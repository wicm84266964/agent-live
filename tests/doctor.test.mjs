/**
 * tests/doctor.test.mjs —— doctor 的退出码与输出契约
 *
 * doctor 的价值全在"能不能作为闸门"：
 *   exit 0 = 数据可用；exit 1 = 数据有问题；exit 2 = 用法错/源打不开。
 * 如果这个判定是软的，它就只是一个打印脚本。
 *
 * 这里用真子进程跑 doctor（它是 CLI，import 就会执行），
 * 覆盖三条输入路径与坏输入的 exit code。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { promisify } from 'node:util';

import { startHttpHook } from '../adapters/http-hook.mjs';
import { pairReport } from '../protocol/events.mjs';

const exec = promisify(execFile);
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DOCTOR = join(ROOT, 'tools', 'doctor.mjs');
const REAL_EVENTS = join(ROOT, 'real-events.json');

/**
 * 跑 doctor。**不用 Promise.all 也不要 reject**：
 * 非 0 退出是正常返回值，不是异常。
 * @returns {Promise<{ code:number, stdout:string, stderr:string }>}
 */
function runDoctor(args, opts = {}) {
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      [DOCTOR, ...args],
      { cwd: ROOT, maxBuffer: 8 * 1024 * 1024, ...opts },
      (err, stdout, stderr) => {
        resolve({ code: err ? (err.code ?? 1) : 0, stdout, stderr });
      },
    );
    if (opts.stdinText != null) {
      child.stdin.end(opts.stdinText);
    }
  });
}

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'doctor-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/* ------------------------------------------------------------------ *
 * 正常路径：exit 0
 * ------------------------------------------------------------------ */

test('doctor --file real-events.json 必须 exit 0 并打印真实统计', async () => {
  const r = await runDoctor(['--file', REAL_EVENTS]);
  assert.equal(r.code, 0, `期望 exit 0，实际 ${r.code}\n${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /事件总数\s+585/);
  assert.match(r.stdout, /tool 292 \/ tool_end 292 \/ turn_end 1/);
  assert.match(r.stdout, /未知 kind\s+0/);
  assert.match(r.stdout, /id 配对\s+292\/292（100\.0%）\s+完美/);
  assert.match(r.stdout, /重复上报\s+0/);
  assert.match(r.stdout, /结论\s+通过/);
});

test('doctor --json 输出可被解析，且数字与文本模式一致', async () => {
  const r = await runDoctor(['--file', REAL_EVENTS, '--json']);
  assert.equal(r.code, 0);
  const j = JSON.parse(r.stdout);
  assert.equal(j.ok, true);
  assert.equal(j.totals.events, 585);
  assert.equal(j.totals.unknown, 0);
  assert.equal(j.pairing.calls, 292);
  assert.equal(j.pairing.results, 292);
  assert.equal(j.pairing.pairingRate, 1);
  assert.equal(j.pairing.perfect, true);
  assert.equal(j.duplicates.count, 0);
  assert.equal(j.problems.length, 0);
  /* 耗时合计必须等于 ETL 写进 meta 的值（不能把 start/end 算两遍） */
  assert.equal(j.timeline.durationSumMs, 130079);
});

/* ------------------------------------------------------------------ *
 * stdin 路径
 * ------------------------------------------------------------------ */

test('doctor --stdin 能读管道输入，且计数与 --file 一致', async () => {
  const { readFile } = await import('node:fs/promises');
  const doc = JSON.parse(await readFile(REAL_EVENTS, 'utf8'));
  const text = `${doc.events.map((e) => JSON.stringify(e)).join('\n')}\n`;

  const r = await runDoctor(['--stdin'], { stdinText: text });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /事件总数\s+585/);
  assert.match(r.stdout, /id 配对\s+292\/292/);
});

test('doctor --stdin 对坏行计数并 exit 1', async () => {
  const r = await runDoctor(['--stdin'], {
    stdinText:
      '{"kind":"tool","tool":"read","id":"a","ts":0}\n'
      + '{"kind":"tool_end","tool":"read","id":"a","ts":1,"ok":true}\n'
      + 'NOT JSON AT ALL\n',
  });
  assert.equal(r.code, 1, '有坏行必须 exit 1');
  assert.match(r.stdout, /坏记录\s+1/);
});

/* ------------------------------------------------------------------ *
 * 坏输入：exit 1
 * ------------------------------------------------------------------ */

test('未知 kind 让 doctor exit 1，并打出具体名字', async () => {
  await withTempDir(async (dir) => {
    const f = join(dir, 'unknown.jsonl');
    await writeFile(
      f,
      '{"kind":"tool","tool":"read","id":"a","ts":0}\n'
        + '{"kind":"tool_end","tool":"read","id":"a","ts":1,"ok":true}\n'
        + '{"kind":"tool_use","tool":"Read","ts":2}\n',
      'utf8',
    );
    const r = await runDoctor(['--file', f]);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /未知 kind\s+1/);
    assert.match(r.stdout, /tool_use/);
  });
});

test('孤儿结束让 doctor exit 1（不许把 0/N 判成通过）', async () => {
  await withTempDir(async (dir) => {
    const f = join(dir, 'orphan.jsonl');
    await writeFile(f, '{"kind":"tool_end","tool":"read","id":"ghost","ts":5,"ok":true}\n', 'utf8');
    const r = await runDoctor(['--file', f]);
    assert.equal(r.code, 1, '只有结束、没有开始的数据源必须判失败');
    assert.match(r.stdout, /孤儿结束\s+1/);
    assert.match(r.stdout, /配对率\s+0\.0%/);
  });
});

test('孤儿开始让 doctor exit 1', async () => {
  await withTempDir(async (dir) => {
    const f = join(dir, 'noonend.jsonl');
    await writeFile(f, '{"kind":"tool","tool":"agent_run","id":"long","ts":0}\n', 'utf8');
    const r = await runDoctor(['--file', f]);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /孤儿开始\s+1/);
  });
});

test('重复上报让 doctor exit 1', async () => {
  await withTempDir(async (dir) => {
    const f = join(dir, 'dup.jsonl');
    await writeFile(
      f,
      '{"kind":"tool","tool":"read","id":"a","ts":0}\n'
        + '{"kind":"tool_end","tool":"read","id":"a","ts":1,"ok":true}\n'
        + '{"kind":"tool_end","tool":"read","id":"a","ts":2,"ok":true}\n',
      'utf8',
    );
    const r = await runDoctor(['--file', f]);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /重复/);
  });
});

test('空事件流 exit 1（不算"通过"）', async () => {
  await withTempDir(async (dir) => {
    const f = join(dir, 'empty.jsonl');
    await writeFile(f, '\n\n\n', 'utf8');
    const r = await runDoctor(['--file', f]);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /没有解析出任何合法事件/);
  });
});

test('缺字段事件让 doctor exit 1', async () => {
  await withTempDir(async (dir) => {
    const f = join(dir, 'missing.jsonl');
    await writeFile(f, '{"kind":"tool_end","ts":1}\n', 'utf8');
    const r = await runDoctor(['--file', f]);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /校验不通过\s+1/);
  });
});

/* ------------------------------------------------------------------ *
 * 用法错误 / 源打不开：exit 2
 * ------------------------------------------------------------------ */

test('不给任何输入参数 → exit 2（用法错误，不是"通过"）', async () => {
  const r = await runDoctor([]);
  assert.equal(r.code, 2);
  assert.match(r.stdout + r.stderr, /用法/);
});

test('--help → exit 0', async () => {
  const r = await runDoctor(['--help']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /--file/);
});

test('文件不存在 → exit 2，且明确说是打不开（不假装空事件流）', async () => {
  const r = await runDoctor(['--file', join(tmpdir(), `nope-${Date.now()}.jsonl`)]);
  assert.equal(r.code, 2);
  assert.match(r.stderr + r.stdout, /打不开文件/);
});

test('不认识的参数 → exit 2', async () => {
  const r = await runDoctor(['--bogus']);
  assert.equal(r.code, 2);
});

test('--strict 把 warn 也当失败（缺 id 之类）', async () => {
  await withTempDir(async (dir) => {
    const f = join(dir, 'noid.jsonl');
    /* 完整配对，但没有 id（只能 FIFO）+ 缺 tool_end 的 tool —— 触发 warn */
    await writeFile(
      f,
      '{"kind":"tool","tool":"bash","ts":0}\n{"kind":"tool_end","tool":"bash","ts":5,"ok":true}\n',
      'utf8',
    );
    const loose = await runDoctor(['--file', f]);
    assert.equal(loose.code, 0, '默认容忍无 id（FIFO 能配）');
    assert.match(loose.stdout, /warn/);

    const strict = await runDoctor(['--file', f, '--strict']);
    assert.equal(strict.code, 1, '--strict 下 warn 必须让 doctor 失败');
  });
});

/* ------------------------------------------------------------------ *
 * 映射层接入 doctor
 * ------------------------------------------------------------------ */

test('doctor --profile 先映射再检查（Cursor 风格日志）', async () => {
  await withTempDir(async (dir) => {
    const f = join(dir, 'cursor.jsonl');
    await writeFile(
      f,
      '{"event":"start","tool":"run_terminal_cmd","callId":"k1","ts":10}\n'
        + '{"event":"end","tool":"run_terminal_cmd","callId":"k1","ts":20,"success":true}\n',
      'utf8',
    );
    const r = await runDoctor(['--file', f, '--profile', 'cursor']);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /映射配置\s+cursor/);
    assert.match(r.stdout, /映射结果\s+成功 2\/2/);
    assert.match(r.stdout, /id 配对\s+1\/1/);
  });
});

test('doctor --profile 一条都匹配不上 → exit 1 并说明（不当作成功）', async () => {
  await withTempDir(async (dir) => {
    const f = join(dir, 'nomatch.jsonl');
    await writeFile(f, '{"totally":"different","shape":true}\n', 'utf8');
    const r = await runDoctor(['--file', f, '--profile', 'cursor']);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /一条都没匹配上/);
  });
});

/* ------------------------------------------------------------------ *
 * --http 路径（真起服务）
 * ------------------------------------------------------------------ */

test('doctor --http 能连上 http-hook 的 SSE 并判定', async () => {
  const hook = await startHttpHook({ port: 0, replay: 50 });
  try {
    /* 先灌两条完整、成对的事件 */
    await hook.push({ kind: 'tool', tool: 'read', id: 'h1', ts: 0 });
    await hook.push({ kind: 'tool_end', tool: 'read', id: 'h1', ts: 5, ok: true });

    const r = await runDoctor(['--http', `${hook.url}/events`, '--max', '2', '--json']);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    const j = JSON.parse(r.stdout);
    assert.equal(j.source.type, 'http');
    assert.equal(j.totals.events, 2);
    assert.equal(j.pairing.perfect, true);
  } finally {
    await hook.close();
  }
});

test('doctor --http 连不上 → exit 2', async () => {
  const r = await runDoctor(['--http', 'http://127.0.0.1:1/events', '--max', '1']);
  assert.equal(r.code, 2);
});

/* 保证 Readable 的导入不被 lint 判成未使用（本文件只通过子进程喂 stdin） */
void Readable;

/* ------------------------------------------------------------------ *
 * F1：文件层「整份 JSON 解析失败」的病因必须被 doctor 呈现
 *
 * 审计发现：适配器 `readFileOnce()` 在整份 JSON 解析失败时**正确**返回
 * `issues: [{code:'parse-failed', message:<原因>}]`，但 doctor 的 `--file`
 * 分支只消费 `shape / badLines / events`，把 `issues` 整个丢掉。
 * 结果屏幕上只剩"事件流是空的" —— 一个**派生症状**，
 * 读的人会去查"通道接上了没"，而真正的问题是"这份文件本身就是断的"。
 *
 * 这三条用例补的是当时 19 条用例完全没覆盖的地方（`parse-failed` 零命中）。
 * ------------------------------------------------------------------ */

/** 一份结构完整、能解析的 {meta,events}：用来做"整份被截断"的基线。 */
function wholeJsonDoc(n) {
  const events = [];
  for (let i = 0; i < n; i++) {
    events.push({ kind: 'tool', id: `i${i}`, tool: 'x', ts: i });
  }
  return { meta: { v: 1 }, events };
}

test('F1: 整份 JSON 解析失败 → 结论里是"解析失败 + 原因"，不是"事件流是空的"', async () => {
  await withTempDir(async (dir) => {
    const f = join(dir, 'bom-not-first.json');
    /*
     * BOM 不在字节 0，而是"空格 + U+FEFF"：
     * `resolveShape()` 用 trim() 判形态时 BOM 被吃掉 → 判成整文件 JSON；
     * 但 `JSON.parse` 见到 U+FEFF 直接炸 → 一份完整事件全丢。
     */
    const body = JSON.stringify(wholeJsonDoc(3));
    await writeFile(f, Buffer.from(` \uFEFF${body}`, 'utf8'));

    const r = await runDoctor(['--file', f]);
    assert.equal(r.code, 1, `解析失败必须判不通过（exit 1）\n${r.stdout}`);
    assert.match(r.stdout, /解析失败/, '结论必须说出"解析失败"这个病因');
    assert.match(r.stdout, /整份 JSON 被截断|整文件 JSON 解析失败|BOM|not valid JSON/i,
      '必须带出适配器给出的具体原因，而不是只说"没有事件"');

    /*
     * "事件流是空的"如果出现，只能排在病因**后面**。
     * 它是症状，不是病因；排在前面就会把人引向错误的方向。
     */
    const iCause = r.stdout.indexOf('解析失败');
    const iSymptom = r.stdout.indexOf('事件流是空的');
    if (iSymptom !== -1) {
      assert.ok(iCause !== -1 && iCause < iSymptom,
        `病因必须排在症状之前（cause@${iCause} symptom@${iSymptom}）\n${r.stdout}`);
    }
  });
});

test('F1: 整份 JSON 解析失败 → --json 的 problems 与 fileIssues 都带病因', async () => {
  await withTempDir(async (dir) => {
    const f = join(dir, 'bom-not-first.json');
    await writeFile(f, Buffer.from(` \uFEFF${JSON.stringify(wholeJsonDoc(3))}`, 'utf8'));

    const r = await runDoctor(['--file', f, '--json']);
    assert.equal(r.code, 1);
    const j = JSON.parse(r.stdout);
    assert.ok(j.problems.length > 0, 'problems 不能为空');
    assert.match(j.problems[0], /解析失败/, '病因必须排在 problems 第一位');
    assert.ok(Array.isArray(j.fileIssues) && j.fileIssues.length > 0,
      '文件层 issue 必须出现在报告里（此前完全丢失）');
    assert.match(j.fileIssues[0], /^parse-failed:/);
    /* inbox 的 issue 仍是空 —— 这两者同名不同源，不能混为一谈。 */
    assert.deepEqual(j.issues, [], 'inbox issue 与文件层 issue 是两回事，不得互相冒充');
  });
});

test('F1: 截断的整份 JSON → 不判成 jsonl、不刷一屏碎片坏行、并指出疑似截断', async () => {
  await withTempDir(async (dir) => {
    const f = join(dir, 'truncated.json');
    /* 缩进 2 空格 → 截断后每一行都不再是完整 JSON，能产出大量碎片坏行。 */
    const full = JSON.stringify(wholeJsonDoc(60), null, 2);
    await writeFile(f, full.slice(0, Math.floor(full.length * 0.55)), 'utf8');

    const r = await runDoctor(['--file', f]);
    assert.equal(r.code, 1, '截断文件必须判不通过');

    /* 形态不能退化成 jsonl —— 那是"把它当成逐行日志"的错误结论。 */
    assert.doesNotMatch(r.stdout, /文件形态\s+jsonl/,
      `整份被截断的 JSON 不该判成 jsonl\n${r.stdout}`);

    /*
     * 关键：几十条碎片坏行会把真病因挤出屏幕。
     * 这里允许至多 1 条坏行记录（折叠成一条），绝不允许十几条。
     */
    const fragments = (r.stdout.match(/不是合法 JSON/g) || []).length;
    assert.ok(fragments <= 1,
      `疑似整份截断时不得逐条刷碎片坏行（实际 ${fragments} 条）\n${r.stdout}`);
    assert.match(r.stdout, /坏记录\s+(0|1)\b/, '碎片不该被算成一堆独立坏记录');

    /* 真病因必须说出来，并且明确"疑似整份被截断"。 */
    assert.match(r.stdout, /解析失败/);
    assert.match(r.stdout, /疑似整份 JSON 被截断/);
    assert.match(r.stdout, /结论\s+不通过/);
  });
});

test('F1 回归：逐行 JSONL 里个别坏行的报错行为保持不变', async () => {
  await withTempDir(async (dir) => {
    const f = join(dir, 'one-bad.jsonl');
    await writeFile(
      f,
      '{"kind":"tool","id":"a","tool":"x","ts":1}\n'
        + 'not json\n'
        + '{"kind":"tool_end","id":"a","tool":"x","ts":2,"ok":true}\n',
      'utf8',
    );

    const r = await runDoctor(['--file', f]);
    assert.equal(r.code, 1, '有坏行就该判不通过');

    /* 合法行照常进入统计 —— 别因为要修"整份失败"就把逐行口径改坏。 */
    assert.match(r.stdout, /文件形态\s+jsonl/, '正常 JSONL 仍必须是 jsonl');
    assert.match(r.stdout, /事件总数\s+2/);
    assert.match(r.stdout, /坏记录\s+1/, '坏行仍要如实计一条');
    assert.match(r.stdout, /第 2 行不是合法 JSON/, '仍要指出坏行行号');
    assert.match(r.stdout, /id 配对\s+1\/1/, '好行照常配对');
    assert.match(r.stdout, /结论\s+不通过/);
    /* 这条输入不是整份截断，不该被误标成它。 */
    assert.doesNotMatch(r.stdout, /疑似整份 JSON 被截断/);

    /*
     * 同一条坏行只许报一次。
     * 它同时走 inbox.bad() 和文件层 issue 时会被打印两遍，
     * 看起来像"有两处不同的错"，实际只有一处 —— 修 F1 时最容易踩的这个坑。
     */
    const hits = (r.stdout.match(/第 2 行不是合法 JSON/g) || []).length;
    assert.equal(hits, 1, `同一条坏行只许报一次，实际 ${hits} 次\n${r.stdout}`);
  });
});

/* ------------------------------------------------------------------ *
 * F2：配对率分母 = max(callsTotal, resultsTotal)
 *
 * 实现一直是对的（`:652-653`），错的是 `PAIRING_RULES` 上方那段注释
 * （原文写"分母 = callsTotal"）。判定依据是 `docs/PROTOCOL.md`：
 * 配对率 = paired / max(calls, results)。
 *
 * 语义由**行为断言**锁；注释本身游离无锁，另加一条只锁字符串的轻量断言，
 * 并且不假装它比实际更强。
 * ------------------------------------------------------------------ */

test('F2 行为：0 次开始 / 1 次结束 → 配对率 0（不是 100%）', () => {
  const r = pairReport([{ kind: 'tool_end', id: 'a', tool: 'x', ts: 1 }]);
  assert.equal(r.callsTotal, 0);
  assert.equal(r.resultsTotal, 1);
  /*
   * 若分母真是 callsTotal，这里是 0/0 = 100%（或 NaN）——
   * "最烂的输入拿到最完美的分数"，正是这条断言要挡住的。
   */
  assert.equal(r.pairingRate, 0);
  assert.equal(r.perfect, false);
});

test('F2 行为：2 次开始 / 1 次结束 → 配对率 0.5', () => {
  const r = pairReport([
    { kind: 'tool', id: 'a', tool: 'x', ts: 1 },
    { kind: 'tool', id: 'b', tool: 'x', ts: 2 },
    { kind: 'tool_end', id: 'a', tool: 'x', ts: 3, ok: true },
  ]);
  assert.equal(r.callsTotal, 2);
  assert.equal(r.resultsTotal, 1);
  assert.equal(r.paired, 1);
  /* max(2,1) = 2 → 1/2。只看 calls 也是 2，这条锁的是"多余开始会压低配对率"。 */
  assert.equal(r.pairingRate, 0.5);
});

test('F2 注释：分母写成 max(callsTotal, resultsTotal)（只锁字符串，不锁语义）', async () => {
  /*
   * 这条断言**只保证注释里有这个字样**，防止注释再次飘回"分母 = callsTotal"。
   * 它不证明实现是对的：注释与代码可以同时改错。
   * 真正的语义由上面两条行为断言锁。
   *
   * 必须只截取 **PAIRING_RULES 上方那段文档注释** 来匹配：
   * 直接全文 search 会命中实现里的 `Math.max(callsTotal, resultsTotal)`，
   * 那样这条断言就变成恒真的假锁 —— 注释随手改回错的也照样绿。
   */
  const src = await readFile(join(ROOT, 'protocol', 'events.mjs'), 'utf8');
  const anchor = src.indexOf('export const PAIRING_RULES');
  assert.ok(anchor > 0, '找不到 PAIRING_RULES，注释锁失效');
  const blockStart = src.lastIndexOf('/**', anchor);
  assert.ok(blockStart >= 0 && blockStart < anchor, 'PAIRING_RULES 上方应有文档注释块');
  const commentOnly = src.slice(blockStart, anchor);

  assert.match(commentOnly, /max\(callsTotal,\s*resultsTotal\)/,
    '配对率分母注释必须写明 max(callsTotal, resultsTotal)（实现就是这么算的）');
  /* 反向断言：旧的错误口径不许回到注释里。 */
  assert.doesNotMatch(commentOnly, /分母\s*=\s*callsTotal（含匿名）/,
    '注释不得再声称分母就是 callsTotal');
});
