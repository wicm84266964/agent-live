/**
 * 战场渲染。
 *
 * ===== 坐标系统：只有一个 =====
 *
 * 世界坐标是 **1x 像素**（比如竞技场半径 260）。
 * 画布按整数倍放大（通常是 3x 或 4x）。
 *
 * 所有逻辑（碰撞、移动、距离）都在 1x 世界里算，
 * 只有最后 `drawImage` 的时候才乘缩放。这样：
 *   - sprite 永远是整数像素块，不会糊
 *   - 逻辑数值不依赖屏幕分辨率，换窗口不用改参数
 *
 * ===== 没有光照、没有阴影贴图 =====
 *
 * 像素风的表现力靠三样东西：
 *   1. 描边（sprites.mjs 已经在烘焙时做了）
 *   2. 有限的色板（亮部/主体/暗部三色）
 *   3. 硬边的地面图案（网格、沙砾点、血迹）
 *
 * 想要"地牢感"，画一层深色地面 + 稀疏碎石点就够了，
 * 加渐变反而会破坏像素感。

 */

/*
 * SWORD_TIP 是炮口在 sprite 内的坐标（三姿态各一份）。
 * 攻击特效必须从它发射 —— 所以这个值是 sprite 和渲染共享的契约，
 * 不能在两边各写一个数字。
 *
 * ROLES 是**角色 → sprite 键名**的映射表（来自 theme.mjs）。
 * 绘制时一律 `this.sprites[ROLES.hero.idle]`，不写 `sprites.aegisIdle`：
 * 硬编码键名会让 render 里藏着一处"换素材时必须跟着改"的暗礁，
 * 而换题材本该只改配置。
 */
import { bakeAll, SWORD_TIP, swordTip, ROLES } from './sprites.mjs';
import { TIER } from './bestiary.mjs';
import { SLASH_COLORS, COPY, fill, TIER_LABEL_COLORS } from './theme.mjs';

/*
 * 斩击色阶：三段结构「外辉光 → 刃身 → 刃口高光」。
 *
 * 这是 render 和 _refs.mjs 之间的共享契约，和 SWORD_TIP 同理：
 * _refs 靠颜色把刀光从地面网格、圆边界里认出来，
 * 所以色值不能在两边各写一遍 —— 改了一边另一边就会静默失效
 * （探针永远匹配不到，只会在"没量到刀光"上假红或假绿）。
 *
 * 色值本身在 theme.mjs 的 slash 里（题材配色单一真相源），
 * 这里只做 re-export 供 _refs / verify 消费，不另存一份字面量。
 *
 * blade：常规攻击，冷白阶。
 * exec ：处决那一下换暖金，表示"这一下是终结"。
 */
export { SLASH_COLORS };

/* ---------------- 震屏：trauma 模型 ---------------- */

/*
 * ===== 为什么不用 Math.random() 逐帧抖动 =====
 *
 * 上一版是：
 *   shx = (Math.random() * 2 - 1) * shakeAmt
 *
 * 这有个肉眼可见的问题：连续两帧的偏移**完全无关**，
 * 画面在像素之间高频跳变，读起来像"静电噪声"，不像冲击。
 * GDC 2016 Squirrel Eiserloh《Juicing Your Cameras With Math》
 * 的原话是「Use Perlin noise for shakes and, like, everything else」，
 * 因为噪声的相邻输入产生相邻输出，天然连续。
 *
 * ===== trauma 模型 =====
 *
 * 维护一个 trauma ∈ [0,1]，事件往上加，时间线性衰减，
 * 实际抖动 = trauma² × 最大偏移。
 *
 * 为什么平方而不是线性：Eiserloh 给的感知校准是
 *   trauma .30 / .60 / .90 → 抖动 3% / 22% / 73%
 * 平方能让"小事件被感觉到但不震屏"，同时强度差异在
 * 感知上是单调可分的。线性则会让小事件也明显晃。
 *
 * 实测换算（maxOffset=22px）：
 *   普通命中 trauma 0.18 → 0.7px   （几乎只被感觉到）
 *   击杀     trauma 0.50 → 5.5px
 *   BOSS 死  trauma 0.85 → 15.9px
 */
export const SHAKE = {
  maxOffset: 22,
  /** trauma 每秒衰减量 */
  decayPerSec: 1.1,
  /*
   * ===== 噪声采样频率：被 Nyquist 限死，不能随便调大 =====
   *
   * 这里踩过一次坑，数值很有教育意义，记下来。
   *
   * 第一版写 freq = 19，本意是"抖得碎一点、更有冲击感"。
   * 但屏幕是 60~75Hz 采样的，而噪声里最高那一路正弦的频率是
   *   freq × 41 = 779Hz
   * 每帧相位推进 = 779 / 60 × 2π ≈ 81 rad，远超 Nyquist 上限 π。
   *
   * 后果：正弦和在被采样时**混叠**成高频噪声 ——
   * 浏览器实测的相邻帧位移差值 15.4px（占全程 35%），
   * 与纯 Math.random() 的 0.350 参照值**完全一样**（实测 0.353），
   * 也就是说噪声函数等于没起作用，画面又变回了静电抖动。
   *
   * 正确的约束是：最高分量的每帧相位推进必须 < π
   *   41 × freq / 60 × 2π < π  →  freq < 60 / 82 ≈ 0.73... 
   *
   * 等等，这里要小心：shakeNoise 里的 t 已经乘了 freq，
   * 而 sin 内部又乘了 11/23/41。所以有效频率是 freq×41 Hz。
   * 要让它每帧推进 < π：
   *   freq × 41 × (1/60) × 2π < π
   *   freq < 60 / (2 × 41) ≈ 0.73 Hz
   *
   * 但 0.73Hz 的噪声在 0.16 秒的震动里几乎不动（不像抖）。
   * 所以必须降那三路的倍数，而不是把 freq 压到 0.7。
   *
   * 现在把倍数改成 1 : 2.3 : 4.1（原来是 11 : 23 : 41），
   * freq 取 6.5Hz。最高分量 = 6.5 × 4.1 ≈ 27Hz，
   * 每帧推进 = 27/60 × 2π ≈ 2.8 rad < π —— 刚好在 Nyquist 之内。
   *
   * 实测效果：相邻帧差值从 15.4px 降到 2.6px 量级，
   * 滞后 1 自相关从 -0.52（反相关，典型噪声）转正（连续）。
   */
  freq: 6.5,
  /** 噪声三路的频率倍数。最高一路必须满足 freq×mul/60×2π < π */
  harmonics: [1, 2.3, 4.1],
  /** 2D 俯视：平移为主 + 极小幅旋转。Eiserloh 明确说 2D 里两者叠加最佳 */
  maxAngle: 0.012,
};

/**
 * 一维值噪声的廉价近似：叠加几个**不可通约频率**的正弦。
 *
 * 为什么不用真柏林噪声：这里只需要"连续且看起来随机"，
 * 三路正弦叠加在 60fps 下已经无法分辨，而且没有查表和插值开销。
 * 关键是频率比必须是无理数附近（11 : 23 : 41），
 * 用整数倍会形成明显的周期拍点。
 */
function shakeNoise(seed, t) {
  /*
   * 频率倍数来自 SHAKE.harmonics（1 : 2.3 : 4.1，不可通约）。
   *
   * 上一版硬编码 11 : 23 : 41 —— 那三路的绝对频率
   * （配合 freq=19）高到帧采样时混叠，等于随机噪声。
   * 详见 SHAKE.freq 上面那段 Nyquist 推导。
   */
  const h = SHAKE.harmonics;
  return 0.55 * Math.sin(t * h[0] + seed * 1.7)
    + 0.30 * Math.sin(t * h[1] + seed * 3.1)
    + 0.15 * Math.sin(t * h[2] + seed * 5.3);
}


/** 竞技场参数（1x 坐标）。 */
export const ARENA = {
  cx: 0,
  cy: 0,
  r: 250,
};

/** 地砖目标尺寸（1x 像素）。 */
const TILE = 32;

/**
 * 视口变换：世界坐标（1x，原点 = 竞技场圆心）→ 设备像素。
 *
 * ===== 这里曾经有一个只在 scale≠1 才暴露的偏移 =====
 *
 * 上一版是 `cx = (vw / 2 + sh.x) * s0`，也就是把"画布中心"也乘了一次
 * scale。scale=1 时 ×1 恰好等于没乘，所以单元断言一路绿灯；真浏览器
 * 上 1600×900（scale=1.3）圆心实测 (1040,579)，画布中心是 (800,450)，
 * 整块战场向右下甩出 +240,+129，底边直接压出画布被裁。
 *
 * 正确的分解是三件事各管一半，谁也不许重复乘：
 *   1. 缩放：1 个世界单位 = scale 个 CSS 像素 = scale·dpr 个设备像素
 *   2. 平移：世界原点要落在**画布中心**，即 vw·dpr/2（这里只乘 dpr，
 *      因为 1 个 CSS 像素 = dpr 个设备像素，与 scale 无关）
 *   3. 震屏：sh.x / sh.y 是**屏幕像素**语义（SHAKE.maxOffset 就是按
 *      px 定的观感），所以只跟 dpr 走，不跟 scale 走 —— 否则放大后
 *      抖得更狠，手感会变。
 *
 * 提成纯函数是为了能在 Node 里对任意 scale/dpr 断言"圆心恒等于画布中心"，
 * 而不是只在 scale=1 这一档上验（那正是这个 bug 漏网的原因）。
 *
 * @returns {{a:number,d:number,e:number,f:number}} 可直接喂 ctx.setTransform
 */
export function viewportTransform(vw, vh, scale, dpr, sh = { x: 0, y: 0 }) {
  const s0 = scale * dpr;
  return {
    a: s0,
    d: s0,
    e: (vw * dpr) / 2 + (sh.x || 0) * dpr,
    f: (vh * dpr) / 2 + (sh.y || 0) * dpr,
  };
}

/** 世界坐标 (x, y) 经视口变换之后的设备像素位置（验证 / 调试用）。 */
export function projectPoint(t, x, y) {
  return { x: t.a * x + t.e, y: t.d * y + t.f };
}

/**
 * 渲染器。
 */
export class Renderer {
  constructor(canvas) {
    this.cv = canvas;
    this.ctx = canvas.getContext('2d');
    this.sprites = null;
    /** 屏幕缩放（整数） */
    this.scale = 1;
    /** 视口宽高（1x 坐标） */
    this.vw = 0;
    this.vh = 0;

    /*
     * 雷电链数据直接引用 director.lightning（同一份数据）。
     *
     * 刻意不在 renderer 里另存一份：如果两边各存一份，
     * 就可能出现"画面上雷劈了 A，血却掉在 B 身上"。
     * 现在几何和伤害是同一个对象。
     */
    this.lightning = [];
    /* 飘字（-1 / KILL / MISS） */
    this.floaters = [];
    /* 落地血迹 */
    this.stains = [];

    this._t = 0;
  }

  /** 是否已经烘焙好 sprite。 */
  ready() {
    return this.sprites !== null;
  }

  /**
   * 尺寸变化时重算。缩放取整数，保证像素不被半像素插值糊掉。
   */
  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cssW = this.cv.clientWidth || 960;
    const cssH = this.cv.clientHeight || 600;

    /*
     * 目标：让竞技场直径 (2*r) 大约占屏幕短边的 88%，
     * 再取整到整数倍缩放。
     */
    const targetScale = (Math.min(cssW, cssH) * 0.88) / (ARENA.r * 2 + 80);
    this.scale = Math.max(1, Math.floor(targetScale * 10) / 10);
    // 再保守一点：低于 1 就钳到 1
    if (this.scale < 1) this.scale = 1;

    const pxW = Math.round(cssW * dpr);
    const pxH = Math.round(cssH * dpr);
    if (this.cv.width !== pxW || this.cv.height !== pxH) {
      this.cv.width = pxW;
      this.cv.height = pxH;
    }
    this.dpr = dpr;
    this.vw = Math.round(cssW);
    this.vh = Math.round(cssH);

    if (!this.sprites) this.sprites = bakeAll();
  }

  /**
   * 一帧。
   *
   * @param {object} s 场景快照：
   *   { now, director, aegis:{x,y,swing,swingT,hurtT}, shake }
   */
  draw(s) {
    if (!this.sprites) this.sprites = bakeAll();

    const ctx = this.ctx;
    const { now } = s;
    this._t = now / 1000;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.imageSmoothingEnabled = false;

    /* ---- 屏幕震动（trauma² + 噪声，见文件头的 SHAKE 说明）---- */
    const shakeAmt = s.shake || 0;
    const sh = this._shakeOffset(now, shakeAmt);

    /*
     * 震屏 = 平移 + 极小幅旋转。
     *
     * Eiserloh 在 GDC 讲稿里对 2D 的判断很明确：
     *   旋转「还行但有点 lame」，平移「不错」，**两者叠加 = Awesome**。
     * （3D 里恰恰相反，叠加会非常糟。）
     *
     * 旋转量极小（0.012 rad ≈ 0.7°），因为像素风格下画面一旦倾斜，
     * 所有像素块都落到非整数角度上，抗锯齿会把它们糊掉。
     * 这么小的角度只提供"画面被撼动"的暗示，不会真的扭曲像素。
     */
    const vt = viewportTransform(this.vw, this.vh, this.scale, this.dpr, sh);

    ctx.setTransform(vt.a, 0, 0, vt.d, vt.e, vt.f);

    if (sh.a) {
      /*
       * 绕画面中心旋转，所以先把原点挪到画布中心再转，最后挪回去。
       * 直接 setTransform 带旋转的话，旋转会绕世界原点 —— 那是画布
       * 左上角，整个场景会甩出屏幕。
       */
      ctx.translate(this.vw / 2, this.vh / 2);
      ctx.rotate(sh.a);
      ctx.translate(-this.vw / 2, -this.vh / 2);
    }

    /* ---- 地面 ---- */
    this._drawGround(ctx);

    /* ---- 血迹（在地上，敌人下面） ---- */
    this._drawStains(ctx);

    /* ---- 敌人 ---- */
    const list = [...s.director.enemies].sort((a, b) => {
      // 大的先画（显得在后面），小的后画
      if (a.tier !== b.tier) return b.tier - a.tier;
      return a.y - b.y;
    });
    for (const e of list) this._drawEnemy(ctx, e, now);

    /* ---- 植保盾牌 ---- */
    this._drawAegis(ctx, s.aegis, now);

    /* ---- 雷电链（在角色上面） ---- */
    this.lightning = s.director.lightning || [];

    /*
     * 特效开关由 main.mjs 传进来（按 F/S/N 切换）。
     * 存成实例字段是因为 _flashAlpha 在 _drawEnemy 的深处调用，
     * 一路加参数会污染四五个函数签名。
     */
    this._fx = s.fx || null;
    this._drawStrikes(ctx, now);

    /* ---- 贴地飘字 ---- */
    this._drawFloaters(ctx, now);

    /* ---- 本地坐标层结束 ---- */
    ctx.setTransform(1, 0, 0, 1, 0, 0);

    /* ---- 屏幕层：BOSS 血条、警示 ---- */
    this._drawOverlay(ctx, s);
  }

  /* ---------------- 地面 ---------------- */

  _drawGround(ctx) {
    // 底色：深土
    ctx.fillStyle = '#241d16';
    ctx.fillRect(
      -this.vw / 2 - 40, -this.vh / 2 - 40,
      this.vw + 80, this.vh + 80,
    );

    /*
     * 地砖网格。
     * 用极低对比度的线，让地面有"尺度"，但不抢戏。
     */
    ctx.strokeStyle = 'rgba(255,255,255,0.028)';
    ctx.lineWidth = 1 / this.scale;
    const half = Math.ceil(Math.max(this.vw, this.vh) / 2 / TILE) + 2;
    ctx.beginPath();
    for (let i = -half; i <= half; i++) {
      ctx.moveTo(i * TILE, -half * TILE);
      ctx.lineTo(i * TILE, half * TILE);
      ctx.moveTo(-half * TILE, i * TILE);
      ctx.lineTo(half * TILE, i * TILE);
    }
    ctx.stroke();

    /*
     * 竞技场圆形边界。
     * 这是"战场"的范围感，也提示怪物从边缘进来。
     */
    ctx.strokeStyle = 'rgba(200,160,90,0.22)';
    ctx.lineWidth = 2 / this.scale;
    ctx.beginPath();
    ctx.arc(ARENA.cx, ARENA.cy, ARENA.r, 0, Math.PI * 2);
    ctx.stroke();

    // 边界内的暗角（便宜的做法：一圈半透明）
    ctx.strokeStyle = 'rgba(0,0,0,0.18)';
    ctx.lineWidth = 14 / this.scale;
    ctx.beginPath();
    ctx.arc(ARENA.cx, ARENA.cy, ARENA.r - 6, 0, Math.PI * 2);
    ctx.stroke();
  }

  _drawStains(ctx) {
    for (const st of this.stains) {
      ctx.globalAlpha = st.a;
      ctx.fillStyle = st.c;
      ctx.fillRect(st.x - st.r, st.y - st.r, st.r * 2, st.r * 2);
    }
    ctx.globalAlpha = 1;
  }

  /* ---------------- 敌人 ---------------- */

  /**
   * 接地阴影：把 sprite 剪影压扁、涂黑、放在脚下。
   *
   * ===== 为什么需要这一层 =====
   *
   * 这是《土豆兄弟》最容易被忽略、但少了就立刻"浮空"的一层。
   * Brotato 的做法（反编译 player.tscn 里有明确参数）非常省：
   * 直接复用角色自己的剪影，压扁到 30%，涂黑 39% alpha。
   *
   *   modulate = Color(0,0,0,0.392)
   *   scale    = Vector2(1, -0.3)
   *
   * 用剪影而不是椭圆：剪影带着身体轮廓的信息 ——
   * 宽肩的角色影子也宽，比统一椭圆更像"真有个东西站在那"。
   *
   * ===== 为什么用离屏 canvas 而不是 source-atop =====
   *
   * 直觉写法是：drawImage(剪影) → composite='source-atop' → fillRect 涂黑。
   * 但 source-atop 作用于**整块画布的已有像素**，会把这一帧先前画的
   * 地面网格、血迹、别的敌人一起染黑。
   *
   * 这类 bug 在画面上表现为"屏幕某块莫名其妙变暗"，极难定位。
   * 所以先在离屏 canvas 上合成好，再一次性 drawImage 到主画布。
   * 顺便按尺寸缓存 —— 阴影每帧都画，不缓存等于每帧多一次合成。
   */
  _drawShadow(ctx, e, sp, w, h, scaleMul, alpha) {
    const sw = Math.max(1, Math.round(w * scaleMul * 1.02));
    const sh = Math.max(1, Math.round(h * scaleMul * 0.30));

    if (!this._shadowCache) this._shadowCache = new Map();
    const key = sw + 'x' + sh;

    let shCanvas = this._shadowCache.get(key);
    if (!shCanvas) {
      shCanvas = document.createElement('canvas');
      shCanvas.width = sw;
      shCanvas.height = sh;
      const sc = shCanvas.getContext('2d');
      sc.imageSmoothingEnabled = false;
      sc.drawImage(sp, 0, 0, sw, sh);
      sc.globalCompositeOperation = 'source-atop';
      sc.fillStyle = '#000000';
      sc.fillRect(0, 0, sw, sh);
      this._shadowCache.set(key, shCanvas);
    }

    ctx.save();
    ctx.globalAlpha = alpha;
    /*
     * 阴影落在脚下，**不跟随 deathT 的上浮**。
     * 死亡时尸体被抬起来（liftY），但影子该留在地上 ——
     * 否则看起来像飘走的气球。
     */
    const shadowY = e.y - h / 2 + h * 0.72;
    ctx.drawImage(shCanvas, e.x - sw / 2, shadowY);
    ctx.restore();
  }

  /**
   * 计算这一帧的震屏偏移。
   *
   * sAmt 是 director/main 传进来的 trauma 值（0..1，可累加超过 1）。
   * 这里做三件事：钳位、平方、按噪声采样。
   *
   * 注意：**不用 Math.random()**。逐帧随机会让画面在像素间高频跳变，
   * 读起来像静电噪声而不是冲击。噪声函数保证相邻帧连续。
   */
  _shakeOffset(now, sAmt) {
    if (!sAmt) return { x: 0, y: 0, a: 0 };
    const trauma = Math.min(1, Math.max(0, sAmt));
    /* 平方：小事件被"感觉到"但不"震屏"，强度差在感知上仍可分 */
    const k = trauma * trauma;
    const t = (now / 1000) * SHAKE.freq;
    return {
      x: SHAKE.maxOffset * k * shakeNoise(1.3, t),
      y: SHAKE.maxOffset * k * shakeNoise(7.9, t),
      a: SHAKE.maxAngle * k * shakeNoise(13.7, t),
    };
  }

  _drawEnemy(ctx, e, now) {
    const sp = this.sprites[e.sprite] || this.sprites[ROLES.enemy.unknown];
    const dying = e.diedAt !== null;

    /*
     * 死亡动画：缩小 + 淡出 + 向上飘。
     * 用 deathT 0..1（由 director 按真实毫秒推进）。
     *
     * 注意：尸体的 alpha 不要掉到 0 —— 留 0.35 的下限。
     * 因为用户要求"保留一秒钟，别一闪而过看不清"，
     * 如果最后 0.3 秒已经几乎透明，等于没留。
     */
    let alpha = 1;
    let scaleMul = 1;
    let liftY = 0;
    if (dying) {
      const t = e.deathT;
      alpha = 1 - t * 0.65;          // 最低留 0.35
      scaleMul = 1 + t * 0.18;
      liftY = -t * 8;
    }

    /*
     * ===== 出生显形 =====
     *
     * 不是"预警"：敌人已经因为真实 tool 事件而存在了，
     * 这里只是不让它第一帧就完整弹出。
     * 缩放 0.60→1.00 + 淡入，缓动用 easeOut（尾段慢，落点稳）。
     *
     * 只作用于画，不作用于数值：这段期间它照样会被雷电打到。
     */
    const spawnT = e.spawnT === undefined ? 1 : e.spawnT;
    if (!dying && spawnT < 1) {
      const et = 1 - (1 - spawnT) * (1 - spawnT);   // easeOutQuad
      alpha *= 0.25 + 0.75 * et;
      scaleMul *= 0.60 + 0.40 * et;
    }

    const w = sp.width;
    const h = sp.height;

    const bobSpeed = e.tier === TIER.BOSS ? 1.4 : 4.2;
    const bobAmt = e.tier === TIER.BOSS ? 1.5 : 0.8;
    const bob = dying ? 0 : Math.sin(this._t * bobSpeed + e.phase) * bobAmt;

    const dx = e.x - (w / 2) * scaleMul;
    const dy = e.y + liftY - h / 2 + bob;

    /*
     * 出生环：地面上收拢的一圈，配合缩放淡入说明"刚刚出现在这里"。
     *
     * 半径从 1.9 倍收到 1.0 倍，同时淡出到 0。
     * 用 world 坐标（e.x/e.y），不跟 bob —— 它贴在地上，
     * 不该跟着敌人上下呼吸，否则会读成"漂浮"。
     */
    if (!dying && spawnT < 1) {
      const k = 1 - spawnT;
      ctx.save();
      ctx.globalAlpha = 0.45 * k;
      ctx.strokeStyle = '#D8B070';
      ctx.lineWidth = 1.5 / this.scale;
      ctx.beginPath();
      ctx.arc(e.x, e.y + h * 0.30, (sp.width * 0.5) * (1 + 0.9 * k), 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    /* 影子先画（在敌人本体下面） */
    this._drawShadow(ctx, e, sp, w, h, scaleMul, dying ? alpha * 0.55 : 0.39);

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.drawImage(sp, dx, dy, w * scaleMul, h * scaleMul);

    /*
     * 被电住时：整只敌人泛一层青蓝，并且轻微抖动。
     *
     * 这是"雷电阻挡前进"的**可读化**。光靠停住不动是不够的 ——
     * 敌人本来就有停手距离，静止不等于"被控住了"。
     * 泛蓝 + 抖动，观众才认得出"它现在是被钉住的"。
     */
    if (e.stunT > 0 && !dying) {
      const jitter = Math.sin(now / 22) * 1.2;
      ctx.save();
      ctx.globalAlpha = 0.55 + Math.sin(now / 40) * 0.25;
      ctx.globalCompositeOperation = 'lighter';
      ctx.drawImage(sp, dx + jitter, dy, w * scaleMul, h * scaleMul);
      ctx.restore();
    }

    /*
     * ===== 受击白闪 =====
     *
     * 上一版是"按 hurtT 线性淡出的 additive 叠加"，有两个问题：
     *
     *   1. 用 lighter 叠加，颜色是**加色**的 —— 在浅色背景或
     *      被电住的青蓝色之上再加白，会糊成一片过曝的方块，
     *      而不是"闪一下白"。
     *
     *   2. hurtT 由 director 按 dt*6 衰减（约 167ms），
     *      而雷电每 312ms 打一次。看起来好像不重叠，
     *      但只要链式命中打到同一个目标，两次白闪就会接在一起，
     *      敌人**一直亮着** —— 那就失去"这一下打中了"的信息量。
     *
     * 现在照 Hollow Knight 的做法（反编译 flashWhiteQuick）：
     *   - 纯白，总时长约 52ms（1ms 进 → 50ms 保持 → 1ms 出）
     *   - 用同一目标的**冷却**保证连击时不会常亮
     *
     * 冷却放在 renderer 侧（按敌人 id 记时间戳），因为
     * director 只管"被打到了"，不该关心"闪了几次"。
     */
    /* 按 F 可关闭全部受击闪烁（可访问性，见 main.mjs 的 FX） */
    const flashOn = !(this._fx && this._fx.flash === false);
    const flashA = flashOn ? this._flashAlpha(e, now) : 0;
    if (flashA > 0 && !dying) {
      ctx.save();
      ctx.globalAlpha = flashA;
      /*
       * 用 'source-atop' 而不是 'lighter'：只把**已经画上去的
       * 敌人像素**染白，不会加亮背景，也不会过曝。
       */
      ctx.globalCompositeOperation = 'source-atop';
      ctx.fillStyle = '#FFFFFF';
      ctx.fillRect(dx, dy, w * scaleMul, h * scaleMul);
      ctx.restore();
    }

    ctx.restore();

    /*
     * 血条：**所有敌人**都画，不只 BOSS。
     *
     * 用户的要求：「小怪身上至少得有他代表哪个任务的名称，
     * 并且最好是保留一秒钟（就算是瞬杀，血条也是呈现一秒钟
     * 快速消耗殆尽的感觉）」
     *
     * 所以即使是最小的 8×8 小兵也要有血条 ——
     * 不然"瞬杀"这个行为在画面上完全看不到。
     */
    this._drawHpBar(ctx, e, now, w, h, dying);

    /*
     * 名字：**所有敌人**都显示。
     *
     * 死亡期间（isDying）也要显示 —— 那正是观众需要看清"打死了什么"的时刻。
     * 只有展示期真正结束、尸体该消失时，名字才一起走。
     */
    if (!dying || e.isDying(now)) {
      this._drawName(ctx, e, now, w, h, dying);
    }
  }

  /**
   * 受击白闪的当前透明度。
   *
   * 时长与曲线照 Hollow Knight 的 flashWhiteQuick：
   * 总 52ms，几乎立刻满亮，保持约 50ms，极快收尾。
   *
   * ===== 为什么要按 id 记时间戳 =====
   *
   * 雷电链会同时打多个目标，而且每 312ms 一轮。
   * 如果只按 hurtT 画，目标连续挨打时白闪会首尾相接，
   * 看起来像"这只怪一直在发光"，玩家就读不出"又被打了一下"。
   *
   * 记 lastFlash[id] 之后，可以保证：
   *   - 每次被打都重新计时（信息不丢）
   *   - 但闪本身是短促的（52ms），中间必然有暗下去的间隙
   *
   * 同时这也是可访问性考虑：长时间高频闪烁对光敏人群不友好，
   * 短促且不连续的白闪风险低得多。
   */
  _flashAlpha(e, now) {
    if (!this._flashAt) this._flashAt = new Map();
    const prev = this._flashAt.get(e.id);
    /*
     * hurtT 是 director 的"刚被打到"信号（0..1 衰减）。
     * 只在它**往上跳**（新的一次命中）时重置白闪起点，
     * 否则一个持续衰减的 hurtT 会让白闪跟着拖长。
     */
    if (e.hurtT > 0 && (prev === undefined || now - prev > 60)) {
      this._flashAt.set(e.id, now);
      /*
       * Map 会随着敌人死亡无限增长 —— 尸体进 gone 之后没人清。
       * 这里做个粗暴但够用的上限：超过 512 条就整体清一次。
       * 不用精确 LRU 是因为这个 Map 只在小整数 id 上增长，
       * 512 条 × 8 字节 ≈ 4KB，清空的代价可以忽略。
       */
      if (this._flashAt.size > 512) this._flashAt.clear();
    }

    const t0 = this._flashAt.get(e.id);
    if (t0 === undefined) return 0;
    const age = now - t0;
    const DUR = 52;
    if (age < 0 || age >= DUR) return 0;
    /* 前 1ms 冲满，最后 8ms 收尾 —— 近似 HK 的 1/50/1 形状 */
    if (age < 1) return age / 1;
    if (age > DUR - 8) return (DUR - age) / 8;
    return 1;
  }

  /**
   * 敌人名字。
   *
   * 像素风里的文字不能真的用 6px 字体 —— 会糊。
   * 用 7px 等宽 + 黑色描边（在四角各画一次黑字再画一次亮字），
   * 这样在任何底色上都读得出来。
   */
  _drawName(ctx, e, now, w, h, dying) {
    const isBoss = e.tier === TIER.BOSS;
    const size = isBoss ? 9 : 7;
    const text = e.label;
    const yOff = dying ? 4 : 0;

    ctx.save();
    ctx.font = `${size}px ui-monospace, monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';

    const nx = e.x;
    const ny = e.y - h / 2 - 6 + yOff;

    // 描边：四向各偏移 1px 画黑字
    ctx.fillStyle = 'rgba(0,0,0,0.92)';
    for (const [ox, oy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
      ctx.fillText(text, nx + ox, ny + oy);
    }

    /*
     * 颜色按档位区分，观众一眼能分出小兵/精英/BOSS。
     * 死亡时变暗灰（表示已结束），但保持可读。
     */
    /* 品级配色也走 theme：换题材时名字颜色不该还留在旧世界观的色阶里 */
    let col = TIER_LABEL_COLORS[0];                        // 小兵
    if (e.tier === TIER.ELITE) col = TIER_LABEL_COLORS[1];  // 精英
    if (isBoss) col = TIER_LABEL_COLORS[2];                // BOSS
    if (dying) col = e.killed ? TIER_LABEL_COLORS.killed : TIER_LABEL_COLORS.failed;
    ctx.fillStyle = col;
    ctx.fillText(text, nx, ny);

    ctx.restore();
  }

  _drawHpBar(ctx, e, now, w, h, dying = false) {
    const ratio = e.hpRatio(now);
    /*
     * 血条宽度跟着体型走，但有下限 16px ——
     * 小兵只有 8×8，如果按 w*0.9 画就只有 7px，看不清掉血过程。
     */
    const bw = Math.max(16, w * 0.95);
    const bh = 3;
    const bx = e.x - bw / 2;
    /*
     * 名字在最上面，血条紧贴名字下面。
     * 顺序：名字 → 血条 → 敌人本体（自上而下）。
     */
    const by = e.y - h / 2 - 4;

    // 底槽
    ctx.fillStyle = 'rgba(0,0,0,0.62)';
    ctx.fillRect(bx - 1, by - 1, bw + 2, bh + 2);

    /*
     * 血条颜色：绿 → 黄 → 红。
     *
     * 注意：这只是**预估进度**的可视化。
     * 血条空了敌人也不会死 —— 见 director.mjs 的说明。
     */
    let col = '#4fbf62';
    if (ratio < 0.55) col = '#d8b23a';
    if (ratio < 0.25) col = '#d8483a';

    // 超时（血条已空）时用闪烁的暗红，表示"拖太久了"
    if (ratio <= 0) {
      const blink = 0.45 + 0.35 * Math.sin(this._t * 9);
      ctx.globalAlpha = blink;
      ctx.fillStyle = '#8a2020';
      ctx.fillRect(bx, by, bw, bh);
      ctx.globalAlpha = 1;
    } else {
      ctx.fillStyle = col;
      ctx.fillRect(bx, by, bw * ratio, bh);
    }
  }

  /* ---------------- 植保盾牌 ---------------- */

  _drawAegis(ctx, p, now) {
    /*
     * 三帧动画：待机 / 蓄能 / 开火。
     *
     * p.swing 是当前攻击的相位，来自 main.mjs 的**真实攻击计数**。
     * 两帧交替是为了让蓄能/开火看得见 —— 攻击动作必须看得见，
     * 否则观众只会觉得守望舰站着不动、敌舰莫名其妙掉血。
     *
     * 帧名一律从 theme 的角色表取（ROLES.hero.*），
     * 不在逻辑里写 `sprites.aegisIdle` 这类硬编码键名。
     */
    let sp = this.sprites[ROLES.hero.idle];
    const swinging = p.swingT > 0;
    if (swinging) {
      sp = (Math.floor(p.swing) % 2 === 0)
        ? this.sprites[ROLES.hero.strike]
        : this.sprites[ROLES.hero.wind];
    }

    const w = sp.width;
    const h = sp.height;

    // 只有在完全站住时才做呼吸浮动；移动/挥击时不要
    const moving = !!p.moving;
    /*
     * ===== 呼吸：挤压，不是上下平移 =====
     *
     * 《土豆兄弟》的待机动画在反编译资源里是一段贝塞尔 tween：
     *
     *   position:y   -24 → -19 → -24     （下沉 5px，不是上跳）
     *   scale:x       1  → 1.15 → 1
     *   scale:y       1  → 0.85 → 1
     *
     * 也就是说它**不是**"上下浮动"，而是"蹲一下"：
     * 往下沉、同时横向撑开、纵向压扁，再弹回。
     * 这是 Brotato 角色辨识度的一部分 —— 像是活的、有体积的东西在呼吸，
     * 而不是一张图在滑上滑下。
     *
     * 上一版是纯 sin 上下平移，看起来像贴在屏幕上滑动。
     *
     * 周期：Brotato 原版 1 秒，本项目调慢到约 2.4 秒 ——
     * 画面上同时有十几个敌人，1 秒一次的呼吸会显得躁。
     *
     * 只在**完全站住**时呼吸。移动或施法时有别的动作，再叠呼吸会乱。
     */
    const breathe = (swinging || moving) ? 0 : Math.sin(this._t * 2.6);
    /* 向下沉 0..2px（Brotato 是体高的 ~7%，26px sprite 约 1.8px） */
    const idleBob = breathe > 0 ? breathe * 1.8 : 0;
    /* 横向撑开、纵向压扁：±6%（Brotato 是 ±15%，小 sprite 上要收敛） */
    const sxMul = 1 + (breathe > 0 ? breathe * 0.06 : 0);
    const syMul = 1 - (breathe > 0 ? breathe * 0.055 : 0);

    /*
     * ===== 朝向：往哪走就朝哪边 =====
     *
     * 视觉复核抓到的缺失：这段代码原来根本没写。
     * 盾牌一直面朝正下方"滑行" —— 尤其逃跑时明明在往后退，
     * 脸还朝前，非常假。
     *
     * 用水平速度判断朝向，而不是用"目标方向"：
     * 边退边打时人是背着敌人跑的，脸朝**移动方向**才对。
     *
     * 像素风的转身用**水平翻转**（scale(-1,1)），不用旋转 ——
     * 旋转会让像素块落在非整数角度上，糊掉。
     */
    /*
     * 只有**往左走**才翻转。
     *
     * 这里原来写成 `if (flip)`，而 flip 是 |vx| > 8 —— 只看速度大小不看方向，
     * 于是往左往右都镜像，两种朝向渲染出来一模一样。
     *
     * 视觉复核用 134 对左右帧做逐像素比对抓到了：
     * 直接比对 MAD 0.47、镜像比对 MAD 13.26 —— 镜像反而差 28 倍，
     * 说明根本没有翻转。`faceLeft` 算出来之后从没被用过，是死变量。
     *
     * 这和之前 target() 的病根是同一个：
     * **判定变量算出来了，但没接进真正消费它的地方。**
     * 那种 bug 不会被任何语法/类型检查发现，只有真去看画面才会露。
     */
    const faceLeft = moving && p.vx < -8;

    /*
     * 挤压时以**脚底**为锚点缩放，不是以中心。
     *
     * 以中心缩放的话，蹲下去身体上半部分也会跟着往下降，
     * 看起来像整张图缩小了；以脚底缩放才是"踩在地上蹲一下"。
     */
    const dw = w * sxMul;
    const dh = h * syMul;
    const drawX = p.x - dw / 2;
    const drawY = p.y + (h / 2) - dh + idleBob;

    /* ===== 剑尖的真实屏幕位置（近战判定与刀光起点要用它）=====
     *
     * 这里必须处理镜像：短剑在 sprite 的**右侧**，
     * 一旦 faceLeft 把整张图水平翻转，剑尖在屏幕上就跑到了左侧。
     *
     * 直接按**未翻转**坐标算的话，盾牌朝左时就朝空气挥刀，
     * 横向偏 20 多像素。这个 bug 不报错、断言也不一定抓到 ——
     * 只有真看画面才露。所以由绘制处算好坐标存下来，
     * 攻击特效只消费结果。
     *
     * 三个姿态的剑尖不同（垂手 / 抬起 / 平捅），
     * 所以按当前姿态取，不用单一常量。
     */
    const pose = swinging ? (Math.floor(p.swing) % 2 === 0 ? 'strike' : 'wind') : 'idle';
    const tipLocal = swordTip(pose);
    const tipUnitX = faceLeft ? (w - tipLocal.x) : tipLocal.x;
    this._tip = {
      x: drawX + tipUnitX * sxMul,
      y: drawY + tipLocal.y * syMul,
    };

    ctx.save();

    if (faceLeft) {
      // 以盾牌中心为轴水平镜像
      ctx.translate(p.x, 0);
      ctx.scale(-1, 1);
      ctx.translate(-p.x, 0);
    }

    ctx.drawImage(sp, drawX, drawY, dw, dh);

    ctx.restore();

    /*
     * ===== 逃跑速度线 =====
     *
     * 视觉复核确认这段也没写。不加的话，观众只看得出"盾牌在动"，
     * 看不出它在**躲** —— 而"边逃边打"是这个项目的核心观感。
     *
     * 画在运动方向的反侧（也就是身后），三条短平行线。
     * 偏移量按速度给，跑得越快拖得越长。
     */
    if (p.fleeing && moving) {
      const sp2 = Math.hypot(p.vx, p.vy) || 1;
      const bx = -p.vx / sp2;   // 身后方向
      const by = -p.vy / sp2;
      // 垂直于运动方向，用来把三条线并排
      const px = -by;
      const py = bx;

      ctx.save();
      ctx.globalAlpha = 0.55;
      ctx.strokeStyle = '#e0c088';
      ctx.lineWidth = 1;
      for (let i = -1; i <= 1; i++) {
        const ox = px * i * 4;
        const oy = py * i * 4;
        ctx.beginPath();
        ctx.moveTo(p.x + ox + bx * 6, p.y + oy + by * 6);
        ctx.lineTo(p.x + ox + bx * 13, p.y + oy + by * 13);
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  /* ---------------- 特效 ---------------- */

  /**
   * 画雷电链。数据来自 director.lightning，不是自己造的。
   *
   * ===== 为什么从弹道改成雷电 =====
   *
   * 用户改需求：「不要枪了，改成法杖吧……法杖设定是可以有多条
   * 雷电链造成伤害的」。
   *
   * 上一版是"枪口闪光 + 一条直线弹道"。换成法杖之后，
   * 直线弹道就不成立了 —— 杖不打子弹。而雷电的视觉语言完全不同：
   *
   *   1. **折线，不是直线**。闪电永远在抖。
   *   2. **蓝白发光**，不是黄色火药光。
   *   3. **有分叉**，一条主链旁边抖出几根细须。
   *   4. **一闪就没**（0.18 秒），不是拖着飞过去。
   *
   * ===== 折线怎么抖 =====
   *
   * 沿 A→B 连线采样 N 段，每一段在中点沿**法线方向**随机偏移。
   * 偏移量按段数衰减（越靠近目标越准），这样看起来像"劈向"目标，
   * 而不是"乱成一团"。
   *
   * 随机数用**帧时间做种子**的确定性伪随机：同一帧内画出的形状稳定，
   * 不会因为多画一次就换形状（那会导致闪烁抖动）。
   */
  _drawStrikes(ctx, now) {
    const list = this.lightning;
    for (const l of list) {
      const age = now - l.bornAt;

      /*
       * ===== 处决雷 vs 普通雷 =====
       *
       * 处决雷（l.exec）是"敌人为什么死"的唯一可见解释。
       * 用户的要求：
       *   「完成任务的时候有个处决特效，秒杀剩余血量」
       *
       * 所以它必须在视觉上和普通雷明显不同，否则观众分不出
       * "这只是掉了点血"和"这一下把它打死了"：
       *
       *   普通雷：180ms，细，一闪而过 —— 那是消耗
       *   处决雷：420ms，粗 2.4 倍，白得发蓝，落点有爆环
       */
      const exec = !!l.exec;
      const life = exec ? 420 : 180;
      if (age < 0 || age > life) continue;

      /*
       * 亮度曲线：前 40% 冲亮，后面快速衰减。
       * 闪电是"先亮后灭"，不是线性淡出。
       */
      const k = age / life;
      let a = k < 0.4 ? 1 : 1 - (k - 0.4) / 0.6;
      if (a <= 0) continue;

      /*
       * 处决雷额外做一个"落下前的强闪"：前 15% 更亮，
       * 而且宽度随 execWeight（剩余血量）加重。
       *
       * execWeight 来自 director：血条剩得越多，说明这一下
       * 清掉的量越大，处决越重 —— 视觉上读得出"秒杀了多少血"。
       */
      const weight = exec ? 1 + (l.execWeight ?? 0) * 0.8 : 1;
      if (exec && k < 0.15) a = 1;

      /*
       * 起点 = 剑尖。由 _drawAegis 算好存在 _tip。
       * 不抄魔法数字 —— 否则改了 sprite 雷还从旧位置出来。
       */
      /*
       * 起点 = 上一帧记下的杖顶真实位置（_drawPotato 负责算）。
       *
       * 不再自己从 l.fromX/fromY 反推 —— 那样无法知道 sprite 有没有镜像。
       * 万一这一帧还没画过盾牌（理论上不会，盾牌在攻击之前画），
       * 退回盾牌中心，宁可少偏一点也不要砍到空白处。
       */
      const tip = this._tip || { x: l.fromX, y: l.fromY - 8 };
      let ax = tip.x;
      let ay = tip.y;

      for (const b of l.bolts) {
        this._slash(ctx, ax, ay, b.x, b.y, a, b.strength ?? 1, now, k, {
          exec,
          width: weight,
        });
        ax = b.x;
        ay = b.y;
      }

      /*
       * 处决落点：一圈冲击环 + 一道竖直光柱。
       *
       * 光柱是"从天而降"的暗示 —— 处决不是从法杖侧面飘过去的，
       * 而是砸下来的。冲击环让落点有分量。
       */
      if (exec) {
        const last = l.bolts[l.bolts.length - 1];
        this._execFx(ctx, last.x, last.y, a, k, weight);
      }
    }
  }

  /** 主角 sprite 的缩放（攻击起点要跟着 sprite 走）。 */
  _aegisScale() {
    const sp = this.sprites && this.sprites[ROLES.hero.idle];
    if (!sp) return 1;
    // sprite 被烘成 1x，绘制时按原尺寸画，所以缩放就是 1。
    // 留这个方法是为了以后改绘制尺寸时不用到处找。
    return 1;
  }

  /**
   * 处决落点特效：竖直光柱 + 冲击环 + 中心爆点。
   *
   * ===== 为什么需要这一层 =====
   *
   * 用户的原话：
   *   「还是有些小怪没被电到就直接挂了……完成任务的时候
   *     有个处决特效，秒杀剩余血量，这会比较符合逻辑」
   *
   * 只把雷画粗一点不够 —— 粗雷和细雷都是"电它一下"，
   * 观众分辨不出"掉点血"和"这一下死了"。
   * 处决需要**独立的视觉语言**：从天降下的光柱 + 落点炸开。
   *
   * 这也是把"血条没空就死"解释清楚的唯一办法：
   * 让死亡有一个比血条更重的可见原因。
   *
   * @param a     当前亮度 0..1
   * @param k     生命进度 0..1
   * @param weight 剩余血量加权（越大处决越重）
   */
  /**
   * 处决/斩杀落点特效：冲击环 + 中心爆点 + 一道横向斩痕。
   *
   * ===== 为什么必须有一个和"掉血"明显不同的特效 =====
   *
   * 用户的原始要求（沿用 potato/ 那条铁律）：
   *   「完成任务的时候有个处决特效，秒杀剩余血量」
   *
   * 平时挨刀只削一小块血条，真正死亡时才有这一下。
   * 如果两者视觉一样，观众就分不出"掉点血"和"这一下死了"，
   * 那条"血条归零不等于死亡"的规则就白写了。
   *
   * ===== 换成近战之后的形态 =====
   *
   * 原来是"竖直光柱从天而降"。近战武器不会从天上砸东西，
   * 所以改成**一道横贯的斩痕**：刀刃扫过去留下的那条线，
   * 加上落点的冲击环和爆点。
   *
   * 颜色也从蓝改成暖金（#e8a24a）—— 冷白+蓝是电弧的语言，
   * 暖金才是"刀砍断了什么东西"的语言。
   */
  _execFx(ctx, x, y, a, k, weight) {
    const w = Math.max(1, weight);

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';

    /*
     * 1) 横贯斩痕：一条从左上扫到右下的粗线，前 35% 最亮。
     *    这是"刀刃经过"的痕迹，给落点一个方向感。
     */
    const cutLen = 16 + w * 7;
    const cutA = Math.max(0, (1 - k * 1.25)) * a;
    if (cutA > 0.01) {
      const g = ctx.createLinearGradient(x - cutLen, y - cutLen * 0.45, x + cutLen, y + cutLen * 0.45);
      g.addColorStop(0, 'rgba(255,228,170,0)');
      g.addColorStop(0.35, `rgba(255,236,190,${0.85 * cutA})`);
      g.addColorStop(0.55, `rgba(255,255,255,${cutA})`);
      g.addColorStop(1, 'rgba(232,162,74,0)');
      ctx.strokeStyle = g;
      ctx.lineWidth = (2.0 + w * 1.8) * (1 - k * 0.5);
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(x - cutLen, y - cutLen * 0.45);
      ctx.lineTo(x + cutLen, y + cutLen * 0.45);
      ctx.stroke();
    }

    /*
     * 2) 冲击环：半径随生命扩大，透明度衰减。
     *    这是"炸开"的部分，给落点分量。
     */
    const ringR = 4 + k * 26 * w;
    const ringA = Math.max(0, (1 - k) * 0.85 * a);
    if (ringA > 0.01) {
      ctx.strokeStyle = `rgba(255,222,168,${ringA})`;
      ctx.lineWidth = 2.2 * (1 - k) + 0.6;
      ctx.beginPath();
      ctx.arc(x, y, ringR, 0, Math.PI * 2);
      ctx.stroke();
    }

    /*
     * 3) 中心爆点：刚开始几帧最亮的一个暖白团。
     */
    if (k < 0.35) {
      const br = (6 + w * 5) * (1 - k / 0.35);
      const g2 = ctx.createRadialGradient(x, y, 0, x, y, Math.max(1, br));
      g2.addColorStop(0, `rgba(255,255,255,${a})`);
      g2.addColorStop(0.4, `rgba(255,214,150,${0.7 * a})`);
      g2.addColorStop(1, 'rgba(200,120,40,0)');
      ctx.fillStyle = g2;
      ctx.beginPath();
      ctx.arc(x, y, Math.max(1, br), 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.restore();
  }

  /**
   * 画一道**斩击**：一弯月牙形的刀光 + 刀尖亮斑。
   *
   * ===== 为什么从闪电改成斩击 =====
   *
   * 主角从"举法杖放雷电的土豆"换成了"只带近战武器的植保盾牌"。
   * 雷电会拐弯、会分叉、会在空中连跳 —— 那是法术的视觉语言。
   * 近战不是这样：一刀下去就是一道**单向的弧**，
   * 弧的运动方向就是挥砍方向，弧的粗细跟着武器走。
   *
   * 所以这里不再画折线，改画：
   *   1. 一条从起点扫向目标的**弧**（用二次曲线 + 垂直方向的弧度）
   *   2. 弧的头部比尾部亮且粗 —— 那是刀锋在动的方向
   *   3. 落点一个亮斑，表示命中
   *
   * 折线里那些"抖动"在这里全部去掉：刀不抖。
   * 取而代之的是**弧度的松紧**，由距离决定 ——
   * 贴身砍是短促的一道，够远了才是一整弯。
   */
  _slash(ctx, x0, y0, x1, y1, alpha, strength, now, ageK, opts = {}) {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len;
    const uy = dy / len;
    /* 法线：弧朝这一侧鼓出去 */
    const nx = -uy;
    const ny = ux;

    /*
     * 弧的鼓起量。
     * 距离越远鼓得越多，但有上限 —— 否则贴脸砍会画成一条大弧，
     * 看起来像在挥空。
     */
    const bow = Math.min(opts.exec ? 13 : 8, len * 0.24);

    /*
     * 生命曲线：刀光是"唰"一下出现再收快门。
     * 前 25% 冲到最亮，之后快速衰减并向外扩 —— 刀在走。
     */
    const k = Math.min(1, Math.max(0, ageK));
    const grow = 1 + k * 0.55;
    const fade = k < 0.25 ? 1 : Math.max(0, 1 - (k - 0.25) / 0.75);
    const a = alpha * fade;
    if (a <= 0.01) return;

    const mul = opts.width || 1;

    /* 三段色：外辉光 → 刃身 → 刃口高光。近战是冷白色，不是蓝电。 */
    const [outerCol, midCol, edgeCol] = opts.exec ? SLASH_COLORS.exec : SLASH_COLORS.blade;
    const layers = opts.exec
      ? [
        { w: 10.0 * mul, col: outerCol, a: 0.30 },
        { w: 5.0 * mul, col: midCol, a: 0.72 },
        { w: 1.9 * mul, col: edgeCol, a: 1.00 },
      ]
      : [
        { w: 5.4, col: outerCol, a: 0.26 },
        { w: 2.6, col: midCol, a: 0.60 },
        { w: 1.0, col: edgeCol, a: 0.96 },
      ];

    /* 弧的控制点：中点沿法线推出去 */
    const mx = (x0 + x1) / 2 + nx * bow;
    const my = (y0 + y1) / 2 + ny * bow;
    /* 终点随生命外扩一点 */
    const ex = x0 + dx * grow;
    const ey = y0 + dy * grow;

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';

    for (const L of layers) {
      ctx.globalAlpha = a * L.a;
      ctx.strokeStyle = L.col;
      ctx.lineWidth = L.w;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.quadraticCurveTo(mx, my, ex, ey);
      ctx.stroke();
    }

    /*
     * 刃口亮斑：只在弧的中前段出现，是"刀锋当前位置"。
     * 用亮点而不是整条发光，读起来才是"一下划过去"。
     */
    if (k < 0.7) {
      const tp = 0.35 + k * 0.75;
      const qx = (1 - tp) * (1 - tp) * x0 + 2 * (1 - tp) * tp * mx + tp * tp * ex;
      const qy = (1 - tp) * (1 - tp) * y0 + 2 * (1 - tp) * tp * my + tp * tp * ey;
      const r = (opts.exec ? 5.5 : 3.2) * (1 - k * 0.6);
      const g2 = ctx.createRadialGradient(qx, qy, 0, qx, qy, Math.max(1, r * 2.4));
      g2.addColorStop(0, `rgba(255,255,255,${a})`);
      g2.addColorStop(0.45, opts.exec
        ? `rgba(255,214,150,${0.65 * a})`
        : `rgba(210,230,245,${0.55 * a})`);
      g2.addColorStop(1, 'rgba(120,140,160,0)');
      ctx.fillStyle = g2;
      ctx.beginPath();
      ctx.arc(qx, qy, Math.max(1, r * 2.4), 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.restore();
  }


  /** 分叉的端点：从主链上某点朝侧上方抖一小段。 */
  _branchPoint(from, seed) {
    let s = (seed * 31 + 17) & 0x7fffffff;
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const ang = (s / 0x7fffffff) * Math.PI * 2;
    const len = 4 + (s % 5);
    return { x: from.x + Math.cos(ang) * len, y: from.y + Math.sin(ang) * len };
  }

  /** 加一个飘字。-1 / KILL / MISS */
  /**
   * 加一条飘字。
   *
   * ===== 为什么要随机水平偏移 =====
   *
   * 同一个敌人连续挨打时，飘字都从同一个 x 出发，会**完全重叠**
   * 成一条看不清的亮线。两份独立实现（Godot 的 floating-damage-numbers、
   * gamecn 的 damage-numbers）都专门处理了这一点，原文说得很好：
   *   "The small random x-jitter matters more than it looks:
   *    without it, ten hits on the same enemy stack into one
   *    unreadable blur."
   *
   * 偏移量取 ±12px（照抄那份 Godot 实现的 randf_range(-12, 12)）。
   *
   * @param opts { scale, vy, life, drift }
   */
  addFloater(x, y, text, color, opts = {}) {
    this.floaters.push({
      x,
      y,
      text,
      color,
      /*
       * 用**真实时间戳**而不是每帧 += 1/60 的累加器。
       *
       * 浏览器实测发现：按 1/60 累加时，75Hz 屏幕上一秒跑 75 帧，
       * 于是寿命 0.55s 的飘字实际只活了 413ms —— 快了 25%。
       * 同理"前 0.15s 不淡出"实际只有 120ms。
       *
       * 这类 bug 在 60Hz 上完全看不出来，换台显示器就变样了。
       * 记 bornAt 和读取时的 now 相减，就跟帧率无关了。
       */
      bornAt: this._t * 1000,
      t: 0,
      /*
       * 水平抖动：让同一位置的连击数字**扇形散开**。
       * 用 ±12，配合 34px 的上升高度，视觉上刚好不重叠也不太散。
       */
      drift: opts.drift ?? (Math.random() * 2 - 1) * 12,
      vx: opts.vx ?? 0,
      vy: opts.vy ?? -34,
      life: opts.life ?? 0.55,
      scale: opts.scale ?? 1,
      /* 起始放大：暴击/击杀用 1.4，普通 1.0 */
      pop: opts.pop ?? 1,
    });
    if (this.floaters.length > 60) this.floaters.shift();
  }

  /** 加一片血迹。 */
  addStain(x, y, color) {
    this.stains.push({
      x, y,
      r: 1.5 + Math.random() * 2.5,
      c: color,
      a: 0.28 + Math.random() * 0.2,
    });
    if (this.stains.length > 220) this.stains.shift();
  }

  /**
   * 画飘字。
   *
   * ===== 运动曲线照 Godot 那份实现 =====
   *
   *   终点 = 起点 + (随机 ±12, -34)
   *   时长 = 0.55s，TRANS_QUAD / EASE_OUT   ← 缓出，不是线性
   *   缩放 = 1.4(暴击) → 1.0，0.18s 内收敛
   *   透明 = 前 0.15s 保持全不透明，之后才淡出
   *
   * 几个细节的用意：
   *
   * **缓出而不是线性**：数字刚出现时走得快、然后减速停住，
   * 读起来像"被弹出来的"。线性上升看起来像电梯。
   *
   * **前 0.15s 不淡出**：那 150ms 正好是眼睛捕捉数字的时间窗口。
   * 一出现就开始淡出的话，最该看清的那几帧反而最模糊。
   *
   * **缩放从 1.4 收敛**：这是"弹出感"的来源（scale punch）。
   * 只有暴击/击杀用，普通命中保持 1.0 —— 全是 1.4 的话
   * 满屏数字都在跳，反而吵。
   */
  _drawFloaters(ctx, now) {
    for (let i = this.floaters.length - 1; i >= 0; i--) {
      const f = this.floaters[i];
      /* 真实经过时间（秒），与帧率无关 */
      f.t = Math.max(0, (now - f.bornAt) / 1000);

      if (f.t >= f.life) { this.floaters.splice(i, 1); continue; }

      const k = f.t / f.life;
      /* 缓出：1 - (1-k)² */
      const ease = 1 - (1 - k) * (1 - k);
      const px = f.x + f.drift * ease;
      const py = f.y + f.vy * ease;

      /*
       * 缩放：pop → 1.0，在 0.18s 内收敛。
       * 之后保持 1.0，不要继续缩 —— 数字缩小会显得"飞远了"，
       * 而我们要的是"停在原地让你读"。
       */
      let sc = 1;
      if (f.pop > 1) {
        const pt = Math.min(1, f.t / 0.18);
        sc = f.pop + (1 - f.pop) * (1 - (1 - pt) * (1 - pt));
      }
      sc *= f.scale;

      /* 透明：前 0.15s 全不透明，剩余时间线性淡出 */
      const fadeStart = 0.15;
      let alpha = 1;
      if (f.t > fadeStart) {
        alpha = Math.max(0, 1 - (f.t - fadeStart) / Math.max(0.01, f.life - fadeStart));
      }

      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.font = `${Math.round(7 * sc)}px ui-monospace, monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';

      /* 描边：四向各 1px 黑，保证在任何底色上都能读 */
      ctx.fillStyle = '#000000';
      for (const [ox, oy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
        ctx.fillText(f.text, px + ox, py + oy);
      }
      ctx.fillStyle = f.color;
      ctx.fillText(f.text, px, py);

      ctx.restore();
    }
  }

  /* ---------------- 屏幕层 ---------------- */

  _drawOverlay(ctx, s) {
    const d = s.director;
    const now = s.now;

    /*
     * 顶部：BOSS 在跑的时候，画一条横贯屏幕的大血条。
     * 用户原话「他的血条就是子智能体预估的进度条」——
     * 所以这条的血量含义就是"预估进度"，不是真实 HP。
     */
    const boss = d.enemies.find((e) => e.tier === TIER.BOSS && e.diedAt === null);
    if (boss) {
      const W = this.cv.width;
      const ratio = boss.hpRatio(now);

      /*
       * 血条要避开左上角的 HUD 文字。这里改过两版，两次都是同一个教训。
       *
       * v1（原始）：bw=62%、bx=(W-bw)/2
       *   1280 宽下血条从 x=264 开始，而 #hudLine1 占到 x=278，
       *   重叠 14px，文字压在满亮度红条上，对比度 3.8:1。
       *
       * v2：bx 钳到 max(W*0.26, 居中)
       *   1280 宽下修好了（间隙 54px），但 1024 宽下
       *   W*0.26=266 又跑回 HUD 的 278 底下 —— 对比度掉到 3.04:1。
       *
       * v2 错在哪：**用相对量去避让绝对布局。**
       *   HUD 是 `left:12px` + 文本宽度（绝对像素，不随视口缩放），
       *   而 W*0.26 是屏幕宽度的比例。
       *   视口越窄，比例值越小，但 HUD 的右边界纹丝不动 —— 必然交叉。
       *   （实测交叉点就在 W≈1071）
       *
       * v3（现在）：**直接读出 HUD 的真实右边界。**
       *   布局里有什么就用什么，不再猜一个比例。
       *   这样无论视口多窄、字号怎么变，血条都会让开。
       *   极端窄屏下血条会被压得很短，但那是正确取舍：
       *   信息（HUD 文本）优先于装饰（血条宽度）。
       */
      const hudEl = typeof document !== 'undefined'
        ? document.getElementById('hudLine1')
        : null;
      let hudRightCss = 0;
      if (hudEl && typeof hudEl.getBoundingClientRect === 'function') {
        const r = hudEl.getBoundingClientRect();
        if (r && r.right > 0) hudRightCss = r.right;
      }
      // CSS px → 画布 px
      const hudRight = hudRightCss * this.dpr;
      const GAP = 16 * this.dpr;

      const bw = Math.round(W * 0.58);
      const minX = Math.round(hudRight + GAP);
      const bx = Math.max(minX, Math.round((W - bw) / 2));

      // 右边留 3% 边距；如果左右都挤（极窄屏），优先保证最小可用宽度
      let bwFinal = Math.min(bw, W - bx - Math.round(W * 0.03));
      if (bwFinal < 80 * this.dpr) bwFinal = Math.max(0, W - bx - Math.round(W * 0.02));

      const by = Math.round(18 * this.dpr);

      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fillRect(bx - 3, by - 3, bwFinal + 6, 10 * this.dpr + 6);

      ctx.fillStyle = '#3a1414';
      ctx.fillRect(bx, by, bwFinal, 10 * this.dpr);

      ctx.fillStyle = boss.isOverdue(now) ? '#8a2020' : '#c8392b';
      ctx.fillRect(bx, by, bwFinal * ratio, 10 * this.dpr);

      // 预估进度刻度：每 25% 一条
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      for (let i = 1; i < 4; i++) {
        ctx.fillRect(bx + (bwFinal * i) / 4, by, Math.max(1, this.dpr), 10 * this.dpr);
      }

      ctx.font = `${Math.round(9 * this.dpr)}px monospace`;
      ctx.textAlign = 'center';
      ctx.fillStyle = '#f0e6cc';
      const secs = boss.ageSec(now).toFixed(1);
      const tag = boss.isOverdue(now) ? COPY.bossBar.overdue : COPY.bossBar.estimate;
      ctx.fillText(`${boss.label} · ${secs}s · ${tag}`, bx + bwFinal / 2, by + 10 * this.dpr + 14 * this.dpr);
    }

    /*
     * 本轮已结束的横幅。
     * 成功 = 清场（这是用户要的"最终击杀"）；失败 = 没打赢，敌人还在。
     */
    if (d.turnDone) {
      const W = this.cv.width;
      const H = this.cv.height;
      ctx.save();
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      if (d.turnOk) {
        ctx.fillStyle = 'rgba(0,0,0,0.42)';
        ctx.fillRect(0, H / 2 - 40 * this.dpr, W, 80 * this.dpr);
        ctx.font = `bold ${Math.round(20 * this.dpr)}px monospace`;
        ctx.fillStyle = '#f2c14e';
        /* 文案走 theme：换题材时这句横幅不该还写着旧世界观的词 */
        ctx.fillText(COPY.banner.win, W / 2, H / 2 - 6 * this.dpr);
        ctx.font = `${Math.round(9 * this.dpr)}px monospace`;
        ctx.fillStyle = '#d8ccb0';
        ctx.fillText(
          fill(COPY.banner.winDetail, { kills: d.kills, failures: d.failures, swings: d.swings }),
          W / 2, H / 2 + 18 * this.dpr,
        );
      } else {
        ctx.fillStyle = 'rgba(0,0,0,0.42)';
        ctx.fillRect(0, H / 2 - 30 * this.dpr, W, 60 * this.dpr);
        ctx.font = `bold ${Math.round(16 * this.dpr)}px monospace`;
        ctx.fillStyle = '#e07a6a';
        ctx.fillText(COPY.banner.lose, W / 2, H / 2);
      }
      ctx.restore();
    }
  }
}
