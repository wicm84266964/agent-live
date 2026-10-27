/**
 * 从 DSH 真实会话日志生成战场事件。
 *
 * ===== 为什么必须有这个文件 =====
 *
 * 上一版的 `DEMO_EVENTS` 是**手写常量数组** —— 29 条假事件，
 * 时间是编的、时长是编的、工具名是挑的。
 * 页面看起来在演"智能体在干活"，其实演的是我写死的剧本。
 *
 * 所以改成：直接从真实会话分析产物读事件，
 * 每条 `tool/call` → 一个敌人出场，
 * 每条 `tool/result` → 一次击杀。
 *
 * ===== 并发：不能串行化 =====
 *
 * 最初的版本是**排队**的：一只出场 → 等它耗时结束 → 下一只才出场。
 * 那是错的。
 *
 * 真实数据实测：
 *   - 最大**同时**在跑 4 个调用
 *   - 有 41 对调用在时间上重叠
 *
 * 而且这不是数据毛刺，是本质：智能体放出子智能体（`agent_run`）之后
 * **会继续做别的事**，两个工具同时在跑。把它串行化会得到两个后果：
 *   1. 一个 42 秒的 `ask_user_question` 会把整条队列堵住，
 *      后面的调用明明早就结束了，画面里还没出场
 *   2. 画面上永远只有一只蚂蚁在挨刀，看不出"并发"这件事
 *
 * 所以现在的做法是：**每个工具在自己的开始时刻出场，
 * 在自己的结束时刻被击杀，互不等待。**
 * 谁先结束谁先死，不需要排队。
 *
 * ===== 时间轴怎么映射 =====
 *
 * 真实跨度 77.4 小时，其中 89.4% 是空白（人在离开）。
 * 直接按真实时间放，观众要等一天。
 *
 * 所以做一个**单调的时间映射** M(真实时间) → 播放时间：
 *   - 把全部开始/结束时刻排序
 *   - 相邻两个时刻的距离 d，映射成 min(d, GAP_CAP)
 *   - 累加得到播放时间
 *
 * M 是单调不减的，所以：
 *   - 事件顺序完全保留
 *   - **重叠关系也保留**（A 和 B 同时，映射后还同时）
 *
 * 折叠掉的总量写进 meta，不隐藏。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/*
 * 数据源路径。
 *
 * ===== 为什么改成可配置 =====
 *
 * 这一版之前写死 `../dsh/data.json` —— 那是开发时同目录下的一个
 * 分析产物。作为独立项目，它不该依赖外部目录结构。
 *
 * 现在支持两种用法：
 *   1. 不传参数：读仓库自带的 `sample/session-analysis.json`
 *      （一份真实的 DSH 会话分析产物，用于演示和验证）
 *   2. 传路径：`node build-events.mjs path/to/analysis.json`
 *      用于接入自己的会话
 *
 * 输入格式见 README 的「接入你自己的智能体」一节。
 */
/*
 * 用 fileURLToPath 而不是 URL.pathname ——
 * Windows 下 pathname 是 '/E:/tmp/...'（带前导斜杠），
 * 直接给 readFileSync 会拼成 'E:\E:/tmp/...' 然后 ENOENT。
 */
const DEFAULT_DATA = fileURLToPath(new URL('./sample/session-analysis.json', import.meta.url));
const DATA = process.argv[2] || DEFAULT_DATA;

/** 相邻时刻的最大间隔。超过就压到这个值（真实值仍记在 meta 里）。 */
const GAP_CAP_MS = 1000;

function main() {
  const raw = readFileSync(DATA, 'utf8');
  const d = JSON.parse(raw);

  /* 按 startTime 排序收集全部工具调用 */
  const tools = [];
  for (const t of d.turns) {
    for (const s of t.steps) {
      for (const x of s.tools || []) tools.push(x);
    }
  }
  tools.sort((a, b) => a.startTime - b.startTime);

  /* ---------- 1. 建单调时间映射 ---------- */
  const marks = [];
  for (const x of tools) {
    marks.push(x.startTime);
    marks.push(x.endTime);
  }
  marks.sort((a, b) => a - b);
  /* 去重：同一毫秒的多个时刻只算一次，否则会重复累加 */
  const uniq = [];
  for (const m of marks) {
    if (!uniq.length || m !== uniq[uniq.length - 1]) uniq.push(m);
  }

  const map = new Map();
  let playT = 0;
  let foldedMs = 0;
  for (let i = 0; i < uniq.length; i++) {
    if (i > 0) {
      const realGap = uniq[i] - uniq[i - 1];
      const used = Math.min(realGap, GAP_CAP_MS);
      foldedMs += realGap - used;
      playT += used;
    }
    map.set(uniq[i], playT);
  }

  /*
   * 检查映射真的单调。
   * 如果这里出问题，事件会乱序、并发会反转，而且不会有任何报错 ——
   * 只会在画面上表现为"蚂蚁莫名倒退"。
   */
  let nonMono = 0;
  let prev = -Infinity;
  for (const m of uniq) {
    const v = map.get(m);
    if (v < prev) nonMono++;
    prev = v;
  }
  if (nonMono) {
    console.error(`时间映射非单调：${nonMono} 处倒退`);
    process.exit(1);
  }

  /* ---------- 2. 生成事件 ---------- */
  const events = [];
  for (const x of tools) {
    const startPlay = map.get(x.startTime);
    const endPlay = map.get(x.endTime);
    events.push({
      kind: 'tool',
      tool: x.name,
      id: x.callId,
      ts: startPlay,
      realMs: x.ms,
    });
    events.push({
      kind: 'tool_end',
      tool: x.name,
      id: x.callId,
      ok: !x.isError,
      ts: endPlay,
      realMs: x.ms,
    });
  }

  /*
   * 按 ts 排序。
   *
   * 同一时刻的相对顺序要稳定：先处理 tool，再处理 tool_end。
   * 否则"开始了又立刻结束"的 0ms 调用可能先结算再出场，
   * 那一条会掉进"补造敌人"分支，seen 就多算了一个。
   */
  events.sort((a, b) => (a.ts - b.ts) || (a.kind === 'tool' ? -1 : 1));

  const lastPlay = Math.max(...events.map((e) => e.ts));
  events.push({ kind: 'turn_end', ok: true, ts: lastPlay + 400 });

  /* ---------- 3. 统计 ---------- */
  const meta = {
    source: process.argv[2] || 'sample/session-analysis.json',
    sessionId: d.sessionId,
    turns: d.turns.length,
    tools: tools.length,
    realDurSumMs: tools.reduce((a, x) => a + x.ms, 0),
    realSpanMs: d.timeline[d.timeline.length - 1].time - d.timeline[0].time,
    foldedMs,
    playDurMs: lastPlay + 400,
    gapCapMs: GAP_CAP_MS,
    /* 并发信息，供页面和断言核对 */
    maxConcurrent: 0,
    overlapPairs: 0,
  };

  /* 真实并发度 */
  {
    const pt = [];
    for (const x of tools) {
      pt.push({ t: x.startTime, d: 1 });
      pt.push({ t: x.endTime, d: -1 });
    }
    pt.sort((a, b) => (a.t - b.t) || (a.d - b.d));
    let cur = 0;
    for (const p of pt) {
      cur += p.d;
      if (cur > meta.maxConcurrent) meta.maxConcurrent = cur;
    }
  }
  for (let i = 0; i < tools.length; i++) {
    for (let j = i + 1; j < tools.length; j++) {
      if (tools[j].startTime < tools[i].endTime) meta.overlapPairs++;
      else break;
    }
  }
  /* 映射到播放时间轴之后的并发度 —— 必须和真实的一致 */
  {
    const pt = [];
    for (const e of events) {
      if (e.kind === 'tool') pt.push({ t: e.ts, d: 1 });
      else if (e.kind === 'tool_end') pt.push({ t: e.ts, d: -1 });
    }
    pt.sort((a, b) => (a.t - b.t) || (a.d - b.d));
    let cur = 0;
    let mx = 0;
    for (const p of pt) {
      cur += p.d;
      if (cur > mx) mx = cur;
    }
    meta.playMaxConcurrent = mx;
  }

  /* ---------- 4. 自检 ---------- */
  const problems = [];
  if (tools.length !== d.stats.toolsPaired) {
    problems.push(`工具数 ${tools.length} ≠ dsh 统计 ${d.stats.toolsPaired}`);
  }
  const durSum = tools.reduce((a, x) => a + x.ms, 0);
  if (durSum !== d.stats.durTotal) {
    problems.push(`耗时合计 ${durSum} ≠ dsh 统计 ${d.stats.durTotal}`);
  }
  const callN = events.filter((e) => e.kind === 'tool').length;
  const endN = events.filter((e) => e.kind === 'tool_end').length;
  if (callN !== endN) problems.push(`call ${callN} ≠ result ${endN}`);
  if (tools.filter((x) => x.ms < 0).length) problems.push('有负耗时');

  /*
   * 并发必须被保留。
   * 这是这一版改动的核心目标 —— 串行化会把 maxConcurrent 压到 1。
   */
  if (meta.playMaxConcurrent !== meta.maxConcurrent) {
    problems.push(
      `并发被改变：真实最大 ${meta.maxConcurrent} 个，播放时间轴 ${meta.playMaxConcurrent} 个`,
    );
  }

  /* 每个 id 必须一进一出，不多不少 */
  const seenIds = new Map();
  for (const e of events) {
    if (!e.id) continue;
    const k = e.kind + ':' + e.id;
    seenIds.set(k, (seenIds.get(k) || 0) + 1);
  }
  const dupIds = [...seenIds.entries()].filter(([, v]) => v > 1);
  if (dupIds.length) problems.push(`${dupIds.length} 个事件 id 重复出现`);

  writeFileSync(
    new URL('./real-events.json', import.meta.url),
    JSON.stringify({ meta, events }),
    'utf8',
  );

  console.log('=== 生成 real-events.json ===');
  console.log(`  来源会话      ${meta.sessionId.replace('session-', '').slice(0, 8)}`);
  console.log(`  工具调用      ${tools.length}`);
  console.log(`  事件条数      ${events.length}（call ${callN} + result ${endN} + turn_end 1）`);
  console.log(`  真实耗时合计  ${meta.realDurSumMs}ms（${(meta.realDurSumMs / 1000).toFixed(1)}s）`);
  console.log(`  真实跨度      ${(meta.realSpanMs / 3600000).toFixed(1)}h`);
  console.log(`  真实并发      ｜最大同时 ${meta.maxConcurrent} 个 · ${meta.overlapPairs} 对重叠`);
  console.log(`  播放并发      ｜最大同时 ${meta.playMaxConcurrent} 个（必须与真实一致）`);
  console.log(`  折叠掉        ${(meta.foldedMs / 3600000).toFixed(2)}h`);
  console.log(`  播放时长      ${(meta.playDurMs / 1000).toFixed(1)}s`);
  console.log(`  压缩比        ${(meta.realSpanMs / meta.playDurMs).toFixed(0)}:1`);

  if (problems.length) {
    console.error('\n自检失败：');
    for (const p of problems) console.error('  - ' + p);
    process.exit(1);
  }
  console.log('\n自检通过：工具数、耗时合计、配对数量与 dsh/ 一致；并发未被串行化');
}

main();
