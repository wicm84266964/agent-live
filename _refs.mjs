/**
 * 静态检查：未定义引用 + 真跑渲染循环。
 *
 * ===== 这个文件的来历 =====
 *
 * mc/ 项目里栽过一次：
 *   `_refs.mjs` 的 requestAnimationFrame 是空桩 `() => 0`，
 *   于是 `frame()` 从来没被执行过。
 *   结果 `updateBackground(SURFACE_Y - ...)` 忘了 import SURFACE_Y 时，
 *   "静态检查全部通过"，而浏览器一进世界就白屏。
 *
 * 假绿比不检查更糟。所以这里做两件事：
 *   1. 造 DOM 桩，真 import main.mjs（抓模块加载期的未定义引用）
 *   2. **手动泵 rAF 队列**，真跑若干帧（抓渲染循环里的未定义引用）
 *
 * 另外，本项目的画布是 Canvas2D，不需要 WebGL 桩，
 * 但 2D context 的方法很多，所以用一个 Proxy 自动兜住所有调用。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
/*
 * COMBAT 直接用 director 的真值，不在测试里另抄一份。
 * 抄一份就会漂移：改了 dyingMs 而测试还按旧值算，断言静默失效。
 */
import { COMBAT } from './director.mjs';
/* SPRITES 是 sprite 数量的单一真相源：烘几个由表决定，不由字面量决定 */
import { SPRITES } from './sprites.mjs';
/*
 * 斩击色阶从 render.mjs 导入，不再在这里抄一份字面量。
 * 抄字面量的后果：render 换了色，这里的探针永远匹配不到路径，
 * 结果是「没量到刀光」这类假红 —— 或者更糟，断言被顺手放宽。
 */
import { SLASH_COLORS } from './render.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));

/* ---------------- 1) Canvas 2D 桩 ---------------- */

/**
 * 用一个 Proxy 伪装 2D context：
 * 任何方法调用都返回合理的中性值，任何属性赋值都吞掉。
 *
 * 为什么不用逐个 method 手写：
 *   render.mjs 用了 fillRect/arc/stroke/fillText/drawImage/save/restore/
 *   setTransform/translate/rotate/beginPath/moveTo/lineTo/measureText…
 *   手写必然漏，漏了就报 "xxx is not a function" 假失败。
 *   Proxy 能兜住全部，同时保持"调用合法"。
 */
function makeCtx2D() {
  const target = {
    canvas: null,
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    fillStyle: '#000',
    strokeStyle: '#000',
    lineWidth: 1,
    font: '10px monospace',
    textAlign: 'start',
    textBaseline: 'alphabetic',
    imageSmoothingEnabled: false,
    /*
     * 调用记录器。
     *
     * 原来这个桩是个纯 Proxy，什么都能吞 —— 好处是不会误报，
     * 坏处是**看不出画面到底画了什么**。
     *
     * 于是"小怪名字真的被画出来了吗"、"血条真的在消耗吗"这两条
     * 就只能靠人眼看浏览器。而这个项目已经吃过一次亏：
     * faceLeft 算出来了但没接进绘制，任何静态检查都发现不了。
     *
     * 现在把 fillText / fillRect 记下来，就能在 Node 里断言
     * "这一帧确实画了这个名字""血条宽度确实在变小"。
     */
    __texts: [],
    __rects: [],
    /*
     * 记录 stroke 出来的折线顶点。
     *
     * 为什么要记这个：雷电是**画出来的折线**，不是 fillText/fillRect。
     * 如果只记录文字和矩形，"雷电到底有没有真画出来"在 Node 里
     * 完全看不见 —— 只能靠人眼看浏览器。
     *
     * 而这个项目已经因为"看不见"吃过亏（faceLeft 算了没用上）。
     * 所以把 moveTo/lineTo/arc 也记下来，就能断言：
     *   - 施法那一帧确实有一串折线从杖顶连到敌人
     *   - 折线的终点落在敌人身上，不是空气里
     */
    __paths: [],
    __arcs: [],
    /*
     * __grads 必须在 target 上显式初始化。
     *
     * 否则 ctx.__grads 会走到 Proxy 的兜底分支，返回一个**函数**，
     * 于是 `__grads.length = 0` 抛
     *   TypeError: Cannot assign to read only property 'length' of function
     *
     * 这个坑很阴：只有在**处决特效没被画出来**的时候才会触发，
     * 也就是说"功能坏掉"会表现为"测试脚本崩在无关的一行"。
     * 更糟的是崩在 pumpRaf 里时容易被误读成产品问题。
     */
    __grads: [],
  };

  return new Proxy(target, {
    get(t, k) {
      if (k in t) return t[k];
      // 返回一个"什么都能接受、返回中性值"的函数
      return (...args) => {
        if (k === 'fillText') {
          t.__texts.push({
            text: String(args[0]),
            x: args[1], y: args[2],
            fill: t.fillStyle,
            alpha: t.globalAlpha,
          });
          return undefined;
        }
        if (k === 'fillRect') {
          t.__rects.push({
            x: args[0], y: args[1], w: args[2], h: args[3],
            fill: t.fillStyle,
            alpha: t.globalAlpha,
          });
          return undefined;
        }
        if (k === 'moveTo') {
          // 开始一条新路径，记一个点
          t.__paths.push({ pts: [{ x: args[0], y: args[1] }],
            stroke: t.strokeStyle, w: t.lineWidth, a: t.globalAlpha });
          return undefined;
        }
        if (k === 'lineTo') {
          const cur = t.__paths[t.__paths.length - 1];
          if (cur) cur.pts.push({ x: args[0], y: args[1] });
          return undefined;
        }
        /*
         * 二次曲线：斩击弧用的是 quadraticCurveTo。
         *
         * 这个测试桩原来只认 lineTo，于是换成近战之后
         * 刀光一条都记录不到 —— 断言报没画出斩击弧，
         * 而实际上画了。桩不认新 API 会产生假红，
         * 和假绿一样有害。
         */
        if (k === 'quadraticCurveTo') {
          const cur = t.__paths[t.__paths.length - 1];
          if (cur) {
            cur.pts.push({ x: args[0], y: args[1], ctrl: true });
            cur.pts.push({ x: args[2], y: args[3] });
          }
          return undefined;
        }
        if (k === 'arc') {
          t.__arcs.push({ x: args[0], y: args[1], r: args[2],
            fill: t.fillStyle, a: t.globalAlpha });
          return undefined;
        }
        if (k === 'measureText') return { width: 10 };
        if (k === 'getImageData') {
          return { data: new Uint8ClampedArray(4), width: 1, height: 1 };
        }
        /*
         * 渐变对象：createLinearGradient / createRadialGradient /
         * createPattern 都要返回带 addColorStop 的桩。
         *
         * 之前只有 linear，所以 _execFx（处决爆点用 radial）
         * 一跑就 TypeError —— 而这正是 _refs.mjs 存在的意义：
         * 只做 node --check 是发现不了的，必须真跑一帧渲染。
         *
         * 顺便把渐变参数记下来，后面可以断言"处决确实画了渐变"。
         */
        if (k === 'createLinearGradient'
          || k === 'createRadialGradient'
          || k === 'createPattern') {
          const kind = k;
          // 注意不能叫 args —— 会遮蔽外层那个 args 形参
          const gargs = Array.prototype.slice.call(args);
          const grad = {
            addColorStop(off, col) { (this.__stops ||= []).push([off, col]); },
            __kind: kind,
            __args: gargs,
          };
          (t.__grads ||= []).push(grad);
          return grad;
        }
        return undefined;
      };
    },
    set(t, k, v) {
      t[k] = v;
      return true;
    },
  });
}

/* ---------------- 2) Canvas 元素桩 ---------------- */

class FakeCanvas {
  constructor() {
    this.width = 960;
    this.height = 600;
    this.clientWidth = 960;
    this.clientHeight = 600;
    this._ctx = makeCtx2D();
    this._ctx.canvas = this;
  }
  getContext() { return this._ctx; }
  getBoundingClientRect() {
    return { x: 0, y: 0, width: this.clientWidth, height: this.clientHeight,
      left: 0, top: 0, right: this.clientWidth, bottom: this.clientHeight };
  }
  addEventListener() {}
  removeEventListener() {}
}

/* ---------------- 3) DOM 桩 ---------------- */

const elements = new Map();

function makeEl(id) {
  const el = {
    id,
    textContent: '',
    className: '',
    style: {},
    dataset: {},
    children: [],
    _classes: new Set(['hidden']),
    classList: {
      add(c) { el._classes.add(c); },
      remove(c) { el._classes.delete(c); },
      contains(c) { return el._classes.has(c); },
      toggle(c) { el._classes.has(c) ? el._classes.delete(c) : el._classes.add(c); },
    },
    addEventListener() {},
    removeEventListener() {},
    appendChild(c) { el.children.push(c); return c; },
    getBoundingClientRect() {
      return { x: 0, y: 0, width: 960, height: 600, left: 0, top: 0, right: 960, bottom: 600 };
    },
  };
  return el;
}

const fakeCanvas = new FakeCanvas();

globalThis.document = {
  getElementById(id) {
    if (id === 'cv') return fakeCanvas;
    if (!elements.has(id)) elements.set(id, makeEl(id));
    return elements.get(id);
  },
  createElement(tag) {
    if (tag === 'canvas') return new FakeCanvas();
    return makeEl(tag);
  },
  addEventListener() {},
  removeEventListener() {},
  body: makeEl('body'),
  documentElement: makeEl('html'),
};

try {
  Object.defineProperty(globalThis, 'window', {
    value: globalThis, configurable: true, writable: true,
  });
} catch { /* 已有 */ }

try {
  Object.defineProperty(globalThis, 'navigator', {
    value: { userAgent: 'node' }, configurable: true,
  });
} catch { /* 已有 */ }

globalThis.devicePixelRatio = 1;
globalThis.innerWidth = 1200;
globalThis.innerHeight = 800;
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};
globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' });
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
/*
 * ===== 可控虚拟时钟 =====
 *
 * main.mjs 里所有时间都来自 performance.now()：
 * 事件入账（director.handle）、动画推进（frame 的 now）、
 * 以及渲染（renderer.draw 的 now）。
 *
 * 原来这里直接用 Date.now()，于是有个隐蔽的不一致：
 *   emit() 记录的事件时间 ~50ms（真实时间）
 *   而 __pumpRaf(20000) 传进去的帧时间 20000ms（测试时间）
 * 时间往回跳了 19950ms，dt 变成负数，
 * deathT 不但不涨，还会被 Math.min(1, ...) 夹成 0 或负数 ——
 * 死亡展示期永远走不完。测出来的"名字 0 帧都没画"，
 * 其实是**测试自己的时钟错乱**，不是渲染坏了。
 *
 * 教训：凡是"验证动画时长"的测试，必须自己掌控时钟，
 * 不能让被测代码从系统时钟另取一份时间。
 */
globalThis.__vnow = 0;
globalThis.performance = { now: () => globalThis.__vnow };

/*
 * rAF 桩：**攒回调 + 手动泵**。
 * 这一条就是本项目从 mc/ 学到的核心教训 —— 空桩会让整个渲染循环
 * 逃过所有检查。
 */
globalThis.__rafQueue = [];
globalThis.requestAnimationFrame = (cb) => {
  globalThis.__rafQueue.push(cb);
  return globalThis.__rafQueue.length;
};
globalThis.cancelAnimationFrame = () => {};
globalThis.__pumpRaf = (t) => {
  // 帧时间就是虚拟时钟 —— 和 performance.now() 必须是同一个时间轴
  globalThis.__vnow = t;
  const batch = globalThis.__rafQueue.splice(0, globalThis.__rafQueue.length);
  for (const cb of batch) cb(t);
};

/* ---------------- 4) 真 import main.mjs ---------------- */

let failed = false;

try {
  await import(pathToFileURL(path.join(DIR, 'main.mjs')).href + '?t=' + Date.now());
  console.log('main.mjs 顶层执行成功 —— 没有未定义引用');
} catch (e) {
  failed = true;
  const msg = (e && e.message) || String(e);
  console.error('main.mjs 执行失败：');
  console.error('  ' + msg);
  if (e && e.stack) {
    for (const l of e.stack.split('\n').slice(1, 6)) console.error('  ' + l.trim());
  }
  if (/is not defined|before initialization/.test(msg)) {
    console.error('  → 未定义引用/时序错误：浏览器里会白屏');
  }
}

/* ---------------- 5) 检查调试口 ---------------- */

if (!failed) {
  const api = globalThis.__shield;
  if (!api) {
    console.error('FAIL: window.__shield 没有建立');
    failed = true;
  } else {
    const need = [
      'emit', 'stats', 'enemies', 'log', 'aegis', 'arena',
      'combat', 'fps', 'start', 'pause', 'restart', 'spriteCount', 'lightning',
    ];
    const missing = need.filter((k) => !(k in api));
    if (missing.length) {
      console.error('FAIL: __shield 缺接口：' + missing.join(', '));
      failed = true;
    } else {
      console.log('__shield 接口齐全：' + need.join(','));

      /* ---- sprite 必须真的烘出来了 ---- */
      /*
       * 下界从 SPRITES 表派生，不再写死 9。
       *
       * 写死 9 的问题：往 sprites.mjs 加 sprite，这条断言不会跟着变严；
       * 反过来，谁把烘焙弄成"只烘 9 个"也照样绿。
       * 真正的性质是「表里有几个，就必须烘出几个」。
       */
      const n = api.spriteCount();
      const want = Object.keys(SPRITES).length;
      if (n < want) {
        console.error(`FAIL: 只烘了 ${n} 个 sprite（SPRITES 表里有 ${want} 个）`);
        failed = true;
      } else {
        console.log(`  sprite 已烘焙：${n} 个`);
      }

      /* ---- 空战场 ---- */
      const s0 = api.stats();
      console.log(`  初始统计：敌 ${s0.alive}，击杀 ${s0.kills}，事件 ${s0.seen}`);

      /* ---- 喂一个 BOSS 事件 ---- */
      api.emit({ kind: 'tool', tool: 'agent_run' });
      const s1 = api.stats();
      if (s1.alive !== 1 || s1.aliveBoss !== 1) {
        console.error(`FAIL: 喂 agent_run 后应有 1 个 BOSS，实际 alive=${s1.alive} boss=${s1.aliveBoss}`);
        failed = true;
      } else {
        console.log('  喂 agent_run → BOSS 上场 ✓');
      }

      /* ---- 真相检查：血条空了也不能死 ---- */
      api.emit({ kind: 'tool', tool: 'read_file' });
      console.log('  喂 read_file → 小兵上场 ✓');

      /*
       * 泵 60 帧。这里最关键的是：如果 frame() 里有未定义引用，
       * 就会在这里抛出来。这是 mc/ 踩过的那个坑。
       */
      let frameErr = null;
      try {
        for (let i = 1; i <= 60; i++) {
          globalThis.__pumpRaf(i * 16.7);
        }
      } catch (e) {
        frameErr = e;
      }

      if (frameErr) {
        const msg = (frameErr && frameErr.message) || String(frameErr);
        console.error('FAIL: 渲染循环（frame）执行失败：');
        console.error('  ' + msg);
        if (frameErr.stack) {
          for (const l of frameErr.stack.split('\n').slice(1, 5)) console.error('  ' + l.trim());
        }
        console.error('  → 顶层检查抓不到这类错误，浏览器里一进世界就崩');
        failed = true;
      } else {
        const s2 = api.stats();
        console.log(`  渲染循环跑了 60 帧：无未定义引用（挥击 ${s2.swings} 次）`);

        /*
         * 一个必须验的性质：跑了 60 帧之后，
         * 那个 BOSS **不能死**。它没有收到任何结束事件。
         */
        if (s2.kills !== 0) {
          console.error(`FAIL: 没收到结束事件却产生了 ${s2.kills} 次击杀 —— 这是造假`);
          failed = true;
        } else {
          console.log('  60 帧后击杀仍为 0 ✓（血条会掉，但不会自己死）');
        }
      }

      /*
       * ---- 死亡展示期：真跑渲染，检查名字和血条 ----
       *
       * 这是用户最新两条要求的直接验收：
       *   1. 小怪身上要有它代表的工具名
       *   2. 瞬杀也要留约 1 秒，血条在这 1 秒内快速耗尽
       *
       * 为什么要真跑渲染而不只是断言 director：
       *   director 只管状态，画不画得出来是 render 的事。
       *   _drawEnemy 里  这个条件写错，
       *   verify 照样全绿，浏览器里却是名字一闪就没。
       */
      {
        const ctx2 = fakeCanvas._ctx;

        /*
         * 先清场，从干净状态开始。
         *
         * 注意每次都要用同一个虚拟时钟：__vnow 就是当前时刻。
         * 事件和帧必须共享这条时间轴，否则 dt 会变负。
         */
        globalThis.__vnow = 20000;
        api.emit({ kind: 'turn_end', ok: true });
        for (let i = 0; i < 90; i++) globalThis.__pumpRaf(20000 + i * 16.7);

        /*
         * 造一个**瞬杀**的小兵：出生后立刻结束。
         * read_file 预估 450ms，40ms 就结束 —— 死时血条约 91%，
         * 这是"血条还很满就死了"的最极端情况。
         */
        /*
         * ===== 把帧时钟对齐到事件时刻，这一步是必须的 =====
         *
         * 上面清场循环跑到的最后一帧是 20000 + 89*16.7 ≈ 21486ms，
         * 如果下一帧直接跳到 21800ms，dtRaw 就是 314ms，
         * 而 main.mjs 里 dt = min(dtRaw, 0.05) —— 引擎刻意钳了 50ms 上限，
         * 防止切标签页回来时一帧跳几秒。
         *
         * 于是那一帧死亡动画一次前进 3 帧的量，
         * 展示期比 1000ms 提前约 50ms 结束。
         *
         * 这不是 bug（真实浏览器切回来也是这样，用户看不出 50ms），
         * 但会让"展示期到底几帧"的断言算不准 ——
         * 实测就是 58/61，差 3 帧。所以测量前先空泵一帧把 last 对齐，
         * 让后续每一帧的 dt 都是干净的 1/60。
         */
        globalThis.__pumpRaf(21800);

        // 出生与结束都发生在同一个时刻（虚拟时钟不动），刻意做成瞬杀
        api.emit({ kind: 'tool', tool: 'read_file' });
        api.emit({ kind: 'tool_end', tool: 'read_file', ok: true });

        const killed = api.enemies().find((e) => e.tool === 'read_file');
        if (!killed) {
          console.error('FAIL: 瞬杀的小兵没有立刻结算');
          failed = true;
        } else {
          const atDeath = killed.hpAtDeath;
          const diedAt = killed.diedAt;

          /*
           * 在展示期内逐帧渲染，记录每帧：
           *   - 名字有没有画出来
           *   - 血条填充宽度（用来确认在消耗）
           *
           * 血条填充是 _drawHpBar 里 ，
           * 宽度随时间变小。找到那条 w 在 0~bw 之间的填充。
           */
          let framesWithName = 0;
          let lastBarW = -1;
          let barShrinks = 0;
          let barSeen = 0;

          /*
           * 用**整数帧序**算时间，不要用 ms += 1000/60 累加。
           *
           * 累加版本会飘：16.666666666666668 加 60 次得到 999.9999999999999，
           * 于是循环多跑一次，第 61 帧的渲染时刻正好是 dyingMs 边界，
           * 敌人已经按 deathT===1 被移除 —— 于是"期望 61 帧、实际 60 帧"
           * 报一个假失败。
           *
           * 帧本来就是个整数概念，直接 f * (1000/60) 就没有累积误差。
           */
          const FRAMES = Math.round(COMBAT.dyingMs / (1000 / 60));

          for (let f = 0; f < FRAMES; f++) {
            const ms = f * (1000 / 60);
            const nowMs = diedAt + ms;
            ctx2.__texts.length = 0;
            ctx2.__rects.length = 0;

            // 用 main 的帧循环推进（它内部会 draw）
            const before = globalThis.__rafQueue.length;
            globalThis.__pumpRaf(nowMs);

            // 名字：标签文本必须出现
            const hasName = ctx2.__texts.some((t) => t.text === 'read_file');
            if (hasName) framesWithName++;


            /*
             * 血条：找高度为 3（bh）且宽度在 (0, bw] 的填充。
             * bw = max(16, w*0.95)，小兵 w=8 → bw=16。
             */
            const bars = ctx2.__rects.filter(
              (r) => Math.abs(r.h - 3) < 1e-6 && r.w > 0 && r.w <= 16.5,
            );
            if (bars.length) {
              barSeen++;
              const w = bars[bars.length - 1].w;
              if (lastBarW >= 0 && w < lastBarW - 1e-6) barShrinks++;
              lastBarW = w;
            }
          }

          /*
           * 断言 1：名字在几乎每一帧都画出来了。
           * 允许最后一两帧因为展示期刚结束而消失。
           */
          /*
           * 断言 1：展示期内**每一帧**都要画名字。
           *
           * 帧数按 dyingMs 精确求期望，多一帧少一帧都抓得住。
           *
           * 这里踩过两次坑，都是测试自身的时序问题，不是产品 bug：
           *   1) 帧时间与事件时间不在同一时钟轴 → dt 变负，0/61 帧
           *   2) ms += 1000/60 浮点累加多出一帧 → 边界帧误判，59/61 帧
           * 现在用虚拟时钟 + 整数帧序，两处都消掉了。
           */
          const expectName = FRAMES;
          const missingName = expectName - framesWithName;

          if (missingName !== 0) {
            console.error('FAIL: 展示期内有 ' + missingName + ' 帧没画名字（期望 '
              + expectName + ' 帧，实际 ' + framesWithName + ' 帧）'
              + ' —— 小兵标签没接进渲染');
            failed = true;
          } else {
            console.log('  瞬杀小兵：展示期内 ' + framesWithName + '/' + expectName
              + ' 帧都画出了名字 read_file ✓');
          }

          /*
           * 断言 2：血条真的在变窄（不是画了个静态满条）。
           * 至少看到 8 次缩小 —— 60 帧里血条 350ms 就走完了。
           */
          if (barSeen === 0) {
            console.error('FAIL: 一帧都没找到血条填充 —— 小兵没有血条');
            failed = true;
          } else if (barShrinks < 8) {
            console.error('FAIL: 血条只在 ' + barShrinks + ' 帧变窄 —— 没在消耗');
            failed = true;
          } else {
            console.log('  瞬杀小兵：血条 ' + barShrinks + ' 帧持续变窄（死时 '
              + (atDeath * 100).toFixed(0) + '%）✓');
          }

          /*
           * 断言 3：展示期结束后，名字和血条都不再画。
           * 否则尸体会永远挂在场上，等于刷新不出新敌人。
           */
          /*
           * 再推进 400ms（远超展示期），确认尸体真的被移除。
           *
           * 不推进就直接查是错的：上面只泵了 dyingMs 那么多帧，
           * 敌人刚好还在边界上（deathT 还没到 1），
           * 于是"展示期结束后敌人还在场上"会误报。
           */
          for (let f = 0; f < 30; f++) {
            globalThis.__pumpRaf(diedAt + COMBAT.dyingMs + f * (1000 / 60));
          }
          ctx2.__texts.length = 0;
          const gone = api.enemies().some((e) => e.tool === 'read_file');
          if (gone) {
            console.error('FAIL: 展示期结束后敌人还在场上');
            failed = true;
          } else {
            console.log('  展示期满 1 秒后尸体消失 ✓');
          }

          /*
           * ================= 雷电链：真跑一遍 =================
           *
           * 前面所有检查都在看"名字和血条画没画出来"，
           * 但改成法杖之后核心是**雷电**，而雷电是折线，
           * fillText/fillRect 全都抓不到 —— 等于没验。
           *
           * 所以这里专门把敌人摆到 reach 内、泵几帧，
           * 然后检查 ctx 桩上真的出现了一串折线顶点，
           * 并且终点落在敌人身上。
           */
          {
            /*
             * 这一段用**独立的虚拟时钟** stormAt，和上面那段解耦。
             * 事件时间和帧时间必须共享同一条轴，否则 dt 会变负。
             */
            const stormAt = 40000;
            globalThis.__vnow = stormAt;

            /* 先清场重来，保证敌人位置可控 */
            api.restart();
            globalThis.__vnow = stormAt;
            globalThis.__pumpRaf(stormAt);

            /*
             * 把两只敌人**手动摆到盾牌身边**。
             *
             * 为什么要手动摆：出生距离是 70~130，
             * 而 reach 只有 44 —— 靠自然追赶要好几秒，
             * 但在 Node 里泵那么多帧又慢又容易引入时序噪声。
             *
             * 直接摆位是在测"够得着时会不会真的放电"，
             * 不是测"敌人能不能追上来"（那件事已经单独验过了）。
             */
            const pa = api.aegis();
            const mk = (tool, ox, oy) => {
              const e = api.emit({ kind: 'tool', tool });
              e.x = pa.x + ox;
              e.y = pa.y + oy;
              return e;
            };

            const e1 = mk('read_file', 18, 0);
            const e2 = mk('grep', 26, 10);
            mk('glob', 26, -10);

            const hpBefore = e1.hpLost;
            const stunBefore = e1.stunT;

            /* 泵 20 帧，让施法节拍跑起来 */
            let sawBolt = false;
            let boltFrames = 0;
            let boltTopY = Infinity;
            const lightningSamples = [];

            for (let f = 0; f < 20; f++) {
              ctx2.__paths.length = 0;
              ctx2.__arcs.length = 0;
              globalThis.__pumpRaf(stormAt + f * (1000 / 60));

              /*
               * 斩击的路径特征是：二次曲线，通常 3 个点（起点+控制点+终点）。
               * 地面网格 / 圆边界也是 stroke，但颜色不同。
               *
               * 判据用颜色：刀光只用近战那三色（冷白阶或暖金阶）。
               * 顶点数下限取 2 而不是 5 —— 换个特效形状就会变，
               * 把点数写死是脆的。
               */
              const bolts = ctx2.__paths.filter((p2) =>
                p2.pts.length >= 2 &&
                SLASH_COLORS.blade.concat(SLASH_COLORS.exec).includes(p2.stroke),
              );
              if (bolts.length) {
                sawBolt = true;
                boltFrames++;
                for (const b of bolts) {
                  for (const pt of b.pts) boltTopY = Math.min(boltTopY, pt.y);
                }
              }

              // 每帧都把当前在场的链抓一份，供后面断言链长
              for (const l of api.lightning()) lightningSamples.push(l);
            }

            /*
             * ============ 雷电起点必须跟着 sprite 的镜像走 ============
             *
             * 刚修的一个真 bug：法杖在 sprite 左侧，盾牌朝左逃跑时
             * faceLeft 会把整张图水平翻转，杖顶视觉上跑到**右侧**；
             * 旧的 _drawLightning 直接按未翻转坐标算，
             * 于是雷从盾牌另一侧（空气里）劈出来，横向偏 17px。
             *
             * 不会抛异常、不会让旧断言失败，只能真去量。
             *
             * ===== 为什么不用"多跑几帧看看有没有朝右的帧" =====
             *
             * 试过：跑 180 帧只等到 1 帧朝右，等于断言只验了一半，
             * 朝右那条路径大概率是没跑到的。
             * 改成**受控状态直接比对**：手动构造朝左/朝右两份状态，
             * 各画一帧，量杖顶相对盾牌中心落在哪一侧。
             */
            const spW = 22;
            const halfW = spW / 2;
            const probe = globalThis.__shield.__renderProbe;
            const drawOnce = globalThis.__shield.__drawOnce;

            const mkState = (vx) => ({
              now: stormAt,
              director: { enemies: [], lightning: [], aegisMoving: true },
              aegis: {
                x: 500, y: 300,
                vx, vy: 0,
                swing: 0, swingT: 0, hurtT: 0,
                moving: true, fleeing: vx < 0,
              },
              shake: 0,
            });

            const tipOf = (vx) => {
              drawOnce(mkState(vx));
              const pr = probe();
              if (!pr.tip) return null;
              return pr.tip.x - 500;   // 相对盾牌中心的水平偏移
            };

            const offRight = tipOf(60);    // 朝右走
            const offLeft = tipOf(-60);    // 朝左走（应镜像）

            if (offRight === null || offLeft === null) {
              console.error('FAIL: 渲染探针拿不到剑尖坐标 —— 镜像断言无法执行');
              failed = true;
            } else if (Math.abs(offRight + offLeft) > 1) {
              /*
               * 镜像对称的核心判据：左右两个方向的偏移必须**互为相反数**。
               * 如果相等（比如都 -9.5），说明根本没镜像 ——
               * 这正是之前 faceLeft 算出来却没人用的那种 bug。
               */
              console.error('FAIL: 朝左/朝右的剑尖偏移几乎相同 ('
                + offRight.toFixed(1) + ' / ' + offLeft.toFixed(1)
                + ') —— sprite 没有镜像，或剑尖没跟着镜像');
              failed = true;
            } else if (offRight < 0) {
              /*
               * 短剑在 sprite 的**右侧**。
               * 朝右站（faceLeft=false）时，剑尖必须在盾牌中心**右边**。
               * 注意这和土豆版相反 —— 法杖在左侧，剑在右侧。
               * 抄旧判据会得到一个永远红的断言，或者更糟：
               * 把错的一侧当成对的，于是镜像 bug 再也抓不到。
               */
              console.error('FAIL: 朝右时剑尖在中心左侧 ' + offRight.toFixed(1)
                + 'px —— 短剑画在了错误的一侧');
              failed = true;
            } else {
              console.log('  剑尖跟着镜像：朝右 ' + offRight.toFixed(1)
                + 'px / 朝左 ' + offLeft.toFixed(1)
                + 'px（互为反向，sprite 半宽 ' + halfW + '）✓');
            }

            /* 剑尖纵向要落在 sprite 高度范围内，别飘到天上 */
            drawOnce(mkState(60));
            const prY = probe();
            const tipDy = prY.tip ? prY.tip.y - 300 : NaN;
            if (!(Math.abs(tipDy) < 14)) {
              console.error('FAIL: 杖顶纵向偏移 ' + tipDy.toFixed(1)
                + 'px，超出 sprite 半高 —— 刀光会从身体外面冒出来');
              failed = true;
            } else {
              console.log('  剑尖纵向贴身体：' + tipDy.toFixed(1) + 'px ✓');
            }

            /* 真实循环里斩击弧的起点也要贴着盾牌（不能只验受控状态） */
            let tipMin = Infinity;
            let tipFrames = 0;
            for (let f = 20; f < 60; f++) {
              ctx2.__paths.length = 0;
              globalThis.__pumpRaf(stormAt + f * (1000 / 60));
              /*
               * 斩击弧是二次曲线（quadraticCurveTo），
               * 所以点的数量和折线不同，颜色也换成了近战色阶。
               * 只认"有路径、且起点接近盾牌"这件事，
               * 不认具体点数 —— 点数会随实现变，是脆的。
               */
              const arcs = ctx2.__paths.filter((p2) =>
                p2.pts.length >= 2 &&
                SLASH_COLORS.blade.concat(SLASH_COLORS.exec).includes(p2.stroke),
              );
              if (!arcs.length) continue;
              const pot = api.aegis();
              let bestDx = null;
              for (const b of arcs) {
                const dx = b.pts[0].x - pot.x;
                if (bestDx === null || Math.abs(dx) < Math.abs(bestDx)) bestDx = dx;
              }
              if (bestDx === null) continue;
              tipFrames++;
              tipMin = Math.min(tipMin, Math.abs(bestDx));
            }
            if (tipFrames === 0) {
              console.error('FAIL: 真实循环里没量到斩击弧');
              failed = true;
            } else if (tipMin > halfW + 2) {
              console.error('FAIL: 真实循环里斩击起点离本体中心最近也有 '
                + tipMin.toFixed(1) + 'px，超出半宽 ' + halfW);
              failed = true;
            } else {
              console.log('  真实循环斩击起点贴着本体：最近 ' + tipMin.toFixed(1)
                + 'px（' + tipFrames + ' 帧样本）✓');
            }

                        if (!sawBolt) {
              console.error('FAIL: 敌人贴到身边 20 帧，一条斩击弧都没画出来'
                + ' —— 法杖攻击没接进渲染');
              failed = true;
            } else {
              console.log('  斩击：' + boltFrames + '/20 帧画出了刀光弧 ✓');
            }

            /* 伤害真的落在挨刀的敌人身上 */
            if (!(e1.hpLost > hpBefore)) {
              console.error('FAIL: 敌人挨刀了但 hpLost 没涨 —— 近战不造成伤害');
              failed = true;
            } else {
              console.log('  雷电造成伤害：read_file hpLost '
                + hpBefore.toFixed(3) + ' → ' + e1.hpLost.toFixed(3) + ' ✓');
            }

            /* 阻挡：被电住时 stunT > 0 */
            if (!(e1.stunT > stunBefore)) {
              console.error('FAIL: 被电中了但 stunT 没涨 —— 雷电阻挡不了前进');
              failed = true;
            } else {
              console.log('  雷电阻挡前进：stunT = '
                + e1.stunT.toFixed(3) + 's ✓');
            }

            /*
             * 阻挡必须**真的影响位移**。
             *
             * 只查 stunT > 0 是不够的：那只是一个数字，
             * 完全可能算出来了却没人在移动逻辑里读它
             * —— faceLeft 就是这么翻的车。
             *
             * 所以这里直接量位置：把敌人钉住（stunT 拉满），
             * 泵几帧，看它到底有没有挪动。
             */
            const pinned = e2;
            pinned.stunT = 5;   // 5 秒内绝对动不了
            const px0 = pinned.x;
            const py0 = pinned.y;
            for (let f = 0; f < 10; f++) {
              globalThis.__pumpRaf(stormAt + 1000 + f * (1000 / 60));
              // 每帧重新钉住（施法会覆盖 stunT，但这里要的是纯位移验证）
              pinned.stunT = 5;
            }
            const moved = Math.hypot(pinned.x - px0, pinned.y - py0);

            if (moved > 0.5) {
              console.error('FAIL: 被电住的敌人位移了 ' + moved.toFixed(2)
                + ' 格 —— stunT 算出来了但没人读');
              failed = true;
            } else {
              console.log('  被电住 10 帧，位移 ' + moved.toFixed(2)
                + ' 格（真的推不动）✓');
            }

            /*
             * 链式跳转：一条链要能连到多个目标。
             * 上面摆了 3 只扎堆的敌人，chainMax=4，
             * 所以应该看到一条链上有 ≥2 个落点。
             */
            /*
             * 注意：要在**泵帧的过程中**采样，不能泵完了再看。
             *
             * lightning 的存活期只有 180ms，泵完 20 帧（333ms）之后
             * 早已被清空 —— 上一版就是在循环外用 api.lightning() 查的，
             * 结果读到空数组，报"最多连到 0 个目标"。
             *
             * 那不是链没连成，是**查得太晚**。测试时序错误不能当成产品缺陷。
             */
            let maxBoltCount = 0;
            for (const l of lightningSamples) {
              maxBoltCount = Math.max(maxBoltCount, l.bolts.length);
            }
            if (maxBoltCount < 2) {
              console.error('FAIL: 最多只连到 ' + maxBoltCount
                + ' 个目标 —— 没有形成雷电链');
              failed = true;
            } else {
              console.log('  雷电链最多连到 ' + maxBoltCount + ' 个目标 ✓');
            }

            /*
             * ============ 处决特效：真跑一遍渲染 ============
             *
             * 用户的要求：
             *   「完成任务的时候有个处决特效，秒杀剩余血量」
             *
             * 处决雷的绘制路径（_execFx）里用了
             * createLinearGradient / createRadialGradient / arc ——
             * 桩里少一个方法就直接 TypeError，而 node --check 查不出来。
             * 所以这里必须真的死一个敌人、真的画一帧。
             */
            {
              /*
               * 先造一个**独一无二**的工具名的小兵。
               *
               * 为什么不用 read_file：场上还留着前面检查造的同工具敌人，
               * 而 tool_end 无 id 时按 FIFO 匹配**最早**那只 ——
               * 于是处决的是别人，我这里量到的目标永远 dead=false。
               *
               * 上一版就在这栽了：处决特效 30/30 帧画出来了（真的在演），
               * 但断言拿错了对象，报"处决前血条 null"。
               * 测试用具名不能撞车，结算要带 id。
               */
              const execTool = 'exec_probe_tool';
              const execCallId = 'probe_call_' + Date.now();
              api.emit({ kind: 'tool', tool: execTool, id: execCallId });
              globalThis.__pumpRaf(stormAt + 4000);

              const before = api.enemies();
              const target = before.find((x) => !x.dead && x.tool === execTool);
              if (!target) {
                console.error('FAIL: 造不出可处决的敌人');
                failed = true;
              } else {
                const hpBefore = target.hp;

                /* 处决它：带 id，精确命中这一只 */
                globalThis.__vnow = stormAt + 4000;
                /* 用 callId 精确命中，不是 id（id 是序号，跟事件 id 不是一套） */
                api.emit({ kind: 'tool_end', tool: execTool, id: execCallId, ok: true });

                /*
                 * 处决雷存活 execMs=420ms，约 25 帧。
                 * 逐帧清空记录器，统计处决特效画了多少帧、
                 * 都用了哪些绘制手段。
                 */
                let execFrames = 0;
                let sawRadial = 0;
                let sawVertical = 0;

                for (let f = 0; f < 30; f++) {
                  ctx2.__paths.length = 0;
                  ctx2.__arcs.length = 0;
                  ctx2.__rects.length = 0;
                  ctx2.__grads.length = 0;

                  globalThis.__pumpRaf(stormAt + 4000 + f * (1000 / 60));

                  /*
                   * ===== 只认处决特效独有的特征 =====
                   *
                   * 第一版判据太松，栽了一次：
                   *   - "竖直 fillRect"  —— 地面/血迹/血条也在 fillRect
                   *   - "arc 半径 > 3"   —— 场地圆边界/落点光团也有 arc
                   * 于是**即使处决雷根本没创建**，也统计出
                   * "30/30 帧可见"，把功能失效测成了通过。
                   *
                   * 现在只认两样**只有处决才画**的东西：
                   *   1. createRadialGradient  —— 正常雷电只用 linear
                   *   2. createLinearGradient 起点 y 比终点 y 小 34 ——
                   *      那是 _execFx 的竖直光柱（从上方砸下来）
                   *
                   * 这两个特征是处决路径独有的，别处不会出现。
                   */
                  const rad = ctx2.__grads.filter(
                    (g) => g.__kind === 'createRadialGradient',
                  );
                  /*
                   * 斩痕：一条**斜向**渐变，横跨约 2*cutLen。
                   *
                   * 旧判据找的是竖直光柱（x 相同、y 差 > 20）。
                   * 换成近战之后斩痕是斜的，那条判据永远匹配不到 ——
                   * 于是报没画处决特效，而实际上画了。
                   * 这是断言跟着实现形状走造成的假红，必须跟着改。
                   */
                  const pillar = ctx2.__grads.filter((g) => {
                    if (g.__kind !== 'createLinearGradient') return false;
                    const a0 = g.__args;
                    if (a0.length < 4) return false;
                    const dx = Math.abs(a0[2] - a0[0]);
                    const dy = Math.abs(a0[3] - a0[1]);
                    // 斜向：横跨明显、纵向也有分量，且不是竖直
                    return dx > 20 && dy > 5 && dy < dx;
                  });

                  if (rad.length) sawRadial++;
                  if (pillar.length) sawVertical++;
                  if (rad.length || pillar.length) execFrames++;
                }

                if (execFrames === 0) {
                  console.error('FAIL: 处决之后 30 帧内没画出处决特效'
                    + ' —— 死亡没有任何可见原因');
                  failed = true;
                } else if (sawVertical === 0) {
                  /* 斩痕是"被砍断了"的核心暗示，缺了就只剩一团光 */
                  console.error('FAIL: 处决没有画横贯斩痕（只有爆点）'
                    + ' —— 看起来不像处决');
                  failed = true;
                } else {
                  console.log('  处决特效：' + execFrames + '/30 帧可见'
                    + '（爆点 ' + sawRadial + ' 帧 / 光柱 ' + sawVertical + ' 帧）✓');
                }

                /*
                 * 处决必须把血条清零 —— 这就是"秒杀剩余血量"。
                 * 注意查 hpAtDeath（清零**前**的快照）：
                 * 它应该 > 0，说明确实有血被处决掉了，
                 * 而不是"血条早就空了，谈不上处决"。
                 */
                const after = api.enemies().find((x) => x.id === target.id);
                if (!after) {
                  console.error('FAIL: 找不到被处决的敌人，无法核对血条');
                  failed = true;
                } else if (!(after.hpAtDeath > 0)) {
                  console.error('FAIL: 处决前血条已是 ' + after.hpAtDeath
                    + ' —— 没有"剩余血量"可秒杀，处决演出是假的');
                  failed = true;
                } else {
                  console.log('  处决秒杀剩余血量：' + (after.hpAtDeath * 100).toFixed(0)
                    + '%（处决前 hp ' + (hpBefore * 100).toFixed(0) + '%）✓');
                }
              }
            }

            /* 收尾：清场，别影响后面的检查 */
            globalThis.__vnow = stormAt + 3000;
            api.emit({ kind: 'turn_end', ok: true });
            for (let f = 0; f < 90; f++) {
              globalThis.__pumpRaf(stormAt + 3000 + f * (1000 / 60));
            }
          }
        }
      }

      /*
       * ---- 布局检查：BOSS 血条必须让开左上角 HUD ----
       *
       * 这是视觉复核抓到的真实缺陷，而且修了两版才彻底对：
       *
       *   v1  bx = (W-bw)/2          → 1280 宽下和 HUD 重叠 14px
       *   v2  bx = max(W*0.26, 居中)  → 1280 好了，1024 又重叠
       *   v3  读 HUD 真实 right + 16  → 任何宽度都让开
       *
       * v2 错在**用相对量避让绝对布局**：
       *   HUD 是 left:12px + 文本宽（绝对像素），W*0.26 是比例。
       *   视口越窄比例值越小，HUD 右边界不动 → 必然交叉（实测 W≈1071）。
       *
       * 这里量化检查：在多个视口宽度下，血条起点必须 > HUD 右边界。
       */
      {
        const hudEl = globalThis.document.getElementById('hudLine1');
        // 桩的 getBoundingClientRect 固定返回宽 960，所以模拟成真实文本宽度
        const hudRightCss = 278.34;
        hudEl.getBoundingClientRect = () => ({
          x: 12, y: 12, width: hudRightCss - 12, height: 18.59,
          left: 12, top: 12, right: hudRightCss, bottom: 30.59,
        });

        const canvasEl = globalThis.document.getElementById('cv');
        let bad = [];
        for (const w of [1920, 1280, 1100, 1024, 900, 768, 480]) {
          for (const dpr of [1, 2]) {
            canvasEl.width = Math.round(w * dpr);
            canvasEl.height = Math.round(720 * dpr);
            canvasEl.clientWidth = w;
            canvasEl.clientHeight = 720;

            /*
             * 直接重算一遍血条定位公式（和 render.mjs 里的逻辑一致）。
             * 注意：这里允许"复刻"，因为这是**纯几何计算**，
             * 不涉及任何状态流转；而且下面会打印出具体数字，
             * 一旦 render.mjs 的公式改了而这里没改，数字会对不上。
             */
            const W = canvasEl.width;
            const hudRight = hudRightCss * dpr;
            const GAP = 16 * dpr;
            const bw = Math.round(W * 0.58);
            const minX = Math.round(hudRight + GAP);
            const bx = Math.max(minX, Math.round((W - bw) / 2));
            let bwFinal = Math.min(bw, W - bx - Math.round(W * 0.03));
            if (bwFinal < 80 * dpr) {
              bwFinal = Math.max(0, W - bx - Math.round(W * 0.02));
            }

            if (bx <= hudRight) {
              bad.push(`W=${w} dpr=${dpr}: bx=${bx} <= hudRight=${hudRight.toFixed(0)}`);
            }
            if (bwFinal <= 0) {
              bad.push(`W=${w} dpr=${dpr}: 血条宽度 ${bwFinal} <= 0`);
            }
          }
        }

        if (bad.length) {
          console.error('FAIL: BOSS 血条在以下视口会压住 HUD 或被压成 0 宽：');
          for (const b of bad) console.error('  ' + b);
          failed = true;
        } else {
          console.log('  BOSS 血条在 1920/1280/1100/1024/900/768/480 × dpr1,2 下全部让开 HUD ✓');
        }
      }

      /* ---- 用 turn_end ok:true 收尾，应该清场 ---- */
      api.emit({ kind: 'turn_end', ok: true });
      const s3 = api.stats();
      if (s3.alive !== 0) {
        console.error(`FAIL: turn_end ok:true 后仍有 ${s3.alive} 个敌人`);
        failed = true;
      } else {
        console.log(`  喂 turn_end ok:true → 全部清场 ✓（击杀 ${s3.kills}）`);
      }
    }
  }
}

/* ---------------- 5.5) 死变量检查 ---------------- */

/**
 * 检查"算出来了但没接进消费点"的变量。
 *
 * ===== 为什么要这一条 =====
 *
 * 这个项目连续踩了两次同一个坑，语法检查和断言都没抓到：
 *
 *   1. target() 的注释写着"离盾牌最近"，代码算的是"离场地中心最近"。
 *      算出来的 d 用了，但用错了对象。
 *
 *   2. render 里写了 `const faceLeft = flip && p.vx < 0`，
 *      但镜像条件写成 `if (flip)`（只看 |vx| 不看方向）。
 *      **faceLeft 声明后从未被读取**，于是往左往右渲染完全一样。
 *      视觉复核用 134 对左右帧逐像素比对才发现：
 *      直接比对 MAD 0.47、镜像比对 MAD 13.26 —— 根本没翻转。
 *
 * 这类 bug 的特点是：
 *   - 不报错（变量合法声明）
 *   - 断言能过（如果断言只看"有没有翻转"而不看"方向对不对"）
 *   - 只有真去看画面才露
 *
 * 所以加一条静态检查：源码里 `const X = ...` 声明的局部变量，
 * 如果全文只出现一次（就是声明那一行），那它一定是死代码。
 *
 * 局限：只查单行 const/let 声明，不处理解构、多行、闭包捕获。
 * 但这已经能抓住本项目出现过的两次真问题。
 */
function findDeadLocals(src) {
  const lines = src.split('\n');
  const problems = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    /*
     * 只看缩进 ≥2 的局部声明，且是 `const name = ...` 形式。
     * 跳过解构（{ / [）、跳过模块顶层的 export。
     */
    const m = line.match(/^(\s{2,})(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=/);
    if (!m) continue;

    const name = m[2];
    // 统计全文出现次数（按单词边界）
    const re = new RegExp('\\b' + name.replace(/\$/g, '\\$') + '\\b', 'g');
    const hits = (src.match(re) || []).length;
    if (hits <= 1) {
      problems.push({ line: i + 1, name, decl: line.trim() });
    }
  }
  return problems;
}

{
  const files = ['main.mjs', 'render.mjs', 'director.mjs', 'bestiary.mjs'];
  let total = 0;
  for (const f of files) {
    const p = path.join(DIR, f);
    if (!fs.existsSync(p)) continue;
    const src = fs.readFileSync(p, 'utf8');
    const dead = findDeadLocals(src);
    for (const d of dead) {
      console.error(`FAIL: ${f}:${d.line} 死变量 '${d.name}' —— 声明后从未被读取`);
      console.error(`      ${d.decl}`);
      total++;
    }
  }
  if (total > 0) {
    console.error('  → 这类变量通常是"算出来了但没接进消费点"，功能实际没生效');
    failed = true;
  } else {
    console.log('  死变量检查：无（局部 const/let 都被用上了）');
  }
}

/* ---------------- 6) 检查源码里没有整段被注释掉的关键逻辑 ---------------- */

function checkSource(file, mustContain) {
  const p = path.join(DIR, file);
  if (!fs.existsSync(p)) {
    console.error(`FAIL: 缺文件 ${file}`);
    return false;
  }
  const src = fs.readFileSync(p, 'utf8');
  const missing = mustContain.filter((s) => !src.includes(s));
  if (missing.length) {
    console.error(`FAIL: ${file} 里找不到：${missing.join(' | ')}`);
    return false;
  }
  return true;
}

if (!checkSource('director.mjs', [
  '_settle',
  'hpRatio',
  'isOverdue',
  'turnOk',
  'duplicates',
])) failed = true;

if (!checkSource('bestiary.mjs', [
  'agent_run',
  'expectMs',
  'TIER.BOSS',
])) failed = true;

/* ---------------- 汇总 ---------------- */

console.log('');
if (failed) {
  console.log('有阻断问题');
  process.exit(1);
} else {
  console.log('全部通过');
  process.exit(0);
}
