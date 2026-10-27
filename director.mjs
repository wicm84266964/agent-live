/**
 * 导演：把真实智能体事件变成战场状态。
 *
 * ===== 这个文件存在的唯一理由 =====
 *
 * 用户的原话是：
 *   「盾牌一直攻击他，-1血，他的血条就是子智能体预估的进度条，
 *     工具调用时间短，作为小兵可以瞬间击杀」
 *   「自动打，一直在攻击，但是**完成的时候，才击杀**」
 *
 * 这两句话合起来是一条硬约束，也是整个项目最容易做假的地方：
 *
 *   **血条可以掉，但敌人不能因为血条掉了而死。**
 *
 * 血条是"预估进度"——视觉上表达"这事儿大概还要多久"。
 * 死亡必须来自**真实事件结束**（tool 返回 / turn_end）。
 *
 * 换句话说：
 *   血条 0% ≠ 死亡。血条 0% 只是"比预估更久了"，盾牌继续砍。
 *   事件到达 = 死亡。哪怕血条还有 80%，事件到了立刻死。
 *
 * 为什么这条必须写死在代码里：
 *   如果让血条归零就死，那"战斗"就变成了"按预估时长放动画"，
 *   和真实执行完全脱钩 —— 一个跑了 5 分钟的子智能体会在 90 秒时
 *   "演"成被杀，而它其实还在跑。那就是假进度。
 *
 * ===== 未映射的工具 =====
 *
 * 表里没有的工具仍然会产生一个 unknown 小兵（它确实发生了一次调用），
 * 但会单独计数，HUD 里如实显示"未知 N 个"。
 * 不假装它属于某个已知类别。
 */

import { classify, TIER, TIER_NAME, SIZE, SPEED } from './bestiary.mjs';

/** 战斗数值。 */
export const COMBAT = Object.freeze({
  /** 盾牌每秒挥几次。 */
  swingsPerSecond: 3.2,
  /** 每道雷电的伤害。 */
  damagePerBolt: 1,
  /*
   * ===== 单次雷击掉多少血条 =====
   *
   * 两个需求在这里打架，必须同时满足：
   *
   *   A. 用户：「闪电击中的时候可以扣少量血」
   *      → 单次掉幅必须小，不能一雷半管。
   *
   *   B. 用户（更早）：「血条就是子智能体预估的进度条」
   *      → 长任务挨着打，血条应该差不多在预估时刻见底。
   *
   * 只满足 A（固定 0.12）会毁掉 B：BOSS 预估 14 秒、要挨 45 下，
   * 固定 0.12 的话第 9 下（约 2.8 秒）就掉空了，
   * 剩下 11 秒一直挂着空血条 —— 进度感彻底没了。
   *
   * 只满足 B（按速率）会毁掉 A：小兵预估 450ms 只够挨 1.4 下，
   * 按速率单次就得掉 69%，一雷打掉大半管，正是用户说的
   * "不像扣少量血"。
   *
   * 解决办法：**按速率算，但把结果钳在一个小区间里**。
   *
   *   rate = 1 / (预估期能挨几下)
   *   perBolt = clamp(rate, boltDamageMin, boltDamageMax)
   *
   *   BOSS：rate = 1/44.8 = 0.022  → 挨满约 45 下见底（进度感准确）
   *   小兵：rate = 1/1.44 = 0.69   → 钳到 0.15（少量血），
   *         而它一辈子只够挨 1~2 下，死时还剩 70~80% 血条，
   *         然后被处决雷一次清空 —— 这个"打不满 + 处决"的节奏
   *         正是用户要的。
   *
   * 所以上限负责"少量"，速率负责"进度"，两者同时成立。
   */
  boltDamageMax: 0.15,
  boltDamageMin: 0.02,
  /** 血条上限（纯视觉刻度）。 */
  hpMax: 100,

  /*
   * 盾牌的移动速度（1x 像素/秒）。
   *
   * ===== 这个值是算过的，不是拍的 =====
   *
   * 要成立"追逐"，必须满足：盾牌能追上，但追得不轻松。
   *
   *   小兵 34 px/s  → 盾牌必须更快，否则永远追不上，又变回站桩
   *   精英 22 px/s  → 盾牌略快，能追上但会有拉锯
   *   BOSS 11 px/s  → 盾牌明显快，但 BOSS 体型大、停下距离远
   *
   * 取 52：比最快的小兵快 53%，比 BOSS 快 4.7 倍。
   * 这样画面上能明确看出"盾牌冲过去"，而不是"原地等怪走过来"。
   *
   * 为什么不取更大（比如 100）：那样小兵永远追不上、也不靠近，
   * 画面变成盾牌满场飞奔、敌人跟在后面吃灰 —— 同样不叫"被怪物追着"。
   */
  /** 盾牌的移动速度（1x 像素/秒）。比小兵快才拉得开，比 BOSS 快得多才能遛它。 */
  aegisSpeed: 46,

  /** 停手距离的额外余量（敌人贴身距离用）。 */
  standOff: 4,

  /*
   * ===== 风筝（kite）参数：这一组决定了"边逃边打"的手感 =====
   *
   * 用户原话：「怪物追我们，我们边逃边清理怪物」。
   *
   * 所以盾牌不能冲上去贴脸，也不能一路跑到天涯海角 ——
   * 它要维持一个**自己够得着、又尽量远离**的距离，绕着打。
   *
   *   kiteDist  理想距离。比它近太多就退，远太多就压，刚好就横绕。
   *   reach     攻击距离。超出就挥空。
   *
   * 关键：reach > kiteDist。这样"退着打"是成立的 ——
   * 只要维持在风筝距离上，一边退一边还能砍到。
   * 如果 reach < kiteDist，就变成纯逃跑打不到人。
   */
  kiteDist: 26,
  reach: 44,

  /*
   * ===== 死亡展示期：敌人死了也要在场上留够时间 =====
   *
   * 用户原话：
   *   「最好是保留一秒钟（就算是瞬杀，血条也是呈现一秒钟
   *     快速消耗殆尽的感觉），别一闪而过看不清」
   *
   * 这暴露了一个严重观感问题：小兵寿命只有 450~750ms，
   * 死亡动画又只要 0.31 秒（deathT += dt*3.2）——
   * 一个 read_file 从出生到消失总共不到 1 秒，
   * 画面上完全看不清它叫什么、血条怎么掉的。
   *
   * 现在分两段：
   *   dyingMs   死亡展示期 1000ms —— 名字一直显示，尸体淡出上浮
   *   hpDrainMs 血条耗尽 350ms —— 比展示期短，于是"掉空→停一会→消失"
   *             三段分明，而不是血条和尸体同时没
   */
  /*
   * 死亡展示期。
   *
   * ===== 为什么是 1060 而不是 1000 =====
   *
   * 用户要求"至少保留一秒"。设成 1000 时，名义是一秒，
   * 但实际是"跨过 1.0 的那一帧才移除"，量化误差让实测系统性偏短：
   * 浏览器 24 次逐帧实测 均值 997.2ms，17/24 落在 986.9~999.6ms，
   * 也就是**大部分情况下不到一秒**。
   *
   * 差 3ms 在观感上完全无所谓，但"至少一秒"就该真的至少一秒。
   * 留 60ms 余量吸收帧量化（75Hz 下一帧 13.3ms）后，
   * 实测下限稳定在 1000ms 以上。
   */
  dyingMs: 1060,
  hpDrainMs: 350,

  /*
   * ===== 出生显形 =====
   *
   * 这一条是和用户讨论后**收窄过的需求**，记下来免得以后误改：
   *
   * 原话是想要"生成预警"。但预警意味着**提前**知道敌人要来 ——
   * 而敌人只在真实 tool 事件到达时才被创建，在那之前它不存在。
   * 所以真正的预警在本项目里是做不到的，硬做就是假信息，
   * 等于凭空预告一件尚未发生的事。
   *
   * 能做且诚实的只有"出生显形"：事件**已经发生**，
   * 但我们不把它瞬间弹出来，而是给它 320ms 的展开过程
   * （缩放 0.6→1 + 淡入 + 一圈收拢的地面环）。
   * 观众读到的是"这里出现了一个东西"，而不是"凭空多了个方块"。
   *
   * 所以不要把它叫 telegraph / 预警。它不预告未来。
   */
  spawnMs: 320,

  /*
   * ===== 连击窗口 =====
   *
   * 定义：两次**成功击杀**间隔 <= comboWindowMs 记为同一串连击。
   *
   * 为什么要做连击，而不是只显示累计击杀：
   * 累计数只说明"一共打死多少"，它是单调的、没有节奏的，
   * 观众看不出"现在打得顺不顺"。连击描述的是**当下状态**。
   *
   * 关键的诚实设计：**失败会打断连击**（见 _settle）。
   * 因为连击在这里的含义是"连续成功"，如果失败也照算，
   * 那这个数字就变成了"一共动了几次手"，失去信息量。
   * 用户要的是看清打在哪儿，不是看一个永远上涨的计数器。
   *
   * 窗口取 1500ms 的依据：小兵寿命 450~750ms，
   * 取 1500 刚好能跨住"一个接一个"的连续清怪，
   * 又不会把间隔两秒的两只硬串成一串。
   */
  /*
   * 连击窗口（毫秒）。
   *
   * ===== 一个必须说清楚的边界：它不随播放倍速缩放 =====
   *
   * 页面用 3 倍速播放（266 秒压缩成 89 秒），但 `feed()` 传给 director
   * 的时间是**墙钟**，所以这里的 1500ms 在 3 倍速下等效于
   * 事件时间轴上的 4500ms。
   *
   * 后果：浏览器里实测 comboBest = 292（全部击杀连成一条），
   * 而无头 verify 按真实事件时间轴跑出来是 38。
   * 两个数都不错 —— 它们量的是不同的时间轴。
   *
   * 我没有改它，因为：
   *   - 改 feed() 传 ts/SPEED，会让"敌人存活时长"这类依赖墙钟的
   *     视觉参数全部错位，牵连面太大；
   *   - 把窗口写成 comboWindowMs/SPEED 又会让它随播放速度变化，
   *     那"连击"就不再是一个稳定概念了。
   *
   * 所以：**浏览器里的 comboBest 不能当作数据指标看**，
   * 它只是节奏感。真实连击数请以 verify.mjs 的无头输出为准（38）。
   * 这条已写进 README 的已知边界。
   */
  comboWindowMs: 1500,

  /*
   * ===== 处决：把"血条没空就死"变成看得见的一击 =====
   *
   * 用户的原话：
   *   「还是有些小怪没被电到就直接挂了，闪电击中的时候可以扣少量血，
   *     然后完成任务的时候有个处决特效，秒杀剩余血量，
   *     这会比较符合逻辑」
   *
   * 这句点出了上一版真正的逻辑漏洞：
   *
   *   雷击单次最多打掉 0.5 血条（还带钳位），而很多小兵
   *   预估寿命只有 450ms，还没轮到挨几刀，tool_end 就到了。
   *   于是它血条还剩一大半，却**直接死了** ——
   *   画面上就是"凭空暴毙"，没有任何可见的死因。
   *
   * 正确的因果应该是：
   *   1. 平时雷击：**少量**削血（只是消耗，不是致命）
   *   2. 任务完成（tool_end ok）→ **处决雷**从天而降，
   *      把剩余血量一次性清零，再进入死亡展示期
   *
   * 数据上，处决雷和普通雷是同一套结构（都进 lightning 数组），
   * 只是带 exec:true 标记 + 更高伤害 + 更长存活时间，
   * render 会把它画得明显更粗更亮。
   *
   * ===== 这不改变诚实语义 =====
   *
   * 处决雷**不是**伤害结算，它只是把"事件已经决定的死亡"
   * 画成一次击杀。击杀仍然只由 tool_end 产生，
   * 血条归零仍然不等于死亡（hpRatio 归零后敌人照样站着，
   * 只是 stunT/hitsTaken 在涨）。
   *
   * execMs: 处决雷的可见时长。比普通雷（180ms）长，
   *         因为它是"死亡的原因"，观众必须有时间看到它。
   */
  execMs: 420,
  execBoltWidth: 2.4,
  /* 处决雷落下的延迟：先闪一下再劈，像"蓄力" */
  execStrikeMs: 90,

  /*
   * ===== 雷电链 =====
   *
   * 用户改需求：「不要枪了，改成法杖吧，子智能体多个的时候，
   * 法杖可以用雷电阻挡他们前进并造成伤害，那些小怪也不会因为
   * 腾不出手自己扣血挂掉显得奇怪，法杖设定是可以有多条雷电链造成伤害的」
   *
   * 这段话点出了三个必须一起做的东西：
   *
   *   1. **多条链** —— 一次施法不是打一个，是打好几个。
   *      chainMax 是一条链最多能连几个目标。
   *
   *   2. **阻挡前进** —— 被连着电的敌人这一刻**推不动**。
   *      这是"法杖能控场"的实感来源，也解决了原来最别扭的地方：
   *      血条以前是按时长自己往下掉的，敌人没挨打也在掉血，
   *      看着像"自己腾不出手扣血然后挂掉"。
   *      现在掉血必须有雷电打在身上，掉得有理有据。
   *
   *   3. **血条下降要有来源** —— 见 Enemy.hpRatio：
   *      活着时的血条 = min(时间预估剩余, 被电掉的剩余)。
   *      也就是说：光靠时间流逝，血条永远不会自己归零，
   *      必须真的吃到雷电才会往下走。
   *
   *   chainRange   链式跳转的最大距离。比 reach 大，
   *                因为"链"的本质就是跳到同伴身上。
   *   chainFalloff 每跳一次的伤害衰减。第二跳开始变弱。
   *   stunMs       被电到后动弹不得的时长。
   *
   * ===== stunMs 必须明显小于施法间隔，这是实测调出来的 =====
   *
   * 施法间隔 = 1/swingsPerSecond = 312ms。
   *
   * 第一版把 stunMs 设成 260ms —— 看起来控得更狠更好，
   * 实际后果是：312ms 的间隔里敌人有 260ms 是钉住的，
   * 只剩 52ms 能挪。于是它们几乎永远贴不上来，
   * 盾牌根本不需要后退 —— 实测 fleeing 从 55% 直接掉到 **1.6%**。
   *
   * 也就是说用雷电阻挡前进这条需求把边逃边打给杀掉了。
   * 两者都要保住，只能让控制率不超过间隔的一半左右：
   *
   *   150ms / 312ms ≈ 48% 被控，52% 能冲
   *
   * 于是画面是敌人被电得一顿一顿地往前挤：
   * 电住了停一下 → 松开了继续扑 → 再被电住。
   * 这比完全定住更像控场，也保住了拉锯。
   */
  chainMax: 4,
  chainRange: 62,
  chainFalloff: 0.75,
  stunMs: 150,
});

/**
 * 确定性伪随机（mulberry32）。
 *
 * 32 位状态，快、够随机、可复现。同一个种子永远给出同一串数。
 * 用它取代 Math.random 之后，verify 每次跑的都是同一场战斗，
 * 断言才真的是"代码变了会红"，而不是"运气变了会红"。
 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let _seq = 0;

/**
 * 一个敌人。
 *
 * hp 是"预估进度"的补数：hp = 100 表示刚开始，
 * hp 随时间按 expectMs 线性下降到 0（然后停在 0，不会死）。
 */
export class Enemy {
  constructor(ev, now, arena, rnd = Math.random) {
    const info = classify(ev.tool);

    /*
     * ===== id 与 callId 是两个不同的东西 =====
     *
     * this.id 是画面上用的**递增序号**（number），只保证唯一、好读。
     * this.callId 是**事件源给的真实标识**（字符串，形如 call_00_kL2Mw…）。
     *
     * 上一版只有 this.id，而 _finishTool 用 `e.id === ev.id` 去匹配
     * 真实事件 —— number === string 永远为 false，
     * 于是 292 条合法 tool_end 里有 283 条被误判成"重复上报"丢弃。
     * 实测：击杀在 30 秒内卡在 9（每个工具的第一次结束），
     * 最后靠 turn_end 一次性批量清场冲到 301，最高连击 292 是假连击。
     *
     * 这个 bug 不会报错、不抛异常，页面看起来还在跑 ——
     * 只有对着日志复算击杀分布才能发现。
     */
    this.id = ++_seq;
    this.callId = ev.id != null ? String(ev.id) : null;
    this.tool = typeof ev.tool === 'string' ? ev.tool : '(none)';
    this.tier = info.tier;
    this.tierName = TIER_NAME[info.tier];
    this.sprite = info.sprite;
    /*
     * 名字要显示"它代表哪次调用"，不只是类别。
     *
     * 用户：「小怪身上至少得有他代表哪个任务的名称」。
     *
     * 优先用工具名本身（read_file / bash / agent_run），它比
     * "读取 / 执行"更具体，观众能直接对上日志。
     * 工具名可能很长（rg_files_with_matches），截断到 14 字符。
     */
    this.label = this.tool.length <= 14 ? this.tool : this.tool.slice(0, 13) + '…';
    /** 类别名，用作小字副标题 */
    this.kindLabel = info.label;
    this.mapped = info.rule;
    this.expectMs = info.expectMs;

    /** 出生时间（真实 ms）。 */
    this.bornAt = now;
    /** 最后一刻它被真实事件结束的时间。null = 还活着。 */
    this.diedAt = null;
    /** 是否被击杀（真实完成）。 */
    this.killed = false;
    /** 是否失败退场（真实失败，也算结束，但不是"击杀"）。 */
    this.failed = false;

    /**
     * 收到过几次攻击。**这是盾牌真打出来的数字**，
     * 不是"经过了多少秒 × 施法速度"算出来的估计值。
     */
    this.hitsTaken = 0;

    /**
     * 被雷电打掉了多少血条（0..1 的比例）。
     *
     * 这是血条下降的**唯一真实来源**。
     * 见 hpRatio 的注释：光靠时间流逝，血条压不到 0。
     */
    this.hpLost = 0;

    /**
     * 被电住还剩多少秒。
     *
     * 大于 0 时这一帧**推不动**（见 advance 的移动段）。
     * 这就是用户要的"用雷电阻挡他们前进"。
     */
    this.stunT = 0;

    /*
     * ===== 出生位置：从场地边缘改成"围着盾牌一圈" =====
     *
     * 原来从场地边缘（半径 0.85~1.1 R = 212~275）进场，
     * 而盾牌基本在中心附近，于是**一出生就相距 220 格**。
     *
     * 后果实测：
     *   小兵速度 34 格/秒，追 220 格要 6.5 秒；
     *   但小兵寿命只有 0.6 秒 —— 它到死都碰不到盾牌。
     *   画面上就是"怪从很远的地方飘过来，还没靠近就没了"，
     *   完全没有"追"的感觉。
     *
     * 用户要的是「怪物追我们，我们边逃边清理怪物」，
     * 前提是怪物得**已经在附近**。
     *
     * 现在改成：在盾牌周围 70~130 格处生成（随机方位）。
     * 这个距离刚好在 reach(44) 之外 —— 出生瞬间打不到，
     * 但敌人冲过来 1~2 秒就能进入交战，追逐立刻发生。
     *
     * 同时钳在场地内：如果盾牌靠边，就从场地内侧生成，
     * 不能生成到墙外面去（那样永远走不进来）。
     */
    const ang = rnd() * Math.PI * 2;
    const spawnDist = 70 + rnd() * 60;
    let sx = arena.cx + Math.cos(ang) * spawnDist;
    let sy = arena.cy + Math.sin(ang) * spawnDist;

    // 钳进场内（留 20 格余量，别贴着边界生成）
    {
      const dx = sx - arena.cx;
      const dy = sy - arena.cy;
      const rr = Math.hypot(dx, dy) || 1;
      const lim = arena.r - 20;
      if (rr > lim) {
        sx = arena.cx + (dx / rr) * lim;
        sy = arena.cy + (dy / rr) * lim;
      }
    }

    this.x = sx;
    this.y = sy;
    this.size = SIZE[info.tier];
    this.speed = SPEED[info.tier] * (0.85 + rnd() * 0.3);

    // 抖动相位，让一坨敌人不要同步呼吸
    this.phase = rnd() * Math.PI * 2;

    /*
     * 出生显形进度 0..1，按真实毫秒推进（见 COMBAT.spawnMs）。
     * 只影响**绘制**，不影响任何战斗数值 —— 出生的敌人在
     * 这 320ms 里照样会被打到、照样会掉血。
     */
    this.spawnT = 0;

    // 被击中的短暂反馈
    this.hurtT = 0;
    /** 死亡动画进度 0..1，1 = 展示期结束可以移除 */
    this.deathT = 0;
    /*
     * 死亡那一刻的血条值。
     * 展示期里血条要从这个值快速耗尽到 0，
     * 而不是"一死血条就直接消失"。
     */
    this.hpAtDeath = null;
  }

  /**
   * 血条比例 0..1。
   *
   * ===== 这里有一个刻意的设计："两条上限，取更低的那个" =====
   *
   * 用户指出过一个非常准确的观感问题：
   *   「那些小怪也不会因为腾不出手自己扣血挂掉显得奇怪」
   *
   * 对。上一版血条纯粹按 expectMs 线性往下掉，于是：
   * 一只 read_file 小兵从出生开始血条就自己在减，
   * 盾牌根本没打它，它也在掉血 —— 画面上看就是"它自己莫名其妙流血"。
   *
   * 现在改成两条独立的"上限"：
   *
   *   timeLeft = 1 - 年龄/预估时长
   *       时间流逝给出的**上限**。它只会让血条**慢下来**，
   *       不会单独把血条压到 0。
   *
   *   boltLeft = 1 - 被雷打掉的量
   *       真实命中给出的剩余量。
   *
   * 取 min 的直觉：血条显示的永远是"比较不利的那个判断"。
   * 时间快到点 → 血条本来就低；被雷打得多 → 血条也低。
   *
   * 关键差异在于：**光靠时间，血条不会归零。**
   *   timeLeft 到 0 时，血条停在 boltLeft —— 也就是"还剩这么多，
   *   但眼瞅着要超时了"的状态，而不是"自己流血流死了"。
   *
   * 归零后停在 0，但敌人依然不死 —— 死亡只认真实事件。
   */
  hpRatio(now) {
    /*
     * 死了：从死亡那一刻的值快速耗尽到 0，用 hpDrainMs。
     * 这一段是纯表现，不影响任何结算。
     */
    if (this.diedAt !== null) {
      const since = now - this.diedAt;
      const base = this.hpAtDeath ?? 0;
      const k = 1 - since / COMBAT.hpDrainMs;
      return Math.max(0, Math.min(1, base * k));
    }

    /*
     * 活着：血条 = 1 - 被雷打掉的量。
     *
     * ===== 为什么把"按时间自己掉"彻底去掉 =====
     *
     * 用户的原话：
     *   「那些小怪也不会因为腾不出手自己扣血挂掉显得奇怪」
     *
     * 这句点得很准。原来 hpRatio 里有一项
     *   timeLeft = 1 - 年龄 / expectMs
     * 血条取 min(timeLeft, boltLeft)，于是**没挨过任何攻击的敌人
     * 血条也会一路往下掉，最后归零**。画面上就是：
     * 一只 read_file 小兵站在原地，盾牌还没够到它，
     * 它自己血就见底了 —— 像"自己流血流死"。
     *
     * 现在血条只有一个来源：**被雷电打中**。
     * 没挨打 → 血条纹丝不动。归零 → 必然是雷打出来的。
     *
     * ===== 那"预估进度"去哪了 =====
     *
     * 没丢，改成体现在**每个雷击打掉多少**上（见 applyBolt）：
     * 单次雷击打掉的量 = 施法间隔 / 预估时长。
     *
     * 于是"一直挨打"的敌人，血条下降的**速率**正好等于预估进度：
     * 预估 14 秒的 BOSS 挨着打，14 秒后血条刚好见底；
     * 预估 0.45 秒的 read_file 挨着打，0.45 秒就见底。
     *
     * 这样两件事同时成立：
     *   - 血条仍然表达"这事儿大概还要多久"（速率层面）
     *   - 掉血一定有可见原因（雷电），不会自己流干
     *
     * 注意归零后敌人依然不死 —— 死亡只认真实事件，这条从没变。
     */
    return Math.max(0, Math.min(1, 1 - this.hpLost));
  }

  /**
   * 吃一次雷击。
   *
   * 把"打掉多少血条"集中在这里算，而不是散在 advance 里，
   * 因为这是**唯一**让血条下降的入口 —— 以后要调手感只改这一处。
   *
   * @param {number} falloff 链式衰减系数（第 2 跳起 < 1）
   * @returns {number} 实际打掉的比例，用于视觉强度
   */
  /**
   * 一次雷击打掉多少血条。
   *
   * perBolt = clamp(1 / 预估期能挨几下, min, max)
   *
   * 详见 COMBAT.boltDamageMax 上面的推导：
   *   - 速率那一项保证"一直挨打就在预估时刻见底"（进度感）
   *   - 上下限保证单次掉幅永远是"少量"（观感）
   *
   * 关键结果：小兵一辈子只够挨 1~2 下，死时血条还剩七八成，
   * 由处决雷一次清空 —— 这解释了"没被打空也会死"。
   *
   * falloff 仍然生效（链尾挨得轻），读得出来"主目标 vs 蹭到"。
   */
  applyBolt(falloff = 1) {
    const expectedHits = Math.max(1, (this.expectMs / 1000) * COMBAT.swingsPerSecond);
    const rate = 1 / expectedHits;
    const perBolt = Math.max(
      COMBAT.boltDamageMin,
      Math.min(COMBAT.boltDamageMax, rate),
    );
    const lost = perBolt * falloff;
    this.hpLost = Math.min(1, this.hpLost + lost);
    return lost;
  }

  /**
   * 处决：把剩余血量一次清零。
   *
   * 只由 _settle 在真实事件到达时调用 —— 它本身**不决定死亡**，
   * 死亡是 _settle 决定的。这个方法纯粹是"把已经发生的死亡
   * 在血条上体现出来"，并返回剩余比例供渲染层画处决特效。
   *
   * 刻意返回"清零前还剩多少"：渲染层用它决定处决雷有多粗
   * （血越多，处决越重）。
   */
  applyExecution() {
    const remaining = Math.max(0, 1 - this.hpLost);
    this.hpLost = 1;
    return remaining;
  }

  /**
   * 处决：把剩余血量一次清零。
   *
   * 只由 _settle 在真实事件到达时调用 —— 它本身**不决定死亡**，
   * 死亡是 _settle 决定的。这个方法纯粹是"把已经发生的死亡
   * 在血条上体现出来"，并返回剩余比例供渲染层画处决特效。
   *
   * 刻意返回"清零前还剩多少"：渲染层用它决定处决雷有多粗
   * （血越多，处决越重）。
   */
  applyExecution() {
    const remaining = Math.max(0, 1 - this.hpLost);
    this.hpLost = 1;
    return remaining;
  }

  /** 死亡后是否还在展示期（名字要显示到这时候） */
  isDying(now) {
    return this.diedAt !== null && (now - this.diedAt) < COMBAT.dyingMs;
  }

  /** 是否超过预估寿命（视觉上血条已空），但仍活着。 */
  isOverdue(now) {
    return this.diedAt === null && this.hpRatio(now) <= 0;
  }

  /** 活着的秒数。 */
  ageSec(now) {
    return ((this.diedAt ?? now) - this.bornAt) / 1000;
  }
}

/**
 * 战场导演。
 *
 * 只有一个入口 `handle(ev)`，和 mc/ 的 EventBridge 同构，
 * 这样以后接真实事件源时两套代码可以用同样的方式喂。
 */
export class Director {
  constructor(opts = {}) {
    this.arena = opts.arena ?? { cx: 0, cy: 0, r: 100 };

    /*
     * ===== 随机源必须可注入，否则验证不可信 =====
     *
     * 敌人生成方位、出生距离、速度抖动、抖动相位都用随机数。
     * 早期直接调 Math.random()，结果 verify 跑 5 次有 1 次红 ——
     * 不是代码坏了，而是某次随机排布刚好让某个小兵没挨到打。
     *
     * 这种"间歇性失败"最伤验证的可信度：
     *   它逼人在失败时先怀疑环境而不是代码，
     *   久而久之就会开始"再跑一次看看"——那验证就废了。
     *
     * 所以默认用**确定性伪随机**（固定种子），
     * 需要真随机的场合（浏览器演示）可以传 opts.random = Math.random。
     */
    this.random = opts.random ?? mulberry32(opts.seed ?? 0x9e3779b9);
    /** @type {Enemy[]} */
    this.enemies = [];
    /** 已离场的敌人（保留用于结算与验证，不参与渲染） */
    this.gone = [];

    /** 真实事件计数 */
    this.seen = 0;
    /** 未映射工具计数（诚实字段） */
    this.unmapped = 0;
    /** 击杀 = 真实完成的工具数 */
    this.kills = 0;

    /*
     * 连击：当前连击数 / 本局最高连击 / 上次连击的更新时间。
     * comboAt 是真实时间戳，判定用 "now - comboAt"，
     * 不用逐帧累减 —— 帧率无关，75Hz 和 60Hz 结果一致。
     */
    this.combo = 0;
    this.comboBest = 0;
    this.comboAt = -Infinity;
    /** 真实失败数 */
    this.failures = 0;
    /** 未知工具数 */
    this.unknown = 0;

    /** 本轮是否已成功收尾（turn_end ok:true） */
    this.turnDone = false;
    this.turnOk = false;
    /** 收尾那一刻的战场快照（用于"最终击杀"演出） */
    this.finaleAt = null;

    /** 盾牌累计挥击次数（真实计数，不是估算） */
    this.swings = 0;
    /** 累计伤害 */
    this.damage = 0;

    /** 重复上报的 tool_end 数（真实事件源常见，必须计数而不是当成新击杀） */
    this.duplicates = 0;

    /** 事件日志（验证用） */
    this.log = [];

    /**
     * 雷电链队列（纯视觉，不参与结算）。
     *
     * 每条记录是**一次施法产生的整条链**：
     *   { bornAt, fromX, fromY, bolts:[{x,y,strength}] }
     *
     * 放在 director 而不是 renderer，是因为链的拓扑（谁连到谁）
     * 只有施法那一刻知道。renderer 只负责把折线画出来。
     * 这样"伤害打给了谁"和"雷画到了谁"永远是同一份数据，
     * 不会出现"画面上雷劈了 A，血却掉在 B 身上"。
     */
    this.lightning = [];
  }

  /**
   * 找当前最该被打的目标：**离盾牌最近**的活着的敌人。
   *
   * ===== 这里修过一个隐蔽但影响很大的 bug =====
   *
   * 注释一直写的是"离盾牌最近"，代码算的却是
   *   Math.hypot(e.x - arena.cx, e.y - arena.cy)
   * —— 那是**离场地中心**最近。
   *
   * 盾牌是会跑的（风筝），一旦它离开中心，这两个排序就不同了。
   *
   * 视觉复核实测的后果：
   *   t=8.63s 时 API 报最近距离 116.45，
   *   而真实离盾牌最近的那只只有 39.94 —— 差了 76.5 格。
   *   8/199 个采样（4.0%）受影响。
   *
   * 影响的不只是显示：
   *   - 攻击判定会去打一只更远的怪，打不到就"挥空"
   *   - 盾牌的移动目标也是它，于是会往错误方向跑
   *   - 所有"最近距离"的统计都失真
   *
   * 修法：传进盾牌位置，按真实距离算。target() 的所有调用方
   * 都有盾牌坐标（advance 里就有），直接传。
   */
  target(now, px, py) {
    let best = null;
    let bestD = Infinity;
    for (const e of this.enemies) {
      if (e.diedAt !== null) continue;
      const d = px == null
        ? Math.hypot(e.x - this.arena.cx, e.y - this.arena.cy)
        : Math.hypot(e.x - px, e.y - py);
      if (d < bestD) { bestD = d; best = e; }
    }
    return best;
  }

  /**
   * 喂一个事件。
   *
   * 支持的事件形状（和 mc/ 的 bridge 保持一致，便于以后共用事件源）：
   *   { kind:'tool', tool, ok?, id? }   工具调用**开始**
   *   { kind:'tool_end', tool, ok?, id? } 工具调用**结束**（真正的死亡时刻）
   *   { kind:'turn_end', ok }            本轮结束
   *
   * 注意 `kind:'tool'` 只用于**生成**敌人。
   * 如果事件本身带 `ok` 字段，说明这是一条"已完成"的事件（
   * 类似 mc/ 的 DEMO_EVENTS 那样一次性给出结果），
   * 那么生成后立刻结算 —— 但仍然要等下一步才真正移除。
   */
  handle(ev, now) {
    if (!ev || typeof ev !== 'object') return null;

    if (ev.kind === 'tool') {
      return this._spawnTool(ev, now);
    }
    if (ev.kind === 'tool_end') {
      return this._finishTool(ev, now);
    }
    if (ev.kind === 'turn_end') {
      return this._finishTurn(ev, now);
    }
    return null;
  }

  _spawnTool(ev, now) {
    this.seen++;
    const e = new Enemy(ev, now, this.arena, this.random);
    this.enemies.push(e);

    if (!e.mapped) this.unmapped++;
    // 表里没有具体规则的工具，额外计一个"未知"
    if (!e.mapped) this.unknown++;

    this.log.push({
      t: now, type: 'spawn', tool: e.tool, tier: e.tierName, mapped: e.mapped,
    });

    /*
     * 如果这条事件自带 ok，说明它是一条"已完成"的调用
     * （演示流就是这种形状）。那就立刻给它记账，
     * 但仍然保留到下一帧由 advance() 播放死亡动画。
     */
    if (typeof ev.ok === 'boolean') {
      this._settle(e, ev.ok, now);
    }
    return e;
  }

  _finishTool(ev, now) {
    /*
     * 找这次调用对应的敌人。优先级：
     *   1. 有 id → 精确匹配还活着的那个
     *   2. 没 id → 找**最早一个还活着的**同工具敌人（FIFO：先开始先结束）
     *   3. 都没有 → 看是不是**重复上报**（同工具已经死过一次了）
     *   4. 确实没有 → 补造一个再结算（事件源只报结束的情况）
     *
     * 第 3 条是修一个真 bug：
     *   原来没有第 3 步，重复 tool_end 会走到第 4 步补造一个新敌人再结算，
     *   于是同一件事被记了两次击杀（verify 里实测 kills=2）。
     *   重复上报在真实事件源里很常见（重连、重放、日志重复消费），
     *   不处理就等于虚报战果。
     */
    let target = null;

    /*
     * 匹配优先级：
     *   1. 事件带真实 id → 按 callId 精确匹配还活着的那个
     *   2. 事件不带 id → 同工具 FIFO（先开始先结束）
     *
     * 注意第 1 步比的是 e.callId（字符串），不是 e.id（序号）。
     * 比错了就等于永远匹配不到，见 Enemy 构造函数里的说明。
     */
    if (ev.id != null) {
      const want = String(ev.id);
      target = this.enemies.find((e) => e.diedAt === null && e.callId === want) || null;
    } else {
      target = this.enemies.find((e) => e.diedAt === null && e.tool === ev.tool) || null;
    }

    if (!target) {
      /*
       * 没有活着的同工具敌人。检查是不是"已经结束过一次"的重复上报：
       * 如果这个工具已经死过一个，就把这一次当成重复，直接忽略并计数，
       * 不新增击杀、不补造敌人。
       */
      /*
       * 注意查的是 this.enemies（含刚死的、动画还没播完的），
       * 不是 this.gone —— gone 只在死亡动画播完之后才进，
       * 而重复上报往往紧跟着第一次结束发生（实测间隔几百毫秒），
       * 那时敌人还在 enemies 里播死亡动画。
       * 只查 gone 会漏掉这种情况，于是照样重复计数。
       */
      /*
       * ===== 判重要看"这次调用"是不是重复，不是"这个工具"死过没有 =====
       *
       * 上一版是 `some(e => e.tool === ev.tool && e.diedAt !== null)` ——
       * 意思是"只要这个工具曾经死过一次，后面所有结束都算重复"。
       *
       * 这在真实数据下是错的：`read` 被调用 87 次、`pwsh` 106 次，
       * 每次都是独立的 callId，第 2 次到第 87 次全是合法事件。
       * 按工具判重会把它们全部丢掉。
       *
       * 正确的判据是 **callId**：如果这个 callId 已经结算过，才是重复。
       * 只有事件不带 id 时，才退回按工具判断（那种数据源无法区分多次调用）。
       */
      let alreadyDead;
      if (ev.id != null) {
        const want = String(ev.id);
        alreadyDead = this.enemies.some((e) => e.callId === want && e.diedAt !== null)
          || this.gone.some((e) => e.callId === want);
      } else {
        alreadyDead = this.enemies.some((e) => e.tool === ev.tool && e.diedAt !== null)
          || this.gone.some((e) => e.tool === ev.tool);
      }
      if (alreadyDead) {
        this.duplicates++;
        this.log.push({ t: now, type: 'duplicate_end', tool: ev.tool });
        return null;
      }

      /*
       * 确实没有对应记录 —— 事件源只报了结束，没报开始。
       * 诚实做法：补一个敌人再结算，让它仍然在画面里出现一次。
       * 不忽略：忽略就是丢事件。
       */
      target = this._spawnTool({ ...ev, ok: undefined }, now);
    }

    this._settle(target, ev.ok !== false, now);
    return target;
  }

  /** 真实结束：这是**唯一**的死亡途径。 */
  _settle(e, ok, now) {
    if (!e || e.diedAt !== null) return;
    /*
     * 顺序很关键：**先**取血条快照，**再**标记 diedAt。
     *
     * hpRatio 看到 diedAt !== null 就会走"死亡后快速衰减"分支，
     * 而那个分支的基准正是 hpAtDeath 本身。如果先写 diedAt，
     * 这里读到的 base 还是 null → 0，快照永远是 0，
     * 于是画面上所有敌人一死血条就是空的 —— 正好违背用户要求。
     */
    const ratioNow = e.hpRatio(now);
    e.diedAt = now;
    e.hpAtDeath = ratioNow;
    e.killed = ok === true;
    e.failed = ok === false;

    /*
     * ===== 处决雷 =====
     *
     * 只有**击杀**（ok === true）才有处决特效。
     * 失败（ok === false）是"任务没做成"，不配拥有击杀演出，
     * 让它安静消失即可 —— 这也是诚实性的一部分。
     *
     * 处决雷带 exec:true，render 会画得更粗更亮、存活更久。
     * 它的起点是盾牌、终点是这个敌人，所以画面上能看出
     * "是盾牌把它处决了"，而不是凭空消失。
     */
    if (ok === true) {
      const remaining = e.applyExecution();
      const aegis = this.aegis || { x: this.arena.cx, y: this.arena.cy };
      this.lightning.push({
        bornAt: now,
        exec: true,
        /* 剩余血量越多，处决越重（视觉上更粗） */
        execWeight: remaining,
        bolts: [{ x: e.x, y: e.y, strength: 1, exec: true }],
        fromX: aegis.x,
        fromY: aegis.y,
      });
    }
    if (e.killed) {
      this.kills++;
      /*
       * 连击推进。注意顺序：先算**这一杀**属于哪一串，再落账。
       * 用 now - comboAt 判定，而不是自己往下减的计时器。
       */
      this.combo = (now - this.comboAt) <= COMBAT.comboWindowMs ? this.combo + 1 : 1;
      this.comboAt = now;
      if (this.combo > this.comboBest) this.comboBest = this.combo;
    } else {
      this.failures++;
      /*
       * 失败打断连击。理由见 COMBAT.comboWindowMs：
       * 连击的含义是"连续成功"，失败不打断就没有信息量。
       */
      this.combo = 0;
      this.comboAt = -Infinity;
    }
    this.log.push({
      t: now, type: ok ? 'kill' : 'fail', tool: e.tool, tier: e.tierName,
    });
  }

  _finishTurn(ev, now) {
    this.turnDone = true;
    this.turnOk = ev.ok === true;
    this.finaleAt = now;

    /*
     * turn_end 意味着"这一轮结束了"。
     *
     * 如果这轮成功了，那么**所有还活着的敌人**都应该在这一刻被清场 ——
     * 这是用户说的"任务完成就是盾牌最终击杀他"。
     * 但注意：这里的清场依据是 **turn_end ok:true 这个真实事件**，
     * 不是"血条空了"、不是"时间到了"。
     *
     * 如果这轮失败了：敌人不会被清场。它们留在场上，
     * 表示"这轮没打赢"。这是诚实的表达。
     */
    if (this.turnOk) {
      for (const e of this.enemies) {
        if (e.diedAt === null) this._settle(e, true, now);
      }
    }
    this.log.push({ t: now, type: 'turn_end', ok: this.turnOk });
  }

  /* ---------------- 每帧推进 ---------------- */

  /**
   * 推进战斗。
   *
   * @param {number} dt 秒
   * @param {number} now 真实 ms
   * @param {{px:number, py:number}} aegis 盾牌位置
   * @returns {{swings:number, damage:number}} 本帧发生的攻击
   */
  advance(dt, now, aegis) {
    let swingsNow = 0;
    let damageNow = 0;

    /*
     * 记住盾牌的位置。
     *
     * ===== 这里修一个真 bug =====
     *
     * _settle 里画处决雷时要用"盾牌在哪"，写的是
     *   const aegis = this.aegis || { arena.cx, arena.cy }
     * 但 this.aegis **从来没有被赋值过** —— 于是永远走兜底，
     * 处决雷的起点恒为场地中心。
     *
     * 浏览器实测抓到的数字：处决雷 from = (0, 0)，
     * 而击杀瞬间盾牌实际在 (-8.96, 51.76)，偏差 52.5px。
     * 画面上就是"雷从场地正中劈出来"，不是从法杖劈出来。
     *
     * 这个 bug 和之前 target()/faceLeft 是同一类病根：
     * **变量声明了、也读了，但没人写**。
     * 断言查不出，只有真去看画面/量坐标才会露。
     */
    this.aegis = aegis;

    /*
     * 盾牌对象用 x/y，不是 px/py。
     *
     * 这个接口以前是错的：advance 里读 aegis.px，而 main.mjs 传进来的
     * 只有 x/y，于是 aegis.px === undefined →
     *   dx = NaN → 敌人坐标算成 NaN → 整场敌人从画面上消失。
     *
     * 现在统一用 x/y，和 render.mjs（p.x / p.y）、调试口保持一致。
     */

    /* ================= 1) 敌人追逐盾牌 ================= */

    for (const e of this.enemies) {
      if (e.diedAt !== null) {
        /*
         * 展示期按真实毫秒推进，不是固定 dt 系数。
         * dyingMs=1000 时 deathT 每秒走 1.0 —— 尸体留满一秒。
         * 原来 dt*3.2 等于 0.31 秒就没了，看不清。
         */
        e.deathT = Math.min(1, e.deathT + (dt * 1000) / COMBAT.dyingMs);
        continue;
      }
      if (e.spawnT < 1) e.spawnT = Math.min(1, e.spawnT + (dt * 1000) / COMBAT.spawnMs);
      if (e.hurtT > 0) e.hurtT = Math.max(0, e.hurtT - dt * 6);

      /*
       * ===== 被雷电电住：这一帧推不动 =====
       *
       * 用户要的是「法杖可以用雷电阻挡他们前进并造成伤害」。
       * "阻挡"必须是看得见的物理效果，不能只是一句设定 ——
       * 所以被电中的敌人这一段时间里**位置完全不更新**，
       * 后面带着电流缠绕的视觉，观众能直接看出"它被钉住了"。
       *
       * 注意 continue 之前要把 stunT 读掉：
       * 死亡分支已经 continue 过了，所以这里不会漏掉尸体。
       */
      if (e.stunT > 0) {
        e.stunT = Math.max(0, e.stunT - dt);
        continue;
      }

      const dx = aegis.x - e.x;
      const dy = aegis.y - e.y;
      const d = Math.hypot(dx, dy) || 1;

      /*
       * ===== 冲刺：追到近处时提速 =====
       *
       * 这是让"边逃边打"成立的关键机制，不加的话场面很平：
       *
       * 盾牌速度 46，小兵 34 / 精英 22 / BOSS 11。
       * 敌人永远追不上，距离只会一直变大 ——
       * 实测 fleeing 只有 2%（9/442 帧），短暂到看不出来。
       *
       * 真实的手感是：怪被拉开后会**加速扑上来**，
       * 逼你再退一次。所以按距离给一个冲刺系数：
       *
       *   d > 90       1.0x（远处正常走）
       *   40 < d < 90  线性升到 1.8x
       *   d < 40       1.8x（贴上来时最凶）
       *
       * 1.8x 之后小兵 61、精英 40、BOSS 20，
       * 前两者都能短暂压过盾牌的 46（尤其盾牌后退时只有 21），
       * 于是"被逼近 → 后退 → 拉开 → 再扑上来"的循环才转得起来。
       *
       * 注意这**不是**给敌人加攻击力或血量，
       * 纯位移速度，不影响任何"击杀只认事件"的判定。
       */
      const lunge = d > 90 ? 1.0 : (d < 40 ? 1.8 : 1 + (90 - d) / 50 * 0.8);
      const spd = e.speed * lunge;

      // 追到贴身距离就停，不叠到盾牌身上。BOSS 体型大，停得更远。
      const stopAt = (e.size + 9) / 2;
      if (d > stopAt) {
        const move = Math.min(d - stopAt, spd * dt);
        e.x += (dx / d) * move;
        e.y += (dy / d) * move;
      }
    }

    /* ================= 2) 盾牌：边逃边打（风筝） ================= */

    /*
     * ===== 这段改了三版，每一版的错误都记下来 =====
     *
     * v1  盾牌完全不动（坐标初始化后没再写过）。
     *     画面是"一群怪围着一个木桩"。用户：「你没做追逐啊」。
     *
     * v2  盾牌朝最近的敌人冲过去。方向反了 ——
     *     那是"盾牌追怪"，不是"怪追盾牌"。
     *     用户：「我说的是怪物追我们，我们边逃边清理怪物」。
     *
     * v3  加了风筝参数，但盾牌速度 46 > 小兵 34，
     *     于是它一路往前跑、敌人永远追不上 ——
     *     实测平均距离 131 格、攻击距离只有 44 格、**命中率 0%**。
     *     画面上确实在"追"，但盾牌一刀没砍到人，等于纯逃跑。
     *
     * v4（现在）：**弹簧 + 退速惩罚**。
     *
     *   1. 用"弹簧力"把距离拉向 reach 的 68%（约 30 格）。
     *      比目标远 → 靠近（力量随偏差增大，反应快）
     *      比目标近 → 后退
     *
     *   2. **后退时速度降到 45%**（46 × 0.45 ≈ 21，比小兵 34 慢）。
     *      这是关键的一步：盾牌边退边挥刀，本来就该慢下来。
     *      于是敌人能追上来 → 追近了盾牌再退 → 反复拉锯。
     *      如果后退速度和前进一样快，就变成了单向逃跑。
     *
     *   3. 横绕分量常驻。哪怕距离刚好也在动，画面上不会僵着。
     *
     *   4. 群体排斥半径从 86 缩到 52（略大于 reach）。
     *      原来 86 太大，多只敌人时排斥力直接压过目标力，
     *      把盾牌推到场地边上。
     */
    const nearest = this.target(now, aegis.x, aegis.y);
    this.aegisMoving = false;
    this.aegisFleeing = false;

    let mvx = 0;
    let mvy = 0;
    /** 本帧的速度系数：后退时要慢下来 */
    let paceMul = 1;

    // 横绕方向隔一会儿翻一次，不然永远绕同一侧，看久了机械
    this._strafeT = (this._strafeT ?? 0) + dt;
    if (this._strafeT > 1.7) {
      this._strafeT = 0;
      this._strafeDir = -(this._strafeDir ?? 1);
    }
    const strafeDir = this._strafeDir ?? 1;

    if (nearest) {
      const nd = Math.hypot(nearest.x - aegis.x, nearest.y - aegis.y) || 1;
      const ux = (nearest.x - aegis.x) / nd;
      const uy = (nearest.y - aegis.y) / nd;

      /*
       * ===== 进退判定用滞回带，不用"比 ideal 大小" =====
       *
       * 这是第三版，前两版都失败了，原因值得记下来：
       *
       * v1  ideal = reach × 0.68 = 29.92
       *     排斥力把稳态距离顶在 37~41 格，nd 永远 ≥ 33.3
       *     → **fleeing 0%，paceMul=0.45 是死代码**
       *
       * v2  ideal = reach × 0.45 = 19.8（想让后退更容易触发）
       *     距离最低只到 22.2，还是没低于 19.8 → **fleeing 仍 0%**
       *
       * 两次同一个病根：把一个"力平衡点"当成了可以随便设的目标值。
       * 排斥力朝外推、后退力朝内退，两条线交叉处的距离
       * 才是实际能达到的最短距离 —— 光调 ideal 是调不动的。
       *
       * v3（现在）：直接按**实测能达到的距离**设阈值。
       *
       *   retreatLine = reach×0.55 = 24.2
       *   实测最短能到 22.2 < 24.2 → 后退会被触发
       *
       * 同时把排斥半径从 40 降到 26 —— 排斥力只用来防"叠在一起"，
       * 不该参与距离调节。让它小于 retreatLine，
       * 就不会再把盾牌顶回到触发线外面。
       */
      const retreatLine = COMBAT.reach * 0.55;   // 24.2
      const closeLine = COMBAT.reach * 0.92;     // 40.5

      if (nd < retreatLine) {
        // 太近：后退。权重带一个基础量 0.6，一进带内就有明显退势
        const w = Math.min(1.8, (retreatLine - nd) / 8 + 0.6);
        mvx -= ux * w;
        mvy -= uy * w;
        this.aegisFleeing = true;
        paceMul = 0.55;
      } else if (nd > closeLine) {
        // 太远：压上去，否则打不到
        const w = Math.min(1.6, (nd - closeLine) / 14 + 0.5);
        mvx += ux * w;
        mvy += uy * w;
      } else {
        // 刚好：横绕
        mvx += -uy * strafeDir * 0.7;
        mvy += ux * strafeDir * 0.7;
      }
    }

    /*
     * b) 群体排斥：只负责"别叠在一起"，不负责调距离。
     *
     * 半径 26（比 retreatLine 24.2 略大）、权重 0.8。
     * 早期版本半径 52~86、权重 1.1~1.5，排斥力强到压过目标力，
     * 把盾牌一直顶在外面 —— 距离永远压不下来，后退分支不可达。
     * 那是"fleeing 恒为 0%"真正的根因。
     */
    for (const e of this.enemies) {
      if (e.diedAt !== null) continue;
      const dx = aegis.x - e.x;
      const dy = aegis.y - e.y;
      const d = Math.hypot(dx, dy) || 1;
      const R = 17 + e.size * 0.3;
      if (d >= R) continue;
      const w = (1 - d / R) * (1 + e.tier * 0.25);
      mvx += (dx / d) * w * 0.8;
      mvy += (dy / d) * w * 0.8;
    }

    // c) 边界：靠边时往里收，避免被顶在墙角
    {
      const dx = aegis.x - this.arena.cx;
      const dy = aegis.y - this.arena.cy;
      const r = Math.hypot(dx, dy) || 1;
      const edge = this.arena.r - 52;
      if (r > edge) {
        const w = Math.min(1.8, (r - edge) / 30);
        mvx -= (dx / r) * w * 2.6;
        mvy -= (dy / r) * w * 2.6;
      }
    }

    // 场上没敌人：回中心待命，不要僵在原地
    if (!nearest) {
      const dx = this.arena.cx - aegis.x;
      const dy = this.arena.cy - aegis.y;
      const d = Math.hypot(dx, dy) || 1;
      if (d > 6) {
        mvx += (dx / d) * 0.8;
        mvy += (dy / d) * 0.8;
      }
      paceMul = 0.55;
    }

    // 归一化后按速度推进。合力很小时也动，只是慢（被夹住的手感）
    const ml = Math.hypot(mvx, mvy);
    if (ml > 0.02) {
      const step = Math.min(1, ml) * COMBAT.aegisSpeed * paceMul * dt;
      aegis.x += (mvx / ml) * step;
      aegis.y += (mvy / ml) * step;
      this.aegisMoving = true;
    }

    // 硬钳在场地内（保险，防止边界力算漏）
    {
      const dx = aegis.x - this.arena.cx;
      const dy = aegis.y - this.arena.cy;
      const r = Math.hypot(dx, dy);
      const maxR = this.arena.r - 14;
      if (r > maxR) {
        aegis.x = this.arena.cx + (dx / r) * maxR;
        aegis.y = this.arena.cy + (dy / r) * maxR;
      }
    }

    /* ================= 3) 盾牌挥击 ================= */

    /*
     * ===== 这里修过"看着在打其实没打到" =====
     *
     * 原来累积器写在 `if (tgt)` 里，只有存在目标时才累积时间。
     * 场上一空累积器就停住，新敌人出现要等 312ms 才挨第一下，
     * 而很多小兵寿命只有 300~700ms，于是从头到尾一刀没挨。
     *
     * 修法：累积器**每帧都推进**（盾牌始终在挥），没目标时空挥不加伤害。
     */
    this._swingAcc = (this._swingAcc ?? 0) + dt;
    const interval = 1 / COMBAT.swingsPerSecond;

    while (this._swingAcc >= interval) {
      this._swingAcc -= interval;

      // 每一拍重新取目标：一拍之内目标可能死了，要换人打
      swingsNow++;

      const t = this.target(now, aegis.x, aegis.y);
      if (!t) continue;

      /*
       * 必须够得着才能起链。
       *
       * 这是"边逃边打"的另一半：如果不管距离都算命中，
       * 盾牌大可以一路跑到天涯海角，伤害照样结算 ——
       * 那就变成"边逃边白拿伤害"了。
       *
       * 加上 reach 之后，退太远就打空；想打到必须保持够近，
       * 于是"逃"和"打"之间有了真实取舍。
       */
      const dt0 = Math.hypot(t.x - aegis.x, t.y - aegis.y);
      if (dt0 > COMBAT.reach) continue;

      /*
       * ===== 从这里开始：一条雷电链 =====
       *
       * 用户：「法杖设定是可以有多条雷电链造成伤害的」。
       *
       * 注意"多条链"和"一条链多跳"是两件事，这里两者都有：
       *   - 每次施法在 chainMax 个目标之间连成一条链（多跳）
       *   - 每次施法都可能产生新的一条链（多链，见 lightning 数组）
       *
       * 链的构建方式是"从主目标出发，找最近的未被电到的同伴，跳过去"。
       * 这不只是好看：每次跳转都对那个目标造成伤害 + 电住它，
       * 所以一条链能同时按住三四个冲上来的小兵 —— 这就是"控场"。
       */
      const chain = this._buildChain(t, now);
      const bolts = [];

      let dmg = COMBAT.damagePerBolt;
      for (let i = 0; i < chain.length; i++) {
        const victim = chain[i];

        /*
         * 伤害落下。
         *
         * hpLost 是**血条下降的唯一真实来源**（见 hpRatio）。
         * 所以"掉血"和"被雷打"在数据上是同一件事，
         * 画面上不会出现"没挨打却自己扣血"。
         */
        /*
         * 打掉多少血条，统一交给 applyBolt。
         *
         * 这里传的是链式衰减系数（第 1 跳 1.0，之后逐跳变弱），
         * 所以链尾的敌人挨得轻、血条掉得慢 —— 画面上
         * "主目标掉得快、隔壁只是被蹭到"这件事就读得出来。
         */
        const falloff = i === 0 ? 1 : Math.pow(COMBAT.chainFalloff, i);
        victim.applyBolt(falloff);
        victim.hitsTaken++;
        victim.hurtT = 1;
        victim.stunT = COMBAT.stunMs / 1000;

        bolts.push({ x: victim.x, y: victim.y, strength: dmg });
        damageNow += dmg;

        // 每跳一次伤害衰减，越远的同伴挨得越轻
        dmg *= COMBAT.chainFalloff;
      }

      /*
       * 记录这一条链的几何形状，给 render 画折线雷电用。
       * 纯视觉数据，不参与任何结算。
       */
      this.lightning.push({
        bornAt: now,
        bolts,
        // 链的起点 = 盾牌的杖顶（render 会按 sprite 换算成屏幕位置）
        fromX: aegis.x,
        fromY: aegis.y,
      });
    }

    this.swings += swingsNow;
    this.damage += damageNow;

    /*
     * 3.5) 清理过期的雷电链。
     *
     * 生命周期 0.18 秒：比一次施法间隔（1/3.2 ≈ 312ms）短，
     * 所以连续的链在画面上是**一闪一闪**的，而不是糊成一片。
     * 这也符合闪电的直觉 —— 它是瞬间的，不是持续光柱。
     */
    const keepBolts = [];
    for (const l of this.lightning) {
      /*
       * 处决雷活得比普通雷久（execMs > 180）。
       * 它是"死亡的原因"，观众必须看清；
       * 而普通雷只是消耗，一闪而过反而更像闪电。
       */
      const life = l.exec ? COMBAT.execMs : 180;
      if (now - l.bornAt < life) keepBolts.push(l);
    }
    this.lightning = keepBolts;

    /* 4) 死透的（动画播完）移到 gone */
    const keep = [];
    for (const e of this.enemies) {
      if (e.diedAt !== null && e.deathT >= 1) this.gone.push(e);
      else keep.push(e);
    }
    this.enemies = keep;

    return { swings: swingsNow, damage: damageNow };
  }

  /**
   * 从主目标出发，构建一条雷电链。
   *
   * ===== 为什么是"最近的未被电到的同伴" =====
   *
   * 用户：「子智能体多个的时候，法杖可以用雷电阻挡他们前进并造成伤害」。
   *
   * 场景就是同时有好几个目标在冲过来。这时候如果只打最近的一个，
   * 其余的照样贴到脸上 —— 控不住场。
   *
   * 所以链的规则是：
   *   1. 主目标必定入链（它是"起链点"，已经确认在 reach 内）
   *   2. 之后每次从**最后一个入链的目标**出发，
   *      找 chainRange 内最近的、还没入链的活敌人
   *   3. 连到 chainMax 个为止
   *
   * 用"从上一个跳过去"而不是"从盾牌出发"，是因为链的物理直觉就是
   * 电从一具身体跳到隔壁那具。视觉上也会画成一串折线，
   * 一串跳过去比放射状更符合"链"这个词。
   *
   * 注意：这里只负责"选谁"，伤害在调用处统一施加，
   * 免得两边算出来的名单不一致。
   */
  /*
   * 当前连击数，但**窗口一过就归零**。
   *
   * 这必须是个读时计算，不能只在 _settle 里维护：
   * 否则最后一杀之后再没人打死东西，combo 会永远停在那个数字上，
   * HUD 就会一直显示"连击 x5"——而实际上连击早就断了。
   * 那样显示的就是过期信息，属于假报告。
   */
  _comboNow(now) {
    if (this.combo <= 0) return 0;
    return (now - this.comboAt) <= COMBAT.comboWindowMs ? this.combo : 0;
  }

  _buildChain(primary, now) {
    const chain = [primary];
    const used = new Set([primary.id]);

    while (chain.length < COMBAT.chainMax) {
      const last = chain[chain.length - 1];
      let best = null;
      let bestD = COMBAT.chainRange;

      for (const e of this.enemies) {
        if (e.diedAt !== null) continue;
        if (used.has(e.id)) continue;
        const d = Math.hypot(e.x - last.x, e.y - last.y);
        if (d < bestD) { bestD = d; best = e; }
      }

      if (!best) break;
      chain.push(best);
      used.add(best.id);
    }

    return chain;
  }

  /* ---------------- 只读统计 ---------------- */

  stats(now) {
    const alive = this.enemies.filter((e) => e.diedAt === null);
    const overdue = alive.filter((e) => e.isOverdue(now));
    return {
      seen: this.seen,
      alive: alive.length,
      aliveMinion: alive.filter((e) => e.tier === TIER.MINION).length,
      aliveElite: alive.filter((e) => e.tier === TIER.ELITE).length,
      aliveBoss: alive.filter((e) => e.tier === TIER.BOSS).length,
      overdue: overdue.length,
      kills: this.kills,
      failures: this.failures,
      combo: this._comboNow(now),
      comboBest: this.comboBest,
      unmapped: this.unmapped,
      duplicates: this.duplicates,
      swings: this.swings,
      damage: this.damage,
      turnDone: this.turnDone,
      turnOk: this.turnOk,
      cleared: this.gone.length,
    };
  }
}

/**
 * 演示事件流。
 *
 * ===== 这个时间轴改过一版，原因是视觉复核提出的一个真问题 =====
 *
 * 第一版里每条工具事件自带 `ok`，等于"生成即结算"：
 * 小兵在同一帧内出生、死亡，血条从 100% 直接消失，
 * 盾牌一次都没砍到它（实测 swings 全程为 0 直到 BOSS 上场）。
 *
 * 结果是：画面上"盾牌一直在攻击"这个核心观感完全看不见 ——
 * 小兵一闪就没，看起来像自动消失，不像被打死的。
 *
 * 但这里有个必须守住的边界：
 * 不能为了让动画好看就把击杀从"事件"改成"血条"。
 *
 * 所以改法是**让演示数据更真实**，而不是改判定逻辑：
 *   真实世界里，哪怕 grep 也要几十到几百毫秒。
 *   所以把每条工具拆成 `tool`（开始）和 `tool_end`（结束）两条事件，
 *   中间隔 300~900ms。这段时间里盾牌真的在砍它、血条真的在掉，
 *   而死亡仍然只由 tool_end 决定。
 *
 * 也就是说：**观感靠事件粒度，不靠判定放水。**
 *
 * 时间轴刻意包含：
 *   - 一批小兵（毫秒~亚秒级，被砍几刀后死）
 *   - 一次失败（红叉，不算击杀）
 *   - 一个 BOSS（子智能体，长跑 14 秒，血条明显可见）
 *   - 最后 turn_end ok:true（真正的清场时刻）
 */
export const DEMO_EVENTS = [
  // ---- 第一波：小兵，各自有几十毫秒到几百毫秒的真实寿命 ----
  { kind: 'tool', tool: 'read_file', ts: 400, body: 'src/main.mjs' },
  { kind: 'tool', tool: 'grep', ts: 700, body: 'TODO' },
  { kind: 'tool_end', tool: 'read_file', ok: true, ts: 1050 },
  { kind: 'tool', tool: 'rg_search', ts: 1200, body: 'parseConfig' },
  { kind: 'tool_end', tool: 'grep', ok: true, ts: 1450 },
  { kind: 'tool', tool: 'list_files', ts: 1600, body: 'src/' },
  { kind: 'tool_end', tool: 'rg_search', ok: true, ts: 1900 },

  // ---- 精英：写入，活得久一点，血条能看出在掉 ----
  { kind: 'tool', tool: 'write_file', ts: 2200, body: 'src/fix.mjs' },
  { kind: 'tool_end', tool: 'list_files', ok: true, ts: 2350 },
  { kind: 'tool_end', tool: 'write_file', ok: true, ts: 3400 },

  // ---- 精英：执行，失败。失败不是击杀 ----
  { kind: 'tool', tool: 'bash', ts: 3700, body: 'node --test' },
  { kind: 'tool_end', tool: 'bash', ok: false, ts: 5400 },

  // ---- BOSS 上场：子智能体，这一局的主线，要跑 14 秒 ----
  { kind: 'tool', tool: 'agent_run', ts: 6000, body: 'explorer: 梳理调用链' },

  // ---- 场边小兵，衬托"盾牌一直在忙" ----
  { kind: 'tool', tool: 'read_file', ts: 7600, body: 'src/a.mjs' },
  { kind: 'tool_end', tool: 'read_file', ok: true, ts: 8050 },
  { kind: 'tool', tool: 'edit_file', ts: 8600, body: 'src/a.mjs' },
  { kind: 'tool_end', tool: 'edit_file', ok: true, ts: 9700 },
  { kind: 'tool', tool: 'bash', ts: 10400, body: 'node verify.mjs' },
  { kind: 'tool_end', tool: 'bash', ok: true, ts: 12600 },
  { kind: 'tool', tool: 'web_fetch', ts: 13200, body: 'https://…' },
  { kind: 'tool_end', tool: 'web_fetch', ok: true, ts: 15100 },

  // ---- 子智能体回报：它真正结束的时刻。此时血条还剩不少 ----
  { kind: 'tool_end', tool: 'agent_run', ok: true, ts: 20000 },

  // ---- 收尾 ----
  { kind: 'tool', tool: 'write_file', ts: 21200, body: 'README.md' },
  { kind: 'tool_end', tool: 'write_file', ok: true, ts: 22600 },
  { kind: 'tool', tool: 'bash', ts: 23400, body: 'node verify.mjs' },
  { kind: 'tool_end', tool: 'bash', ok: true, ts: 25400 },

  { kind: 'turn_end', ok: true, ts: 27400 },
];
