/**
 * 主题层：**题材的唯一真相源**。
 *
 * ===== 这一层为什么必须存在 =====
 *
 * 上一版把题材焊死在逻辑里：main.mjs 里写「盾牌」「蚂蚁」，
 * render.mjs 里写 `this.sprites.aegisIdle`，sprites.mjs 里画的是红火蚁，
 * index.html 里写「植保盾牌 / 工蚁 / 兵蚁 / 蚁后」。
 *
 * 想换一个题材（从"植保盾牌 + 入侵蚂蚁"换成"星海防线"）就得同时动
 * 逻辑、素材、文案、外壳四个地方，而且**没有任何断言会告诉你漏了哪一个**。
 *
 * 所以把「换题材要动的东西」全部收进这一个文件：
 *
 *   1. 品牌            BRAND        —— 中文名 / 英文名 / 包名
 *   2. 可见文案        COPY         —— 标题、面板、HUD 标签、toast、分级说明
 *   3. 分级语义        TIER_THEME   —— MINION/ELITE/BOSS 三级的显示名与单位名
 *   4. 素材映射        SPRITE_ROLES —— 主角三态、每级敌舰、unknown 兜底
 *   5. 配色            PALETTE / SLASH_COLORS —— 点阵调色板 + 刀光/处决色阶
 *   6. 战斗参数        SIZE_THEME / SPEED_THEME / COMBAT_THEME
 *
 * 换题材的正确姿势因此变成：**只改这个文件的配置 + 新增点阵**。
 * director.mjs / render.mjs / main.mjs 里不该有任何一处需要跟着改。
 *
 * ===== 这一层不许做的事 =====
 *
 * 不许碰**战斗逻辑**。谁掉血、谁死、什么时候结算，全在 director.mjs，
 * 一律由真实事件决定。主题层只决定"看起来是什么"，绝不决定"发生了什么"。
 * 换个主题不该让击杀数变一个 —— 那就成了伪造进度。
 *
 * 三级语义（MINION/ELITE/BOSS 的数值 0/1/2）定义在 bestiary.mjs 的 TIER 里，
 * 是排序与渲染尺寸的依据，属于协议的一部分，**换皮不许改数值**。
 * 这里只提供"这一档在这个题材里叫什么、长什么样"。
 */

/* ============================================================
 *  1. 品牌
 * ============================================================ */

/**
 * 品牌名。
 *
 * nameZh 出现在页面标题与开始面板；pkgId 是 package.json 的 name。
 * 一句话定位（tagline）是给文档和 README 用的，不参与渲染。
 */
export const BRAND = Object.freeze({
  nameZh: '实况智能体',
  nameEn: 'AgentLive',
  /** 面板标题里出现的那份短名，和 nameZh 保持同一份真相 */
  get shortName() { return this.nameZh; },
  pkgId: 'agent-live',
  themeName: '星海防线',
  tagline: '把智能体跑任务的过程，变成一场可观看的星海防线实况战斗',
  /** 诚实边界的一句话，出现在文档与面板里，措辞只在这里写一次 */
  honesty: '真实事件驱动，绝不伪造进度',
});

/** 面板标题用的品牌名。main.mjs 直接 import 它，避免再抄一遍字面量。 */
export const PM_NAME = BRAND.nameZh;

/* ============================================================
 *  2. 分级语义（只换显示名，不换数值）
 * ============================================================ */

/**
 * 品级 → 显示名 / 单位名 / 单字缩写。
 *
 * name     HUD 与规则说明里的档次名（侦察机 / 突击舰 / 母舰）
 * species  单位全名（侦察无人机 / 重装突击舰 / 旗舰母舰）
 * short    检视态一行的单字（`侦 0 突 1 母 1`），必须**单字符**
 */
export const TIER_THEME = Object.freeze({
  /* 键名用语义名（minion/elite/boss），数值 0/1/2 的映射在 bestiary.mjs 的 TIER_KEY 里。
     这里刻意**不**用数字键：数字是协议，字符串是题材，两者的真相源不该是同一份。 */
  minion: Object.freeze({
    key: 'MINION',
    name: '侦察机',
    species: '侦察无人机',
    short: '侦',
    blurb: '毫秒级工具：读取 / 搜索 / 列目录',
  }),
  elite: Object.freeze({
    key: 'ELITE',
    name: '突击舰',
    species: '重装突击舰',
    short: '突',
    blurb: '秒级工具：跑命令 / 联网 / 落盘',
  }),
  boss: Object.freeze({
    key: 'BOSS',
    name: '母舰',
    species: '旗舰母舰',
    short: '母',
    blurb: '子智能体 · 长跑，血条只是预估进度',
  }),
});

/* ============================================================
 *  3. 角色 → sprite 键
 * ============================================================ */

/**
 * 角色到点阵键的映射。**render 的唯一入口**。
 *
 * render.mjs 里一律写 `this.sprites[SPRITE_ROLES.hero.idle]`，
 * 不写 `this.sprites.aegisIdle` —— 硬编码键名会让 render 里藏着一处
 * "换素材时必须跟着改"的暗礁，而换题材本该只改配置。
 *
 * 键名本身（aegisIdle / scoutDrone / mothership …）是 sprites.mjs 的
 * 协议稳定项，改它们等于改协议；要换外观，改**点阵**而不是改键名。
 */
export const SPRITE_ROLES = Object.freeze({
  hero: Object.freeze({
    idle: 'aegisIdle',
    wind: 'aegisWind',
    strike: 'aegisStrike',
  }),
  enemy: Object.freeze({
    /** 小兵：侦察无人机 */
    minion: 'scoutDrone',
    /** 精英：重装突击舰（起进程） */
    elite: 'assaultShip',
    /** 精英同档不同外观：布雷舰（落盘 / 写入） */
    miner: 'minelayer',
    /** 精英同档不同外观：轻僚机（联网 / MCP） */
    wing: 'wingDrone',
    /** BOSS：母舰（子智能体） */
    boss: 'mothership',
    /** 兜底：查不到的角色一律落这里，绝不画成空白 */
    unknown: 'unknown',
  }),
});

/* ============================================================
 *  4. 配色
 * ============================================================ */

/**
 * 点阵调色板：**单字符键** → 色值。
 *
 * 字符必须单字符 —— bake() 逐字符查表，多字符键永远匹配不到
 * （lintSprites() 里有断言）。
 *
 * 沿用 hue-shifting 规范：
 *   1. 暗部不直接压亮度（会变灰塑料），每降一阶 hue 偏一点、饱和加一点
 *   2. 描边不是纯黑，用近黑的深空蓝
 *   3. 每种材质只给 3~4 阶
 *
 * 阵营用冷暖对立：我方冷钢蓝 + 青色引擎光，敌方暖紫红。
 * 这样在一片深空底色里，敌我一眼可分，而不用靠标签。
 */
export const PALETTE = Object.freeze({
  /* ---- 描边：深空近黑 ---- */
  k: '#070b16',

  /* ---- 我方舰体：冷钢蓝四阶（上壳亮 → 下壳暗）---- */
  H: '#c2e2ec',   // 上壳高光
  h: '#709cb4',   // 主体
  g: '#3d607e',   // 下壳
  G: '#263d58',   // 下壳暗部

  /* ---- 我方引擎 / 座舱：青蓝冷光（唯一高饱和冷色）---- */
  e: '#9bf7f3',   // 座舱长窗
  C: '#76e4c5',   // 引擎核心
  c: '#1a8f9a',   // 引擎外焰

  /* ---- 武器 / 炮口：暖金（"这一下是终结"的颜色来源）---- */
  Y: '#f2c14e',
  W: '#fff4d6',

  /* ---- 敌方舰体：暖紫红三阶 ---- */
  Z: '#e4a77f',   // 装甲亮面
  z: '#ae6f56',   // 装甲主体
  V: '#ffd27a',   // 敌舰能量核心
  /* ---- 敌方引擎组：暖橙尾焰三阶（母舰左端整排推进口）---- */
  v: '#e8703a',   // 尾焰外层
  b: '#4a1f1a',   // 尾焰内层 / 最深暗部
  u: '#5e1f1c',   // 腹甲暗部

  /* ---- 敌方精英：紫调装甲（和杂兵的暖红区分）---- */
  N: '#6a5590',
  n: '#8e77b5',
  o: '#2e2444',
  P: '#1b142b',

  /* ---- 雷 / 载荷吊舱：暗金 ---- */
  y: '#b8863c',

  /* ---- 未知：中性灰（不假装它是什么）---- */
  A: '#8a8a96',
});

/**
 * 刀光 / 处决色阶：**协议色值，不得改动**。
 *
 * 三段结构「外辉光 → 刃身 → 刃口高光」。
 * _refs.mjs 靠颜色把刀光从地面网格、圆边界里认出来，
 * 所以色值不能在各处各写一遍 —— 改了一边另一边会静默失效
 * （探针永远匹配不到，只会在"没量到刀光"上假红或假绿）。
 *
 * blade：常规近战，冷白阶。exec：处决那一下换暖金，表示"这一下是终结"。
 * verify.mjs 把这 6 个色值逐字冻结成断言，改一个就会被抓。
 */
export const SLASH_COLORS = Object.freeze({
  blade: Object.freeze(['#5a6470', '#cdd8e0', '#ffffff']),
  exec: Object.freeze(['#8a5a2a', '#e8a24a', '#fff4d6']),
});

/**
 * 画布上按品级区分的名字颜色。
 *
 * 敌人头顶的工具名要能一眼分出档次，同时又不能比血条更抢眼。
 * 死亡后统一转暗灰（表示已结束），但保持可读 —— 看不清等于没写。
 */
export const TIER_LABEL_COLORS = Object.freeze({
  0: '#9fc4e0',   // 小兵：淡蓝
  1: '#c9a0e0',   // 精英：淡紫
  2: '#ff8a6a',   // BOSS：橙红
  killed: '#8a9a80',
  failed: '#9a6a6a',
});

/* ============================================================
 *  5. 可见文案
 * ============================================================ */

/**
 * 所有**观众能看见的字**。
 *
 * 带 `{name}` 的占位符由 fill() 填值；不要在别处再拼一遍字符串 ——
 * 一旦有两处拼装，改一处就会出现"面板是星海、HUD 还是蚂蚁"。
 *
 * honest.* 三条是**诚实不变量**的对外说法，属于产品红线：
 * 血条只是预估、死亡只来自真实事件、清场只来自 turn_end ok:true。
 * 改写措辞可以，改掉这三层意思不行。
 */
export const COPY = Object.freeze({
  /* 浏览器标签页标题 */
  docTitle: `${BRAND.nameZh} · ${BRAND.themeName}`,

  /* ---- 开始面板 ---- */
  panelTitle: BRAND.nameZh,
  panelSub: `${BRAND.themeName} · 智能体执行过程实况`,
  startButton: '观看样本回放',
  keysHint: '空格 开始 / 暂停 · P 暂停 · R 重播 · I 明细 · F/S/N 特效',

  /* ---- 分级说明（三档对应 TIER 0/1/2）---- */
  tierRules: Object.freeze({
    minion: Object.freeze({
      tag: '侦察机',
      desc: '侦察无人机 · 毫秒级工具（读取 / 搜索，实测中位 8~29ms）',
    }),
    elite: Object.freeze({
      tag: '突击舰',
      desc: '重装突击舰 · 秒级工具（跑命令 / 联网 / 落盘，中位 271~482ms）',
    }),
    boss: Object.freeze({
      tag: '母舰',
      desc: '旗舰母舰 · 子智能体长跑，血条只是预估进度',
    }),
  }),

  /* ---- 诚实边界（面板上的三段说明）---- */
  honest: Object.freeze({
    death: '防线会自动开火，但<strong>敌舰不会因为血条空了就爆</strong>。'
      + '<br>血条归零只表示「比预估更久了」，它照样推进。'
      + '<br>击毁只来自真实事件结束；清场只来自 <code>turn_end ok:true</code>。',
    source: '事件源是 DSH 真实会话 <code>ede86888</code>：<strong>292 次工具调用</strong>、'
      + '真实耗时合计 <strong>130.1 秒</strong>、会话跨度 <strong>77.4 小时</strong>。'
      + '<br>每次的生死时刻来自 <code>tool/call.time</code> 与 '
      + '<code>tool/result.time</code> 相减。<br>'
      + '所以 <code>read</code>（中位 8ms）几乎是瞬杀，'
      + '<code>pwsh</code>（中位 482ms）要挨几刀，'
      + '<code>ask_user_question</code>（42.2 秒）站到天荒地老 —— 这些都是真的。',
    timeAxis: '时间轴做过压缩：长空白与超长调用被折叠（77.4h → 播放 266s，3 倍速）。'
      + '折叠量写在 <code>real-events.json</code> 的 meta 里，可复算。',
  }),

  /* ---- HUD ---- */
  hud: Object.freeze({
    alive: '敌',
    kills: '击杀',
    failures: '失败',
    combo: '连击',
    unmapped: '未映射',
    overdue: '超时',
    calls: '调用',
    concurrent: '同时最多',
    swings: '开火',
    damage: '伤害',
    comboBest: '最高连击',
    duplicates: '重复',
    fps: 'fps',
  }),

  /* ---- 飘字（画布上的击杀数字）---- */
  floater: Object.freeze({
    kill: '击毁',
    killCombo: '击毁 ×{n}',
    fail: 'FAIL',
  }),

  /* ---- toast ---- */
  toast: Object.freeze({
    kill: '击毁 · {tool}',
    fail: '失败 · {tool}',
    paused: '暂停',
    resumed: '继续',
    inspectOn: '明细图表 · 开',
    inspectOff: '明细图表 · 关',
    replay: '重播',
    flashOn: '受击闪烁：开',
    flashOff: '受击闪烁：关',
    shakeOn: '震屏：开',
    shakeOff: '震屏：关',
    numbersOn: '飘字：开',
    numbersOff: '飘字：关',
  }),

  /* ---- BOSS 大血条 / 屏幕边框 ---- */
  bossBar: Object.freeze({
    estimate: '预估进度',
    overdue: '超出预估 · 仍在执行',
    border: '母舰交战中',
  }),

  /* ---- 结算横幅 ---- */
  banner: Object.freeze({
    win: '防线守住 · 入侵清除',
    winDetail: '击毁 {kills} · 失败 {failures} · 开火 {swings}',
    lose: '本轮失守 · 残敌仍在',
  }),
});

/* ============================================================
 *  6. 战斗展示参数
 * ============================================================ */

/**
 * 敌人渲染尺寸（1x 画布坐标）。
 *
 * 阶梯必须**严格递增**：小兵 < 精英 < BOSS。
 * 这是"品级肉眼可辨"的依据，verify.mjs 把阶梯钉死了。
 * 注意这是"目标绘制尺寸"，不是点阵实际宽高（两者是不同的量）。
 */
export const SIZE_THEME = Object.freeze({
  minion: 11,
  elite: 17,
  boss: 30,
});

/**
 * 敌人移动速度（像素/秒）。
 *
 * 阶梯必须**严格递减**：小兵 > 精英 > BOSS。
 * 小的跑得快、大的压得慢 —— 纯形态表达，不参与任何结算。
 */
export const SPEED_THEME = Object.freeze({
  minion: 36,
  elite: 20,
  boss: 10,
});

/**
 * 与题材相关、但**纯展示**的其它参数。
 *
 * 主角速度 / 风筝距离 / 攻击距离这些在 director.mjs 的 COMBAT 里，
 * 属于战斗逻辑，不搬到这里 —— 换题材不该改变手感。
 * 这里只放"画多大、飘多远"这一类。
 */
export const COMBAT_THEME = Object.freeze({
  /** 主角绘制比例：1 = 点阵原尺寸（像素风不缩放，避免糊） */
  heroScale: 1,
  /** 击杀飘字上浮速度（px/s） */
  floaterRise: -26,
});

/* ============================================================
 *  汇总 + 工具
 * ============================================================ */

/**
 * 完整主题对象。
 *
 * 给"整个主题一次性换掉"的场景用（比如 verify 里的换主题冒烟测试：
 * 塞一份内联假 theme 进去，断言全部可见文案与 sprite 映射跟着变）。
 * 上面那些具名导出是它的**视图**，两者是同一份数据，不会漂移。
 */
export const THEME = Object.freeze({
  brand: BRAND,
  tiers: TIER_THEME,
  sprites: SPRITE_ROLES,
  colors: Object.freeze({ palette: PALETTE, slash: SLASH_COLORS, tierLabel: TIER_LABEL_COLORS }),
  copy: COPY,
  combat: Object.freeze({ size: SIZE_THEME, speed: SPEED_THEME, ...COMBAT_THEME }),
});

/**
 * 模板填充：`{name}` → vars.name。
 *
 * 找不到的值填空串，而不是把 `{name}` 原样漏到画面上 ——
 * 画面里出现花括号比缺一个字更糟：观众会以为程序崩了。
 */
export function fill(tpl, vars = {}) {
  if (typeof tpl !== 'string') return '';
  return tpl.replace(/\{(\w+)\}/g, (m, k) => (vars[k] == null ? '' : String(vars[k])));
}

/**
 * 角色 → sprite 键。带 unknown 兜底。
 *
 * role 可以是 'idle' / 'wind' / 'strike'（主角三态），
 * 或 'minion' / 'elite' / 'miner' / 'wing' / 'boss' / 'unknown'（敌人角色）。
 * 任何查不到的字符串一律落到 unknown —— 宁可画个菱形，也不画空白。
 */
export function spriteKeyFor(role, theme = THEME) {
  const t = theme && theme.sprites ? theme.sprites : SPRITE_ROLES;
  if (role === 'idle' || role === 'wind' || role === 'strike') {
    return (t.hero && t.hero[role]) || (t.enemy && t.enemy.unknown) || SPRITE_ROLES.enemy.unknown;
  }
  return (t.enemy && t.enemy[role]) || (t.enemy && t.enemy.unknown) || SPRITE_ROLES.enemy.unknown;
}

/**
 * 把所有可见文案拍平成一维（换主题冒烟测试用）。
 *
 * 用途：测试要能**枚举**全部可见文案，而不是靠人肉记一份清单 ——
 * 清单会漏，而漏掉的往往正是没人看的那一句。
 */
export function copyLeaves(theme = THEME) {
  const t = (theme && theme.copy) || COPY;
  const out = [];
  const walk = (v, path) => {
    if (typeof v === 'string') out.push({ path, text: v });
    else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`));
    else if (v && typeof v === 'object') {
      for (const k of Object.keys(v)) walk(v[k], path ? `${path}.${k}` : k);
    }
  };
  walk(t, '');
  return out;
}
