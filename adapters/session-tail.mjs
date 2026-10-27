import { open } from 'node:fs/promises';
import { projectCodexSession } from './codex-session.mjs';

/** Byte offsets and raw buffers preserve UTF-8 and incomplete JSONL writes. */
export async function openSessionTail(file, { fromEnd = true } = {}) {
  const input = await open(file, 'r');
  let offset = fromEnd ? (await input.stat()).size : 0;
  let pending = Buffer.alloc(0);
  let skipPartial = false;
  let closed = false;
  const stats = { records: 0, tools: 0, skipped: 0, badLines: 0, issues: 0, bytes: 0 };
  if (offset) {
    const last = Buffer.alloc(1);
    await input.read(last, 0, 1, offset - 1);
    skipPartial = last[0] !== 10;
  }
  return {
    stats,
    async poll() {
      if (closed) throw new Error('Session reader is closed');
      const size = (await input.stat()).size;
      if (size < offset) throw new Error('会话日志被截断，请重新连接该会话');
      if (size === offset) return { events: [], issues: [] };
      const chunk = Buffer.alloc(Math.min(size - offset, 1024 * 1024));
      const { bytesRead } = await input.read(chunk, 0, chunk.length, offset);
      offset += bytesRead;
      stats.bytes += bytesRead;
      pending = Buffer.concat([pending, chunk.subarray(0, bytesRead)]);
      if (pending.length > 16 * 1024 * 1024) throw new Error('单条日志超过 16MB，已停止读取');
      const events = [], issues = [];
      let end;
      while ((end = pending.indexOf(10)) !== -1) {
        const line = pending.subarray(0, end).toString('utf8').trim();
        pending = pending.subarray(end + 1);
        if (skipPartial) { skipPartial = false; continue; }
        if (!line) continue;
        stats.records++;
        let record;
        try { record = JSON.parse(line); }
        catch {
          stats.badLines++;
          issues.push({ code: 'bad-json', message: `新增记录 ${stats.records} 不是完整 JSON，已跳过` });
          continue;
        }
        const result = projectCodexSession([record]);
        stats.skipped += result.stats.skippedOther;
        stats.tools += result.stats.projected;
        issues.push(...result.issues);
        for (const event of result.events) {
          if (event.kind !== 'turn_end' && !event.id) {
            issues.push({ code: 'missing-id', message: '工具记录缺少调用 ID，已跳过' });
            continue;
          }
          events.push(event);
        }
      }
      stats.issues += issues.length;
      return { events, issues };
    },
    async close() { if (!closed) { closed = true; await input.close(); } },
  };
}
