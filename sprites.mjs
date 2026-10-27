/** Programmatic fleet models; shared palette, muzzle anchors and canvas baking. */
import { PALETTE, SPRITE_ROLES, SLASH_COLORS } from './theme.mjs';
import { modelRows } from './ship-models.mjs';
const PAL = PALETTE;

export const SWORD_TIP = Object.freeze({
  idle: { x: 41, y: 22 },
  wind: { x: 37, y: 18 },
  strike: { x: 43, y: 22 },
});

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
  aegisIdle: modelRows('aegisIdle'),
  aegisWind: modelRows('aegisWind'),
  aegisStrike: modelRows('aegisStrike'),

  /* 敌人 */
  scoutDrone: modelRows('scoutDrone'),
  assaultShip: modelRows('assaultShip'),
  minelayer: modelRows('minelayer'),
  wingDrone: modelRows('wingDrone'),
  mothership: modelRows('mothership'),
  unknown: modelRows('unknown'),
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
export const AEGIS_SIZE = Object.freeze({ w: 44, h: 44 });
