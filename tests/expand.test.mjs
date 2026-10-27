/**
 * tests/expand.test.mjs —— 预展平层（`adapters/expand.mjs`）的测试
 *
 * ===== 诚实声明（别把这份测试读成"已支持 Claude Code"）=====
 *
 * - `adapters/profiles/claude-code.json` / `codex.json` / `cursor.json` 三份配置
 *   **只在小样本合成夹具上验证过，从未对任何真实转录验证过**。
 * - 本文件里所有输入都是**我们自己手写的合成形状**，按 `docs/ADAPTERS.md`
 *   的描述构造。**没有一行来自真实 Claude Code 转录**，所以：
 *     测试全绿 ≠ 能接真实日志。它只证明"如果真实日志长这样，这条链路是通的"。
 * - 真实转录的形状可能与本文件的假设不同（字段改名、多一层包装、content 里
 *   出现我们没枚举的块类型……）。补验方式见文件末尾 `真实转录补验方法`。
 *
 * ===== 这份测试要证明的四件事 =====
 *
 * 1. `message.content[]` 里的 `tool_use` / `tool_result` 展平后，能被
 *    `generic.mjs` + `profiles/claude-code.json` 翻成协议事件，并**过 validate**。
 * 2. 展平后 `pairReport()` 配对率 **100%**（id 一个都没丢）
 *    —— 这是回归红线：历史上 292 次调用被判成 283 次配对的误判事故。
 * 3. 缺时刻的块**不被伪造时刻**（不许出现 `Date.now()` 那种东西）。
 * 4. 嵌套 / 多 message 的常见形态也能展平。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  expandRecords,
  expandRecord,
  flatten,
  DROP_CODE,
  EXPAND_VERSION,
} from '../adapters/expand.mjs';
import { compileProfile, loadProfile, createMapStats } from '../adapters/generic.mjs';
import { validate, normalize, pairReport, duplicateReport, KIND } from '../protocol/events.mjs';

const PROFILE_DIR = fileURLToPath(new URL('../adapters/profiles', import.meta.url));
const readUtf8 = (p) => readFileSync(p, 'utf8');
const profileIO = { readFile: readUtf8, profileDir: PROFILE_DIR };

/**
 * 走完整链路：原始记录 → expand → generic+profile → 协议事件。
 *
 * 返回的 `events` 已过 `validate()`；`rejected` 里是没过校验的（应当为空）。
 * 这条链路就是 doctor 的 `--file … --profile claude-code` 在做的事
 * （doctor 里多一步 `readFileOnce()`，不改变形状）。
 */
function runChain(records, mapper) {
  const expanded = expandRecords(records);
  const m = mapper ?? loadProfile('claude-code', profileIO);
  const stats = createMapStats();
  const events = [];
  const rejected = [];
  for (const rec of expanded.records) {
    const r = m.mapRecord(rec);
    stats.count(rec, r);
    if (!r.mapped) continue;
    const n = normalize(r.event);
    if (n.ok) events.push(n.event);
    else rejected.push(n.errors);
  }
  return { expanded, events, rejected, stats: stats.snapshot() };
}

/* ------------------------------------------------------------------ *
 * 0. 模块本身：纯函数、无 node: 依赖
 * ------------------------------------------------------------------ */

test('expand.mjs 是纯 ESM、不引 node: 内建（浏览器可直接 import）', () => {
  const src = readUtf8(fileURLToPath(new URL('../adapters/expand.mjs', import.meta.url)));
  assert.equal(/from\s+['"]node:/.test(src), false, '展平层不该依赖 node: 内建');
  assert.equal(/require\s*\(/.test(src), false, '不该用 require');
  assert.equal(EXPAND_VERSION >= 1, true);
});

test('展平是纯函数：不改入参、不读时钟', () => {
  const rec = {
    type: 'assistant',
    timestamp: 1000,
    message: {
      content: [{ type: 'tool_use', id: 'a1', name: 'Read', input: { file_path: 'x' } }],
    },
  };
  const snapshot = JSON.stringify(rec);
  const out1 = expandRecord(rec);
  const out2 = expandRecord(rec);
  assert.equal(JSON.stringify(rec), snapshot, '入参被改动了');
  assert.deepEqual(out1, out2, '同一输入两次展平结果必须一致（不许带入当前时间）');
  assert.equal(out1[0].type, 'tool_use');
  assert.equal(out1[0].id, 'a1');
  assert.equal(out1[0].name, 'Read');
  assert.equal(out1[0].timestamp, 1000);
});

/* ------------------------------------------------------------------ *
 * 1. content[] 展平 → 协议事件（过 validate）
 * ------------------------------------------------------------------ */

test('① content[] 里的 tool_use/tool_result 展平后能过协议校验', () => {
  /*
   * 合成输入：一场"读文件 + 跑命令"的最小会话。
   * 一条 assistant 记录里塞两个工具块（真实形状里很常见），
   * 紧接着两条 user 记录各带一个 tool_result。
   */
  const records = [
    { type: 'summary', summary: '会话开始', session_id: 's1' },
    {
      type: 'assistant',
      timestamp: '2025-01-01T00:00:00.000Z',
      session_id: 's1',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: '我先读一下文件。' },
          { type: 'tool_use', id: 'toolu_01A', name: 'Read', input: { file_path: 'a.mjs' } },
          { type: 'tool_use', id: 'toolu_01B', name: 'Bash', input: { command: 'ls' } },
        ],
      },
    },
    {
      type: 'user',
      timestamp: '2025-01-01T00:00:01.000Z',
      session_id: 's1',
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_01A', is_error: false, duration_ms: 799 },
        ],
      },
    },
    {
      type: 'user',
      timestamp: '2025-01-01T00:00:02.000Z',
      session_id: 's1',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_01B', is_error: false }],
      },
    },
  ];

  const { expanded, events, rejected, stats } = runChain(records);

  /*
   * 展平：2 条 assistant 记录含 4 个工具块 → 4 条扁平记录；
   * summary 记录没有 content[]，如实透传 1 条（下游按 envelope 跳过，不是丢）。
   */
  assert.equal(expanded.stats.outputRecords, 5, `应展平出 5 条扁平记录，实际 ${expanded.stats.outputRecords}`);
  assert.equal(stats.total, 5, `映射结果应喂入 5 条扁平记录，实际 ${stats.total}`);
  assert.equal(stats.mapped, 4, `应 4/5 映射成功（summary 是信封），实际 ${JSON.stringify(stats.byCode)}`);
  assert.equal(stats.byCode['ignored-record-type'], 1, 'summary 必须被如实计为信封，不是静默消失');
  assert.equal(rejected.length, 0, '不应有事件被协议校验拒绝');
  assert.equal(events.length, 4, `应产出 4 条协议事件，实际 ${events.length}`);

  /* 展平统计：两个 tool_use、两个 tool_result，文本块如实计数丢弃 */
  assert.equal(expanded.stats.toolUse, 2);
  assert.equal(expanded.stats.toolResult, 2);
  assert.equal(expanded.stats.droppedByCode[DROP_CODE.TEXT_BLOCK], 1,
    '普通 text 块应被计成 text-block 丢弃，而不是静默消失');

  /* 事件形状：kind 只有 tool / tool_end，且每一条都过 validate */
  for (const ev of events) {
    const v = validate(ev);
    assert.equal(v.ok, true, `事件没过 validate：${JSON.stringify(v.errors)}`);
    assert.equal(ev.kind === KIND.TOOL || ev.kind === KIND.TOOL_END, true, `意外 kind ${ev.kind}`);
    assert.equal(typeof ev.ts, 'number', 'ts 必须是毫秒数字');
  }

  const starts = events.filter((e) => e.kind === KIND.TOOL);
  const ends = events.filter((e) => e.kind === KIND.TOOL_END);
  assert.deepEqual(starts.map((e) => e.tool), ['Read', 'Bash'], '开始事件的工具名与顺序');
  /* 合成输入里有同一时刻的两条记录：ts 顺序必须跟着输入走 */
  assert.deepEqual(starts.map((e) => e.id), ['toolu_01A', 'toolu_01B'], '开始事件的 id 原样保留');
  assert.deepEqual(ends.map((e) => e.id), ['toolu_01A', 'toolu_01B'], '结束事件的 id 来自 tool_use_id');

  /* realMs：只有第一个 result 块给了 duration_ms */
  assert.equal(ends[0].realMs, 799);
  assert.equal(ends[1].realMs, undefined, '没给耗时就不许有 realMs');
  /* ok：is_error:false → ok:true（trueMeansFail 语义） */
  assert.equal(ends[0].ok, true);
});

test('①-b 顶层工具块（已经扁平过的日志）原样透传，不被展平层吃掉', () => {
  const records = [
    { type: 'tool_use', id: 'x1', name: 'Edit', timestamp: 10 },
    { type: 'tool_result', tool_use_id: 'x1', is_error: true, timestamp: 20 },
  ];
  const { expanded, events } = runChain(records);
  assert.equal(expanded.stats.passthrough, 2, '无 content[] 的记录应原样透传');
  assert.equal(events.length, 2);
  assert.equal(events[1].ok, false, 'is_error:true 必须翻成 ok:false');
  assert.equal(pairReport(events).pairingRate, 1);
});

/* ------------------------------------------------------------------ *
 * 2. 配对率（回归红线）
 * ------------------------------------------------------------------ */

test('② 展平后 pairReport 配对率 100%：多次同名调用也不许并成一次', () => {
  /*
   * 这是红线用例的展平版：**同一个工具名被调用 3 次**，3 个不同 id。
   * 配对口径若按工具名走，就会变成 1 次调用 —— 正是 292 → 283 那次事故。
   * 展平层唯一可能犯这个错的方式是丢 id / 改写 id，所以这里针对性地查。
   */
  const mk = (n) => ({
    type: 'assistant',
    timestamp: 1000,
    message: {
      content: [{ type: 'tool_use', id: `toolu_read_${n}`, name: 'Read', input: {} }],
    },
  });
  /*
   * 注意 `is_error` 是**必填**的：协议里 `tool_end` 要求 `ok` 布尔，
   * 而 generic.mjs 的 resolveOk 取不到就不写 ok（绝不默认 true ——
   * 默认成功等于凭空记一次击杀）。所以合成夹具按文档形状带上它。
   */
  const mkr = (n) => ({
    type: 'user',
    timestamp: 1100,
    message: {
      content: [{ type: 'tool_result', tool_use_id: `toolu_read_${n}`, is_error: false }],
    },
  });

  const records = [mk(1), mk(2), mk(3), mkr(1), mkr(2), mkr(3)];
  const { events } = runChain(records);

  const report = pairReport(events);
  assert.equal(report.callsTotal, 3, '3 次同名调用必须算 3 次');
  assert.equal(report.resultsTotal, 3);
  assert.equal(report.callsWithId, 3, 'id 一个都不许丢');
  assert.equal(report.anonymousCalls, 0, '不许退化成无 id 的 FIFO 配对');
  assert.equal(report.pairedById, 3, '必须全部按 id 配对');
  assert.equal(report.pairingRate, 1, `配对率必须 100%，实际 ${report.pairingRate}`);
  assert.equal(report.perfect, true, `配对必须完美：${JSON.stringify(report)}`);
  assert.equal(report.orphanCalls, 0);
  assert.equal(report.orphanResults, 0);
  assert.equal(report.duplicateResults, 0);

  /* 重复上报也必须是 0：展平层不该把同一个块吐两遍 */
  assert.equal(duplicateReport(events).count, 0);

  /* id 必须原样出现在事件里，字符级相等 */
  assert.deepEqual(
    events.filter((e) => e.kind === KIND.TOOL).map((e) => e.id).sort(),
    ['toolu_read_1', 'toolu_read_2', 'toolu_read_3'],
  );
});

test('②-b 缺 id 时如实报警、不编 id；无 id 且无工具名就如实配不上', () => {
  /*
   * 展平层唯一不许做的事：为缺 id 的块**造**一个 id。
   * 造了会怎样？配对率看起来 100%，但那 100% 是编出来的 ——
   * 比"配不上"危害大得多（配不上会被 doctor 报出来，编的不会）。
   *
   * 这里还有一层真实语义：Claude Code 的 tool_result 通常**只带**
   * tool_use_id、不带工具名。所以一旦 id 丢了，同工具 FIFO 也救不回来
   * （FIFO 要按工具名排队）。正确行为是如实配不上，而不是猜个名字凑上。
   */
  const records = [
    { type: 'assistant', timestamp: 1, message: { content: [{ type: 'tool_use', name: 'Read' }] } },
    {
      type: 'user',
      timestamp: 2,
      message: { content: [{ type: 'tool_result', is_error: false }] },
    },
  ];
  const { events } = runChain(records);
  assert.equal(events.length, 2, '缺 id 也要照样产出事件（丢事件比缺 id 更糟）');
  for (const ev of events) {
    assert.equal(ev.id, undefined, '不许为缺 id 的块编造 id');
  }

  const report = pairReport(events);
  assert.equal(report.callsTotal, 1);
  assert.equal(report.resultsTotal, 1);
  assert.equal(report.callsWithId, 0, '不许把编出来的 id 算进精确配对');
  assert.equal(report.paired, 0, '无 id 且结束事件无工具名 → 配不上，如实');
  assert.equal(report.pairingRate, 0, `配不上就是 0%，实际 ${report.pairingRate}`);
  assert.equal(report.perfect, false);

  /* 协议本身会就"缺 id"给出 warn（不是 error：director 有 FIFO 兜底） */
  const v = validate(events[0]);
  assert.equal(v.warnings.some((w) => w.code === 'missing-id'), true, '缺 id 必须有 warn');

  /* 展平层要如实报"缺 id"，别静默 */
  const { issues } = expandRecords(records);
  assert.equal(issues.some((i) => i.code === 'missing-block-id'), true, '缺 id 必须留下 issue');
});

test('②-c 展平层不补 is_error；claude-code 的 absent=success 必须显式记账', () => {
  /*
   * 展平层仍然不许补 is_error。那是伪造字段。
   * claude-code profile 另有一条写明的缺省规则：is_error 不在时记成功。
   * 这条规则必须从 okVia 看得见。没写 absent 的 profile 仍然不许补 ok。
   */
  const records = [{
    type: 'user',
    timestamp: 3,
    message: { content: [{ type: 'tool_result', tool_use_id: 'q1' }] },
  }];
  const expanded = expandRecords(records);
  assert.equal('is_error' in expanded.records[0], false, '不许补 is_error');

  const silent = compileProfile({
    profile: 'no-absent',
    start: { type: ['tool_use'] },
    end: { type: ['tool_result'] },
    id: ['tool_use_id'],
    tool: ['name'],
    ts: ['timestamp'],
    ok: { path: ['is_error'], trueMeansFail: true },
  });
  const bare = silent.mapRecord(expanded.records[0]);
  assert.equal(bare.mapped, true);
  assert.equal('ok' in bare.event, false, '没声明 absent 时不许补 ok');
  assert.equal(validate(bare.event).ok, false);

  const m = loadProfile('claude-code', profileIO);
  const r = m.mapRecord(expanded.records[0]);
  assert.equal(r.mapped, true, '事件本身是映射成功的');
  assert.equal(r.event.ok, true);
  assert.equal(r.okVia, 'absent-success', '缺省成功必须能被 doctor 单独计数');
});

/* ------------------------------------------------------------------ *
 * 3. 缺时刻不被伪造
 * ------------------------------------------------------------------ */

test('③ 缺时刻的块不被伪造时刻：不写 timestamp，下游报 missing-ts', () => {
  /*
   * 合成输入：**整条链路都没有任何时刻字段**（块没有、message 没有、记录也没有）。
   * 正确行为：展平记录里根本没有 timestamp 这个键 → generic 报 missing-ts →
   * 这条被如实跳过。**绝不能**出现 `Date.now()`。
   */
  const records = [
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'n1', name: 'Read' }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'n1' }] } },
  ];

  const expanded = expandRecords(records);
  assert.equal(expanded.records.length, 2, '缺时刻也要展平出来（丢不丢是下游的事）');
  for (const rec of expanded.records) {
    assert.equal(Object.prototype.hasOwnProperty.call(rec, 'timestamp'), false,
      `不许给缺时刻的块填 timestamp，实际 ${JSON.stringify(rec)}`);
    assert.equal(Object.prototype.hasOwnProperty.call(rec, 'ts'), false, '也不许换成 ts 塞进去');
  }
  assert.equal(expanded.stats.missingTimestamp, 2, '缺时刻必须被计数');
  assert.equal(expanded.issues.filter((i) => i.code === 'missing-timestamp').length, 2);

  /* 下游：没有实时时钟 → missing-ts，如实跳过（而不是凭空造条事件） */
  const m = loadProfile('claude-code', profileIO);
  const now = Date.now();
  const after = Date.now();
  for (const rec of expanded.records) {
    const r = m.mapRecord(rec); // 不传 now = 一次性读文件，没有实时时钟可用
    assert.equal(r.mapped, false, '缺时刻且无实时时钟不许映射成功');
    assert.equal(r.code, 'missing-ts', `应报 missing-ts，实际 ${r.code}`);
  }

  /* 也不许掏出"现在"：采样窗口内的 Date.now() 不该出现在任何展平结果里 */
  const flat = flatten(records);
  for (const rec of flat) {
    assert.equal(rec.timestamp, undefined);
  }
  assert.equal(flat.some((r) => r.timestamp >= now && r.timestamp <= after + 1000), false,
    '展平结果里出现了当前时间 —— 这是伪造历史时刻');
});

test('③-b 记录级时刻可以继承（是真的值，不是编的），块级优先', () => {
  const inherited = expandRecord({
    type: 'assistant',
    timestamp: 42,
    message: { content: [{ type: 'tool_use', id: 'i1', name: 'Read' }] },
  });
  assert.equal(inherited[0].timestamp, 42, '应继承同一记录上真实写着的 timestamp');

  const own = expandRecord({
    type: 'assistant',
    timestamp: 42,
    message: { content: [{ type: 'tool_use', id: 'i1', name: 'Read', timestamp: 7 }] },
  });
  assert.equal(own[0].timestamp, 7, '块自己的时刻优先于记录级继承');
});

/* ------------------------------------------------------------------ *
 * 4. 嵌套 / 多 message 形态
 * ------------------------------------------------------------------ */

test('④ message 是数组 / messages[] 批量导出 / 裸 content[] 都能展平', () => {
  /* 形态 A：message 本身是数组（一条记录含多轮） */
  const a = {
    type: 'assistant',
    timestamp: 100,
    message: [
      { content: [{ type: 'tool_use', id: 'a1', name: 'Read' }] },
      { content: [{ type: 'tool_use', id: 'a2', name: 'Bash' }] },
    ],
  };
  const ra = expandRecord(a);
  assert.deepEqual(ra.map((r) => r.id), ['a1', 'a2'], 'message[] 里每个 message 的工具块都要展平');
  assert.deepEqual(ra.map((r) => r.timestamp), [100, 100], '都继承记录级时刻');

  /* 形态 B：批量导出的 messages[] */
  const b = {
    session_id: 's9',
    messages: [
      { role: 'assistant', timestamp: 5, content: [{ type: 'tool_use', id: 'b1', name: 'Read' }] },
      { role: 'user', timestamp: 6, content: [{ type: 'tool_result', tool_use_id: 'b1' }] },
    ],
  };
  const rb = expandRecord(b);
  assert.deepEqual(rb.map((r) => r.type), ['tool_use', 'tool_result']);
  assert.deepEqual(rb.map((r) => r.id ?? r.tool_use_id), ['b1', 'b1'], 'id 必须跨记录配得上');
  assert.deepEqual(rb.map((r) => r.session_id), ['s9', 's9'], '会话 id 要透传');

  /* 形态 C：裸 content[]（没有 message 包装） */
  const c = { type: 'assistant', timestamp: 9, content: [{ type: 'tool_use', id: 'c1', name: 'Edit' }] };
  const rc = expandRecord(c);
  assert.equal(rc.length, 1);
  assert.equal(rc[0].id, 'c1');

  /* 三种形态一起过链路：id 全部保留、全部映射成功 */
  const { events, stats } = runChain([a, b, c]);
  assert.equal(stats.mapped, 5, `应 5 条全映射，实际 ${JSON.stringify(stats.byCode)}`);
  const ids = events.filter((e) => e.kind === KIND.TOOL).map((e) => e.id).sort();
  assert.deepEqual(ids, ['a1', 'a2', 'b1', 'c1']);
});

test('④-b 无关块如实分类计数（text/thinking/未知），不静默消失', () => {
  const records = [{
    type: 'assistant',
    timestamp: 1,
    message: {
      content: [
        { type: 'text', text: 'hi' },
        { type: 'thinking', thinking: '...' },
        { type: 'server_tool_use', id: 'zzz' },
        null,
        { type: 'tool_use', id: 'k1', name: 'Read' },
      ],
    },
  }];
  const { records: flat, stats } = expandRecords(records);
  assert.equal(flat.length, 1, '只有 tool_use 块该变成扁平记录');
  assert.equal(flat[0].id, 'k1', '有 id 的块必须保留 id');
  assert.equal(stats.dropped, 4, `应丢掉 4 个块，实际 ${stats.dropped}`);
  assert.equal(stats.droppedByCode[DROP_CODE.TEXT_BLOCK], 1);
  assert.equal(stats.droppedByCode[DROP_CODE.THINKING_BLOCK], 1);
  assert.equal(stats.droppedByCode[DROP_CODE.UNKNOWN_BLOCK], 1);
  assert.equal(stats.droppedByCode[DROP_CODE.NOT_OBJECT], 1);
  assert.equal(stats.droppedBlockTypes.server_tool_use, 1, '未知块类型要单独留名字');
});

test('④-c 工具入参与结果正文不摊进扁平记录（体积 + 隐私）', () => {
  const records = [{
    type: 'assistant',
    timestamp: 1,
    secret_token: 'leak-me',
    message: {
      content: [{
        type: 'tool_use',
        id: 'p1',
        name: 'Bash',
        input: { command: 'cat token.txt', secret_token: 'leak-me' },
      }],
    },
  }];
  const flat = expandRecord(records[0])[0];
  assert.equal(flat.input, undefined, '工具入参不许进扁平记录');
  assert.equal(flat.secret_token, undefined, '记录上没点名的字段不许被带出来');
  assert.deepEqual(Object.keys(flat).sort(), ['id', 'name', 'timestamp', 'type']);
});

/* ------------------------------------------------------------------ *
 * 5. 工具名回填（按 id 查表，不是猜）
 * ------------------------------------------------------------------ */

test('⑤ tool_result 不带工具名时，按 id 从 tool_use 查回真名', () => {
  /*
   * 合成形状：tool_result 只带 tool_use_id（真实日志常见）。
   * 正确行为：按 id 到**同一份日志的** tool_use 记录里查名字 ——
   * 这是外键 join，查到的名字是原文里真实存在的值。
   * 不查表的话，每条 tool_end 都会掉一条 `missing-tool-on-end` warn，
   * 而且画面上击杀没有名字可显示。
   */
  const records = [
    { type: 'assistant', timestamp: 1, message: { content: [
      { type: 'tool_use', id: 'u1', name: 'Read' },
      { type: 'tool_use', id: 'u2', name: 'Bash' },
    ] } },
    { type: 'user', timestamp: 2, message: { content: [
      { type: 'tool_result', tool_use_id: 'u2', is_error: false },
      { type: 'tool_result', tool_use_id: 'u1', is_error: false },
    ] } },
  ];
  const expanded = expandRecords(records);
  const ends = expanded.records.filter((r) => r.type === 'tool_result');
  assert.deepEqual(ends.map((r) => r.name), ['Bash', 'Read'], '名字要按各自的 id 查，不能按顺序摊');
  assert.equal(expanded.stats.nameBackfilled, 2);

  const { events } = runChain(records);
  const toolEnds = events.filter((e) => e.kind === KIND.TOOL_END);
  assert.deepEqual(toolEnds.map((e) => [e.id, e.tool]), [['u2', 'Bash'], ['u1', 'Read']],
    'tool_end 必须带对工具名（id 与名字不许错配）');
  for (const ev of toolEnds) {
    assert.equal(validate(ev).warnings.some((w) => w.code === 'missing-tool-on-end'), false);
  }
  assert.equal(pairReport(events).pairingRate, 1);
});

test('⑤-b 查不到就空着：不填占位名；同 id 多名字时也不填（那是脏数据）', () => {
  /* 情形 1：日志从会话中途开始 —— 只有 result，没有对应 tool_use */
  const orphanOnly = expandRecords([
    { type: 'user', timestamp: 1, message: { content: [
      { type: 'tool_result', tool_use_id: 'ghost', is_error: false },
    ] } },
  ]);
  assert.equal('name' in orphanOnly.records[0], false, '查不到名字就不许填，更不许填 "unknown"');
  assert.equal(orphanOnly.stats.nameBackfilled, 0);

  /* 情形 2：同一个 id 上出现两个不同工具名 → 不猜，记冲突 */
  const conflict = expandRecords([
    { type: 'assistant', timestamp: 1, message: { content: [
      { type: 'tool_use', id: 'dup', name: 'Read' },
      { type: 'tool_use', id: 'dup', name: 'Bash' },
    ] } },
    { type: 'user', timestamp: 2, message: { content: [
      { type: 'tool_result', tool_use_id: 'dup', is_error: false },
    ] } },
  ]);
  const end = conflict.records.find((r) => r.type === 'tool_result');
  assert.equal('name' in end, false, '同 id 多名字时挑一个就是猜，不许填');
  assert.equal(conflict.stats.nameBackfillConflicts, 1, '冲突必须计数上报');

  /* 也可以整体关掉回填（想让输出与原始日志逐字一致时） */
  const off = expandRecords([
    { type: 'assistant', timestamp: 1, message: { content: [{ type: 'tool_use', id: 'z', name: 'Read' }] } },
    { type: 'user', timestamp: 2, message: { content: [{ type: 'tool_result', tool_use_id: 'z', is_error: false }] } },
  ], { backfillNames: false });
  assert.equal('name' in off.records.find((r) => r.type === 'tool_result'), false);
  assert.equal(off.stats.nameBackfilled, 0);
});

/* ------------------------------------------------------------------ *
 * 真实转录补验方法（写在这里方便日后照抄，不是自动化测试）
 * ------------------------------------------------------------------ *
 *
 * 上面的用例全部是**合成夹具**。要宣称"支持 Claude Code"，必须补下面这一步，
 * 而且要在 docs/ADAPTERS.md 里同时更新"已对真实转录验证"的说法：
 *
 *   # 1) 把真实 transcript 展平（expand 是纯函数，用 node -e 直接 import 即可）
 *   node --input-type=module -e "
 *     import {readFileSync} from 'node:fs';
 *     import {expandRecords} from './adapters/expand.mjs';
 *     const recs = readFileSync(process.argv[1],'utf8')
 *       .split('\n').filter(l=>l.trim()).map(l=>JSON.parse(l));
 *     const r = expandRecords(recs);
 *     for (const x of r.records) console.log(JSON.stringify(x));
 *     console.error(JSON.stringify(r.stats));
 *   " ~/.claude/projects/<会话>.jsonl > flat.jsonl
 *
 *   # 2) 过 doctor（这一步的 exit 0 才是"接上了"）
 *   node tools/doctor.mjs --file flat.jsonl --profile claude-code
 *
 *   # 3) 关键看两行：映射结果（成功率）与 id 配对（必须 perfect）
 *   #    配对不完美 = 展平层丢了 id；映射率低 = 真实形状与 profile 不符
 */

test('补验方法在文件里有据可查（防止这段话被顺手删掉）', () => {
  const self = readUtf8(fileURLToPath(import.meta.url));
  assert.equal(self.includes('node tools/doctor.mjs --file flat.jsonl --profile claude-code'), true);
  assert.equal(/合成夹具/.test(self), true);
});
