/**
 * adapters/stdin.mjs —— 从标准输入读 JSONL 事件流
 *
 * ===== 用途 =====
 *
 * `your-agent ... | node tools/doctor.mjs --stdin`
 * `your-agent ... | node adapters/stdin.mjs --out events.jsonl`
 *
 * 这是最通用的接法：**任何**能往 stdout 打一行 JSON 的智能体都能接，
 * 不需要改它的代码，不需要装依赖，只需要一个管道。
 *
 * ===== 逐行流式，不吃全量 =====
 *
 * 智能体可能跑几个小时。必须一行到了就处理一行，
 * 不能等 EOF —— 等了就等于"会话结束才看到第一个事件"。
 *
 * 所以用 `readline` 按行切，每行独立 parse：
 *   - 空行 / 纯空白行：静默跳过（不算坏行，日志里的空行是正常的）
 *   - 非 JSON 行：**计坏行并带行号**，继续读下一行，绝不中断
 *   - 一行是一个 JSON 数组：拆开逐个处理（有些日志一次打一批）
 *   - 一行是 { events: [...] }：拆开（有些日志一次打一页）
 *
 * ===== 不猜字段 =====
 *
 * 这里只做"JSON → 对象"的搬运和批量展开，不做任何字段映射。
 * 需要把 Claude Code 的 `{"type":"tool_use",...}` 转成协议形状，
 * 请先过 `adapters/generic.mjs`。
 */
import { createInterface } from 'node:readline';

/**
 * 从任意可读流读 JSONL。
 *
 * @param {NodeJS.ReadableStream} input 通常是 process.stdin
 * @param {{
 *   onEvent: (ev: object, meta: { line: number }) => void,
 *   onBadLine?: (info: { line: number, text: string, message: string }) => void,
 *   onBatch?: (info: { line: number, count: number }) => void,
 * }} opts
 * @returns {{ done: Promise<{ lines: number, badLines: number, batches: number }>, stop: () => void }}
 */
export function readJsonlStream(input, opts) {
  const onEvent = opts.onEvent;
  const onBadLine = opts.onBadLine || (() => {});
  const onBatch = opts.onBatch || (() => {});

  let lines = 0;
  let badLines = 0;
  let batches = 0;

  const rl = createInterface({ input, crlfDelay: Infinity });

  rl.on('line', (raw) => {
    const line = raw.replace(/^\uFEFF/, '');
    if (line.trim() === '') return; // 空行不是坏行
    lines++;

    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      badLines++;
      onBadLine({ line: lines, text: line.slice(0, 120), message: err.message });
      return;
    }

    emitParsed(parsed, lines, onEvent, onBatch, () => batches++);
    if (Array.isArray(parsed)) {
      /* batches 已在 emitParsed 里累加，这里不再动 */
    }
  });

  const done = new Promise((resolve) => {
    rl.on('close', () => resolve({ lines, badLines, batches }));
  });

  return {
    done,
    stop() {
      rl.close();
    },
  };
}

function emitParsed(parsed, lineNo, onEvent, onBatch, bump) {
  if (Array.isArray(parsed)) {
    bump();
    onBatch({ line: lineNo, count: parsed.length });
    for (const item of parsed) onEvent(item, { line: lineNo });
    return;
  }
  if (parsed != null && typeof parsed === 'object' && Array.isArray(parsed.events)) {
    bump();
    onBatch({ line: lineNo, count: parsed.events.length });
    if (parsed.meta !== undefined) {
      onEvent(parsed, { line: lineNo, envelope: true });
    }
    for (const item of parsed.events) onEvent(item, { line: lineNo });
    return;
  }
  onEvent(parsed, { line: lineNo });
}

/**
 * 读 stdin 的全部事件到数组（一次性）。给 doctor 的 `--stdin` 用。
 *
 * 注意：这会等到 EOF。对 `printf ... | doctor --stdin` 是合适的；
 * 对长时间实时流不合适（那种场景用 readJsonlStream 边读边报）。
 *
 * @param {NodeJS.ReadableStream} input
 * @param {{ maxEvents?: number }} [opts]
 */
export async function collectStdin(input, opts = {}) {
  const maxEvents = opts.maxEvents ?? Infinity;
  const events = [];
  const badLines = [];
  const envelopes = [];

  const reader = readJsonlStream(input, {
    onEvent(ev, meta) {
      if (meta && meta.envelope) {
        envelopes.push(ev);
        return;
      }
      if (events.length < maxEvents) events.push(ev);
      else if (events.length === maxEvents) events.push({ __truncated: true });
    },
    onBadLine(info) {
      badLines.push(info);
    },
  });
  const summary = await reader.done;
  const truncated = events.length > maxEvents;
  if (truncated) events.pop();
  return {
    events,
    badLines,
    envelopes,
    /*
     * 注意不能直接 `...summary` 摊进来：summary 里也有个 `badLines`（是**数字**），
     * 摊开会把上面那个 badLines **数组**悄悄覆盖掉 —— 调用方拿到的是一个数字，
     * 再想取 `.length` 就是 undefined，坏行明细凭空消失。
     * 所以逐字段改名，不摊。
     */
    linesSeen: summary.lines,
    badLineCount: summary.badLines,
    batches: summary.batches,
    truncated,
  };
}

/** 从真实 process.stdin 读（doctor 用的入口）。 */
export function collectProcessStdin(opts) {
  return collectStdin(process.stdin, opts);
}
