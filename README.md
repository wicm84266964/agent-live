# 实况智能体 · agent-live

English overview: [README.en.md](README.en.md).

## 本地工作台：一条命令启动

需要 Node.js 18 或更新版本；零依赖，不需要 `npm install`。

```powershell
npm start
```

打开终端打印的本机地址（默认 http://127.0.0.1:5173/）。工作台会发现
`~/.codex/sessions` 中最近 30 个会话，首次选择最近更新的会话，并自动连接。
在右上角选择当前聊天即可切换；连接后不需要导出或拖入分析文件。
标题来自会话中的首条用户消息，原始日志正文不会通过事件流发送。

显式指定会话或端口：

```powershell
npm start -- --file "C:\Users\你的用户名\.codex\sessions\日期\rollout-会话.jsonl"
npm start -- --port 5300
```

默认只读取接入后新增的记录，不把历史工作伪装成实时执行。会话固定为你选择的那一个，
不会因为另一个聊天开始写日志而偷偷换源。刷新列表后可以主动切换。
HTTP hook 与页面由同一进程启动，无需另外启动钩子、填写端口或拖文件。

工作台包含调用统计、真实工具耗时、最近 100 条调用、来源与异常状态，支持暂停、
柔和特效及手机布局。暂停时继续接收并缓冲，恢复后结算；缓冲上限 2000 条，
超出会明确断开，不静默丢数据。断线在最近 1000 条事件窗口内按游标恢复，
超过窗口会报告数据缺口。切换来源时清空上一来源的统计和特效。

战场采用纵向飞行：我方战机在下方，任务敌舰由上方进入，空档有环境飞弹和自动规避。
环境飞弹有独立标注，不计入工具调用、成功或失败；任务敌舰仍按真实工具结果结算。

**当前 Codex 接入是「工具完成后自动同步」**：沿用 `codex-session` 的
`item_completed` 与真实 duration 还原事件，无法展示尚未完成的调用。
界面会明确标注这一限制，执行中为 0 不代表 Codex 没有正在运行的任务。
不支持的记录跳过；缺少明确状态、时间或调用 ID 的记录会报告异常。
文件回放会拒绝坏行、未知类型和配对不完整的数据，也不会用文件结束冒充任务成功。

更多交付范围和边界见 [工作台说明](docs/WORKSPACE.md)。

## 高级接入：把下面整段粘给你的智能体

这是安装。不要先自己找日志、改端口、猜 profile。把下面代码块里的**全部内容**复制给你的智能体（Codex / Claude Code / Cursor / 自研 agent 都行）。它不依赖聊天上下文，自身就是一份完整工单，包括 Codex 会话卷该用哪个 profile、怎样导出成页面能拖进去的文件。

```
任务：把我的日志/事件流接进「实况智能体」(agent-live)，让它能看着我的工具调用打一场
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

【二、先按我正在用的智能体选 profile，再跑 doctor】
先看真实日志的前几行，再选下面一条。不要凭名字猜。

Codex 会话卷（最常见。文件在 %USERPROFILE%\.codex\sessions\ 或 ~/.codex/sessions/ 下，
文件名通常是 rollout-*.jsonl，里面有 "type":"event_msg" 和 "item_completed"）：
     npm run doctor -- --file "<那份 jsonl 的绝对路径>" --profile codex-session --out codex-events.jsonl
  - 必须用 codex-session。--profile codex 是给 `codex exec --json` 的 item.started /
    item.completed 用的，那条只在合成夹具上验证过，不要拿去套会话卷。
  - exit 0 才会写出 codex-events.jsonl。exit 不是 0 就不要自己编一份播放文件。
  - Codex 本地工作台优先运行 npm start -- --file "<那份 jsonl 的绝对路径>"。
    打开打印出的本机地址，确认自动连接且新工具完成后统计更新，不要求用户拖文件。
    codex-events.jsonl 仅用于离线回放。工作台会明确显示「完成后同步」，不要宣称开始即实时可见。
  - 不要把原始会话卷直接拖进页面。页面不读 Codex 原始字段。
  - 不要把原始会话卷 tail 进 npm run hook。钩子不套 profile，原始行不会变成战斗。
  - codex-session 只投影带 exit_code 或 status=completed|failed 的
    CommandExecution / McpToolCall / FileChange。没有这些字段的记录会跳过并计数。
    这是如实跳过，不要补成功。

Claude Code 转录（~/.claude/projects/ 或 %USERPROFILE%\.claude\projects\ 下的 .jsonl，
工具块嵌在 message.content[] 里）：
     npm run doctor -- --file "<转录路径>" --profile claude-code --out claude-events.jsonl
  doctor 会先把 message.content[] 摊平。exit 0 后再 npm run demo，拖入写出的 jsonl。

Cursor：profile 名是 cursor，仅合成夹具验证过。先看真实日志再决定能不能用，
不要把它当成已经接好。

自研 / 已经是协议形状的 JSONL：不要加 --profile。
     npm run doctor -- --file "<路径>" --out play.jsonl

另外两条通道，文件通道走不通时再用：
B. 管道 stdin
     <我的智能体命令> | node tools/doctor.mjs --stdin
     或： <我的智能体命令> | node tools/doctor.mjs --stdin --profile <名字>
C. HTTP hook（只接收已经是协议形状的事件，不负责翻译 Codex/Claude 原始日志）
     npm run hook
     curl -X POST http://127.0.0.1:8787/event -H "content-type: application/json" -d "<事件JSON>"
     另开窗口：npm run demo
     页面若从 npm run demo 打开，钩子地址用页面自己的来源（默认 http://127.0.0.1:5173），不要填 8787。

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
   adapters/profiles/*.json —— 字段映射模板（claude-code / codex-session / codex / cursor）
   注意：Cursor 的 profile 仅合成夹具验证过。claude-code 与 codex-session
   各对照过一份本机转录（doctor exit 0，id 配对完美），这不是对所有版本的保证。
   用它们之前先拿你自己的真实转录跑 doctor 验证，别假定它一定能用。
   如果你的智能体是自研的，最省事的做法是让它**直接按第三节的形状吐事件**，
   跳过映射层，出错面最小。

【七、交付时报告】
   - 用了哪条（codex-session / claude-code / cursor / 协议文件 / stdin / HTTP hook），用什么命令跑的
   - 如果写了 --out：写出的文件路径，以及我该拖进页面的是这份文件，不是原始日志
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

### Codex 当前会话自动同步（不需要拖文件）

```powershell
npm run codex-live -- --file "C:\Users\你的用户名\.codex\sessions\日期目录\rollout-会话.jsonl"
# 另一个终端：
npm run demo
```

打开页面，点击「连接 HTTP hook」，保留页面自动填入的同源地址（默认
`http://127.0.0.1:5173`）。`codex-live` 自带 8787 钩子，不要同时运行 `npm run hook`。
桥接器每 250ms 增量读取指定会话新追加的完整行，沿用 `codex-session` 投影器，
不发送原始日志正文。连接前的历史记录不会重新扫描（SSE 重连会补发桥接器最近
500 条事件）。换聊天需改为对应日志路径并重启桥接器；服务退出后同步停止。

**限制：这是工具完成后的自动同步。** 当前投影器读取 `item_completed`，
使用真实完成时间和 duration 还原开始/结束事件，因此无法在工具刚开始执行时显示敌人。
缺少显式成败、时间戳或调用 id，以及坏 JSON / 文件截断时，桥接器报错停止，
不补造事件。只有项目支持的 CommandExecution / McpToolCall / FileChange 会转换。

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
