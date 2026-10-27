/**
 * tests/adapters.test.mjs —— 四个适配器的测试
 *
 * 每个适配器都要证两件事：
 *   1. 能接：正常数据能变成协议事件
 *   2. 不骗人：坏数据给可读错误/计数，绝不伪造、绝不静默丢
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, appendFile, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

import {
  detectShape,
  parseJsonlChunk,
  parseWholeJson,
  readFileOnce,
  openFileSource,
  FILE_SHAPE,
} from '../adapters/jsonl-file.mjs';
import { readJsonlStream, collectStdin } from '../adapters/stdin.mjs';
import { startHttpHook, consumeSse, LISTEN_HOST, normalizeSseUrl } from '../adapters/http-hook.mjs';
import {
  compileProfile,
  createMapStats,
  loadProfile,
  matchRule,
  pickPath,
  toMs,
  SKIP_CODE,
  BUILTIN_PROFILES,
} from '../adapters/generic.mjs';

const PROFILE_DIR = fileURLToPath(new URL('../adapters/profiles', import.meta.url));
const readUtf8 = (p) => readFileSync(p, 'utf8');
const profileIO = { readFile: readUtf8, profileDir: PROFILE_DIR };

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'agent-shield-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** 轮询等待条件成立（避免固定 sleep 造成 flaky）。 */
async function waitFor(cond, timeoutMs = 2000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`waitFor 超时（${timeoutMs}ms）`);
}

/* ================================================================== *
 * jsonl-file
 * ================================================================== */

test('文件形态探测只看首个非空白字符', () => {
  assert.equal(detectShape('{"events":[]}'), FILE_SHAPE.JSON_EVENTS);
  assert.equal(detectShape('\n\n   [1,2]'), FILE_SHAPE.JSON_ARRAY);
  assert.equal(detectShape('\uFEFF{"a":1}'), FILE_SHAPE.JSON_EVENTS);
  assert.equal(detectShape('{"a":1}\n{"a":2}\n'), FILE_SHAPE.JSON_EVENTS);
  assert.equal(detectShape(''), FILE_SHAPE.JSONL);
  assert.equal(detectShape('not json at all\n'), FILE_SHAPE.JSONL);
});

test('JSONL 解析：末行不完整时留成 tail，不误报坏行', () => {
  const r = parseJsonlChunk('{"kind":"tool"}\n{"kind":"tool_end"');
  assert.equal(r.events.length, 1, '完整的行才算事件');
  assert.equal(r.badLines.length, 0, '半行不该被当成坏行');
  assert.equal(r.tail, '{"kind":"tool_end"');
});

test('JSONL 解析：坏行带行号，继续解析后面的行', () => {
  const r = parseJsonlChunk('{"a":1}\n@@@\n{"a":3}\n');
  assert.equal(r.events.length, 2, '坏行不该中断后面的解析');
  assert.equal(r.badLines.length, 1);
  assert.equal(r.badLines[0].line, 2);
  assert.match(r.badLines[0].message, /JSON/i);
});

test('整文件 JSON：形态对不上时如实报原因，不猜', () => {
  const wrong = parseWholeJson('{"items":[1]}', FILE_SHAPE.JSON_EVENTS);
  assert.equal(wrong.ok, false);
  assert.match(wrong.reason, /events/);

  const arr = parseWholeJson('[1,2]', FILE_SHAPE.JSON_ARRAY);
  assert.equal(arr.ok, true);
  assert.deepEqual(arr.events, [1, 2]);

  const broken = parseWholeJson('{"events":[', FILE_SHAPE.JSON_EVENTS);
  assert.equal(broken.ok, false);
  assert.match(broken.reason, /解析失败/);
});

test('readFileOnce 读 JSON-with-events 形态', async () => {
  await withTempDir(async (dir) => {
    const f = join(dir, 'ev.json');
    await writeFile(
      f,
      JSON.stringify({ meta: { s: 1 }, events: [{ kind: 'tool', tool: 'x', ts: 0 }] }),
      'utf8',
    );
    const r = await readFileOnce(f);
    assert.equal(r.shape, FILE_SHAPE.JSON_EVENTS);
    assert.equal(r.events.length, 1);
    assert.equal(r.badLines.length, 0);
    assert.deepEqual(r.meta, { s: 1 });
  });
});

test('readFileOnce 读 JSONL，并把坏行单独报出来', async () => {
  await withTempDir(async (dir) => {
    const f = join(dir, 'ev.jsonl');
    await writeFile(
      f,
      '{"kind":"tool","tool":"a","ts":0}\nOOPS\n{"kind":"tool_end","tool":"a","ts":1,"ok":true}\n',
      'utf8',
    );
    const r = await readFileOnce(f);
    assert.equal(r.shape, FILE_SHAPE.JSONL);
    assert.equal(r.events.length, 2);
    assert.equal(r.badLines.length, 1);
    assert.equal(r.badLines[0].line, 2);
    assert.equal(r.issues.length, 1);
  });
});

test('openFileSource 增量读 JSONL：只读新追加的部分', async () => {
  await withTempDir(async (dir) => {
    const f = join(dir, 'live.jsonl');
    await writeFile(f, '{"kind":"tool","tool":"a","ts":0}\n', 'utf8');

    const src = await openFileSource(f);
    assert.equal(src.shape, FILE_SHAPE.JSONL);

    const first = await src.poll();
    assert.equal(first.events.length, 1);

    /* 没有新内容：不该重复发 */
    const second = await src.poll();
    assert.equal(second.events.length, 0, '没有追加时不能重复下发');

    /* 追加两条（第二条故意没有换行 = 半行） */
    await appendFile(f, '{"kind":"tool_end","tool":"a","ts":1,"ok":true}\n{"kind":"tool"', 'utf8');
    const third = await src.poll();
    assert.equal(third.events.length, 1, '只发完整的那一行');
    assert.equal(src.pendingBytes, '{"kind":"tool"'.length, '半行必须留着等下次');

    /* 把半行补完 */
    await appendFile(f, ',"tool":"b","ts":2}\n', 'utf8');
    const fourth = await src.poll();
    assert.equal(fourth.events.length, 1);
    assert.equal(fourth.events[0].tool, 'b');
    await src.close();
  });
});

test('openFileSource 热更新 JSON-with-events：只发新增条目', async () => {
  await withTempDir(async (dir) => {
    const f = join(dir, 'doc.json');
    const write = (events) => writeFile(f, JSON.stringify({ events }), 'utf8');

    const ev1 = { kind: 'tool', tool: 'a', ts: 0 };
    const ev2 = { kind: 'tool_end', tool: 'a', ts: 1, ok: true };
    await write([ev1]);

    const src = await openFileSource(f);
    const a = await src.poll();
    assert.equal(a.events.length, 1);

    await write([ev1, ev2]);
    const b = await src.poll();
    assert.equal(b.events.length, 1, '只发新增的那一条，不能重发历史');
    assert.equal(b.events[0].kind, 'tool_end');
    await src.close();
  });
});

test('openFileSource：文件被重写成更短时如实报告，不装作没事', async () => {
  await withTempDir(async (dir) => {
    const f = join(dir, 'doc.json');
    const issues = [];
    await writeFile(f, JSON.stringify({ events: [{ kind: 'tool', tool: 'a', ts: 0 }] }), 'utf8');
    const src = await openFileSource(f, { onIssue: (i) => issues.push(i) });
    await src.poll();

    await writeFile(f, JSON.stringify({ events: [] }), 'utf8');
    await src.poll();
    assert.ok(
      issues.some((i) => i.code === 'revision-changed'),
      '条目变少必须报 revision-changed',
    );
    await src.close();
  });
});

test('openFileSource：文件不存在时抛出（不假装"暂时没有事件"）', async () => {
  await assert.rejects(
    () => openFileSource(join(tmpdir(), `definitely-not-here-${Date.now()}`, 'x.jsonl')),
    /ENOENT|no such file/i,
  );
});

/* ------------------------------------------------------------------ *
 * 缺陷回归：空闲轮询重放（A）、字节偏移 vs 字符偏移（B）、BOM（C）
 *
 * 这三条都是"现有用例全绿也照样漏掉"的：旧用例只覆盖"追加一次再 poll"，
 * 从不做**空闲 poll**（没有新内容时的轮询），也没有非 ASCII / BOM 输入。
 * ------------------------------------------------------------------ */

/** UTF-8 BOM 的三个字节。Windows（PowerShell Set-Content、记事本、Excel）导出常带。 */
const BOM_BYTES = [0xef, 0xbb, 0xbf];
/** 把事件数组写成 JSONL 文本。 */
const jsonlText = (events) => events.map((e) => `${JSON.stringify(e)}\n`).join('');
/** 事件源一轮轮询的结果汇总，便于断言"累计"口径。 */
function tally(acc, r) {
  acc.events.push(...r.events);
  acc.badLines += r.badLines.length;
  return acc;
}

test('openFileSource 空闲轮询：不重放历史事件，也不误报 file-rotated（缺陷 A）', async () => {
  await withTempDir(async (dir) => {
    const f = join(dir, 'idle.jsonl');
    const real = [
      { kind: 'tool', tool: 'c1', ts: 0 },
      { kind: 'tool_end', tool: 'c1', ts: 1, ok: true },
      { kind: 'tool', tool: 'c2', ts: 2 },
      { kind: 'tool_end', tool: 'c2', ts: 3, ok: true },
    ];
    await writeFile(f, jsonlText(real.slice(0, 2)), 'utf8');

    const issues = [];
    const src = await openFileSource(f, { onIssue: (i) => issues.push(i) });
    const acc = { events: [], badLines: 0 };
    tally(acc, await src.poll()); // 2 条

    /* 第 3 条完整 + 第 4 条只写一半 —— 这一半会留在 pending 里 */
    const fourth = JSON.stringify(real[3]);
    await appendFile(f, `${JSON.stringify(real[2])}\n${fourth.slice(0, 12)}`, 'utf8');
    tally(acc, await src.poll()); // +1 条
    assert.ok(src.pendingBytes > 0, '半行应当留在 pending 里');
    assert.equal(acc.events.length, 3);

    /* 补完半行 */
    await appendFile(f, `${fourth.slice(12)}\n`, 'utf8');
    tally(acc, await src.poll());
    assert.equal(acc.events.length, 4, '4 条真实事件此时应当都下发过');
    assert.equal(acc.badLines, 0);

    /*
     * 关键回归：此刻**没有任何新内容**。
     *
     * 旧实现在这行把 pending 的长度多算了一次：
     *   offset = offset + pending.length + (combined.length - r.tail.length)
     * 而 combined 本身**已经包含** pending，于是 offset 越过真实文件尾；
     * 下一次 poll 满足 `now.size < offset + pending.length`，判定"文件被截断"，
     * 报一条 file-rotated 并把 offset 归零 → 从头重读，历史事件被重放。
     * 实测：4 条真实事件被下发 7 条（tool:c1 / tool_end:c1 / tool:c2 各多一次）。
     *
     * 为什么是产品红线：`tool` 开始事件被重放，director 会**凭空多生成敌人**，
     * 并抬高 seen/unmapped 计数 —— 那等于报告了根本没发生过的进度。
     */
    const idle = await src.poll();
    assert.equal(idle.events.length, 0, '没有新内容时不得下发任何事件（不得重放历史）');
    assert.equal(
      issues.filter((i) => i.code === 'file-rotated').length,
      0,
      '文件没有变短，不得误报 file-rotated',
    );

    /* 再追加一条：只发新增的这一条 */
    await appendFile(f, jsonlText([{ kind: 'tool', tool: 'c3', ts: 4 }]), 'utf8');
    tally(acc, await src.poll());
    assert.equal(acc.events.length, 5, '累计下发数必须等于真实事件数');
    assert.equal(acc.events.at(-1).tool, 'c3');
    await src.close();
  });
});

test('openFileSource 逐条追加 + 一次半行：累计下发数恰等于真实条数（缺陷 A/B）', async () => {
  await withTempDir(async (dir) => {
    const f = join(dir, 'drip.jsonl');
    const real = Array.from({ length: 6 }, (_, i) => ({
      kind: i % 2 ? 'tool_end' : 'tool',
      tool: `t${i}`,
      ts: i,
    }));
    await writeFile(f, '', 'utf8');

    const issues = [];
    const src = await openFileSource(f, { onIssue: (i) => issues.push(i) });
    const acc = { events: [], badLines: 0 };

    for (let i = 0; i < real.length; i++) {
      const line = `${JSON.stringify(real[i])}\n`;
      if (i === 2) {
        /* 第 3 条拆两次写：中间那次 poll 必须什么都不发，也不能报坏行 */
        const cut = Math.floor(line.length / 2);
        await appendFile(f, line.slice(0, cut), 'utf8');
        const mid = await src.poll();
        assert.equal(mid.events.length, 0, '半行不得被当成事件');
        assert.equal(mid.badLines.length, 0, '半行不得被当成坏行');
        await appendFile(f, line.slice(cut), 'utf8');
      } else {
        await appendFile(f, line, 'utf8');
      }
      const r = await src.poll();
      assert.equal(r.badLines.length, 0, `第 ${i + 1} 次追加不该报坏行`);
      tally(acc, r);
    }

    assert.equal(acc.events.length, real.length, '累计下发数必须恰好等于真实事件数（不能重放）');
    assert.deepEqual(
      acc.events.map((e) => e.tool),
      real.map((e) => e.tool),
      '不得重复、不得乱序、不得丢',
    );
    assert.equal(issues.filter((i) => i.code === 'file-rotated').length, 0);
    await src.close();
  });
});

test('openFileSource 非 ASCII 日志：中文 tool/id 不得产生 bad-line 误报（缺陷 B）', async () => {
  await withTempDir(async (dir) => {
    const f = join(dir, 'cjk.jsonl');
    const real = Array.from({ length: 20 }, (_, i) => ({
      kind: i % 2 ? 'tool_end' : 'tool',
      tool: `搜索文件-${i}`,
      id: `调用-${i}`,
      ts: i,
    }));
    await writeFile(f, '', 'utf8');

    const issues = [];
    const src = await openFileSource(f, { onIssue: (i) => issues.push(i) });
    const acc = { events: [], badLines: 0 };

    /*
     * 偏移量必须是**字节**语义。旧实现用 `encoding:'utf8'` 读字符串，
     * 却把统计出来的**字符数**（中文 1 字 3 字节 → 字符数 < 字节数）当字节游标，
     * 于是每轮 poll 都从错位处重读，解出来的第一行是半截 JSON →
     * 每轮报一条 bad-line（实测 20 条事件 → 19 条假错）。
     */
    for (const e of real) {
      await appendFile(f, `${JSON.stringify(e)}\n`, 'utf8');
      tally(acc, await src.poll());
    }

    assert.equal(acc.events.length, 20, '20 条中文事件必须一条不少、也不重复');
    assert.equal(acc.badLines, 0, '中文内容不得产生任何坏行');
    assert.deepEqual(
      issues.filter((i) => i.code === 'bad-line'),
      [],
      'issue 流里不得出现 bad-line',
    );
    assert.deepEqual(acc.events.map((e) => e.tool), real.map((e) => e.tool));
    await src.close();
  });
});

test('BOM + {meta,events}：readFileOnce 与 openFileSource 都要能读全（缺陷 C）', async () => {
  await withTempDir(async (dir) => {
    const f = join(dir, 'bom-events.json');
    const events = Array.from({ length: 7 }, (_, i) => ({
      kind: 'tool',
      tool: `b${i}`,
      ts: i,
    }));
    const withBom = (evs) =>
      Buffer.concat([
        Buffer.from(BOM_BYTES),
        Buffer.from(JSON.stringify({ meta: { s: evs.length }, events: evs }), 'utf8'),
      ]);

    const buf = withBom(events);
    await writeFile(f, buf);
    /* 先证明文件里**真的**有 EF BB BF，别让测试自己骗自己 */
    assert.equal(buf[0], 0xef);
    assert.equal(buf[1], 0xbb);
    assert.equal(buf[2], 0xbf);

    /*
     * 旧实现的不一致：`resolveShape` 用 trim() 判形态（BOM 被 trim 掉 →
     * 判成整文件 JSON），但 `parseWholeJson` 直接 JSON.parse 带 BOM 的文本
     * → 解析失败 → 事件全丢，而界面上是 "0 条事件 / 100.0% 完美"。
     * Windows 上 PowerShell/记事本/Excel 导出带 BOM 是常态，这是真实入口。
     */
    const once = await readFileOnce(f);
    assert.equal(once.shape, FILE_SHAPE.JSON_EVENTS);
    assert.equal(once.events.length, 7, '带 BOM 的整文件 JSON 必须解析成功');
    assert.deepEqual(once.issues, [], 'BOM 不得被当成解析失败');
    assert.deepEqual(once.meta, { s: 7 });

    const issues = [];
    const src = await openFileSource(f, { onIssue: (i) => issues.push(i) });
    const first = await src.poll();
    assert.equal(first.events.length, 7, 'openFileSource 首轮也要拿到全部事件');
    const idle = await src.poll();
    assert.equal(idle.events.length, 0, '无变化时不得重发');
    assert.deepEqual(issues, [], 'BOM 不得让增量路径报解析失败');

    /* 增量：带 BOM 重写并追加一条，只发新增 */
    await writeFile(f, withBom([...events, { kind: 'tool_end', tool: 'b7', ts: 99, ok: true }]));
    const delta = await src.poll();
    assert.equal(delta.events.length, 1, '只发新增的那一条');
    assert.equal(delta.events[0].tool, 'b7');
    await src.close();
  });
});

test('BOM + JSONL：readFileOnce 与 openFileSource 都要能读全，且游标不因 BOM 错位（缺陷 B/C）', async () => {
  await withTempDir(async (dir) => {
    const f = join(dir, 'bom.jsonl');
    const events = [
      { kind: 'tool', tool: '搜索', ts: 0 },
      { kind: 'tool_end', tool: '搜索', ts: 1, ok: true },
    ];
    await writeFile(f, Buffer.concat([Buffer.from(BOM_BYTES), Buffer.from(jsonlText(events), 'utf8')]));

    const once = await readFileOnce(f);
    assert.equal(once.shape, FILE_SHAPE.JSONL);
    assert.equal(once.events.length, 2, 'BOM + JSONL 必须两条都拿到');
    assert.deepEqual(once.issues, []);

    const issues = [];
    const src = await openFileSource(f, { onIssue: (i) => issues.push(i) });
    const first = await src.poll();
    assert.equal(first.events.length, 2);
    assert.equal(first.badLines.length, 0);
    /* 空闲 poll：BOM 不该让逐字节游标错位，从而把已消费内容再读一遍 */
    const idle = await src.poll();
    assert.equal(idle.events.length, 0, '无新内容时不得重发');
    assert.equal(idle.badLines.length, 0, '不得出现坏行');
    assert.deepEqual(issues, []);
    await src.close();
  });
});

test('半行保留：pending 按字节计，被切在多字节字符中间也不丢、不报坏行', async () => {
  await withTempDir(async (dir) => {
    const f = join(dir, 'half.jsonl');
    await writeFile(f, '', 'utf8');
    const issues = [];
    const src = await openFileSource(f, { onIssue: (i) => issues.push(i) });

    const buf = Buffer.from(`${JSON.stringify({ kind: 'tool', tool: '读取文件', id: '调用-a', ts: 0 })}\n`, 'utf8');
    /* 故意切在一个汉字**中间**（"读" 占 3 字节，只写进 1 字节） */
    const cut = buf.indexOf(Buffer.from('读', 'utf8')) + 1;
    await appendFile(f, buf.subarray(0, cut));

    const r1 = await src.poll();
    assert.equal(r1.events.length, 0, '半行不该产出事件');
    assert.equal(r1.badLines.length, 0, '半行更不该被当坏行丢掉');
    assert.equal(src.pendingBytes, cut, 'pending 必须按**字节**计');

    await appendFile(f, buf.subarray(cut));
    const r2 = await src.poll();
    assert.equal(r2.events.length, 1, '补齐后必须正好拿到这一条');
    assert.equal(r2.events[0].tool, '读取文件', '被切开的多字节字符不能被解成乱码');
    assert.equal(r2.badLines.length, 0);
    assert.deepEqual(issues, []);
    await src.close();
  });
});

/* ================================================================== *
 * stdin
 * ================================================================== */

function streamOf(text) {
  return Readable.from([Buffer.from(text, 'utf8')]);
}

test('stdin：逐行解析 JSONL，空行跳过', async () => {
  const seen = [];
  const r = readJsonlStream(streamOf('{"a":1}\n\n   \n{"a":2}\n'), {
    onEvent: (e) => seen.push(e),
  });
  await r.done;
  assert.deepEqual(seen, [{ a: 1 }, { a: 2 }]);
});

test('stdin：坏行计数并继续，不中断流', async () => {
  const seen = [];
  const bad = [];
  const r = readJsonlStream(streamOf('{"a":1}\nNOTJSON\n{"a":3}\n'), {
    onEvent: (e) => seen.push(e),
    onBadLine: (b) => bad.push(b),
  });
  const s = await r.done;
  assert.equal(seen.length, 2);
  assert.equal(bad.length, 1);
  assert.equal(s.badLines, 1);
  assert.equal(bad[0].line, 2);
});

test('stdin：一行是数组时拆开逐条发', async () => {
  const seen = [];
  const r = readJsonlStream(streamOf('[{"a":1},{"a":2}]\n'), {
    onEvent: (e) => seen.push(e),
  });
  await r.done;
  assert.equal(seen.length, 2);
});

test('stdin：一行是 {events:[...]} 时拆开（信封本身单独交给调用方）', async () => {
  const seen = [];
  const envelopes = [];
  const r = readJsonlStream(streamOf('{"meta":{"s":1},"events":[{"a":1}]}\n'), {
    onEvent: (e, m) => (m && m.envelope ? envelopes.push(e) : seen.push(e)),
  });
  await r.done;
  assert.equal(seen.length, 1);
  assert.equal(envelopes.length, 1);
});

test('collectStdin 返回坏行明细与总行数', async () => {
  const r = await collectStdin(streamOf('{"a":1}\nBAD\n'));
  assert.equal(r.events.length, 1);
  assert.equal(r.badLineCount, 1);
  assert.equal(r.linesSeen, 2);
});

test('collectStdin --max 截断时如实标记 truncated', async () => {
  const r = await collectStdin(streamOf('{"a":1}\n{"a":2}\n{"a":3}\n'), { maxEvents: 2 });
  assert.equal(r.truncated, true);
  assert.equal(r.events.length, 2);
});

/* ================================================================== *
 * http-hook（真起服务 + 真发请求）
 * ================================================================== */

test('HTTP：只绑 127.0.0.1（安全红线）', async () => {
  const hook = await startHttpHook({ port: 0 });
  try {
    assert.equal(hook.host, LISTEN_HOST);
    assert.equal(hook.host, '127.0.0.1');
    assert.match(hook.url, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.ok(hook.port > 0);
  } finally {
    await hook.close();
  }
});

test('HTTP：POST /event 收下事件，GET /events 用 SSE 收到它，然后关闭', async () => {
  const hook = await startHttpHook({ port: 0 });
  const received = [];
  let abort;
  try {
    /* 先连上 SSE，再 POST —— 顺序反了只能靠 replay 补发，这里要测实时推送 */
    const ctrl = new AbortController();
    abort = ctrl;
    const sseDone = consumeSse(hook.url, {
      signal: ctrl.signal,
      stopWhen: (n) => n >= 1,
      onEvent: (e) => received.push(e),
    });

    /* 等 SSE 真正连上（否则 POST 可能抢在前面，测的就不是实时推送了） */
    await waitFor(() => hook.clientCount() > 0, 2000);

    const res = await fetch(`${hook.url}/event`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'tool', tool: 'read_file', id: 'c1', ts: 100 }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.accepted, true);

    const sent = await sseDone;
    assert.equal(sent.received, 1, 'SSE 必须收到刚 POST 的那条');
    assert.equal(received.length, 1);
    assert.equal(received[0].kind, 'tool');
    assert.equal(received[0].tool, 'read_file');
    assert.equal(received[0].id, 'c1');
  } finally {
    abort?.abort();
    await hook.close();
  }
});

test('HTTP：坏 JSON 回 400 并给可读原因（不许静默 200）', async () => {
  const hook = await startHttpHook({ port: 0 });
  try {
    const res = await fetch(`${hook.url}/event`, {
      method: 'POST',
      body: '{not json',
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.match(body.error, /JSON/);
    assert.equal(hook.stats().badRecords, 1);
  } finally {
    await hook.close();
  }
});

test('HTTP：缺字段回 400 并列出缺什么', async () => {
  const hook = await startHttpHook({ port: 0 });
  try {
    const res = await fetch(`${hook.url}/event`, {
      method: 'POST',
      body: JSON.stringify({ kind: 'tool_end', ts: 1 }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.ok(
      body.issues.some((i) => i.includes('missing-tool')),
      `issues 里应指出缺 tool，实际：${JSON.stringify(body.issues)}`,
    );
  } finally {
    await hook.close();
  }
});

test('HTTP：未知 kind 照收（200），但明说不认识并计数', async () => {
  const hook = await startHttpHook({ port: 0 });
  try {
    const res = await fetch(`${hook.url}/event`, {
      method: 'POST',
      body: JSON.stringify({ kind: 'tool_use', tool: 'Read', ts: 1 }),
    });
    assert.equal(res.status, 200, '未知 kind 不是错误，只是不认识');
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.unknownKind, 'tool_use', '必须在响应里如实告知');

    const stats = hook.stats();
    assert.equal(stats.unknown, 1);
    assert.equal(stats.unknownKinds.tool_use, 1);
  } finally {
    await hook.close();
  }
});

test('HTTP：POST 一批事件', async () => {
  const hook = await startHttpHook({ port: 0 });
  try {
    const res = await fetch(`${hook.url}/event`, {
      method: 'POST',
      body: JSON.stringify({
        events: [
          { kind: 'tool', tool: 'a', id: '1', ts: 0 },
          { kind: 'tool_end', tool: 'a', id: '1', ts: 1, ok: true },
        ],
      }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.accepted, 2);
    assert.equal(hook.recent().length, 2);
  } finally {
    await hook.close();
  }
});

test('HTTP：批里有一条坏的，如实报 207 并说明拒收了几条', async () => {
  const hook = await startHttpHook({ port: 0 });
  try {
    const res = await fetch(`${hook.url}/event`, {
      method: 'POST',
      body: JSON.stringify([
        { kind: 'tool', tool: 'a', id: '1', ts: 0 },
        { kind: 'tool_end', ts: 1 },
      ]),
    });
    assert.equal(res.status, 207);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.equal(body.accepted, 1);
    assert.equal(body.rejected, 1);
  } finally {
    await hook.close();
  }
});

test('HTTP：GET /stats 给出计数', async () => {
  const hook = await startHttpHook({ port: 0 });
  try {
    await hook.push({ kind: 'tool', tool: 'a', id: '1', ts: 0 });
    const res = await fetch(`${hook.url}/stats`);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.host, '127.0.0.1');
    assert.equal(body.stats.accepted, 1);
  } finally {
    await hook.close();
  }
});

test('HTTP：未知路径回 404 并列出可用路由', async () => {
  const hook = await startHttpHook({ port: 0 });
  try {
    const res = await fetch(`${hook.url}/nope`);
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.ok(Array.isArray(body.routes));
  } finally {
    await hook.close();
  }
});

test('HTTP：晚订阅者能拿到 replay 缓冲', async () => {
  const hook = await startHttpHook({ port: 0 });
  const got = [];
  const ctrl = new AbortController();
  try {
    await hook.push({ kind: 'tool', tool: 'early', id: 'e1', ts: 0 });
    const done = consumeSse(hook.url, {
      signal: ctrl.signal,
      stopWhen: (n) => n >= 1,
      onEvent: (e) => got.push(e),
    });
    const r = await done;
    assert.equal(r.received, 1);
    assert.equal(got[0].tool, 'early', '后连上的订阅者必须能补到历史事件');
  } finally {
    ctrl.abort();
    await hook.close();
  }
});

test('normalizeSseUrl 把裸 host 补成 /events', () => {
  assert.equal(normalizeSseUrl('http://127.0.0.1:8787'), 'http://127.0.0.1:8787/events');
  assert.equal(normalizeSseUrl('http://127.0.0.1:8787/'), 'http://127.0.0.1:8787/events');
  assert.equal(
    normalizeSseUrl('http://127.0.0.1:8787/custom'),
    'http://127.0.0.1:8787/custom',
  );
});

test('consumeSse 连不上时如实报错，不崩', async () => {
  const issues = [];
  const r = await consumeSse('http://127.0.0.1:1/events', {
    onIssue: (i) => issues.push(i),
  });
  assert.equal(r.received, 0);
  assert.equal(r.aborted, true);
  assert.ok(issues.length > 0);
});

/* ================================================================== *
 * generic 映射层
 * ================================================================== */

test('pickPath 支持嵌套与数组下标，取不到就 found:false', () => {
  const rec = { a: { b: [{ c: 1 }] }, top: 'x' };
  assert.deepEqual(pickPath(rec, ['a.b[0].c']), { found: true, value: 1, via: 'a.b[0].c' });
  assert.deepEqual(pickPath(rec, ['missing', 'top']), { found: true, value: 'x', via: 'top' });
  assert.equal(pickPath(rec, ['nope.deep']).found, false);
});

test('matchRule 支持数组候选、多键 AND、true/false 语义', () => {
  assert.equal(matchRule({ type: 'tool_use' }, { type: ['tool_use', 'tool_call'] }), true);
  assert.equal(matchRule({ type: 'other' }, { type: ['tool_use'] }), false);
  assert.equal(matchRule({ a: 1, b: 2 }, { a: [1], b: [2] }), true);
  assert.equal(matchRule({ a: 1, b: 9 }, { a: [1], b: [2] }), false);
  /* 字段不存在 != 假 */
  assert.equal(matchRule({}, { x: [false] }), false);
  assert.equal(matchRule({ x: false }, { x: [false] }), true);
});

test('toMs 认数字/ISO 字符串/proto 形状，认不出来返回 null', () => {
  assert.equal(toMs(1234), 1234);
  assert.equal(toMs('2020-01-01T00:00:00.000Z'), 1577836800000);
  assert.equal(toMs('500'), 500);
  assert.equal(toMs({ seconds: 2, nanoseconds: 500000000 }), 2500);
  assert.equal(toMs('not a date'), null);
  assert.equal(toMs(null), null);
});

test('compileProfile 拒绝没有 start/end 的配置（不猜）', () => {
  assert.throws(() => compileProfile({ profile: 'x', start: { type: ['a'] } }), /end/);
  assert.throws(() => compileProfile(null), /对象/);
});

test('generic：Claude Code 形状能映射成协议事件', () => {
  const mapper = compileProfile({
    profile: 'cc',
    start: { type: ['tool_use'] },
    end: { type: ['tool_result'] },
    id: ['id', 'tool_use_id'],
    tool: ['name'],
    ts: ['timestamp'],
    ok: { path: ['is_error'], trueMeansFail: true },
  });

  const start = mapper.mapRecord({
    type: 'tool_use',
    id: 'toolu_1',
    name: 'Read',
    timestamp: '2024-01-01T00:00:00Z',
  });
  assert.equal(start.mapped, true);
  assert.deepEqual(start.event, {
    kind: 'tool',
    tool: 'Read',
    id: 'toolu_1',
    ts: 1704067200000,
  });

  const end = mapper.mapRecord({
    type: 'tool_result',
    tool_use_id: 'toolu_1',
    timestamp: '2024-01-01T00:00:01Z',
    is_error: false,
  });
  assert.equal(end.mapped, true);
  assert.equal(end.event.kind, 'tool_end');
  assert.equal(end.event.ok, true, 'is_error:false 应映射成 ok:true');
});

test('generic：is_error:true 映射成 ok:false', () => {
  const mapper = compileProfile({
    profile: 'cc',
    start: { type: ['tool_use'] },
    end: { type: ['tool_result'] },
    tool: ['name'],
    ts: ['timestamp'],
    id: ['id', 'tool_use_id'],
    ok: { path: ['is_error'], trueMeansFail: true },
  });
  const r = mapper.mapRecord({
    type: 'tool_result',
    tool_use_id: 'x',
    tool: 'Read',
    is_error: true,
    timestamp: 1,
  });
  assert.equal(r.event.ok, false);
});

test('generic：找不到工具调用时停下并如实报告原因', () => {
  const mapper = compileProfile({
    profile: 'cc',
    start: { type: ['tool_use'] },
    end: { type: ['tool_result'] },
  });
  const r = mapper.mapRecord({ type: 'assistant_message', text: 'hello' });
  assert.equal(r.mapped, false);
  assert.equal(r.code, SKIP_CODE.NO_RULE);
  assert.match(r.reason, /没有任何/);
});

test('generic：匹配上了但取不到工具名 → missing-tool，绝不伪造 unknown', () => {
  const mapper = compileProfile({
    profile: 'cc',
    start: { type: ['tool_use'] },
    end: { type: ['tool_result'] },
    tool: ['name'],
    ts: ['timestamp'],
  });
  const r = mapper.mapRecord({ type: 'tool_use', timestamp: 1 });
  assert.equal(r.mapped, false);
  assert.equal(r.code, SKIP_CODE.MISSING_TOOL);
  /* 最关键：没有被造出一个事件 */
  assert.equal(r.event, undefined);
});

test('generic：取不到时间且没有实时时钟 → missing-ts（不许编 Date.now()）', () => {
  const mapper = compileProfile({
    profile: 'cc',
    start: { type: ['tool_use'] },
    end: { type: ['tool_result'] },
    tool: ['name'],
    ts: ['timestamp'],
  });
  const r = mapper.mapRecord({ type: 'tool_use', name: 'Read' });
  assert.equal(r.mapped, false);
  assert.equal(r.code, SKIP_CODE.MISSING_TS);
});

test('generic：实时流允许用接收时刻补 ts，但明确标 tsSource', () => {
  const mapper = compileProfile({
    profile: 'cc',
    start: { type: ['tool_use'] },
    end: { type: ['tool_result'] },
    tool: ['name'],
    ts: ['timestamp'],
  });
  const r = mapper.mapRecord({ type: 'tool_use', name: 'Read' }, { now: () => 999 });
  assert.equal(r.mapped, true);
  assert.equal(r.event.ts, 999);
  assert.equal(r.event.tsSource, 'ingest');
});

test('generic：不是对象 / 是数组 → not-object', () => {
  const mapper = compileProfile({
    profile: 'cc',
    start: { type: ['a'] },
    end: { type: ['b'] },
  });
  assert.equal(mapper.mapRecord('str').code, SKIP_CODE.NOT_OBJECT);
  assert.equal(mapper.mapRecord([1]).code, SKIP_CODE.NOT_OBJECT);
});

test('generic：envelope 记录被归为 ignored，不算映射失败', () => {
  const mapper = compileProfile({
    profile: 'cc',
    envelope: { type: ['summary'] },
    start: { type: ['tool_use'] },
    end: { type: ['tool_result'] },
  });
  const r = mapper.mapRecord({ type: 'summary', text: 'x' });
  assert.equal(r.mapped, false);
  assert.equal(r.code, SKIP_CODE.IGNORED_TYPE);
});

test('generic：映射统计把失败原因分类计数（诚实报告）', () => {
  const mapper = compileProfile({
    profile: 'cc',
    start: { type: ['tool_use'] },
    end: { type: ['tool_result'] },
    tool: ['name'],
    ts: ['timestamp'],
  });
  const stats = createMapStats();
  const records = [
    { type: 'tool_use', name: 'Read', timestamp: 1 },
    { type: 'assistant_message' },
    { type: 'tool_use', timestamp: 2 },
    { type: 'tool_use', name: 'Bash' },
  ];
  for (const rec of records) stats.count(rec, mapper.mapRecord(rec));
  const s = stats.snapshot();
  assert.equal(s.total, 4);
  assert.equal(s.mapped, 1);
  assert.equal(s.unmapped, 3);
  assert.equal(s.byCode[SKIP_CODE.NO_RULE], 1);
  assert.equal(s.byCode[SKIP_CODE.MISSING_TOOL], 1);
  assert.equal(s.byCode[SKIP_CODE.MISSING_TS], 1);
  assert.equal(s.mapRate, 0.25);
  assert.equal(s.examples.length, 3);
});

test('generic：extra 只透传配置点名的字段（不把整条记录摊进事件）', () => {
  const mapper = compileProfile({
    profile: 'cc',
    start: { type: ['tool_use'] },
    end: { type: ['tool_result'] },
    tool: ['name'],
    ts: ['timestamp'],
    extra: { sessionId: ['session_id'] },
  });
  const r = mapper.mapRecord({
    type: 'tool_use',
    name: 'Read',
    timestamp: 1,
    session_id: 's1',
    secret_token: 'leak-me',
  });
  assert.equal(r.event.sessionId, 's1');
  assert.equal(r.event.secret_token, undefined, '没点名的字段不能被带进事件流');
});

test('内置 profile 都能加载并编译', () => {
  for (const name of Object.keys(BUILTIN_PROFILES)) {
    const m = loadProfile(name, profileIO);
    assert.equal(m.profile, name);
    assert.equal(typeof m.mapRecord, 'function');
  }
});

test('Cursor 风格 profile 端到端：start/end 各映射一条并配对得上', () => {
  const m = loadProfile('cursor', profileIO);
  const a = m.mapRecord({ event: 'start', tool: 'run_terminal_cmd', callId: 'k1', ts: 10 });
  const b = m.mapRecord({
    event: 'end',
    tool: 'run_terminal_cmd',
    callId: 'k1',
    ts: 20,
    success: true,
  });
  assert.equal(a.mapped, true);
  assert.equal(a.event.kind, 'tool');
  assert.equal(b.mapped, true);
  assert.equal(b.event.kind, 'tool_end');
  assert.equal(b.event.ok, true);
  assert.equal(a.event.id, b.event.id, '同一 callId 必须配对得上');
});

test('Codex 风格 profile 端到端：item 信封里的工具名能取到', () => {
  const m = loadProfile('codex', profileIO);
  const a = m.mapRecord({
    type: 'item.started',
    item: { id: 'i1', type: 'command_execution', name: 'bash' },
    timestamp: 5,
  });
  assert.equal(a.mapped, true);
  assert.equal(a.event.tool, 'bash');
  assert.equal(a.event.kind, 'tool');
});
