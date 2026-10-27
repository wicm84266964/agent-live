/**
 * 敌人图鉴：什么工具算小兵、什么算精英、什么算 BOSS。
 *
 * ===== 这一版把题材换成星海防线 =====
 *
 * 主角是一艘守望舰，守的是防线；来犯的是**敌方舰队**。
 * 所以敌人的"大小"直接对应真实工具的**耗时量级**：
 *
 *   侦察无人机（minion，小兵）
 *     小型、最快、数量最多。
 *     对应**毫秒级**工具：读文件、搜索、列目录。
 *     真实数据：read 中位 8ms、edit 13ms、grep 29ms。
 *
 *   突击舰（elite，精英）
 *     明显大一圈、带装甲翼，活动慢但重。
 *     对应**秒级**工具：起进程、走网络、落盘。
 *     真实数据：pwsh 中位 482ms / 最大 15.4s、web_search 271ms。
 *
 *   母舰（boss）
 *     整场最长最重。
 *     对应**子智能体**：agent_run 这种长跑。
 *
 * ===== 分级语义由 theme 提供，这个文件只做映射 =====
 *
 * 显示名（侦察无人机 / 突击舰 / 母舰）、每个品级用哪个 sprite，
 * 全部来自 theme.mjs。这里只负责：
 *
 *   工具名 → 品级（业务语义，跟题材无关）
 *   品级   → 显示名 / sprite / 尺寸 / 速度（全部查 theme）
 *
 * 所以换题材时这个文件**一行都不用改** —— 这是"只改配置"的关键一环。
 *
 * ===== 一个必须说清楚的诚实边界 =====
 *
 * 这张表说的是**典型值**，不是精确值。
 * `pwsh` 也可能 15 秒（实测最大值就是 15.4s），`read` 也可能慢。
 *
 * 所以：**品级只影响"画多大、跑多快"，不影响"它什么时候死"。**
 * 死亡一律由真实事件结束决定（见 director.mjs）。
 * 决不能出现"因为它是突击舰所以自动扣血到死"。
 */

import { TIER_THEME, SPRITE_ROLES, SIZE_THEME, SPEED_THEME } from './theme.mjs';

/** 品级。数字用于排序和渲染尺寸，不是血量。 */
export const TIER = Object.freeze({
  MINION: 0,     // 小兵
  ELITE: 1,      // 精英
  BOSS: 2,       // BOSS
});

/* 品级 → theme 里的键名。这张对照表是唯一的（数值 ↔ 语义键）。 */
const TIER_KEY = Object.freeze({
  [TIER.MINION]: 'minion',
  [TIER.ELITE]: 'elite',
  [TIER.BOSS]: 'boss',
});

/** 品级显示名（来自 theme）。 */
export const TIER_NAME = Object.freeze({
  [TIER.MINION]: TIER_THEME.minion.name,
  [TIER.ELITE]: TIER_THEME.elite.name,
  [TIER.BOSS]: TIER_THEME.boss.name,
});

/** 物种/单位名。HUD 和注释里用，避免出现"小兵"这种不含单位名的说法。 */
export const TIER_SPECIES = Object.freeze({
  [TIER.MINION]: TIER_THEME.minion.species,
  [TIER.ELITE]: TIER_THEME.elite.species,
  [TIER.BOSS]: TIER_THEME.boss.species,
});

/** 检视态一行的单字缩写（`侦 0 突 1 母 1`）。 */
export const TIER_SHORT = Object.freeze({
  [TIER.MINION]: TIER_THEME.minion.short,
  [TIER.ELITE]: TIER_THEME.elite.short,
  [TIER.BOSS]: TIER_THEME.boss.short,
});

/** 品级 → sprite 键名。全部走 theme 的角色表，不抄 sprite 名。 */
function spriteOf(tier) {
  const key = TIER_KEY[tier];
  const map = {
    minion: SPRITE_ROLES.enemy.minion,
    elite: SPRITE_ROLES.enemy.elite,
    boss: SPRITE_ROLES.enemy.boss,
  };
  return map[key];
}

/**
 * 规则表。**顺序有意义**：先匹配到的先生效。
 * BOSS 放最前面，因为 agent_run 必须优先识别。
 *
 * sprite 字段不写裸名字 —— 一律从 theme 的角色表取。
 * 这样换题材时这里不需要改，而且不会出现"规则指向一个不存在的 sprite"。
 */
const RULES = [
  {
    // 子智能体 —— 母舰。独立长跑，最重。
    tier: TIER.BOSS,
    match: /^(agent_run|task|agent)$/,
    sprite: spriteOf(TIER.BOSS),
    label: '子智能体',
    /*
     * 预估时长（毫秒）。只用于血条的"预期寿命"，
     * 不驱动任何结算。
     */
    expectMs: 90000,
  },

  {
    // 起进程 —— 突击舰。秒级，实测中位 482ms、最大 15.4s。
    tier: TIER.ELITE,
    match: /^(bash|powershell|pwsh|background_shell|commandexecution|exec|shell|exec_command)$/,
    sprite: spriteOf(TIER.ELITE),
    label: '执行',
    expectMs: 6000,
  },

  {
    // 走网络 —— 轻僚机。要等远端，实测中位 271ms。
    tier: TIER.ELITE,
    match: /^(web_fetch|web_search|webfetch|websearch)$/,
    sprite: SPRITE_ROLES.enemy.wing,
    label: '联网',
    expectMs: 3000,
  },

  {
    // 落盘 —— 布雷舰。要刷盘。实测 write 中位 14ms、edit 13ms，
    // 数值上接近小兵，但它是"改动世界"的操作，不是读取，
    // 所以仍归精英 —— 这一档按**语义**归类，不纯按耗时。
    tier: TIER.ELITE,
    match: /^(write_file|edit_file|write|edit|filechange)$/,
    sprite: SPRITE_ROLES.enemy.miner,
    label: '写入',
    expectMs: 800,
  },

  {
    // 纯读 / 纯搜 —— 侦察无人机。毫秒级，实测 read 中位 8ms。
    tier: TIER.MINION,
    match: /^(read_file|read|list_files|glob|grep|rg_search|rg_files|rg_files_with_matches|rg_count|ts_symbols|ts_diagnostics|ts_find_definition|ts_find_references|toolsearch)$/,
    sprite: spriteOf(TIER.MINION),
    label: '读取',
    expectMs: 300,
  },

  {
    // 问人 —— 小兵体型，但会等很久。实测唯一一次 42.2s。
    // 不设为精英：它不是"重活"，是"在等人"。
    tier: TIER.MINION,
    match: /^(ask_user|ask_user_question)$/,
    sprite: spriteOf(TIER.MINION),
    label: '询问',
    expectMs: 30000,
  },

  {
    // 任务清单 —— 小兵。实测中位 5ms。
    tier: TIER.MINION,
    match: /^(todo_read|todo_write|plan_update)$/,
    sprite: spriteOf(TIER.MINION),
    label: '任务',
    expectMs: 200,
  },

  {
    // 文档/PDF 解析 —— 小兵偏上。
    tier: TIER.MINION,
    match: /^(document_intake)$/,
    sprite: spriteOf(TIER.MINION),
    label: '解析',
    expectMs: 1500,
  },

  {
    // MCP —— 走外部服务，按精英。
    tier: TIER.ELITE,
    match: /^mcp_|^mcptoolcall$/,
    sprite: SPRITE_ROLES.enemy.wing,
    label: 'MCP',
    expectMs: 2500,
  },

  {
    // 技能 —— 读指令文件，小兵。
    tier: TIER.MINION,
    match: /^skill_/,
    sprite: spriteOf(TIER.MINION),
    label: '技能',
    expectMs: 400,
  },
];

/** 查一个工具对应什么敌舰。 */
export function classify(tool) {
  if (typeof tool !== 'string' || !tool) {
    // 没有工具名 → 未知。**不猜**。
    return {
      tier: TIER.MINION,
      sprite: SPRITE_ROLES.enemy.unknown,
      label: '未知',
      expectMs: 500,
      rule: false,
    };
  }
  const name = tool.trim().toLowerCase();
  for (const r of RULES) {
    if (r.match.test(name)) {
      return { tier: r.tier, sprite: r.sprite, label: r.label, expectMs: r.expectMs, rule: true };
    }
  }
  /*
   * 表里没有的工具：按小兵处理，sprite 用 unknown、rule=false。
   * 不是"当成精英"—— 那样会虚报强度。
   * 我不知道它做什么，画成最小的一个是最保守的表达。
   */
  return {
    tier: TIER.MINION,
    sprite: SPRITE_ROLES.enemy.unknown,
    label: tool.slice(0, 8),
    expectMs: 500,
    rule: false,
  };
}

/** 全部规则，给验证脚本用。 */
export function rules() {
  return RULES.map((r) => ({ ...r, match: String(r.match) }));
}

/**
 * 敌人尺寸（渲染像素，1x 画布坐标）。
 *
 * 来自 theme 的 size 阶梯：小兵 < 精英 < BOSS，严格递增。
 * 精英明显大一圈 —— 这是它作为"重活"的视觉依据。
 * BOSS 最大，因为它是整场唯一的长跑者。
 */
export const SIZE = Object.freeze({
  [TIER.MINION]: SIZE_THEME.minion,
  [TIER.ELITE]: SIZE_THEME.elite,
  [TIER.BOSS]: SIZE_THEME.boss,
});

/**
 * 敌人移动速度（像素/秒，1x 坐标）。
 *
 * 来自 theme 的 speed 阶梯：小兵 > 精英 > BOSS，严格递减。
 * 小的灵活、大的笨重 —— 这纯粹是形态表达，不影响任何结算。
 */
export const SPEED = Object.freeze({
  [TIER.MINION]: SPEED_THEME.minion,
  [TIER.ELITE]: SPEED_THEME.elite,
  [TIER.BOSS]: SPEED_THEME.boss,
});
