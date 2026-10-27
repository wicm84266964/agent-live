# 实况智能体 · agent-live

English overview: [README.en.md](README.en.md).

> 把智能体跑任务的过程，变成一场可观看的星海防线实况战斗 —— 等待不再无聊。
> **真实事件驱动，绝不伪造进度。**

零依赖、零构建。纯 ES module + Canvas 2D。`npm install` 不需要，仓库里没有依赖。

---

## 把下面这段提示词粘给你的智能体

> 复制下面代码块里的**全部内容**，整段发给你的智能体（Claude Code / Codex / Cursor / 自研 agent 都行）。
> 它不依赖你和它的任何聊天上下文，自身就是一份完整工单。

```
任务：把我的日志/事件流接进「实况智能体」(agent-live)，让它能实时看着我的工具调用打一场
星海防线实况战斗。项目根目录 = 本仓库根目录（含 package.json，name 必须是 "agent-live"）。
零依赖、零构建：不要 npm install，不要引入任何打包工具。

【一、先做的事（不要跳过）】
1) 确认项目就位：
     node -e "console.log(require('./package.json').name)"   # 必须输出 agent-live
     npm run check                                          # 必须 exit 0；判据看下面两行，别只看末行：
     #   - verify.mjs 的收尾行会打印「全部通过：N 项」（带计数，N 就是断言数）
     #   - 整条命令的末行是 _refs.mjs 打印的「全部通过」（不带计数，这是正常的）
     # 两行都出现、且 exit 0 才算通过；出现 FAIL 或报错就停下报告
   如果这两条不成立，停下来报告，不要继续。
2) 找到我这份智能体自己的日志/转录文件（或事件流）。必须先亲眼看一遍它的**真实格式**。

【二、三路接入，选一条（推荐文件通道起步）】
A. 本地文件（最省事，支持增量 tail）
     npm run doctor -- --file <我的日志路径>
     加 --profile 做字段映射（模板见 adapters/profiles/*.json）：
     npm run doctor -- --file <路径> --profile <profile名或profile文件路径>
B. 管道 stdin（智能体能往 stdout 吐 JSONL 时最合适）
     <我的智能体命令> | node tools/doctor.mjs --stdin
     或： <我的智能体命令> | node tools/doctor.mjs --stdin --profile <名字>
C. HTTP hook（要"边跑边看"就用这条）
     npm run hook                                  # 起钩子，默认 127.0.0.1:8787
     # 我的每一条事件：
     curl -X POST http://127.0.0.1:8787/event -H "content-type: application/json" -d "<事件JSON>"
     # 然后另开窗口起页面：npm run demo ，页面里钩子地址填 http://127.0.0.1:5173

【三、事件必须是这个形状（不要发明字段）】
   {"kind":"tool",     "tool":"<工具原始名>", "id":"<调用唯一ID>", "ts":<毫秒时间戳>}
   {"kind":"tool_end", "tool":"<工具原始名>", "id":"<调用唯一ID>", "ok":true|false, "ts":<毫秒>, "realMs":<耗时毫秒，可选>}
   {"kind":"turn_end", "ok":true|false, "ts":<毫秒>}
   - id 必须成对：同一次调用的 tool 和 tool_end 用同一个 id。少了 id 就没法配对。
   - ts 必须是真实发生时刻（毫秒）。**不要**用"当前时间"顶替历史事件的时刻。
   - 未知 kind 会被收下并计入 unknownKinds，但**不会**被当成工具调用 —— 不要指望它推进战斗。

【四、判定标准（这就是验收，别看画面像不像）】
   npm run doctor -- --file <路径>       退出码含义：
     0 = 通过（协议合法 + id 全配对 + 无坏记录 + 无未知 kind）
     1 = 语义不通过（配对漏了 / 有坏记录 / 有未知 kind / 重复上报）
     2 = 源打不开，或参数写错（路径不存在、--file 后面没跟值、不认识的参数）
   要求：必须拿到 0。拿到 1 就按输出里逐条列出的问题去修（输出会说明是哪个 id、
   哪条记录、哪种 kind）。拿到 2 先修路径/参数。

【五、失败闭合条款（硬约束，优先级高于"把活干完"）】
   如果在我的日志/转录里**找不到任何工具调用**（找不到可识别的 tool / tool_end，
   或加了 --profile 之后仍是大量 no-rule-matched / missing-tool），你必须：
   1) 立刻停下来，如实报告"这份日志里没有我能识别的工具调用"；
   2) 附上证据：doctor 的原始输出、你实际看到的日志前几行（脱敏，别贴密钥）；
   3) 说明你试过哪些 profile、哪些字段路径，为什么都不匹配。
   **禁止**编造事件、**禁止**猜测字段含义、**禁止**把别的字段硬映射成 tool/tool_end
   来让 doctor 变绿、**禁止**为了让画面动起来而手写一份"看起来像"的事件流。
   一份空的或只有 turn_end 的结果，是**正确**的诚实结果；一份编造的事件流是**错误**的
   失败结果 —— 后者比不做更糟。

【六、卡住了看这两份文档（不要凭猜测改字段）】
   docs/PROTOCOL.md    —— 字段表、约束、id 配对规则、诚实语义红线
   docs/ADAPTERS.md    —— 三路通道的细节、映射层配置格式、逐家接入手册
   adapters/profiles/*.json —— 字段映射模板（claude-code / codex / cursor），照抄改路径
   注意：Cursor 的 profile 仅合成夹具验证过。claude-code 与 codex-session
   各对照过一份本机转录（doctor exit 0，id 配对完美），这不是对所有版本的保证。
   用它们之前先拿你自己的真实转录跑 doctor 验证，别假定它一定能用。
   如果你的智能体是自研的，最省事的做法是让它**直接按第三节的形状吐事件**，
   跳过映射层，出错面最小。

【七、交付时报告】
   - 用了哪条通道（A / B / C），用什么命令跑的
   - doctor 的退出码，以及关键几行（事件数 / 分类型 / id 配对率 / 未知 kind）
   - 如果没接成：卡在哪一步、doctor 说了什么、下一步需要我提供什么
```

---

## 它是什么

一场**由真实事件驱动**的战斗，用来把"等智能体跑完"这段空转时间变得可观看。

| 你的智能体 | 画面上的事 |
|---|---|
| 一次工具调用开始（`tool`） | 一个敌人出场，按工具类型分档次 |
| 一次调用结束（`tool_end`） | 该敌人被击毁；`ok:false` 记作**失败**，不记击杀 |
| 一轮结束（`turn_end ok:true`） | 全场清场，插胜利横幅 |
| 什么都没有 | 画面什么都不发生（**这是正确行为**） |

零依赖、零构建：`git clone` 之后直接 `npm run demo`。没有 `npm install` 这一步。

```bash
npm run demo          # 起本地静态服务并打印打开地址（默认 5173）
```

打开页面后有三个入口：

| 入口 | 怎么用 | 播的是什么 |
|---|---|---|
| **进入战场**（一键演示） | 什么都不用准备 | 仓库自带的真实样本会话（292 次工具调用） |
| **拖入分析文件** | 拖 `.json` / `.jsonl` 进框，或点「选择文件…」 | 你自己的会话 |
| **连接 HTTP hook** | 先 `npm run hook`，再填地址点「连接」 | 你的智能体**正在跑**的实时事件流 |

拖入支持三种文件：`session-analysis.json`（会话分析产物）、`real-events.json`
（`{meta,events:[...]}` 形状）、以及一行一条事件的 `.jsonl`。判定看内容不看扩展名。

---

## 三路接入：最小可用命令

### A. 本地文件（推荐起步）

```bash
# 1) 先自检：能不能读、协议合不合法、id 配不配得上
npm run doctor -- --file ./my-agent-log.jsonl

# 2) 字段名对不上时，加 profile 做映射（模板见 adapters/profiles/*.json）
npm run doctor -- --file ./my-agent-log.jsonl --profile ./adapters/profiles/claude-code.json

# 3) 自检通过后，把同一份文件拖进页面即可播放
```

支持三种文件形态，按**内容**判定（不看扩展名）：`{meta,events:[...]}`、
纯事件数组、`.jsonl`。`jsonl` 走**字节偏移增量读取**，只读新追加的部分，
所以适合边跑边追。

### B. 管道 stdin（智能体能吐 JSONL 时最合适）

```bash
# 自检
<你的智能体命令> | node tools/doctor.mjs --stdin

# 带映射
<你的智能体命令> | node tools/doctor.mjs --stdin --profile codex
```

### C. HTTP hook（边跑边看）

```bash
npm run hook                                  # 钩子：127.0.0.1:8787（只绑本机）
npm run demo                                  # 页面：127.0.0.1:5173

# 每一条事件（也可以一次 POST 一批：数组 或 {"events":[...]}）
curl -X POST http://127.0.0.1:8787/event \
  -H "content-type: application/json" \
  -d '{"kind":"tool","tool":"read_file","id":"c1","ts":1730000000000}'
```

页面里的钩子地址填 **`http://127.0.0.1:5173`**（不是 8787）。

**为什么要填 5173 —— 这是如实说明的限制**：钩子服务
（`adapters/http-hook.mjs`，本轮未改动）出于安全考虑**不发送
`access-control-allow-origin`** 头，浏览器在跨源（8787 → 5173）读取 SSE 时
会拦掉响应体。所以 `npm run demo` 起的静态服务同时反向代理了
`/event` `/events` `/stats` `/health` 到钩子端口（默认 8787），
页面与钩子因此是**同源**的，没有 CORS 问题。

| 场景 | 能实时看吗 | 说明 |
|---|---|---|
| `npm run demo`（页面 5173，钩子 8787） | ✅ | 静态服务已把三个钩子端点反代到同源 |
| 直接用 `npm run serve`（python http.server，无代理） | ⚠️ | 跨源，浏览器会拦 SSE；页面会如实报错，**不会**回退成样本数据 |
| 用别的静态服务器且不做反代 | ⚠️ | 同上 |

反向代理端口可用 `HOOK_PORT` 改（钩子不在默认 8787 时）：
`PORT=5300 HOOK_PORT=9000 npm run demo`。

---

## 自检：`npm run doctor` 的退出码

`npm run doctor -- <参数>` 是这套东西唯一的"合不合格"判定入口，
它和页面走**同一个**协议校验器（`protocol/events.mjs`），所以
"doctor 说合格"和"页面能播"是同一套标准。

| 退出码 | 含义 | 典型原因 | 下一步 |
|---|---|---|---|
| **0** | 通过 | 协议合法、id 全配对、无坏记录、无未知 kind | 可以接页面了 |
| **1** | 语义不通过 | id 配对不全（孤儿 tool / 孤儿 tool_end）、坏记录、未知 kind 过多、重复上报 | 按输出逐条修映射或补齐字段 |
| **2** | 源打不开 / 参数错 | 路径不存在、`--file` 后没跟值、不认识的参数 | 修路径或参数 |

```bash
npm run doctor -- --file real-events.json ; echo "exit=$?"
#   事件总数    585
#   分类型      tool 292 / tool_end 292 / turn_end 1
#   未知 kind   0
#   坏记录      0
#   id 配对     292/292（100.0%） 完美
#   重复上报    0 个 id（多出 0 条）
#   结论        通过
# exit=0
```

加 `--json` 可拿到机器可读的完整报告（适合塞进 CI）。

---

## 诚实原则（产品红线）

这几条不是文档修辞，是代码里被断言钉住的行为。**任何一个字都不许改意思**：

1. **血条 = 预估进度，不是血量。** 血条归零只表示"这次调用比预估更久了"，
   敌人**照样推进、照样活着**。它不会因为血条空了就死。
2. **击杀只由 `tool_end ok:true` 结算。** 没有第二条路径能让敌人消失 ——
   渲染层不做"看起来该死就让它死"的判断。
3. **`turn_end ok:true` 才清场。** `ok:false` 的收尾意味着这一轮没正常结束，
   残敌留在场上。
4. **`ok:false` 记失败，不记击杀。** 失败有自己的视觉效果（暗红小字、不上浮），
   刻意做得比击杀**弱** —— 失败不该有成就感。
5. **重复上报记 `duplicates`，不虚报战果。** 同一个 id 的 `tool_end` 到第二次，
   计数进 `duplicates`，不会多算一次击杀。
6. **解析失败就停在原地。** 拖入一份读不懂的文件时，页面给出可读错误，
   **不会**偷偷退回样本数据。画面继续动、数继续涨、而你看的其实是别人的数据 ——
   这是本项目最不能犯的错。
7. **未映射 / 超时两个数字永不隐藏。** 它们一旦非零，就是"有工具没被识别"
   或"有任务超了预估"。藏在展开层里等于假报告，所以它们常驻运行态。

页面上的**事件源状态条**（左下角）随时告诉你在播哪份数据：源名、调用数、
被拒收的记录数、坏行数、未知 kind。播的是谁的活，永远看得见。

---

## 支持矩阵（如实版）

**结论先说：目前没有任何一家第三方智能体被宣称"已支持"。**

| 接入方式 | 状态 | 怎么验证它对你可用 |
|---|---|---|
| **自研 / 直接吐协议形状** | ✅ 可用 | `npm run doctor -- --stdin` 拿 exit 0 |
| `real-events.json` / 事件数组 / `.jsonl` 文件 | ✅ 可用 | `npm run doctor -- --file <路径>` 拿 exit 0 |
| HTTP hook（`POST /event`） | ✅ 可用 | `curl` 打一条，`/stats` 里 `accepted` +1 |
| `adapters/profiles/codex.json` | ⚠️ `codex exec --json` 的 `item.started` / `item.completed` 形状，合成夹具验证过 | 你的真实转录仍要跑 doctor |
| `adapters/profiles/codex-session.json` | ⚠️ 会话卷 `item_completed`。一份本机会话 doctor exit 0，140/140 配对 | 没有显式 `exit_code` / `status` 的记录会跳过并计数 |
| `adapters/profiles/cursor.json` | ⚠️ **仅合成夹具验证过** | 不要把它读成已支持 Cursor |
| `adapters/profiles/claude-code.json` | ⚠️ doctor 会先把 `message.content[]` 摊平。一份本机转录 196/196 配对 | `is_error` 缺省按 profile 记成功，doctor 会单列 `absent-success` |

关于这些 profile 的实话：

- **Claude Code**：`npm run doctor -- --file <transcript.jsonl> --profile claude-code`
  会先把 `message.content[]` 摊平，再映射。一份本机转录跑出 196/196 配对、exit 0。
  `is_error` 不在时，profile 写明的 `absent=success` 会记成功，doctor 单列
  `absent-success` 的条数。这不是对所有 Claude Code 版本的保证。
- **Codex 会话卷**：`--profile codex-session`。只投影带显式 `exit_code` 或
  `status=completed|failed` 的 `item_completed`（CommandExecution / McpToolCall / FileChange）。
  一份本机会话卷 140/140 配对。ImageView 这类没有成败字段的记录会跳过。
  `codex exec --json` 的实时流仍用 `--profile codex`，那条只在合成夹具上验证过。
- **Cursor**：仅合成夹具验证过。不要把它读成已支持 Cursor。
- 因此：**不要**把这些 profile 当成"已支持 Claude Code / Cursor / Codex"的完成声明。
  你自己的真实转录跑出 doctor exit 0 之前，它们都还是模板。

最省事、出错面最小的路子始终是：**让你的智能体直接按协议形状吐事件**，
完全跳过映射层。

---

## 开发与验证

```bash
npm run demo      # 起页面（零依赖本地静态服务，含钩子反代）
npm run test      # 单元测试（node --test；条数以输出 `# pass` 行为准，不在此写死）
npm run check     # 全部静态 + 行为断言（verify + _refs；截至本次交付：403 项）
npm run verify    # 只跑诚实性断言（verify.mjs）
npm run refs      # 只跑"真跑一遍渲染循环 + 未定义引用检查"（_refs.mjs）
npm run build     # 从 sample/ 重新生成 real-events.json（含自检）
npm run doctor    # 事件源自检（见上面的退出码表）
npm run hook      # 起 HTTP 事件钩子（127.0.0.1:8787）
npm run serve     # 纯静态服务（python，无钩子反代）
```

> `npm run test` 必须写成 `node --test "tests/**/*.test.mjs"`（带引号的 glob）。
> `node --test tests` 在 Node 22 上会把目录当成模块去加载然后失败。

验证的立场：这些断言不检查"有没有报错"，而检查**它会不会造假**。
每条新断言都做过"改坏代码必须变红"的变异自测 —— 包括本轮新增的
"拖入非法文件不许伪造进度"和"钩子出错不许回退样本数据"。

---

## 文件

| 文件 | 职责 |
|---|---|
| `index.html` | 开始面板 / 落地页（品牌、三个入口、分级说明；文案由 theme 填充） |
| `main.mjs` | 每帧：喂事件 → 推进战斗 → 画；三路事件源接入 |
| `director.mjs` | 事件 → 敌人；**唯一的死亡判定处** |
| `render.mjs` | 战场 → 画布（纯表现，不改任何状态） |
| `sprites.mjs` | 像素 sprite（字符串点阵 + 调色板） |
| `bestiary.mjs` | 工具 → 品级映射（改这里适配你的工具名） |
| `theme.mjs` | 品牌 / 分级 / 全部可见文案的唯一真相源 |
| `protocol/events.mjs` | 统一事件协议（校验 / 归一化 / 配对 / 重复检测） |
| `adapters/` | 三路通道 + 字段映射层（`profiles/*.json` 是模板） |
| `tools/doctor.mjs` | 事件源自检 CLI（退出码 0 / 1 / 2） |
| `tools/http-server.mjs` | HTTP 钩子服务（只绑 127.0.0.1） |
| `build-events.mjs` | 会话分析产物 → `real-events.json`（含自检） |
| `real-events.json` | 生成物：事件 + meta（59573 B ≈ 58.2 KiB，样本战斗；截至本次交付） |
| `sample/` | 真实样本会话（292 次调用） |
| `verify.mjs` / `_refs.mjs` | 断言（截至本次交付 403 项） / 真跑渲染循环与未定义引用检查 |
| `tests/` | `node --test` 单元测试（条数以 `# pass` 行为准） |
| `docs/PROTOCOL.md` | 协议字段表、约束、配对规则 |
| `docs/ADAPTERS.md` | 三路通道细节、映射层配置、逐家接入手册 |
| `docs/THEME.md` | 换题材的边界（只改 theme + 新增点阵） |
| `docs/USAGE.md` | 使用手册：三个入口、文件格式、排错 |

---

## 品级与"一个敌人 = 一次工具调用"

一个敌人 = **一次工具调用**。档次由工具的真实耗时分布决定：

| 档次 | 显示名 | 含义 |
|---|---|---|
| `MINION` | 侦察机 | 毫秒级工具（读取 / 搜索，实测中位 8~29ms） |
| `ELITE` | 突击舰 | 秒级工具（跑命令 / 联网 / 落盘，中位 271~482ms） |
| `BOSS` | 母舰 | 子智能体长跑，血条只是预估进度 |

（这些名称与描述的唯一真相源是 `theme.mjs` 的 `COPY.tierRules`，
页面运行时从那里填充，HTML 里没有第二份文案。）

---

## 调试接口

```js
__shield.emit(ev)            // 喂一条事件
__shield.stats()             // 状态快照（seen / kills / failures / duplicates / overdue…）
__shield.source()            // 当前事件源（标签 / 条数 / meta / 是否实时）
__shield.loadText(text,name) // 模拟一次拖入（走和拖入完全相同的解析路径）
__shield.playSample()        // 一键演示（不传任何数据）
__shield.ingest(data)        // 模拟一条 SSE 载荷（走 protocol 校验）
__shield.connectHook(url)    // 连接 HTTP 钩子（只允许本机地址）
__shield.restart() / pause() // 重播 / 暂停
```

---

## 来源与一段历史

从 `potato/`（土豆斗兽场）改造而来。那条线验证了"血条不等于死亡"这条铁律；
本项目换掉了主角（我方防线本体 + 近战短剑）和敌人（真实入侵工具调用），
并把事件源从**手写常量**换成了真实会话数据。

值得记一笔的历史：最早的 `DEMO_EVENTS` 是 29 条编造的事件，时间、时长、
工具名全是假的。页面看起来在演"智能体在干活"，其实演的是写死的剧本。
血条铁律守住了，但事件本身是假的 —— 整场演出仍然是假的。
现在 `real-events.json` 由 `build-events.mjs` 从真实会话分析产物生成，
每一只敌人的出场和死亡时刻都是 `tool/call.time` 与 `tool/result.time` 相减得到的真值。

零依赖。零构建步骤。MIT。
