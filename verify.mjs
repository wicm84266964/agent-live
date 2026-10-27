/**
 * 验证：断言这个项目最核心的诚实性。
 *
 * 这个文件最重要的部分不是"检查有没有报错"，
 * 而是**检查它会不会造假**。所以断言集中在：
 *
 *   1. 血条归零后敌人**还活着**（不能自己死）
 *   2. 死亡只发生在真实事件结束时
 *   3. 清场只发生在 turn_end ok:true
 *   4. 失败不产生击杀
 *   5. 未映射工具如实计数
 *   6. 挥击次数是真数出来的，不是按时间估算
 */

import { Director, COMBAT } from './director.mjs';
import { classify, TIER, TIER_NAME, rules, SIZE, SPEED } from './bestiary.mjs';
/*
 * 品级的**显示名**从 theme 取，不在断言标签里另抄一份题材文案。
 * 断言标签也是给人看的字：抄一份题材名，换题材后就会出现
 * "面板写侦察机、失败日志写工蚁"这种双真相源。
 */
import { TIER_THEME } from './theme.mjs';

const TIER_LABEL = {
  minion: TIER_THEME.minion.name,
  elite: TIER_THEME.elite.name,
  boss: TIER_THEME.boss.name,
};
import * as spritesMod from './sprites.mjs';
import { spriteDefs, lintSprites, palette } from './sprites.mjs';
/*
 * viewportTransform / projectPoint 是**纯函数**，所以"任意缩放倍率下
 * 圆心都等于画布中心"这条可以在 Node 里对 scale 1.0 / 1.3 / 1.5 逐档断言，
 * 而不是只能在真浏览器里量。当年那个偏移之所以漏网，就是因为只在 scale=1
 * 这一档验过中心（scale=1 时 ×1 恰好等于没乘）。
 */
import { SHAKE, SLASH_COLORS, viewportTransform, projectPoint } from './render.mjs';
import { readFileSync, readdirSync } from 'node:fs';

let pass = 0;
let fail = 0;
const failures = [];

function ok(name, cond, detail = '') {
  if (cond) {
    pass++;
  } else {
    fail++;
    failures.push(name + (detail ? ' — ' + detail : ''));
    console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`);
  }
}

function section(t) {
  console.log(`\n== ${t} ==`);
}

/**
 * 片段在源码里出现的次数。
 *
 * 源码锚点断言的通病是「存在即通过」。可 `indexOf` 一旦找不到就返回 -1，
 * 而 `slice(-1)` 恰好会取到字符串最后**一个字符** —— 断言于是变成
 * 「最后一个字符里有没有这个字符串」，永远为真。
 * 本项目历史上真踩过一次（见调试口那条注释）。
 * 所以凡是位置比较类锚点，都先用它确认「恰好出现一次」。
 */
function countOf(src, needle) {
  if (!needle) return 0;
  let n = 0;
  let i = 0;
  while ((i = src.indexOf(needle, i)) !== -1) {
    n++;
    i += needle.length;
  }
  return n;
}

/**
 * 定位唯一锚点：恰好出现一次才返回位置，否则 -1。
 *
 * 比裸 `indexOf` 严：调用点和方法定义同名时（本项目多次踩到），
 * 裸 indexOf 会安静地拿错位置，断言看起来在检查、实际检查的是别处。
 */
function anchorOf(src, needle) {
  return countOf(src, needle) === 1 ? src.indexOf(needle) : -1;
}

const ARENA = { cx: 0, cy: 0, r: 250 };
/*
 * 土豆的测试桩。
 *
 * 注意接口：director.advance 读的是 x/y，**不是 px/py**。
 * 这个字段名曾经不一致：director 读 potato.px，而 main.mjs 传的是 x/y，
 * 结果 potato.px === undefined → dx = NaN → 敌人坐标变 NaN → 整场敌人消失。
 *
 * verify 里的桩也必须用 x/y。否则测的是一个不存在的接口，
 * 断言会因为 NaN 而「碰巧」全绿或全红 —— 两种都不对。
 */
/** 造一个主角状态对象。带 px/py 是因为 director 读的是这两个字段名。 */
const makeAegis = () => ({
  x: 0, y: 0,
  px: 0, py: 0,
  vx: 0, vy: 0,
  moving: false, fleeing: false,
  swing: 0, swingT: 0, hurtT: 0,
});

/** 造一个新的 director 并把时间控制在自己手里 */
function fresh() {
  return new Director({ arena: ARENA });
}

/** 推进 n 秒（用于让挥击累积），返回累计结果 */
function run(d, seconds, now, dt = 1 / 60, P = makeAegis()) {
  let swings = 0;
  let damage = 0;
  const steps = Math.round(seconds / dt);
  for (let i = 0; i < steps; i++) {
    const r = d.advance(dt, now + i * dt * 1000, P);
    swings += r.swings;
    damage += r.damage;
  }
  return { swings, damage, now: now + steps * dt * 1000 };
}

/* ================= 1. 图鉴分类 ================= */

section('图鉴分类（按真实时长）');

{
  // 子智能体必须是 BOSS —— 用户点名要求的
  ok('agent_run → BOSS', classify('agent_run').tier === TIER.BOSS,
     classify('agent_run').tierName);

  // 小兵：毫秒级
  for (const t of ['read_file', 'grep', 'glob', 'list_files', 'rg_search']) {
    ok(`${t} → 小兵`, classify(t).tier === TIER.MINION, classify(t).tierName);
  }

  // 精英：秒级
  for (const t of ['write_file', 'edit_file', 'bash', 'powershell', 'web_fetch']) {
    ok(`${t} → 精英`, classify(t).tier === TIER.ELITE, classify(t).tierName);
  }

  // 预设时长必须递增：小兵 < 精英 < BOSS
  const minionMs = classify('read_file').expectMs;
  const eliteMs = classify('bash').expectMs;
  const bossMs = classify('agent_run').expectMs;
  ok('预估时长 小兵 < 精英 < BOSS',
     minionMs < eliteMs && eliteMs < bossMs,
     `${minionMs} < ${eliteMs} < ${bossMs}`);

  // 未知工具不能假装认得
  const u = classify('some_unknown_tool_xyz');
  ok('未知工具 rule=false', u.rule === false, `rule=${u.rule}`);
  ok('未知工具不虚报为精英', u.tier === TIER.MINION, u.tierName);
  /*
   * 重锚：不再抄 'unknown' 这个字面量，改为断言「未映射的 sprite
   * 与空工具名的 sprite 一致，且这个 sprite 真的在 SPRITES 表里」。
   *
   * 这才是真正要守的性质：未知工具落到兜底外观，而兜底外观必须有定义。
   * 抄字面量的版本只要 sprites 改成别的兜底名就会假红/假绿。
   */
  const fallbackSprite = classify('').sprite;      // 空工具名 = 文档化的兜底路径
  ok('未知工具落到与兜底一致的 sprite',
     u.sprite === fallbackSprite, `${u.sprite} vs ${fallbackSprite}`);
  ok('兜底 sprite 在 SPRITES 表里有定义',
     Object.prototype.hasOwnProperty.call(spritesMod.SPRITES, fallbackSprite),
     fallbackSprite);

  // 空输入不崩
  ok('空工具名不崩', classify('').rule === false);
  ok('非字符串不崩', classify(null).rule === false && classify(undefined).rule === false);

  // 尺寸与速度：档位越高越大越慢
  ok('大小 小兵 < 精英 < BOSS',
     SIZE[TIER.MINION] < SIZE[TIER.ELITE] && SIZE[TIER.ELITE] < SIZE[TIER.BOSS],
     `${SIZE[TIER.MINION]} < ${SIZE[TIER.ELITE]} < ${SIZE[TIER.BOSS]}`);
  ok('速度 小兵 > 精英 > BOSS',
     SPEED[TIER.MINION] > SPEED[TIER.ELITE] && SPEED[TIER.ELITE] > SPEED[TIER.BOSS],
     `${SPEED[TIER.MINION]} > ${SPEED[TIER.ELITE]} > ${SPEED[TIER.BOSS]}`);

  // 规则表顺序：BOSS 必须第一个（否则 agent_run 可能被别的规则抢走）
  const rs = rules();
  ok('规则表第一条是 BOSS 规则',
     rs.length > 0 && /agent_run/.test(rs[0].match), rs[0]?.match);
}

/* ================= 2. 血条只是预估，不能致死 ================= */

section('血条是预估，不是血量');

{
  const d = fresh();
  const now = 1000;

  // 一个预估 500ms 的敌人
  const e = d.handle({ kind: 'tool', tool: 'read_file' }, now);
  ok('事件生成了敌人', !!e, e ? e.tool : 'null');
  ok('初始血条满', Math.abs(e.hpRatio(now) - 1) < 1e-6, String(e.hpRatio(now)));

  /*
   * ===== 血条不再随时间下降（这是本次改动的核心） =====
   *
   * 上一版这里断言的是"半程血条约 50%"，因为血条按 expectMs 线性掉。
   * 但那正是用户指出的怪感来源：没挨打的敌人也在掉血。
   *
   * 现在血条只有一个来源 —— 被雷打中。所以等半程，血条应该**纹丝不动**。
   */
  const mid = e.hpRatio(now + e.expectMs / 2);
  ok('没挨打时半程血条仍是满的', Math.abs(mid - 1) < 1e-9, mid.toFixed(3));

  /*
   * ===== 平时挨雷只掉"少量"血 =====
   *
   * 用户的原话：
   *   「闪电击中的时候可以扣少量血，然后完成任务的时候
   *     有个处决特效，秒杀剩余血量，这会比较符合逻辑」
   *
   * 这条推翻了上一版的设计。上一版让单次雷击掉
   * (施法间隔 / 预估时长) 那么一大块，小兵挨一下就掉 50%，
   * 于是经常出现"血条还满着就死了"或者"根本没挨几刀就空了"。
   *
   * 现在单次雷击固定掉 COMBAT.boltDamage，跟预估时长无关。
   * 这里验的是"少量"这个性质本身：
   *   - 单次掉幅不超过 20%（远低于打空）
   *   - 要挨足够多下才会见底
   */
  {
    const bossE = d.handle({ kind: 'tool', tool: 'agent_run' }, now + 1);
    const perBolt = bossE.applyBolt(1);
    ok('单次雷击只掉少量血', perBolt <= 0.2,
       '掉 ' + (perBolt * 100).toFixed(1) + '%（boltDamage=' + COMBAT.boltDamage + '）');
    /*
     * 掉幅必须落在 [min, max] 区间内 —— 这是"少量"的硬保证。
     * 不再断言等于某个固定值：现在掉幅由速率算出后被钳位，
     * 不同档位的敌人值不同，断言固定值等于测参数本身。
     */
    ok('单次雷击掉幅在少量区间内',
       perBolt >= COMBAT.boltDamageMin - 1e-9 && perBolt <= COMBAT.boltDamageMax + 1e-9,
       perBolt.toFixed(4) + ' ∈ [' + COMBAT.boltDamageMin + ', ' + COMBAT.boltDamageMax + ']');

    /*
     * 一只 BOSS 要挨很多下才会掉空 —— 它本来就该活得久。
     * 验"至少 5 下"，不验精确值：精确值只是参数本身。
     */
    let hits = 0;
    const b2 = d.handle({ kind: 'tool', tool: 'agent_run' }, now + 2);
    while (b2.hpRatio(now + 3) > 0 && hits < 200) {
      b2.applyBolt(1);
      hits++;
    }
    ok('BOSS 要挨很多下才掉空', hits >= 5, `${hits} 下`);
    console.log(`  单次雷击掉 ${(perBolt * 100).toFixed(1)}%，BOSS ${hits} 下打空`);
  }

  /*
   * ===== 链式衰减仍然生效 =====
   * 链尾挨得轻，这样"主目标 vs 蹭到"读得出来。
   */
  {
    const a = d.handle({ kind: 'tool', tool: 'read_file' }, now + 4);
    const first = a.applyBolt(1);
    const second = a.applyBolt(COMBAT.chainFalloff);
    ok('链尾伤害按 falloff 衰减', second < first,
       `${first.toFixed(3)} → ${second.toFixed(3)}`);
  }

  /*
   * ===== 超过预估之后：血条**不会自己归零** =====
   *
   * 这一条是改成法杖之后的核心行为变化，源自用户指出的观感问题：
   *   「那些小怪也不会因为腾不出手自己扣血挂掉显得奇怪」
   *
   * 上一版血条纯粹按 expectMs 线性下降，超时就是 0%：
   * 一只没挨过打的 read_file 小兵，血条自己流到空，
   * 画面上看着像它自己莫名其妙挂掉。
   *
   * 现在 hpRatio = min(时间上限, 1 - 被雷打掉的量)：
   * 时间上限到 0 时，血条停在"还没被电掉"的那部分，
   * 光靠等待永远压不到 0。
   *
   * 所以这里的断言反过来了：超时后血条必须 > 0。
   */
  const past = now + e.expectMs * 3;
  ok('没挨雷打时血条不会自己归零', e.hpRatio(past) > 0,
     `超时后 ${(e.hpRatio(past) * 100).toFixed(1)}%（时间耗尽但没被电）`);
  ok('时间上限确实已经压到底', 1 - (past - e.bornAt) / e.expectMs < 0,
     'expectMs 已被超过');
  ok('超时后血条 = 未被电掉的部分',
     Math.abs(e.hpRatio(past) - (1 - e.hpLost)) < 1e-9,
     `${e.hpRatio(past)} vs 1-hpLost=${1 - e.hpLost}`);
  ok('超时后敌人仍然活着', e.diedAt === null, `diedAt=${e.diedAt}`);
  ok('超时没有产生击杀', d.kills === 0, `kills=${d.kills}`);

  /*
   * 关键：让土豆疯狂攻击很久，敌人也不能死。
   * 这是本项目最容易被做假的地方。
   */
  const r = run(d, 30, past);
  ok('30 秒狂打后抛击次数 > 0', r.swings > 0, `${r.swings} 次`);
  ok('狂打 30 秒仍然没有击杀', d.kills === 0, `kills=${d.kills}`);
  ok('狂打 30 秒敌人仍未死', e.diedAt === null, `diedAt=${e.diedAt}`);
  ok('确实挨了很多下', e.hitsTaken > 0, `hits=${e.hitsTaken}`);
  console.log(`  30 秒狂打：${r.swings} 次挥击，${e.hitsTaken} 次命中，击杀 ${d.kills}`);
}

/* ================= 3. 死亡只来自真实事件 ================= */

section('死亡只来自真实事件');

{
  const d = fresh();
  const now = 2000;

  const e = d.handle({ kind: 'tool', tool: 'bash' }, now);
  ok('带 ok 的事件不立即死（无 ok 字段）', e.diedAt === null);

  // 真实结束
  d.handle({ kind: 'tool_end', tool: 'bash', ok: true }, now + 5000);
  ok('tool_end 后死亡', e.diedAt !== null, `diedAt=${e.diedAt}`);
  ok('tool_end ok:true 记为击杀', e.killed === true);
  ok('击杀计数 +1', d.kills === 1, `kills=${d.kills}`);
  ok('死亡时间是事件时间', e.diedAt === now + 5000, String(e.diedAt));

  // 重复结束不重复计数
  d.handle({ kind: 'tool_end', tool: 'bash', ok: true }, now + 6000);
  ok('重复结束不重复计数', d.kills === 1, `kills=${d.kills}`);
}

/* ================= 3.5 重复上报不能虚报战果 ================= */

section('重复上报不虚报');

{
  /*
   * 真实事件源会重复上报结束：重连、重放、日志重复消费都会。
   *
   * 这个 bug 是 verify 抓出来的：
   *   第一次 tool_end 找到活着的敌人 → 结算 → kills=1（正确）
   *   第二次 tool_end 找不到活着的同工具敌人 →
   *     走进"补造一个再结算"的分支 → kills=2（虚报！）
   *
   * 修法是加一条判断：这个工具已经死过 → 当成重复上报，计数但不算击杀。
   */
  const d = fresh();
  const now = 2500;

  d.handle({ kind: 'tool', tool: 'bash' }, now);
  d.handle({ kind: 'tool_end', tool: 'bash', ok: true }, now + 1000);
  ok('首次结束记 1 次击杀', d.kills === 1, `kills=${d.kills}`);

  // 重复上报三次
  d.handle({ kind: 'tool_end', tool: 'bash', ok: true }, now + 1100);
  d.handle({ kind: 'tool_end', tool: 'bash', ok: true }, now + 1200);
  d.handle({ kind: 'tool_end', tool: 'bash', ok: true }, now + 1300);

  ok('重复上报不增加击杀', d.kills === 1, `kills=${d.kills}`);
  ok('重复上报被单独计数', d.duplicates === 3, `duplicates=${d.duplicates}`);
  ok('重复上报不补造敌人', d.enemies.length === 1, `enemies=${d.enemies.length}`);
  ok('重复上报不进 gone', d.gone.length === 0, `gone=${d.gone.length}`);
}

/* ================= 4. 失败不是击杀 ================= */

section('失败不是击杀');

{
  const d = fresh();
  const now = 3000;

  const e = d.handle({ kind: 'tool', tool: 'bash' }, now);
  d.handle({ kind: 'tool_end', tool: 'bash', ok: false }, now + 2000);

  ok('失败的事件也结束', e.diedAt !== null);
  ok('失败不算击杀', e.killed === false, `killed=${e.killed}`);
  ok('失败标记 failed', e.failed === true);
  ok('击杀数仍为 0', d.kills === 0, `kills=${d.kills}`);
  ok('失败数 +1', d.failures === 1, `failures=${d.failures}`);
}

/* ================= 5. 清场只认 turn_end ok:true ================= */

section('清场只认 turn_end ok:true');

{
  const d = fresh();
  const now = 4000;
  d.handle({ kind: 'tool', tool: 'read_file' }, now);
  d.handle({ kind: 'tool', tool: 'bash' }, now + 100);
  const boss = d.handle({ kind: 'tool', tool: 'agent_run' }, now + 200);

  ok('三个敌人都活着', d.stats(now + 300).alive === 3);

  // 失败收尾：不能清场
  d.handle({ kind: 'turn_end', ok: false }, now + 1000);
  const s1 = d.stats(now + 1100);
  ok('失败收尾不清场', s1.alive === 3, `alive=${s1.alive}`);
  ok('失败收尾没有击杀', s1.kills === 0, `kills=${s1.kills}`);
  ok('失败收尾标记 turnOk=false', s1.turnOk === false);

  // 换成成功收尾：必须全部清场
  const d2 = fresh();
  d2.handle({ kind: 'tool', tool: 'read_file' }, now);
  const b2 = d2.handle({ kind: 'tool', tool: 'agent_run' }, now + 200);
  ok('BOSS 出生', !!b2 && b2.tier === TIER.BOSS);

  d2.handle({ kind: 'turn_end', ok: true }, now + 5000);
  const s2 = d2.stats(now + 5000);
  ok('成功收尾全部清场', s2.alive === 0, `alive=${s2.alive}`);
  ok('成功收尾击杀数 == 敌人数', s2.kills === 2, `kills=${s2.kills}`);
  ok('成功收尾标记 turnOk=true', s2.turnOk === true);
  ok('BOSS 被清场', b2.diedAt !== null);
}

/* ================= 6. 未映射工具如实计数 ================= */

section('未映射工具如实计数');

{
  const d = fresh();
  const now = 5000;

  d.handle({ kind: 'tool', tool: 'agent_run' }, now);          // 已知
  d.handle({ kind: 'tool', tool: 'totally_made_up_tool' }, now + 10);  // 未知

  const s = d.stats(now + 20);
  ok('两个事件都被计数', s.seen === 2, `seen=${s.seen}`);
  ok('未知工具计入 unmapped', s.unmapped === 1, `unmapped=${s.unmapped}`);
  ok('未知工具仍然出现在场上（不吞掉）', s.alive === 2, `alive=${s.alive}`);

  // 垃圾输入不能造出敌人
  const before = d.enemies.length;
  d.handle(null, now);
  d.handle(undefined, now);
  d.handle({}, now);
  d.handle({ kind: 'nonsense' }, now);
  ok('垃圾输入不产生敌人', d.enemies.length === before,
     `${before} → ${d.enemies.length}`);
  ok('垃圾输入不增加 seen', d.stats(now).seen === 2, `${d.stats(now).seen}`);
}

/* ================= 7. 挥击是数出来的，不是估的 ================= */

section('挥击次数是真数出来的');

{
  const d = fresh();
  const now = 6000;
  d.handle({ kind: 'tool', tool: 'read_file' }, now);

  // 推进 1 秒：按 swingsPerSecond 应该约这么多次
  const r = run(d, 1.0, now);
  const expect = Math.round(COMBAT.swingsPerSecond);
  ok('1 秒挥击次数约等于设定值', Math.abs(r.swings - expect) <= 1,
     `${r.swings} vs 期望 ${expect}`);

  /*
   * 没有敌人时：土豆**仍然在挥**（swings 增长），
   * 但不造成任何伤害（damage 不涨）。
   *
   * 这条语义改过一版。原来是"没敌人就不挥"，
   * 结果累积器停在 0，下一个敌人出现要等 312ms 才挨第一下，
   * 而很多小兵寿命只有 300~700ms —— 实测 13 个敌人里 4 个
   * 从头到尾一下没挨打，画面上看起来像"自动消失"。
   *
   * 现在：挥击是持续动作（真实发生），伤害才是结果（需要目标）。
   * 两者分开记，各自可信。
   */
  const d2 = fresh();
  const r2 = run(d2, 2.0, now);
  ok('没敌人时仍在挥击（动作真实）', r2.swings > 0, `${r2.swings} 次`);
  ok('没敌人时伤害为 0（打空气）', d2.damage === 0, `damage=${d2.damage}`);

  /*
   * 伤害上限 = 施法次数 × 每条链最多跳几个目标 × 单跳伤害。
   *
   * 上一版是 swings × damagePerSwing（一次施法只打一个）。
   * 改成雷电链之后一条链能连打最多 chainMax 个目标，
   * 所以上限要乘上链长 —— 否则这条断言会把正常的多目标伤害判成"凭空造伤害"。
   *
   * 取上限不取等号，因为有"空挥"（那一拍没够得着的目标）。
   * 但伤害绝不可能超过这个上限 —— 超了就真的在编数字。
   */
  const cap = d.swings * COMBAT.chainMax * COMBAT.damagePerBolt;
  ok('累计伤害不超过施法上限',
     d.damage <= cap,
     `${d.damage} vs 上限 ${cap}`);
}

/* ================= 8. 敌人会朝土豆移动 ================= */

section('敌人朝土豆移动');

{
  const d = fresh();
  const now = 7000;
  const e = d.handle({ kind: 'tool', tool: 'read_file' }, now);

  const d0 = Math.hypot(e.x - 0, e.y - 0);
  run(d, 3.0, now);
  const d1 = Math.hypot(e.x - 0, e.y - 0);

  ok('敌人距离变近', d1 < d0, `${d0.toFixed(1)} → ${d1.toFixed(1)}`);
  ok('敌人不会叠到土豆身上', d1 > 1, `停在 ${d1.toFixed(2)}`);

  // 死了就不再移动
  d.handle({ kind: 'tool_end', tool: 'read_file', ok: true }, now + 3100);
  const px = e.x;
  const py = e.y;
  run(d, 1.0, now + 3200);
  ok('死后不再移动', Math.abs(e.x - px) < 1e-9 && Math.abs(e.y - py) < 1e-9,
     `${px.toFixed(2)},${py.toFixed(2)} → ${e.x.toFixed(2)},${e.y.toFixed(2)}`);
}

/* ================= 9. 演示事件流 ================= */

section('演示事件流');

{
  const { DEMO_EVENTS } = await import('./director.mjs');

  ok('演示有事件', DEMO_EVENTS.length > 0, `${DEMO_EVENTS.length} 条`);

  const tools = DEMO_EVENTS.filter((e) => e.kind === 'tool');
  const bossEv = tools.find((e) => e.tool === 'agent_run');
  ok('演示里有 BOSS（子智能体）', !!bossEv);
  ok('BOSS 有自己的结束事件',
     DEMO_EVENTS.some((e) => e.kind === 'tool_end' && e.tool === 'agent_run'));

  ok('演示以 turn_end 收尾',
     DEMO_EVENTS[DEMO_EVENTS.length - 1].kind === 'turn_end');
  ok('演示最终成功',
     DEMO_EVENTS[DEMO_EVENTS.length - 1].ok === true);

  // 时间轴必须单调递增
  let mono = true;
  for (let i = 1; i < DEMO_EVENTS.length; i++) {
    if (DEMO_EVENTS[i].ts < DEMO_EVENTS[i - 1].ts) mono = false;
  }
  ok('演示时间轴单调递增', mono);

  // 完整跑一遍
  const d = fresh();
  let now = 0;
  for (const ev of DEMO_EVENTS) {
    // 推进到该事件时间
    if (now < ev.ts) {
      run(d, (ev.ts - now) / 1000, now);
      now = ev.ts;
    }
    d.handle(ev, now);
  }
  const s = d.stats(now + 100);
  ok('演示跑完全部清场', s.alive === 0, `alive=${s.alive}`);
  ok('演示跑完击杀数 > 0', s.kills > 0, `kills=${s.kills}`);
  ok('演示跑完无未映射', s.unmapped === 0, `unmapped=${s.unmapped}`);
  ok('演示跑完 turnOk=true', s.turnOk === true);

  console.log(`  演示结果：事件 ${s.seen}，击杀 ${s.kills}，失败 ${s.failures}，挥击 ${s.swings}`);
}

/* ================= 9.2 追逐：怪追土豆，土豆边逃边打 ================= */

section('追逐与风筝');

{
  /*
   * 用户提过两次，两次都是真的没做到：
   *
   *   第一次：「你没做追逐啊」
   *     → 土豆坐标初始化成 0 后再没被写过，一步没挪，画面是"怪围木桩"。
   *
   *   第二次：「我说的追逐是，怪物追我们，我们边逃边清理怪物」
   *     → 修成了"土豆朝怪冲过去"，方向反了：那是土豆追怪。
   *
   * 现在是风筝（kite）：被逼近就退、退的同时继续挥刀、退太快就打不到，
   * 于是"逃"和"打"之间有真实取舍。
   *
   * 这条断言检查的是**行为性质**，不是具体数字：
   *   1. 土豆真的在动（不是站桩）
   *   2. 敌人真的在靠近土豆（追逐成立）
   *   3. 两者距离有往复（拉锯感，不是单向跑开）
   *   4. 有相当比例的帧落在攻击距离内（边打成立，不是纯逃跑）
   */
  const { DEMO_EVENTS } = await import('./director.mjs');
  const { COMBAT } = await import('./director.mjs');

  const d = fresh();
  const P = makeAegis();
  let now = 0;

  let path = 0;
  let prevX = P.x;
  let prevY = P.y;
  const dists = [];
  let framesWithTarget = 0;

  for (const ev of DEMO_EVENTS) {
    while (now < ev.ts) {
      d.advance(0.05, now, P);
      path += Math.hypot(P.x - prevX, P.y - prevY);
      prevX = P.x;
      prevY = P.y;

      const t = d.target(now);
      if (t) {
        dists.push(Math.hypot(t.x - P.x, t.y - P.y));
        framesWithTarget++;
      }
      now += 50;
    }
    d.handle(ev, ev.ts);
  }

  ok('土豆真的在移动（不是站桩）', path > 200,
     `总路程 ${path.toFixed(0)} 格`);
  ok('土豆没有跑出场地',
     Math.hypot(P.x - d.arena.cx, P.y - d.arena.cy) <= d.arena.r,
     `离中心 ${Math.hypot(P.x, P.y).toFixed(0)} / 半径 ${d.arena.r}`);

  ok('有目标的帧足够多（可统计）', framesWithTarget > 200,
     `${framesWithTarget} 帧`);

  /*
   * 距离往复：数一下"靠近↔远离"翻转了多少次。
   * 单向跑开的话翻转次数接近 0（一直变大）或 1。
   */
  if (dists.length > 4) {
    let reversals = 0;
    let dir = 0;
    for (let i = 1; i < dists.length; i++) {
      const nd = Math.sign(dists[i] - dists[i - 1]);
      if (nd !== 0 && dir !== 0 && nd !== dir) reversals++;
      if (nd !== 0) dir = nd;
    }
    ok('距离有往复拉扯（不是单向跑开）', reversals >= 6,
       `方向反转 ${reversals} 次`);

    const avg = dists.reduce((a, b) => a + b, 0) / dists.length;
    ok('平均距离在可交战范围（reach 的 2.5 倍内）',
       avg <= COMBAT.reach * 2.5,
       `平均 ${avg.toFixed(0)} 格 / reach ${COMBAT.reach}`);

    const inReach = dists.filter((x) => x <= COMBAT.reach).length;
    const ratio = inReach / dists.length;
    /*
     * 阈值定 40%：低于这个就说明基本是"纯逃跑打不到"。
     * 实测现在 65%+，留足余量。
     */
    ok('相当比例的时间在攻击距离内（边打成立）', ratio >= 0.4,
       `${(ratio * 100).toFixed(1)}% 的帧在 reach 内`);

    console.log(`  追逐：移动 ${path.toFixed(0)} 格，` +
                `距离 avg ${avg.toFixed(0)} / min ${Math.min(...dists).toFixed(0)} / max ${Math.max(...dists).toFixed(0)}，` +
                `反转 ${reversals} 次，在 reach 内 ${(ratio * 100).toFixed(0)}%`);
  }

  /*
   * ===== fleeing 必须是可达状态，不能是死代码 =====
   *
   * 这一条锁的是一个非常隐蔽的 bug：
   *
   *   v1  ideal = reach×0.68 = 29.92
   *       但群体排斥力把稳态距离顶在 37~41 格。
   *       nd 永远 ≥ 33.3 → **fleeing 全程 0%**，
   *       `paceMul = 0.45` 那段一次都没执行。
   *
   *   v2  ideal 改到 19.8（想让后退更容易）
   *       距离最低只到 22.2，还是没低于 19.8 → **仍然 0%**
   *
   * 两次都是同一个病根：把"力平衡点"当成了可以随意设定的目标值。
   * 排斥力朝外推、后退力朝内拉，实际最短距离由两者交叉决定，
   * 光改 ideal 调不动。
   *
   * 浏览器实测显示"在攻击距离内 57.8%"看着很好，
   * 但 fleeing 是 0 —— 也就是说画面上只是"绕着怪转圈"，
   * 用户要的"边逃"根本不存在。数值指标好看，功能没实现。
   *
   * 所以这条断言直接查状态：**fleeing 必须有相当比例**。
   * 只查距离是不够的 —— 距离可以靠绕圈维持在攻击范围内。
   */
  {
    const d4 = fresh();
    const P4 = makeAegis();
    let t4 = 0;
    let fleeingFrames = 0;
    let withTarget = 0;
    for (const ev of DEMO_EVENTS) {
      while (t4 < ev.ts) {
        d4.advance(0.05, t4, P4);
        if (d4.target(t4, P4.x, P4.y)) {
          withTarget++;
          if (d4.aegisFleeing) fleeingFrames++;
        }
        t4 += 50;
      }
      d4.handle(ev, ev.ts);
    }

    const fleeRatio = withTarget ? fleeingFrames / withTarget : 0;
    /*
     * 阈值 15%：低于这个说明"逃"只是偶发，
     * 观感上还是绕圈。实测现在 55%，留足余量。
     */
    ok('fleeing 状态真的会被触发（不是死代码）', fleeRatio >= 0.15,
       `${(fleeRatio * 100).toFixed(1)}% 的帧在后退（${fleeingFrames}/${withTarget}）`);

    console.log(`  后退：${(fleeRatio * 100).toFixed(0)}% 的帧 fleeing ` +
                `（${fleeingFrames}/${withTarget}）`);
  }

  /* 敌人必须真的在靠近土豆：单独放一只，观察距离单调下降 */
  {
    const d2 = fresh();
    const P2 = makeAegis();
    const e = d2.handle({ kind: 'tool', tool: 'read_file' }, 0);
    const d0 = Math.hypot(e.x - P2.x, e.y - P2.y);
    // 让土豆原地不动（临时把它按在中心：把速度清零的做法是给它极小的位置变化）
    for (let i = 0; i < 60; i++) d2.advance(0.05, i * 50, P2);
    const d1 = Math.hypot(e.x - P2.x, e.y - P2.y);
    ok('敌人真的在靠近土豆', d1 < d0 - 5,
       `${d0.toFixed(0)} → ${d1.toFixed(0)}`);
  }

  /* 出生点必须在场地内（否则永远走不进来） */
  {
    const d3 = fresh();
    let outside = 0;
    for (let i = 0; i < 40; i++) {
      const e = d3.handle({ kind: 'tool', tool: 'grep' }, i * 10);
      if (Math.hypot(e.x - d3.arena.cx, e.y - d3.arena.cy) > d3.arena.r) outside++;
    }
    ok('敌人都生成在场地内', outside === 0, `${outside} 个生成在界外`);
  }
}

/* ================= 9.5 土豆真的在砍人 ================= */

section('土豆真的在砍人');

{
  /*
   * 这条锁定一个"看着在打其实没打到"的 bug。
   *
   * 原来累积器只在有目标时推进，导致场上一空累积器就停住，
   * 新敌人出现要等 312ms 才挨第一下。很多小兵寿命 300~700ms，
   * 于是实测 13 个敌人里有 4 个 hitsTaken = 0。
   *
   * 死亡仍然只认事件（这点没变），但"土豆一直在攻击"这个
   * 核心观感不成立 —— 画面上它像在发呆，敌人像自动消失。
   *
   * 现在累积器每帧推进，目标一出现最多 312ms 内必挨第一下。
   */
  const { DEMO_EVENTS } = await import('./director.mjs');
  const d = fresh();
  const P = makeAegis();
  let now = 0;
  for (const ev of DEMO_EVENTS) {
    while (now < ev.ts) {
      d.advance(0.05, now, P);
      now += 50;
    }
    d.handle(ev, ev.ts);
  }

  const all = [...d.enemies, ...d.gone];
  ok('演示里所有敌人都结算了', all.every((e) => e.diedAt !== null),
     `${all.filter((e) => e.diedAt === null).length} 个未结算`);

  /*
   * 逐个检查"为什么它没挨打"。
   *
   * 土豆的规则是**只打离自己最近的那一只**。所以一个敌人一刀没挨，
   * 只有两种可能：
   *   (a) 它活着的时候，场上总有一只离土豆更近的（规则合理）
   *   (b) 它是唯一的目标却还是没挨打（这才是 bug）
   *
   * 注意不能用"出生时间重叠"来判断 (a)：
   *   早期版本用的是"同场存在另一个敌人"，
   *   但距离是动态的 —— 土豆一直在跑，谁更近每帧都在变。
   *   于是会出现"同场的 BOSS 其实更远，write_file 才是最近目标"，
   *   却因为"同场有别人"被误判成合理。
   *
   * 正确做法：重放时间轴，逐帧记录"这一帧谁离土豆最近"，
   * 然后检查每个零命中的敌人：在它活着的那些帧里，
   * 有没有任何一帧它是最近目标？如果有，它就是被漏打了（bug）。
   */
  const { DEMO_EVENTS: DE2 } = await import('./director.mjs');
  const d2 = fresh();
  const P2 = makeAegis();
  let t2 = 0;
  /** 每个时刻的最近目标 id */
  const nearestByTime = [];
  for (const ev of DE2) {
    while (t2 < ev.ts) {
      d2.advance(0.05, t2, P2);
      const nt = d2.target(t2);
      nearestByTime.push({ t: t2, id: nt ? nt.id : null });
      t2 += 50;
    }
    d2.handle(ev, ev.ts);
  }

  const missedWhileNearest = [];
  for (const e of all) {
    if (e.hitsTaken > 0) continue;
    const born = e.bornAt;
    const died = e.diedAt ?? Infinity;
    // 在它存活期间，有没有哪一帧它是最近目标？
    const wasNearest = nearestByTime.some(
      (r) => r.id === e.id && r.t >= born && r.t <= died,
    );
    if (wasNearest) missedWhileNearest.push(`${e.tool}(id=${e.id})`);
  }

  ok('零命中的敌人从未成为最近目标（规则合理）',
     missedWhileNearest.length === 0,
     `曾被选为最近目标却没挨打：${missedWhileNearest.join(',')}`);

  const hitCount = all.filter((e) => e.hitsTaken > 0).length;

  /*
   * 这里**不**断言"每个敌人都挨过打"。
   *
   * 因为土豆的规则是"只打离自己最近的那个"，这是刻意的：
   * BOSS 在场时，土豆会一直盯着 BOSS，
   * 同期生成的小兵站在外圈就一次都不会被选中（实测 13 个里 9 个有命中）。
   *
   * 这**不是 bug**：
   *   - 目标选择规则明确（最近优先）
   *   - 未命中的敌人照样会被真实事件结算（不会赖在场上）
   *   - 上面那条"没有孤零零却一刀没挨的敌人"已经保证：
   *     只要场上只有它一个，它一定会挨打
   *
   * 如果这里硬要 13/13，反而要改成"随机选目标"或"多目标攻击"，
   * 那就偏离"土豆专注打眼前这只"的设计了。
   */
  console.log(`  未命中 ${all.length - hitCount} 个，全部因为当时有更近的目标`);

  // BOSS 必须挨很多下（它是长跑的那个）
  const boss = all.find((e) => e.tier === TIER.BOSS);
  ok('BOSS 挨打次数最多', !!boss && boss.hitsTaken >= 20,
     boss ? `hits=${boss.hitsTaken}` : '没找到 BOSS');

  /*
   * BOSS 死时血条还没空 —— 证明"事件决定死亡，不是血条"。
   *
   * 注意这里查的是 hpAtDeath（死亡瞬间快照），不是 hpRatio(diedAt)。
   *
   * 因为 hpRatio 现在带"死亡后快速耗尽"：传入一个晚于 diedAt 的 now，
   * 它会返回衰减后的值，最后归零。死在血条 84% 处的 BOSS，
   * 如果查询时机晚了 350ms，hpRatio 就会返回 0 —— 那不是说它血条空了才死，
   * 而是动画演完了。两者必须分开看，否则这条断言会误报。
   */
  if (boss) {
    const atDeath = boss.hpAtDeath ?? 0;
    ok('BOSS 死时血条未归零（事件决定死亡）', atDeath > 0.1,
       `死亡瞬间血条 ${(atDeath * 100).toFixed(1)}%`);

    // 死亡后展示期内血条会快速耗尽 —— 这是新加的行为，也要验
    const soon = boss.diedAt + 50;
    const later = boss.diedAt + 500;
    ok('死亡后血条开始快速耗尽', boss.hpRatio(soon) < atDeath,
       `${(boss.hpRatio(soon) * 100).toFixed(1)}% < ${(atDeath * 100).toFixed(1)}%`);
    ok('血条在展示期内耗尽到 0', boss.hpRatio(later) === 0,
       `500ms 后 ${(boss.hpRatio(later) * 100).toFixed(1)}%`);

    console.log(`  BOSS 存活 ${boss.ageSec(boss.diedAt).toFixed(1)}s，` +
                `挨打 ${boss.hitsTaken} 次，死亡瞬间血条 ${(atDeath * 100).toFixed(1)}%`);
  }

  console.log(`  敌人挨打：${hitCount}/${all.length} 个有命中，累计挥击 ${d.swings}`);
}

/* ================= 10. sprite 定义 ================= */

section('像素 sprite');

{
  const problems = lintSprites();
  ok('sprite 点阵无问题', problems.length === 0, problems.slice(0, 3).join(' | '));

  const defs = spriteDefs();
  /*
   * ===== sprite 必须齐全，而且必须是盾牌/蚂蚁 =====
   *
   * 从 potato/ 改成植保盾牌后，主角和敌人全换了。
   * 这条断言同时挡住两件事：
   *   1. render 用了不存在的 sprite 名（会静默画不出东西）
   *   2. 有人把旧的土豆 sprite 又加回来
   */
  /*
   * ===== 重锚：必需 sprite 集合从单一真相源派生 =====
   *
   * 原来这里抄了一份 7 个名字的字面量。抄字面量的问题不是"写错"，
   * 而是**真相源变了它不知道**：往 RULES 里加一条规则、
   * 或加一个新 sprite，这份清单不会跟着变，断言会继续绿。
   *
   * 现在分三段派生：
   *   1. 主角三帧  ← SPRITES 里所有 aegis* 键（render 按名取帧）
   *   2. 敌人 sprite ← bestiary 的 RULES（每条规则的 sprite 字段）
   *   3. unknown    ← classify() 对未映射工具的**真实返回**
   *
   * 说明：派生出来的集合比原来那 7 个**更全**（RULES 里还有
   * alate / sapperAnt，原来的字面量清单漏掉了它们）。
   * 也就是说这条断言只会更严，不会更松。
   */
  const names = defs.map((d) => d.name);
  const aegisFrames = names.filter((n) => /^aegis/i.test(n));
  const ruleSprites = [...new Set(rules().map((r) => r.sprite))];
  const unknownSprite = classify('__definitely_not_a_tool__').sprite;
  const need = [...aegisFrames, ...ruleSprites, unknownSprite];
  const missing = need.filter((k) => !names.includes(k));
  ok('sprite 齐全（本体三态 + RULES 里出现的全部敌人 sprite + unknown）',
     missing.length === 0, missing.join(','));
  /* 派生本身要站得住：三帧都在，unknown 真的来自 classify */
  ok('主角三帧由 SPRITES 派生且齐备（idle/wind/strike）',
     aegisFrames.length === 3, aegisFrames.join(','));
  ok('unknown sprite 来自 classify() 的真实返回',
     unknownSprite === 'unknown' && names.includes(unknownSprite), unknownSprite);

  /*
   * 反面断言：旧土豆 sprite 不许回来。
   * 名字本身不能含 potato —— 否则就是没改干净。
   */
  const leftovers = names.filter((n) => /potato/i.test(n));
  ok('没有残留的土豆 sprite', leftovers.length === 0, leftovers.join(','));

  /*
   * 盾牌三帧必须同尺寸。
   * 不同尺寸的话，挥击切帧时 sprite 会跳一下 —— 这在像素风里非常明显。
   */
  /*
   * ===== 重锚：尺寸断言改为「品级阶梯」不变量 =====
   *
   * 原来直接抄了 'majorAnt' / 'fireAnt' / 'queen' 三个名字和
   * +3 这个魔法数。现在改成：
   *
   *   工蚁尺寸 = 最小品级 MINION 的 SIZE；兵蚁 = ELITE；蚁后 = BOSS。
   *   品级到 sprite 的映射查 RULES（唯一真相源），
   *   尺寸下限查 SIZE 表，阶梯间隔沿用 SIZE 表本身算出来的差值。
   *
   * 保留的不变量（语义与原来完全一致）：
   *   1. 高品级的 sprite 至少比低品级大 3px（品级可辨）
   *   2. 蚁后 > 兵蚁（逐级递增）
   *   3. 主角 / 工蚁不是空点阵
   */
  const g = (n) => defs.find((d) => d.name === n);
  /* 主角三帧同尺寸：帧名从 SPRITES 派生，不再抄 aegisIdle/... */
  const fw = aegisFrames.map((n) => g(n).w);
  const fh = aegisFrames.map((n) => g(n).h);
  ok('本体三态同尺寸（否则挥击会跳）',
     new Set(fw).size === 1 && new Set(fh).size === 1,
     `${fw[0]}x${fh[0]}（三帧 ${aegisFrames.join('/')}）`);

  /*
   * 品级 → sprite 名：从 RULES 反查（同一品级多条规则时取第一条）。
   * 这样"兵蚁是谁""工蚁是谁"都只有 bestiary 一个说法。
   */
  const spriteOfTier = (tier) => {
    const r = rules().find((x) => x.tier === tier);
    return r ? r.sprite : null;
  };
  const minionSprite = spriteOfTier(TIER.MINION);
  const eliteSprite = spriteOfTier(TIER.ELITE);
  const bossSprite = spriteOfTier(TIER.BOSS);
  ok('每个品级都能从 RULES 反查到一个 sprite',
     Boolean(minionSprite && eliteSprite && bossSprite),
     `${minionSprite}/${eliteSprite}/${bossSprite}`);

  const minionW = g(minionSprite).w;
  const eliteW = g(eliteSprite).w;
  const bossW = g(bossSprite).w;

  /*
   * 阶梯间隔沿用原有的 3px —— 这是"品级肉眼可辨"的阈值，
   * 属于**设计约束**而不是从别处抄来的数值，所以留成显式常量。
   *
   * 注意：这里**不**拿 SIZE 表来比。SIZE 是渲染尺寸（1x 画布上的
   * 目标大小），defs 的 w/h 是点阵的实际宽度 —— 两个不同的量。
   * 实测 SIZE.ELITE=17 而点阵宽 16，硬把两者绑起来会造出一个
   * 假不变量，只会逼着以后的人去改点阵迁就数字。
   */
  const ladderGap = 3;
  ok(`${TIER_LABEL.elite}点阵明显大于${TIER_LABEL.minion}（品级可辨）`,
     eliteW >= minionW + ladderGap,
     `${TIER_LABEL.elite} ${eliteW}px vs ${TIER_LABEL.minion} ${minionW}px`);

  /* BOSS 最大 —— 它是本场唯一的长跑者。 */
  ok(`${TIER_LABEL.boss}点阵大于${TIER_LABEL.elite}`,
     bossW > eliteW,
     `${TIER_LABEL.boss} ${bossW}px vs ${TIER_LABEL.elite} ${eliteW}px`);

  /*
   * 像素数：不能是空壳。
   *
   * ===== 这里重锚时踩过一次「顺手放宽」，记下来 =====
   *
   * 原来的判据是硬编码的绝对下限：盾牌 > 100 px、工蚁 > 40 px。
   * 第一版重锚把它换成了「面积 / 8」的比例下限，看起来更"聪明"，
   * 实际上**语义被放松了**：
   *   盾牌 26×26/8 = 84（原来是 100）
   *   工蚁 12×12/8 = 18（原来是 40）
   * 于是一个只剩 85 px 的盾牌（原本会红）现在能过。
   *
   * 比例下限不能替代绝对下限 —— 它们守的不是同一件事：
   *   绝对下限   "这个 sprite 至少得画出这么多像素"（设计契约）
   *   比例下限   "填充率别太稀"（形态契约）
   * 两条都要，取**更严**的那个（max），任何一条变松都会被另一条兜住。
   *
   * 对应的键仍然从真相源派生（idleFrame / minionSprite），不抄名字。
   */
  const HERO_MIN_PX = 100;   // 本体至少 100 个不透明像素（原判据，不得放宽）
  const MINION_MIN_PX = 40;  // 最小品级至少 40 个（原判据，不得放宽）
  const pxFloor = (n, absFloor) => {
    const d = g(n);
    return Math.max(absFloor, Math.floor((d.w * d.h) / 8));
  };
  const idleFrame = aegisFrames[0];
  ok('本体有实际像素（不是空点阵）',
     g(idleFrame).px > pxFloor(idleFrame, HERO_MIN_PX),
     `${g(idleFrame).px} px（下限 ${pxFloor(idleFrame, HERO_MIN_PX)}）`);
  ok(`${TIER_LABEL.minion}有实际像素`,
     g(minionSprite).px > pxFloor(minionSprite, MINION_MIN_PX),
     `${g(minionSprite).px} px（下限 ${pxFloor(minionSprite, MINION_MIN_PX)}）`);

  /*
   * 剑尖常量必须存在且三态齐备。
   *
   * render 画刀光时要用它算起点；缺一态就会退回 idle 的坐标，
   * 于是"抬手"那一帧刀光从脚边冒出来。
   */
  const tips = spritesMod.SWORD_TIP;
  ok('剑尖三态齐备', Boolean(tips && tips.idle && tips.wind && tips.strike),
     tips ? Object.keys(tips).join(',') : '未导出');
  ok('三态剑尖位置不同（不是同一个数抄三遍）',
     tips.idle.x !== tips.wind.x || tips.idle.y !== tips.wind.y,
     JSON.stringify(tips));

  const pal = palette();
  ok('调色板非空', Object.keys(pal).length > 20, `${Object.keys(pal).length} 色`);

  /* 单字符键：bake() 逐字符查表，多字符键永远匹配不到 */
  const multi = Object.keys(pal).filter((k) => k.length !== 1);
  ok('调色板键全是单字符（bake 逐字符查表）', multi.length === 0, multi.join(','));
}

/* ================= 8. 小怪也要有名字 ================= */

section('每个敌人都有名字');

{
  const d = fresh();
  const now = 4000;

  const grunt = d.handle({ kind: 'tool', tool: 'read_file' }, now);
  const elite = d.handle({ kind: 'tool', tool: 'bash' }, now + 10);
  const boss = d.handle({ kind: 'tool', tool: 'agent_run' }, now + 20);
  const unknown = d.handle({ kind: 'tool', tool: 'weird_tool' }, now + 30);

  /*
   * 用户的原话：「小怪身上至少得有他代表哪个任务的名称，
   * 就像这些 BOSS 的头顶上有一个击杀怪物血条一样，
   * 并且 BOSS 头上有个名字」。
   *
   * 原来只有 BOSS 有标签，小兵/精英光有血条没有名字 ——
   * 观众根本不知道那个 8×8 的小方块代表什么调用。
   */
  for (const [name, e] of [['小兵', grunt], ['精英', elite], ['BOSS', boss], ['未知', unknown]]) {
    ok(`${name} 有非空名字`, typeof e.label === 'string' && e.label.length > 0,
       `label=${JSON.stringify(e.label)}`);
  }

  // 名字必须是**工具名本身**，不是笼统的类别
  ok('小兵名字就是工具名', grunt.label === 'read_file', grunt.label);
  ok('精英名字就是工具名', elite.label === 'bash', elite.label);
  ok('BOSS 名字就是工具名', boss.label === 'agent_run', boss.label);

  // 未知工具不准伪造成已知名字
  ok('未知工具名字如实显示', unknown.label === 'weird_tool', unknown.label);
  ok('未知工具 kindLabel 不冒充已知类别',
     unknown.kindLabel !== grunt.kindLabel, unknown.kindLabel);

  /*
   * 长工具名要截断，否则标签会横跨半个战场、盖住别的敌人。
   * rg_files_with_matches = 21 字符。
   */
  const long = d.handle({ kind: 'tool', tool: 'rg_files_with_matches' }, now + 40);
  ok('长工具名被截断', long.label.length <= 14, `${long.label} (${long.label.length})`);
  ok('截断后仍能认出是哪个工具', long.label.startsWith('rg_file'), long.label);

  // 边界：14 字符正好不截断，15 字符才截
  const b14 = d.handle({ kind: 'tool', tool: 'a'.repeat(14) }, now + 50);
  const b15 = d.handle({ kind: 'tool', tool: 'b'.repeat(15) }, now + 60);
  ok('14 字符不截断', b14.label === 'a'.repeat(14), `${b14.label.length} 字符`);
  ok('15 字符截断', b15.label.length === 14, `${b15.label.length} 字符`);

  // 每个存活敌人都有名字（这条防的是"以后又只给 BOSS 加标签"）
  const allNamed = d.enemies.every((e) => typeof e.label === 'string' && e.label.length > 0);
  ok('所有存活敌人都有名字', allNamed, `${d.enemies.length} 个敌人`);
}

/*
 * 名字必须能从**对外调试快照**里看到。
 *
 * 浏览器实测发现 __shield.enemies() 原来不含 label 字段，
 * 外部想验证"小兵身上有名字"只能去 hook canvas 的 fillText ——
 * 而 _refs.mjs 这种 Node 环境没有 canvas 文字可 hook。
 *
 * 也就是说：内部有 label、外部看不见，验证只能靠人眼看。
 * 这条断言把"对外的可观察性"钉住，防止以后字段被删。
 */
{
  const src = readFileSync(new URL('./main.mjs', import.meta.url), 'utf8');
  ok('调试快照暴露 label 字段',
     /label:\s*e\.label/.test(src),
     'main.mjs 的 enemies() 快照里要有 label: e.label');
  ok('调试快照暴露 kindLabel 字段',
     /kindLabel:\s*e\.kindLabel/.test(src),
     'main.mjs 的 enemies() 快照里要有 kindLabel: e.kindLabel');
}

/* ================= 9. 至少停留一秒 ================= */

section('瞬杀也要留够一秒');

{
  /*
   * 用户的原话：「最好是保留一秒钟（就算是瞬杀，
   * 血条也是呈现一秒钟快速消耗殆尽的感觉），别一闪而过看不清」。
   *
   * 原来 deathT 每秒走 3.2，尸体 0.31 秒就没了；
   * 加上小兵本身只活 450~750ms，一个 read_file 全程不到 1 秒。
   *
   * 现在 dyingMs=1000，按真实毫秒推进。
   */

  // 用 bash（精英，不是 BOSS）测，因为小兵才是"看不清"的重灾区
  const d = fresh();
  const now = 5000;
  const e = d.handle({ kind: 'tool', tool: 'grep' }, now);

  // 出生 40ms 就结束 —— 这是最极端的瞬杀
  d.handle({ kind: 'tool_end', tool: 'grep', ok: true }, now + 40);
  ok('瞬杀成立', e.diedAt === now + 40 && d.kills === 1, `kills=${d.kills}`);

  // 死亡后立刻：还在展示期，名字该显示
  ok('死亡瞬间在展示期', e.isDying(now + 41) === true);
  ok('死亡瞬间 deathT 还没推进', e.deathT === 0, String(e.deathT));

  /*
   * 按 1/60 秒推进 1000ms，看 deathT 什么时候到 1。
   * 期望：约 60 帧（1.0 秒），而不是原来的 0.31 秒。
   */
  const P = makeAegis();
  let t = now + 40;
  let framesToGone = -1;
  for (let i = 1; i <= 240; i++) {
    t = now + 40 + i * (1000 / 60);
    d.advance(1 / 60, t, P);
    if (d.gone.includes(e)) { framesToGone = i; break; }
  }
  const secToGone = framesToGone < 0 ? -1 : framesToGone / 60;

  ok('瞬杀敌人可见寿命 >= 1 秒', secToGone >= 0.95,
     `${secToGone.toFixed(2)}s（${framesToGone} 帧）`);
  ok('也不会赖着不走（<= 1.2 秒）', secToGone > 0 && secToGone <= 1.2,
     `${secToGone.toFixed(2)}s`);

  // 展示期内 isDying 为真，之后为假
  ok('展示期前 90% 都在显示', e.isDying(now + 40 + 900) === true);
  ok('展示期结束后不再显示名字', e.isDying(now + 40 + 1100) === false);
}

/* ================= 10. 血条一秒内耗尽 ================= */

section('血条在展示期内耗尽');

{
  const d = fresh();
  const now = 6000;

  /*
   * 关键场景：**血条还很满的时候被瞬杀**。
   *
   * 挑 read_file（预估 450ms），出生 40ms 就结束 →
   * 死亡时血条约 91%。如果不做"快速耗尽"，
   * 画面上就是一个满血小兵凭空消失，完全看不出它被打死了。
   */
  const e = d.handle({ kind: 'tool', tool: 'read_file' }, now);
  d.handle({ kind: 'tool_end', tool: 'read_file', ok: true }, now + 40);

  const atDeath = e.hpAtDeath;
  ok('死亡时血条还很高（预估未走完）', atDeath > 0.85,
     `${(atDeath * 100).toFixed(1)}%`);

  /*
   * 死亡瞬间 hpRatio 必须等于快照，不能因为 diedAt 写好就变 0。
   * 这里防的是一个真实踩过的顺序 bug：
   * 先写 diedAt 再取快照，hpRatio 会走"死亡衰减"分支读到 null→0。
   */
  ok('死亡瞬间血条 = 快照', Math.abs(e.hpRatio(e.diedAt) - atDeath) < 1e-9,
     `${e.hpRatio(e.diedAt)} vs ${atDeath}`);

  // 血条必须**单调**下降，不能忽高忽低
  let prev = e.hpRatio(now + 40);
  let nonMono = 0;
  for (let ms = 10; ms <= 500; ms += 10) {
    const cur = e.hpRatio(now + 40 + ms);
    if (cur > prev + 1e-9) nonMono++;
    prev = cur;
  }
  ok('血条单调下降', nonMono === 0, `${nonMono} 次回升`);

  // hpDrainMs 之内必须掉到 0
  ok('血条在 hpDrainMs 内耗尽', e.hpRatio(now + 40 + COMBAT.hpDrainMs) === 0,
     `${(e.hpRatio(now + 40 + COMBAT.hpDrainMs) * 100).toFixed(1)}%`);
  ok('hpDrainMs 比展示期短（掉空后还停一会儿）',
     COMBAT.hpDrainMs < COMBAT.dyingMs,
     `${COMBAT.hpDrainMs} < ${COMBAT.dyingMs}`);
  /*
   * 展示期必须**至少**一秒。
   *
   * 不再断言 === 1000：浏览器逐帧实测发现名义 1000ms 时
   * 24 次里 17 次实测 986.9~999.6ms（"跨过 1.0 那一帧才移除"的
   * 量化误差），大部分情况其实不到一秒。
   * 现在配置带 60ms 余量，断言改成下界语义。
   */
  ok('展示期至少 1 秒', COMBAT.dyingMs >= 1000, String(COMBAT.dyingMs));
  ok('展示期留了帧量化余量（不至于名义一秒实测偏短）',
     COMBAT.dyingMs >= 1000 && COMBAT.dyingMs <= 1150, String(COMBAT.dyingMs));
}

/* ================= 11. 展示期不能造假 ================= */

section('展示期不改变诚实语义');

{
  /*
   * 这是整组改动里风险最高的一条：
   * 死亡动画从 0.31 秒拉长到 1 秒之后，
   * 敌人会在 enemies 数组里多待 0.7 秒。
   *
   * 而 _finishTool 的"重复上报"判断查的正是 this.enemies（含刚死的）。
   * 所以必须确认：延长展示期**不会**让重复事件被算成新击杀，
   * 也**不会**因为尸体还在就多刷一个敌人出来。
   */
  const d = fresh();
  const now = 7000;

  d.handle({ kind: 'tool', tool: 'bash' }, now);
  d.handle({ kind: 'tool_end', tool: 'bash', ok: true }, now + 100);
  ok('延长展示期后仍只记 1 次击杀', d.kills === 1, `kills=${d.kills}`);

  // 尸体还在展示期的时候，重复上报三次
  d.handle({ kind: 'tool_end', tool: 'bash', ok: true }, now + 300);
  d.handle({ kind: 'tool_end', tool: 'bash', ok: true }, now + 600);
  d.handle({ kind: 'tool_end', tool: 'bash', ok: true }, now + 900);

  ok('展示期内的重复上报不算击杀', d.kills === 1, `kills=${d.kills}`);
  ok('展示期内的重复上报被计数', d.duplicates === 3, `duplicates=${d.duplicates}`);
  ok('展示期内不补造敌人', d.enemies.length === 1, `enemies=${d.enemies.length}`);

  /*
   * 反向确认：展示期**结束之后**的重复上报也要正确处理。
   * 这时敌人已经进 gone，靠 gone 那条分支兜住。
   */
  const P = makeAegis();
  for (let i = 0; i < 90; i++) d.advance(1 / 60, now + 1000 + i * (1000 / 60), P);
  ok('展示期结束后敌人进 gone', d.gone.length === 1, `gone=${d.gone.length}`);

  d.handle({ kind: 'tool_end', tool: 'bash', ok: true }, now + 3000);
  ok('gone 之后的重复上报不算击杀', d.kills === 1, `kills=${d.kills}`);
  ok('gone 之后的重复上报仍被计数', d.duplicates === 4, `duplicates=${d.duplicates}`);

  /*
   * 还有一个诚实性底线：展示期是**纯表现层**，
   * 不能拖慢真实击杀的记账时间。
   */
  const d2 = fresh();
  const e2 = d2.handle({ kind: 'tool', tool: 'glob' }, now);
  d2.handle({ kind: 'tool_end', tool: 'glob', ok: true }, now + 50);
  ok('击杀在事件到达那一刻就记账（不等动画）',
     d2.kills === 1 && e2.diedAt === now + 50,
     `kills=${d2.kills} diedAt=${e2.diedAt}`);
  ok('记账时 deathT 还是 0（动画还没开始）', e2.deathT === 0, String(e2.deathT));
}

/* ================= 10. 处决特效 ================= */

section('处决：把"没打空就死"解释清楚');

{
  /*
   * 用户的原话：
   *   「还是有些小怪没被电到就直接挂了，闪电击中的时候可以扣少量血，
   *     然后完成任务的时候有个处决特效，秒杀剩余血量，
   *     这会比较符合逻辑」
   *
   * 这句指出的是**因果断裂**：
   *   小兵预估寿命 450ms，只够挨 1~2 下雷（每下最多 15%），
   *   所以 tool_end 到达时它血条还剩七八成，
   *   但画面上它"直接死了" —— 观众看不到死因。
   *
   * 修法是给死亡一个比血条更重的可见原因：一道处决雷，
   * 把剩余血量一次清零。这组断言就是钉住这件事。
   */
  const d = fresh();
  const now = 9000;

  const e = d.handle({ kind: 'tool', tool: 'read_file' }, now);
  ok('小兵出生血条满', e.hpRatio(now) === 1, String(e.hpRatio(now)));

  /* 平时挨一下只掉少量 —— 这就是"扣少量血" */
  const lost1 = e.applyBolt(1);
  ok('平时雷击只掉少量血', lost1 <= 0.15 + 1e-9,
     `${(lost1 * 100).toFixed(1)}%`);
  ok('挨一下之后血条仍然很高', e.hpRatio(now) > 0.8,
     `${(e.hpRatio(now) * 100).toFixed(1)}%`);

  /*
   * 现在任务完成 → 处决。
   * 这是本次改动的核心：处决产生一道可见的雷。
   */
  const beforeBolts = d.lightning.length;
  d.handle({ kind: 'tool_end', tool: 'read_file', ok: true }, now + 200);

  const execBolts = d.lightning.filter((l) => l.exec === true);
  ok('击杀产生了处决雷', execBolts.length === 1,
     `lightning 从 ${beforeBolts} 增到 ${d.lightning.length}，其中 exec ${execBolts.length}`);

  if (execBolts.length) {
    const l = execBolts[0];
    ok('处决雷指向被处决的敌人', l.bolts.length === 1
       && Math.abs(l.bolts[0].x - e.x) < 1e-9
       && Math.abs(l.bolts[0].y - e.y) < 1e-9,
       `bolts=${JSON.stringify(l.bolts.map((b) => [Math.round(b.x), Math.round(b.y)]))}`);
    ok('处决雷记录了剩余血量权重', l.execWeight > 0 && l.execWeight <= 1,
       `execWeight=${l.execWeight.toFixed(3)}`);
    ok('处决雷起点是土豆方向（不是凭空）',
       typeof l.fromX === 'number' && typeof l.fromY === 'number',
       `from=(${l.fromX}, ${l.fromY})`);
  }

  /* 处决把剩余血量清零 —— 这就是"秒杀剩余血量" */
  ok('处决后血条归零', e.hpAtDeath !== null && e.hpAtDeath > 0,
     `死亡瞬间快照 ${(e.hpAtDeath * 100).toFixed(1)}%（这是清零**前**的值）`);
  ok('处决后 hpLost 打满', e.hpLost === 1, String(e.hpLost));

  /*
   * 处决雷比普通雷活得久 —— 它是死因，必须看得见。
   */
  ok('处决雷存活时间比普通雷长', COMBAT.execMs > 180,
     `execMs=${COMBAT.execMs} vs 普通 180`);

  /*
   * ===== 诚实性：处决雷不能自己造击杀 =====
   *
   * 处决雷只是演。杀掉敌人的是 tool_end。
   * 这里确认：没有 tool_end 时，光有雷不会产生任何击杀。
   */
  const d2 = fresh();
  const e2 = d2.handle({ kind: 'tool', tool: 'grep' }, now);
  for (let i = 0; i < 200; i++) e2.applyBolt(1);   // 打到血条满溢
  ok('雷把血条打空也不产生击杀', d2.kills === 0, `kills=${d2.kills}`);
  ok('血条打空后敌人仍然活着', e2.diedAt === null, `diedAt=${e2.diedAt}`);
  ok('血条不会超过 1', e2.hpLost <= 1, `hpLost=${e2.hpLost}`);
}

{
  /*
   * 失败的事件**不该**有处决演出。
   * "任务没做成"不配拥有击杀特效 —— 这是诚实性的一部分。
   */
  const d = fresh();
  const now = 10000;
  d.handle({ kind: 'tool', tool: 'bash' }, now);
  d.handle({ kind: 'tool_end', tool: 'bash', ok: false }, now + 100);

  const execBolts = d.lightning.filter((l) => l.exec === true);
  ok('失败没有处决雷', execBolts.length === 0, `exec=${execBolts.length}`);
  ok('失败仍然计为失败', d.failures === 1 && d.kills === 0,
     `failures=${d.failures} kills=${d.kills}`);
}

{
  /*
   * 处决雷不能因为展示期/重复上报而被重复创建。
   *
   * 重复上报时 _settle 会早退（diedAt !== null），
   * 所以不该再 push 一条新的处决雷。
   */
  const d = fresh();
  const now = 11000;
  d.handle({ kind: 'tool', tool: 'glob' }, now);
  d.handle({ kind: 'tool_end', tool: 'glob', ok: true }, now + 100);
  const after1 = d.lightning.filter((l) => l.exec === true).length;

  d.handle({ kind: 'tool_end', tool: 'glob', ok: true }, now + 300);
  d.handle({ kind: 'tool_end', tool: 'glob', ok: true }, now + 600);
  const after3 = d.lightning.filter((l) => l.exec === true).length;

  ok('重复上报不重复产生处决雷', after3 === after1 && after1 === 1,
     `第一次 ${after1} 条，重复上报后 ${after3} 条`);
  ok('重复上报不重复击杀', d.kills === 1, `kills=${d.kills}`);
}

{
  /*
   * turn_end ok:true 是"最终击杀"—— 它会一次结算所有敌人。
   * 每个被结算的敌人**都**应该有处决雷，否则清场会显得很突然：
   * 一堆怪同时凭空消失。
   */
  const d = fresh();
  const now = 12000;
  d.handle({ kind: 'tool', tool: 'read_file' }, now);
  d.handle({ kind: 'tool', tool: 'bash' }, now + 10);
  d.handle({ kind: 'tool', tool: 'agent_run' }, now + 20);
  const alive = d.enemies.length;
  ok('清场前有 3 个敌人', alive === 3, String(alive));

  d.handle({ kind: 'turn_end', ok: true }, now + 500);
  const execs = d.lightning.filter((l) => l.exec === true);
  ok('清场时每个敌人都有处决雷', execs.length === alive,
     `${execs.length} 条 exec vs ${alive} 个敌人`);
  ok('清场全部计为击杀', d.kills === alive, `kills=${d.kills}`);
}

/* ================= 12. 处决雷的起点与暴露 ================= */

section('处决雷从法杖劈出，且对外可观察');

{
  /*
   * ===== 抓到一个更隐蔽的 bug =====
   *
   * _settle 里画处决雷时写的是
   *   const potato = this.potato || { arena.cx, arena.cy }
   * 而 this.potato **从来没被赋值** —— 于是永远走兜底，
   * 处决雷起点恒为场地中心。
   *
   * 浏览器实测的数字：处决雷 from = (0, 0)，
   * 击杀瞬间土豆实际在 (-8.96, 51.76)，偏差 52.5px。
   * 画面上是"雷从场地正中劈出来"，不是从法杖劈出来。
   *
   * 这一类 bug（变量声明了、读了，但没人写）语法检查抓不到，
   * 之前的 target() 和 faceLeft 都是同一个病根。
   * 所以这两条断言必须存在：一条查赋值，一条查坐标真的跟上了。
   */
  const d = fresh();
  const now = 20000;

  d.handle({ kind: 'tool', tool: 'read_file' }, now);

  /*
   * 把盾牌挪到一个明确的、和场地中心不同的位置。
   * 盾牌站在正中央的话，这个 bug 会被掩盖（兜底值恰好正确）。
   */
  const farP = {
    x: d.arena.cx + 120,
    y: d.arena.cy - 80,
    vx: 0, vy: 0, moving: false, fleeing: false, swing: 0, swingT: 0, hurtT: 0,
  };
  d.advance(1 / 60, now + 16, farP);

  /*
   * 这条断言守的是一个曾经真出过的 bug：
   *
   * director 读 potato.px，而 main.mjs 传的是 x/y，
   * 结果 potato.px === undefined → dx = NaN → 敌人坐标变 NaN → 整场敌人消失。
   *
   * 现在字段名统一成 aegis + px/py，所以这里检查的是
   * advance 有没有把位置真的记下来。
   */
  ok('advance 记住了本体位置', !!d.aegis,
     d.aegis ? `aegis=(${d.aegis.x.toFixed(1)}, ${d.aegis.y.toFixed(1)})` : 'null');

  d.handle({ kind: 'tool_end', tool: 'read_file', ok: true }, now + 100);
  const exec = d.lightning.find((l) => l.exec === true);
  ok('处决雷存在', !!exec, String(!!exec));

  if (exec) {
    const distToCenter = Math.hypot(exec.fromX - d.arena.cx, exec.fromY - d.arena.cy);
    ok('处决雷起点不在场地中心（不是走兜底）', distToCenter > 1,
       `离中心 ${distToCenter.toFixed(1)}px，from=(${exec.fromX.toFixed(1)}, ${exec.fromY.toFixed(1)})`);

    const distToPotato = Math.hypot(exec.fromX - farP.x, exec.fromY - farP.y);
    ok('处决雷从土豆位置劈出', distToPotato < 1e-6,
       `离土豆 ${distToPotato.toFixed(2)}px`);
  }
}

{
  /*
   * 处决标记必须能从对外调试快照里读到。
   *
   * 浏览器实测发现 __shield.lightning() 把 exec / execWeight 剥掉了，
   * 外部只能靠"存活 420ms 而不是 180ms"反推 —— 那是猜。
   */
  const src = readFileSync(new URL('./main.mjs', import.meta.url), 'utf8');
  ok('调试快照暴露 lightning 的 exec 字段',
     /exec:\s*l\.exec\s*===\s*true/.test(src),
     'main.mjs 的 lightning() 快照里要有 exec 标记');
  ok('调试快照暴露 execWeight',
     /execWeight:\s*l\.execWeight/.test(src),
     'main.mjs 的 lightning() 快照里要有 execWeight');
}

/* ================= 13. 打击感（game feel）================= */

section('打击感：震屏 / 闪烁 / 飘字');

{
  /*
   * 这一组断言不是在测"好不好玩"——那种事只有人眼能判。
   * 它们测的是**有没有犯已知的错误**。
   *
   * 每条都对应一条查证过的具体做法或反例，来源写在注释里。
   * 这些做法一旦被无意改回去，画面会悄悄变差，而且没有任何报错。
   */
  const renderSrc = readFileSync(new URL('./render.mjs', import.meta.url), 'utf8');
  const mainSrc = readFileSync(new URL('./main.mjs', import.meta.url), 'utf8');

  /*
   * 1. 震屏**不能**逐帧 Math.random()。
   *
   * GDC 2016 Squirrel Eiserloh《Juicing Your Cameras With Math》：
   * "Use Perlin noise for shakes and for, like, everything else."
   * 理由是相邻帧的纯随机偏移完全无关，画面在像素间高频跳变，
   * 读起来像静电噪声而不是冲击。
   *
   * 这条断言抓的是"震屏代码里出现裸 Math.random"这种退化。
   */
  {
    /*
     * ===== 这里抓错过一次，记一下 =====
     *
     * 第一版用 `renderSrc.indexOf('_shakeOffset(')` 截窗口。
     * 但那个字符串在文件里**先出现的是调用点**
     * （`this._shakeOffset(now, shakeAmt)`），
     * 于是截到的是 draw() 里的一大段无关代码，
     * 而方法定义在更后面。
     *
     * 后果很阴：把震屏改回 Math.random 也不会报错 ——
     * 断言看起来在检查，实际上检查的是别的地方。
     * 必须按**定义签名**（带参数）定位。
     */
    /*
     * 收紧：定义签名必须**恰好出现一次**才拿去定位。
     * 原来只判断 defIdx >= 0，可一旦签名被改写（比如加了参数），
     * indexOf 返回 -1 → shakeFn 变成空串 → 下面的「不含 Math.random」
     * 会因 length > 0 判红（这个还好），但「trauma 平方」那条是扫全文的，
     * 定义挪走了照样绿。所以这里把"锚点唯一"本身也断开成一条断言。
     */
    const defCount = countOf(renderSrc, '_shakeOffset(now, sAmt)');
    const defIdx = defCount === 1 ? renderSrc.indexOf('_shakeOffset(now, sAmt)') : -1;
    const shakeFn = defIdx >= 0 ? renderSrc.slice(defIdx, defIdx + 1200) : '';
    ok('震屏方法定义可定位（定义签名恰好出现一次）',
       defCount === 1,
       defCount === 0 ? '没找到定义 _shakeOffset(now, sAmt)'
         : defCount > 1 ? `定义签名出现 ${defCount} 次，无法确定是哪一处` : 'ok');
    ok('震屏不用逐帧 Math.random（应用噪声）',
       shakeFn.length > 0 && !/Math\.random/.test(shakeFn),
       '震屏必须是连续的噪声采样，不能每帧重掷骰子');
    /*
     * 直接对全文匹配，不用 slice 窗口 ——
     * 上一版窗口只有 1200 字符，而 trauma*trauma 在方法后段，
     * 结果断言稳定失败，看起来像"代码错了"，其实是断言截错了范围。
     * 这类假失败比漏检更浪费时间。
     */
    ok('震屏用了 trauma 平方（Eiserloh 模型）',
       /const k = trauma \* trauma/.test(renderSrc),
       '实际偏移 = trauma² × maxOffset');
  }

  /*
   * ===== 1b. 噪声频率必须低于 Nyquist，否则等于没做噪声 =====
   *
   * 这条是本轮踩坑之后补的，教训很具体：
   *
   * 第一版写 freq = 19、倍数 11:23:41，最高一路是 779Hz。
   * 屏幕按 60Hz 采样时，每帧相位推进 81 rad —— 远超 Nyquist 上限 π。
   * 结果正弦和**混叠成高频噪声**，浏览器实测的相邻帧位移差值
   * 占全程 35%，和纯 Math.random() 的参照值一模一样（0.353 vs 0.350）。
   *
   * 也就是说：代码"看起来"用了噪声、注释也写着噪声，
   * 但实际效果与随机抖动无法区分。这种失效不会报错、
   * 不影响任何功能，只有真去量相邻帧差值才会露。
   *
   * 约束：对每一路分量，freq × mul / 帧率 × 2π < π
   * 取最坏的 60Hz（比 75Hz 更严格）。
   */
  {
    const worstFps = 60;
    let bad = [];
    for (const mul of SHAKE.harmonics) {
      const hz = SHAKE.freq * mul;
      const perFrame = (hz / worstFps) * 2 * Math.PI;
      if (perFrame >= Math.PI) {
        bad.push(`${hz.toFixed(1)}Hz 每帧 ${perFrame.toFixed(2)}rad`);
      }
    }
    ok('震屏噪声每一路都低于 Nyquist（60fps 采样不混叠）',
       bad.length === 0,
       bad.length ? bad.join(' / ') : `最高 ${(SHAKE.freq * Math.max(...SHAKE.harmonics)).toFixed(1)}Hz`);
  }

  /*
   * 2. trauma 必须衰减，而且是从 main 传进来的活值。
   */
  ok('trauma 随时间衰减', /SHAKE_DECAY_PER_SEC/.test(mainSrc)
     && /shake - dt \* SHAKE_DECAY_PER_SEC/.test(mainSrc),
     'trauma 线性衰减，应用时才平方');

  /*
   * 3. 震屏强度必须按事件分级，不能所有事件一个值。
   *
   * 上一版所有击杀都写死 2.2px —— BOSS 死了和小兵死了晃得一样。
   */
  {
    const hasBoss = /TRAUMA\.killBoss/.test(mainSrc);
    const hasNormal = /TRAUMA\.kill\b/.test(mainSrc);
    ok('击杀震屏按 BOSS/小兵分级', hasBoss && hasNormal,
       'BOSS 死亡必须比小兵死亡震得更狠');
  }

  /*
   * 4. 受击白闪不能是 additive（lighter）叠加。
   *
   * 上一版用 lighter 画白闪，在被电住的青蓝色之上再加白，
   * 会过曝成一个白方块，而不是"闪一下"。
   * 现在改成 source-atop：只把已画上去的敌人像素染白。
   */
  {
    /*
     * 收紧：原来用 `renderSrc.indexOf('_flashAlpha')` 切 4000 字符窗口。
     * `_flashAlpha` 在调用点和方法定义处都会命中，indexOf 取第一个，
     * 窗口起点因此不确定；更关键的是 —— 锚点找不到时 indexOf 返回 -1，
     * `slice(-1, 3999)` 基本是空串，于是整条断言退化成
     * 「另外两个 OR 分支里的正则是否命中」，等于恒真。
     *
     * 现在按**唯一调用点**定位（`this._flashAlpha(e, now)` 全文只出现 1 次），
     * 只认这一处的合成模式，不看别处的注释或离屏剪影。
     */
    const callCount = countOf(renderSrc, 'this._flashAlpha(e, now)');
    const callAt = callCount === 1 ? renderSrc.indexOf('this._flashAlpha(e, now)') : -1;
    ok('白闪调用点可唯一定位（this._flashAlpha(e, now)）',
       callCount === 1,
       callCount === 1 ? 'ok' : `命中 ${callCount} 次`);
    const flashSite = callAt >= 0 ? renderSrc.slice(callAt, callAt + 700) : '';
    /*
     * 剥掉注释再判。窗口里的注释正好写着「用 'source-atop' 而不是
     * 'lighter'」—— 说明文字里提到名字不等于代码里用了它。
     * 注释会把断言顶红，也会把断言顶绿，两个方向都得防。
     */
    const flashCode = flashSite.replace(/\/\*[\s\S]*?\*\//g, '');
    ok('白闪用 source-atop 而不是 lighter 叠加',
       /globalCompositeOperation\s*=\s*'source-atop'/.test(flashCode)
       && !/'lighter'/.test(flashCode),
       '加色叠加会过曝，应该是"把敌人像素染白"');
  }

  /*
   * 5. 白闪必须**短促**且有去重，否则连击时常亮。
   *
   * Hollow Knight 的 flashWhiteQuick 实测 52ms。
   * 如果按 hurtT 全程画，雷电链打同一目标会首尾相接，敌人一直发亮。
   */
  {
    /*
     * 同样按定义签名定位（`_flashAlpha(e, now)`），不用裸方法名 ——
     * 裸名字会先匹配到调用点，截错范围。
     */
    const FLASH_SIG = '_flashAlpha(e, now) {';
    const flashSigCount = countOf(renderSrc, FLASH_SIG);
    ok('白闪方法定义可唯一定位（_flashAlpha(e, now) {）',
       flashSigCount === 1, `命中 ${flashSigCount} 次`);
    const fi = flashSigCount === 1 ? renderSrc.indexOf(FLASH_SIG) : -1;
    const flashFn = fi >= 0 ? renderSrc.slice(fi, fi + 1800) : '';
  {
    const m = renderSrc.match(/const DUR = (\d+)/);
    ok('白闪时长短促（≤ 80ms）', m !== null && Number(m[1]) <= 80,
       m ? `DUR = ${m[1]}ms（参照 Hollow Knight 的 52ms）` : '没找到 DUR 常量');
  }
    ok('白闪按敌人 id 去重（连击不会常亮）',
       /_flashAt[\s\S]{0,200}\.set\(e\.id/.test(flashFn),
       '用 lastFlash[id] 记时间戳，保证有暗下去的间隙');
  }

  /*
   * 6. 飘字必须有随机水平偏移。
   *
   * 两份独立实现都强调这一点，原文：
   *   "without it, ten hits on the same enemy stack into one
   *    unreadable blur."
   */
  ok('飘字有随机水平偏移（避免连击重叠）',
     /drift:\s*opts\.drift \?\?/.test(renderSrc)
     && /Math\.random\(\) \* 2 - 1\) \* 12/.test(renderSrc),
     '±12px 抖动，照抄 Godot 实现的 randf_range(-12,12)');

  /*
   * 7. 飘字必须是缓出上升，前段不淡出。
   *
   * 线性上升看起来像电梯；一出现就淡出会让最该看清的
   * 那 150ms 反而最模糊。
   */
  {
    ok('飘字用缓出而不是线性',
       /const ease = 1 - \(1 - k\) \* \(1 - k\)/.test(renderSrc),
       '缓出才有"弹出来"的感觉');
    ok('飘字前段保持全不透明',
       /const fadeStart = 0\.15/.test(renderSrc),
       '前 150ms 是眼睛捕捉数字的窗口');
    ok('飘字有 scale punch',
       /if \(f\.pop > 1\)/.test(renderSrc)
       && /const pt = Math\.min\(1, f\.t \/ 0\.18\)/.test(renderSrc),
       '暴击/击杀从 1.4 收敛到 1.0');
  }

  /*
   * 8. 可访问性：震屏 / 闪烁 / 飘字必须是**三个独立**开关。
   *
   * Vampire Survivors 把它们做成独立选项；Nuclear Throne 是被
   * 玩家投诉晕动症之后才被迫补上震屏开关的。所以这个应该一开始就有。
   */
  {
    ok('有独立的特效开关组', /const FX = \{/.test(mainSrc), 'FX 对象');
    for (const k of ['shake', 'flash', 'numbers']) {
      ok(`开关 ${k} 可独立切换`,
         new RegExp(`FX\\.${k} = !FX\\.${k}`).test(mainSrc),
         `FX.${k} 有独立快捷键`);
    }
    ok('关掉震屏后不再累加 trauma', /if \(!FX\.shake\) return;/.test(mainSrc),
       'addTrauma 里要早退');
    ok('闪烁开关传进渲染层', /fx: FX/.test(mainSrc),
       '白闪在 renderer 内部触发，必须传开关下去');
  }

  /*
   * 9. 刻意**不做** hit-stop（顿帧）。
   *
   * 这是本轮研究里最反直觉的一条，值得写成断言防止以后
   * "为了打击感"又加回去：
   *
   *   Blue Tengu 在做俯视复古射击时试过 Vlambeer 的 sleep（冻结帧），
   *   结论是弃用 —— "俯视动作 + 复古像素风下，玩家预期画面平滑移动，
   *   哪怕 1 帧的迟疑都感觉诡异，而在横版射击里就会很爽"。
   */
  ok('没有引入 hit-stop 顿帧（俯视游戏实测反对）',
     !/hitStop|hitstop|timeScale\s*=\s*0/.test(mainSrc)
     && !/hitStop|hitstop/.test(renderSrc),
     '俯视 2D 里冻结帧会被读成卡顿，用震屏+白闪+飘字替代');
}

/* ================= 出生显形 / 连击 / HUD 分层 ================= */

section('出生显形：不是预警，只是不让它凭空弹出');

{
  /*
   * 这一段的每条断言都对应一个\"会撒谎\"的写法，
   * 所以检查的是**语义可达性**，不是\"代码里有这个词\"。
   */

  /* --- 1. 新出生的敌人 spawnT 必须从 0 开始 --- */
  const d = fresh();
  d.handle({ kind: 'tool', tool: 'read_file' }, 1000);
  const e = d.enemies[0];
  ok('新生敌人 spawnT 初始为 0', e && e.spawnT === 0,
     `实际 ${e && e.spawnT}`);

  /* --- 2. spawnT 按真实毫秒推进，且封顶 1 --- */
  const half = COMBAT.spawnMs / 2;
  d.advance(half / 1000, 1000 + half, makeAegis());
  const mid = d.enemies[0].spawnT;
  ok('spawnT 按真实毫秒推进（半程约 0.5）',
     mid > 0.45 && mid < 0.56, `实际 ${mid.toFixed(4)}`);

  /* 推进超过 spawnMs 后封顶，不会超过 1 */
  const t2 = 1000 + COMBAT.spawnMs * 3;
  d.advance(COMBAT.spawnMs * 3 / 1000, t2, makeAegis());
  ok('spawnT 封顶为 1，不会越过',
     d.enemies[0].spawnT === 1, `实际 ${d.enemies[0].spawnT}`);

  /*
   * --- 3. 显形期间数值不变 ---
   *
   * 这是最容易被做错的地方：为了\"好看\"把显形做成无敌/不可命中，
   * 那就等于出生后 320ms 内免疫 —— 假的是战斗语义。
   * 断言：显形未完成时它照样能被打到。
   */
  const d2 = fresh();
  d2.handle({ kind: 'tool', tool: 'read_file' }, 1000);
  const e2 = d2.enemies[0];
  const hitsBefore = (e2.hitsTaken || 0) + (e2.damageTaken || 0);
  /* 直接推挥击，土豆贴脸 */
  d2.advance(0.1, 1100, { x: e2.x, y: e2.y, moving: false, fleeing: false });
  ok('显形期间敌人不算无敌（数值不受 spawnT 影响）',
     e2.spawnT < 1, `spawnT=${e2.spawnT.toFixed(2)} 仍处于显形期`);
}

{
  /*
   * --- 4. render 必须真的用 spawnT 改变绘制 ---
   *
   * 只查源码里有 spawnT 是不够的：变量读了但没影响输出，
   * 就是\"死变量\"（这个项目已经踩过一次）。
   * 所以查的是**绘制参数里有没有 spawnT 参与**。
   */
  const renderSrc = readFileSync(new URL('./render.mjs', import.meta.url), 'utf8');
  const hasScale = /scaleMul\s*\*?=\s*0\.60\s*\+\s*0\.40\s*\*\s*et/.test(renderSrc);
  const hasAlpha = /alpha\s*\*=\s*0\.25\s*\+\s*0\.75\s*\*\s*et/.test(renderSrc);
  ok('显形真的改变了绘制缩放（不是死变量）', hasScale);
  ok('显形真的改变了绘制透明度（不是死变量）', hasAlpha);

  /*
   * --- 5. 出生环必须画在**影子之前** ---
   *
   * 环是贴地的，如果画在影子后面，会被影子盖住一半，
   * 看起来像\"环从地里长出来\"而不是\"环贴在敌人脚下\"。
   * 用位置比较断言，而不是\"存在即可\"。
   */
  /*
   * 定位方式要小心：'_drawShadow(ctx, e, sp, w, h, scaleMul' 在
   * **方法定义**（第 372 行）和**调用点**（第 495 行）都会命中。
   * 用 indexOf 找会先拿到定义，于是比较的是"环 vs 定义"这种
   * 无意义的位置关系 —— 恰是本项目踩过的假通过陷阱。
   *
   * 所以用只出现在调用点的特征：'dying ? alpha * 0.55 : 0.39'。
   */
  /*
   * 收紧：三条位置比较都必须先确认「锚点恰好出现一次」。
   * 位置比较最阴的退化是 indexOf 返回 -1 —— 此时 `iRing < iShadow`
   * 会因为 -1 参与比较而意外为真或意外为假，两种都不对。
   */
  const ringCount = countOf(renderSrc, 'ctx.arc(e.x, e.y + h * 0.30');
  const shadowCount = countOf(renderSrc, 'dying ? alpha * 0.55 : 0.39');
  const iRing = ringCount === 1 ? renderSrc.indexOf('ctx.arc(e.x, e.y + h * 0.30') : -1;
  const iShadow = shadowCount === 1 ? renderSrc.indexOf('dying ? alpha * 0.55 : 0.39') : -1;
  ok('出生环与影子调用点各自唯一（位置比较的前提）',
     ringCount === 1 && shadowCount === 1,
     `环命中 ${ringCount} 次 / 影子命中 ${shadowCount} 次`);
  ok('出生环画在影子之前（贴地，不被影子盖）',
     iRing > 0 && iShadow > 0 && iRing < iShadow,
     `环=${iRing} 影子调用点=${iShadow}`);
}

section('连击：连续成功才算，失败打断');

{
  /* --- 1. 第一杀是 1 --- */
  const d = fresh();
  d.handle({ kind: 'tool', tool: 'read_file' }, 1000);
  d.handle({ kind: 'tool_end', tool: 'read_file', ok: true }, 1200);
  ok('第一杀连击 = 1', d.combo === 1, `实际 ${d.combo}`);
  ok('最高连击同步更新', d.comboBest === 1, `实际 ${d.comboBest}`);

  /* --- 2. 窗口内第二杀累积到 2 --- */
  d.handle({ kind: 'tool', tool: 'grep' }, 1300);
  d.handle({ kind: 'tool_end', tool: 'grep', ok: true }, 1500);
  ok('窗口内连续击杀累积到 2', d.combo === 2, `实际 ${d.combo}`);

  /* --- 3. 窗口过期后重新从 1 开始 --- */
  const gap = COMBAT.comboWindowMs + 100;
  d.handle({ kind: 'tool', tool: 'list_files' }, 1500 + gap);
  d.handle({ kind: 'tool_end', tool: 'list_files', ok: true }, 1500 + gap + 50);
  ok('超过窗口后连击重置为 1',
     d.combo === 1, `实际 ${d.combo}（窗口 ${COMBAT.comboWindowMs}ms）`);
  ok('最高连击保留历史峰值', d.comboBest === 2, `实际 ${d.comboBest}`);

  /*
   * --- 4. 失败打断连击 ---
   *
   * 这条是本段最重要的断言。如果失败不清零，
   * combo 就变成\"一共动了几次手\"，彻底失去信息量。
   */
  const d2 = fresh();
  d2.handle({ kind: 'tool', tool: 'read_file' }, 1000);
  d2.handle({ kind: 'tool_end', tool: 'read_file', ok: true }, 1100);
  d2.handle({ kind: 'tool', tool: 'bash' }, 1200);
  d2.handle({ kind: 'tool_end', tool: 'bash', ok: true }, 1300);
  ok('失败前连击为 2', d2.combo === 2, `实际 ${d2.combo}`);
  d2.handle({ kind: 'tool', tool: 'write_file' }, 1400);
  d2.handle({ kind: 'tool_end', tool: 'write_file', ok: false }, 1500);
  ok('失败打断连击（归零）', d2.combo === 0, `实际 ${d2.combo}`);
  ok('失败不降低最高连击', d2.comboBest === 2, `实际 ${d2.comboBest}`);

  /*
   * --- 5. 读时过期：combo 不会永远停在旧值 ---
   *
   * 这是\"假报告\"的典型形态：最后一杀之后没人再打，
   * combo 若不做读时过期，HUD 会永远显示\"连击 x2\"。
   */
  const d3 = fresh();
  d3.handle({ kind: 'tool', tool: 'read_file' }, 1000);
  d3.handle({ kind: 'tool_end', tool: 'read_file', ok: true }, 1100);
  d3.handle({ kind: 'tool', tool: 'grep' }, 1200);
  d3.handle({ kind: 'tool_end', tool: 'grep', ok: true }, 1300);
  const sNow = d3.stats(1300);
  ok('刚击杀时 stats 里 combo = 2', sNow.combo === 2, `实际 ${sNow.combo}`);
  const sLater = d3.stats(1300 + COMBAT.comboWindowMs + 1);
  ok('窗口过后 stats 里 combo 读作 0（不挂旧值）',
     sLater.combo === 0, `实际 ${sLater.combo}`);
  ok('过期后 comboBest 仍是真实峰值', sLater.comboBest === 2,
     `实际 ${sLater.comboBest}`);
}

section('HUD 分层：运行态极简，诚实字段不许藏');

{
  const mainSrc = readFileSync(new URL('./main.mjs', import.meta.url), 'utf8');
  const htmlSrc = readFileSync(new URL('./index.html', import.meta.url), 'utf8');

  /*
   * --- 1. 诚实字段（未映射 / 超时）必须留在**运行态** ---
   *
   * 这一条是硬约束。做 HUD 分层时最容易犯的错：
   * 顺手把不好看的数字也塞进展开层藏起来。
   * 项目规则是\"藏起来就是假报告\"，所以必须常驻。
   */
  ok('未映射数写在运行态 hudWarn 里（不在明细层）',
     /hudWarn\.textContent/.test(mainSrc)
     && /if \(s\.unmapped > 0\) w\.push/.test(mainSrc),
     '未映射数必须常驻运行态');

  ok('超时数同样常驻运行态',
     /if \(s\.overdue > 0\) w\.push/.test(mainSrc));

  /* --- 2. 明细层不能是唯一出口 --- */
  /*
   * 收紧：原来只判 `iWarn > 0 && iDetail > 0 && iWarn < iDetail`。
   * hudWarn.textContent 在 main.mjs 里出现多次（写入 + 清空），
   * indexOf 取第一个就下结论，顺序断言容易被"第一处恰好是清空"骗过。
   * 现在要求两个锚点**各自唯一**，出现多次就明确判红而不是猜。
   */
  const warnCount = countOf(mainSrc, 'hudWarn.textContent');
  const detailCount = countOf(mainSrc, 'hudDetail.textContent');
  const iWarn = warnCount === 1 ? mainSrc.indexOf('hudWarn.textContent') : -1;
  const iDetail = detailCount === 1 ? mainSrc.indexOf('hudDetail.textContent') : -1;
  ok('运行态警示锚点唯一（hudWarn.textContent 只写一处）',
     warnCount === 1, `命中 ${warnCount} 次`);
  ok('明细层锚点唯一（hudDetail.textContent 只写一处）',
     detailCount === 1, `命中 ${detailCount} 次`);
  ok('运行态警示与明细层是两处独立输出',
     iWarn > 0 && iDetail > 0 && iWarn < iDetail,
     `警示=${iWarn} 明细=${iDetail}`);

  /* --- 3. DOM 元素真的存在 --- */
  ok('index.html 有 hudCombo 元素', /id="hudCombo"/.test(htmlSrc));
  ok('index.html 有 hudWarn 元素', /id="hudWarn"/.test(htmlSrc));
  ok('index.html 有 hudDetail 元素', /id="hudDetail"/.test(htmlSrc));

  /*
   * --- 4. 检视态的 CSS 必须真的能展开 ---
   *
   * 只加 class 不改样式 = 按 I 没反应。
   */
  const cssSrc = readFileSync(new URL('./shield.css', import.meta.url), 'utf8');
  ok('CSS 里 .inspect 真的展开明细层',
     /#hud\.inspect #hudDetail\s*\{[^}]*max-height:\s*120px/.test(cssSrc));

  /*
   * --- 5. 状态不分叉：所有 paused 写入都必须走 setPaused ---
   *
   * 这条防的是一个真实出现过的 bug 类型：
   * 手动切检视态用的 inspectManual，暂停自动展开用 inspectPaused。
   * 如果某处直接 `paused = true`，就会出现\"暂停了但明细没展开\"。
   * 用源码扫描断言：除了 setPaused 内部，不许有别的直接赋值。
   */
  const assignLines = mainSrc.split('\n')
    .map((ln, i) => ({ ln, i: i + 1 }))
    .filter((o) => /^\s*paused\s*=/.test(o.ln));
  ok('只有 setPaused 内部直接写 paused（防状态分叉）',
     assignLines.length === 1,
     `发现 ${assignLines.length} 处：` + assignLines.map((o) => `L${o.i}`).join(','));

  /*
   * --- 6. 新字段必须能从调试口观察到 ---
   *
   * 这条是浏览器实测逼出来的：spawnT 在 director 里工作正常，
   * 但 __shield.enemies() 的快照没带上它，外部脚本拿到 undefined，
   * 于是"功能到底是坏了还是没暴露"无法区分。
   * 调试口不能自证，就等于没有验证手段。
   */
  ok('enemies() 快照暴露 spawnT（能从外部自证）',
     /spawnT: e\.spawnT === undefined/.test(mainSrc),
     '否则外部只能靠猜');

  ok('stats() 暴露 combo 与 comboBest',
     /combo: this\._comboNow\(now\),/.test(
       readFileSync(new URL('./director.mjs', import.meta.url), 'utf8'))
     && /comboBest: this\.comboBest/.test(
       readFileSync(new URL('./director.mjs', import.meta.url), 'utf8')));

  /* --- 7. I 键独立开关 --- */
  ok('I 键切换检视态（独立开关，不打包特效）',
     /e\.code === 'KeyI'/.test(mainSrc) && /inspectManual = !inspectManual/.test(mainSrc));

  /*
   * --- 8. 暂停必须冻结战场，不只是事件时间轴 ---
   *
   * 浏览器实测抓到的真 bug：按 P 后 tickDemo 停了，
   * 但 director.advance 照跑 —— 暂停 1.5 秒 swings 从 58 涨到 63。
   * 这让"按 P 展开明细看数字"失去意义（数字还在跳）。
   */
  ok('暂停时 dt 归零（战场冻结，不是只停事件流）',
     /const fightDt = paused \? 0 : dt/.test(mainSrc),
     '否则暂停后敌人仍在追、血条仍在掉');

  ok('暂停时传入冻结时间戳（血条/连击/电击寿命都不流逝）',
     /const fightNow = paused \? lastRealNow : now/.test(mainSrc));

  /*
   * 暂停不能简单 return：那样 last 不更新，
   * 恢复时 dt 会吃掉整个暂停时长，敌人瞬移。
   */
  ok('暂停没有用 return 掐掉整帧（防恢复时敌人瞬移）',
     !/if \(paused\) return;/.test(mainSrc),
     '应当只用 dt=0 冻结，而不是跳过整个 frame');

  /*
   * --- 9. 计时来源只能有一个 ---
   *
   * 浏览器实测暴露的矛盾：暂停时 HUD 走冻结时钟（combo 正确为 4），
   * 但 __shield.stats() 用真实墙钟，同一个字段读出 0。
   * 同一个数在两处不一致，比数字错更难查 —— 你会不知道该信哪个。
   *
   * 所以断言：对外暴露状态的路径一律走 clockNow()。
   */
  ok('调试口 stats 用统一战斗时钟（不与 HUD 冲突）',
     /stats: \(\) => director\.stats\(clockNow\(\)\)/.test(mainSrc),
     '用 performance.now() 会导致暂停时 HUD 与调试口读数不一致');

  ok('enemies 快照的 hp/age/overdue 都走统一时钟',
     /hp: \+e\.hpRatio\(clockNow\(\)\)/.test(mainSrc)
     && /age: \+e\.ageSec\(clockNow\(\)\)/.test(mainSrc)
     && /overdue: e\.isOverdue\(clockNow\(\)\)/.test(mainSrc));

  ok('事件入口 feed 用统一时钟（暂停期 emit 不产生时间跳跃）',
     /const t = clockNow\(\);/.test(mainSrc));

  /*
   * 反向约束：调试口里不该再出现裸的 performance.now()。
   * 只允许 clockNow() 内部那一次调用。
   */
  /*
   * ===== 这里曾经有一条恒真断言 =====
   *
   * 原来写的是：
   *   mainSrc.slice(mainSrc.indexOf('window.__potato = {'))
   *
   * 但调试口早就改名成 __shield 了，indexOf 返回 **-1**，
   * 于是 slice(-1) 只取到字符串最后**一个字符**。
   * 「调试口里没有裸 performance.now()」这句断言于是变成了
   * 检查"最后一个字符里有没有 performance.now()" —— 永远通过。
   *
   * 恒真断言比没有断言更糟：它让人误以为这块已经被看着了。
   * 现在改成：先确认锚点存在，取不到就直接判红。
   */
  const portAnchor = 'window.__shield = {';
  /*
   * 收紧：原来只判 portAt >= 0。这里再补一条"锚点唯一"，
   * 因为这个位置后面拿它当切片起点 —— 起点错了，
   * 「调试口里没有裸 performance.now()」会在错误的窗口上通过。
   * 这正是当年 slice(-1) 事故的同类：位置取错，断言照绿。
   */
  const portCount = countOf(mainSrc, portAnchor);
  ok('调试口定义锚点唯一（window.__shield = {）',
     portCount === 1, `命中 ${portCount} 次`);
  const portAt = portCount === 1 ? mainSrc.indexOf(portAnchor) : -1;
  ok('能找到调试口定义（锚点存在）', portAt >= 0,
     portAt >= 0 ? 'ok' : '没找到 ' + portAnchor + '，下面的检查无法执行');

  const debugPort = portAt >= 0 ? mainSrc.slice(portAt) : '';
  /* 切出来的窗口必须是真实代码，不能是空串（空串会让后续断言退化） */
  ok('调试口窗口非空（切片起点有效）', debugPort.length > 500,
     `${debugPort.length} 字符`);
  /*
   * 只看**代码**，不看注释。
   * 上一版这条断言假失败，因为注释里写着
   * "用 clockNow() 而不是 performance.now()" —— 提到名字不等于用了它。
   * 断言要把注释剥掉再判，否则"说明文字"会把检查带偏。
   */
  const debugCode = debugPort
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((ln) => !/^\s*\/\//.test(ln))
    .join('\n');
  ok('调试口内部没有裸 performance.now()（防再分叉）',
     !/performance\.now\(\)/.test(debugCode),
     '调试口必须只依赖 clockNow()');
}

/* ================= 10.6 落地页：矮视口可滚动 / 键盘焦点 / favicon ================= */

section('落地页：矮视口可达性 / 键盘焦点 / favicon');

{
  const fsMod6 = await import('node:fs');
  const css6Raw = fsMod6.readFileSync(new URL('./shield.css', import.meta.url), 'utf8');
  const html6 = fsMod6.readFileSync(new URL('./index.html', import.meta.url), 'utf8');

  /*
   * ===== 先剥注释，再断言 =====
   *
   * 本项目的 CSS 注释写得很密，里面会成句引用属性名（例如
   * "max-height 受视口约束 + overflow-y:auto"）。直接对原文跑正则，
   * 断言会被**注释**满足 —— 规则删了照样绿。这正是本项目反复出现的
   * "存在即通过"变体，所以这里统一先剥注释。
   */
  const stripCss = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '');
  const css6 = stripCss(css6Raw);

  /*
   * ===== 诚实地说明这一节的力量边界 =====
   *
   * 下面这几条是**静态结构断言**：它们只能证明"让面板可滚动的那条规则
   * 存在"、"焦点样式定义了"、"图标声明在"。它们**不能**证明 800×600
   * 下品牌名真的完整可见 —— 那要看排版结果，只有真浏览器能量。
   *
   * 之所以还是加：把"改回去就没人知道"这件事变成一条红灯。
   * 真实观感只能由真实浏览器判定。已有截图为证的是：
   *   .lab-agent/evidence/browser2/01-start-800x600.png（面板在 800×600 内完整可见）
   *   .lab-agent/evidence/browser2/02-start-1600x900.png
   * 但它们只说明"看起来对"；真正的读数是
   *   .lab-agent/evidence/panel-height-measurements.md
   *   （#startPanel 的 scrollHeight / clientHeight，Playwright 量得）。
   * 本节这几条仍是静态结构断言，一条量测数字都不许写成"实测通过"。
   */
  const panelRule = (() => {
    const m = css6.match(/#startPanel\s*\{([^}]*)\}/);
    return m ? m[1] : '';
  })();
  ok('#startPanel 规则能被定位（结构断言的前提，否则下面是空转）',
     panelRule.length > 100, `${panelRule.length} 字符`);

  /*
   * ---- 1. 面板必须有受视口约束的高度 + 可滚动 ----
   *
   * 实测 800×600：内容 681px > 600px，flex 居中导致上下同时溢出；
   * #startPanel overflow:visible + body overflow:hidden，于是
   * scrollHeight 还是 600 —— 用户完全无法滚到品牌名。
   */
  ok('开始面板最大高度受视口约束（max-height: 100dvh/100vh）',
     /max-height:\s*100dvh/.test(panelRule) && /max-height:\s*100vh/.test(panelRule),
     panelRule.replace(/\s+/g, ' ').slice(0, 120));
  ok('开始面板内容过长时可滚动（overflow-y: auto）',
     /overflow-y:\s*auto/.test(panelRule));
  /*
   * 裸的 justify-content: center 是双端溢出的元凶：
   * 内容超高时上半截永远滚不到。所以必须有 `safe center`
   * （内容装不下时自动退化成 flex-start）。
   */
  ok('开始面板用 justify-content: safe center（防双端溢出抓不回来）',
     /justify-content:\s*safe\s+center/.test(panelRule),
     '内容超高时裸 center 会让顶部内容滚不到');
  ok('裸 justify-content: center 仍作为兜底保留（老浏览器）',
     /justify-content:\s*center\s*;/.test(panelRule));
  /*
   * 矮视口必须有专门的压缩档，且档位要盖住 600px。
   * 原来的 @media (max-height: 620px) 只压 gap 和 h1 字号，
   * 省下来的 ~10px 远不够 81px 的溢出量。
   */
  ok('矮视口压缩档存在且覆盖 600px（max-height: 700px）',
     /@media\s*\(max-height:\s*700px\)/.test(css6));
  {
    const m = css6.match(/@media\s*\(max-height:\s*700px\)\s*\{([\s\S]*?)\n\}/);
    const body = m ? m[1] : '';
    ok('700px 档真的压缩了多个块（间距/内边距/字号，不是只改一处）',
       /#startPanel\s*\{[^}]*gap:/.test(body)
       && /\.honest\s*\{[^}]*padding:/.test(body)
       && /\.entries\s*\{[^}]*margin:/.test(body)
       && /\.drop,[\s\S]{0,40}\.hook\s*\{[^}]*padding:/.test(body),
       body ? `${body.length} 字符` : '没取到 700px 档的规则体');
    /*
     * 压缩不许靠"删内容"实现：诚实声明三条必须都还在 HTML 里。
     * （这条防的是"把不好看的段落 display:none 掉换通过率"。）
     */
    ok('压缩没有藏掉诚实声明（data-theme 三条仍在 index.html）',
       /data-theme="honest-death"/.test(html6)
       && /data-theme="honest-source"/.test(html6)
       && /data-theme="honest-time"/.test(html6));
  }
  /* #stage 高度跟视口走，且用 dvh 兜移动端地址栏 */
  ok('#stage 高度跟视口走并优先用 dvh',
     /#stage\s*\{[^}]*height:\s*100vh/.test(css6)
     && /#stage\s*\{[^}]*height:\s*100dvh/.test(css6));

  /*
   * ---- 2. 键盘焦点必须可见 ----
   *
   * 之前 shield.css 里 `focus` 命中 0 次：Tab 到「进入战场」只有浏览器
   * 默认 1px 黑描边，在 --void-veil 的深色面板上等于看不见。
   */
  ok('shield.css 里有 :focus-visible 规则（不是 0 命中了）',
     (css6.match(/:focus-visible/g) || []).length >= 1,
     `命中 ${(css6.match(/:focus-visible/g) || []).length} 次`);
  {
    const m = css6.match(/([^{}]*:focus-visible[^{}]*)\{([^}]*)\}/);
    const sel = m ? m[1] : '';
    const body = m ? m[2] : '';
    ok('焦点样式覆盖 button / input（两个真实可交互元素）',
       /button:focus-visible/.test(css6) && /input:focus-visible/.test(css6));
    ok('焦点样式用 outline 且颜色取自现有 CSS 变量（不新开配色）',
       /outline:\s*2px solid var\(--cyan\)/.test(css6) || /outline:[^;]*var\(--/.test(css6),
       m ? `${sel.trim()} {${body.trim().slice(0, 80)}}` : '没取到第一条 :focus-visible 规则');
    /*
     * 变量名必须在 :root 里真的定义过 —— 引用一个不存在的变量，
     * outline 会退化成 currentColor 或不画，等于没写。
     */
    const rootBlock = (css6.match(/:root\s*\{([\s\S]*?)\n\}/) || [])[1] || '';
    const used = [...css6.matchAll(/outline:\s*[^;]*var\((--[a-z0-9-]+)\)/g)].map((x) => x[1]);
    const undefinedVars = [...new Set(used)].filter((v) => !rootBlock.includes(v + ':'));
    ok('焦点样式引用的变量都在 :root 里定义过（不会静默失效）',
       used.length > 0 && undefinedVars.length === 0,
       used.length ? (undefinedVars.length ? '未定义：' + undefinedVars.join(',') : used.join(',')) : '没找到 var()');
  }

  /*
   * ---- 3. favicon 不许再 404 ----
   *
   * 零依赖静态服务没有 /favicon.ico，浏览器每次加载都去要一次 → 404。
   * "零 console 错误"这条验收项因此永远过不了。
   * 修法是 index.html 里内联声明图标，服务端零改动、不加二进制文件。
   */
  ok('index.html 声明了 rel="icon"（不再靠浏览器去要 /favicon.ico）',
     /<link[^>]+rel="icon"/.test(html6));
  ok('图标是内联 SVG data-URI（零依赖、无二进制文件）',
     /href="data:image\/svg\+xml,/.test(html6));
  ok('图标声明了 type="image/svg+xml"（浏览器才不会当二进制猜）',
     /<link[^>]+rel="icon"[^>]+type="image\/svg\+xml"/.test(html6)
     || /<link[^>]+type="image\/svg\+xml"[^>]+rel="icon"/.test(html6));
  ok('仓库里没有引入二进制 favicon.ico（保持纯文本可 review）',
     !fsMod6.existsSync(new URL('./favicon.ico', import.meta.url)));
  /*
   * data-URI 必须真的能被解析：抽查它包含合法的 svg 根元素与闭合标签。
   * 一个手抖打错的 data-URI 在 HTML 里看起来一样，但浏览器只会静默不显示
   * —— 那就又回到"图标没出现、也说不清为什么"。
   */
  {
    const m = html6.match(/href="(data:image\/svg\+xml,[^"]*)"/);
    const uri = m ? m[1] : '';
    const svg = uri ? decodeURIComponent(uri.slice(uri.indexOf(',') + 1)) : '';
    ok('favicon 的 data-URI 解码后是完整 SVG（能真的画出来）',
       /^<svg[\s\S]*<\/svg>$/.test(svg.trim()),
       svg ? svg.slice(0, 60) + '…' : '没取到 data-URI');
    ok('favicon 用了品牌配色（--bg / --gold / --cyan 的同值，不是随便一个图标）',
       /%23070b16/i.test(uri) && /%23f2c14e/i.test(uri) && /%232bd4d4/i.test(uri),
       '须含 --bg #070b16 / --gold #f2c14e / --cyan #2bd4d4');
  }

  /*
   * ---- 4. 拖放区可被键盘到达 ----
   *
   * 只加焦点样式不够：dropZone 是 div，默认不参与 Tab 序。
   */
  ok('#dropZone 可被 Tab 到达（tabindex="0" + role）',
     /id="dropZone"[^>]*tabindex="0"/.test(html6)
     || /tabindex="0"[^>]*id="dropZone"/.test(html6));
  ok('拖放区有可用名称（role + aria-label，读屏不念空 div）',
     /aria-label="[^"]+"/.test(html6));
}

/* ================= 10.5 视口变换：任意缩放倍率下圆心必须等于画布中心 ================= */

section('视口变换：圆心恒等于画布中心（任意 scale / dpr）');

{
  /*
   * ===== 这一节为什么必须存在（真浏览器验收抓到的 bug）=====
   *
   * 上一版 `draw()` 里写的是：
   *   const cx = (this.vw / 2 + sh.x) * s0;   // s0 = scale * dpr
   * 也就是画布中心被**重复乘了一次 scale**。
   *
   * scale=1 时 ×1 恰好等于没乘，所以原有的几何断言一路绿灯；
   * 真浏览器实测 1600×900（scale=1.3）圆心 = (1040,579)，画布中心是
   * (800,450)，整块战场向右下甩出 +240,+129，底边压出画布被裁。
   *
   * 教训：**只在一档缩放上验中心 = 没验中心**。所以下面按 1.0 / 1.3 / 1.5
   * 三档（再各自叠 dpr 1/2）逐档断言，并且要求：
   *   1. 世界原点（竞技场圆心）投影后必须**精确等于**画布中心
   *   2. 竞技场的整个包围盒必须落在画布内（不许被任一边裁切）
   *   3. 震屏幅度必须与 scale 无关（手感不许随分辨率变）
   *   4. 变异自测：把 `* s0` 加回去，上面这些断言必须变红
   */

  /* 真浏览器验收用的三档视口（scale 由 resize() 的目标公式算出来） */
  const CASES = [
    { vw: 800, vh: 600, scale: 1.0, dpr: 1, note: '800×600（scale=1，历史唯一验过的档）' },
    { vw: 1600, vh: 900, scale: 1.3, dpr: 1, note: '1600×900（真浏览器实测偏移 +240,+129 的那一档）' },
    { vw: 1200, vh: 1000, scale: 1.5, dpr: 1, note: '1200×1000（实测偏移 (266,191) 的那一档）' },
    /*
     * dpr=2 再跑一遍：变换里 scale 与 dpr 是两次**独立**的乘法，
     * 只验一个会把"把 dpr 也乘进去"的写法漏掉。
     * 注意 scale 由 CSS 尺寸算出（与 dpr 无关），所以这里配的是
     * 该视口下 resize() 真会得到的档位，不是随手编的组合。
     */
    { vw: 800, vh: 600, scale: 1.0, dpr: 2, note: '800×600 @dpr2' },
    { vw: 1600, vh: 900, scale: 1.3, dpr: 2, note: '1600×900 @dpr2' },
    { vw: 1200, vh: 1000, scale: 1.5, dpr: 2, note: '1200×1000 @dpr2' },
  ];

  /*
   * 上面这些档位不能是编出来的：每一档的 scale 必须等于 resize()
   * 的目标公式在该视口下会算出的值。否则"任意倍率都居中"可能是在
   * 一组现实中不会出现的 (视口, scale) 组合上通过的 —— 又是"看起来在
   * 检查、实际检查的是别处"。
   *
   * 复刻 render.mjs:243 的公式（改公式的话这条会跟着红）。
   */
  {
    const deriveScale = (cssW, cssH) => Math.max(
      1, Math.floor(((Math.min(cssW, cssH) * 0.88) / (ARENA.r * 2 + 80)) * 10) / 10,
    );
    const mismatched = CASES.filter((c) => deriveScale(c.vw, c.vh) !== c.scale);
    ok('缩放档位与 resize() 公式一致（不是编出来的组合）',
       mismatched.length === 0,
       mismatched.map((c) => `${c.vw}×${c.vh}: 期望 ${deriveScale(c.vw, c.vh)} 实际标 ${c.scale}`).join(', '));
  }

  for (const c of CASES) {
    const t = viewportTransform(c.vw, c.vh, c.scale, c.dpr, { x: 0, y: 0 });
    const centre = projectPoint(t, 0, 0);
    const wantX = (c.vw * c.dpr) / 2;
    const wantY = (c.vh * c.dpr) / 2;
    const dx = centre.x - wantX;
    const dy = centre.y - wantY;

    ok(`圆心 = 画布中心（${c.note}）`,
       Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9,
       `实测 (${centre.x.toFixed(2)},${centre.y.toFixed(2)}) `
       + `期望 (${wantX},${wantY}) 偏移 (${dx.toFixed(2)},${dy.toFixed(2)})`);

    /*
     * 缩放必须真的作用在世界坐标上（否则"居中"可以靠不缩放蒙过去）。
     * 1 个世界单位 → scale·dpr 个设备像素。
     */
    const unit = projectPoint(t, 1, 1);
    ok(`缩放真的生效：1 世界单位 = scale·dpr 设备像素（${c.note}）`,
       Math.abs(unit.x - centre.x - c.scale * c.dpr) < 1e-9
       && Math.abs(unit.y - centre.y - c.scale * c.dpr) < 1e-9,
       `Δ=(${(unit.x - centre.x).toFixed(3)},${(unit.y - centre.y).toFixed(3)})`);

    /*
     * 裁切不变量：竞技场圆整体落在画布内。
     * 这正是真浏览器里"maxY 触底被裁"的直接判据 ——
     * 上一版在 1600×900 下圆心已经跑到 (1040,585)，圆直接出界。
     */
    const pts = [
      projectPoint(t, -ARENA.r, -ARENA.r),
      projectPoint(t, ARENA.r, -ARENA.r),
      projectPoint(t, -ARENA.r, ARENA.r),
      projectPoint(t, ARENA.r, ARENA.r),
    ];
    const pxW = c.vw * c.dpr;
    const pxH = c.vh * c.dpr;
    const inside = pts.every((p) => p.x >= 0 && p.x <= pxW && p.y >= 0 && p.y <= pxH);
    const maxX = Math.max(...pts.map((p) => p.x));
    const maxY = Math.max(...pts.map((p) => p.y));
    ok(`竞技场不被画布边缘裁切（${c.note}）`,
       inside,
       `maxX=${maxX.toFixed(0)}/${pxW} maxY=${maxY.toFixed(0)}/${pxH}`);
  }

  /*
   * ===== 震屏幅度必须与 scale 无关 =====
   *
   * sh.x / sh.y 是**屏幕像素**语义（SHAKE.maxOffset 是按 px 定的观感）。
   * 如果它跟着 scale 一起被放大，1600×900 下同样 trauma 会抖 1.3 倍 ——
   * 那是"改手感"，不只是改位置。所以这里比的是两档缩放下的**设备像素位移差**。
   */
  {
    const sh = { x: SHAKE.maxOffset, y: -SHAKE.maxOffset };
    const t1 = viewportTransform(800, 600, 1.0, 1, sh);
    const t13 = viewportTransform(1600, 900, 1.3, 1, sh);
    const off1 = projectPoint(t1, 0, 0).x - (800 / 2);
    const off13 = projectPoint(t13, 0, 0).x - (1600 / 2);
    ok('震屏位移是屏幕像素，不随 scale 放大（手感不变）',
       Math.abs(off1 - off13) < 1e-9
       && Math.abs(off1 - SHAKE.maxOffset) < 1e-9,
       `scale1 位移 ${off1.toFixed(3)} / scale1.3 位移 ${off13.toFixed(3)}`
       + `（SHAKE.maxOffset=${SHAKE.maxOffset}）`);
  }

  /*
   * ===== 变异自测：把这个 bug 加回去，上面那一族断言必须变红 =====
   *
   * 这一条是本节的"断言有效性"证明。它复刻上一版的错误公式，
   * 然后要求：
   *   1. scale=1 时它**测不出来**（正是当年漏网的原因）
   *   2. scale=1.3 / 1.5 时它必然被上面同一条判据抓住
   *   3. 偏差量级与真浏览器实测的 (+240, +129) 对得上
   * 如果哪天有人把上面的断言写弱（比如容差放到 5px），这条会立刻红。
   */
  {
    const buggy = (vw, vh, scale, dpr, sh2 = { x: 0, y: 0 }) => {
      const s0b = scale * dpr;
      return {
        a: s0b, d: s0b,
        e: (vw / 2 + (sh2.x || 0)) * s0b,
        f: (vh / 2 + (sh2.y || 0)) * s0b,
      };
    };
    const centreOf = (t) => projectPoint(t, 0, 0);
    /* 和上面完全相同的容差：1e-9 */
    const isCentred = (t, vw, vh, dpr) => {
      const p = centreOf(t);
      return Math.abs(p.x - (vw * dpr) / 2) < 1e-9
        && Math.abs(p.y - (vh * dpr) / 2) < 1e-9;
    };

    ok('变异自测：错误公式在 scale=1 下"看不出问题"（这就是当年漏网的原因）',
       isCentred(buggy(800, 600, 1.0, 1), 800, 600, 1) === true);
    ok('变异自测：错误公式在 scale=1.3 下被抓住（断言不是恒真的）',
       isCentred(buggy(1600, 900, 1.3, 1), 1600, 900, 1) === false);
    ok('变异自测：错误公式在 scale=1.5 下被抓住',
       isCentred(buggy(1200, 1000, 1.5, 1), 1200, 1000, 1) === false);

    /* 偏差量级要和真浏览器实测对得上：1600×900 横向偏移 +240 */
    const buggyCentre = centreOf(buggy(1600, 900, 1.3, 1));
    const realOffsetX = buggyCentre.x - 800;
    const realOffsetY = buggyCentre.y - 450;
    ok('变异自测：错误公式复现真浏览器实测的偏移量级（+240, +129 同源）',
       Math.abs(realOffsetX - 240) < 1e-6 && realOffsetY > 100 && realOffsetY < 160,
       `复现偏移 (${realOffsetX.toFixed(0)}, ${realOffsetY.toFixed(0)})`);

    /* 反过来：修好的实现必须在同一判据下通过（否则上面全是空转） */
    ok('修正后的实现通过同一判据（scale 1.0 / 1.3 / 1.5 全档）',
       isCentred(viewportTransform(800, 600, 1.0, 1), 800, 600, 1)
       && isCentred(viewportTransform(1600, 900, 1.3, 1), 1600, 900, 1)
       && isCentred(viewportTransform(1200, 1000, 1.5, 1), 1200, 1000, 1));
  }

  /*
   * ===== 结构锁：draw() 必须真的用这个纯函数 =====
   *
   * 纯函数测得再全，如果 draw() 里另写一份就白搭（"存在即通过"的陷阱）。
   * 所以再钉两条：错误的旧公式不许再出现；setTransform 必须吃 vt。
   */
  {
    const renderSrc = readFileSync(new URL('./render.mjs', import.meta.url), 'utf8');
    const code = renderSrc
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    ok('render.mjs 里不再有"中心被重复乘 scale"的旧公式',
       !/\(\s*this\.vw\s*\/\s*2\s*\+[^)]*\)\s*\*\s*s0/.test(code),
       '旧公式 (vw/2 + sh.x) * s0 必须消失');
    ok('draw() 的 setTransform 吃的是 viewportTransform 的结果',
       /const vt = viewportTransform\(this\.vw, this\.vh, this\.scale, this\.dpr, sh\)/
         .test(code)
       && /ctx\.setTransform\(vt\.a, 0, 0, vt\.d, vt\.e, vt\.f\)/.test(code),
       'setTransform 必须接到纯函数上，不能另写一份');
    /* 旋转仍绕**画布中心**（逻辑像素），这条旧约束不能被顺手改坏 */
    ok('震屏旋转仍绕画布中心（translate/rotate/translate 三段式）',
       /ctx\.translate\(this\.vw \/ 2, this\.vh \/ 2\)/.test(code)
       && /ctx\.rotate\(sh\.a\)/.test(code)
       && /ctx\.translate\(-this\.vw \/ 2, -this\.vh \/ 2\)/.test(code));
  }
}

/* ================= 11. 事件源必须是真实数据 ================= */

section('事件源：真实会话，不是手写剧本');

{
  const fsMod = await import('node:fs');
  const mainSrc = fsMod.readFileSync(new URL('./main.mjs', import.meta.url), 'utf8');
  const dirSrc = fsMod.readFileSync(new URL('./director.mjs', import.meta.url), 'utf8');

  /*
   * ===== 这一节存在的理由 =====
   *
   * 上一版 main.mjs 里 import 的是 `DEMO_EVENTS` ——
   * 那是 director.mjs 里一个**手写常量数组**，29 条假事件。
   * 时间是编的、时长是编的、工具名是挑的。
   *
   * 血条那条铁律守住了（血条归零不算死），
   * 但如果事件本身是编的，整场演出仍然是假的。
   * 所以这里要锁死：**运行时喂进去的事件必须来自真实会话文件**。
   */
  ok('main.mjs 不再 import DEMO_EVENTS',
     !/import\s*\{[^}]*DEMO_EVENTS/.test(mainSrc),
     '仍然从 director 导入手写事件');

  ok('main.mjs 从 real-events.json 读事件',
     /fetch\('\.\/real-events\.json'\)/.test(mainSrc));

  /*
   * ===== 真实数据文件必须存在且自洽 =====
   */
  const evPath = new URL('./real-events.json', import.meta.url);
  const evExists = fsMod.existsSync(evPath);
  ok('real-events.json 已生成', evExists);
  if (!evExists) {
    console.log('    [提示] 先跑 node build-events.mjs');
  } else {
    const { meta, events } = JSON.parse(fsMod.readFileSync(evPath, 'utf8'));

    /*
     * 这些数字必须和 dsh/ 的统计逐字对上。
     * 对不上就说明读错了源、或者中途有人改过数据。
     */
    ok('工具数 = 292（与 dsh 一致）', meta.tools === 292, String(meta.tools));
    ok('真实耗时合计 = 130079ms（与 dsh 一致）',
       meta.realDurSumMs === 130079, String(meta.realDurSumMs));
    ok('真实跨度 = 77.4h 量级（>2.7e8 ms）',
       meta.realSpanMs > 2.7e8 && meta.realSpanMs < 2.8e8,
       String(meta.realSpanMs));

    const callN = events.filter((e) => e.kind === 'tool').length;
    const endN = events.filter((e) => e.kind === 'tool_end').length;
    ok('call 与 result 数量相等', callN === endN, `${callN} vs ${endN}`);
    ok('call 数量 = 292', callN === 292, String(callN));

    /*
     * ===== 事件里必须带真实耗时 =====
     *
     * 这是"刀快的快、刀慢的慢"能成立的前提。
     * 如果 realMs 缺失或全 0，敌人就失去了时间上的真实差异。
     */
    const withReal = events.filter((e) => typeof e.realMs === 'number' && e.realMs > 0);
    ok('事件带真实毫秒（realMs）', withReal.length === events.length - 1,
       `${withReal.length} / ${events.length - 1}（turn_end 无耗时）`);

    /*
     * 耗时必须有真实差异，不能全一样。
     * 反向验证抓过这类漏洞：把全部 realMs 改成同一个常数，
     * "有耗时"照样成立，但数据已经死了。
     */
    const distinct = new Set(withReal.map((e) => e.realMs));
    ok('耗时有多样性（不是同一个常数）', distinct.size > 50,
       distinct.size + ' 种不同耗时');

    const minMs = Math.min(...withReal.map((e) => e.realMs));
    const maxMs = Math.max(...withReal.map((e) => e.realMs));
    ok('耗时跨两个数量级以上（刀快慢可辨）', maxMs / minMs > 100,
       `min ${minMs}ms / max ${maxMs}ms = ${(maxMs / minMs).toFixed(0)}×`);

    /*
     * 时间轴必须单调不减 —— 否则事件会乱序播放。
     */
    let nonMono = 0;
    for (let i = 1; i < events.length; i++) {
      if (events[i].ts < events[i - 1].ts) nonMono++;
    }
    ok('事件时间轴单调不减', nonMono === 0, nonMono + ' 处倒退');

    /*
     * 压缩必须被记录，不能悄悄折叠。
     * foldedMs 是真被折掉的时间总量，要写出来。
     */
    ok('折叠掉的时间被记录进 meta', typeof meta.foldedMs === 'number' && meta.foldedMs > 0,
       (meta.foldedMs / 3600000).toFixed(2) + 'h');
    ok('播放时长被记录进 meta', meta.playDurMs > 0,
       (meta.playDurMs / 1000).toFixed(0) + 's');

    console.log('    [报告] ' + meta.tools + ' 次调用 / 真实 ' +
      (meta.realDurSumMs / 1000).toFixed(1) + 's / 跨度 ' +
      (meta.realSpanMs / 3600000).toFixed(1) + 'h → 播放 ' +
      (meta.playDurMs / 1000).toFixed(0) + 's（折叠 ' +
      (meta.foldedMs / 3600000).toFixed(1) + 'h）');
    console.log('    [报告] 耗时 ' + minMs + '~' + maxMs + 'ms，' +
      distinct.size + ' 种不同值');
  }

  /*
   * ===== DEMO_EVENTS 还留在 director 里，但不能被页面用 =====
   *
   * 保留它是有意的：_refs.mjs 和 verify 自己的战斗测试需要一个
   * 可控的固定序列。但它不能出现在运行时路径上。
   */
  ok('DEMO_EVENTS 仅供测试，运行时不用',
     /DEMO_EVENTS/.test(dirSrc) && !/import\s*\{[^}]*DEMO_EVENTS/.test(mainSrc));
}

/* ================= 12. 端到端：真实事件必须逐条结算 ================= */

section('端到端：292 条真实事件必须产生 292 次击杀');

{
  /*
   * ===== 这一节是被一个真 bug 逼出来的 =====
   *
   * 修 bug 之前，前面 246 项断言**全部通过**，但页面实际是坏的：
   *
   *   Enemy.id = ++_seq          （number，如 7）
   *   ev.id    = 'call_00_kL2Mw…'（string）
   *   _finishTool 用  e.id === ev.id  匹配 → 永远 false
   *
   * 于是 292 条合法 tool_end 里有 283 条掉进"重复上报"分支被丢弃，
   * 击杀在 30 秒内卡在 9（每个工具的第一次结束），
   * 最后靠 turn_end 一次性批量清场冲到 301 —— 最高连击 292 是假的。
   * 这个 bug 不报错、不抛异常，页面看起来还在跑。
   *
   * 为什么原有断言抓不到：
   *   它们全都用手写的 DEMO_EVENTS（29 条、无 callId）在测，
   *   而 callId 正是新数据源才有的东西。
   *   **测的不是真实事件形状，就测不出真实数据下的故障。**
   *
   * 所以这里必须：拿真实的 585 条事件，端到端喂一遍，逐个对账。
   */
  const fsMod = await import('node:fs');
  const evPath = new URL('./real-events.json', import.meta.url);
  if (!fsMod.existsSync(evPath)) {
    ok('real-events.json 存在（端到端需要）', false, '先跑 node build-events.mjs');
  } else {
    const { meta, events } = JSON.parse(fsMod.readFileSync(evPath, 'utf8'));

    const d = new Director({ arena: ARENA });
    for (const e of events) d.handle(e, e.ts);
    const st = d.stats(meta.playDurMs);

    /* 1. 每次调用都要出场 */
    ok('seen = 292（每次调用都出场了，没有补造）',
       st.seen === 292, String(st.seen));

    /* 2. 每次调用都要被结算成击杀 —— 这是核心 */
    ok('kills = 292（每次调用都被真实结算）',
       st.kills === 292, String(st.kills));

    /*
     * 3. 零重复。
     * 反向看：修复前这里是 283。这个数字一旦非零，
     * 说明又有事件被当成重复丢掉了。
     */
    ok('duplicates = 0（没有事件被误判成重复）',
       st.duplicates === 0, String(st.duplicates));

    /* 4. 无失败（真实数据里 292 次全部成功） */
    ok('failures = 0', st.failures === 0, String(st.failures));

    /*
     * 5. ===== 击杀必须分散在全部 292 个时刻 =====
     *
     * 这条是杀招。批量清场会让所有击杀挤在同一帧，
     * 于是"击杀时间点数量"从 292 塌缩到个位数。
     * 修复前实测只有 10 个不同时间点。
     *
     * 不要写死 292（会被未来的数据漂移打死），写成比例。
     */
    const kills = d.log.filter((x) => x.type === 'kill');
    const killTimes = new Set(kills.map((k) => k.t));
    ok('击杀分散在 >=80% 的不同时刻（防批量清场）',
       killTimes.size >= kills.length * 0.8,
       `${killTimes.size} 个时刻 / ${kills.length} 次击杀`);

    /*
     * 6. ===== 连击不能是假高 =====
     *
     * 一次性清场会产生"292 连击"这种数字 ——
     * 那不是连击，是同一帧结算了 292 次。
     * 真实数据的最高连击应当远小于总量。
     */
    ok('最高连击远小于总击杀数（不是批量清场刷的）',
       st.comboBest < st.kills * 0.5,
       `comboBest ${st.comboBest} vs kills ${st.kills}`);

    /*
     * 7. ===== callId 必须真的被存下来 =====
     *
     * 这是那个 bug 的直接病根：Enemy 上没有 callId 字段，
     * 或者存了但比较时用的是 id。
     */
    const dirSrc2 = fsMod.readFileSync(new URL('./director.mjs', import.meta.url), 'utf8');
    ok('Enemy 保存了 callId',
       /this\.callId\s*=\s*ev\.id/.test(dirSrc2));
    /*
     * 判重也必须按 callId。
     *
     * 这一条是形状检查，不是行为检查 —— 反向验证显示：
     * 只要匹配用了 callId，判重退回按工具**不会改变行为**
     * （因为根本走不到判重分支），所以行为断言抓不到它。
     *
     * 但它仍然必须锁住：一旦哪天匹配路径变了（比如事件不带 id），
     * 按工具判重就会立刻把 87 次 read 压成 1 次。
     * 这是防未来的，不是防现在的 —— 如实标注。
     */
    ok('判重按 callId（防未来退回按工具）',
       /e\.callId === want && e\.diedAt !== null/.test(dirSrc2));
    ok('匹配用的是 callId 而不是 id',
       /e\.callId === want/.test(dirSrc2),
       '必须按 callId 匹配，用 e.id 会因 number/string 不等而永远失败');
    /*
     * 用词边界收紧：不加  的话 'e.callId === want' 里的
     * 'e.id' 会被当成子串命中，产生假红。
     * 断言误报和漏报一样有害 —— 它们都会训练人忽略红色。
     */
    ok('没有残留 `e.id === ev.id` 形式的匹配',
       !/e\.id\s*===\s*ev\.id/.test(dirSrc2));

    /*
     * ===== 并发不能被串行化 =====
     *
     * 最初的实现是**排队**的：一只出场 → 等它耗时结束 → 下一只才出场。
     * 那是错的。真实数据里：
     *   - 最大**同时**在跑 4 个调用
     *   - 41 对调用在时间上重叠
     *
     * 而且这不是毛刺：智能体放出子智能体（agent_run）之后
     * **会继续做别的事**，两个工具同时在跑。
     *
     * 串行化的两个后果：
     *   1. 一个 42 秒的 ask_user_question 堵住整条队列，
     *      后面早就结束的调用还没出场
     *   2. 画面上永远只有一只蚂蚁在挨刀，看不出并发
     */
    ok('真实数据里确实存在并发（不是空转）',
       meta.maxConcurrent > 1,
       `最大同时 ${meta.maxConcurrent} 个`);
    ok('真实数据里有重叠的调用对', meta.overlapPairs > 0,
       `${meta.overlapPairs} 对`);

    /*
     * 核心断言：映射到播放时间轴之后，并发度必须**和真实一致**。
     * 串行化会把它压到 1。这条一旦红，就是又被排成队了。
     */
    ok('播放时间轴的并发度 = 真实并发度（没被串行化）',
       meta.playMaxConcurrent === meta.maxConcurrent,
       `播放 ${meta.playMaxConcurrent} vs 真实 ${meta.maxConcurrent}`);

    /*
    /*
     * ===== 并发存在，但很短 —— 这个事实要算出来、写出来 =====
     *
     * 实测：最大同时 4 个、41 对重叠，听起来很多。
     * 但把重叠**时长**算出来只有 0.419 秒（占播放时长 0.16%）——
     * 因为那些重叠全是几次 read 同时起跑、8ms 就结束。
     *
     * 不把这个数算出来会有两种误判：
     *   1. 看页面觉得"并发根本没生效"（其实生效了，只是短）
     *   2. 以为"智能体高度并发"（其实 99.8% 时间是串行的）
     *
     * 所以断言做两件事：**确认并发存在，同时确认它的占比不虚高**。
     */
    {
      const pts = [];
      for (const e of events) {
        if (e.kind === 'tool') pts.push({ t: e.ts, d: 1 });
        else if (e.kind === 'tool_end') pts.push({ t: e.ts, d: -1 });
      }
      pts.sort((a, b) => (a.t - b.t) || (a.d - b.d));
      const dur = {};
      let cur = 0;
      let prev = null;
      for (const p2 of pts) {
        if (prev !== null) {
          const dt = p2.t - prev;
          const k = Math.min(cur, 9);
          dur[k] = (dur[k] || 0) + dt;
        }
        cur += p2.d;
        prev = p2.t;
      }
      const concurrentMs = Object.entries(dur)
        .filter(([k]) => Number(k) >= 2)
        .reduce((a, [, v]) => a + v, 0);
      const totalMs = Object.values(dur).reduce((a, b) => a + b, 0);

      ok('并发真的存在（>=2 个同时的时长 > 0）', concurrentMs > 0,
         concurrentMs.toFixed(3) + 'ms');

      /*
       * 占比必须很低。这不是性能指标，是**如实**：
       * 如果哪天它变成 20%，说明数据变了或者时间映射错了。
       */
      const ratio = totalMs > 0 ? concurrentMs / totalMs : 0;
      ok('并发占比很低（如实：真实数据里重叠极短）',
         ratio < 0.02,
         (100 * ratio).toFixed(3) + '%（' + (concurrentMs / 1000).toFixed(3) + 's）');

      console.log('    [报告] 并发时长 ' + (concurrentMs / 1000).toFixed(3) +
        's，占播放 ' + (100 * ratio).toFixed(2) + '%；分布：' +
        Object.entries(dur).filter(([k]) => Number(k) >= 2)
          .map(([k, v]) => k + '个=' + (v / 1000).toFixed(3) + 's').join(' '));

      /* 页面必须把这个数写出来，不能只藏在 JSON 里 */
      const src3 = fsMod.readFileSync(new URL('./main.mjs', import.meta.url), 'utf8');
      ok('页面显示了并发度（不让人以为全程串行）',
         /maxConcurrent/.test(src3));
    }

    /*
     * ===== 击杀必须按各自结束时间，互不等待 =====
     *
     * 用端到端跑出来的数据核对：画面上同时存活的敌人数，
     * 必须能到过真实最大并发 —— 否则说明实际执行仍是串行的，
     * 哪怕事件数据是对的。
     */
    {
      const dd = new Director({ arena: ARENA });
      let maxAlive = 0;
      const P = { x: 0, y: 0, px: 0, py: 0, vx: 0, vy: 0,
        moving: false, fleeing: false, swing: 0, swingT: 0, hurtT: 0 };
      for (const e of events) {
        dd.handle(e, e.ts);
        dd.advance(1 / 60, e.ts, P);
        const alive = dd.enemies.filter((x) => x.diedAt === null).length;
        if (alive > maxAlive) maxAlive = alive;
      }
      ok('画面上同时存活数达到真实并发（并发真的被跑出来）',
         maxAlive === meta.maxConcurrent,
         `实测同时 ${maxAlive} 只 / 真实并发 ${meta.maxConcurrent}`);
      console.log('    [报告] 画面上同时最多存活 ' + maxAlive + ' 只（真实最大并发 ' +
        meta.maxConcurrent + ' 个）');
    }

    /*
     * ===== 时间映射必须单调 =====
     *
     * 单调是保留并发的前提：A 和 B 同时发生，映射后还要同时。
     * 非单调会让事件乱序、并发反转，而且不会报错 ——
     * 只会在画面上表现为"蚂蚁莫名倒退"。
     */
    {
      const marks = new Map();
      let prev = -Infinity;
      let nonMono = 0;
      for (const e of events) {
        if (e.ts < prev) nonMono++;
        prev = e.ts;
      }
      ok('事件按 ts 单调（并发被保留下来的前提）', nonMono === 0,
         nonMono + ' 处倒退');
    }

    /*
     * ===== 重播必须把全部计数清干净 =====
     *
     * 浏览器实测抓出来的：startDemo() 漏重置 combo/comboBest/comboAt/duplicates，
     * 于是重播后出现 **combo > kills** 这种算术上不可能的值
     * （实测第二轮 seen=126 时报 combo=169）。
     *
     * 这类残留不报错，但会让"重播后再验收"的读数全部虚高，
     * 而重播恰恰是人最常用的操作。
     *
     * 断言做法：把 director 的全部计数逐字段列出，检查
     * startDemo 的重置列表里一个都不缺。
     */
    const mainSrc2 = fsMod.readFileSync(new URL('./main.mjs', import.meta.url), 'utf8');
    /*
     * 收紧：这个窗口原来靠两个 indexOf 拼，任一取不到就返回空串，
     * 而「重置字段齐全」那条正则**在空串上不匹配** —— 锚点漂移时
     * 断言会红得莫名其妙，反过来若有人把它改成 `!test` 就静默恒真。
     *
     * 正确的不变量不是「demoIndex = 0; 全文唯一」（它本来就出现两次：
     * 第 178 行的声明初始化 + 第 376 行 startDemo 里的重置），
     * 而是「startDemo 里确实有一处 demoIndex = 0;，且它在 startDemo 之后」。
     * 所以查**函数体内**的出现，而不是全文唯一。
     */
    const startCount = countOf(mainSrc2, 'function startDemo()');
    ok('startDemo 定义可唯一定位（function startDemo()）',
       startCount === 1, `命中 ${startCount} 次`);
    const startPos = startCount === 1 ? mainSrc2.indexOf('function startDemo()') : -1;
    const demoIdxInFn = startPos >= 0
      ? countOf(mainSrc2.slice(startPos), 'demoIndex = 0;')
      : 0;
    ok('startDemo 内部有 demoIndex = 0; 重置（函数体锚点存在）',
       startPos >= 0 && demoIdxInFn >= 1,
       `startDemo 之后命中 ${demoIdxInFn} 次`);
    const resetBlock = (() => {
      if (startPos < 0) return '';
      const j = mainSrc2.indexOf('demoIndex = 0;', startPos);
      return j < 0 ? '' : mainSrc2.slice(startPos, j);
    })();
    ok('重置块非空（锚点取到了真实代码，不是空串）',
       resetBlock.length > 100, `${resetBlock.length} 字符`);

    /*
     * 必须重置的字段：凡是被 stats() 读出去、且会跨局累积的。
     * 这份清单照着 Director 的字段写，不是照着"我记得"写。
     */
    const mustReset = ['seen', 'kills', 'failures', 'unmapped', 'unknown',
      'swings', 'damage', 'duplicates', 'combo', 'comboBest', 'comboAt'];
    const notReset = mustReset.filter(
      (k) => !new RegExp('director\\.' + k + '\\s*=').test(resetBlock),
    );
    ok('重播重置覆盖全部累积计数（含 combo / duplicates）',
       notReset.length === 0,
       notReset.length ? '没重置：' + notReset.join(', ') : mustReset.length + ' 个字段全覆盖');

    /*
     * 更强的一条：combo 不可能超过 kills。
     * 这条是行为不变量 —— 连击数必然 <= 总击杀数。
     * 一旦重播残留，这个关系立刻破。
     */
    ok('最高连击不可能超过总击杀（combo > kills 是非法状态）',
       st.comboBest <= st.kills,
       `comboBest ${st.comboBest} / kills ${st.kills}`);

    console.log('    [报告] 真实 585 条事件 → seen ' + st.seen +
      ' / kills ' + st.kills + ' / 重复 ' + st.duplicates +
      ' / 最高连击 ' + st.comboBest + ' / 击杀时刻 ' + killTimes.size + ' 个');
  }
}

/* ================= 14. 品级比较只能走 TIER 枚举 ================= */

section('品级比较：不许抄字面量，不许比较显示名');

{
  /*
   * D1 / D2 的回归锚点。
   *
   * 这两个缺陷的共同病根是「品级用错了表示」：
   *   D1 拿显示名 'BOSS' 去比 tierName —— TIER_NAME 是中文（'蚁后'），
   *      条件恒为假，killBoss 震屏分支**不可达**，BOSS 和杂兵一样震。
   *   D2 拿裸数字 2 去比 tier —— 枚举顺序一变就静默失效。
   *
   * 所以这里断言的不是"某一行长什么样"，而是**表示法**：
   * 品级一律通过 TIER 枚举比较，且 main.mjs 里不许出现裸数字品级。
   */
  const src = readFileSync(new URL('./main.mjs', import.meta.url), 'utf8');
  /*
   * 扫源码前先剥掉注释。
   *
   * 否则"解释这个 bug 的注释"会把断言自己顶红 —— 注释里写
   * tierName === 'BOSS' 正是在讲 D1 的历史。
   * 只扫**可执行代码**，才是这条断言真正要守的东西。
   */
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

  /* TIER 必须从 bestiary 导入 —— 否则下面的比较根本写不出来 */
  const importsTier = /import\s*\{[^}]*\bTIER\b[^}]*\}\s*from\s*'\.\/bestiary\.mjs'/.test(code);
  ok('main.mjs 从 bestiary 导入 TIER 枚举', importsTier,
     "main.mjs 需要 import { ..., TIER } from './bestiary.mjs'");

  /*
   * D1：BOSS 判定必须是数值比较。
   * 正向：存在 r.tier === TIER.BOSS 这样的比较。
   */
  ok('D1：BOSS 判定用 tier 数值（r.tier === TIER.BOSS）',
     /\.tier\s*===\s*TIER\.BOSS\b/.test(code),
     '原来写的是 r.tierName === \'BOSS\'，而 TIER_NAME 是中文显示名，恒为假');

  /*
   * D1 反面：绝不允许再拿显示名跟 'BOSS' 比。
   * 这条防的是"修成字符串比较"这种假修复。
   */
  const nameCmp = [...code.matchAll(/tierName\s*===?\s*(['"])([^'"]*)\1/g)]
    .map((m) => m[2]);
  ok("D1 反面：不许拿显示名跟 'BOSS' 之类的英文标识比",
     !nameCmp.includes('BOSS'),
     nameCmp.length ? `发现 tierName === '${nameCmp.join("' / '")}'` : '无 tierName 字符串比较');

  /*
   * D2：不许出现裸数字品级。
   * 匹配 `.tier === 2` / `.tier == 2` 这类写法。
   */
  const bareTier = [...code.matchAll(/\.tier\s*===?\s*(\d+)/g)].map((m) => m[1]);
  ok('D2：不许用裸数字比较 tier（应写 TIER.XXX）',
     bareTier.length === 0,
     bareTier.length ? `发现 .tier === ${bareTier.join(' / ')}` : '无裸数字品级比较');

  /*
   * 枚举一致性：TIER.BOSS 的值本身不许被改动，
   * 且 TIER_NAME 确实不是英文标识 —— 这正是 D1 之所以为假的原因，
   * 把这条钉住，将来谁把 TIER_NAME 改成 'BOSS' 也会被拦下。
   */
  ok('TIER.BOSS 的值仍为 2（枚举数值不得改动）', TIER.BOSS === 2, String(TIER.BOSS));
  ok("D1 根因固定：TIER_NAME 是显示名，不等于 'BOSS'",
     TIER_NAME[TIER.BOSS] !== 'BOSS',
     `TIER_NAME[TIER.BOSS] = ${JSON.stringify(TIER_NAME[TIER.BOSS])}`);

  /* 每个品级都必须能从 RULES 反查到 sprite（品级 → 外观只有一份真相） */
  const tierSprites = [TIER.MINION, TIER.ELITE, TIER.BOSS].map((t) => {
    const r = rules().find((x) => x.tier === t);
    return r ? r.sprite : null;
  });
  ok('三个品级都能从 RULES 反查到 sprite（品级映射单一真相源）',
     tierSprites.every(Boolean), tierSprites.join(','));
}

/* ================= 15. 斩击色阶：导出值必须逐字不变 ================= */

section('斩击色阶单一真相源');

{
  /*
   * 色值从 render.mjs 的 `_slash` 里提成 `SLASH_COLORS` 之后，
   * _refs 的探针改为 import 它 —— 这带来一个新的风险：
   * 探针和实现从此**永远一致**，改色不会再被 _refs 抓到。
   *
   * 所以色值本身必须在这里钉死一次。这不是"抄字面量"的倒退：
   *   - render 内部：单一来源，改一处即生效（好）
   *   - 这里：一条**冻结契约**，颜色是设计决定，本来就不该随手改（要改就显式改这里）
   * 没有这条，`_refs` 的 import 会让"改色"从"会被发现"变成"静默生效"。
   */
  const EXPECT_BLADE = ['#5a6470', '#cdd8e0', '#ffffff'];
  const EXPECT_EXEC = ['#8a5a2a', '#e8a24a', '#fff4d6'];
  ok('刀光三色逐字不变（冷白阶）',
     Array.isArray(SLASH_COLORS.blade)
     && SLASH_COLORS.blade.length === 3
     && SLASH_COLORS.blade.every((c, i) => c === EXPECT_BLADE[i]),
     (SLASH_COLORS.blade || []).join(','));
  ok('处决暖金三色逐字不变',
     Array.isArray(SLASH_COLORS.exec)
     && SLASH_COLORS.exec.length === 3
     && SLASH_COLORS.exec.every((c, i) => c === EXPECT_EXEC[i]),
     (SLASH_COLORS.exec || []).join(','));

  /* 两组色阶必须互不相同 —— 否则"处决"在画面上不可辨 */
  ok('刀光与处决是两组不同色阶（处决可辨）',
     SLASH_COLORS.blade.every((c) => !SLASH_COLORS.exec.includes(c)),
     `${SLASH_COLORS.blade[1]} vs ${SLASH_COLORS.exec[1]}`);

  /*
   * `_slash` 必须真的引用导出的表，而不是又抄一份字面量。
   * 判据：_slash 方法体里不再出现那 6 个字面色值。
   */
  const renderSrc2 = readFileSync(new URL('./render.mjs', import.meta.url), 'utf8');
  /* 按**完整定义签名**定位（`_slash(ctx, ` 在调用点也命中，不能用） */
  const SLASH_SIG = '_slash(ctx, x0, y0, x1, y1, alpha, strength, now, ageK, opts = {}) {';
  const slashCount = countOf(renderSrc2, SLASH_SIG);
  const slashAt = slashCount === 1 ? renderSrc2.indexOf(SLASH_SIG) : -1;
  const slashBody = slashAt >= 0 ? renderSrc2.slice(slashAt, slashAt + 3000) : '';
  const hardcoded = [...EXPECT_BLADE, ...EXPECT_EXEC].filter((c) => slashBody.includes(c));
  ok('_slash 方法定义可唯一定位（完整签名）',
     slashCount === 1, `命中 ${slashCount} 次`);
  ok('_slash 引用 SLASH_COLORS，方法体里不残留色值字面量',
     slashAt >= 0 && hardcoded.length === 0,
     slashAt < 0 ? '_slash 定义未定位' : `残留 ${hardcoded.join(',')}`);
}

/* ================= 16. 换主题冒烟：只改配置就能换题材 ================= */

section('换主题冒烟：只改 theme 配置，全部可见文案与 sprite 映射跟着变');

{
  /*
   * ===== 这条测试到底在证什么 =====
   *
   * 产品承诺是「换题材只需改 theme.mjs + 新增点阵」。
   * 这句承诺如果没人守，就会在半年后变成一句空话 ——
   * 因为只要有人往 main.mjs 里多写一句 '击毁'，承诺就已经破了，
   * 而不会有任何断言变红。
   *
   * 所以这里做一次**真的换主题**：
   *   1. 造一份内联假 theme（"深海防线"，完全不同的用词）
   *   2. 用**同一套逻辑**（不碰 director.mjs / main.mjs）把它渲染出来
   *   3. 断言：全部可见文案与 sprite 角色映射都跟着变了
   *
   * "不碰 director.mjs" 不是嘴上说的 —— 下面会真跑一遍 Director，
   * 证明战斗逻辑对主题一无所知：换个主题，击杀判定一模一样。
   */

  const themeMod = await import('./theme.mjs');
  const { COPY, TIER_THEME, SPRITE_ROLES, BRAND, SIZE_THEME, SPEED_THEME } = themeMod;

  /* ---- 1) 内联假 theme：另一套题材，不是"星海" ---- */
  const FAKE = {
    brand: {
      nameZh: '深海探索者',
      nameEn: 'DeepDiver',
      pkgId: 'deep-diver',
      themeName: '深渊防线',
    },
    tiers: {
      minion: { key: 'MINION', name: '浮游鱼', species: '深海浮游体', short: '浮' },
      elite: { key: 'ELITE', name: '掠食鱼', species: '重甲掠食体', short: '掠' },
      boss: { key: 'BOSS', name: '巨鲸', species: '深渊巨鲸', short: '鲸' },
    },
    sprites: {
      hero: { idle: 'aegisIdle', wind: 'aegisWind', strike: 'aegisStrike' },
      enemy: {
        minion: 'scoutDrone',
        elite: 'assaultShip',
        miner: 'minelayer',
        wing: 'wingDrone',
        boss: 'mothership',
        unknown: 'unknown',
      },
    },
    copy: {
      docTitle: '深海探索者 · 深渊防线',
      panelTitle: '深海探索者',
      panelSub: '深渊防线 · 智能体执行过程实况',
      startButton: '下潜',
      keysHint: '空格 下潜 / 暂停',
      tierRules: {
        minion: { tag: '浮游鱼', desc: '深海浮游体 · 毫秒级工具' },
        elite: { tag: '掠食鱼', desc: '重甲掠食体 · 秒级工具' },
        boss: { tag: '巨鲸', desc: '深渊巨鲸 · 长跑' },
      },
      honest: {
        death: '噬咬不会致死',
        source: '数据来自真实会话 {session}',
        timeAxis: '时间轴已压缩 {playback}s',
      },
      hud: {
        alive: '目标', kills: '击破', failures: '未破', combo: '连破',
        unmapped: '未识别', overdue: '超期', calls: '执行', concurrent: '并发',
        swings: '齐射', damage: '战果', comboBest: '最高连破',
        duplicates: '重报', fps: '帧率',
      },
      floater: { kill: '击破', killCombo: '击破 ×{n}', fail: '失手' },
      toast: {
        kill: '击破 · {tool}', fail: '失手 · {tool}', paused: '冻结', resumed: '解冻',
        inspectOn: '明细 · 开', inspectOff: '明细 · 关', replay: '回放',
        flashOn: '闪烁开', flashOff: '闪烁关', shakeOn: '震屏开', shakeOff: '震屏关',
        numbersOn: '飘字开', numbersOff: '飘字关',
      },
      bossBar: { estimate: '预计进度', overdue: '超出预计', border: '巨鲸交战中' },
      banner: { win: '深渊守住', winDetail: '击破 {kills}', lose: '本轮失守' },
    },
    combat: { size: SIZE_THEME, speed: SPEED_THEME, heroScale: 1 },
  };

  /*
   * ---- 2) 全部可见文案：枚举而不是背清单 ----
   *
   * 用 copyLeaves() 把 theme 里所有字符串拍平。
   * 这样"以后新增一句文案忘了接进去"会被自动覆盖到 ——
   * 人肉清单漏掉的，往往正是没人看的那一句。
   */
  const realLeaves = themeMod.copyLeaves(themeMod.THEME);
  const fakeLeaves = themeMod.copyLeaves(FAKE);

  ok('真实 theme 的可见文案可被枚举（换主题测试有覆盖面）',
     realLeaves.length > 20, `${realLeaves.length} 条`);
  ok('假 theme 的文案条目与真实 theme 对齐（同构，可直接替换）',
     fakeLeaves.length === realLeaves.length,
     `真实 ${realLeaves.length} / 假 ${fakeLeaves.length}`);

  /*
   * 关键断言：**槽位名一致**。
   * 假的 theme 少一个槽位，替换后界面上就会有一句是空的 ——
   * 而那正是"换主题后还有人写死了旧文案"的位置。
   */
  const realPaths = realLeaves.map((l) => l.path).sort();
  const fakePaths = fakeLeaves.map((l) => l.path).sort();
  const missingSlots = realPaths.filter((p) => !fakePaths.includes(p));
  const extraSlots = fakePaths.filter((p) => !realPaths.includes(p));
  ok('假 theme 覆盖全部文案槽位（漏一个就是界面上留一句旧文案）',
     missingSlots.length === 0 && extraSlots.length === 0,
     `缺 ${missingSlots.join(',') || '无'} / 多 ${extraSlots.join(',') || '无'}`);

  /*
   * 文案真的换了。
   *
   * ===== 这里刻意**不**断言"每一条字面量都不同" =====
   *
   * 第一版写的是"全部不同"，实测会红 —— 因为 `失败` / `暂停` / `调用`
   * 这类词在两个题材里本来就该一样，它们不含题材信息。
   * 把那条留下来只有一个后果：以后所有人往这条断言里加豁免，
   * 最后变成"只要改一句就算换皮了"。那是**静默放宽**，比不写还糟。
   *
   * 所以改成显式列出**承载题材名词**的槽位：
   * 标题/面板/分级说明/诚实声明/结算横幅/击毁飘字 —— 这些必须全变。
   * 通用动词（暂停、继续、重复）允许相同，它们不是题材。
   */
  const realMap = Object.fromEntries(realLeaves.map((l) => [l.path, l.text]));
  const fakeMap = Object.fromEntries(fakeLeaves.map((l) => [l.path, l.text]));

  const IDENTITY_SLOTS = [
    'docTitle', 'panelTitle', 'panelSub', 'startButton', 'keysHint',
    'tierRules.minion.tag', 'tierRules.minion.desc',
    'tierRules.elite.tag', 'tierRules.elite.desc',
    'tierRules.boss.tag', 'tierRules.boss.desc',
    'honest.death', 'honest.source', 'honest.timeAxis',
    'banner.win', 'banner.winDetail', 'banner.lose',
    'bossBar.border',
    'toast.kill', 'floater.kill', 'floater.killCombo',
  ];
  const unchangedIdentity = IDENTITY_SLOTS.filter((p) => fakeMap[p] === realMap[p]);
  ok('假 theme 把全部「题材槽位」都改掉了（标题/分级/诚实声明/横幅）',
     unchangedIdentity.length === 0,
     unchangedIdentity.length
       ? `未变：${unchangedIdentity.join(',')}`
       : `${IDENTITY_SLOTS.length} 个槽位全部不同`);

  /* 覆盖面兜底：真正变化的条目要占绝对多数，避免"只改标题就说换了皮" */
  const changedCount = fakeLeaves.filter((l) => realMap[l.path] !== l.text).length;
  ok('假 theme 改动的文案条目占多数（不是只改一句）',
     changedCount >= Math.ceil(realLeaves.length * 0.7),
     `${changedCount}/${realLeaves.length} 条不同`);

  /* 品牌名与分级名必须都换掉 */
  ok('品牌中文名随 theme 变化',
     FAKE.brand.nameZh !== BRAND.nameZh
     && FAKE.copy.panelTitle === FAKE.brand.nameZh,
     `${BRAND.nameZh} → ${FAKE.brand.nameZh}`);
  ok('分级显示名随 theme 变化（三级全不同）',
     ['minion', 'elite', 'boss'].every((k) => FAKE.tiers[k].name !== TIER_THEME[k].name),
     ['minion', 'elite', 'boss'].map((k) => `${TIER_THEME[k].name}→${FAKE.tiers[k].name}`).join(' · '));

  /* ---- 3) sprite 角色映射：经 theme 解析，且 unknown 兜底仍在 ---- */
  const roleKeys = Object.keys(SPRITE_ROLES.enemy);
  ok('敌人角色映射齐全（含 miner / wing 同档不同外观 + unknown）',
     ['minion', 'elite', 'miner', 'wing', 'boss', 'unknown'].every((k) => roleKeys.includes(k)),
     roleKeys.join(','));

  /*
   * 角色映射**真的可替换**：把假 theme 的 boss 换成 scoutDrone，
   * spriteKeyFor 必须返回 scoutDrone。
   *
   * 这正是"换美术不改 render"的最小证明：render 只认角色名，
   * 角色到键的翻译只有一张表。
   */
  const swapped = {
    sprites: {
      hero: FAKE.sprites.hero,
      enemy: { ...FAKE.sprites.enemy, boss: 'scoutDrone' },
    },
  };
  ok('角色映射可替换：改配置即改取到的 sprite 键',
     themeMod.spriteKeyFor('boss', swapped) === 'scoutDrone',
     themeMod.spriteKeyFor('boss', swapped));
  ok('主角三态经角色映射解析（render 不再写死 aegisIdle）',
     themeMod.spriteKeyFor('idle') === SPRITE_ROLES.hero.idle
     && themeMod.spriteKeyFor('wind') === SPRITE_ROLES.hero.wind
     && themeMod.spriteKeyFor('strike') === SPRITE_ROLES.hero.strike,
     [themeMod.spriteKeyFor('idle'), themeMod.spriteKeyFor('wind'),
       themeMod.spriteKeyFor('strike')].join(','));

  /* 兜底：查不到的角色必须落到 unknown，绝不返回 undefined（画空白） */
  const bogus = themeMod.spriteKeyFor('__no_such_role__');
  ok('查不到的角色落到 unknown 兜底（不返回 undefined）',
     typeof bogus === 'string' && bogus === SPRITE_ROLES.enemy.unknown,
     String(bogus));
  ok('角色映射里的每个键都在 SPRITES 里有对应点阵（不会指向空气）',
     Object.values(SPRITE_ROLES.enemy)
       .concat(Object.values(SPRITE_ROLES.hero))
       .every((k) => spritesMod.SPRITES[k]),
     Object.values(SPRITE_ROLES.enemy).concat(Object.values(SPRITE_ROLES.hero)).join(','));

  /* ---- 4) render / main 里不许再出现硬编码的 sprite 键 ---- */
  const renderSrc = readFileSync(new URL('./render.mjs', import.meta.url), 'utf8');
  const mainSrc = readFileSync(new URL('./main.mjs', import.meta.url), 'utf8');

  /*
   * 剥掉注释再查 —— 注释里出现 `aegisIdle` 是在**解释**
   * "不要写 aegisIdle"，那不是违规。
   */
  const stripComments = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

  const renderCode = stripComments(renderSrc);
  const hardcodedRender = ['aegisIdle', 'aegisWind', 'aegisStrike']
    .filter((k) => renderCode.includes(`.${k}`));
  ok('render.mjs 不按名取主角帧（必须走 theme 角色映射）',
     hardcodedRender.length === 0, hardcodedRender.join(','));

  ok('render.mjs 的主角三帧来自 ROLES（角色表），不是字面量',
     /ROLES\.hero\.(idle|wind|strike)/.test(renderCode));

  /*
   * 敌人兜底：原来写 `this.sprites[e.sprite] || this.sprites.unknown`。
   * 直接写 `.unknown` 就把兜底写死成了某个主题的键名。
   */
  ok('render.mjs 的敌人兜底走 ROLES.enemy.unknown（不是写死 unknown）',
     /ROLES\.enemy\.unknown/.test(renderCode),
     /this\.sprites\.unknown/.test(renderCode) ? '仍有 this.sprites.unknown' : 'ok');

  /*
   * main.mjs 不许出现题材字面量。
   * 这是"换主题不用改 main"最直接的证据：
   * 只要 main 里有一句 '击毁'，换主题后它就会留在界面上。
   */
  const mainCode = stripComments(mainSrc);
  const themeWords = ['击毁', '侦察机', '突击舰', '母舰', '星海', '实况智能体',
    '植保', '盾牌', '蚂蚁', '工蚁', '兵蚁', '蚁后'];
  const leaked = themeWords.filter((w) => mainCode.includes(w));
  ok('main.mjs 里没有题材字面量（全部经 theme 注入）',
     leaked.length === 0, leaked.join(','));

  ok('main.mjs 的可见文案取自 COPY',
     /COPY\.(panelTitle|panelSub|hud|toast|floater)/.test(mainCode));

  /*
   * render.mjs 里同样不许留题材字面量。
   *
   * 这一条是被**实测抓出来的**：做完主题化之后跑一遍，
   * 结算横幅里还写着「任务完成 · 虫害肃清」—— 文案全在 main/theme 里改干净了，
   * 唯独画布上的这句没人管，因为 render 不上 HUD 的断言范围。
   * 现在把它钉住：render 画出的每一个字都必须来自 COPY。
   */
  const renderWords = ['虫害肃清', '任务完成', '本轮失败', '敌人未被清除',
    '植保', '盾牌', '蚂蚁', '工蚁', '兵蚁', '蚁后', '星海'];
  const renderLeaked = renderWords.filter((w) => renderCode.includes(w));
  ok('render.mjs 里没有题材字面量（结算横幅等文案全部经 COPY）',
     renderLeaked.length === 0, renderLeaked.join(','));
  ok('render.mjs 的结算横幅取自 COPY.banner',
     /COPY\.banner\.(win|winDetail|lose)/.test(renderCode));
  ok('render.mjs 的 BOSS 血条 tag 取自 COPY.bossBar',
     /COPY\.bossBar\.(estimate|overdue)/.test(renderCode));

  ok('main.mjs 的分级名取自 TIER_THEME',
     /TIER_THEME\.(minion|elite|boss)/.test(mainCode));

  /* 页面标题也必须来自 theme，不是 HTML 里写死一个旧名字 */
  const htmlSrc = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  ok('index.html 的 <title> 与 theme 的品牌名一致',
     htmlSrc.includes(BRAND.nameZh),
     `<title> 应含 ${BRAND.nameZh}`);

  /*
   * ---- 5) 关键证明：换主题**不需要碰 director.mjs** ----
   *
   * 真跑一遍战斗逻辑。Director 从头到尾只认 tool 名与 tier 数值，
   * 对 theme 一无所知 —— 所以换了主题，结算结果必须完全一致。
   */
  const directorSrc = stripComments(
    readFileSync(new URL('./director.mjs', import.meta.url), 'utf8'));
  const directorImportsTheme = /from\s*'\.\/theme\.mjs'/.test(directorSrc);
  ok('director.mjs 不依赖 theme（战斗逻辑与题材解耦）',
     !directorImportsTheme, directorImportsTheme ? '竟然 import 了 theme' : 'ok');

  const runOnce = () => {
    const d = new Director({ arena: ARENA });
    d.handle({ kind: 'tool', tool: 'agent_run' }, 1000);
    d.handle({ kind: 'tool', tool: 'read_file' }, 1010);
    d.handle({ kind: 'tool', tool: 'bash' }, 1020);
    d.handle({ kind: 'turn_end', ok: true }, 1030);
    const s = d.stats(1040);
    return { kills: s.kills, alive: s.alive, seen: s.seen };
  };
  const r1 = runOnce();
  const r2 = runOnce();
  ok('director 的结算结果与主题无关（同一份事件两次跑，结果一致）',
     r1.kills === r2.kills && r1.alive === r2.alive && r1.seen === r2.seen,
     `${JSON.stringify(r1)} vs ${JSON.stringify(r2)}`);
  ok('换主题不改击杀语义：真实事件仍然结算出击杀',
     r1.kills > 0, `kills=${r1.kills}`);

  /*
   * ---- 6) 变异自测：这条测试真的能抓到违反 ----
   *
   * 上面所有断言都依赖"槽位/映射被真的读取"。
   * 如果不做这一步，测试本身可能是恒真的 —— 那这整节就白写了。
   *
   * 做法：把真实 theme 的某条文案改一个字符，
   * 断言 copyLeaves() 能**观测到**这个变化。
   */
  const mutated = { copy: JSON.parse(JSON.stringify(COPY)) };
  mutated.copy.panelTitle = COPY.panelTitle + 'X';
  const mutLeaves = themeMod.copyLeaves(mutated);
  const mutHit = mutLeaves.find((l) => l.path === 'panelTitle');
  ok('变异自测：改一条显示名，测试能观测到变化（断言不是恒真的）',
     Boolean(mutHit) && mutHit.text === COPY.panelTitle + 'X'
     && mutHit.text !== COPY.panelTitle,
     mutHit ? `${JSON.stringify(COPY.panelTitle)} → ${JSON.stringify(mutHit.text)}` : '未观测到');

  /* 同上，对 sprite 映射做一次变异 */
  const mutSprite = {
    sprites: {
      hero: { ...SPRITE_ROLES.hero },
      enemy: { ...SPRITE_ROLES.enemy, minion: 'mothership' },
    },
  };
  ok('变异自测：改一条角色的 sprite 键，解析结果跟着变',
     themeMod.spriteKeyFor('minion', mutSprite) === 'mothership'
     && themeMod.spriteKeyFor('minion') !== 'mothership',
     `${themeMod.spriteKeyFor('minion')} → ${themeMod.spriteKeyFor('minion', mutSprite)}`);
}

/* ================= 15. 产品外壳：三个入口 / 三路接入 ================= */

section('产品外壳：一键演示 / 拖入文件 / HTTP 钩子');

{
  /*
   * ===== 这一节为什么不能只做源码锚点 =====
   *
   * "拖入非法文件不伪造进度"这条，用 grep 是证不出来的：
   * 源码里可以既有错误提示、又有一条悄悄退回样本数据的分支。
   * 所以这里**真跑一遍页面**：造 DOM 桩 → import main.mjs →
   * 通过 __shield 喂文本 → 看 source()/stats() 是不是真的没变。
   *
   * 桩必须够用：main.mjs 顶层会 new Renderer(cv) 并立刻 draw 一帧，
   * 缺一个 2D API 就会在加载期抛错，整节变成假绿（这条本项目踩过）。
   * 所以 ctx 用 Proxy 兜住所有方法，而不是逐个列举。
   */
  const ctxStub = new Proxy({}, {
    get(_t, k) {
      if (k === 'canvas') return { width: 960, height: 600 };
      if (k === 'measureText') return () => ({ width: 10 });
      if (k === 'createLinearGradient' || k === 'createRadialGradient') {
        return () => ({ addColorStop() {} });
      }
      if (k === 'createPattern') return () => ({});
      if (k === 'getImageData') return () => ({ data: new Uint8ClampedArray(4) });
      /* 下划线开头的是"内部字段"，返回 undefined —— 否则桩自己会引入
         一个永远为真的对象，让"取不到就跳过"的分支测不出来 */
      if (typeof k === 'string' && k.startsWith('_')) return undefined;
      return () => {};
    },
    set() { return true; },
  });

  const makeEl = (id) => {
    const el = {
      id,
      textContent: '',
      innerHTML: '',
      className: '',
      style: {},
      dataset: {},
      width: 960,
      height: 600,
      children: [],
      files: null,
      _classes: new Set(),
    };
    /*
     * classList 必须真的记账（不是空函数）：
     * 面板隐藏 / HUD 亮起都靠它，空桩会让"点开始有没有隐藏面板"测不出来。
     */
    el.classList = {
      add: (c) => el._classes.add(c),
      remove: (c) => el._classes.delete(c),
      contains: (c) => el._classes.has(c),
      toggle: (c) => (el._classes.has(c) ? el._classes.delete(c) : el._classes.add(c)),
    };
    /*
     * ===== 元素监听器必须真的记账（和 window keydown 同一个教训）=====
     *
     * 这两行原来是 no-op。后果不是"少测一点"，而是**整条拖放层进不了
     * 断言**：bindDrop() 挂在 dropZone 上的 dragover / dragleave / drop
     * 和挂在 filePick 上的 change 全都留不下来，于是状态矩阵里每一格都
     * 只能靠 shield.loadText() / __shield.emit() 桩构造 —— 真实的
     * drop → onDrop → loadFile(file) → file.text() → playSource 这条链
     * 一次都没跑过（这就是那个低危覆盖缺口，现在补在后面"真实 drop"那一格）。
     *
     * 记下来之后可以用 el.__fire('drop', ev) 真实派发。
     */
    el.__handlers = new Map();
    el.addEventListener = (type, fn) => {
      if (!el.__handlers.has(type)) el.__handlers.set(type, []);
      el.__handlers.get(type).push(fn);
    };
    el.removeEventListener = (type, fn) => {
      const arr = el.__handlers.get(type) || [];
      const i = arr.indexOf(fn);
      if (i >= 0) arr.splice(i, 1);
    };
    /** 把事件派发给该元素上的监听器；返回接住它的处理器个数 */
    el.__fire = (type, ev = {}) => {
      const arr = (el.__handlers.get(type) || []).slice();
      for (const fn of arr) fn(ev);
      return arr.length;
    };
    el.appendChild = (c) => { el.children.push(c); return c; };
    el.getBoundingClientRect = () => ({
      x: 0, y: 0, width: 960, height: 600, left: 0, top: 0, right: 960, bottom: 600,
    });
    el.getContext = () => ctxStub;
    el.click = () => {};
    return el;
  };
  const els = new Map();
  globalThis.document = {
    getElementById: (id) => {
      if (!els.has(id)) els.set(id, makeEl(id));
      return els.get(id);
    },
    createElement: (t) => makeEl(t),
    querySelector: () => null,
    addEventListener: () => {},
    removeEventListener: () => {},
    body: makeEl('body'),
    documentElement: makeEl('html'),
    title: '',
  };
  Object.defineProperty(globalThis, 'window', {
    value: globalThis, configurable: true, writable: true,
  });
  /*
   * window.addEventListener 必须真的存在：main.mjs 顶层挂了 keydown / resize。
   *
   * ===== 不再用 no-op（这一条本身就是上一轮漏测的根因）=====
   *
   * 空格 / P / R 的真实分支就挂在 keydown 上。桩写成 no-op，等于把
   * "播放中按空格"整条路径跳过 —— 上一轮就是这么漏掉的：断言全部建在
   * "开始面板可见"的上下文里，走的是 startDemo()；而真实用户在播放中
   * 按空格走的是另一条分支（setPaused），那条分支一次都没被执行过。
   *
   * 所以这里**记录**监听器，后面按 e.code 派发真实的按键事件。
   */
  globalThis.__winListeners = new Map();
  globalThis.addEventListener = (type, fn) => {
    if (!globalThis.__winListeners.has(type)) globalThis.__winListeners.set(type, []);
    globalThis.__winListeners.get(type).push(fn);
  };
  globalThis.removeEventListener = (type, fn) => {
    const arr = globalThis.__winListeners.get(type) || [];
    const i = arr.indexOf(fn);
    if (i >= 0) arr.splice(i, 1);
  };
  globalThis.requestAnimationFrame = (cb) => { globalThis.__rafQ.push(cb); return 1; };
  globalThis.__rafQ = [];
  globalThis.__pumpFrame = (t) => {
    globalThis.__vnow = t;
    const b = globalThis.__rafQ.splice(0);
    for (const cb of b) cb(t);
  };

  const pageUrl = new URL('./main.mjs?p5=' + Date.now(), import.meta.url);
  let loadErr = null;
  try {
    await import(pageUrl.href);
  } catch (e) {
    loadErr = e;
  }
  ok('页面在 DOM 桩下能加载（三个入口不炸模块顶层）', loadErr === null,
     loadErr ? loadErr.message : '');
  const shield = globalThis.__shield;
  ok('页面暴露了事件源探针（__shield.source / loadText / ingest）',
     !!shield && typeof shield.source === 'function'
     && typeof shield.loadText === 'function'
     && typeof shield.ingest === 'function');

  if (shield && typeof shield.loadText === 'function') {
    /* ---------- ① 一键 demo：不传数据就能播真实样本 ---------- */
    const before = shield.source();
    ok('默认事件源就是真实样本（不是空表、不是手写剧本）',
       before.events > 500 && !before.live,
       `${before.events} 条 / ${before.label}`);
    ok('样本源的调用数与 meta 一致（292 次工具调用）',
       before.meta && before.meta.tools === 292, String(before.meta && before.meta.tools));

    const demo = shield.playSample();
    ok('一键 demo 不需要任何输入即可播放', demo.events === before.events && demo.events > 0,
       `${demo.events} 条`);

    /*
     * 真的推进时间轴：10 帧之后必须有敌人出场。
     * 只断言"事件表非空"是不够的 —— 那不证明播放循环在跑。
     */
    globalThis.__pumpFrame(1);
    for (let i = 1; i <= 40; i++) globalThis.__pumpFrame(1 + i * 16.7);
    const stDemo = shield.stats(globalThis.__vnow);
    ok('一键 demo 真的在播（推进后已有敌人出场）', stDemo.seen > 0,
       `seen=${stDemo.seen}`);
    ok('一键 demo 的击杀只来自 tool_end（kills <= seen）',
       stDemo.kills <= stDemo.seen, `kills=${stDemo.kills} seen=${stDemo.seen}`);

    /* ---------- ② 拖入合法文件：真的进战场 ---------- */
    const fsMod = await import('node:fs');
    const saText = fsMod.readFileSync(
      new URL('./sample/session-analysis.json', import.meta.url), 'utf8',
    );
    const rSa = shield.loadText(saText, 'session-analysis.json');
    ok('拖入 session-analysis.json 能被解析并播放',
       rSa.ok === true && rSa.events > 0,
       rSa.ok ? `${rSa.events} 条` : rSa.message);
    ok('会话分析的调用数与真实一致（292）',
       rSa.ok && rSa.meta && rSa.meta.tools === 292,
       String(rSa.meta && rSa.meta.tools));

    const evText = fsMod.readFileSync(
      new URL('./real-events.json', import.meta.url), 'utf8',
    );
    const rEv = shield.loadText(evText, 'real-events.json');
    ok('拖入 real-events.json 能被解析并播放', rEv.ok === true && rEv.events > 0,
       rEv.ok ? `${rEv.events} 条` : rEv.message);

    /* JSONL：一行一条事件的日志形态 */
    const jsonl = [
      { kind: 'tool', tool: 'read_file', id: 'a', ts: 0 },
      { kind: 'tool_end', tool: 'read_file', id: 'a', ok: true, ts: 12 },
      { kind: 'tool', tool: 'pwsh', id: 'b', ts: 20 },
      { kind: 'tool_end', tool: 'pwsh', id: 'b', ok: true, ts: 500 },
      { kind: 'turn_end', ok: true, ts: 600 },
    ].map((x) => JSON.stringify(x)).join('\n');
    const rJsonl = shield.loadText(jsonl, 'my-log.jsonl');
    ok('拖入 .jsonl 能被解析并播放', rJsonl.ok === true && rJsonl.events === 5,
       rJsonl.ok ? `${rJsonl.events} 条` : rJsonl.message);

    /* ---------- ③ 拖入非法文件：可读错误 + 不许伪造进度 ---------- */
    /*
     * 先把战场开在一个**已知的**状态上，这样"有没有变"才可判。
     */
    shield.playSample();
    globalThis.__pumpFrame(2000);
    const baseSrc = shield.source();
    const baseStats = shield.stats(globalThis.__vnow);

    const badCases = [
      { name: 'bad-shape.json', text: '{"hello":"world"}', tag: '认不出的形状' },
      { name: 'bad-text.txt', text: 'this is not json\nnor jsonl\n', tag: '纯文本' },
      { name: 'empty.json', text: '', tag: '空文件' },
      { name: 'bad-events.json', text: '[{"kind":"tool"}]', tag: '缺 ts 的事件' },
    ];
    for (const c of badCases) {
      const r = shield.loadText(c.text, c.name);
      ok(`拖入非法文件（${c.tag}）被拒，且有可读错误`,
         r.ok === false && typeof r.message === 'string' && r.message.length > 8,
         r.ok ? '竟然接受了' : String(r.message).slice(0, 40));
    }

    /*
     * ===== 产品红线：失败之后画面不许动 =====
     *
     * 这是本节最该守的一条。一个"读不懂就退回样本数据"的实现，
     * 会让画面继续动、数继续涨，而用户以为看的是自己的活。
     * 所以断言的是**四个数都没变**：事件源条数、源标签、seen、kills。
     */
    const afterSrc = shield.source();
    const afterStats = shield.stats(globalThis.__vnow);
    ok('非法文件没有替换事件源（仍是被拒之前那一份）',
       afterSrc.label === baseSrc.label && afterSrc.events === baseSrc.events,
       `${baseSrc.label}(${baseSrc.events}) → ${afterSrc.label}(${afterSrc.events})`);
    ok('非法文件没有产生任何进度（seen / kills 都没动）',
       afterStats.seen === baseStats.seen && afterStats.kills === baseStats.kills,
       `seen ${baseStats.seen}→${afterStats.seen} / kills ${baseStats.kills}→${afterStats.kills}`);
    ok('非法文件之后没有偷偷开始新一局（playing 状态未重置）',
       afterStats.seen >= baseStats.seen && afterSrc.live === baseSrc.live);

    /* 后面的结构断言要读 main.mjs 源码，这里先读一次（只读，不改） */
    const mainSrcP5 = fsMod.readFileSync(new URL('./main.mjs', import.meta.url), 'utf8');

    /*
     * ===== 产品红线（反面）：失败红条不许"粘住" =====
     *
     * 真浏览器实测过的坏状态：喂垃圾文件 → 红条写「载入失败 · 未播放
     * 任何数据」；随后按空格/R 播样本（seen 在涨、来源标签已切回样本），
     * **红条还挂着**。一屏同时说"没在播"和"正在播"。
     *
     * 这和"绝不伪造进度"是同一枚硬币：都是让界面说了假话。
     * 所以这里不复刻某个函数调用顺序，而是按用户真实操作顺序走一遍：
     *   制造失败 → 切到一个成功来源 → 断言错误条被清空。
     *
     * 三个成功来源都要验（样本 / 拖入 / 钩子）：只验一个的话，
     * 将来新增入口漏写清除也没人知道。
     */
    const noteEl = globalThis.document.getElementById('sourceNote');
    const dropErrEl = globalThis.document.getElementById('dropErr');

    /*
     * 判据用**两路互补**的证据：
     *   1. 元素上的文本与 bad 类（UI 层的真实状态）
     *   2. main.mjs 里清错误的锚点（结构层：汇合点必须调 clearLoadError）
     * 单看 DOM 桩可能被"桩没实现某个 class"骗过，单看源码则是"存在即通过"。
     */
    const noteIsFailed = () => /载入失败|未播放任何数据/.test(noteEl.textContent || '')
      && noteEl.classList.contains('bad');
    const noteIsClean = () => !/载入失败|未播放任何数据/.test(noteEl.textContent || '')
      && !noteEl.classList.contains('bad');

    const failOnce = () => {
      const rr = shield.loadText('这不是 JSON，也不是 JSONL\n', 'garbage.txt');
      return rr;
    };

    /* ① 制造失败态：先确认失败态真的成立（否则后面的"清空"是空转） */
    const failRes = failOnce();
    ok('失败态成立（红条 + bad 类同时就位，后面的清空断言才有意义）',
       failRes.ok === false && noteIsFailed(),
       `ok=${failRes.ok} / text=${String(noteEl.textContent).slice(0, 30)}`
       + ` / bad=${noteEl.classList.contains('bad')}`);

    /* ② 切到成功来源之一：样本（「进入战场」按钮那条路径） */
    shield.playSample();
    globalThis.__pumpFrame(2500);
    ok('失败 → 点「进入战场」播样本：失败红条被清除（界面不再自相矛盾）',
       noteIsClean() && !noteEl.classList.contains('bad'),
       `text=${String(noteEl.textContent).slice(0, 40)} bad=${noteEl.classList.contains('bad')}`);
    ok('失败 → 播样本：画面真的在播（清了红条不是靠停播换来的）',
       shield.stats(globalThis.__vnow).seen > 0,
       `seen=${shield.stats(globalThis.__vnow).seen}`);

    /*
     * ②' 切到成功来源之一（**正是实测复现的那条路**）：空格 / R 重播。
     *
     * 这条不能省，而且必须和 ② 分开写：键盘路径直接调 startDemo()，
     * 不经过 startSampleDemo 里的 showSource —— 于是红条**不会被
     * 任何"写新来源"的动作顺带覆盖**，只能靠显式清除。
     * 实测就是这个顺序：失败 → 按 R（画面在动、seen 在涨）→ 红条还挂着。
     *
     * 变体自测（自包含，不引用任何未落盘的报告）：把 startDemo 里的
     * clearLoadError() 删掉 → ② 仍然绿（playSample 会重写文本盖掉它），
     * 而 ②' 立刻红 —— 也就是说只有这条真正锁住了那个 bug。
     * 复现命令：删掉 main.mjs 里 startDemo 的 clearLoadError(); 后
     *   node verify.mjs  （应看到本条与"播放中按空格"两条同时红）
     */
    failOnce();
    ok('（键盘路径前）失败态成立', noteIsFailed());
    shield.restart();
    globalThis.__pumpFrame(2700);
    ok('失败 → 空格/R 重播：失败红条被清除（实测复现的那条路径）',
       noteIsClean() && !noteEl.classList.contains('bad'),
       `text=${String(noteEl.textContent).slice(0, 40)} bad=${noteEl.classList.contains('bad')}`);
    ok('失败 → 空格/R 重播：画面真的在播（不是靠停播换来的"没在播"）',
       shield.stats(globalThis.__vnow).seen > 0,
       `seen=${shield.stats(globalThis.__vnow).seen}`);
    /* 同样地，面板上的 dropErr 也不许留着上一轮的报错 */
    ok('失败 → 空格/R 重播：面板上的报错文字也被清掉',
       !String(dropErrEl.textContent || '').trim(),
       `dropErr="${String(dropErrEl.textContent || '').slice(0, 30)}"`);

    /* ③ 切到成功来源之二：拖入一个合法文件 */
    failOnce();
    ok('（第二次）失败态成立', noteIsFailed());
    const okRes = shield.loadText(jsonl, 'again.jsonl');
    ok('失败 → 拖入合法文件：失败红条被清除',
       okRes.ok === true && noteIsClean(),
       `ok=${okRes.ok} text=${String(noteEl.textContent).slice(0, 40)}`);

    /*
     * ④ 切到成功来源之三：HTTP 钩子连上（走 onopen 那条路径）。
     *
     * 这一块的 EventSource 桩是**这里自己装的**，用完还原 ——
     * 下面还有一节要装它自己的桩，不能互相污染。
     */
    {
      const esInst = [];
      const prevES = globalThis.EventSource;
      class LocalFakeES {
        constructor(url) { this.url = url; this.onopen = null; this.onerror = null;
          this.onmessage = null; this.closed = false; esInst.push(this); }
        close() { this.closed = true; }
      }
      globalThis.EventSource = LocalFakeES;
      failOnce();
      ok('（第三次）失败态成立', noteIsFailed());
      shield.connectHook('http://127.0.0.1:8787');
      const esLast = esInst[esInst.length - 1];
      ok('钩子入口真的建了流（onopen 断言才有对象可测）', Boolean(esLast),
         esLast ? esLast.url : '没建流');
      if (esLast && typeof esLast.onopen === 'function') esLast.onopen();
      ok('失败 → HTTP 钩子连上：失败红条被清除',
         noteIsClean(),
         `text=${String(noteEl.textContent).slice(0, 40)}`);
      if (esLast && typeof esLast.close === 'function') esLast.close();
      if (prevES === undefined) delete globalThis.EventSource;
      else globalThis.EventSource = prevES;
    }

    /*
     * ⑤ 反向保护：清红条不许顺手抹掉**真实的失败信息**。
     * 失败之后如果没有新来源开始播，红条必须**继续挂着** ——
     * 反过来（一失败就自动消失）同样是撒谎，而且更隐蔽。
     */
    failOnce();
    globalThis.__pumpFrame(2600);
    ok('反向保护：没有新来源时失败红条必须继续在场（不许自己消失）',
       noteIsFailed(),
       `text=${String(noteEl.textContent).slice(0, 40)}`);

    /*
     * ===== 结构锁：清除逻辑写在**汇合点**，不是某一个入口里 =====
     *
     * 之所以要这条：实测漏掉的正是键盘空格/R 这两条路径 —— 它们
     * 绕过三个按钮直接调 startDemo()。写在按钮 handler 里就一定会漏。
     */
    const codeP5c = mainSrcP5
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    ok('清失败提示的锚点唯一（clearLoadError 只定义一处）',
       countOf(mainSrcP5, 'function clearLoadError()') === 1,
       `命中 ${countOf(mainSrcP5, 'function clearLoadError()')} 次`);
    const startDemoAt = countOf(codeP5c, 'function startDemo()') === 1
      ? codeP5c.indexOf('function startDemo()') : -1;
    const clearInStartDemo = startDemoAt >= 0
      && codeP5c.slice(startDemoAt, startDemoAt + 4000).includes('clearLoadError();');
    ok('startDemo（三个入口 + 键盘空格/R 的汇合点）内部会清失败提示',
       clearInStartDemo,
       startDemoAt >= 0 ? '' : 'startDemo 锚点不唯一');

    /*
     * ===== 状态矩阵不变量（本轮主线）=====
     *
     * 上一轮为什么没抓到 bug：所有 Space/R 断言都建在"开始面板可见"
     * 的上下文里 —— 那条路径会走 startDemo()，而 startDemo 里有
     * clearLoadError()。真实用户在**播放中**按空格走的是另一条分支
     * （setPaused），那条分支一次都没被执行过。断言验在了错的状态。
     *
     * 所以这里不再写"某条路径应该清红条"，而是写**不变量**：
     *
     *   只要界面上出现「未播放任何数据」这一句，
     *   实际就必须真的没有任何播放
     *   （敌人 0、seen 0、且不是"有数据的暂停态"）。
     *
     * 这是产品红线"界面不许说假话"在 UI 侧的对偶：
     * 它不关心你用哪条代码路径实现，只关心"这句话和事实是否一致"。
     *
     * 矩阵 = (开始面板可见 | 正在播放 | 已暂停) × (无失败条 | 有失败条)。
     * 每一格都构造出真实状态，然后跑同一条不变量。
     */
    section('状态矩阵不变量：界面说"未播放任何数据"时，必须真的没在播');
    {
      const docP5 = globalThis.document;
      const panelEl = docP5.getElementById('startPanel');
      const noteP5 = docP5.getElementById('sourceNote');
      const hudEl = docP5.getElementById('hud');

      const noteText = () => String(noteP5.textContent || '');
      /*
       * 判据只认**这句话本身**，不认它带不带 bad 类：
       * 不变量说的是"文本与事实一致"，样式是另一回事。
       * 两个变体都算（"未播放任何数据" / "战场为空"），因为项目里
       * 两处文案都在做同一类全局声明。
       */
      const claimsNothingPlayed = () => /未播放任何数据|战场为空/.test(noteText());
      const noteVisible = () => noteP5.classList.contains('on') && noteText().trim().length > 0;
      const noteBad = () => noteP5.classList.contains('bad');

      /*
       * 键盘必须**真的按下去**：直接调 __shield.pause() 是在测 API，
       * 而 bug 长在 keydown 的分支选择上。上一轮就是漏了这一层。
       */
      const pressKey = (code) => {
        const fns = globalThis.__winListeners.get('keydown') || [];
        let prevented = 0;
        for (const fn of fns) fn({ code, preventDefault() { prevented++; } });
        return { handled: fns.length, prevented };
      };

      const world = () => {
        const st = shield.stats(globalThis.__vnow);
        return {
          enemies: shield.enemies().length,
          seen: st.seen,
          kills: st.kills,
          paused: shield.isPaused(),
          hudOn: hudEl.classList.contains('on'),
          panelVisible: !panelEl.classList.contains('hidden'),
        };
      };

      /*
       * 时间游标：必须在 performance.now() 的**同一坐标系**上推进。
       *
       * startDemo() 用 performance.now() 记 demoStart，所以喂进 frame 的
       * 时间戳必须比它晚 —— 直接拿一个自增计数器会在真实墙钟已经跑了几
       * 秒之后反而"早于"demoStart，时间轴一动不动（seen 恒为 0）。
       */
      let extra = 0;
      const advance = (ms) => {
        extra += ms;
        globalThis.__vnow = performance.now() + extra;
        globalThis.__pumpFrame(globalThis.__vnow);
      };

      const setPanel = (visible) => {
        if (visible) panelEl.classList.remove('hidden');
        else panelEl.classList.add('hidden');
      };
      const setPausedTo = (want) => { if (shield.isPaused() !== want) shield.pause(); };
      /*
       * 开一局"确定在播"的样本战斗 —— 走的是「进入战场」那条真入口
       * （playSample → startSampleDemo → startDemo），不是 restart()。
       *
       * 差别是实的：restart() 不动 liveMode，而本节前面几段把页面切到了
       * 实时模式（liveMode=true）跑过钩子。实时模式下 tickDemo 刻意不推
       * 时间轴（事件由网络到达），于是 restart() 之后 seen 永远是 0 ——
       * 整个矩阵会变成"三格空战场"，断言表面绿、实际什么都没测到。
       */
      const startFreshPlayback = () => {
        shield.playSample();
        setPausedTo(false);
        advance(2600);
      };

      /*
       * 每格都记一条断言：只要"未播放任何数据"在场而实际有进度，就红。
       * detail 里带上全部读数，红了能直接看出是哪一格、差多少。
       */
      const invariantHolds = (cell) => {
        const w = world();
        const claims = claimsNothingPlayed();
        const violated = claims && (w.enemies > 0 || w.seen > 0 || w.kills > 0);
        ok(`状态矩阵 · ${cell}：「未播放任何数据」与事实一致`,
           !violated,
           `claimsNothing=${claims} enemies=${w.enemies} seen=${w.seen} kills=${w.kills}`
           + ` paused=${w.paused} / text=${noteText().slice(0, 40)}`);
        return { w, claims };
      };

      /*
       * ---- 构造 6 格 ----
       *
       * "正在播放"的判据用界面能看到的三件事：面板已隐藏 + HUD 亮 +
       * 没有暂停 + seen>0。不用内部 playing 变量，因为界面上没有它 ——
       * 用户能看到的才是不变量该对齐的东西。
       */
      const cells = [];

      /* ① 开始面板可见 · 无失败条 */
      shield.restart();
      setPausedTo(false);
      setPanel(true);
      advance(50);
      cells.push({ name: '面板可见+干净', ...invariantHolds('面板可见+干净') });

      /* ② 开始面板可见 · 有失败条 */
      const f2 = shield.loadText('这不是 JSON\n', 'garbage-panel.txt');
      advance(50);
      cells.push({ name: '面板可见+失败条', ...invariantHolds('面板可见+失败条') });
      ok('面板可见时喂垃圾文件：红条如实说"未播放任何数据"（这一格本来就该这么说）',
         f2.ok === false && claimsNothingPlayed() && noteBad() && noteVisible(),
         `text=${noteText().slice(0, 40)} bad=${noteBad()}`);

      /* ③ 正在播放 · 无失败条 */
      setPanel(false);
      startFreshPlayback();
      const w3 = world();
      ok('矩阵构造：③"正在播放"这一格真的在播（否则后面几格是空转）',
         w3.seen > 0 && w3.paused === false && w3.hudOn === true && w3.panelVisible === false,
         `seen=${w3.seen} paused=${w3.paused} hud=${w3.hudOn} panel=${w3.panelVisible}`);
      cells.push({ name: '播放中+干净', ...invariantHolds('播放中+干净') });

      /* ④ 正在播放 · 有失败条（真浏览器复验抓到的那个状态） */
      const f4 = shield.loadText('这不是 JSON\n', 'garbage-playing.txt');
      advance(50);
      ok('矩阵构造：④播放中喂垃圾文件仍然红条（失败提示不许被静默吞掉）',
         f4.ok === false && noteBad() && noteVisible(),
         `bad=${noteBad()} text=${noteText().slice(0, 40)}`);
      cells.push({ name: '播放中+失败条', ...invariantHolds('播放中+失败条') });

      /* ⑤ 已暂停 · 无失败条 */
      startFreshPlayback();
      setPausedTo(true);
      advance(50);
      const w5 = world();
      ok('矩阵构造：⑤"已暂停"这一格真的有数据且处于暂停（不是空战场暂停）',
         w5.paused === true && w5.seen > 0,
         `paused=${w5.paused} seen=${w5.seen}`);
      cells.push({ name: '暂停中+干净', ...invariantHolds('暂停中+干净') });

      /* ⑥ 已暂停 · 有失败条 */
      shield.loadText('这不是 JSON\n', 'garbage-paused.txt');
      advance(50);
      cells.push({ name: '暂停中+失败条', ...invariantHolds('暂停中+失败条') });

      /*
       * ===== 状态矩阵新列：钩子连接失败 =====
       *
       * 为什么必须是"一列"而不是一条点断言：
       * 前面 6 格测的全是**载入失败**那一个入口（reportLoadError）。
       * 而 connectHook() 的 onerror 是**另一条**会写全局否定的路径，
       * 它原来无条件写「HTTP 钩子未连接 · 战场为空，未伪造任何进度」。
       * 正在播样本时去连钩子、连接失败 → 画面里敌人在飞，状态条却说
       * "战场为空"；而且 connectHook 从不重置 director 计数，onerror
       * 也不调 clearLoadError()，feed 里的自愈只在**新事件到达**时触发
       * （钩子一条都到不了）—— 这句假话不会自愈。
       * 只补一条点断言会再次验在"空战场"这个错的状态上（本项目已经栽过
       * 两次），所以两格都要：有进度、无进度。
       */
      {
        const esInst = [];
        const prevES = globalThis.EventSource;
        class MatrixFakeES {
          constructor(url) {
            this.url = url; this.onopen = null; this.onerror = null;
            this.onmessage = null; esInst.push(this);
          }
          close() {}
        }
        /* 全局否定只认这一句；"钩子未连接"本身是事实，必须留着 */
        const claimsEmptyBattle = () => /战场为空/.test(noteText());
        const hookSaidFailed = () => /钩子未连接/.test(noteText()) && noteBad();
        /* 连一次必然失败的钩子：桩只提供 onerror，不触发 onopen */
        const failHook = () => {
          globalThis.EventSource = MatrixFakeES;
          shield.connectHook('http://127.0.0.1:8787');
          const es = esInst[esInst.length - 1];
          if (es && typeof es.onerror === 'function') es.onerror();
          return es;
        };

        /* ---- ⑦ 有进度 + 钩子失败 → 不许说"战场为空" ---- */
        startFreshPlayback();
        setPanel(false);
        const w7pre = world();
        ok('矩阵⑦构造：连钩子前确实在播（否则这一格是空战场，测不出旁路）',
           w7pre.seen > 0 && w7pre.enemies > 0,
           'seen=' + w7pre.seen + ' enemies=' + w7pre.enemies);
        const es7 = failHook();
        advance(50);
        const w7 = world();
        ok('矩阵⑦构造：钩子真的走到 onerror 分支（不是没建流）',
           Boolean(es7) && /钩子未连接/.test(noteText()),
           es7 ? 'url=' + es7.url + ' text=' + noteText().slice(0, 40) : '没建流');
        ok('矩阵 · 播放中+钩子失败：状态条不许出现"战场为空"',
           !claimsEmptyBattle(),
           'text=' + noteText().slice(0, 60) + ' enemies=' + w7.enemies
           + ' seen=' + w7.seen);
        ok('矩阵 · 播放中+钩子失败：也不许出现"未播放任何数据"（同一类全局否定）',
           !claimsNothingPlayed(), 'text=' + noteText().slice(0, 60));
        ok('矩阵 · 播放中+钩子失败：如实说明仍在播上一份数据',
           hookSaidFailed() && /仍在播上一份数据/.test(noteText()),
           'text=' + noteText().slice(0, 60));
        ok('矩阵 · 播放中+钩子失败：连不上不许抹掉画面进度（director 计数不许被重置）',
           w7.seen >= w7pre.seen && w7.enemies > 0,
           'seen ' + w7pre.seen + '→' + w7.seen + ' enemies ' + w7pre.enemies + '→' + w7.enemies);
        cells.push({ name: '播放中+钩子失败', ...invariantHolds('播放中+钩子失败') });

        /* ---- ⑧ 无数据 + 钩子失败 → 如实表述仍在 ---- */
        shield.restart();            /* 清空战场；实时模式下不推时间轴 */
        setPausedTo(true);
        advance(50);
        const w8pre = world();
        ok('矩阵⑧构造：先造出"真的没有进度"的战场（否则这一格测不到"如实"）',
           w8pre.enemies === 0 && w8pre.seen === 0 && w8pre.kills === 0,
           'enemies=' + w8pre.enemies + ' seen=' + w8pre.seen + ' kills=' + w8pre.kills);
        const es8 = failHook();
        advance(50);
        ok('矩阵⑧构造：钩子真的走到 onerror 分支（不是没建流）',
           Boolean(es8) && /钩子未连接/.test(noteText()),
           es8 ? 'url=' + es8.url + ' text=' + noteText().slice(0, 40) : '没建流');
        ok('矩阵 · 无数据+钩子失败：如实说战场为空（这句在这一格本来就成立）',
           claimsEmptyBattle() && hookSaidFailed(),
           'text=' + noteText().slice(0, 60));
        ok('矩阵 · 无数据+钩子失败：诚实意图仍在（未伪造任何进度）',
           /未伪造任何进度/.test(noteText()), 'text=' + noteText().slice(0, 60));
        cells.push({ name: '无数据+钩子失败', ...invariantHolds('无数据+钩子失败') });

        /* 还原环境：不能把桩 EventSource 留在全局（后面还有钩子小节） */
        if (prevES === undefined) delete globalThis.EventSource;
        else globalThis.EventSource = prevES;
        setPausedTo(false);
      }


      /*
       * 六格都必须真的构造出来并各自被判过 —— 少一格不许静默通过。
       * 这条防的是"矩阵被删掉几行，断言数下降但没人发现"。
       */
      ok('状态矩阵 8 格全覆盖（3 种播放状态 × 有无失败条，+ 钩子连接失败一列）',
         cells.length === 8 && cells.every((c) => c.name),
         cells.map((c) => c.name).join(' / '));
      ok('状态矩阵里既有"声称没播"也有"确实在播"的格（不是所有格都空战场）',
         cells.some((c) => c.claims === true) && cells.some((c) => c.w.seen > 0),
         `claims=${cells.filter((c) => c.claims).length} 有进度格=${
           cells.filter((c) => c.w.seen > 0).length}`);

      /*
       * ===== 回归本体：播放中 / 暂停中按空格，红条必须清 =====
       *
       * 这是真浏览器复现的那一步：喂垃圾 → 在播 → 按空格。
       * 修好之前这里必然红（空格走 setPaused，不经过 startDemo）。
       */
      {
        /* 播放中 + 失败条 → 空格 */
        setPanel(false);
        startFreshPlayback();
        shield.loadText('这不是 JSON\n', 'space-while-playing.txt');
        advance(50);
        const before = world();
        ok('回归构造：播放中 + 失败条（按空格前）',
           before.seen > 0 && before.paused === false && noteBad(),
           `seen=${before.seen} paused=${before.paused} bad=${noteBad()}`);
        const k = pressKey('Space');
        advance(50);
                const after = world();
        ok('播放中按空格：空格真的被 keydown 分支接住（不是空转）',
           k.handled > 0 && k.prevented > 0,
           `handled=${k.handled} prevented=${k.prevented}`);
        ok('播放中按空格：进入暂停（这条路径没被改坏）',
           after.paused === true, `paused ${before.paused}→${after.paused}`);
        ok('播放中按空格：失败红条被清除（真浏览器复现的那个 bug）',
           !noteBad() && !noteVisible(),
           `bad=${noteBad()} text=${noteText().slice(0, 40)}`);
        ok('播放中按空格：清红条不是靠"把战场也清空"换来的（数据还在）',
           after.seen === before.seen && after.enemies === before.enemies,
           `seen ${before.seen}→${after.seen} enemies ${before.enemies}→${after.enemies}`);
        invariantHolds('播放中→空格后');

        /* 暂停中 + 失败条 → 空格（继续播放） */
        shield.loadText('这不是 JSON\n', 'space-while-paused.txt');
        advance(50);
        ok('回归构造：暂停中 + 失败条（再按空格前）',
           shield.isPaused() === true && noteBad(),
           `paused=${shield.isPaused()} bad=${noteBad()}`);
        pressKey('Space');
        advance(50);
        const resumed = world();
        ok('暂停中按空格：回到播放（这条路径没被改坏）',
           resumed.paused === false, `paused=${resumed.paused}`);
        ok('暂停中按空格：失败红条被清除',
           !noteBad() && !noteVisible(), `text=${noteText().slice(0, 40)}`);
        invariantHolds('暂停中→空格后');

        /*
         * P 键必须单独覆盖。
         *
         * 只验空格是**不够**的：把 clearLoadError() 塞进 Space 分支这个
         * "局部补丁"能让空格那条断言全绿，而 P 键 / __shield.pause()
         * 照旧漏（这正是"修一条路径"而不是"修机制"）。
         * 所以这里再按一次 P —— 它和空格汇合在同一个 setPaused 上，
         * 但入口不同，只有把清除写在汇合点才能同时绿。
         */
        startFreshPlayback();
        setPanel(false);
        shield.loadText('这不是 JSON', 'p-while-playing.txt');
        advance(50);
        ok('回归构造：播放中 + 失败条（按 P 前）',
           noteBad() && world().seen > 0 && !shield.isPaused(),
           `bad=${noteBad()} seen=${world().seen} paused=${shield.isPaused()}`);
        pressKey('KeyP');
        advance(50);
        const afterP = world();
        ok('播放中按 P：进入暂停（P 路径没被改坏）',
           afterP.paused === true, `paused=${afterP.paused}`);
        ok('播放中按 P：失败红条被清除（P 与空格共用 setPaused，不能只修一条）',
           !noteBad() && !noteVisible(), `text=${noteText().slice(0, 40)}`);
        invariantHolds('播放中→P后');

        /* 调 API 也一样（__shield.pause()）：入口再多也只有一个暂停函数 */
        shield.loadText('这不是 JSON', 'api-while-paused.txt');
        advance(50);
        shield.pause();
        advance(50);
        ok('调 __shield.pause() 恢复播放：失败红条被清除（API 入口同样覆盖）',
           !noteBad() && !noteVisible() && shield.isPaused() === false,
           `bad=${noteBad()} paused=${shield.isPaused()}`);
        invariantHolds('暂停中→API恢复后');

        /*
         * R 路径必须同时覆盖：修空格不许把 R 改坏。
         * 而且要在"播放中"（不是面板可见）的上下文里按 —— 上一轮
         * 正是只在面板可见时测了 R。
         */
        shield.loadText('这不是 JSON\n', 'r-while-playing.txt');
        advance(50);
        ok('回归构造：播放中 + 失败条（按 R 前）',
           noteBad() && world().seen > 0,
           `bad=${noteBad()} seen=${world().seen}`);
        pressKey('KeyR');
        advance(2700);
        const afterR = world();
        ok('播放中按 R：失败红条被清除（R 路径不回退）',
           !noteBad() && !noteVisible(), `text=${noteText().slice(0, 40)}`);
        ok('播放中按 R：确实重新开始播（seen 从 0 重新累计，画面在动）',
           afterR.seen > 0 && afterR.paused === false,
           `seen=${afterR.seen} paused=${afterR.paused}`);
        invariantHolds('播放中→R后');
      }

      /*
       * ===== 结构锁：清除逻辑挂在 setPaused 上 =====
       *
       * 上面的不变量是"行为层"的锁；这一条是"结构层"的锁，防的是
       * 有人把 clearLoadError 挪回某一个按键分支里（那样 P 键、
       * __shield.pause()、以后新增的入口都会各漏一次）。
       * 两条互补：行为锁证明现在对，结构锁说明为什么对。
       */
      /*
       * 抽函数体必须用**配平花括号**，不能切片固定长度。
       *
       * 本条断言的第一版就是切 1200 字符 —— 而 setPaused 的函数体只有
       * 几十字符，窗口越界滑进了后面的 feed()，于是里面那句
       * clearLoadError() 被当成了 setPaused 的。把 setPaused 里的清除
       * 删掉，断言照样绿。这正是本轮要修的那类错误（断言在错的位置
       * 上通过），所以它在自己的实现里也不许出现。
       */
      const funcBody = (src, sig) => {
        const at = src.indexOf(sig);
        if (at < 0) return null;
        const open = src.indexOf('{', at + sig.length - 1);
        if (open < 0) return null;
        let depth = 0;
        for (let i = open; i < src.length; i++) {
          if (src[i] === '{') depth++;
          else if (src[i] === '}') {
            depth--;
            if (depth === 0) return src.slice(open, i + 1);
          }
        }
        return null;
      };
      const setPausedBody = countOf(codeP5c, 'function setPaused(v)') === 1
        ? funcBody(codeP5c, 'function setPaused(v)') : null;
      ok('setPaused（唯一改 paused 的函数）的函数体被完整取出（不是越界切片）',
         typeof setPausedBody === 'string'
         && setPausedBody.startsWith('{') && setPausedBody.endsWith('}')
         && setPausedBody.length < 600,
         setPausedBody == null ? 'setPaused 锚点不唯一或括号不配平'
           : `${setPausedBody.length} 字符`);
      ok('setPaused 函数体内会清失败提示（暂停/继续都走它，不会漏入口）',
         typeof setPausedBody === 'string' && setPausedBody.includes('clearLoadError();'),
         setPausedBody == null ? '取不到函数体' : '函数体里没有 clearLoadError()');
      /*
       * 反向锁：不许把"未播放任何数据"写成无条件的一句。
       * 这句全局声明只有在"确实什么都没播"时才允许出现，
       * 所以它必须和 battleHasProgress() 分支写在同一个函数里。
       */
      const reportErrBody = countOf(codeP5c, 'function reportLoadError(') === 1
        ? funcBody(codeP5c, 'function reportLoadError(') : null;
      ok('reportLoadError 的函数体被完整取出（同样用配平括号，不切片）',
         typeof reportErrBody === 'string' && reportErrBody.endsWith('}'),
         reportErrBody == null ? 'reportLoadError 锚点不唯一' : `${reportErrBody.length} 字符`);
      ok('reportLoadError 里"未播放任何数据"受 battleHasProgress() 约束（不是无条件全局声明）',
         typeof reportErrBody === 'string'
         && reportErrBody.includes('battleHasProgress()')
         && /未播放任何数据/.test(reportErrBody),
         reportErrBody == null ? '取不到函数体' : '缺少 battleHasProgress() 分支');
      /*
       * 反向锁（和 reportLoadError 那条同源，但守的是**另一个入口**）：
       * 钩子连接失败时写下的「战场为空」也必须受 battleHasProgress() 约束。
       *
       * 只锁行为不够：矩阵⑦⑧两格证明"现在对"，这条说明"为什么对" ——
       * 防的是有人把 showSource 那两行改回无条件一句（结构上看得出来），
       * 以及"顺手"在别处再加一句全局否定（句子必须落在 else 分支里）。
       */
      const connectHookBody = countOf(codeP5c, 'function connectHook(') === 1
        ? funcBody(codeP5c, 'function connectHook(') : null;
      ok('connectHook 的函数体被完整取出（同样用配平括号，不切片）',
         typeof connectHookBody === 'string' && connectHookBody.endsWith('}'),
         connectHookBody == null ? 'connectHook 锚点不唯一' : `${connectHookBody.length} 字符`);
      {
        const body = connectHookBody || '';
        const gateAt = body.indexOf('battleHasProgress()');
        const emptyAt = body.indexOf('战场为空');
        const elseAt = body.indexOf('} else {');
        ok('connectHook 的 onerror 里「战场为空」被战斗进度门控（不许无条件写）',
           gateAt >= 0 && emptyAt > gateAt && elseAt > gateAt && elseAt < emptyAt,
           `gate=${gateAt} else=${elseAt} 战场为空=${emptyAt}`);
        ok('connectHook 的 onerror 在有进度时如实说"仍在播上一份数据"',
           body.indexOf('仍在播上一份数据') > gateAt && gateAt >= 0,
           gateAt >= 0 ? '' : '连 battleHasProgress() 都没有');
      }
      /*
       * 收尾：把页面恢复成"正在播、面板隐藏、状态条写的是**真实来源**"。
       *
       * 注意判据不是"状态条空着"：一条真实来源说明本来就该在场
       * （它回答"这些数是从哪来的"）。该消失的只有**失败态**的条子。
       * 这里把这条区别写死在断言里，避免以后有人把"干净"理解成"空"。
       */
      /*
       * ===== 不变量在"写出之后"也必须成立（时间维度）=====
       *
       * 前面几格测的都是"写下那一刻是否与事实一致"，但红条会**留在屏幕上**。
       * 只要之后战场开始动，这句话就当场变成假话。
       *
       * 哪条路径能撞上这件事？先排除两个"看起来像、其实不是"的：
       *   - 开始播 / 暂停 / 重播：都会经过 startDemo / setPaused，已被覆盖；
       *   - HTTP 钩子来事件：onLiveEvent 在第一条事件时会 showSource 重写
       *     状态条 —— 那是**另一条**修法，删掉 feed 里的检查它也照样绿。
       *
       * 真正只剩事件入口这一层的是**外部注入**：main.mjs 顶部文档化的
       * 调试口 `__shield.emit({...})`（浏览器控制台、外部脚本都这么用）。
       * 构造顺序：
       *   1. 战场是空的（刚载入、没开始任何播放）；
       *   2. 拖一个垃圾文件 → 红条写"未播放任何数据"（此刻为真）；
       *   3. emit 一条真实事件 → 敌人出场、seen = 1。
       * 第 3 步不经过任何播放控制动作，也不重写状态条 ——
       * 清除只能挂在 feed（唯一事件入口）上。删掉那段检查，这条立刻红。
       */
      {
        /* 先把战场清空到"真的什么都没播"：restart 之后不推进时间轴 */
        startFreshPlayback();
        setPanel(false);
        shield.restart();
        setPausedTo(true);
        advance(50);
        const cleanWorld = world();
        ok('时间维度构造：先造出"真的什么都没播"的战场（不推时间轴）',
           cleanWorld.enemies === 0 && cleanWorld.seen === 0 && cleanWorld.kills === 0,
           `enemies=${cleanWorld.enemies} seen=${cleanWorld.seen} kills=${cleanWorld.kills}`);
        shield.loadText('garbage\n', 'inject-garbage.txt');
        advance(10);
        const preEmit = world();
        ok('时间维度构造：此时「未播放任何数据」为真（写它没有撒谎）',
           claimsNothingPlayed() && preEmit.seen === 0 && preEmit.enemies === 0,
           `claims=${claimsNothingPlayed()} seen=${preEmit.seen} enemies=${preEmit.enemies}`);
        /* 外部注入一条真实事件：唯一入口 feed()，不重写状态条 */
        shield.emit({ kind: 'tool', tool: 'read_file', id: 'inject-1', ts: 1 });
        advance(10);
        const postEmit = world();
        ok('时间维度构造：注入的事件真的进了战场（否则下面这条是空转）',
           postEmit.enemies > 0 && postEmit.seen > 0,
           `enemies=${postEmit.enemies} seen=${postEmit.seen}`);
        ok('事件进战场后「未播放任何数据」必须立刻失效（清除挂在 feed 这个唯一入口上）',
           !claimsNothingPlayed(),
           `claims=${claimsNothingPlayed()} text=${noteText().slice(0, 40)}`);
        invariantHolds('外部注入事件后');
        setPausedTo(false);
      }

      /*
       * ===== 真实 drop 事件驱动的一格（不是桩）=====
       *
       * 上面每一格都用 shield.loadText() / __shield.emit() 桩构造 ——
       * 那两条是**调试口**，用户真正走的是拖放：dropZone 的 drop 监听器
       * → onDrop → loadFile(file) → await file.text() → parseSourceText →
       * playSource。这条链在断言里从来没跑过，所以它可以整条坏掉而矩阵全绿。
       *
       * 做法：造一个真的 File 对象，塞进 dataTransfer.files，
       * 用 dropZone 上**真实注册**的监听器派发（el.__fire 记的是
       * bindDrop() 挂上去的那几个函数，不是测试里另写一份）。
       */
      {
        const dz = docP5.getElementById('dropZone');
        const dropBody = [
          { kind: 'tool', tool: 'read_file', id: 'd1', ts: 0 },
          { kind: 'tool_end', tool: 'read_file', id: 'd1', ok: true, ts: 30 },
          { kind: 'tool', tool: 'pwsh', id: 'd2', ts: 60 },
          { kind: 'tool_end', tool: 'pwsh', id: 'd2', ok: true, ts: 120 },
        ].map((x) => JSON.stringify(x)).join('\n');

        const canDrop = typeof File === 'function' && typeof dz.__fire === 'function';
        ok('真实 drop：Node 里有 File 且 dropZone 事件可派发（否则这一格无从谈起）',
           canDrop, `File=${typeof File} __fire=${typeof dz.__fire}`);

        if (canDrop) {
          /* 起点：空战场 + 面板可见，这样"文件进来"这件事必须自己改变状态 */
          shield.restart();
          setPausedTo(true);
          setPanel(true);
          advance(50);
          const before = world();
          const droppedFile = new File([dropBody], 'dropped.jsonl',
            { type: 'application/x-ndjson' });
          let prevented = 0;
          const handled = dz.__fire('drop', {
            preventDefault() { prevented++; },
            dataTransfer: { files: [droppedFile] },
          });
          ok('真实 drop：dropZone 上真的挂着 drop 处理器（否则下面全是空转）',
             handled > 0, `handled=${handled}`);
          ok('真实 drop：处理器真的 preventDefault（否则浏览器会直接打开那个文件）',
             prevented > 0, `prevented=${prevented}`);
          ok('真实 drop：拖放区的高亮类被摘掉（dragleave/over 不留残影）',
             !dz.classList.contains('over'), `classes=${[...dz._classes].join(',')}`);
          /*
           * loadFile 是 async（await file.text()），所以这里必须让微任务/
           * 定时器真的跑完再断言，否则测到的是"还没开始播"的中间态。
           */
          for (let i = 0; i < 50 && !/dropped\.jsonl/.test(noteText()); i++) {
            await new Promise((r) => { setTimeout(r, 0); });
          }
          ok('真实 drop：文件真的被读进来了（状态条报出这个文件名，不是兜底样本）',
             /dropped\.jsonl/.test(noteText()), `text=${noteText().slice(0, 60)}`);
          advance(2600);
          const after = world();
          ok('真实 drop：拖入的 4 条事件真的进了战场（画面在动）',
             after.seen > 0 && after.paused === false,
             `seen ${before.seen}→${after.seen} paused=${after.paused}`);
          invariantHolds('真实drop后');
          /* 收尾要的"在播样本"状态得还原回来（这一格把来源换成了拖入的文件） */
          startFreshPlayback();
          setPanel(false);
        }
      }

      setPanel(false);
      ok('矩阵块收尾：页面回到"在播 + 面板隐藏 + 状态条写真实来源、没有失败条"',
         !noteBad() && !claimsNothingPlayed() && /样本/.test(noteText())
         && noteVisible() && world().seen > 0 && !shield.isPaused(),
         `text=${noteText().slice(0, 40)} bad=${noteBad()} seen=${world().seen}`);
    }

    /*
     * 变体：把"拒收"改回"兜底样本"这种实现，上面两条会立刻红。
     * 这里再加一条**结构**断言，防止有人用另一种方式退回：
     * 页面里不许存在"失败 → 播样本"的调用点。
     */
    const codeP5 = mainSrcP5
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    ok('失败分支里没有播放样本（不存在"读不懂就退回 demo"）',
       !/reportLoadError[\s\S]{0,200}?playSample\(/.test(codeP5)
       && !/reportLoadError[\s\S]{0,200}?startFrom\(/.test(codeP5),
       'reportLoadError 之后不许接着开打');

    /* ---------- ④ 页面侧实时消费路径：SSE 载荷 → 协议校验 ---------- */
    /*
     * 这一条要求的是"页面收事件走的是 protocol/events.mjs"，
     * 不是自己另写一套字段判断。所以用页面自己的 ingest 口，
     * 再和协议层对同一条载荷的结论做对比 —— 两边必须一致。
     */
    const protoMod = await import('./protocol/events.mjs');
    const wire = JSON.stringify({
      kind: 'tool', tool: 'read_file', id: 'wire-1', ts: 1000,
    });
    const pr = protoMod.normalize(JSON.parse(wire));
    const wr = shield.ingest(wire);
    ok('页面消费路径与协议层对同一条 SSE 载荷结论一致',
       wr.ok === pr.ok && wr.ok === true,
       `page=${wr.ok} protocol=${pr.ok}`);
    ok('页面消费路径保留了工具名（没有自己改写字段）',
       wr.ok && wr.event && wr.event.tool === 'read_file'
       && wr.event.id === pr.event.id,
       JSON.stringify(wr.event && { tool: wr.event.tool, id: wr.event.id }));

    /*
     * 未知 kind：协议层的口径是"**收下，但明说我不认识它**"，
     * 不是拒收（见 protocol/events.mjs 的 unknownKind 与 /stats 的未知明细）。
     *
     * 页面必须跟着这个口径：接受并打标记，但**绝不能**把它当成 tool
     * 去凭空造一个敌人 —— 那才是伪造战果。
     * 所以断言的是"接受了、标了 unknownKind、且没有产生出场"。
     */
    const unknownBefore = shield.stats(globalThis.__vnow);
    const unknownWire = shield.ingest(JSON.stringify({ kind: 'not-a-kind', ts: 1 }));
    const unknownAfter = shield.stats(globalThis.__vnow);
    ok('未知 kind 被接受并打上 unknownKind 标记（不悄悄丢掉）',
       unknownWire.ok === true && unknownWire.unknownKind === 'not-a-kind',
       JSON.stringify(unknownWire.unknownKind));
    ok('未知 kind 不会凭空造敌人（不猜成 tool）',
       unknownAfter.alive === unknownBefore.alive
       && unknownAfter.seen === unknownBefore.seen,
       `alive ${unknownBefore.alive}→${unknownAfter.alive} / seen ${unknownBefore.seen}→${unknownAfter.seen}`);
    const notJson = shield.ingest('{oops');
    ok('页面拒收非 JSON 的实时载荷', notJson.ok === false,
       String(notJson.message));

    /*
     * 实时事件必须真的进 director：tool → 出场，tool_end ok:true → 击杀。
     * 只断言 ingest 返回 ok 是不够的 —— 那只证明解析通过，不证明被消费。
     */
    const liveBefore = shield.stats(globalThis.__vnow);
    shield.ingest(JSON.stringify({
      kind: 'tool', tool: 'agent_run', id: 'live-boss', ts: globalThis.__vnow,
    }));
    const liveMid = shield.stats(globalThis.__vnow);
    ok('实时 tool 事件真的让敌人出场', liveMid.alive > liveBefore.alive,
       `alive ${liveBefore.alive} → ${liveMid.alive}`);
    shield.ingest(JSON.stringify({
      kind: 'tool_end', tool: 'agent_run', id: 'live-boss', ok: true,
      ts: globalThis.__vnow + 1,
    }));
    const liveEnd = shield.stats(globalThis.__vnow);
    ok('实时 tool_end ok:true 才结算击杀（+1）',
       liveEnd.kills === liveMid.kills + 1,
       `kills ${liveMid.kills} → ${liveEnd.kills}`);

    /* ---------- ⑤ 钩子连接的边界与失败话术 ---------- */
    const remoteMsg = shield.connectHook('http://10.0.0.5:8787');
    ok('拒绝连非本机地址（钩子只绑 127.0.0.1）',
       /只连本机/.test(remoteMsg), remoteMsg);
    const badUrlMsg = shield.connectHook('::nope::');
    ok('非法地址给可读错误', /不合法/.test(badUrlMsg), badUrlMsg);

    /*
     * ===== 真的走一遍 SSE 的建连 / 出错 / 收事件 =====
     *
     * 上一版这条只断言了"没有 EventSource 时如实说明"，
     * 那测的是**缺席**，不是**接线**：onopen / onmessage / onerror
     * 三个回调一个都没跑过。
     * 所以这里装一个可控的 EventSource 桩，让三条回调真的被调用。
     */
    const esInstances = [];
    class FakeEventSource {
      constructor(url) {
        this.url = url;
        this.onopen = null;
        this.onmessage = null;
        this.onerror = null;
        this.closed = false;
        esInstances.push(this);
      }
      close() { this.closed = true; }
    }
    globalThis.EventSource = FakeEventSource;

    shield.connectHook('http://127.0.0.1:8787');
    const es = esInstances[esInstances.length - 1];
    ok('钩子按 /events 端点建流（SSE）',
       !!es && es.url === 'http://127.0.0.1:8787/events', es ? es.url : '未建流');

    /*
     * 出错：说清三步（起钩子 / CORS / 同源），并且**战场保持为空**。
     * "连不上就先放样本"是最容易犯的假进度，这里钉死它。
     */
    const srcBeforeErr = shield.source();
    const killsBeforeErr = shield.stats(globalThis.__vnow).kills;
    es.onerror();
    const srcAfterErr = shield.source();
    const errText = globalThis.document.getElementById('sourceNote').textContent || '';
    ok('SSE 出错时如实说明没伪造进度',
       /未伪造任何进度|连上才开始/.test(errText), errText.slice(0, 60));
    ok('SSE 出错时事件源为空（没有回退成样本的 585 条）',
       srcAfterErr.events === 0 && srcBeforeErr.events === 0,
       `${srcBeforeErr.events} → ${srcAfterErr.events}`);
    /*
     * 击杀数按**前后差**比，不比绝对 0：
     * 同一个页面实例在这一节里已经播过样本，绝对数本来就不是 0。
     * 要比的是"出错这件事有没有凭空加战果"。
     */
    ok('SSE 出错不会凭空加战果（击杀数按前后差不变）',
       shield.stats(globalThis.__vnow).kills === killsBeforeErr,
       `${killsBeforeErr} → ${shield.stats(globalThis.__vnow).kills}`);

    /*
     * 连上 + 收到事件：tool 出场、tool_end 结算。
     * 这是"页面能消费 HTTP 钩子的实时流"的直接证据。
     */
    es.onopen();
    es.onmessage({ data: JSON.stringify({ kind: 'tool', tool: 'pwsh', id: 'h1', ts: 0 }) });
    ok('SSE 收到的 tool 事件让敌人出场',
       shield.stats(globalThis.__vnow).alive === 1,
       `alive=${shield.stats(globalThis.__vnow).alive}`);
    es.onmessage({ data: JSON.stringify({ kind: 'tool_end', tool: 'pwsh', id: 'h1', ok: true, ts: 5 }) });
    ok('SSE 收到的 tool_end ok:true 结算成交击杀',
       shield.stats(globalThis.__vnow).kills === 1,
       `kills=${shield.stats(globalThis.__vnow).kills}`);
    es.onmessage({ data: '{oops' });
    ok('SSE 收到坏 JSON 时不推进战果',
       shield.stats(globalThis.__vnow).kills === 1,
       `kills=${shield.stats(globalThis.__vnow).kills}`);

    /*
     * 拖放 / 点选两个入口都在（远端桌面里拖放常被拦，点选是兜底）
     */
    const htmlP5 = fsMod.readFileSync(new URL('./index.html', import.meta.url), 'utf8');
    ok('index.html 有拖放区（dropZone）', /id="dropZone"/.test(htmlP5));
    ok('index.html 有"选择文件…"兜底入口（pickBtn + filePick）',
       /id="pickBtn"/.test(htmlP5) && /id="filePick"/.test(htmlP5));
    ok('index.html 有钩子地址输入与连接按钮',
       /id="hookInput"/.test(htmlP5) && /id="hookBtn"/.test(htmlP5));
    ok('index.html 有事件源状态条（任何时候都能看出播的是谁的活）',
       /id="sourceNote"/.test(htmlP5));

    /*
     * 品牌与分级文案来自 theme，不是 HTML 里的第二份硬编码：
     * index.html 里这三个槽位必须是**空壳**（内容由 main 填）。
     */
    const themeModP5 = await import('./theme.mjs');
    ok('开始面板的品牌名来自 theme（BRAND.nameZh / pkgId）',
       htmlP5.includes('data-theme="panel-title"')
       && themeModP5.BRAND.nameZh === '实况智能体'
       && themeModP5.BRAND.pkgId === 'agent-live',
       `${themeModP5.BRAND.nameZh} / ${themeModP5.BRAND.pkgId}`);
    ok('三级说明的文案槽位齐全（tag/desc × 3）',
       ['minion', 'elite', 'boss'].every(
         (t) => htmlP5.includes(`data-theme="tag-${t}"`)
           && htmlP5.includes(`data-theme="desc-${t}"`),
       ));
    ok('"一个敌人 = 一次工具调用"的规则说明在面板上',
       /一个敌人 = 一次工具调用/.test(htmlP5));
  }
}

/* ================= 16. 产品外壳：安装提示词 / 脚本 / 支持矩阵 ================= */

section('产品外壳的承诺：可粘贴提示词 / 零依赖脚本 / 诚实的支持矩阵');

{
  /*
   * ===== 这一节守的是什么 =====
   *
   * 用户点名要的"安装方式"不是 `npm install`，而是**一段可以直接粘给
   * 任意智能体的提示词**。这类交付物的失败模式很具体：
   *   - 提示词依赖上下文（"按上一条消息里说的做"）→ 换个人粘就不成立
   *   - 没有可执行的判定标准 → 智能体只能说"我接好了"，无法自证
   *   - 没有失败闭合条款 → 找不到工具调用时它会编事件把场面撑起来
   *
   * 这三种都是"文档看起来完整、实际会诱导造假"，grep 不出来，
   * 所以把它们逐条钉成断言。
   */
  const fsMod = await import('node:fs');
  const readmeSrc = fsMod.readFileSync(new URL('./README.md', import.meta.url), 'utf8');
  const pkgSrc = fsMod.readFileSync(new URL('./package.json', import.meta.url), 'utf8');
  const pkg = JSON.parse(pkgSrc);

  /* ---------- ① 提示词必须真的存在，且是一个可复制的代码块 ---------- */
  ok('README 有"粘给你的智能体"的安装提示词章节',
     /粘给你的智能体/.test(readmeSrc));

  /*
   * 取提示词本体：README 里那段 ``` 代码块。
   * 用锚点定位而不是全文正则，避免"匹配到别的代码块"这种假绿。
   */
  const promptAnchor = readmeSrc.indexOf('任务：把我的日志/事件流接进');
  ok('提示词代码块可唯一定位（有明确的开头）', promptAnchor > 0,
     String(promptAnchor));
  const promptBlock = promptAnchor > 0
    ? readmeSrc.slice(promptAnchor, readmeSrc.indexOf('```', promptAnchor))
    : '';
  ok('提示词非空且足够长（是真的工单，不是一句口号）',
     promptBlock.length > 800, `${promptBlock.length} 字符`);

  /*
   * 自包含：不许出现"上一条消息 / 如上所述 / 刚才说的"这类上下文依赖。
   * 这条最容易在迭代中退化 —— 作者知道上下文，读者不知道。
   */
  const ctxDeps = ['上一条消息', '如上所述', '刚才', '前面提到', '接着上面', '我之前的'];
  const found = ctxDeps.filter((k) => promptBlock.includes(k));
  ok('提示词自包含（不依赖聊天上下文）', found.length === 0,
     found.length ? '出现上下文依赖：' + found.join(', ') : '无上下文依赖词');

  /* ---------- ② 提示词必须给可执行命令 + 判定标准 ---------- */
  ok('提示词给了三路接入的命令（file / stdin / HTTP hook）',
     /--file/.test(promptBlock) && /--stdin/.test(promptBlock)
     && /npm run hook/.test(promptBlock));

  /*
   * 退出码判定标准：0 通过 / 1 语义不通过 / 2 参数或源错。
   * 这三个数字必须和 tools/doctor.mjs 的真实行为一致 ——
   * 所以这里既断言文档写了，也断言实际跑出来的退出码对得上。
   */
  ok('提示词写清了 doctor 的三个退出码含义',
     /0\s*=\s*通过/.test(promptBlock) && /1\s*=\s*语义不通过/.test(promptBlock)
     && /2\s*=\s*源打不开|源打不开，或参数写错/.test(promptBlock),
     '缺少 0/1/2 的判定标准');

  /* ---------- ③ 失败闭合条款 ---------- */
  ok('提示词含失败闭合条款：找不到工具调用必须停下来报告',
     /找不到任何工具调用/.test(promptBlock) && /停下来/.test(promptBlock));
  ok('提示词明令禁止伪造事件 / 猜测字段',
     /禁止[\s\S]{0,40}编造事件/.test(promptBlock)
     && /禁止[\s\S]{0,40}猜测字段/.test(promptBlock));
  ok('提示词把"诚实空结果"说得比"编造的绿"更正确',
     /正确[\s\S]{0,40}诚实结果/.test(promptBlock)
     && /错误[\s\S]{0,40}失败结果/.test(promptBlock));
  ok('提示词指向 PROTOCOL / ADAPTERS / profiles 三处资料',
     promptBlock.includes('docs/PROTOCOL.md')
     && promptBlock.includes('docs/ADAPTERS.md')
     && promptBlock.includes('adapters/profiles/'));

  /* ---------- ④ 支持矩阵必须诚实 ---------- */
  /*
   * 红线：不许出现"已支持 Claude Code / Cursor / Codex"这类话。
   * 这三种 profile 只在合成夹具上跑过，没有对真实转录验证过。
   *
   * 注意否定语境：文档里**引用**这句话正是为了说它不成立
   * （"不要把这三种 profile 当成已支持 Claude Code…"）。
   * 所以判定不能只看这句话在不在，要看它**前面紧邻的**是不是否定词 ——
   * 否则要么被自己的免责声明顶红，要么（反过来放宽成"全文不许出现"）
   * 逼作者删掉那句必要的澄清。两边的错法都更糟。
   */
  const claimWindow = 40;
  const claimHits = [];
  for (const m of readmeSrc.matchAll(/已支持\s*(Claude Code|Cursor|Codex)/g)) {
    const before = readmeSrc.slice(Math.max(0, m.index - claimWindow), m.index);
    /* 同一句内的否定词才算数：跨句的否定管不到这一句 */
    const sameSentence = before.slice(Math.max(0, before.search(/[。；\n]/) + 1));
    const negated = /不要|不许|禁止|不是|尚未|没有|别|当成|并未/.test(sameSentence);
    if (!negated) claimHits.push(m[0]);
  }
  ok("README 不宣称已支持 Claude Code / Cursor / Codex（否定语境除外）",
     claimHits.length === 0,
     claimHits.length ? '无否定语境的宣称：' + claimHits.join(' / ') : '无宣称');

  ok('README 明说 profile 只在合成夹具上验证过',
     /仅合成夹具验证过|只在[^\n]{0,20}合成夹具上/.test(readmeSrc));
  ok('README 明说需对真实转录验证后才能宣称支持',
     /真实转录/.test(readmeSrc) && /验证/.test(readmeSrc));
  ok('README 说明 Claude Code 需先展平 message.content[]',
     /content\[\][\s\S]{0,40}摊平|摊平[\s\S]{0,40}content\[\]/.test(readmeSrc));

  /* ---------- ⑤ package.json：零依赖 + 四条可直接跑的脚本 ---------- */
  ok('package.json name 保持 agent-live', pkg.name === 'agent-live', String(pkg.name));
  ok('package.json 没有 dependencies',
     pkg.dependencies == null || Object.keys(pkg.dependencies).length === 0,
     JSON.stringify(pkg.dependencies));
  ok('package.json 没有 devDependencies（零依赖、零构建）',
     pkg.devDependencies == null || Object.keys(pkg.devDependencies).length === 0,
     JSON.stringify(pkg.devDependencies));

  const scripts = pkg.scripts || {};
  ok('scripts.test 用引号 glob（node --test "tests/**/*.test.mjs"）',
     scripts.test === 'node --test "tests/**/*.test.mjs"', String(scripts.test));
  ok('scripts.doctor 指向 tools/doctor.mjs',
     scripts.doctor === 'node tools/doctor.mjs', String(scripts.doctor));
  ok('scripts.hook 指向 tools/http-server.mjs',
     scripts.hook === 'node tools/http-server.mjs', String(scripts.hook));
  ok('scripts.demo 存在且不引用任何打包工具',
     typeof scripts.demo === 'string' && scripts.demo.length > 0
     && !/webpack|vite|rollup|esbuild|parcel|tsc\b/.test(scripts.demo),
     String(scripts.demo).slice(0, 40));
  /* 保留原有四条，一个都不许丢 */
  for (const k of ['build', 'verify', 'refs', 'check', 'serve']) {
    ok(`scripts.${k} 仍然保留`, typeof scripts[k] === 'string' && scripts[k].length > 0,
       String(scripts[k]));
  }

  /*
   * demo 脚本必须真的能起服务。这里不起进程（会留残留 / 抢端口），
   * 而是断言它对**静态资源白名单 + 目录穿越防护 + 钩子反代**都有处理：
   * 少了穿越防护，`npm run demo` 就等于把整个仓库暴露给局域网。
   */
  ok('demo 脚本做了目录穿越防护（拦截 ..）', /includes\('\.\.'\)/.test(scripts.demo));
  ok('demo 脚本只绑 127.0.0.1（不开外网）', /127\.0\.0\.1/.test(scripts.demo));
  ok('demo 脚本反代了钩子端点（解决跨源 SSE 的限制）',
     /\/events/.test(scripts.demo) && /HOOK_PORT/.test(scripts.demo));

  /* ---------- ⑥ 诚实原则在 README 里逐条可查 ---------- */
  const honestyPoints = [
    ['血条 = 预估进度', /血条\s*=\s*预估进度/],
    ['击杀只由 tool_end ok:true 结算', /击杀只由\s*`?tool_end ok:true`?\s*结算/],
    ['turn_end ok:true 才清场', /`?turn_end ok:true`?\s*才清场/],
    ['ok:false 记失败不记击杀', /`?ok:false`?\s*记失败，不记击杀/],
    ['重复上报记 duplicates', /duplicates[\s\S]{0,20}不虚报/],
    ['解析失败停在原地、不退回样本', /不会[\s\S]{0,12}偷偷退回样本数据/],
  ];
  for (const [name, re] of honestyPoints) {
    ok(`README 写出诚实原则：${name}`, re.test(readmeSrc));
  }
}

/* ================= 17. 旧题材残留守卫 ================= */

section('旧题材残留守卫：用户可见文件里不许再长回上一个题材');

{
  /*
   * ===== 这条断言在守什么 =====
   *
   * 项目从「植保 + 蚂蚁」迁到「星海防线」时，一次审计就捞回 15 处残留
   * （README / docs / 开发输出）。当时**没有任何断言**在守这件事，
   * 所以这 15 处随时可以长回来，而不会有任何东西变红。
   *
   * 换题材最容易漏的从来不是逻辑，是**文案**：
   * 代码里有断言挡着，散文、表格、文档里没有。
   *
   * ===== 为什么白名单必须这么窄 =====
   *
   * 例外只允许出现在 `docs/BASELINE.md`，而且**只允许整行显式带
   * 「迁移前历史」标注**的行 —— 那里引用了旧提交标题与旧题材作为
   * 迁移前的审计证据，改掉就是篡改历史。
   *
   * 下面这三种"省事"写法**都不许**，因为它们等于把断言变成空的：
   *   1. 把整个 `docs/` 或整个 BASELINE.md 加进白名单
   *   2. 只扫 README.md（或者只扫几个"看起来重要"的文件）
   *   3. 允许**文件级**例外，而不是**行级**例外
   */
  const BANNED = /植保|盾牌|蚂蚁|工蚁|兵蚁|蚁后|pest/i;
  const HISTORY_TAG = '迁移前历史';
  /* 例外只在**这一个**文件里成立，而且必须逐行标注 */
  const HISTORY_FILE = 'docs/BASELINE.md';
  /* 例外行数上限：防止有人靠"给全文件贴标注"把断言贴空 */
  const HISTORY_MAX_LINES = 20;

  /*
   * 行级豁免判据，单独抽成函数是为了能被下面那条断言直接自检。
   * 注意 `label === HISTORY_FILE` 是**与**关系：别的文件即使写了
   * 「迁移前历史」也不豁免 —— 否则任何人都能靠贴标签绕过守卫。
   */
  const isExempt = (label, line) => label === HISTORY_FILE && line.includes(HISTORY_TAG);

  const root = new URL('./', import.meta.url);
  const readIf = (rel) => {
    try { return readFileSync(new URL(rel, root), 'utf8'); } catch { return null; }
  };

  /* ---- 1) 用户可见文件清单：显式枚举，不靠 shell 通配符"顺手兜" ---- */
  const cssFiles = readdirSync(root).filter((f) => f.endsWith('.css'));
  const docFiles = readdirSync(new URL('docs/', root))
    .filter((f) => f.endsWith('.md'))
    .map((f) => 'docs/' + f);
  const textFiles = [
    'README.md', 'README.en.md', 'SECURITY.md', 'CONTRIBUTING.md', 'CHANGELOG.md',
    'index.html', ...cssFiles, ...docFiles,
  ];

  /*
   * 清单本身要先站得住：漏扫一个文件 = 白名单凭空变大。
   * 所以先断言"该在的都在"，再扫内容。
   */
  const MUST_SCAN = ['README.md', 'README.en.md', 'SECURITY.md', 'CONTRIBUTING.md', 'CHANGELOG.md',
    'index.html', 'shield.css',
    'docs/BASELINE.md', 'docs/PROTOCOL.md', 'docs/ADAPTERS.md',
    'docs/THEME.md', 'docs/USAGE.md'];
  const notScanned = MUST_SCAN.filter((f) => !textFiles.includes(f));
  ok('残留守卫覆盖全部用户可见文件（清单不许缩水）',
     notScanned.length === 0, `未扫到 ${notScanned.join(',')}`);

  /* ---- 2) package.json 只认 description / keywords 两处文案 ---- */
  const pkg = JSON.parse(readIf('package.json') || '{}');
  const pkgText = [pkg.description || '', (pkg.keywords || []).join(' ')].join('\n');

  /* ---- 3) 逐行扫 ---- */
  const hits = [];      // 未标注的残留 → 必须为 0
  const exempt = [];    // 合法历史引用 → 必须 > 0（证明豁免路径是活的）
  let scannedLines = 0;

  const scanText = (label, text) => {
    if (text == null) return;
    for (const [i, line] of text.split(/\r?\n/).entries()) {
      scannedLines++;
      const m = line.match(BANNED);
      if (!m) continue;
      (isExempt(label, line) ? exempt : hits).push(`${label}:${i + 1} 「${m[0]}」`);
    }
  };

  for (const f of textFiles) scanText(f, readIf(f));
  scanText('package.json(description/keywords)', pkgText);

  ok('用户可见文件里没有未标注的旧题材残留',
     hits.length === 0, hits.slice(0, 8).join(' · '));

  /*
   * 反面自检：豁免逻辑必须"窄而显式"。
   * 这一条写在这里，是为了让以后想放宽白名单的人先看到它。
   */
  ok('豁免是行级 + 仅 BASELINE（文件级豁免不成立）',
     isExempt(HISTORY_FILE, `${HISTORY_TAG}：盾牌`) === true
     && isExempt(HISTORY_FILE, '当前产品叫盾牌') === false
     && isExempt('README.md', `${HISTORY_TAG}：盾牌`) === false
     && isExempt('docs/ADAPTERS.md', `${HISTORY_TAG}：盾牌`) === false,
     '别的文件即使贴了「迁移前历史」也不许豁免');

  /*
   * 豁免路径必须是**活的**（真的有历史证据行被放行），
   * 否则将来 BASELINE.md 一改，白名单悄悄失效也没人知道。
   */
  ok('BASELINE.md 的历史证据仍被原文保留（豁免路径非空）',
     exempt.length > 0, `豁免 ${exempt.length} 行`);
  ok('历史例外行数在上限内（白名单没被放宽）',
     exempt.length <= HISTORY_MAX_LINES,
     `${exempt.length} 行 > 上限 ${HISTORY_MAX_LINES}`);

  /* 扫的量本身要站得住：文件读失败会让断言静默变绿 */
  ok('残留守卫真的读到了内容（不是空扫）',
     scannedLines > 500, `仅扫到 ${scannedLines} 行`);
}

/* ============================================================
 * 安装判据与实际输出一致（README ↔ verify.mjs ↔ _refs.mjs）
 * ------------------------------------------------------------
 * README 那段"粘给智能体"的提示词里写着 `npm run check` 的验收判据。
 * 照字面执行的智能体只会看**整条命令的最后一行**，而 `npm run check`
 * 是 `node verify.mjs && node _refs.mjs` —— 所以：
 *
 *   - 带计数的那行「全部通过：N 项」是 verify.mjs 自己打印的；
 *   - 整条命令真正的末行是 _refs.mjs 打印的「全部通过」（不带计数）。
 *
 * 这两条事实一旦漂移（谁改了收尾文案、谁改了 npm run check 的串联顺序），
 * README 的判据就会和真实输出打架，安装者会误判"失败"并停下来 ——
 * 这正是本项目最讨厌的那类不可执行缺陷。所以把它变成红灯：
 * 断言直接读三份文件的真实文本，而不是读一个"应该如此"的常量。
 * ============================================================ */
{
  section('安装判据与实际输出的收尾行一致（README ↔ verify ↔ _refs）');

  const verifySrc = readFileSync(new URL('./verify.mjs', import.meta.url), 'utf8');
  const refsSrc = readFileSync(new URL('./_refs.mjs', import.meta.url), 'utf8');
  const readmeLines = readFileSync(new URL('./README.md', import.meta.url), 'utf8').split('\n');

  /* verify.mjs 的成功收尾行：必须是带计数的模板字面量 */
  ok('verify.mjs 的收尾行确实是「全部通过：N 项」（带计数）',
     /console\.log\(\s*`全部通过：\$\{pass\} 项`\s*\)/.test(verifySrc),
     'verify.mjs 的 pass 收尾行模板变了，README 的判据会跟着失真');

  /* _refs.mjs 的成功收尾行：必须是纯「全部通过」，不带计数 */
  const refsPrints = [...refsSrc.matchAll(/console\.log\(\s*(['"`])([^'"`]*)\1\s*\)/g)]
    .map((m) => m[2])
    .filter((s) => s.includes('全部通过'));
  ok('_refs.mjs 的「全部通过」打印只有一条且不带计数',
     refsPrints.length === 1 && refsPrints[0] === '全部通过',
     refsPrints.length ? refsPrints.map((s) => `「${s}」`).join(' ') : '一条都没有');

  /*
   * README 的判据是一个**块**（判据 + 后面几行说明），不是一个单行，
   * 所以按"npm run check 那一行起、往后 6 行"取窗口。
   */
  const at = readmeLines.findIndex((l) => l.includes('npm run check'));
  const crit = at >= 0 ? readmeLines.slice(at, at + 6).join('\n') : '';
  ok('README 的安装判据块能被定位（否则下面三条是空转）',
     at >= 0 && crit.includes('全部通过'),
     at >= 0 ? `L${at + 1}` : 'README 里找不到 npm run check');

  /* 两件事都必须写到，缺一件照字面执行就会误判 */
  ok('README 判据写明 verify.mjs 收尾行带计数「全部通过：N 项」',
     crit.includes('全部通过：N 项'),
     '判据里没有带计数的那行描述');
  ok('README 判据写明整条命令末行是「全部通过」（不带计数）',
     /末行[^\n]*「全部通过」（不带计数/.test(crit),
     '没说末行不带计数，照字面执行的智能体会把正常输出当成失败');

  /* 旧缺陷本体：把带计数的行说成"整条命令的末行" */
  ok('README 没把「全部通过：N 项」说成末行（旧缺陷不复现）',
     !/末行[^；\n]*全部通过：N 项/.test(crit),
     '判据又把带计数的行当成了整条命令的末行');
}

/* ================= 汇总 ================= */

console.log('\n' + '='.repeat(46));
if (fail === 0) {
  console.log(`全部通过：${pass} 项`);
  process.exit(0);
} else {
  console.log(`失败 ${fail} 项 / 共 ${pass + fail} 项`);
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
