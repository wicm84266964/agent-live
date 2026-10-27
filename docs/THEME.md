# 主题层（THEME）

> 一句话：**换题材 = 改 `theme.mjs` + 加一份点阵。**
> 不需要动 `director.mjs` / `render.mjs` / `main.mjs` 里的任何逻辑分支。

## 1. 这是什么

项目当前题材是 **星海防线**（太空科幻），品牌是 **实况智能体 / AgentLive**（包名 `agent-live`）。

「星海防线」是**题材**，不是**产品**。题材应该能换，所以所有题材相关的东西
都收进了 `theme.mjs` 一个文件。`verify.mjs` 第 16 节有一条**换主题冒烟测试**
在守这个承诺（见 §5）。

## 2. 导出清单

| 导出 | 作用 | 谁在用 |
|---|---|---|
| `BRAND` | 中文名 / 英文名 / 包名 / 题材名 / 定位一句话 | `main.mjs`（页面标题）、`index.html` |
| `PM_NAME` | 面板标题用的品牌名（= `BRAND.nameZh`） | `main.mjs` |
| `TIER_THEME` | 三级的显示名 / 单位名 / 单字缩写 | `bestiary.mjs`、`main.mjs` |
| `SPRITE_ROLES` | **角色 → sprite 键** 映射（含 `unknown` 兜底） | `sprites.mjs`、`render.mjs`、`bestiary.mjs` |
| `PALETTE` | 点阵调色板（**单字符键**） | `sprites.mjs` |
| `SLASH_COLORS` | 刀光冷白阶 / 处决暖金阶（**协议色值，不得改**） | `render.mjs`、`_refs.mjs` |
| `TIER_LABEL_COLORS` | 敌人名字按品级着色 | `render.mjs` |
| `COPY` | 全部可见文案 | `main.mjs`、`render.mjs` |
| `SIZE_THEME` / `SPEED_THEME` | 敌人尺寸 / 速度阶梯 | `bestiary.mjs` |
| `COMBAT_THEME` | 纯展示参数（主角比例、飘字上浮） | `render.mjs` |
| `THEME` | 以上各项的汇总对象 | 换主题冒烟测试 |
| `fill(tpl, vars)` | `{name}` 占位符填充 | `render.mjs`、`main.mjs` |
| `spriteKeyFor(role, theme?)` | 角色 → sprite 键（带兜底） | 测试 / 未来扩展 |
| `copyLeaves(theme?)` | 拍平全部可见文案（测试用） | `verify.mjs` |

## 3. 三级语义：数值锁死，只换显示名

`TIER = { MINION: 0, ELITE: 1, BOSS: 2 }` 定义在 `bestiary.mjs`，
数值是**排序与渲染尺寸的协议**，换皮时**不许改**。`theme.mjs` 只提供：

| 语义 | 数值 | 显示名 | 单位名 | 单字 |
|---|---|---|---|---|
| MINION | 0 | 侦察机 | 侦察无人机 | 侦 |
| ELITE | 1 | 突击舰 | 重装突击舰 | 突 |
| BOSS | 2 | 母舰 | 旗舰母舰 | 母 |

对应的 `SIZE_THEME` = 11 / 17 / 30（**严格递增**），
`SPEED_THEME` = 36 / 20 / 10（**严格递减**）。
两条阶梯都被 `verify.mjs` 钉死，数值可微调，关系不许破。

## 4. 换一个新题材要做什么

1. 改 `theme.mjs` 里的 `BRAND` / `TIER_THEME` / `COPY` / `PALETTE` / `SLASH_COLORS`。
2. 在 `sprites.mjs` 里按新的 `PALETTE` 重绘点阵，键名保持 `SPRITE_ROLES` 里那些
   （键名是协议稳定项，**换外观改点阵，不改键名**）。
3. 若新增了角色，才需要动 `SPRITE_ROLES` 并在 `sprites.mjs` 的 `RAW` 表里加一行。

**不需要碰**：`director.mjs`（战斗逻辑）、`render.mjs`（绘制算法）、`main.mjs`（装配）。
`verify.mjs` 第 16 节会直接扫这三个文件，出现题材字面量就红。

## 5. 换主题冒烟测试在证什么

位置：`verify.mjs` 第 16 节「换主题冒烟」。

它加载一份**内联假 theme**（"深海防线 / 深海探索者"，完全不同的用词），然后断言：

1. 全部可见文案槽位**逐一对应**（假 theme 少一个槽位就红 —— 那正是界面上会留一句旧文案的位置）；
2. 21 个「题材槽位」（标题/面板/分级说明/诚实声明/结算横幅/击毁飘字）**全部变掉**；
3. 变化条目占绝对多数（≥70%），防止"只改标题就说换了皮"；
4. `spriteKeyFor` 能按配置改出不同的 sprite 键，且查不到的角色落到 `unknown`；
5. `render.mjs` 里没有 `.aegisIdle` 这类硬编码取帧，兜底走 `ROLES.enemy.unknown`；
6. `main.mjs` / `render.mjs` 里**没有题材字面量**；
7. `director.mjs` 不 `import` theme，且同一份事件跑两次结算结果一致（**战斗逻辑与题材解耦**）。

### 它自己也能被击红（变异自测）

- 把 `copyLeaves()` 改成忽略入参 → 3 条断言红（含"变异自测"那条）；
- 把 `render.mjs` 的主角帧改回 `this.sprites.aegisIdle` → 「render.mjs 不按名取主角帧」红；
- 往 `main.mjs` 塞一句 `'击毁'` → 「main.mjs 里没有题材字面量」红；
- 让 `director.mjs` 私自 `import { COPY }` → 「战斗逻辑与题材解耦」红；
- 把结算横幅改回 `'任务完成 · 虫害肃清'` → 「render.mjs 里没有题材字面量」红。

> 注意：只改 `theme.mjs` 里的某个显示名，**全套检查仍然是绿的** ——
> 那正是设计目标（改配置就是允许的操作），不是漏洞。

## 6. 不许越界的地方

- `SLASH_COLORS` 的 6 个色值是**协议**（`verify.mjs` 逐字冻结）。`_refs.mjs` 的探针靠它
  把刀光从地面网格里认出来，改了会静默失效。
- `window.__shield` 的 13 个方法名、`aegis` 字段名、`_drawAegis` / `_slash` / `SWORD_TIP`
  都是协议，换皮不等于 churn 协议。
- 主题层**不许**影响结算：谁掉血、谁死、什么时候清场，全部在 `director.mjs`，
  由真实事件决定。换个主题不该让击杀数变一个。
