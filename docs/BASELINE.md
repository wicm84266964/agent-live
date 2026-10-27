# 基线冻结与锚点登记表（BASELINE）

> 本文件是重构期间的安全网：**先冻结基线，再动代码**。任何一次改动后，只要 `npm run check` 变红，
> 就回到本文件的锚点清单逐条比对，而不是放宽断言。
>
> **关于标注「迁移前历史」的行**：项目已从上一版题材迁移为「星海防线」（项目名：实况智能体 / agent-live）。
> 本文件中带 **〔迁移前历史〕** 标注的行，是**迁移前的原始审计记录**——引用的旧提交标题、
> 旧题材用词、旧判据原文都**按原样保留，不得修改或删除**（改了就是篡改历史证据）。
> 读到这些行时请理解为"迁移前它叫这个"，而不是"当前产品还叫这个"。
> `verify.mjs` 的残留守卫只放行本文件中带该标注的行，其它文件一律不许出现旧题材用词。

## 1. 基线快照

| 项 | 值 |
|---|---|
| 仓库 HEAD | `61c3c65` feat: 植保盾牌 — 真实事件驱动的智能体可视化（单提交仓库）**〔迁移前历史〕** |
| Node / npm | `v22.22.2` / `10.9.7`（`package.json` engines: node >= 18） |
| 依赖 | 零依赖（`dependencies` / `devDependencies` 均为空），无构建工具 |
| 验证命令 | `npm run check` = `node verify.mjs && node _refs.mjs` |
| 基线结果 | 退出码 **0**；`verify.mjs` **全部通过：267 项**；`_refs.mjs` **全部通过** |
| 工作区状态 | 与 HEAD 逐字节一致（`git diff HEAD` 为空），仅 `.lab-agent/` 未跟踪 |

`_refs.mjs` 内部不输出通过项数（只输出「有阻断问题」/「全部通过」二元结论），
因此「267 项」这一数字只来自 `verify.mjs`。

## 2. 文件规模（重构影响面）

| 文件 | 行数 | 职责 |
|---|---|---|
| `director.mjs` | 1543 | 事件 → 敌人状态机；唯一死亡判定点 `_settle` |
| `render.mjs` | 1449 | 战场 → canvas 绘制（只读状态，对敌人零写入） |
| `verify.mjs` | 2304 | 断言 267 项，含大量源码字符串锚点 |
| `_refs.mjs` | 1233 | DOM/Canvas 桩 + 真跑 `main.mjs` + 泵帧；未定义引用/死变量扫描 |
| `main.mjs` | 885 | 每帧编排；`window.__shield` 调试口 |
| `sprites.mjs` | 466 | 字符串点阵 + 单字符调色板 + `bake()` 烘焙 |
| `shield.css` | 301 | 像素风 UI；`:root` 颜色变量 |
| `build-events.mjs` | 282 | 会话分析产物 → `real-events.json`（现存 ETL 雏形） |
| `bestiary.mjs` | 202 | 工具 → 敌人品级映射单一真相源（`TIER`/`RULES`/`SIZE`/`SPEED`） |
| `index.html` | 85 | 入口：标题、HUD 骨架、开始面板 |
| `real-events.json` | 生成物 | `meta` + `events[]`；**任何改动都必须字节不变** |
| `sample/session-analysis.json` | 样本 | 原始会话分析，真实数据来源 |

## 3. 锚点登记表（重构期间不得破坏）

### 3.1 协议与契约（改了就大面积连带失败）

- `window.__shield`（`main.mjs:735`）挂载点与全部方法名：
  `emit, stats, enemies, log, aegis, arena, combat, fps, start, pause, restart, spriteCount, lightning`
  —— 被 `_refs.mjs:338`、`_refs.mjs:344` 的 `need` 列表与 `verify.mjs` 源码锚点依赖。
- 主角位置协议字段名 **`aegis`**：跨 `director.mjs`（约 45 处）、`main.mjs`、`render.mjs`、`verify.mjs:52-58`、
  `_refs.mjs:344/633/709/788`。**本轮不改名**，只允许让它在 theme 层可被重命名显示。
- `TIER = { MINION: 0, ELITE: 1, BOSS: 2 }` 数值（`bestiary.mjs:34-38`）不得改动。
- `DEMO_EVENTS`（`director.mjs` 末尾）必须继续存在（`verify` 有断言要求）。
- sprite 契约：`SPRITES` 键名、主角三帧（`aegisIdle/aegisWind/aegisStrike`）**同尺寸**、
  `SWORD_TIP` 剑尖在右（镜像时 `offRight > 0`、`|offRight + offLeft| ≈ 0`）、
  调色板 `PAL` 为**单字符键**、`spriteCount() >= 9`。

### 3.2 源码字符串锚点（verify 直接扫描源码）

`_shakeOffset(now, sAmt)` / `const k = trauma * trauma` / `function startDemo()` + `demoIndex = 0;` /
`hudWarn` → `hudDetail` 顺序 / FX 三处 / `spawnT` / `exec` / `execWeight` / `director` 的 `checkSource` 5 处 /
`bestiary` 3 个串。

> 风险：这类锚点一旦随重构位移，会退化成**恒真断言**（历史上已出现过 `slice(-1)` 只检查最后一个字符的事故）。
> 重锚时必须收紧为精确匹配（出现次数 + 关键内容），**不允许**改成「存在即通过」。

### 3.3 诚实不变量（产品红线，任何重构都不许破坏）

- 血条 = **预估进度**；血条归零敌人仍然活着（只是「比预估久了」）。
- **击杀只由真实事件结算**：`tool_end ok:true` 才记击杀；`ok:false` 记失败、不记击杀。
- `turn_end ok:true` 才清场；重复上报记 `duplicates`，不虚报战果。
- 真实数据回归：292 条调用 → 292 次结算；最高连击 38；击杀时刻 291 次；无重复。

## 4. 待重锚清单（P1 断言重锚）

| 目标 | 位置 | 现状 | 重锚方向 |
|---|---|---|---|
| sprite 名字面量断言 | `verify.mjs` 约 22 处 | 抄字面量 | 从 `sprites.mjs` / `bestiary.mjs` 派生 |
| sprite 存在性 need 数组 | `verify.mjs:833-839` | 硬编码 7 个名字 | 派生（保持集合语义） |
| 尺寸/像素数断言 | `verify.mjs:856-878` | 硬编码尺寸与像素数 | 派生，保留「ELITE ≥ MINION + 3」阶梯与像素下限 |
| sprite 数量下界 | `_refs.mjs:356` | `spriteCount() >= 9` | 改为派生下界 |
| 刀光三色 + 处决暖金两色 | `_refs.mjs:669-670`、`:784-785` | 硬编码 6 个色值 | `render.mjs` 导出 `SLASH_COLORS`（值与现有 6 色逐字相同），两侧改 import |
| 源码字符串锚点 | `verify.mjs` 约 13 处 `indexOf(`、1 处 `slice(-1)` 式 | 可能退化为恒真 | 收紧为精确锚点 |

## 5. 待修真实缺陷（P4）

| ID | 位置 | 缺陷 | 后果 |
|---|---|---|---|
| D1 | `main.mjs:248` | `r.tierName === 'BOSS'` 恒为假（`TIER_NAME` 是中文显示名如「蚁后」）**〔迁移前历史〕** | `killBoss` 震屏分支不可达，BOSS 与杂兵同震动 |
| D2 | `main.mjs:637` | `e.tier === 2` 裸数字，违反同文件注释 | 枚举顺序变动时静默失效，且当前无断言会红 |

**执行纪律**：D1/D2 都必须**先有能红的断言**（记录红色输出），再改代码变绿。
修法只能按 **`tier` 数值**比较（`e.tier === TIER.BOSS`），**不能**写成 `tierName === 'BOSS'`。

## 6. 每个阶段的收尾门（Gate）

1. `npm run check` 退出码 0，且**断言数不减少、语义不弱化**。
2. `node build-events.mjs` 后 `git diff --stat real-events.json` 为空（真实样本不被改动）。
3. 换题材冒烟：加载另一份 theme 配置即可改变全部可见文案与 sprite 映射，无需改逻辑文件。
4. 诚实不变量在真实数据上仍成立（第 3.3 节全部条目）。

## 7. 关联文档

- 计划包：`.lab-agent/plans/plan-20261027-020330-4a731e/`（`requirements.md` / `task-plan.md` / `execution-checklist.md`）

## 8. 重锚对照表（P1 已执行）

> 原则：断言只改**来源**，不改**语义**。每一条都写明「重锚前 → 重锚后」，
> 并声明语义有无变化。配合 3.1/3.2 的锚点登记表一起看。

### 8.1 sprite 断言（Step 1）

| # | 位置 | 重锚前语义 | 重锚后语义 | 语义变化 |
|---|---|---|---|---|
| 1 | `verify.mjs:913`（`need` 数组） | 7 个硬编码 sprite 名必须都在 `spriteDefs()` 里 | 主角帧 ← `SPRITES` 的 `aegis*` 键；敌人 sprite ← `rules()` 的 `sprite` 字段；兜底 ← `classify()` 真实返回。三者都必须有定义 | **更严**（原清单漏了 `alate`/`sapperAnt`） |
| 2 | `verify.mjs:~919`（新增） | — | 派生出的主角帧恰好 3 个 | 新增 |
| 3 | `verify.mjs:~921`（新增） | — | `unknown` 来自 `classify()` 且表里有定义 | 新增 |
| 4 | `verify.mjs:~952`（三帧同尺寸） | 逐字段比较 `aegisIdle/Wind/Strike` 的 w/h | 帧名由 `SPRITES` 派生，再断言 w 集合与 h 集合各只有 1 个元素 | 无 |
| 5 | `verify.mjs:~975`（兵蚁 > 工蚁） | `majorAnt.w >= fireAnt.w + 3` | `elite.w >= minion.w + 3`，品级→sprite 由 `RULES` 反查 | 无（间隔 3px 仍是显式设计常量）**〔迁移前历史〕** |
| 6 | `verify.mjs:~980`（蚁后最大） | `queen.w > majorAnt.w` | `boss.w > elite.w`，同样由 `RULES` 反查 | 无**〔迁移前历史〕** |
| 7 | `verify.mjs:1000`（盾牌像素） | `aegisIdle.px > 100` | `aegisFrames[0].px > max(100, floor(w*h/8))` | 无（**修正后**；见 8.6 的踩坑记录）**〔迁移前历史〕** |
| 8 | `verify.mjs:1003`（工蚁像素） | `fireAnt.px > 40` | `minionSprite.px > max(40, floor(w*h/8))` | 无（**修正后**；见 8.6）**〔迁移前历史〕** |
| 9 | `verify.mjs:148`（兜底 sprite） | `u.sprite === 'unknown'` | 兜底 sprite == `classify('')` 的 sprite，且它在 `SPRITES` 里有定义 | **更严**（原来只比名字，现在要求有定义） |
| 10 | `_refs.mjs:365`（sprite 数量） | `spriteCount() >= 9` | `spriteCount() >= Object.keys(SPRITES).length` | **更严**（下界随真相源走，不再写死 9） |

**未能重锚（如实列出）**：无。

### 8.2 特效色值（Step 2）

| # | 位置 | 重锚前语义 | 重锚后语义 | 语义变化 |
|---|---|---|---|---|
| 11 | `_refs.mjs:669-670` | 探针匹配 6 个色值字面量 | `SLASH_COLORS.blade.concat(SLASH_COLORS.exec).includes(...)` | 无 |
| 12 | `_refs.mjs:784-785` | 同上 | 同上 | 无 |
| 13 | `verify.mjs:2578`（新增） | — | 6 个色值逐字冻结为契约（`#5a6470/#cdd8e0/#ffffff`、`#8a5a2a/#e8a24a/#fff4d6`） | 新增（**必要**：见下方风险） |
| 14 | `verify.mjs:2599`（新增） | — | `_slash` 方法体里不残留这 6 个字面量 | 新增 |

> **风险与补偿**：`_refs` 改为 import `SLASH_COLORS` 后，探针与实现永远一致，
> 「改色」这件事在 `_refs` 里**不再可能被发现**（实测验证：把 `#5a6470`
> 改成 `#5a6471`，`_refs` 仍然「全部通过」）。
> 补偿是把色值冻结成契约挪到 `verify.mjs`，实测同一变异会红
> （`FAIL 刀光三色逐字不变`）。没有这条补偿，第 11/12 条就构成语义弱化。

### 8.3 源码锚点收紧（约 13 处 `indexOf` / 1 处 `slice(-1)` 相邻）

新增两个共用助手（`verify.mjs:44` `countOf()` / `verify.mjs:63` `anchorOf()`），
语义统一为「恰好出现一次才拿去定位」，避免 `indexOf === -1` 让位置比较
或 `slice(-1)` 退化成恒真。

| # | 位置 | 重锚前语义 | 重锚后语义 | 语义变化 |
|---|---|---|---|---|
| 15 | `verify.mjs:1519` | `_shakeOffset(now, sAmt)` 找得到就截 1200 字符 | 签名**恰好出现 1 次**才定位 + 单独一条断言 | **更严**（无法定位时不再静默） |
| 16 | `verify.mjs:1609` | `_flashAlpha` 切 4000 窗口 + 3 个 OR 分支 | 按唯一调用点 `this._flashAlpha(e, now)` 定位；`source-atop` 与 `'lighter'` 都只在该窗口的**代码**里判 | **更严**（去掉 OR 兜底；剥注释） |
| 17 | `verify.mjs:1641` | `_flashAlpha(e, now) {` 找得到就截 | 签名恰好 1 次 + 独立断言 | **更严** |
| 18 | `verify.mjs:1802` | `ctx.arc(e.x, e.y + h * 0.30` / `dying ? ...` 各 `> 0` | 两个锚点各自恰好 1 次（独立断言）+ 位置比较 | **更严** |
| 19 | `verify.mjs:1902` | `hudWarn/hudDetail.textContent` 各 `> 0` 且顺序 | 各自恰好 1 次（两条独立断言）+ 顺序 | **更严** |
| 20 | `verify.mjs:2027` | `window.__shield = {` 存在即可 | 恰好 1 次 + 窗口非空（> 500 字符） | **更严**（正是 `slice(-1)` 事故的同类防线） |
| 21 | `verify.mjs:2445` | `startDemo()` 与 `demoIndex = 0;` 拼窗口 | 函数定义恰好 1 次；改为查**函数体内**的 `demoIndex = 0;`（全文出现 2 次是正常的：声明+重置）；窗口非空 | **更严**（原先锚点漂移会红得莫名其妙） |
| 22 | `verify.mjs:2597` | —— | `_slash` 完整签名恰好 1 次才定位（`_slash(ctx, ` 在调用点也命中） | 新增 |

### 8.4 D1 / D2（Step 3，先红后绿）

| # | 位置 | 断言内容 |
|---|---|---|
| 23 | `verify.mjs:2444`（新增） | `main.mjs` 从 `bestiary.mjs` 导入 `TIER` |
| 24 | `verify.mjs:2451` | **D1 正向**：存在 `.tier === TIER.BOSS` 比较 |
| 25 | `verify.mjs:2461` | **D1 反面**：不允许 `tierName === 'BOSS'` 这类显示名比较（防"修成字符串比较"） |
| 26 | `verify.mjs:2469` | **D2**：不允许 `.tier === <裸数字>` |
| 27 | `verify.mjs:2475` | `TIER.BOSS === 2`（枚举数值不得改动） |
| 28 | `verify.mjs:2477` | `TIER_NAME[TIER.BOSS] !== 'BOSS'`（把 D1 的根因钉住） |
| 29 | `verify.mjs:2481` | 三个品级都能从 `RULES` 反查到 sprite |

行为探针：`.lab-agent/evidence/d12/boss-shake-probe.mjs`
—— 桩掉 `Renderer.prototype.draw`，记录 `main` 交接的 `s.trauma`。

### 8.5 断言计数

| 阶段 | `npm run check` | verify 通过项 |
|---|---|---|
| 基线（Start） | 0 | 267 |
| Step 2 后 | 0 | 267 |
| Step 3 后（D1/D2 绿） | 0 | 277 |
| Step 1 + 锚点收紧完成后 | 0 | 293 |
| **复查修正像素下限后** | **0** | **293** |

> **阶段标注（后补，不改写上方历史值）**：上表是那次审计当期的快照。
> 此后断言数继续只增不减地增长，当前为 **531 项**（`npm run check` exit 0）。
> 读这张表时请按"当时的阶段"理解，不要拿它当当前值。

断言数只增不减。

### 8.6 复查记录：一次真实的「重锚顺手放宽」（已修正）

复查 8.1 第 7/8 条时发现，第一版重锚**确实弱化了语义**，
而且当时代码注释与本文档都声称「语义无变化」——**那是错的**：

| 项 | 原判据 | 第一版重锚判据 | 实际效果 |
|---|---|---|---|
| 盾牌像素 | `px > 100` | `px > floor(26*26/8) = 84` | 一个只剩 85 px 的盾牌**原本会红，重锚后能过** **〔迁移前历史〕** |
| 工蚁像素 | `px > 40` | `px > floor(12*12/8) = 18` | 只剩 41 px 的工蚁变成 19 px 仍能过 **〔迁移前历史〕** |

根因：把**绝对下限**换成了**比例下限**，二者守的不是同一件事，
不能互相替代：

- 绝对下限 = 「这个 sprite 至少得画出这么多不透明像素」→ 设计契约
- 比例下限 = 「填充率别太稀」→ 形态契约

修正：取**两者更严者**（`max`），并保留从真相源派生的 sprite 键：

```js
const HERO_MIN_PX = 100;   // 原判据，不得放宽
const MINION_MIN_PX = 40;  // 原判据，不得放宽
const pxFloor = (n, absFloor) =>
  Math.max(absFloor, Math.floor(g(n).w * g(n).h / 8));
```

修正后 `npm run check` 仍为 293 项全绿（说明当前 sprite 同时满足两条契约），
而语义已恢复为「不弱于原始判据」。

> **教训（写进纪律）**：重锚时若把「常量」换成「公式」，必须显式列举
> 该公式在**当前取值**与**退化取值**下是否都比原常量更严。只验证
> 「现在还是绿的」不足以证明语义没放松 —— 绿只说明当前数据满足它。

