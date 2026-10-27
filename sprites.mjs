/**
 * 像素 sprite 工厂 —— 全部程序化生成，零外部素材。
 *
 * ===== 这一版换了题材：星海防线 =====
 *
 * 主角：**守望舰**（只带轨道炮，指向右），三态 idle / wind / strike。
 * 小兵：**侦察无人机**（scoutDrone）—— 小型、最快、数量最多。
 * 精英：**突击舰**（assaultShip）/ 布雷舰（minelayer）/ 轻僚机（wingDrone）
 *       —— 三档都明显比小兵大一圈。
 * BOSS：**母舰**（mothership）—— 整场最大的东西。
 * 兜底：**unknown** —— 中性菱形，不假装它是什么。
 *
 * ===== 题材归属：显示名与角色映射在 theme.mjs =====
 *
 * 这个文件只负责**点阵本身**。哪个角色用哪个 sprite、三级分别叫什么，
 * 全部在 theme.mjs 的 SPRITE_ROLES / TIER_THEME 里。
 * 换题材 = 改 theme 配置 + 在这里加一套点阵，**不动 render / director / main**。
 *
 * 内部标识符 `AEGIS_*` / `SWORD_TIP` 保持原名：它们是协议稳定项
 * （render 与 _refs 的共享契约，跨文件约 45 处引用），
 * 改名只会制造大面积 churn 而没有任何收益。变的只是它们画的是什么。
 *
 * ===== 一个像素风的硬规则 =====
 *
 * 一切绘制都在 1x 世界坐标里做，最后用 imageSmoothingEnabled = false
 * 和整数缩放放大到屏幕。半像素坐标、非整数缩放会让像素糊掉。
 *
 * bake() 逐字符查表，**键必须单字符**。lintSprites() 里有检查。
 */

/*
 * 调色板：字符 → 颜色。'.' = 透明。
 *
 * 色值来自 theme.mjs 的 PALETTE（题材配色单一真相源）。
 * 这里 re-export 出去，是为了让 bake()/lintSprites() 与调色板
 * 永不脱节 —— 两边各写一份色值时，改一边另一边会静默失效。
 *
 * 这里只保留**键的类型说明**，实际色值一律以 theme 为准。
 */
import { PALETTE, SPRITE_ROLES, SLASH_COLORS } from './theme.mjs';

const PAL = PALETTE;

/* ============================================================
 *  主角：守望舰（26×26，三帧同尺寸，炮口朝右）
 * ============================================================ */

/*
 * 守望舰的造型依据（要让"这是一艘舰"读得出来，不是一团方块）：
 *
 *   - **左宽右窄**：舰尾是宽的引擎舱区，向右收窄成舰首。
 *     反过来（右宽）会读成"在倒车"。
 *   - **上下分层**：上壳 H（亮）/ 腰线 h / 下壳 g→G（暗），
 *     三层让平面读成曲面。单一色会像一张贴纸。
 *   - **引擎口在最左**：青蓝 C/c 三阶，是唯一的高饱和冷光，
 *     立刻区分"这是友方"。
 *   - **座舱是一块横窗**（不是两只圆眼睛）：它是一台设备，不是一张脸。
 *   - **轨道炮在右侧**，三态：
 *       idle   炮管收在舰内，炮口齐平舰首
 *       wind   炮管抬起蓄能（蓄能球在右上方）
 *       strike 炮管前伸 + 炮口暖金闪光
 *
 * 三帧**必须同尺寸**（26×26），否则切帧时 sprite 会跳一下。
 * 炮口位置见 SWORD_TIP —— 那个常量必须与点阵严格一致。
 */

const AEGIS_IDLE = [
  '..........................',
  '..........................',
  '..........................',
  '..........................',
  '..........................',
  '..........................',
  '.....kkkkkkkkkk...........',
  '....kHHHHHHHHHHkk.........',
  '...kHHHHHHHHHHHHHkk.......',
  '..khhhhhhhhhheeeehhk......',
  '.kchhhhhhhhhheeeehhhk.....',
  '.kchhhhhhhhhhhhhhhhhhk....',
  '.kchhhhhhhhhhhhhhhhhhY....',
  '.kChhhhhhhhhhhhhhhhhhY....',
  '.kchhhhhhhhhhhhhhhhhhk....',
  '.kchhhhhhhhhhhhhhhhhhk....',
  '.kchhhhhhhhhhhhhhhhhk.....',
  '..kggggggggggggggggk......',
  '...kgggggggggggggkk.......',
  '....kGGGGGGGGGGkk.........',
  '.....kkkkkkkkkk...........',
  '..........................',
  '..........................',
  '..........................',
  '..........................',
  '..........................',
];

const AEGIS_WIND = [
  '..........................',
  '..........................',
  '..........................',
  '..........................',
  '..........................',
  '...................c......',
  '.....kkkkkkkkkk....CW.....',
  '....kHHHHHHHHHHkk..Ch.....',
  '...kHHHHHHHHHHHHHkk.h.....',
  '..khhhhhhhhhheeeehhkk.....',
  '.kchhhhhhhhhheeeehhhk.....',
  '.kchhhhhhhhhhhhhhhhhhk....',
  '.kchhhhhhhhhhhhhhhhhhk....',
  '.kChhhhhhhhhhhhhhhhhhk....',
  '.kchhhhhhhhhhhhhhhhhhk....',
  '.kchhhhhhhhhhhhhhhhhhk....',
  '.kchhhhhhhhhhhhhhhhhk.....',
  '..kggggggggggggggggk......',
  '...kgggggggggggggkk.......',
  '....kGGGGGGGGGGkk.........',
  '.....kkkkkkkkkk...........',
  '..........................',
  '..........................',
  '..........................',
  '..........................',
  '..........................',
];

const AEGIS_STRIKE = [
  '..........................',
  '..........................',
  '..........................',
  '..........................',
  '..........................',
  '..........................',
  '.....kkkkkkkkkk...........',
  '....kHHHHHHHHHHkk.........',
  '...kHHHHHHHHHHHHHkk.......',
  '..khhhhhhhhhheeeehhk......',
  '.kchhhhhhhhhheeeehhhk.....',
  '.kchhhhhhhhhhhhhhhhhhkY...',
  '.kchhhhhhhhhhhhhhhhhhhhW..',
  '.kChhhhhhhhhhhhhhhhhhhhW..',
  '.kchhhhhhhhhhhhhhhhhhkY...',
  '.kchhhhhhhhhhhhhhhhhhk....',
  '.kchhhhhhhhhhhhhhhhhk.....',
  '..kggggggggggggggggk......',
  '...kgggggggggggggkk.......',
  '....kGGGGGGGGGGkk.........',
  '.....kkkkkkkkkk...........',
  '..........................',
  '..........................',
  '..........................',
  '..........................',
  '..........................',
];

/*
 * 炮口在 sprite 内的坐标。
 *
 * render 画攻击特效、以及 _refs 校验"攻击是不是从炮口出来"，
 * 都以这个常量为唯一依据 —— 抄成魔法数字会出现
 * "改了点阵但特效还从旧位置冒出来"。
 *
 * 三个姿态的炮口不同，所以给三份。单一常量在这里是错的：
 * wind 的炮口在右上方（蓄能球），strike 的在最右端（炮管前伸）。
 *
 * 坐标必须与上面的点阵**逐像素对齐**：
 *   idle   → 炮口像素 (21, 12/13)  → 中心 (21.5, 13)  → 取 22 / 13
 *   wind   → 蓄能球像素 (20, 6)    → 中心 (20.5, 6.5) → 取 21 / 6.5
 *   strike → 炮口像素 (23, 12/13)  → 中心 (23.5, 13)  → 取 24 / 13
 */
export const SWORD_TIP = Object.freeze({
  idle: { x: 22, y: 13 },
  wind: { x: 21, y: 6.5 },
  strike: { x: 24, y: 13 },
});

/* ============================================================
 *  小兵：侦察无人机（12×12）
 * ============================================================ */

/*
 * 侦察无人机的辨识点：
 *   - **小**：整场最小，读成"来得快去得也快"
 *   - **单核心**：中间一块亮紫 V 是传感器/反应堆，不是眼睛
 *   - **两端推进**：左右各一个短推进口，表示它能横着飘
 *   - 机首朝右，和主角同向，避免画面上"两边都在倒退"
 */
const SCOUT_DRONE = [
  '............',
  '....kkkk....',
  '..kkZZZZkk..',
  '.kzzzzzzzzk.',
  '.kzzVVVVzzk.',
  'czzzzVVVVzzb',
  'czzzzVVVVzzb',
  '.kzzVVVVzzk.',
  '.kzzzzzzzzk.',
  '..kkuuuukk..',
  '....kkkk....',
  '............',
];

/* ============================================================
 *  精英：突击舰（16×16）
 * ============================================================ */

/*
 * 突击舰：比侦察无人机**明显大一圈**（16 vs 12），这是"品级可辨"的
 * 视觉依据。它的辨识点是上下张开的**装甲翼**（N 色）——
 * 侦察机没有翼，突击舰有，一眼能分出来是"重活"。
 */
const ASSAULT_SHIP = [
  '................',
  '................',
  '......kkkk......',
  '....kkZZZZkk....',
  '..kkZZZZZZZZkk..',
  '.kNNZZZZZZZZNNk.',
  'kcZZZZVVVVZZZZZk',
  'kCZZZZVVVVZZZZZk',
  'kCZZZZVVVVZZZZZk',
  'kcZZZZVVVVZZZZZk',
  '.kNNzzzzzzzzNNk.',
  '..kkzzzzzzzzkk..',
  '....kkuuuukk....',
  '......kuuk......',
  '.......kk.......',
  '................',
];

/* ============================================================
 *  精英（同档不同外观）：布雷舰 / 轻僚机
 * ============================================================ */

/*
 * 布雷舰：方头厚甲 + 四角磁雷吊舱（Y 暖金）。
 * 对应"落盘 / 写入"—— 它是往战场上**放东西**的那一类，
 * 所以造型上强调"吊舱、载荷"，而不是速度和翼。
 */
const MINELAYER = [
  '..............',
  '..............',
  '..............',
  '.Y...kkkk...Y.',
  'y..kkZZZZkk..y',
  '..kZNNNNNNZk..',
  '.kZZNNNNNNZZk.',
  '.kZZNNNNNNZZk.',
  '.kzzNNNNNNzzk.',
  'y.kzzzzzzzzk.y',
  '.Y.kkuuuukk.Y.',
  '.....kkkk.....',
  '..............',
  '..............',
];

/*
 * 轻僚机：比突击舰窄一档的三角翼，对应"走网络 / MCP"——
 * 它不是重活，是**伸展出去**的那一类，所以做成薄的。
 */
const WING_DRONE = [
  '..............',
  '..............',
  '.....kkkk.....',
  '...kkZZZZkk...',
  '.kkZZZZZZZZkk.',
  'cZZZZVVVVZZZZk',
  'cZZZZVVVVZZZZk',
  '.kkzzzzzzzzkk.',
  '...kkzzzzkk...',
  '.....kkkk.....',
  '..............',
  '..............',
];

/* ============================================================
 *  BOSS：母舰（27×17）
 * ============================================================ */

/*
 * 母舰：整场**最大**的东西（27 宽，比突击舰宽 11px）。
 *
 * 它不是"放大版突击舰"，而是**另一种结构**：
 *   - 横向极长，舰桥（长窗 e）在右段，不是居中小窗
 *   - 上下都有武器阵位（Y），表示它自己就能持续输出
 *   - 左端是整排引擎组（C/V/v/b），推力规模明显更大
 *
 * 造型上刻意做成"扁平长条"而不是"大团"：
 * 大团在像素风里会糊成一个色块，长条还能读出分层。
 */
const MOTHERSHIP = [
  '...........................',
  '...........kkkkk...........',
  '........kkkNNNNNkkk........',
  '......kkNNNNNNNNNNNkk......',
  '...kkknnnnnnnnnnnnnnnkk....',
  'vvvnnnnnYYYYnnnnnnnnnnnkk..',
  'VVVnnnnnYYYYnnnnnnnnnnnnnk.',
  'CCCnnnnnnnnnnnnneeeeeeeenk.',
  'VVVnnnnnnnnnnnnneeeeeeeenk.',
  'vvvnnnnnnnnnnnnneeeeeeeenk.',
  'bbbnnnnnYYYYnnnnnnnnnnnkk..',
  '...kooooYYYYooooooooook....',
  '....kkooooooooooooookk.....',
  '......kkooooooooookk.......',
  '........kkkPPPPkkk.........',
  '...........kkkk............',
  '...........................',
];

/* ============================================================
 *  兜底：未知
 * ============================================================ */

/** 未知工具：中性菱形。不假装它是什么。 */
const UNKNOWN = [
  '........',
  '...kk...',
  '..kAAk..',
  '.kAHAAk.',
  '.kAHAAk.',
  '..kAAk..',
  '...kk...',
  '........',
];

/* ============================================================
 *  烘焙
 * ============================================================ */

/**
 * 点阵 → { w, h, px }。
 *
 * 行宽不等会在这里就被 bake 的 `rows[0].length` 掩盖掉一部分像素，
 * 所以 lintSprites() 单独查等宽。
 */
function bake(rows) {
  const h = rows.length;
  const w = rows[0].length;
  const px = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const c = rows[y][x];
      if (c === '.') continue;
      const color = PAL[c];
      if (!color) throw new Error('未定义的颜色字符: ' + JSON.stringify(c));
      px.push([x, y, color]);
    }
  }
  return { w, h, px };
}

/**
 * 原始点阵表：**唯一清单**。
 *
 * bakeAll() / lintSprites() / SPRITES 全部从这一张表派生。
 * 上一版把清单抄了两份（SPRITES 里一份、lintSprites 的 raw 里一份），
 * 于是新增 sprite 时很容易只加一边 —— lint 检查的是旧清单，
 * 新点阵的等宽问题永远查不到。一张表就没有这个缺口。
 */
const RAW = Object.freeze({
  /* 主角三态（键名是协议稳定项，不要改） */
  aegisIdle: AEGIS_IDLE,
  aegisWind: AEGIS_WIND,
  aegisStrike: AEGIS_STRIKE,

  /* 敌人 */
  scoutDrone: SCOUT_DRONE,
  assaultShip: ASSAULT_SHIP,
  minelayer: MINELAYER,
  wingDrone: WING_DRONE,
  mothership: MOTHERSHIP,
  unknown: UNKNOWN,
});

export const SPRITES = Object.fromEntries(
  Object.entries(RAW).map(([name, rows]) => [name, bake(rows)]),
);

/**
 * 角色名 → sprite 键名（来自 theme，**不是**在这里写死）。
 *
 * render.mjs 一律通过这张表取素材：
 *   this.sprites[SPRITE_ROLES.hero.idle]
 * 而不是 this.sprites.aegisIdle。
 * 这样换题材时 render 里没有一处需要跟着改。
 */
export const ROLES = SPRITE_ROLES;

/** 供 render 查询"炮口在哪"。 */
export function swordTip(pose) {
  return SWORD_TIP[pose] || SWORD_TIP.idle;
}

/**
 * 烘焙成离屏 canvas。
 *
 * 在浏览器里用真 canvas；在 Node 里（verify / _refs）用假 canvas，
 * 这样验证脚本不需要 DOM 就能检查 sprite 尺寸和像素数。
 */
export function bakeAll(canvasFactory) {
  const out = {};
  const make = canvasFactory || ((w, h) => {
    if (typeof document === 'undefined') {
      // Node 环境：返回一个记账用的假 canvas
      return {
        width: w, height: h, _px: 0,
        getContext() {
          const self = this;
          return {
            fillStyle: '',
            fillRect() { self._px++; },
            clearRect() {},
          };
        },
      };
    }
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  });
  for (const [name, spr] of Object.entries(SPRITES)) {
    const c = make(spr.w, spr.h);
    const ctx = c.getContext('2d');
    for (const [x, y, color] of spr.px) {
      ctx.fillStyle = color;
      ctx.fillRect(x, y, 1, 1);
    }
    c._srcW = spr.w;
    c._srcH = spr.h;
    out[name] = c;
  }
  return out;
}

/** 所有 sprite 的尺寸表，给预渲染用。 */
export function spriteDefs() {
  return Object.entries(SPRITES).map(([name, s]) => ({
    name, w: s.w, h: s.h, px: s.px.length,
  }));
}

/** 调色板导出，给 lint 和调色用。 */
export function palette() {
  return { ...PAL };
}

/** 刀光色阶 re-export：render 与 _refs 的共享契约在这里汇合。 */
export { SLASH_COLORS };

/**
 * sprite 自检。
 *
 * 三件事必须查，因为它们在像素画里都会静默出错：
 *   1. 所有行等宽 —— 不等宽会导致形状歪掉
 *   2. 所有字符都在调色板里 —— 否则那些像素是透明的
 *   3. 调色板的键全是单字符 —— bake() 逐字符查表，多字符键永远匹配不到
 *
 * 检查清单从 RAW 派生，不再另抄一份名字。
 */
export function lintSprites() {
  const bad = [];
  for (const [name, rows] of Object.entries(RAW)) {
    const w = rows[0].length;
    for (let i = 0; i < rows.length; i++) {
      if (rows[i].length !== w) {
        bad.push(`${name} 第 ${i} 行宽度 ${rows[i].length}，应为 ${w}`);
      }
      for (const c of rows[i]) {
        if (c !== '.' && !PAL[c]) bad.push(`${name} 第 ${i} 行有未定义字符 ${JSON.stringify(c)}`);
      }
    }
  }
  for (const k of Object.keys(PAL)) {
    if (k.length !== 1) bad.push(`调色板键 ${JSON.stringify(k)} 不是单字符`);
  }
  return bad;
}

/** 主角 sprite 尺寸，render / verify 都要用。 */
export const AEGIS_SIZE = Object.freeze({ w: 26, h: 26 });
