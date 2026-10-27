/**
 * adapters/jsonl-file.mjs —— 本地文件事件源（JSONL / JSON-with-events 双形态）
 *
 * ===== 为什么两种形态都要支持 =====
 *
 * 这个项目里真实存在的文件就有两种：
 *   - `real-events.json`：`{ meta, events: [...] }` —— ETL 写出来的成品
 *   - 各家智能体的日志：基本是**逐行 JSON**（JSONL），而且**边跑边追加**
 *
 * 如果只支持前者，"实时"就无从谈起：成品文件是在会话**结束之后**才生成的。
 * 如果只支持后者，我们自己的 real-events.json 反而读不了。
 *
 * 所以这里先**探形态**，再选读法：
 *   - `json-events`：整个文件是一个带 `events` 数组的 JSON 对象
 *   - `json-array` ：整个文件是一个 JSON 数组
 *   - `jsonl`      ：逐行 JSON（可能还没写完最后一行）
 *
 * ===== 增量与热更新 =====
 *
 * `jsonl`：按**字节偏移**读，只读新追加的部分。末行不完整时**留着**，
 *          等下次有了换行再解析 —— 半条 JSON 不该被当成坏行报出去。
 *          （这是个真实坑：追加写日志时最后的 `{"kind":"tool"` 是常态。）
 *
 * `json-events` / `json-array`：整文件 JSON 没法按字节增量，
 *          所以采用"变化则重读 + 只发新增条目"的做法，按**已发出条数**去重。
 *          这要求文件是**只追加**的（不能重排/删除中间元素）——
 *          违反这个前提会被 `revisionChanged` 检查抓出来并如实报告，而不是猜。
 *
 * ===== 诚实约束 =====
 *
 * - 坏行不吞：计数 + 带行号的可读 issue，继续读下一行。
 * - 文件不存在：如实报错，不会假装"暂时没有事件"。
 * - 不做任何字段映射/补造 —— 那是 `generic.mjs` 的职责。
 */
import { createReadStream } from 'node:fs';
import { open, stat } from 'node:fs/promises';

/** 文件形态。 */
export const FILE_SHAPE = Object.freeze({
  JSON_EVENTS: 'json-events',
  JSON_ARRAY: 'json-array',
  JSONL: 'jsonl',
});

/**
 * 形态判定：**先尝试整文件 JSON 解析**，解析不了才当 JSONL。
 *
 * ===== 为什么不能只看首个字符 =====
 *
 * JSONL 的每一行都以 `{` 开头，所以"首字符是 `{` → 整文件 JSON"这个推断
 * 对 JSONL 文件是**错的**：一份正常的 `{"a":1}\n{"a":2}\n` 日志会被当成
 * "一个坏掉的 JSON 对象"，然后整份报解析失败 —— 恰好把最常见的输入形态
 * 判成了坏数据。
 *
 * 所以这里用**能不能整体 parse** 来判定：能 parse 且是对象（带 events）
 * 或数组 → 整文件形态；不能 parse → JSONL。这是确定性的，
 * 不依赖"看起来像什么"。
 */
/**
 * 去掉开头的 UTF-8 BOM（U+FEFF）。
 *
 * Windows 上 PowerShell 的 `Set-Content`/`Out-File`、记事本、Excel 导出
 * 写 UTF-8 文件时**默认带 BOM**，这是真实用户最常见的入口之一。
 * 所有文本入口都必须先过这一道，否则"第一个字符"就不是 `{`/`[` 而是 BOM。
 */
export function stripBom(text) {
  const s = String(text ?? '');
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

/** UTF-8 BOM 的三个字节。 */
const BOM_BYTES = Object.freeze([0xef, 0xbb, 0xbf]);

export function resolveShape(text, shapeHint) {
  /* trim() 本身也会吃掉 U+FEFF，但显式先剥一次，语义更明确、也不依赖 trim 的白名单。 */
  const trimmed = stripBom(text).trim();
  if (trimmed === '') return { shape: FILE_SHAPE.JSONL, doc: null, reason: '空文件' };

  try {
    const doc = JSON.parse(trimmed);
    if (Array.isArray(doc)) return { shape: FILE_SHAPE.JSON_ARRAY, doc };
    /*
     * 关键判定：**只有带 events 数组的对象**才算整文件形态。
     *
     * 不能"能 parse 成对象就算整文件"：一行 JSONL 的日志
     * `{"kind":"tool","tool":"a","ts":0}` 本身就是合法 JSON 对象。
     * 那样判会把最常见的单行追加日志当成"整文件 JSON"，
     * 于是热更新只能整份重读、按条目数去重 —— tail 语义直接失效。
     *
     * 所以口径是：有 events 数组 → 整文件；否则 → 逐行。
     */
    if (doc && typeof doc === 'object' && Array.isArray(doc.events)) {
      return { shape: FILE_SHAPE.JSON_EVENTS, doc };
    }
    return { shape: FILE_SHAPE.JSONL, doc: null };
  } catch {
    /* 整份 parse 失败 = 只能是逐行 JSON（或坏文件，交给逐行解析去报） */
    return { shape: FILE_SHAPE.JSONL, doc: null };
  }
}

/**
 * 判定形态。只看首个非空白字符，用于**猜测提示**；
 * 真正的判定请用 `resolveShape()`（它对 JSONL 才是准的）。
 * `{` → 可能是 json-events；`[` → json-array；其他 → jsonl。
 */
export function detectShape(head) {
  const s = String(head || '');
  for (const ch of s) {
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n' || ch === '\uFEFF') continue;
    if (ch === '{') return FILE_SHAPE.JSON_EVENTS;
    if (ch === '[') return FILE_SHAPE.JSON_ARRAY;
    return FILE_SHAPE.JSONL;
  }
  return FILE_SHAPE.JSONL; // 空文件：按 JSONL 处理，等它长出来
}

/**
 * 解析"整文件 JSON"形态，返回事件数组。
 * 形态对不上时**不猜**，返回带说明的失败。
 */
export function parseWholeJson(text, shape) {
  let doc;
  try {
    /*
     * 必须先剥 BOM：`resolveShape()` 用 trim() 判形态时 BOM 已被吃掉，
     * 于是带 BOM 的 `{meta,events}` 会被判成整文件 JSON 走到这里；
     * 而 JSON.parse 遇到 BOM 直接抛错 → 整份事件静默丢光，
     * 界面上却显示"0 条事件 / 100.0% 完美"。两条路径的 BOM 口径必须一致。
     */
    doc = JSON.parse(stripBom(text));
  } catch (err) {
    return { ok: false, events: [], reason: `整文件 JSON 解析失败：${err.message}` };
  }
  if (shape === FILE_SHAPE.JSON_ARRAY) {
    if (!Array.isArray(doc)) {
      return { ok: false, events: [], reason: '期望 JSON 数组，实际不是' };
    }
    return { ok: true, events: doc, reason: null };
  }
  /* JSON_EVENTS */
  if (doc == null || typeof doc !== 'object' || Array.isArray(doc)) {
    return { ok: false, events: [], reason: '期望带 events 数组的对象，实际不是对象' };
  }
  if (!Array.isArray(doc.events)) {
    return {
      ok: false,
      events: [],
      reason: `对象里没有 events 数组（实际键：${Object.keys(doc).join(',') || '空'}）`,
    };
  }
  return { ok: true, events: doc.events, reason: null, meta: doc.meta };
}

/**
 * 逐行解析 JSONL 文本，返回 { events, badLines, tail }。
 * `tail` 是最后一段**没有换行结尾**的残留，由调用方保存到下次。
 */
export function parseJsonlChunk(text) {
  const events = [];
  const badLines = [];
  /*
   * 去掉 UTF-8 BOM。
   *
   * Windows 上很多工具（PowerShell 的 Set-Content/Out-File、
   * 部分编辑器和日志重定向）写文件时会带 BOM。不处理的话
   * **第一行永远 parse 失败** —— 而那恰好是会话的第一条事件。
   * 表现是"第一条工具调用凭空消失"，且没有任何显眼报错。
   */
  const clean = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const lastNl = clean.lastIndexOf('\n');
  const complete = lastNl === -1 ? '' : clean.slice(0, lastNl + 1);
  const tail = lastNl === -1 ? clean : clean.slice(lastNl + 1);

  const lines = complete.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') continue;
    try {
      events.push(JSON.parse(line));
    } catch (err) {
      badLines.push({ line: i + 1, text: line.slice(0, 120), message: err.message });
    }
  }
  return { events, badLines, tail };
}

/**
 * 打开一个文件事件源。
 *
 * @param {string} file
 * @param {{
 *   fromStart?: boolean,      是否从头读（false = 只读之后追加的，适合 tail -f 行为）
 *   onIssue?: (i) => void,    文件层问题（不存在、形态变化、坏行）
 * }} [opts]
 * @returns {Promise<{ shape, poll, close, path }>}
 */
export async function openFileSource(file, opts = {}) {
  const onIssue = typeof opts.onIssue === 'function' ? opts.onIssue : () => {};
  let shape = null;
  let offset = 0; // jsonl 用：已消费的字节数
  let pending = Buffer.alloc(0); // jsonl 用：未成行的残片（**字节**，不是字符）
  let emitted = 0; // 整文件 JSON 用：已发出的条目数
  let lastSignature = '';
  let closed = false;

  const st = await stat(file); // 不存在就在这里抛，调用方拿得到 ENOENT
  if (!st.isFile()) throw new Error(`${file} 不是普通文件`);

  /*
   * 探形态：整份读一次再判定。
   *
   * 不用"前 512 字节首字符"来判 —— 那会把正常 JSONL 误判成整文件 JSON。
   * 代价是启动时多读一遍文件；换来的是判形永远正确。
   * （tail 场景跟进的是会话日志，量级在 MB 以内，这个代价可接受。）
   */
  const headText = await readRangeText(file, 0, st.size);
  shape = resolveShape(headText).shape;

  /* JSONL 的游标从"正文起点"开始：文件带 BOM 时跳过那 3 个字节。 */
  let bomBytes = 0;
  if (shape === FILE_SHAPE.JSONL) bomBytes = await bomByteLength(file, st.size);

  if (opts.fromStart === false) {
    offset = st.size;
    lastSignature = `${st.size}:${st.mtimeMs}`;
  } else {
    offset = bomBytes; // 正常从头读：BOM 不计入内容
  }

  async function pollOnce() {
    if (closed) return { events: [], badLines: [], issues: [], shape };
    const now = await stat(file).catch((err) => {
      onIssue({ code: 'stat-failed', message: `读文件状态失败：${err.message}` });
      return null;
    });
    if (!now) return { events: [], badLines: [], issues: [], shape };

    /* ---------- 整文件 JSON 形态 ---------- */
    if (shape !== FILE_SHAPE.JSONL) {
      const sig = `${now.size}:${now.mtimeMs}`;
      if (sig === lastSignature) return { events: [], badLines: [], issues: [], shape };
      lastSignature = sig;
      const text = await readRangeText(file, 0, now.size);
      const parsed = parseWholeJson(text, shape);
      if (!parsed.ok) {
        onIssue({ code: 'parse-failed', message: parsed.reason });
        return { events: [], badLines: [], issues: [], shape };
      }
      if (parsed.events.length < emitted) {
        /*
         * 条目变少了 = 文件被重写/重排，不是只追加。
         * 这时"只发新增"的前提不成立，必须整份重发并明说，
         * 而不是静静地把新增条目算错。
         */
        onIssue({
          code: 'revision-changed',
          message: `条目数从 ${emitted} 减到 ${parsed.events.length}，文件不是只追加的；已整份重发`,
        });
        emitted = 0;
      }
      const fresh = parsed.events.slice(emitted);
      emitted = parsed.events.length;
      return { events: fresh, badLines: [], issues: [], shape, meta: parsed.meta };
    }

    /* ---------- JSONL 形态 ---------- */
    if (now.size < offset) {
      /* 文件被截断/轮转：从头再来（BOM 也要重新跳过） */
      onIssue({
        code: 'file-rotated',
        message: `文件从 ${offset} 字节缩到 ${now.size} 字节（被截断或轮转），已从头重读`,
      });
      pending = Buffer.alloc(0);
      bomBytes = await bomByteLength(file, now.size);
      offset = bomBytes;
    }
    if (now.size === offset) {
      /* 没有新字节：必须什么都不发，也什么都不报。 */
      return { events: [], badLines: [], issues: [], shape };
    }

    /*
     * ===== 游标语义（这里曾经出过两个真缺陷，改之前先读这段） =====
     *
     * `offset` = 已经**成行并消费掉**的字节数（不含 BOM）。
     * `pending` = 还没等到换行符的残片**字节**。
     * 读起点永远是 offset + pending.length —— 残片不会被重复读。
     *
     * 旧实现犯的两个错：
     *   1) `offset = offset + pending.length + (combined.length - r.tail.length)`：
     *      combined 里**已经包含** pending，pending.length 被多加了一次，
     *      于是 offset 越过真实文件尾。下一轮 `now.size < offset` 成立，
     *      判定"文件被截断"，报一条 file-rotated 并把 offset 归零 → 从头重读。
     *      后果是空闲轮询会把历史事件重放一遍（实测 4 条真实事件下发 7 条）。
     *      **这是产品红线**：`tool` 开始事件被重放会让 director 凭空多生成敌人、
     *      抬高 seen/unmapped 计数 —— 那等于报告了根本没发生过的进度。
     *   2) offset 按**字符**累加却按**字节**比较：中文日志每轮错位，
     *      每轮解出半截 JSON 并报一条假 bad-line。
     *
     * 现在的做法：全程字节，最后一次性解码成文本再解析。
     */
    const chunk = await readRangeBytes(file, offset + pending.length, now.size);
    const combined = Buffer.concat([pending, chunk]);

    /*
     * 只在**最后一个换行符**处切分完整部分与残片。
     * 换行符 0x0A 不可能出现在 UTF-8 多字节序列内部，所以按字节切是安全的：
     * 完整部分一定能整块正确解码，残片原样留到下一轮。
     */
    const lastNl = combined.lastIndexOf(0x0a);
    const completeBytes = lastNl === -1 ? 0 : lastNl + 1;
    const completeText = combined.subarray(0, completeBytes).toString('utf8');
    pending = Buffer.from(combined.subarray(completeBytes)); // 拷贝，避免持有大 buffer
    offset += completeBytes;

    const r = parseJsonlChunk(completeText);
    /*
     * completeText 一定以 `\n` 结尾（或为空），所以 parseJsonlChunk 的 tail 必为空；
     * 残片就是上面按字节切出来的 `pending`。这里显式校验一次，
     * 一旦口径被将来的改动破坏，立刻在测试/日志里暴露，而不是静默丢内容。
     */
    if (r.tail !== '') {
      pending = Buffer.concat([Buffer.from(r.tail, 'utf8'), pending]);
      offset -= Buffer.byteLength(r.tail, 'utf8');
    }
    const tail = pending.toString('utf8');

    const badLines = r.badLines;
    for (const b of badLines) {
      onIssue({ code: 'bad-line', message: `第 ${b.line} 行不是合法 JSON：${b.message}` });
    }
    return { events: r.events, badLines, issues: [], shape, pendingBytes: pending.length, tail };
  }

  return {
    get shape() {
      return shape;
    },
    path: file,
    poll: pollOnce,
    /** 剩余没成行的**字节**数（诊断用，说明"还有半行没读到"） */
    get pendingBytes() {
      return pending.length;
    },
    /** 整文件 JSON 形态下已下发多少条（诊断用） */
    get emittedCount() {
      return emitted;
    },
    async close() {
      closed = true;
    },
  };
}

/**
 * 只读文件的 [start, end) 字节区间，返回 **Buffer**。
 *
 * ===== 为什么必须是字节 =====
 *
 * `offset` 天然是字节语义（它要和 `stat().size` 比大小、要给
 * `createReadStream` 当 `start`）。如果用 `encoding:'utf8'` 读成字符串，
 * 拿到的长度是**字符数**，而中文/emoji 一个字要 3-4 字节 —— 字符数 < 字节数，
 * 游标就会持续落后于真实位置，每轮 poll 都从错位处重读半截 JSON，
 * 于是每轮报一条假的 `bad-line`（实测 20 条中文事件 → 19 条假错）。
 *
 * 所以这一层只吐字节；解码放在"确认是完整行之后"再做，
 * 这样多字节字符永远不可能被切开（换行符 0x0A 不会出现在 UTF-8 多字节序列内部）。
 */
function readRangeBytes(file, start, end) {
  if (end <= start) return Promise.resolve(Buffer.alloc(0));
  return new Promise((resolve, reject) => {
    const chunks = [];
    const stream = createReadStream(file, { start, end: end - 1 });
    stream.on('data', (c) => chunks.push(c));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

/** 读 [start, end) 字节区间并解码成 utf8 文本。 */
async function readRangeText(file, start, end) {
  return (await readRangeBytes(file, start, end)).toString('utf8');
}

/**
 * 文件开头如果有 UTF-8 BOM，返回它的字节数（3）；否则 0。
 *
 * BOM 不是正文：把它算进 `offset` 的起点，能让"字符位置"和"字节位置"
 * 从第一轮就对齐，也不用每轮都靠 decode 后再剥一次来兜底。
 */
async function bomByteLength(file, size) {
  if (size < BOM_BYTES.length) return 0;
  const head = await readRangeBytes(file, 0, BOM_BYTES.length);
  const hit = BOM_BYTES.every((b, i) => head[i] === b);
  return hit ? BOM_BYTES.length : 0;
}

/**
 * 一次性读完整文件（非增量）。给 doctor 的 `--file` 和测试用。
 *
 * @returns {Promise<{ shape, events, badLines, issues, meta }>}
 */
export async function readFileOnce(file) {
  const st = await stat(file);
  const text = await readRangeText(file, 0, st.size);
  const { shape } = resolveShape(text);

  if (shape !== FILE_SHAPE.JSONL) {
    const parsed = parseWholeJson(text, shape);
    if (!parsed.ok) {
      return {
        shape,
        events: [],
        badLines: [],
        issues: [{ code: 'parse-failed', message: parsed.reason }],
        meta: undefined,
      };
    }
    return { shape, events: parsed.events, badLines: [], issues: [], meta: parsed.meta };
  }

  /*
   * JSONL：最后一行即使没有换行也算一条（一次性读时不存在"还会长出来"的问题），
   * 但如果是**明显不完整**的（比如正好被截断在对象中间），parse 会失败并按坏行报。
   *
   * 这里补一个换行再交给 parseJsonlChunk —— 复用它，顺便拿到 BOM 处理和
   * 一致的坏行口径，避免两处解析逻辑各说各话。
   */
  const { events, badLines } = parseJsonlChunk(text.endsWith('\n') ? text : `${text}\n`);

  /*
   * 形态判定的兜底：**整份 JSON 被截断/写坏** 不是"几十个坏行"。
   *
   * `resolveShape()` 的 catch 分支对"整份 parse 失败"只能退回 JSONL ——
   * 它对"能 parse 成的对象"才是准的。于是一份被截断到 55% 的 `{meta,events}`
   * 会被拆成几十条碎片，每条碎片的 parse 都失败，逐行口径就报出几十条 bad-line：
   * **一个病因被印成几十个症状**，读的人根本看不到"文件本身是断的"。
   *
   * 判定条件刻意保守，只认"铁证"：
   *   1) 首字符（剥掉 BOM/空白后）是 `{` 或 `[` —— 像一份整文件 JSON；
   *   2) 整份 JSON.parse 失败（否则 resolveShape 已经判成整文件形态了）；
   *   3) 逐行口径**一条合法事件都拿不到**（events.length === 0）。
   *
   * 条件 3 是安全阀：正常 JSONL 日志里个别坏行不会命中（还有别的合法行 → events>0），
   * 所以"逐行 JSONL 里个别坏行"的既有报错行为完全不变。
   */
  if (events.length === 0 && badLines.length > 0 && looksLikeWholeJsonHead(text)) {
    return {
      shape: FILE_SHAPE.JSON_EVENTS,
      events: [],
      badLines: [],
      issues: [{
        code: 'parse-failed',
        message: `整文件 JSON 解析失败：疑似整份 JSON 被截断或写坏`
          + `（${badLines.length} 条碎片都不是独立的合法 JSON 行，`
          + `首条错误：${badLines[0].message}）`,
      }],
      meta: undefined,
    };
  }

  const issues = badLines.map((b) => ({
    code: 'bad-line',
    message: `第 ${b.line} 行不是合法 JSON：${b.message}`,
  }));
  return { shape, events, badLines, issues };
}

/**
 * 首字符（剥掉 BOM 与空白）是不是 `{` / `[` —— 即"看起来像一份整文件 JSON"。
 *
 * 只看首字符是**故意**的：这是给 `readFileOnce()` 的兜底启发式用的，
 * 它只在"整份 parse 失败且逐行一条都没解析出来"之后才会被问到，
 * 这时候"开头是不是对象/数组"已经足够区分"整份 JSON 断了"和"逐行日志脏了"。
 */
function looksLikeWholeJsonHead(text) {
  const s = stripBom(text);
  for (const ch of s) {
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') continue;
    return ch === '{' || ch === '[';
  }
  return false;
}

/* `open` 目前只为保持 import 形状一致而保留给将来用；显式标一下避免误读。 */
void open;
