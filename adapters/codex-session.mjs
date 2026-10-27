/**
 * Codex CLI 会话卷（~/.codex/sessions/...jsonl）→ 协议事件。
 *
 * 这一层存在，是因为会话卷里的工具完成记录不是 generic 的
 * start/end 两行，而是一条 `event_msg` / `item_completed`：
 *
 *   payload.item.type = CommandExecution | McpToolCall | FileChange
 *   payload.item.status / exit_code      = 显式成败
 *   payload.item.duration                = { secs, nanos }
 *   timestamp                             = 完成时刻
 *
 * 开始行（custom_tool_call）的 id 与这条完成记录的 id 对不上，
 * 所以不能靠配对把两行缝起来。这里只消费**带显式成败**的完成记录，
 * 用 duration 反推开始时刻：
 *
 *   tool.ts     = 完成时刻 - duration
 *   tool_end.ts = 完成时刻
 *   ok          = exit_code === 0，或 status completed/failed
 *
 * 没有 status、也没有 exit_code 的记录（例如 ImageView）跳过并计数。
 * 不读 command / cwd / arguments / result 正文。
 */
import { toMs } from './generic.mjs';

export const CODEX_SESSION_TOOL_TYPES = Object.freeze([
  'CommandExecution',
  'McpToolCall',
  'FileChange',
]);

export function durationToMs(v) {
  if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return v;
  if (!v || typeof v !== 'object') return null;
  const secs = typeof v.secs === 'number' ? v.secs
    : typeof v.seconds === 'number' ? v.seconds : null;
  if (secs == null || secs < 0) return null;
  const nanos = typeof v.nanos === 'number' ? v.nanos
    : typeof v.nanoseconds === 'number' ? v.nanoseconds : 0;
  return secs * 1000 + Math.floor(nanos / 1e6);
}

/** 只认显式字段。缺了就返回 null，调用方必须跳过，不许补成功。 */
export function explicitOk(item) {
  if (!item || typeof item !== 'object') return null;
  if (typeof item.exit_code === 'number' && Number.isFinite(item.exit_code)) {
    return item.exit_code === 0;
  }
  if (item.status === 'completed') return true;
  if (item.status === 'failed') return false;
  return null;
}

function toolName(item) {
  if (typeof item.tool === 'string' && item.tool.trim() !== '') return item.tool.trim();
  if (typeof item.type === 'string' && item.type.trim() !== '') return item.type.trim();
  return null;
}

/**
 * @param {object[]} records
 * @returns {{ events: object[], issues: object[], stats: object }}
 */
export function projectCodexSession(records) {
  const stats = {
    inputRecords: 0,
    projected: 0,
    turnEnds: 0,
    skippedOther: 0,
    skippedNoStatus: 0,
    skippedNoTool: 0,
    skippedNoTs: 0,
    durationUsed: 0,
  };
  const issues = [];
  const events = [];
  const list = Array.isArray(records) ? records : [];

  for (const rec of list) {
    stats.inputRecords++;
    if (!rec || typeof rec !== 'object') {
      stats.skippedOther++;
      continue;
    }
    const payload = rec.payload;
    const payloadType = payload && payload.type;
    if (rec.type === 'event_msg' && payloadType === 'task_complete') {
      const ts = toMs(rec.timestamp);
      if (ts == null) {
        stats.skippedNoTs++;
        issues.push({ code: 'missing-ts', message: 'task_complete 没有可解析的 timestamp' });
        continue;
      }
      events.push({ kind: 'turn_end', ok: true, ts });
      stats.turnEnds++;
      continue;
    }
    if (!(rec.type === 'event_msg' && payloadType === 'item_completed' && payload.item)) {
      stats.skippedOther++;
      continue;
    }
    const item = payload.item;
    if (!CODEX_SESSION_TOOL_TYPES.includes(item.type)) {
      stats.skippedOther++;
      continue;
    }
    const ok = explicitOk(item);
    if (ok == null) {
      stats.skippedNoStatus++;
      issues.push({
        code: 'no-explicit-ok',
        message: `${item.type} 没有 exit_code 或 status=completed|failed，已跳过`,
      });
      continue;
    }
    const tool = toolName(item);
    if (!tool) {
      stats.skippedNoTool++;
      issues.push({ code: 'missing-tool', message: `${item.type} 没有工具名` });
      continue;
    }
    const endTs = toMs(rec.timestamp);
    if (endTs == null) {
      stats.skippedNoTs++;
      issues.push({ code: 'missing-ts', message: `${item.type} 没有可解析的 timestamp` });
      continue;
    }
    const realMs = durationToMs(item.duration);
    const startTs = realMs != null ? endTs - realMs : endTs;
    if (realMs != null) stats.durationUsed++;
    const evStart = { kind: 'tool', tool, ts: startTs };
    const evEnd = { kind: 'tool_end', tool, ok, ts: endTs };
    if (item.id != null && (typeof item.id === 'string' || typeof item.id === 'number')) {
      evStart.id = String(item.id);
      evEnd.id = String(item.id);
    }
    if (realMs != null) {
      evStart.realMs = realMs;
      evEnd.realMs = realMs;
    }
    events.push(evStart, evEnd);
    stats.projected++;
  }

  return { events, issues, stats };
}
