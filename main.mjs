/**
 * 主程序。
 *
 * 结构：
 *   Director  真实事件 → 敌人（唯一数据源）
 *   Renderer  战场 → 画布（纯表现，不改任何状态）
 *   main      每帧：喂事件 → 推进战斗 → 画
 *
 * ===== 一条铁律 =====
 *
 * 所有"敌人死了"都来自 Director，来自真实事件。
 * 渲染层不做任何"看起来该死就让它死"的判断。
 * 这条如果破了，整个东西就退化成一段假动画。
 */

import { Director, COMBAT } from './director.mjs';
import { Renderer, ARENA } from './render.mjs';
import { COPY, PM_NAME, TIER_THEME, SPRITE_ROLES, BRAND } from './theme.mjs';
/*
 * TIER 枚举从 bestiary 导入，品级判断一律走它。
 *
 * 上一版这里没导入，于是 D1 拿显示名去比（tierName === 'BOSS'，
 * 而 TIER_NAME 是「蚁后」这类中文，条件恒为假），D2 直接写裸数字 2。
 * 两者都是"品级用了错误的表示"，静默失效且不会有人发现。
 */
import { TIER } from './bestiary.mjs';
/*
 * 协议层：页面侧的入站事件必须过**同一个**校验器。
 *
 * 为什么不自己写一遍字段检查：一旦页面和 doctor 各有一套判定，
 * 就会出现"doctor 说这份日志有问题、页面却照播不误"——
 * 同一个文件两种结论，用户没法知道该信哪个。
 *
 * protocol/events.mjs 是纯函数、无 node 内置依赖，浏览器里能直接 import。
 */
import { KIND, normalize } from './protocol/events.mjs';

/*
 * ===== 事件源：真实会话，不是手写剧本 =====
 *
 * `real-events.json` 由 `build-events.mjs` 从真实会话分析产物生成：
 * 每条 tool/call → 一个敌人出场，每条 tool/result → 一次击杀，
 * **两者之间就是真实的毫秒耗时**。
 *
 * 上一版这里 import 的是 `DEMO_EVENTS` —— 29 条手写常量，
 * 时间是编的。那是在演一个我写死的剧本，不是在展示真实执行。
 * 换成真实数据之后，"read 几乎瞬杀、pwsh 要挨几刀、
 * ask_user_question 站到天荒地老"这些观感才**真的是数据**。
 *
 * 没有网络请求，同步取一次即可（266KB）。
 */
/*
 * 取事件源。
 *
 * 浏览器里用 fetch；Node 里（_refs.mjs 会把 main.mjs 整体跑一遍查未定义引用）
 * 用 fs 直接读 —— 因为 `fetch('./real-events.json')` 在 Node 里
 * 没有 URL 基准，会抛 "Failed to parse URL"，把整个静态检查打断。
 *
 * 两条路径读的是**同一个文件**，所以 Node 里跑出来的行为可信。
 * 如果这里退回成"读不到就给空数组"，静态检查就变成假绿了。
 */
/*
 * 判据用 typeof process，不用 document / window。
 *
 * _refs.mjs 两个都装了桩（document 为了模拟 canvas，window 为了挂 __shield），
 * 所以用它们判断都会误判成在浏览器里，于是去 fetch 相对 URL 照样炸。
 * 只有 Node 才有 process —— 这是唯一可靠的区分。
 */
const inBrowser = typeof process === 'undefined';
const realSrc = await (!inBrowser
  ? JSON.parse(
    (await import('node:fs')).readFileSync(
      new URL('./real-events.json', import.meta.url), 'utf8',
    ),
  )
  : await (await fetch('./real-events.json')).json());
/* 样本战斗：一键演示播的就是它，且它必须真的存在（读不到就抛，不静默给空数组） */
const SAMPLE_EVENTS = realSrc.events;
const SAMPLE_META = realSrc.meta;

/* ============================================================
 *  事件源：三路接入（一键演示 / 拖入文件 / HTTP 钩子）
 * ============================================================ */

/*
 * ===== 这一层为什么必须存在，以及它必须遵守什么 =====
 *
 * 页面原来只有一条事件源：仓库自带的 real-events.json。
 * 那保证了"演的不是手写剧本"，但用户没法看**自己的**智能体。
 *
 * 现在有三条路进来。三条路的共同铁律只有一条：
 *
 *   **只有真的解析出了 tool / tool_end 事件，才允许开始播放。**
 *
 * 解析失败时显示可读错误并**停在原地**。绝不允许"读不懂就退回样本数据"——
 * 那正是本项目最不能犯的错：画面在动、数在涨，但一个字节都不是你的。
 * 所以下面的失败分支一律 return { ok:false }，绝不返回一份兜底事件表。
 */

/** 相邻两个时刻的最大播放间隔：真实会话里 89% 是空白（人在离开），按真实放要等一天 */
const GAP_CAP_MS = 1000;

let EVENTS = SAMPLE_EVENTS;
let META = SAMPLE_META;
/** 当前事件源的标签，显示在状态条上 —— 任何时候都能回答"这播的是谁的活" */
let sourceLabel = '样本：仓库自带真实会话';
/** 实时模式：事件逐条到达，不走 tickDemo 的时间轴游标 */
let liveMode = false;

/**
 * 去掉 UTF-8 BOM。
 *
 * 为什么不从 adapters/jsonl-file.mjs 导入现成的那个：那个模块顶层
 * `import { createReadStream } from 'node:fs'`，浏览器里加载会直接抛错。
 * 页面必须保持"零依赖、纯浏览器可跑"，所以这里保留一份 3 行的实现，
 * 并在 verify 里断言两份行为一致（带 BOM 的第一行不许丢）。
 */
function stripBom(text) {
  const s = String(text ?? '');
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

/**
 * 单调时间映射：真实时间 → 播放时间。
 *
 * 和 build-events.mjs 用同一套规则（相邻间隔压到 GAP_CAP_MS）。
 * 映射是**单调不减**的，所以事件顺序和并发关系完全保留；
 * 折叠掉多少毫秒如实记进 meta.foldedMs，可复算。
 */
function compressTimeline(list) {
  const marks = list.map((e) => e.ts).sort((a, b) => a - b);
  const uniq = [];
  for (const m of marks) {
    if (!uniq.length || m !== uniq[uniq.length - 1]) uniq.push(m);
  }
  const map = new Map();
  let play = 0;
  let folded = 0;
  for (let i = 0; i < uniq.length; i++) {
    if (i > 0) {
      const gap = uniq[i] - uniq[i - 1];
      const used = Math.min(gap, GAP_CAP_MS);
      folded += gap - used;
      play += used;
    }
    map.set(uniq[i], play);
  }
  return {
    events: list.map((e) => ({ ...e, realTs: e.ts, ts: map.get(e.ts) })),
    folded,
    playDur: play,
  };
}

/** 统计最大并发（同时有几个工具在跑）—— HUD 要如实写出来 */
function maxConcurrentOf(calls) {
  const pt = [];
  for (const c of calls) {
    pt.push({ t: c.ts, d: 1 });
    pt.push({ t: c.endTs == null ? c.ts : c.endTs, d: -1 });
  }
  pt.sort((a, b) => (a.t - b.t) || (a.d - b.d));
  let cur = 0;
  let max = 0;
  for (const p of pt) {
    cur += p.d;
    if (cur > max) max = cur;
  }
  return max;
}

/**
 * 事件数组 → 可播放的战斗（统一收尾：排序 + 补 turn_end + 建 meta）。
 *
 * 排序规则和 build-events.mjs 一致：同一时刻先出 tool 再结算 tool_end，
 * 否则 0ms 的调用会"先结算再出场"，seen 会多算一条。
 */
function finalizeSource(rawEvents, extra = {}, label = '未知事件源') {
  const list = rawEvents.filter((e) => Number.isFinite(e.ts));
  const calls = list.filter((e) => e.kind === KIND.TOOL);
  if (calls.length === 0) {
    return {
      ok: false,
      message: '解析出 ' + list.length + ' 条事件，但其中没有 tool（工具调用），'
        + '播不出战斗。',
    };
  }
  const ends = new Map();
  for (const e of list) {
    if (e.kind === KIND.TOOL_END && e.id != null) ends.set(String(e.id), e.ts);
  }
  for (const c of calls) c.endTs = ends.get(String(c.id)) ?? null;

  const { events, folded, playDur } = compressTimeline(list);

  const arr = [...events];
  arr.sort((a, b) => (a.ts - b.ts) || (a.kind === KIND.TOOL ? -1 : 1));

  /*
   * 只补 turn_end，而且只补 ok:true —— 且必须说明这是"文件读完"的收尾。
   *
   * 文件里本来就带 turn_end 的（real-events.json 就带），不重复补。
   * 注意：不给 ok:false 的事件补清场，那会把"有失败"演成"全歼"。
   */
  if (!arr.some((e) => e.kind === KIND.TURN_END)) {
    arr.push({ kind: KIND.TURN_END, ok: true, ts: playDur + 400, synthesized: true });
  }
  const lastTs = arr.reduce((a, e) => Math.max(a, e.ts), 0);

  const meta = {
    label,
    sessionId: extra.sessionId ?? null,
    tools: calls.length,
    realDurSumMs: extra.realDurSumMs
      ?? calls.reduce((a, c) => a + (Number.isFinite(c.realMs) ? c.realMs : 0), 0),
    realSpanMs: extra.realSpanMs ?? null,
    maxConcurrent: extra.maxConcurrent ?? maxConcurrentOf(calls),
    playDurMs: lastTs,
    foldedMs: folded,
  };
  return { ok: true, events: arr, meta, label };
}

/**
 * 会话分析产物（`session-analysis.json`）→ 事件。
 *
 * 只认**完整配对**的调用：缺 endTime 的调用不猜它的结束时刻
 * （猜一个就是伪造击杀时刻），只计数并在提示里说出来。
 */
function fromSessionAnalysis(doc, label) {
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.turns)) {
    return {
      ok: false,
      message: '这不是会话分析文件：缺 turns 数组。'
        + '（期望 DSH 风格 { turns:[{steps:[{tools:[…]}]}] }）',
    };
  }
  const tools = [];
  let unpaired = 0;
  for (const t of doc.turns) {
    for (const s of (t && t.steps) || []) {
      for (const x of (s && s.tools) || []) {
        if (!Number.isFinite(x.startTime) || !Number.isFinite(x.endTime)) { unpaired++; continue; }
        tools.push(x);
      }
    }
  }
  if (tools.length === 0) {
    return {
      ok: false,
      message: 'turns 里没有任何可用于播放的工具调用'
        + (unpaired ? `（${unpaired} 条缺 startTime/endTime，不猜时刻）` : '')
        + '。确认这份分析产物里包含 tool/call 与 tool/result。',
    };
  }
  tools.sort((a, b) => a.startTime - b.startTime);

  const raw = [];
  for (const x of tools) {
    raw.push({
      kind: KIND.TOOL, tool: x.name, id: x.callId, ts: x.startTime, realMs: x.ms,
    });
    raw.push({
      kind: KIND.TOOL_END, tool: x.name, id: x.callId, ok: !x.isError,
      ts: x.endTime, realMs: x.ms,
    });
  }

  /*
   * 真实跨度：优先用 timeline 首尾时刻；没有 timeline 就用工具时刻的极值。
   * 这个数会显示在面板的诚实声明里，所以宁可不算，也不能拿播放时长冒充。
   */
  let span = null;
  if (Array.isArray(doc.timeline) && doc.timeline.length) {
    const t0 = doc.timeline[0].time;
    const t1 = doc.timeline[doc.timeline.length - 1].time;
    if (Number.isFinite(t0) && Number.isFinite(t1)) span = t1 - t0;
  }

  return finalizeSource(raw, {
    sessionId: doc.sessionId ?? null,
    realSpanMs: span,
  }, label || '拖入的会话分析文件');
}

/**
 * 事件数组（`real-events.json` / `{events:[…]}` / JSONL）→ 事件。
 *
 * 每条都过 protocol/events.mjs 的 normalize/validate：
 * **坏事件被拒收并计数**，不会被"修一修"塞进战场。
 * 拒绝理由摘要会回给调用方显示 —— 丢了多少、为什么丢，必须是可见数字。
 */
function fromEventList(list, extra, label) {
  const accepted = [];
  const rejects = [];
  const unknownKinds = new Map();
  for (const raw of list) {
    /*
     * 文件源**不给 now**：缺 ts 的事件一律拒收。
     * 补"读到它的时刻"在这里就是编时间，会凭空造出出场/死亡时刻。
     */
    const r = normalize(raw);
    if (!r.ok) {
      if (rejects.length < 3) {
        rejects.push(r.errors.map((i) => i.code).join('/') || 'unknown');
      }
      continue;
    }
    if (r.unknownKind) {
      const k = String(r.unknownKind);
      unknownKinds.set(k, (unknownKinds.get(k) || 0) + 1);
    }
    accepted.push(r.event);
  }
  if (accepted.length === 0) {
    const why = rejects.length ? `（首个拒收原因：${rejects[0]}）` : '';
    return {
      ok: false,
      message: `${list.length} 条记录没有一条通过协议校验${why}。`
        + '每条至少需要 kind + ts；tool/tool_end 还需要 tool。',
    };
  }
  const res = finalizeSource(accepted, extra, label || '拖入的事件文件');
  if (res.ok) {
    res.rejected = list.length - accepted.length;
    res.unknownKinds = [...unknownKinds.entries()];
  }
  return res;
}

/** 按行解析 JSONL；坏行计数后跳过，不猜内容 */
function fromJsonlText(text, label) {
  const lines = stripBom(text).split('\n');
  const list = [];
  let bad = 0;
  for (const ln of lines) {
    const s = ln.trim();
    if (!s) continue;
    try {
      list.push(JSON.parse(s));
    } catch {
      bad++;
    }
  }
  if (list.length === 0) {
    return {
      ok: false,
      message: `不是合法 JSON，也不是 JSONL：${bad} 行全部解析失败。`,
    };
  }
  const res = fromEventList(list, {}, label || `拖入的 JSONL（${bad} 行坏行已跳过）`);
  if (res.ok && bad) res.badLines = bad;
  return res;
}

/**
 * 文本 → 事件源。**唯一**的文件入口（拖入和选择文件都走这里）。
 *
 * 判定顺序：整文件 JSON（对象/数组）→ 会话分析 → JSONL。
 * 全都认不出来时返回可读错误，**绝不返回兜底数据**。
 */
function parseSourceText(text, name = '') {
  const raw = String(text ?? '');
  if (!raw.trim()) {
    return { ok: false, message: '文件是空的：没有任何内容可以播放。' };
  }
  let doc;
  let jsonErr = null;
  try {
    doc = JSON.parse(stripBom(raw));
  } catch (e) {
    jsonErr = e;
  }
  if (jsonErr === null) {
    if (Array.isArray(doc)) return fromEventList(doc, {}, name || '拖入的事件数组');
    if (doc && typeof doc === 'object' && Array.isArray(doc.events)) {
      return fromEventList(doc.events, doc.meta || {}, name || '拖入的 real-events.json');
    }
    if (doc && typeof doc === 'object' && Array.isArray(doc.turns)) {
      return fromSessionAnalysis(doc, name || '拖入的 session-analysis.json');
    }
    const keys = doc && typeof doc === 'object' ? Object.keys(doc).join(', ') : typeof doc;
    return {
      ok: false,
      message: '认不出这份文件的形状（键：' + (keys || '空') + '）。\n'
        + '支持：{ events:[…] }（含 meta）、事件数组、'
        + '会话分析 { turns:[…] }、以及一行一条的 .jsonl。',
    };
  }
  /* 不是整文件 JSON —— 试 JSONL（最常见的日志形态） */
  return fromJsonlText(raw, name);
}


/* ---------------- DOM ---------------- */

const cv = document.getElementById('cv');
const startPanel = document.getElementById('startPanel');
const startBtn = document.getElementById('startBtn');
const hud = document.getElementById('hud');
const hudLine1 = document.getElementById('hudLine1');
const hudCombo = document.getElementById('hudCombo');
const hudWarn = document.getElementById('hudWarn');
const hudDetail = document.getElementById('hudDetail');
const hudBoss = document.getElementById('hudBoss');
const toastEl = document.getElementById('toast');
/* 三个入口 + 事件源状态条（落地页） */
const sourceNote = document.getElementById('sourceNote');
const dropZone = document.getElementById('dropZone');
const dropErr = document.getElementById('dropErr');
const pickBtn = document.getElementById('pickBtn');
const filePick = document.getElementById('filePick');
const hookInput = document.getElementById('hookInput');
const hookBtn = document.getElementById('hookBtn');
const hookState = document.getElementById('hookState');

/* ---------------- 状态 ---------------- */

const renderer = new Renderer(cv);

const director = new Director({ arena: ARENA });

/** 植保盾牌。位置固定在场地中央偏内一点，跟随轻微移动。 */
const aegis = {
  x: 0,
  y: 0,
  /** 上一帧位置，用来算速度（朝向、速度线都要） */
  _px: 0,
  _py: 0,
  /** 本帧速度（格/秒），由位置差算出 */
  vx: 0,
  vy: 0,
  /** 是否在移动（director 每帧写） */
  moving: false,
  /** 是否在后退躲避（director 每帧写） */
  fleeing: false,
  /** 累计挥击次数（真实计数） */
  swing: 0,
  /** 当前挥击的相位 0..1，用于选帧 */
  swingT: 0,
  /** 受击反馈 */
  hurtT: 0,
};

/*
 * 屏幕震动量：**trauma**，不是像素。
 *
 * ===== 语义改了一次，值得说清楚 =====
 *
 * 上一版是"像素偏移"，每次命中写死 2.2px。问题是：
 *   - 普通命中和击杀的震感完全一样（都用 2.2）
 *   - 连续命中时 Math.max 让震屏一直停在 2.2，抖动没有层次
 *
 * 现在改成 trauma ∈ [0,1]：事件**累加**，时间线性衰减，
 * 实际偏移由 renderer 算 trauma² × maxOffset。
 * 好处是强度分级天然成立（普通命中 0.18 → 击杀 0.5 → BOSS 0.85），
 * 连击会自然叠加成更强的震感，符合"打得越狠越晃"的直觉。
 *
 * 数值依据：GDC 2016 Eiserloh《Juicing Your Cameras With Math》
 * 的 trauma 模型（trauma .3/.6/.9 → 抖动 3%/22%/73%，即严格平方）。
 */
let shake = 0;

/**
 * ===== 特效开关（可访问性）=====
 *
 * 三个**互相独立**的开关，不是一个打包的"降低特效"。
 *
 * 依据：Vampire Survivors 把 `Flashing VFX`、`Weapons ScreenShake`、
 * `Damage Numbers`、`Disable blood` 做成四个独立选项。
 * 这是正确的做法 —— 不同的人对不同的刺激敏感：
 * 有人对震屏晕动，有人对闪烁不适，但都还想保留打击感。
 * 打包成一个开关就逼他们在"全有"和"全无"之间选。
 *
 * 反面案例也很明确：Nuclear Throne 是在玩家反馈晕动症之后
 * **被迫**补上震屏开关的。所以这个开关应该一开始就有。
 */
const FX = {
  shake: true,
  flash: true,
  numbers: true,
};

/** trauma 每秒衰减量。1.1/s 意味着一记普通命中约 0.16 秒散完 */
const SHAKE_DECAY_PER_SEC = 1.1;

/**
 * 事件 → trauma 增量。
 *
 * 这些数字不是手感玄学，是按"trauma² 之后的像素量"倒推的：
 *   maxOffset = 22px
 *   普通命中 0.18 → 0.71px（只被感觉到，不晃眼）
 *   重击     0.35 → 2.70px
 *   击杀     0.50 → 5.50px
 *   BOSS 死亡 0.85 → 15.9px
 */
const TRAUMA = {
  hit: 0.18,
  hitElite: 0.26,
  hitBoss: 0.35,
  kill: 0.50,
  killBoss: 0.85,
  fail: 0.22,
};

/** 加 trauma。钳到 1，不无限叠加。关掉震屏时直接忽略。 */
function addTrauma(v) {
  if (!FX.shake) return;
  shake = Math.min(1, shake + v);
}

/** 演示模式下的时间轴游标 */
let demoIndex = 0;
let demoStart = 0;
let playing = false;
let paused = false;

/**
 * 状态条上那句"未播放任何数据"是否**当前为真**。
 *
 * ===== 为什么需要这个标记 =====
 *
 * 这句声明是全局的（"屏幕上什么都没有"），可它在两处会当场变成假话：
 *   1. 之后真的有事件进了战场（实时模式下事件可以晚于声明到达）；
 *   2. 用户开始播放/暂停（那意味着战场上有东西可摆弄）。
 *
 * 光靠"写的时候判断一次"不够 —— 判定那一刻为真，之后可能变假。
 * 所以凡是让这句声明失效的动作，都要把它摘掉；靠这个标记就能
 * 只摘"那一句"，不会误伤一条真实的来源说明。
 */
let noteClaimsNothingPlayed = false;

/** 战场上有没有任何真实进度（判"未播放任何数据"是否成立的数据依据） */
function battleHasProgress() {
  return director.enemies.length > 0 || director.gone.length > 0
    || director.seen > 0 || director.kills > 0;
}

/*
 * 检视态：HUD 展开完整明细。
 *
 * 两个入口：
 *   - 手动按 I 切换（想随时看数据）
 *   - 暂停时**自动展开**（暂停本来就是"停下来想看看"的时刻）
 *
 * 手动切换的值存在 inspectManual 里，这样暂停/继续不会覆盖
 * 用户手动做的选择：暂停只是"临时要求展开"。
 */
let inspectManual = false;
let inspectPaused = false;
function syncInspect() {
  if (!hud) return;
  const on = inspectManual || inspectPaused;
  hud.classList.toggle('inspect', on);
}
/*
 * 所有改变 paused 的地方都必须走这个函数，
 * 否则"暂停了但明细没展开"—— 状态分叉比功能缺失更难查。
 */
function setPaused(v) {
  paused = v;
  inspectPaused = v;
  syncInspect();
  /*
   * ===== 暂停 / 继续也要摘掉"上一次载入失败"的旧消息 =====
   *
   * 真浏览器复验抓到的 bug 就在这里：播放中按空格走 setPaused，
   * **不经过** startDemo()，于是 startDemo 里那句 clearLoadError()
   * 一次都没跑到 —— 画面上在播（seen 在涨），左下角还挂着红条，
   * 一屏两句话互相打脸。
   *
   * 修法不是"空格分支再补一句 clearLoadError"（那样 P 键、鼠标、
   * 以后新增的任何暂停入口都要各补一次，必漏）。暂停/继续本来就是
   * "用户开始摆弄当前这场播放"的信号，旧那条载入消息已经不是当前
   * 话题，所以清除逻辑挂在**唯一的暂停状态变更函数**上。
   */
  clearLoadError();
  return paused;
}

/** fps 统计 */
let frames = 0;
let fps = 0;
let fpsAt = 0;

/* ---------------- 事件入口 ---------------- */

/**
 * 喂一个真实事件。
 *
 * 这是整个程序**唯一**的输入口。浏览器控制台里可以这样用：
 *   __shield.emit({ kind:'tool', tool:'read_file', ok:true })
 *   __shield.emit({ kind:'tool', tool:'agent_run' })          // BOSS 上场
 *   __shield.emit({ kind:'tool_end', tool:'agent_run', ok:true })  // BOSS 被击杀
 *   __shield.emit({ kind:'turn_end', ok:true })                // 清场
 */
function feed(ev) {
  /*
   * 事件时间戳统一走 clockNow()。
   *
   * 如果这里用真实墙钟，暂停期间手动 emit 一条事件会带着
   * "比战场更晚"的时间戳进去，醒来后 timeLeft 会凭空少一截。
   */
  const t = clockNow();
  const before = director.stats(t);
  const r = director.handle(ev, t);
  const after = director.stats(t);

  /*
   * ===== "未播放任何数据"这句话一旦不再成立，必须当场失效 =====
   *
   * 这条不是锦上添花：实时模式（HTTP 钩子）下事件是**陆续到达**的。
   * 完全可以出现"载入失败写了未播放任何数据" → 之后钩子的第一条事件
   * 到了 → 战场开始动。此时红条上那句全局声明就变成假话。
   *
   * 写在 feed 里是因为它是**唯一**的事件入口：任何一条事件无论从
   * 样本时间轴、拖入的文件还是网络进来，都会经过这里。
   */
  if (noteClaimsNothingPlayed && battleHasProgress()) {
    clearLoadError();
  }

  // 有新击杀 → 视觉反馈（震动 + 飘字），但击杀事实来自 director
  if (after.kills > before.kills) {
    /*
     * 击杀的震屏按档位分级。
     *
     * 上一版所有击杀都写 2.2px —— BOSS 死了和小兵死了晃得一样，
     * 那 BOSS 的分量就没了。现在 BOSS 0.85（→15.9px），
     * 小兵 0.50（→5.5px）。
     */
    /*
     * 用 TIER 枚举判断，既不抄显示名，也不写裸数字 2。
     *
     * 这里原来写的是 `r.tierName === 'BOSS'` —— 恒为假。因为 tierName
     * 取自 TIER_NAME，那是中文显示名（'蚁后'），不是英文标识。
     * 后果不是"少了个特例"，而是 killBoss 的震屏/血污分支**永不可达**：
     * BOSS 死得跟杂兵一模一样，本场唯一的长跑者没有任何分量感。
     *
     * 也曾经想写 `=== 2`：那就是在依赖 bestiary 里 TIER.BOSS 恰好等于 2
     * 这个实现细节，哪天枚举顺序变了会静默失效。
     * 所以从 bestiary 导入 TIER，按数值比较。
     */
    const isBoss = r && r.tier === TIER.BOSS;
    addTrauma(isBoss ? TRAUMA.killBoss : TRAUMA.kill);
    if (r && r.x != null) {
      renderer.addStain(r.x, r.y, '#5a1a1a');
      /*
       * 击杀飘字按档位分：BOSS 更大更亮，带 scale punch（1.6）。
       *
       * 参考的数值（gamecn 的 damage-numbers 实现）：
       *   普通 #ffffff 14px 800 字重
       *   暴击 #facc15 18px（+29%）+ 黄色 glow
       *   miss  #94a3b8 11px（-21%）全大写
       *
       * 这里击杀=黄（#ffd24a ≈ facc15），BOSS 用更大档，
       * 失败用暗红小字 —— 一眼能分出"打死了"和"没做成"。
       */
      /*
       * 连击数 >= 2 时把数字写进飘字（KILL x3），并随连击加码：
       * 字更大、上浮更高、寿命更长。
       *
       * 上限钳到 x9 —— 连环击杀十几只时字会大到盖住战场，
       * 那反而看不清打在哪儿。连击数本身在 HUD 里如实显示，
       * 不会被这个视觉上限影响。
       */
      const cb = after.combo || 0;
      const cbShow = Math.min(cb, 9);
      /* 飘字文案来自 theme：换题材时这里跟着变 */
      const label = cb >= 2
        ? COPY.floater.killCombo.replace('{n}', String(cb))
        : COPY.floater.kill;
      if (FX.numbers) renderer.addFloater(r.x, r.y - 8, label,
        isBoss ? '#FFF0A8' : (cb >= 2 ? '#FFE066' : '#ffd24a'),
        isBoss
          ? { scale: 1.7, pop: 1.7, vy: -46, life: 0.85, drift: 0 }
          : {
            scale: 1.15 + 0.10 * Math.max(0, cbShow - 1),
            pop: 1.45,
            vy: -34 - 3 * Math.max(0, cbShow - 1),
            life: 0.55 + 0.05 * Math.max(0, cbShow - 1),
          });
    }
    if (toastEl) showToast(COPY.toast.kill.replace('{tool}', r ? r.tool : ''));
  }
  if (after.failures > before.failures) {
    if (r && r.x != null) {
      /*
       * 失败：暗红、小字、不上浮太多、寿命短。
       * 刻意做得**比击杀弱** —— 失败不该有成就感。
       */
      if (FX.numbers) {
        renderer.addFloater(r.x, r.y - 8, COPY.floater.fail, '#e07a6a',
          { scale: 0.85, vy: -26, life: 0.5 });
      }
    }
    if (toastEl) showToast(COPY.toast.fail.replace('{tool}', r ? r.tool : ''));
  }
  return r;
}

let toastTimer = 0;
function showToast(msg) {
  if (!toastEl) return;
  toastEl.textContent = msg;
  toastEl.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('on'), 1100);
}

/* ---------------- 战斗启动：演示 / 拖入 / 钩子 共用一条路径 ---------------- */

/**
 * 换事件源并开打。
 *
 * ===== 为什么参数不在 startDemo 上 =====
 *
 * 三个入口（一键演示、拖入文件、HTTP 钩子）必须走**同一条**启动路径 ——
 * 一旦分成两条，就会出现"演示能重播、拖入的不能重播"这种不对称 bug。
 *
 * 但 startDemo 本身保持无参：verify.mjs 用它的无参声明做锚点定位重置块
 * （"重播必须把全部累积计数清零"那条断言只认无参形式）。
 * 所以参数入口单独放这里，重置逻辑只有一份。
 */
function startFrom(source) {
  EVENTS = source.events;
  META = source.meta;
  sourceLabel = source.label;
  liveMode = source.live === true;
  startDemo();
}

function startDemo() {
  /*
   * 这里是三个入口（样本 / 拖入 / 钩子）加键盘重播（空格 / R）的
   * **最终汇合点**，所以失败红条的清除写在这里：写进入口就一定会漏
   * 一个（实测漏的就是空格 / R 这两条键盘路径）。
   * 它只清"失败态"的条子，不会抹掉随后 showSource 写下的真实来源说明。
   */
  clearLoadError();
  director.enemies.length = 0;
  director.gone.length = 0;
  director.seen = 0;
  director.kills = 0;
  director.failures = 0;
  director.unmapped = 0;
  director.unknown = 0;
  director.swings = 0;
  director.damage = 0;
  director.turnDone = false;
  director.turnOk = false;
  director.finaleAt = null;
  director.log.length = 0;
  director._swingAcc = 0;
  /*
   * ===== 重播必须把连击和重复计数也清掉 =====
   *
   * 上一版漏了这四个字段，后果是重播后出现
   * **combo > kills** 这种算术上不可能的值：
   * 实测第二轮跑到 seen=126 时报 combo=169（击杀 126 次却有 169 连击）。
   *
   * 原因：combo/comboBest 是上一局累积的，restart 没清，
   * 新一局的击杀继续往旧连击上叠加。
   *
   * 这类残留不会报错，只会让"重播后再验收"的读数虚高 ——
   * 而重播恰恰是人最常用的操作。所以必须在这里清干净。
   */
  director.combo = 0;
  director.comboBest = 0;
  director.comboAt = -Infinity;  // 与 Director 构造函数里的初值一致
  director.duplicates = 0;

  aegis.x = 0;
  aegis.y = 0;
  aegis._px = 0;
  aegis._py = 0;
  aegis.vx = 0;
  aegis.vy = 0;
  aegis.moving = false;
  aegis.fleeing = false;
  aegis.swing = 0;
  aegis.swingT = 0;
  aegis.hurtT = 0;
  shake = 0;

  demoIndex = 0;
  demoStart = performance.now();
  playing = true;
  /*
   * 重播必须清掉检视态的"暂停自动展开"，
   * 否则上一局暂停时展开的明细会带到新一局。
   * 手动开关 inspectManual 保留 —— 那是用户主动设的偏好。
   */
  inspectPaused = false;
  setPaused(false);
}

/** 按真实时间轴把事件送进来（事件是真实的，进入管线的路径和实时事件完全一致） */
function tickDemo(now) {
  if (!playing || paused) return;
  /*
   * 实时模式（HTTP 钩子）不走时间轴：事件从网络逐条到达，
   * 由 onLiveEvent 直接 feed。这里只负责把"已结束"这件事说清楚。
   * 用时间轴游标去推进实时事件，等于给它编一个假节奏。
   */
  if (liveMode) return;
  /*
   * 播放倍速。
   *
   * 真实会话 292 次调用、压缩后播放时长 266 秒（4 分半）。
   * 1:1 放完太久，观众看不到整场的样子。
   *
   * 注意倍速只影响**播放**，不影响任何数据：
   * 每次调用的真实毫秒仍然记在事件里（realMs），
   * HUD 显示的是真实值。倍速只是让敌人在场时间变短，
   * 不改谁什么时候死这个事实 —— 死亡时刻由事件 ts 决定。
   */
  const t = (now - demoStart) * PLAYBACK_SPEED;
  while (demoIndex < EVENTS.length && EVENTS[demoIndex].ts <= t) {
    const ev = EVENTS[demoIndex++];
    feed(ev);
  }
  if (demoIndex >= EVENTS.length && director.turnDone) {
    playing = false;
  }
}

/* ---------------- 每帧 ---------------- */

/**
 * 播放倍速：只影响"看到的速度"，不影响任何数据。
 *
 * 抽成模块级常量是因为落地面板的文案要把它写出来
 * （[data-theme=honest-time] 里的 "3 倍速"），
 * 写死两个 3 迟早会不一致。
 */
const PLAYBACK_SPEED = 3;

let last = null;

/*
 * 暂停用的冻结时钟。
 *
 * lastRealNow 记录"最后一次未暂停时的真实时间戳"，
 * 暂停期间所有传给 director / renderer 的时间都用它。
 * fightClock 是战斗自身的累计时间（不含暂停），
 * 留给将来需要"战斗内时长"的地方用。
 */
let lastRealNow = 0;
let fightClock = 0;

/*
 * 战斗时钟：所有对外暴露的状态都必须用它，不能用 performance.now()。
 *
 * 这条是浏览器实测抓出来的：暂停时 HUD 走冻结时钟（combo 正确冻结），
 * 但 __shield.stats() 用的是真实墙钟，于是同一个字段
 * 在 HUD 里是 4、在调试口里是 0 —— 同一个数两处不一致。
 *
 * 计时来源只能有一个。暂停时它停在 lastRealNow，恢复时继续。
 */
function clockNow() {
  return paused ? lastRealNow : performance.now();
}

function frame(now) {
  const dtRaw = last === null ? 0 : (now - last) / 1000;
  last = now;
  const dt = Math.min(dtRaw, 0.05);

  if (startPanel && !startPanel.classList.contains('hidden')) {
    // 还没开始，只画一帧静态画面
  }

  /*
   * ===== 暂停必须冻结**整个战场**，不只是事件时间轴 =====
   *
   * 浏览器实测发现的真问题：按 P 之后 tickDemo 停了，
   * 但 director.advance 还在跑 —— 敌人继续追、盾牌继续挥、
   * 血条继续掉、连击窗口继续过期。实测暂停 1.5 秒后
   * swings 从 58 涨到 63。
   *
   * 这直接毁掉了检视态的意义：按 P 展开明细，本意是
   * "停下来看清这些数字"，而数字还在跳。
   *
   * 修法不是简单地 return —— 那样屏幕会立刻定格成一张死图，
   * 且 last 时间戳不更新，恢复时 dt 会突然变得很大（累积了
   * 整个暂停时长），敌人会瞬移。
   *
   * 正确做法：暂停时 dt 归零、传入的战斗时间戳冻结。
   *   - dt=0        → 一切按时间的推进都停在原地
   *   - fightNow    → 冻结的时间戳，血条/连击/电击寿命都不再流逝
   * 画面照样每帧重绘（呼吸、闪电这类纯视觉动画用 _t，
   * 但 director 侧的数值一律不动）。
   */
  if (!paused) {
    fightClock += dt;
    lastRealNow = now;
  }
  const fightNow = paused ? lastRealNow : now;
  const fightDt = paused ? 0 : dt;

  if (!paused) tickDemo(now);

  /* --- 战斗推进 --- */
  const before = director.swings;

  aegis._px = aegis.x;
  aegis._py = aegis.y;

  const res = director.advance(fightDt, fightNow, aegis);

  /*
   * 由**位置差**算速度，而不是另外维护一个速度变量。
   *
   * 为什么这样做：director 里盾牌的位置是"三组力叠加后归一化推进"得到的，
   * 单独维护速度很容易和实际位移不同步（尤其被边界钳制、被夹住时）。
   * 从位置差反推，永远和画面上看到的运动一致。
   */
  if (fightDt > 1e-6) {
    aegis.vx = (aegis.x - aegis._px) / fightDt;
    aegis.vy = (aegis.y - aegis._py) / fightDt;
  } else {
    aegis.vx = 0;
    aegis.vy = 0;
  }

  /*
   * director 每帧写的两个状态：
   *   aegisMoving  这一帧确实动了
   *   aegisFleeing 这一帧在后退（被逼近）
   */
  aegis.moving = !!director.aegisMoving;
  aegis.fleeing = !!director.aegisFleeing;

  /*
   * 盾牌的挥击动画由**真实挥击计数**驱动。
   * director.advance 返回本帧发生了几次挥击，
   * 这里把计数累加，动画相位只做视觉插值。
   */
  if (res.swings > 0) {
    aegis.swing += res.swings;
    aegis.swingT = 0.22;
    /*
     * 暂停时 dt 已归零，理论上不会有挥击；
     * 这里仍然显式挡一道，避免"暂停瞬间刚生成的一次挥击"
     * 在屏幕上闪一下震屏。
     */
    if (!paused) addTrauma(TRAUMA.fail);

    /*
     * 每一下真实施法 = 一条雷电链。
     *
     * 注意这里**不需要**再构造雷电的数据 ——
     * director 在结算伤害的同时已经把链的几何写进 director.lightning 了。
     * renderer 直接读那份数据画，所以"雷打到谁"和"谁掉血"
     * 永远是同一份事实，不会对不上。
     *
     * 之前枪械版本是在这里调 addShot 造一条独立弹道，
     * 那种做法有隐患：弹道是渲染层自己编的，和伤害结算无关，
     * 一旦两边逻辑漂移就会"画面上打 A、血掉在 B"。
     */
  }
  if (aegis.swingT > 0) aegis.swingT = Math.max(0, aegis.swingT - dt);
  if (aegis.hurtT > 0) aegis.hurtT = Math.max(0, aegis.hurtT - dt * 3);
  /* trauma 线性衰减（Eiserloh 模型：衰减用线性，应用时用平方） */
  if (shake > 0) shake = Math.max(0, shake - dt * SHAKE_DECAY_PER_SEC);

  /* --- 渲染 --- */
  renderer.draw({
    /*
     * 传给渲染层也用冻结时钟：
     * 否则暂停时呼吸动画还在动，而战场数值静止，
     * 会出现"人还在喘气但时间停了"的诡异感。
     */
    now: fightNow,
    director,
    aegis,
    shake,
    /*
     * 闪烁开关传进渲染层。
     *
     * 震屏和飘字在 main 侧就掐掉了（不累加 trauma / 不加飘字），
     * 但受击白闪是 renderer 内部按 hurtT 触发的，
     * 所以必须把这个开关传下去 —— 否则按 F 会没有任何反应，
     * 用户以为键坏了。
     */
    fx: FX,
  });

  /* --- HUD --- */
  frames++;
  if (now - fpsAt > 500) {
    fps = Math.round((frames * 1000) / (now - fpsAt));
    frames = 0;
    fpsAt = now;
    updateHud(fightNow, fps);
  }

  requestAnimationFrame(frame);
}

function updateHud(now, fpsNow) {
  if (!hud) return;
  const s = director.stats(now);

  /*
   * 运行态（极简）：只留"战场现状"三个数。
   * 细分的小兵/精英/BOSS 数量挪到检视层 —— 运行中没人数这个。
   */
  if (hudLine1) {
    hudLine1.textContent =
      `${COPY.hud.alive} ${s.alive} · ${COPY.hud.kills} ${s.kills}` +
      (s.failures > 0 ? ` · ${COPY.hud.failures} ${s.failures}` : '');
  }

  /*
   * 连击角标：只有 >= 2 才算连击。
   * s.combo 由 director 读时计算，窗口一过就自动归零，
   * 所以这里不需要自己做过期判断。
   */
  if (hudCombo) {
    if (s.combo >= 2) {
      hudCombo.textContent = `${COPY.hud.combo} ×${s.combo}`;
      hudCombo.classList.add('on');
    } else {
      hudCombo.textContent = '';
      hudCombo.classList.remove('on');
    }
  }

  /*
   * 诚实警示：未映射 / 超时**永不隐藏**，非零就常驻运行态。
   * 这两个数字不好看，但藏起来就是假报告。
   */
  if (hudWarn) {
    const w = [];
    if (s.unmapped > 0) w.push(`${COPY.hud.unmapped} ${s.unmapped}`);
    if (s.overdue > 0) w.push(`${COPY.hud.overdue} ${s.overdue}`);
    hudWarn.textContent = w.join(' · ');
  }
  /*
   * 检视层（展开）：完整明细。
   * 这些是"分析时才看"的数，运行中留着只会互相干扰。
   */
  if (hudDetail) {
    hudDetail.textContent = [
      /*
       * 三级缩写来自 theme（侦 / 突 / 母），不是写死的「小精BOSS」。
       * 换题材时这一行跟着变，逻辑不需要动。
       */
      `${TIER_THEME.minion.short} ${s.aliveMinion}`
        + ` ${TIER_THEME.elite.short} ${s.aliveElite}`
        + ` ${TIER_THEME.boss.short} ${s.aliveBoss}`,
      /*
       * 进度用**调用数**，不用事件数。
       *
       * 上一版写 `事件 ${s.seen}/${META.tools*2+1}`：
       * 分子只统计 tool 出生（292），分母是全部事件（585）——
       * 语义不同，放完也只会显示 301/585，进度条永远读不到满。
       * 现在改成"已结算调用 / 总调用"。
       */
      `${COPY.hud.calls} ${s.kills}/${META.tools}`,
      /*
       * 把并发度写出来。
       *
       * 实测：真实数据最大同时 4 个、41 对重叠，
       * 但**重叠本身只持续 0.419 秒**（占播放时长 0.16%）——
       * 因为那些重叠都是几次 read 同时起跑、8ms 就结束。
       *
       * 如果页面上不写这个数，观众会默认智能体是串行干活的，
       * 而事实是它会并发（放子智能体后继续做别的事）。
       * 这句话就是为了说清：**并发存在，但真实数据里它很短。**
       */
      `${COPY.hud.concurrent} ${META.maxConcurrent}`,
      `${COPY.hud.swings} ${s.swings}`,
      `${COPY.hud.damage} ${s.damage}`,
      `${COPY.hud.comboBest} ${s.comboBest}`,
      `${COPY.hud.duplicates} ${s.duplicates}`,
      `${fpsNow} fps`,
    ].join(' · ');
  }

  /* D2 修复：BOSS 血条用 tier 数值，不写裸数字 2 */
  const boss = director.enemies.find((e) => e.tier === TIER.BOSS && e.diedAt === null);
  if (hudBoss) {
    if (boss) {
      hudBoss.classList.add('on');
    } else {
      hudBoss.classList.remove('on');
    }
  }
}

/* ---------------- 落地面板：文案全部来自 theme ---------------- */

/**
 * 把 theme 的文案填进落地面板。
 *
 * ===== 为什么文案不在 index.html 里写好 =====
 *
 * 静态 HTML 里写死文案，换题材就必须改 HTML ——
 * 那正是"换题材要动四个地方"的老问题。
 * 这里改成**运行时填充**：HTML 只留带 data-theme 标记的空壳，
 * 内容由 theme 提供。于是换题材 = 改 theme.mjs 一个文件
 * （加 HTML 的空壳一次就好，之后就再也不动了）。
 *
 * 用 data-theme 而不是 id：一个节点可以同时挂多个槽位，
 * 而且 id 已经被 HUD 占用了（hudLine1 / hudWarn …）。
 */
function applyPanelCopy() {
  /*
   * 查询要**容错**：Node 侧的静态检查（_refs.mjs）只装了
   * getElementById / createElement 的最小 DOM 桩，没有 querySelector。
   * 这里如果直接调，静态检查会在模块加载期抛错，
   * 于是"未定义引用"检查整个哑掉 —— 那比少填文案严重得多。
   *
   * 返回 null 时静默跳过：文案没填上是**可见的**（面板是空的），
   * 而崩掉是**不可见的**（检查直接没跑）。
   */
  const q = (sel) => {
    if (typeof document === 'undefined'
      || typeof document.querySelector !== 'function') return null;
    try { return document.querySelector(sel); } catch { return null; }
  };
  const set = (key, value) => {
    const el = q(`[data-theme="${key}"]`);
    if (el) el.textContent = value;
  };
  set('panel-title', COPY.panelTitle);
  set('panel-sub', COPY.panelSub);
  set('start-button', COPY.startButton);
  set('keys-hint', COPY.keysHint);

  /* 三级说明：标签 + 描述 */
  set('tag-minion', COPY.tierRules.minion.tag);
  set('desc-minion', COPY.tierRules.minion.desc);
  set('tag-elite', COPY.tierRules.elite.tag);
  set('desc-elite', COPY.tierRules.elite.desc);
  set('tag-boss', COPY.tierRules.boss.tag);
  set('desc-boss', COPY.tierRules.boss.desc);

  /*
   * 诚实声明里带真实数据占位符。
   *
   * 占位符只放**数据**（调用数、耗时、跨度），判断和措辞都在 theme 里 ——
   * 这样"死也不靠血条"这类承诺不会被数据填充逻辑改写。
   */
  const fill = (tpl) => tpl
    .replace('{session}', String(META.sessionId || '').slice(-8))
    .replace('{tools}', String(META.tools))
    .replace('{duration}', (META.realDurSumMs / 1000).toFixed(1))
    .replace('{span}', (META.realSpanMs / 3600000).toFixed(1))
    .replace('{playback}', (META.playDurMs / 1000).toFixed(0))
    .replace('{speed}', String(PLAYBACK_SPEED));

  const honestDeath = q('[data-theme="honest-death"]');
  if (honestDeath) honestDeath.innerHTML = COPY.honest.death;
  const honestSource = q('[data-theme="honest-source"]');
  if (honestSource) honestSource.innerHTML = fill(COPY.honest.source);
  const honestTime = q('[data-theme="honest-time"]');
  if (honestTime) honestTime.innerHTML = fill(COPY.honest.timeAxis);

  /* 浏览器标签页标题 */
  if (typeof document !== 'undefined' && 'title' in document) document.title = COPY.docTitle;

  /* 品牌英文名（和 nameZh 同源，来自 theme 的 BRAND） */
  set('panel-en', BRAND.pkgId);
}

/* ---------------- 三个入口：演示 / 拖入 / 钩子 ---------------- */

/**
 * 状态条：任何时候都能看到"现在播的是哪份数据"。
 *
 * 它是这套东西诚实性的一部分 —— 页面在动的时候，
 * 人必须能回答"这些数是从哪来的"。所以载入失败时它是红的，
 * 载入成功时报出源名和拒收/坏行计数。
 */
function showSource(text, bad = false) {
  if (!sourceNote) return;
  sourceNote.textContent = text;
  noteClaimsNothingPlayed = /未播放任何数据|战场为空/.test(String(text));
  sourceNote.classList.add('on');
  /*
   * 用 add / remove 而不是 toggle(c, force)：
   * toggle 的两参形式在 DOM 桩里不一定被实现，一旦桩忽略第二个参数，
   * "写成好来源"也会被加上 bad —— 断言就测到假状态。
   */
  if (bad) sourceNote.classList.add('bad');
  else sourceNote.classList.remove('bad');
}

/**
 * 清掉上一次的载入失败提示。
 *
 * ===== 为什么必须显式清（这是产品红线）=====
 *
 * 实测过的坏状态：喂一个垃圾文件 → 状态条变红写下"这份文件没进战场"；
 * 然后按空格 / R 重播样本（画面真的在动、来源标签已经切回样本），
 * **红条还挂在屏幕上**。同一屏同时出现"没在播"和"正在播"两句话，
 * 等于界面在撒谎 —— 和"绝不伪造进度"是同一枚硬币的两面。
 *
 * 谁必须调它：**每一个改变播放状态的入口**。
 *   开始新的数据源 → startDemo / playSource / startSampleDemo
 *   暂停 / 继续      → setPaused（唯一改 paused 的函数）
 * 只写在"开始播"的入口里是不够的：真浏览器复验抓到的那个 bug 就是
 * 播放中按空格走 setPaused，一次都没经过 startDemo。
 */
function clearLoadError() {
  if (dropErr) dropErr.textContent = '';
  noteClaimsNothingPlayed = false;
  if (!sourceNote) return;
  /*
   * 只清"失败态"的条子：成功态的来源说明由后续 showSource 覆写，
   * 这里不要顺手把一条真实说明抹掉（那会变成另一个方向的撒谎）。
   */
  if (sourceNote.classList.contains('bad')) {
    sourceNote.classList.remove('bad');
    sourceNote.classList.remove('on');
    sourceNote.textContent = '';
  }
}

/**
 * 载入失败：面板上给出可读错误，并停在原地（不退回样本数据）。
 *
 * ===== 文案语义（本轮改过，别改回无条件"全局声明"）=====
 *
 * 以前的写法是无条件一句：
 *   「载入失败 · 未播放任何数据」
 * 这是一句**全局状态声明**，可写它的这行代码当时并不知道答案：
 *
 *   - 拖入垃圾文件时，上一轮的样本 / 钩子战斗可能**还在画面上打**；
 *   - 点了「进入战场」之后再拖一个垃圾文件，同样如此；
 *   - 暂停在有数据的战场上时，画面里明明有一整场冻结的战斗。
 *
 * 于是同一屏出现"没在播放任何数据"和真的在飞的敌人两句话 ——
 * 界面在撒谎。真浏览器复验抓到的正是这一类（播放中按空格不清红条）。
 *
 * ===== 选定语义：全局声明 ≠ 随便写，必须**当场核对** =====
 *
 * 这句话对用户是有价值的（"我拖了个垃圾文件，有没有把正在看的东西
 * 搞丢？"），所以不删它，而是**只在它成立时**才写：
 *
 *   - 战场真的没有任何进度（敌人 0 / seen 0 / 击杀 0）
 *       → 「载入失败 · 未播放任何数据」；
 *   - 否则
 *       → 「载入失败 · 这份文件没进战场」（只描述这次尝试，不对
 *         画面状态做任何断言）。
 *
 * 判据用**数据**（director 的真实计数）而不是某个开关：开关会被漏设，
 * 计数就是画面本身。
 *
 * 另外两层保护（缺一层都还会漏）：
 *   1. 任何播放控制动作（开始 / 暂停 / 继续 / 重播）都会摘掉这条提示
 *      —— 见 setPaused 与 startDemo；
 *   2. 一旦真的有事件进战场（feed），"未播放任何数据"这句话立刻失效，
 *      所以 feed 里会按标记把它摘掉 —— 否则实时模式下事件可以在这句
 *      声明写出之后才到达，它当场变成假话。
 */
function reportLoadError(msg, origin) {
  if (dropErr) dropErr.textContent = msg;
  const who = origin ? `：${origin}` : '';
  if (battleHasProgress()) {
    showSource(`载入失败 · 这份文件没进战场${who}\n${msg}`, true);
  } else {
    showSource(`载入失败 · 未播放任何数据${who}\n${msg}`, true);
  }
  showToast('载入失败 · 这份文件没进战场');
}

/**
 * 用一个解析结果开打。
 *
 * 只有 res.ok 才走到这里 —— 失败分支永远不调用它，
 * 于是"读不懂就播样本"这条路径在结构上就不存在。
 */
function playSource(res, closePanel = true) {
  /* 新的一路数据即将开播：先把上一轮的红条摘掉，免得"没在播"和"在播"并存 */
  clearLoadError();
  const bits = [`${res.meta.tools} 次工具调用`];
  if (res.rejected) bits.push(`拒收 ${res.rejected} 条`);
  if (res.badLines) bits.push(`坏行 ${res.badLines} 行`);
  if (res.unknownKinds && res.unknownKinds.length) {
    bits.push('未知 kind ' + res.unknownKinds.map(([k, n]) => `${k}×${n}`).join('/'));
  }
  showSource(`${res.label} · ${bits.join(' · ')}` + (res.meta.sessionId
    ? `\n会话 ${String(res.meta.sessionId).slice(-8)}` : ''));
  if (closePanel && startPanel) startPanel.classList.add('hidden');
  if (hud) hud.classList.add('on');
  startFrom(res);
}

/** 读一个 File 对象并开打 —— 拖入和"选择文件…"共用这一个函数 */
async function loadFile(file) {
  if (!file) return;
  let text;
  try {
    text = await file.text();
  } catch (err) {
    reportLoadError(`读不了这个文件：${err && err.message ? err.message : String(err)}`, file.name);
    return;
  }
  const origin = file.name || '(未命名)';
  const res = parseSourceText(text, `文件：${origin}`);
  if (!res.ok) {
    reportLoadError(res.message, origin);
    return;
  }
  playSource(res);
}

/**
 * 一条来自网络的原始事件（SSE 的 `data:` 载荷，或轮询拿到的一条 JSON）
 * → 协议事件。
 *
 * ===== 为什么单独抽出来 =====
 *
 * 这段以前内联在 EventSource 的 onmessage 里，于是它**只能在浏览器里测**。
 * 抽成纯函数之后，verify 可以在 Node 桩环境里把整条页面侧消费路径
 * （JSON 解析 → protocol.normalize → 校验）跑一遍 ——
 * 而不是靠在源码里 grep 有没有 `normalize(` 这三个字。
 *
 * 判定口径和文件源一致：坏事件**拒收并说明**，不"修一修"塞进战场。
 */
function ingestWire(data) {
  let ev;
  try {
    ev = JSON.parse(String(data));
  } catch {
    return { ok: false, message: '收到一条不是 JSON 的事件（已跳过，未计数）' };
  }
  const r = normalize(ev);
  if (!r.ok) {
    return {
      ok: false,
      message: `拒收一条事件（${r.errors.map((i) => i.code).join('/')}）`,
      errors: r.errors,
    };
  }
  return { ok: true, event: r.event, unknownKind: r.unknownKind };
}

/** 拖入：接受 .json / .jsonl / .ndjson，其他一律给可读错误（不尝试猜） */
function bindDrop() {
  if (!dropZone || !dropZone.addEventListener) return;

  const onDragOver = (e) => {
    if (e && typeof e.preventDefault === 'function') e.preventDefault();
    dropZone.classList.add('over');
  };
  const onDragLeave = () => dropZone.classList.remove('over');
  const onDrop = (e) => {
    if (e && typeof e.preventDefault === 'function') e.preventDefault();
    dropZone.classList.remove('over');
    const files = e && (e.dataTransfer ? e.dataTransfer.files : null);
    if (!files || !files.length) {
      reportLoadError('没有拿到文件。拖入一个文件，或点「选择文件…」。');
      return;
    }
    loadFile(files[0]);
  };
  dropZone.addEventListener('dragover', onDragOver);
  dropZone.addEventListener('dragleave', onDragLeave);
  dropZone.addEventListener('drop', onDrop);

  /*
   * 键盘等价路径：droZone 现在带 tabindex="0"（见 index.html），
   * 能被 Tab 到就必须能被激活 —— 否则焦点框只是个装饰，键盘用户
   * 到了这里依然什么都做不了。回车 / 空格 = 点「选择文件…」。
   */
  dropZone.addEventListener('keydown', (e) => {
    if (!e || (e.code !== 'Enter' && e.code !== 'Space')) return;
    if (typeof e.preventDefault === 'function') e.preventDefault();
    if (pickBtn && typeof pickBtn.click === 'function') pickBtn.click();
  });

  /*
   * 点选文件：必须有，因为有些环境（远程桌面 / 沙箱）拖放会被拦掉。
   * 两个入口读同一份代码路径，行为不会分叉。
   */
  if (pickBtn && pickBtn.addEventListener) {
    pickBtn.addEventListener('click', () => {
      if (filePick && typeof filePick.click === 'function') filePick.click();
    });
  }
  if (filePick && filePick.addEventListener) {
    filePick.addEventListener('change', () => {
      const f = filePick.files && filePick.files[0];
      loadFile(f);
    });
  }
}

let liveSource = null;
let liveSeen = 0;

/**
 * 收到一条实时事件。
 *
 * 它和文件事件走**同一个** feed()，所以诚实规则完全一样：
 * tool_end ok:true 才结算击杀，turn_end ok:true 才清场。
 */
function onLiveEvent(ev) {
  liveSeen++;
  if (liveSeen === 1) showSource(`HTTP 钩子 · ${sourceLabel}\n已收到事件，实时播放中`);
  feed(ev);
  if (ev.kind === KIND.TURN_END && director.turnDone) {
    showSource(`HTTP 钩子 · ${sourceLabel}\n本轮已收尾（turn_end ok:${ev.ok}）· 共 ${liveSeen} 条事件`);
  }
}

/**
 * 连上 HTTP 钩子。
 *
 * ===== 为什么默认走 SSE，失败才退回轮询 =====
 *
 * `GET /events` 是 text/event-stream，标准的 EventSource 就能用。
 * 但钩子（`tools/http-server.mjs`，本轮**不许改**）没有给
 * 事件流/轮询响应加 `access-control-allow-origin`：
 * 浏览器在**跨源**读取时会拦下响应体（GET 会被送去网络，
 * 但页面拿不到数据）。所以：
 *
 *   1. 同源打开（`npm run demo` 起的静态服务 + 钩子同端口不行，
 *      但可以把页面放在钩子后面反代）→ SSE 直接可用
 *   2. 跨源 → EventSource 会触发 error，这里**如实**显示原因，
 *      并提示"打开 devtools 看 CORS，或用同源方式"
 *
 * 不做的一件事：连不上就悄悄播样本数据。那等于骗人。
 */
function connectHook(url) {
  if (!hookState) return;
  const target = String(url || '').trim() || 'http://127.0.0.1:8787';
  let stream;
  try {
    stream = new URL(target);
  } catch {
    hookState.classList.remove('on');
    hookState.textContent = `地址不合法：${target}`;
    return;
  }
  /* 只连本机 —— 和钩子自身的"只绑 127.0.0.1"保持同一条边界 */
  if (stream.hostname !== '127.0.0.1' && stream.hostname !== 'localhost') {
    hookState.classList.remove('on');
    hookState.textContent = '只连本机（127.0.0.1 / localhost）：钩子刻意不绑外网地址。';
    return;
  }
  if (stream.pathname === '/' || stream.pathname === '') stream.pathname = '/events';

  if (typeof EventSource === 'undefined') {
    hookState.classList.remove('on');
    hookState.textContent = '这个环境没有 EventSource（通常是 Node 桩环境）。'
      + '浏览器里打开页面才有实时流。';
    return;
  }

  if (liveSource && typeof liveSource.close === 'function') liveSource.close();
  liveSeen = 0;
  sourceLabel = stream.toString();
  EVENTS = [];
  META = { label: sourceLabel, tools: 0, realDurSumMs: 0, realSpanMs: null,
    maxConcurrent: 0, playDurMs: 0, foldedMs: 0, sessionId: null };
  liveMode = true;
  hookState.classList.remove('on');
  hookState.textContent = `连接中… ${sourceLabel}`;

  /*
   * SSE 解析统一交给 protocol 侧的格式约束：每条只需一个 `data:` 行，
   * 内容是 JSON 事件。这里不猜别的字段。
   */
  liveSource = new EventSource(sourceLabel);
  liveSource.onopen = () => {
    hookState.classList.add('on');
    hookState.textContent = `已连接 ${sourceLabel}（SSE）· 事件到达即播放`;
    if (startPanel) startPanel.classList.add('hidden');
    if (hud) hud.classList.add('on');
    startFrom({ events: [], meta: META, label: sourceLabel, live: true });
  };
  liveSource.onmessage = (e) => {
    const r = ingestWire(e.data);
    if (!r.ok) {
      hookState.classList.remove('on');
      hookState.textContent = r.message;
      return;
    }
    onLiveEvent(r.event);
  };
  liveSource.onerror = () => {
    hookState.classList.remove('on');
    hookState.textContent =
      `连不上 ${sourceLabel}。\n`
      + '1) 先跑 npm run hook 起钩子（默认 8787）；\n'
      + '2) 若页面与钩子不同源，浏览器会拦掉跨源读取 —— '
      + '钩子本轮未开放 CORS 头，请把页面用同源方式打开（见 README「HTTP hook」）。\n'
      + '战场不会退回样本数据，连上才开始。';
    /*
     * ===== 这句以前是**无条件**写的，那是同一个老病 =====
     *
     * 原写法：`showSource('HTTP 钩子未连接 · 战场为空，未伪造任何进度', true)`。
     * 它是一句**全局状态声明**（"战场上什么都没有"），可写下它的这一行
     * 当时并不知道答案：
     *
     *   - 正在播样本 / 正在播你刚拖进来的文件时去连钩子 → 连接失败
     *     → 画面里敌人还在飞，状态条却写「战场为空」；
     *   - connectHook() **从不重置** director 的计数（连不上不该把
     *     观众正在看的那场战斗抹掉），onerror 原来也不调 clearLoadError()；
     *   - feed() 里的自愈（见 feed() 顶部 noteClaimsNothingPlayed 那段）只在**新事件到达**时才触发，
     *     而钩子恰恰一条都没到达 —— 于是这句假话不会自愈，可以长期挂着。
     *
     * 这和我们修过的「载入失败 · 未播放任何数据」是同一类 bug：
     * 界面写出了与实际状态矛盾的全局否定。所以判据也用同一个数据依据
     * battleHasProgress()（director 的真实计数），而不是某个开关。
     *
     * 两句的分工：
     *   有进度 → 只描述"钩子这条路"的失败，并如实说画面还在播上一份数据；
     *            不写"战场为空"，也不写"未播放任何数据"。
     *   没进度 → 才允许说「战场为空」。
     * 「未伪造任何进度」两句都保留：它断言的是"没有凭空造进度"，
     * 而画面上那些敌人来自**上一份真实数据**，不是伪造的 —— 这句话在
     * 两种状态下都为真，被删掉的只有那句会变假的全局否定。
     */
    if (battleHasProgress()) {
      showSource('HTTP 钩子未连接 · 当前画面仍在播上一份数据，未伪造任何进度', true);
    } else {
      showSource('HTTP 钩子未连接 · 战场为空，未伪造任何进度', true);
    }
  };
}

/**
 * npm run demo 把页面和钩子收成同源。
 * 输入框的出厂值是钩子自己的 8787；页面若从本机 http 打开，改成当前来源，
 * 避免浏览器跨源拦掉 SSE。file:// 或非本机来源保持原值。
 */
function applyHookDefault() {
  if (!hookInput || typeof location === 'undefined' || !location.protocol) return;
  const stock = 'http://127.0.0.1:8787';
  const current = String(hookInput.value || '').replace(/\/$/, '');
  if (current !== stock) return;
  if (location.protocol !== 'http:' && location.protocol !== 'https:') return;
  if (location.hostname !== '127.0.0.1' && location.hostname !== 'localhost') return;
  if (!location.origin || location.origin === 'null') return;
  hookInput.value = location.origin;
}

function bindHook() {
  if (!hookBtn || !hookBtn.addEventListener) return;
  hookBtn.addEventListener('click', () => {
    connectHook(hookInput ? hookInput.value : 'http://127.0.0.1:8787');
  });
}

/** 一键演示：不传数据，直接播仓库自带的真实样本战斗 */
function startSampleDemo() {
  /* 样本也是一个"新的播放入口"：先摘掉上一轮的失败红条，再开始播 */
  clearLoadError();
  if (startPanel) startPanel.classList.add('hidden');
  if (hud) hud.classList.add('on');
  /*
   * ===== 「进入战场」必须真的播样本，而不是"标签写样本" =====
   *
   * 这里原来只改 liveMode 和 sourceLabel，**没有把 EVENTS/META 换回样本**。
   * 于是只要之前经历过"钩子连接"（EVENTS 被清成 []、liveMode=true）
   * 或"拖入过别的文件"，这条入口就会：
   *   - 状态条理直气壮地写「样本：仓库自带真实会话 · 292 次工具调用」，
   *   - 而屏幕上要么一场空（实时模式 + 空事件表，时间轴不动），
   *   - 要么播的其实是上一份文件。
   *
   * 两种都是界面说假话 —— 和"未播放任何数据"那一类是同一个病。
   * 所以这里把事件源显式换成仓库自带的真实样本：标签和内容
   * 来自**同一个**来源，不可能对不上。
   */
  EVENTS = SAMPLE_EVENTS;
  META = SAMPLE_META;
  liveMode = false;
  sourceLabel = '样本：仓库自带真实会话';
  showSource('样本：仓库自带真实会话（real-events.json）· 292 次工具调用');
  startDemo();
}

/* ---------------- 启动 ---------------- */

function boot() {
  applyPanelCopy();
  applyHookDefault();
  renderer.resize();
  // 先摆一个空的战场
  renderer.draw({
    now: performance.now(),
    director,
    aegis,
    shake: 0,
  });
  updateHud(performance.now(), 0);

  window.addEventListener('resize', () => {
    renderer.resize();
  });

  if (startBtn) {
    startBtn.addEventListener('click', () => {
      startSampleDemo();
    });
  }

  bindDrop();
  bindHook();

  requestAnimationFrame(frame);
}

/*
 * 键盘：空格开始 / P 暂停 / R 重播
 * 指针锁定会吞掉鼠标点击，所以开始按钮之外必须有键盘入口。
 */
window.addEventListener('keydown', (e) => {
  if (e.code === 'Space') {
    e.preventDefault();
    if (startPanel && !startPanel.classList.contains('hidden')) {
      startPanel.classList.add('hidden');
      startDemo();
      if (hud) hud.classList.add('on');
    } else {
      setPaused(!paused);
      showToast(paused ? COPY.toast.paused : COPY.toast.resumed);
    }
  }
  if (e.code === 'KeyP') {
    setPaused(!paused);
    showToast(paused ? COPY.toast.paused : COPY.toast.resumed);
  }
  /*
   * I：切换检视态。
   * 和 S/F/N 一样是独立开关，不打包进"降低特效"。
   */
  if (e.code === 'KeyI') {
    inspectManual = !inspectManual;
    syncInspect();
    showToast(inspectManual ? COPY.toast.inspectOn : COPY.toast.inspectOff);
  }
  if (e.code === 'KeyR') {
    startDemo();
    if (hud) hud.classList.add('on');
    showToast(COPY.toast.replay);
  }

  /*
   * 特效开关快捷键。
   *
   * 选 F / S / N 是因为它们不和现有键冲突（空格/P/R），
   * 而且字母本身好记：Flash / Shake / Numbers。
   * 每次切换都弹 toast 明确告知状态 —— 静默切换会让人
   * 以为是 bug（"怎么突然不抖了"）。
   */
  if (e.code === 'KeyF') {
    FX.flash = !FX.flash;
    showToast(FX.flash ? '受击闪烁：开' : '受击闪烁：关');
  }
  if (e.code === 'KeyS') {
    FX.shake = !FX.shake;
    if (!FX.shake) shake = 0;
    showToast(FX.shake ? '震屏：开' : '震屏：关');
  }
  if (e.code === 'KeyN') {
    FX.numbers = !FX.numbers;
    showToast(FX.numbers ? '飘字：开' : '飘字：关');
  }
});

/* ---------------- 调试口 ---------------- */

window.__shield = {
  /** 喂事件 */
  emit: (ev) => feed(ev),
  /** 状态快照 */
  /*
   * 用 clockNow() 而不是 performance.now()：
   * 暂停时必须和 HUD 显示同一个数，否则"暂停看明细"会自相矛盾。
   */
  stats: () => director.stats(clockNow()),
  /*
   * 渲染器的只读探针。
   *
   * 为什么需要：某些行为**只有渲染层才知道**，从 director/stats 看不出来。
   * 最典型的就是杖顶位置 —— 它依赖 sprite 是否被水平镜像，
   * 而镜像决定权在 render._drawPotato 手里。
   *
   * 没有这个口子，验证只能靠"多跑几帧碰运气看有没有出现朝右的帧"，
   * 实测朝右只出现 1 帧，等于半个断言没跑。
   * 有了它，就能构造确定的朝左/朝右状态直接比对。
   */
  __renderProbe: () => ({
    tip: renderer._tip ? { x: renderer._tip.x, y: renderer._tip.y } : null,
    sprites: Object.keys(renderer.sprites || {}),
  }),
  /** 直接驱动一帧渲染，传入受控状态（测试用，不改变真实循环） */
  __drawOnce: (state) => renderer.draw(state),
  /** 敌人列表（只读快照，避免外部改内部对象） */
  enemies: () => director.enemies.map((e) => ({
    id: e.id,
    /*
     * callId 必须暴露出来。
     *
     * 修复 callId 匹配那个 bug 之后，tool_end 要靠 callId 精确命中；
     * 而 id 是画面上的递增序号（number），跟事件里的 id（string）
     * 是两套东西。外部脚本如果拿 id 去 emit，会打不中目标
     * —— 这个坑 _refs.mjs 已经踩过一次（报"处决前血条 null"）。
     */
    callId: e.callId,
    tool: e.tool,
    /*
     * 名字标签。
     *
     * 浏览器实测时发现快照里没有这个字段：外部脚本想验证
     * "小兵身上有名字"，只能去 hook canvas 的 fillText 才知道，
     * 而 _refs.mjs 那种 Node 环境根本没有 canvas 文字可 hook。
     *
     * 调试口要能自证，不能逼验证方去猜。
     */
    label: e.label,
    kindLabel: e.kindLabel,
    tier: e.tier,
    tierName: e.tierName,
    mapped: e.mapped,
    x: +e.x.toFixed(2),
    y: +e.y.toFixed(2),
    hp: +e.hpRatio(clockNow()).toFixed(3),
    hits: e.hitsTaken,
    age: +e.ageSec(clockNow()).toFixed(2),
    dead: e.diedAt !== null,
    /*
     * 死亡时刻与死亡瞬间血条。
     *
     * 原来快照里没有这两个字段，于是"死亡展示期到底多长"、
     * "死的时候血条多少"从外部根本观察不到 —— _refs.mjs 想验
     * 用户要的"瞬杀也留一秒"，拿到的是 undefined，
     * 算出来的时间戳是 NaN，帧时间全变成 NaN，测出一堆假失败。
     *
     * 调试口要能观察真实状态，否则验证只能靠猜。
     */
    diedAt: e.diedAt,
    hpAtDeath: e.hpAtDeath,
    deathT: +e.deathT.toFixed(3),
    /*
     * 出生显形进度。
     *
     * 同样是"调试口要能自证"：浏览器实测时脚本想看 spawnT，
     * 拿到的全是 undefined —— 因为这个快照没带上它。
     * 抓不到就开始怀疑是功能坏了，实际只是没暴露。
     */
    spawnT: e.spawnT === undefined ? null : +e.spawnT.toFixed(3),
    /*
     * 出生显形进度。
     *
     * 同样是"调试口要能自证"：浏览器实测时脚本想看 spawnT，
     * 拿到的全是 undefined —— 因为这个快照没带上它。
     * 抓不到就开始怀疑是功能坏了，实际只是没暴露。
     */

    killed: e.killed,
    failed: e.failed,
    overdue: e.isOverdue(clockNow()),
  })),
  /** 事件日志 */
  log: () => director.log.map((l) => ({ ...l })),
  /** 植保盾牌 */
  aegis: () => ({
    x: +aegis.x.toFixed(2),
    y: +aegis.y.toFixed(2),
    vx: +aegis.vx.toFixed(2),
    vy: +aegis.vy.toFixed(2),
    speed: +Math.hypot(aegis.vx, aegis.vy).toFixed(2),
    moving: aegis.moving,
    fleeing: aegis.fleeing,
    swing: aegis.swing,
  }),
  /** 盾牌与最近敌人的距离（验证"边逃边打"用） */
  nearestDist: () => {
    const t = director.target(clockNow(), aegis.x, aegis.y);
    if (!t) return null;
    return +Math.hypot(t.x - aegis.x, t.y - aegis.y).toFixed(2);
  },
  /** 竞技场 */
  arena: () => ({ ...ARENA }),
  /** 战斗常数 */
  combat: () => ({ ...COMBAT }),
  fps: () => fps,
  /** 开始 / 暂停 / 重播 */
  start: () => { startSampleDemo(); },
  pause: () => { setPaused(!paused); return paused; },
  /*
   * 暂停态的**只读**探针。
   *
   * pause() 是开关，调一次就翻转，断言拿它当"读"用会把状态搞乱。
   * 验收需要在一个确定的暂停态上观察状态条文案，所以单独给一个 getter。
   */
  isPaused: () => paused,
  restart: () => { startDemo(); if (hud) hud.classList.add('on'); },
  /*
   * ===== 事件源探针（验证用）=====
   *
   * 这三个口子存在的理由，是让 verify / 浏览器验收能回答
   * "拖进来的文件真的进了战场吗"，而不是只看源码里有没有某个函数名。
   *
   * loadText 走的是**和拖入完全相同**的 parseSourceText，
   * 所以它测到的就是拖入的真实行为，不是另一条平行实现。
   */
  source: () => ({
    label: sourceLabel,
    live: liveMode,
    events: EVENTS.length,
    meta: { ...META },
  }),
  /** 用文本模拟一次拖入；返回解析结果（失败时 ok:false，且不改变战场） */
  loadText: (text, name = 'drag.json') => {
    const res = parseSourceText(text, `文件：${name}`);
    if (!res.ok) {
      reportLoadError(res.message, name);
      return { ok: false, message: res.message, events: EVENTS.length,
        source: sourceLabel };
    }
    playSource(res);
    return { ok: true, label: res.label, events: res.events.length,
      meta: res.meta };
  },
  /** 播放仓库自带样本（= 一键演示，不传任何数据） */
  playSample: () => { startSampleDemo(); return { events: EVENTS.length, label: sourceLabel }; },
  /** 钩子连接（验证里只用来检查参数校验分支，不会真的联网） */
  connectHook: (url) => { connectHook(url); return hookState ? hookState.textContent : ''; },
  /**
   * 页面侧事件消费路径（SSE `data:` 载荷 → protocol 校验）。
   *
   * 暴露它是因为"页面能收实时事件"这件事必须在 Node 里可测：
   * 只 grep 源码证不了 normalize 真的会被调用、也证不了坏事件会被拒。
   */
  ingest: (data) => {
    const r = ingestWire(data);
    if (r.ok) onLiveEvent(r.event);
    return r;
  },
  /** 清单文件数（验证渲染确实烘了 sprite） */
  spriteCount: () => Object.keys(renderer.sprites || {}).length,
  /**
   * 当前在场的雷电链（调试 / 验证用）。
   *
   * 暴露它是为了让验证能回答雷电真的连到多个目标了吗，
   * 而不只是某个函数被调用了。返回浅拷贝，避免外部改到内部状态。
   */
  lightning: () => director.lightning.map((l) => ({
    bornAt: l.bornAt,
    /*
     * 处决标记必须暴露出来。
     *
     * 浏览器实测发现快照把 exec / execWeight 剥掉了，
     * 外部只能靠"存活 420ms 而不是 180ms"去反推这是不是处决雷 ——
     * 那是猜，不是观察。
     *
     * 调试口的原则：内部有什么可观察的事实，对外就该看得见。
     * 否则"处决特效真的发生了吗"这个问题只能靠人眼看截图。
     */
    exec: l.exec === true,
    execWeight: l.execWeight ?? null,
    from: { x: +l.fromX.toFixed(2), y: +l.fromY.toFixed(2) },
    bolts: l.bolts.map((b) => ({
      x: +b.x.toFixed(2), y: +b.y.toFixed(2), strength: b.strength,
      exec: b.exec === true,
    })),
  })),
};

boot();
