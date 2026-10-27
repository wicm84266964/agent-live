/**
 * tests/protocol.test.mjs —— 协议本身的测试
 *
 * 这里锁两类东西：
 *   1. **红线**：id 配对口径。292 vs 283 那次事故必须永久不会复现。
 *   2. **诚实**：未知 kind 不崩不猜、坏输入给可读错误、不伪造字段。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  KIND,
  KNOWN_KINDS,
  SCHEMA,
  PAIRING_RULES,
  validate,
  normalize,
  createInbox,
  pairReport,
  duplicateReport,
  describeTimeline,
  isKnownKind,
  formatIssues,
  PROTOCOL_VERSION,
} from '../protocol/events.mjs';

const REAL_EVENTS = fileURLToPath(new URL('../real-events.json', import.meta.url));
const realDoc = JSON.parse(readFileSync(REAL_EVENTS, 'utf8'));

/* ------------------------------------------------------------------ *
 * schema 契约
 * ------------------------------------------------------------------ */

test('schema 只包含现有消费方真正读的字段（不发明并行 schema）', () => {
  assert.deepEqual(Object.keys(SCHEMA).sort(), [
    'id',
    'kind',
    'ok',
    'realMs',
    'tool',
    'ts',
  ]);
  assert.deepEqual(KNOWN_KINDS, ['tool', 'tool_end', 'turn_end']);
  assert.equal(isKnownKind('tool'), true);
  assert.equal(isKnownKind('tool_use'), false);
  assert.equal(PROTOCOL_VERSION, 1);
});

test('schema 每个字段都声明了语义与消费方（防止协议和实现脱钩）', () => {
  for (const [name, def] of Object.entries(SCHEMA)) {
    assert.equal(typeof def.type, 'string', `${name}.type`);
    assert.ok(def.semantics && def.semantics.length > 10, `${name}.semantics 太短`);
    assert.ok(Array.isArray(def.consumedBy) && def.consumedBy.length > 0, `${name}.consumedBy`);
    assert.ok(Array.isArray(def.requiredFor), `${name}.requiredFor`);
  }
});

test('真实 real-events.json 的每一条都能通过校验', () => {
  const bad = [];
  for (const [i, ev] of realDoc.events.entries()) {
    const r = validate(ev);
    if (!r.ok) bad.push({ i, issues: formatIssues(r.errors) });
    assert.equal(r.unknownKind, false, `第 ${i} 条被当成未知 kind`);
  }
  assert.deepEqual(bad, [], '真实事件里存在校验不过的条目');
});

test('真实文件里出现过的字段，schema 都必须认识', () => {
  const seen = new Set();
  for (const ev of realDoc.events) for (const k of Object.keys(ev)) seen.add(k);
  const unknown = [...seen].filter((k) => !(k in SCHEMA));
  assert.deepEqual(unknown, [], `发现未被 schema 覆盖的真实字段：${unknown.join(',')}`);
});

/* ------------------------------------------------------------------ *
 * 校验：不抛异常、可读错误
 * ------------------------------------------------------------------ */

test('validate 对任何烂输入都不抛异常', () => {
  const junk = [
    null, undefined, 42, 'x', [], [1, 2], {}, { kind: null },
    { kind: 5 }, { kind: 'tool' }, { kind: 'tool_end' },
    { kind: 'tool', tool: '' }, { kind: 'tool', tool: 5 },
    { kind: 'tool', tool: 'x', id: {} },
    { kind: 'tool', tool: 'x', ts: NaN },
    { kind: 'tool', tool: 'x', ts: Infinity },
    { kind: 'tool', tool: 'x', realMs: -1 },
    { kind: 'tool', tool: 'x', ok: 'yes' },
    { kind: 'tool_end', tool: 'x' },
  ];
  for (const j of junk) {
    assert.doesNotThrow(() => validate(j), `validate 对 ${JSON.stringify(j)} 抛了异常`);
    const r = validate(j);
    assert.equal(typeof r.ok, 'boolean');
    assert.ok(Array.isArray(r.errors));
    assert.ok(Array.isArray(r.warnings));
  }
});

test('缺字段错误可读（说清是哪个 kind 缺哪个字段）', () => {
  const r = validate({ kind: 'tool_end', ts: 1 });
  assert.equal(r.ok, false);
  const text = formatIssues(r.errors).join('\n');
  assert.match(text, /missing-ok/);
  assert.match(text, /kind="tool_end"/);
});

test('tool_end 缺 tool 只是 warn：有 id 时配对照常按 callId 走', () => {
  /*
   * 这是真实的形状：Claude Code 的 tool_result 只有 tool_use_id，没有工具名。
   * 因为 director 有 id 时按 callId 精确匹配、根本不读 ev.tool，
   * 所以这里不该判死 —— 判死只会逼适配器去猜一个名字填上（伪造）。
   */
  const r = validate({ kind: 'tool_end', id: 'x', ok: true, ts: 1 });
  assert.equal(r.ok, true, 'tool_end 缺 tool 不该判失败');
  assert.match(formatIssues(r.warnings).join(), /missing-tool-on-end/);
});

test('tool 在开始事件上仍然必填（不知道上场的是谁就没法玩）', () => {
  const r = validate({ kind: 'tool', id: 'x', ts: 1 });
  assert.equal(r.ok, false);
  assert.match(formatIssues(r.errors).join(), /missing-tool/);
});

test('ok 在 tool_end 上必填，在 tool 上可选', () => {
  assert.equal(validate({ kind: 'tool_end', tool: 'read', ts: 1 }).ok, false);
  assert.equal(validate({ kind: 'tool_end', tool: 'read', ts: 1, ok: true }).ok, true);
  assert.equal(validate({ kind: 'tool', tool: 'read', ts: 1 }).ok, true);
  /* tool 上带 ok = "已完成的一次性事件"，是合法用法（director 支持） */
  assert.equal(validate({ kind: 'tool', tool: 'read', ts: 1, ok: false }).ok, true);
});

test('负耗时是错误，不是"小问题"', () => {
  const r = validate({ kind: 'tool', tool: 'read', ts: 1, realMs: -5 });
  assert.equal(r.ok, false);
  assert.match(formatIssues(r.errors).join(), /negative-realMs/);
});

/* ------------------------------------------------------------------ *
 * 未知 kind：不崩、不猜、计数上报
 * ------------------------------------------------------------------ */

test('未知 kind 不报 error，但明确标记为未知', () => {
  const r = validate({ kind: 'tool_use', tool: 'Read', ts: 1 });
  assert.equal(r.ok, true, '未知 kind 不该判死');
  assert.equal(r.unknownKind, true);
  const text = formatIssues(r.warnings).join('\n');
  assert.match(text, /unknown-kind/);
  assert.match(text, /tool_use/);
});

test('未知 kind 不会被猜成 tool 或 tool_end', () => {
  const inbox = createInbox();
  const r = inbox.push({ kind: 'tool_use', tool: 'Read', ts: 1 });
  assert.equal(r.event.kind, 'tool_use', 'kind 必须原样保留，不得被改写');
  const s = inbox.snapshot();
  assert.equal(s.unknown, 1);
  assert.equal(s.unknownKinds.tool_use, 1);
  /* 最关键的：没有被塞进 tool/tool_end 的桶里 */
  assert.equal(s.byKind.tool, undefined);
  assert.equal(s.byKind.tool_end, undefined);
});

test('多个未知 kind 分别计数，并给出可读汇总', () => {
  const inbox = createInbox();
  inbox.push({ kind: 'tool_use', tool: 'a', ts: 1 });
  inbox.push({ kind: 'tool_use', tool: 'b', ts: 2 });
  inbox.push({ kind: 'reasoning', ts: 3 });
  const s = inbox.snapshot();
  assert.equal(s.unknown, 3);
  assert.deepEqual(s.unknownKinds, { tool_use: 2, reasoning: 1 });
  assert.match(s.unknownKindsText, /tool_usex2/);
});

test('坏记录计数，不崩，不当成事件', () => {
  const inbox = createInbox();
  inbox.bad('第 3 行不是合法 JSON：Unexpected token');
  inbox.push({ kind: 'tool', tool: 'x', ts: 1, id: 'c1' });
  const s = inbox.snapshot();
  assert.equal(s.badRecords, 1);
  assert.equal(s.accepted, 1);
  assert.equal(s.rejected, 1);
  const badIssues = s.issues.filter((i) => i.code === 'bad-json');
  assert.equal(badIssues.length, 1);
  assert.match(badIssues[0].message, /第 3 行/);
});

/* ------------------------------------------------------------------ *
 * normalize：不伪造
 * ------------------------------------------------------------------ */

test('normalize 不伪造缺失的 ts：宁可拒收，不编时刻', () => {
  const r = normalize({ kind: 'tool', tool: 'read' });
  /*
   * ts 是必填（协议里 requiredFor 三个 kind 都有）。
   * 拿不到时间的事件无法放到时间轴上 —— 与其补一个假时刻，
   * 不如明确拒收并说清缺什么。
   */
  assert.equal(r.ok, false);
  assert.equal(r.event, null, '不允许把没有时间的事件放行');
  assert.match(formatIssues(r.errors).join(), /missing-ts/);
  assert.equal(r.tsSynthesized, false);
});

test('normalize 只在显式给 now 时补 ts，并留下可见痕迹', () => {
  const r = normalize({ kind: 'tool', tool: 'read' }, { now: () => 1234, source: 'http' });
  assert.equal(r.event.ts, 1234);
  assert.equal(r.tsSynthesized, true);
  assert.equal(r.event.tsSource, 'ingest', '必须标明这是接收时刻，不是发生时刻');
  assert.match(formatIssues(r.warnings).join(), /ts-synthesized/);
});

test('normalize 把数字 id 规范成字符串（配对口径统一）', () => {
  const r = normalize({ kind: 'tool', tool: 'read', ts: 0, id: 7 });
  assert.equal(r.event.id, '7');
  assert.equal(typeof r.event.id, 'string');
});

test('normalize 透传未知的扩展字段（前向兼容，不丢信息）', () => {
  const r = normalize({ kind: 'tool', tool: 'read', ts: 0, vendor: 'acme', cost: 3 });
  assert.equal(r.event.vendor, 'acme');
  assert.equal(r.event.cost, 3);
});

test('normalize 拒绝把非对象当事件，并给出可读原因', () => {
  const r = normalize('"just a string"');
  assert.equal(r.ok, false);
  assert.equal(r.rejected, true);
  assert.match(formatIssues(r.errors).join(), /not-object/);
});

/* ------------------------------------------------------------------ *
 * ============ 回归红线：id 配对口径 ============
 * ------------------------------------------------------------------ */

test('红线：真实数据的 292 次调用必须配成 292 对（不是 283）', () => {
  const r = pairReport(realDoc.events);
  assert.equal(r.callsTotal, 292, '调用数必须是 292');
  assert.equal(r.resultsTotal, 292, '结束数必须是 292');
  assert.equal(r.pairedById, 292, '按 id 必须配出 292 对');
  assert.equal(r.paired, 292);
  assert.equal(r.pairingRate, 1);
  assert.equal(r.perfect, true);
  assert.equal(r.duplicateResults, 0);
  assert.equal(r.orphanResults, 0);
  assert.equal(r.orphanCalls, 0);

  /* 事故值：按工具名配对会把同名调用并掉，得到 283 这类小数字 */
  assert.notEqual(r.paired, 283, '曾经的事故值 283 不许再出现');
  const toolNames = new Set(realDoc.events.filter((e) => e.kind === 'tool').map((e) => e.tool));
  assert.ok(
    toolNames.size < 292,
    `真实数据里不同工具名只有 ${toolNames.size} 种 < 292 次调用 —— 这正是当年算成 283 的原因`,
  );
});

test('红线：同名工具多次调用必须各自配对（不能用工具名当键）', () => {
  const events = [
    { kind: 'tool', tool: 'read', id: 'c1', ts: 0 },
    { kind: 'tool', tool: 'read', id: 'c2', ts: 1 },
    { kind: 'tool', tool: 'read', id: 'c3', ts: 2 },
    { kind: 'tool_end', tool: 'read', id: 'c1', ts: 10, ok: true },
    { kind: 'tool_end', tool: 'read', id: 'c2', ts: 11, ok: true },
    { kind: 'tool_end', tool: 'read', id: 'c3', ts: 12, ok: true },
  ];
  const r = pairReport(events);
  assert.equal(r.callsTotal, 3);
  assert.equal(r.pairedById, 3, '三次同工具调用必须配成 3 对，不能压成 1 对');
  assert.equal(r.perfect, true);
});

test('同 id 的第二个 tool_end 是重复上报，不算新配对', () => {
  const events = [
    { kind: 'tool', tool: 'read', id: 'c1', ts: 0 },
    { kind: 'tool_end', tool: 'read', id: 'c1', ts: 5, ok: true },
    { kind: 'tool_end', tool: 'read', id: 'c1', ts: 6, ok: true },
  ];
  const r = pairReport(events);
  assert.equal(r.pairedById, 1);
  assert.equal(r.duplicateResults, 1);
  assert.equal(r.orphanResults, 0, '重复上报不该被算成孤儿');
  assert.equal(r.perfect, false);
});

test('没有开始、只有结束 → 孤儿结束（如实记未配对，不假装配上）', () => {
  const events = [{ kind: 'tool_end', tool: 'read', id: 'x9', ts: 5, ok: true }];
  const r = pairReport(events);
  assert.equal(r.resultsTotal, 1);
  assert.equal(r.pairedById, 0);
  assert.equal(r.orphanResults, 1);
  assert.equal(r.pairingRate, 0);
  assert.equal(r.orphanResultIds[0], 'x9');
});

test('只有开始、没有结束 → 孤儿开始', () => {
  const events = [{ kind: 'tool', tool: 'agent_run', id: 'long', ts: 0 }];
  const r = pairReport(events);
  assert.equal(r.callsTotal, 1);
  assert.equal(r.orphanCalls, 1);
  assert.equal(r.orphanCallIds[0], 'long');
  assert.equal(r.perfect, false);
});

test('重复的开始事件被单独计数，不会把配对率抬到 >100%', () => {
  const events = [
    { kind: 'tool', tool: 'read', id: 'c1', ts: 0 },
    { kind: 'tool', tool: 'read', id: 'c1', ts: 1 },
    { kind: 'tool_end', tool: 'read', id: 'c1', ts: 5, ok: true },
  ];
  const r = pairReport(events);
  assert.equal(r.duplicateCallIds, 1);
  assert.equal(r.pairedById, 1);
  assert.ok(r.pairingRate <= 1, '配对率不能超过 100%');
});

test('无 id 事件按工具名 FIFO 配对，并单独统计为匿名', () => {
  const events = [
    { kind: 'tool', tool: 'bash', ts: 0 },
    { kind: 'tool', tool: 'bash', ts: 1 },
    { kind: 'tool_end', tool: 'bash', ts: 5, ok: true },
    { kind: 'tool_end', tool: 'bash', ts: 6, ok: true },
  ];
  const r = pairReport(events);
  assert.equal(r.anonymousCalls, 2);
  assert.equal(r.callsWithId, 0);
  assert.equal(r.pairedAnonymous, 2);
  assert.equal(r.pairedById, 0, '没有 id 就不许算进"按 id 配对"');
  assert.equal(r.perfect, true);
});

test('无 id 多出来的结束是重复上报，不是孤儿', () => {
  const events = [
    { kind: 'tool', tool: 'bash', ts: 0 },
    { kind: 'tool_end', tool: 'bash', ts: 5, ok: true },
    { kind: 'tool_end', tool: 'bash', ts: 6, ok: true },
  ];
  const r = pairReport(events);
  assert.equal(r.pairedAnonymous, 1);
  assert.equal(r.duplicateResults, 1);
  assert.equal(r.orphanResults, 0);
});

test('配对结果与"结束事件的先后顺序"无关（并发交叉不影响配对）', () => {
  /* 同一批两个并发调用，只是结束的先后不同 */
  const orderA = [
    { kind: 'tool', tool: 'a', id: 'a1', ts: 0 },
    { kind: 'tool', tool: 'b', id: 'b1', ts: 1 },
    { kind: 'tool_end', tool: 'a', id: 'a1', ts: 2, ok: true },
    { kind: 'tool_end', tool: 'b', id: 'b1', ts: 3, ok: true },
  ];
  const orderB = [
    { kind: 'tool', tool: 'a', id: 'a1', ts: 0 },
    { kind: 'tool', tool: 'b', id: 'b1', ts: 1 },
    { kind: 'tool_end', tool: 'b', id: 'b1', ts: 2, ok: true },
    { kind: 'tool_end', tool: 'a', id: 'a1', ts: 3, ok: true },
  ];
  const r1 = pairReport(orderA);
  const r2 = pairReport(orderB);
  assert.equal(r1.pairedById, 2);
  assert.equal(r2.pairedById, 2);
  assert.equal(r1.perfect && r2.perfect, true);
});

test('结束事件先于开始事件到达 = 如实记孤儿，不靠顺序硬配', () => {
  /*
   * 这是真实的乱序风险：重连/重放可能让结束先到。
   * 正确做法是如实报孤儿（director 会补造一个再结算），
   * 而不是为了"凑齐配对率"把它硬塞给后面才来的开始事件。
   */
  const reversed = [
    { kind: 'tool_end', tool: 'b', id: 'b1', ts: 2, ok: true },
    { kind: 'tool', tool: 'b', id: 'b1', ts: 1 },
  ];
  const r = pairReport(reversed);
  assert.equal(r.orphanResults, 1);
  assert.equal(r.orphanCalls, 1);
  assert.equal(r.perfect, false);
});

test('配对规则表是公开契约（文档与代码同一份）', () => {
  assert.ok(PAIRING_RULES.length >= 6);
  assert.match(PAIRING_RULES[0], /String\(ev\.id\)/);
});

test('数字 id 与字符串 id 视为同一个调用', () => {
  const events = [
    { kind: 'tool', tool: 'read', id: 7, ts: 0 },
    { kind: 'tool_end', tool: 'read', id: '7', ts: 1, ok: true },
  ];
  const r = pairReport(events);
  assert.equal(r.pairedById, 1, '数字 7 和字符串 "7" 必须配得上（director 按字符串比）');
});

/* ------------------------------------------------------------------ *
 * 重复上报 / 时间轴
 * ------------------------------------------------------------------ */

test('duplicateReport 与 build-events 的 kind+id 去重口径一致', () => {
  const r = duplicateReport(realDoc.events);
  assert.equal(r.count, 0, '真实数据不该有重复上报');
  const dup = duplicateReport([
    { kind: 'tool', tool: 'x', id: 'a', ts: 0 },
    { kind: 'tool', tool: 'x', id: 'a', ts: 0 },
    { kind: 'tool_end', tool: 'x', id: 'a', ts: 1, ok: true },
  ]);
  assert.equal(dup.count, 1);
  assert.equal(dup.totalExtra, 1);
  assert.deepEqual(dup.ids, ['tool:a']);
});

test('耗时去重：tool 和 tool_end 带同一个 realMs 时不能算两遍', () => {
  const t = describeTimeline(realDoc.events);
  const meta = realDoc.meta;
  assert.equal(
    t.durationSumMs,
    meta.realDurSumMs,
    `耗时合计必须等于 build-events 写进 meta 的 ${meta.realDurSumMs}（实际 ${t.durationSumMs}）`,
  );
  assert.equal(t.durationCount, 292);
  assert.equal(t.durationMaxMs, 42218);
  assert.equal(t.durationMinMs, 3);
});

test('时间跨度与 build-events 的播放时长一致', () => {
  const t = describeTimeline(realDoc.events);
  assert.equal(t.lastTs, realDoc.meta.playDurMs);
  assert.equal(t.firstTs, 0);
  assert.equal(t.spanMs, realDoc.meta.playDurMs);
});

test('空数组/非数组输入不崩', () => {
  assert.doesNotThrow(() => pairReport(undefined));
  assert.doesNotThrow(() => duplicateReport(null));
  assert.doesNotThrow(() => describeTimeline('nope'));
  assert.equal(describeTimeline([]).durationMinMs, null);
  assert.equal(pairReport([]).pairingRate, 1, '没有调用时配对率视为 1（不是 NaN）');
});

test('formatIssues 对空输入返回空数组', () => {
  assert.deepEqual(formatIssues(null), []);
  assert.deepEqual(formatIssues([]), []);
});
