/**
 * doctor / 文件通道在映射之前的预处理。
 *
 * claude-content：把 message.content[] 摊平，再交给 generic profile。
 * codex-session：直接投影成协议事件（id 对不上的两套记录不能靠字段映射缝合）。
 *
 * 这一层不读文件、不取当前时间。
 */
import { expandRecords } from './expand.mjs';
import { projectCodexSession } from './codex-session.mjs';

export const PREPROCESS = Object.freeze({
  CLAUDE_CONTENT: 'claude-content',
  CODEX_SESSION: 'codex-session',
});

/**
 * @param {object} config profile JSON
 * @param {object[]} records
 * @returns {{
 *   mode: string|null,
 *   records: object[],
 *   events: object[]|null,
 *   stats: object|null,
 *   issues: object[],
 * }}
 */
export function prepareSourceRecords(config, records) {
  const mode = config && config.preprocess ? String(config.preprocess) : null;
  const list = Array.isArray(records) ? records : [];
  if (mode == null) {
    return { mode: null, records: list, events: null, stats: null, issues: [] };
  }
  if (mode === PREPROCESS.CLAUDE_CONTENT) {
    const exp = expandRecords(list);
    return {
      mode,
      records: exp.records,
      events: null,
      stats: exp.stats,
      issues: exp.issues,
    };
  }
  if (mode === PREPROCESS.CODEX_SESSION) {
    const proj = projectCodexSession(list);
    return {
      mode,
      records: list,
      events: proj.events,
      stats: proj.stats,
      issues: proj.issues,
    };
  }
  throw new Error(`未知 preprocess "${mode}"（只认 claude-content / codex-session）`);
}
