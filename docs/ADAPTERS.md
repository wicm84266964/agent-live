# 接入手册：把你的智能体接到实况智能体

> 三条通道，任选一条。都不需要改实况智能体的源码，都不需要装依赖（Node ≥ 18 内建即可）。
>
> 接完必做一步：`node tools/doctor.mjs ...` **exit 0 才算接上**。

---

## 0. 三十秒选型

| 你的智能体… | 用这条通道 | 命令 |
|---|---|---|
| 会写日志文件 | **文件** | `node tools/doctor.mjs --file <你的日志>` |
| 能往 stdout 打一行 JSON | **管道** | `your-agent ... \| node tools/doctor.mjs --stdin` |
| 能发 HTTP 请求 | **HTTP** | `node tools/doctor.mjs --http http://127.0.0.1:8787/events` |
| 日志形状和我们差很远 | **先过映射层** | 加 `--profile <名字\|路径>` |

日志形状和协议对不上是**常态**，不是例外 —— 所以有 `adapters/generic.mjs` 这一层。
它读一份 JSON 映射配置，把别人的字段翻译成我们的 6 个字段。

---

## 1. 文件通道 —— `adapters/jsonl-file.mjs`

支持两种形态，自动判定（不看扩展名，看内容）：

| 形态 | 长相 | 增量策略 |
|---|---|---|
| `json-events` | `{"meta":{...},"events":[...]}` | 变化则重读，只发新增条目 |
| `json-array` | `[...]` | 同上 |
| `jsonl` | 每行一个 JSON | **按字节偏移**只读新追加的部分 |

本仓库的 `real-events.json` 就是 `json-events` 形态；
各家智能体的会话日志基本都是 `jsonl`。

### 验收

```bash
node tools/doctor.mjs --file real-events.json
```

实测输出：

```
  事件总数    585
  分类型      tool 292 / tool_end 292 / turn_end 1
  未知 kind   0
  id 配对     292/292（100.0%） 完美
  时间跨度    265.96s
  耗时分布    min 3ms / median 17ms / p90 597ms / max 42.22s（292 条，130 种不同值，合计 130.08s）
  结论        通过
```

### 两个真实坑（都已处理，但你该知道）

- **半行**：追加写日志时最后一行常常是 `{"kind":"tool"` 这种半条。
  适配器会把它留着等下次，不会当坏行报 —— 否则每次 tail 都会刷一条假错误。
- **BOM**：Windows 上 `Set-Content` / `Out-File` 会写 UTF-8 BOM。
  不处理的话**第一行永远 parse 失败**，而那正好是会话的第一条事件，
  表现是"第一条调用凭空消失"且没有显眼报错。适配器会剥掉 BOM。

---

## 2. 管道通道 —— `adapters/stdin.mjs`

最通用的接法：任何能打印一行 JSON 的智能体都能接，不需要改它。

```bash
your-agent --log-events | node tools/doctor.mjs --stdin
```

支持的行内形态：

- 一行一个对象 → 一条事件
- 一行一个**数组** → 拆开逐条
- 一行一个 `{"events":[...]}` → 拆开逐条

坏行**计数并带行号**，继续读下一行，绝不中断（智能体可能跑几个小时，
一行垃圾不该让整场白跑）。

实测（把 `real-events.json` 逐行喂进去）：

```
=== 事件源自检 ===
  输入        stdin <stdin>
  事件总数    585
  id 配对     292/292（100.0%） 完美
  结论        通过
```

与文件通道的数字**逐项一致** —— 这说明两条路径的解析口径确实统一。

---

## 3. HTTP 通道 —— `adapters/http-hook.mjs`

适合"智能体在跑、页面要实时看"的场景。

```
你的智能体 --POST--> 127.0.0.1:PORT/event
                            |
                            +--GET /events (SSE)--> 页面 / doctor
```

### 路由

| 方法 | 路径 | 用途 |
|---|---|---|
| `POST` | `/event`（或 `/events`） | 收一条事件，或一批（数组 / `{"events":[...]}`） |
| `GET` | `/events` | **SSE** 事件流，新订阅者会收到最近 `replay` 条历史 |
| `GET` | `/stats` / `/health` | 计数与未知 kind 明细 |

### 安全红线：只绑 `127.0.0.1`

这个服务**没有任何鉴权** —— 能 POST 的人就能往你屏幕上塞事件。
所以监听地址是常量 `LISTEN_HOST`，**不接受参数覆盖**，并且 `startHttpHook()`
启动后会**校验实际监听地址**，不是 `127.0.0.1` 就直接关掉服务并抛错。

这不是形式主义：绑 `0.0.0.0` 等于把"往你屏幕上造假战报"的权限开放给整个局域网。

### 响应语义（诚实）

| 情况 | 状态码 | 响应体 |
|---|---|---|
| 正常 | `200` | `{ok:true, accepted:true, seq}` |
| 未知 kind | `200` | `{ok:true, unknownKind:"tool_use"}` ← 收下，但**明说不认识** |
| 坏 JSON | `400` | `{ok:false, error:"JSON 解析失败：..."}` |
| 缺必填字段 | `400` | `{ok:false, issues:["[error] missing-ok: ..."]}` |
| 批量里部分坏 | `207` | `{accepted:N, rejected:M, issues:[...]}` |
| 路径不存在 | `404` | `{routes:[...]}` |

**坏 JSON 一定回 400，绝不回 200。** 回 200 会让上游以为发成功了，
然后"事件丢了但没人知道"——那是最糟的失败模式。

### 启动

```js
import { startHttpHook } from './adapters/http-hook.mjs';
const hook = await startHttpHook({ port: 8787, replay: 200 });
console.log(hook.url); // http://127.0.0.1:8787
// ...跑完了
await hook.close();
```

### 端到端实测

```bash
node tools/demo-http-hook.mjs
```

```
  1) 服务已启动   http://127.0.0.1:64903（host=127.0.0.1）
  2) SSE 已连接   订阅者 1 个
  3) POST /event  200 {"ok":true,"accepted":true,"seq":1}
  4) SSE 收到     {"kind":"tool","tool":"read_file","id":"demo-1","ts":1000,"realMs":42,"seq":1}
  5) 坏 JSON      400 {"ok":false,"error":"JSON 解析失败：..."}
  6) 缺字段       400 issues=["[error] missing-ok: ...","[warn] missing-id: ..."]
  7) 未知 kind    200 unknownKind="tool_use"
  8) GET /stats   accepted=2 unknown=1 badRecords=1 未知明细=tool_usex1
  9) 服务已关闭   端口 64903 不再响应 OK
  结论            通过
```

这个脚本任何一步不符合预期就 exit 1，可以进 CI。

---

## 4. 映射层 —— `adapters/generic.mjs`（接入任意智能体的关键）

### 为什么需要它

各家日志的形状完全不一样：

```jsonc
// Claude Code
{"type":"tool_use","id":"toolu_01..","name":"Read","timestamp":"..."}
// Codex
{"type":"item.completed","item":{"type":"command_execution","name":"bash",...}}
// Cursor
{"event":"start","tool":"run_terminal_cmd","callId":"abc","ts":123}
```

它们和协议只差一次**翻译**。翻译规则不该写死在代码里（那样每接一个新智能体
就要改代码 + 发版），所以做成 JSON 配置。

### 配置格式

```json
{
  "profile": "my-agent",
  "envelope": { "type": ["session_meta"] },
  "start":  { "type": ["tool_use"] },
  "end":    { "type": ["tool_result"] },
  "turnEnd":{ "type": ["turn_end"] },
  "id":     ["id", "tool_use_id", "callId"],
  "tool":   ["name", "tool_name"],
  "ts":     ["timestamp", "ts"],
  "realMs": ["duration_ms", "durationMs"],
  "ok":     { "path": ["is_error"], "trueMeansFail": true },
  "extra":  { "sessionId": ["session_id"] }
}
```

| 键 | 作用 |
|---|---|
| `start` / `end` / `turnEnd` | 匹配规则：多键 **AND**，值可以是候选列表 |
| `envelope` | 命中的记录被归为"信封/元信息"，**不算映射失败** |
| `id` / `tool` / `ts` / `realMs` | **候选路径列表**，按顺序取第一个存在的；支持 `a.b[0].c` |
| `ok` | `{path, trueMeansFail}`：`trueMeansFail:true` 表示"字段为真 = 失败"（`is_error`）；默认相反（`success`） |
| `extra` | 只透传**这里点名的**字段 → 事件。不点名的（比如 `secret_token`）不会被带进事件流 |

内置三份：`claude-code` / `codex` / `cursor`（在 `adapters/profiles/`）。
新接一个智能体只需要新建一个 `.json`，**不用改代码**。

> **诚实标注**：这三份 profile（`claude-code` / `codex` / `cursor`）**只在小样本合成夹具上验证过，
> 没有对任何真实转录验证过**。所以它们**不是**"已支持 Claude Code / Cursor / Codex"的意思，
> 只是一份"按文档描述的形状写出来、并且在自造数据上跑通"的起点。
> 要宣称支持某一家，必须先拿真实日志跑一遍：
> `node tools/doctor.mjs --file <真实日志> --profile <名字>` 拿到 exit 0，
> 并且 `id 配对` 一行显示完美。

### 用起来

```bash
node tools/doctor.mjs --file codex.jsonl --profile codex
node tools/doctor.mjs --file my.jsonl   --profile ./my-agent.json
```

### 诚实红线（这一层最容易作恶）

这一层握着"从别人日志里认字段"的权力，所以：

1. **找不到工具调用就停下并如实报告**，`code: no-rule-matched`。
   绝不"看起来像工具调用就造一条"。
2. **绝不为缺字段猜值**。匹配上了但取不到工具名 → `missing-tool`。
   不用 `"unknown"`、下标数字顶替 —— 那会让画面里出现 292 只叫 unknown 的敌舰，
   而用户以为是真数据。
3. **绝不为缺时间猜时间**。没有 `ts` 字段且没有实时时钟 → `missing-ts`。
4. 每个失败原因**分类计数**，doctor 会打出来：

```
  映射结果    成功 41/50（82.0%），跳过原因 no-rule-matchedx5, missing-toolx2, missing-tsx2
```

"丢了 9 条"和"丢了 9 条，原因分别是 A/B/C"是**两件性质完全不同的事**。

---

## 5. 逐家接入手册

### 5.1 Claude Code

> **不要读成「已支持 Claude Code」。**
> `doctor --profile claude-code` 会先把 `message.content[]` 摊平再映射。
> 一份本机转录跑出 doctor exit 0、196/196 配对。你的版本仍要自己验证。

```bash
node tools/doctor.mjs --file ~/.claude/projects/<项目>/<会话>.jsonl --profile claude-code
```

transcript 是 JSONL，工具块嵌在 `message.content[]` 里。doctor 会调用
`adapters/expand.mjs` 摊平，不必先手写 `flat.jsonl`。展平层仍然不搬运工具入参和结果正文。

`is_error: true` 记失败。`is_error` 不在时，profile 写明的 `absent=success` 记成功，
doctor 输出里会有一行 `ok 缺省规则 absent-successxN`。没写这条规则的 profile 不会补 ok。

展平层做的事，以及它**不肯**做的事：

- **保留原 id**：`tool_use.id` / `tool_result.tool_use_id` **原样搬运**，不改写、不生成、不去重。
  配对按这个字符串走（回归红线：历史上 292 次调用被算成 283 次配对，
  就是因为配对口径从 callId 漂成了工具名）。
- **不伪造时刻**：块自己没有时刻时，只继承**同一份记录上真实写着**的
  `timestamp` / `ts` / `time` / `created_at`；记录也没有就**如实缺失**，
  让 doctor 报 `missing-ts`。绝不拿"现在"顶替历史时刻。
- **不搬运入参/结果正文**：`block.input` 与 `tool_result.content` 不进扁平记录
  （体积 + 里面可能有 token / 路径）。要看正文请直接看原始日志。
- **不静默丢块**：`text` / `thinking` / 不认识的块类型逐个分类计数（`stats.droppedByCode`），
  丢了什么、丢了几条，是能被看见的数字。
- **按 id 查回工具名**：真实 `tool_result` 通常**只带** `tool_use_id`、不带工具名。
  展平层会拿这个 id 到**同一份日志的** `tool_use` 记录里查名字（外键 join，`stats.nameBackfilled`），
  查不到就空着 —— 不填 `"unknown"`；同一个 id 上出现两个不同名字时也不填，计 `nameBackfillConflicts`。
  想让输出与原始日志逐字一致，传 `{backfillNames:false}` 关掉。

若**跳过第 ① 步**直接喂原始 transcript，会得到大量 `no-rule-matched`
（那是**如实报告**，不是 bug）—— 因为 `tool_use` 藏在数组元素里，不在顶层。

`adapters/profiles/claude-code.json` 的 `notes` 里写着同一件事，别只信本节。

### 5.2 Codex

实时 `codex exec --json`（`item.started` / `item.completed`）：

```bash
node tools/doctor.mjs --file events.jsonl --profile codex
```

这条只在合成夹具上验证过。取不到工具名的记录记 `missing-tool`，不会被硬造。
`exit_code` 为 0 记成功，非 0 记失败。

会话卷 `~/.codex/sessions/**/rollout-*.jsonl`：

```bash
node tools/doctor.mjs --file rollout.jsonl --profile codex-session --out codex-events.jsonl
```

exit 0 才会写出 `codex-events.jsonl`。把这个文件拖进 `npm run demo` 打开的页面。
不要拖原始会话卷，也不要把它 tail 进 `npm run hook`：钩子不套 profile。

只投影带显式成败的 `item_completed`：`CommandExecution`（`exit_code`）、
`McpToolCall` / `FileChange`（`status` 为 `completed` 或 `failed`）。
开始时刻用完成时刻减去 `duration.secs/nanos`。不读取 command、cwd、arguments、result。
没有成败字段的记录跳过并计数。一份本机会话卷 140/140 配对。

### 5.3 Cursor

```bash
node tools/doctor.mjs --file cursor-agent.jsonl --profile cursor
```

仅合成夹具验证过。不要把它读成已支持 Cursor。

### 5.4 自研智能体

最省事的路子是**直接吐协议形状**（跳过映射层）：

```python
def emit(ev): print(json.dumps(ev), flush=True)
emit({"kind":"tool",  "tool":"read_file", "id":cid, "ts":now_ms()})
...
emit({"kind":"tool_end","tool":"read_file","id":cid, "ok":ok, "ts":now_ms(),"realMs":ms})
```

然后 `your-agent | node tools/doctor.mjs --stdin`。

---

## 6. 给你的智能体的一段提示词（草稿，可直接粘贴）

> 复制下面整段给你的智能体（Claude Code / Codex / Cursor / 自研 agent 都可以）。
> 它会让智能体自己产出符合协议的事件流，免掉后面所有翻译工作。

```
你要把本次会话中的每一次工具调用，实时打成 JSONL 到 stdout（每行一个 JSON，立即 flush）。

严格遵守以下事件协议，不要发明字段，不要合并事件：

1) 每次工具调用**开始时**打一条：
   {"kind":"tool","tool":"<工具原始名>","id":"<调用唯一ID>","ts":<毫秒时间戳>}
2) 同一次调用**结束时**打一条：
   {"kind":"tool_end","tool":"<同一工具名>","id":"<同一个ID>","ok":<true|false>,"ts":<毫秒时间戳>,"realMs":<本次耗时毫秒>}
3) 每一轮对话结束时打一条：
   {"kind":"turn_end","ok":true,"ts":<毫秒时间戳>}

硬性要求（违反其一即视为接入失败）：
- id 必须是**每次调用唯一**的标识，start 和 end 必须用同一个 id。
  **绝不能用工具名当 id** —— 同名工具会被并成一次调用，历史上前功尽弃过一次。
- ts 必须是毫秒数字。拿不到就**不要打这条事件**，不要用 0 或当前时间顶替。
- realMs 必须是真实耗时，不能是估算值；拿不到就不写这个字段。
- ok 必须是布尔值，不能是 "true"/"true"/"success" 等。
- 不要输出任何非 JSON 行到 stdout（日志/调试信息走 stderr）。
  如果必须有说明行，就用 # 开头的纯文本也可以，但我们的解析器会把非 JSON 行记为坏行。
- 工具失败也要打 tool_end，只是 ok 用 false。**不要吞掉失败的调用。**
- 如果某个工具调用你无法确定 id 或 ts，宁可**不打**，也不许猜。

示例（一次 read_file 成功调用 + 收尾）：
{"kind":"tool","tool":"read_file","id":"c1","ts":1786705838598}
{"kind":"tool_end","tool":"read_file","id":"c1","ok":true,"ts":1786705839397,"realMs":799}
{"kind":"turn_end","ok":true,"ts":1786705839500}
```

---

## 7. 验收清单

接完跑一遍，逐条打勾：

- [ ] `node tools/doctor.mjs --<你的通道>` **exit 0**
- [ ] 事件总数 = 你预期发起的工具调用数 × 2 + 轮数
- [ ] `未知 kind` 为 0（不为 0 说明有事件类型没被协议覆盖）
- [ ] `id 配对` 显示**完美**（`paired == calls == results`）
- [ ] `重复上报` 为 0
- [ ] `坏记录` 为 0（不为 0 说明有行不是合法 JSON）
- [ ] 时间跨度合理（不是 0，也不是几天）
- [ ] 耗时 max 是可信的（不是 0、不是天文数字）

任一条不满足，doctor 会 **exit 1** 并列出原因 —— 别调低标准去凑绿。

---

## 8. 常见失败与对策

| doctor 说什么 | 真实原因 | 怎么办 |
|---|---|---|
| `没有解析出任何合法事件` | **不一定**是"没数据"。doctor 能区分三种情况，见下面 8.1 | 先看同一份输出里有没有 `解析失败：…` / `[file] 疑似整份 JSON 被截断` / `映射配置…一条都没匹配上`，按 8.1 对症 |
| `未知 kind N 条` | 日志里的 `type` 不是 `tool/tool_end/turn_end` | 写 profile 映射，别改协议 |
| `id 配对不完整：孤儿开始 N` | 只打了 start，没打 end | 让智能体在结束时也必打 |
| `id 配对不完整：孤儿结束 N` | 只打了 end（或断线重连后接着打） | 补 start；或接受它被补造出场 |
| `重复上报 N 个 id` | 重连/重放导致重复投递 | 上游去重；`director` 会忽略，不虚报战果 |
| `N 条 tool/tool_end 没有 id` | 日志没给调用 ID | 尽量补；FIFO 兜底可用但同名调用无法区分 |
| `映射配置一条都没匹配上` | profile 的 start/end 规则对不上你的日志 | 看 `--json` 里的 `examples` 对照真实字段 |
| `打不开文件` / `连不上` | 路径错 / 服务没起 | doctor 会 exit 2，不会假装成功 |

### 8.1 「事件流是空的」到底是谁的错

`没有解析出任何合法事件（事件流是空的）` 是**症状**，不是病因。
doctor 的检查顺序是"先病因、后症状"，所以先看同一份输出里**还有没有别的行**：

| 情况 | doctor 会额外说什么 | 真实原因 | 怎么办 |
|---|---|---|---|
| ① 真的是空流 | 只有这一条，没有 `[file]` 也映射不到任何记录 | 文件/管道确实一个事件都没进来（上游还没开始打日志，或打到了别处） | 确认上游**真的**在写这份文件（`tail -f` 看有没有新行）、确认路径/端口没错 |
| ② 解析失败 | `解析失败：<原因>` 或 `整文件 JSON 解析失败：…` | 文件读进来了，但**内容不是合法 JSON**（写坏了、编码不对、混进了非 JSON 行） | 按 `<原因>` 修文件本身。**别去查"通道接上没有"** —— 通道是通的，是数据坏了 |
| ③ 疑似整份 JSON 被截断 | `[file] … 疑似整份 JSON 被截断或写坏（N 条碎片都不是独立的合法 JSON 行…）` | 文件是**写了一半**的（进程被杀 / 磁盘满 / 重定向中断）。特征是 `{meta,events}` 只写到一半，碎片怎么拼都拼不成 JSON | 让上游**重新完整写一遍**再读。不要手工补括号凑成合法 JSON —— 那会把"截断"变成"少了几百条事件"，更隐蔽 |

这三种情况下 doctor 都是 exit 1，但**下一步动作完全不同**：
①是查接线，②是修文件内容，③是让上游重写。混成一件事会把排错引向错误方向。

> 还有一种容易和上面三种混淆的情况：**文件合法、但一条都没映射上**
> （`映射配置 … 一条都没匹配上（喂入 N 条）`）。那时事件流也是空的，
> 但病因是 profile 规则对不上，不是文件坏 —— 看 `--json` 里的 `examples` 对照真实字段。
