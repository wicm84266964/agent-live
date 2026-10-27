# 0.0.1 发布记录

日期：2026-10-28。首个 GitHub Release，标签 `v0.0.1`。

- 本地工作台：`npm start` 一键启动，会话发现、选择和增量同步，无需手动拖入日志。
- 纵向飞行战场：分层舰体、自动规避、环境飞弹、命中特效、最低 1 HP 锁血和成功击杀回血。
- Boss 持续交火，表现装甲最低保留 5%，真实成功结束才斩杀。
- 改进 SSE 恢复、重复事件处理、暂停缓冲、异常记录提示及窄屏布局。
- 验证：146 项测试通过，`npm run check` 通过。

限制：当前 Codex 会话源仅在调用完成后同步，不能提前显示进行中的子智能体。完整 Boss 交战需要真实开始／结束事件源。游戏生命值和装甲不代表任务进度，不改变真实成功／失败统计。包保持 `private: true`，不发布到 npm。

## 历史候选验证（原标记 0.1.0，未发布）

日期：2026-10-27。这是公开候选，不是“已支持每一家智能体”的声明。

## 命令与结果

| 命令 | 结果 |
|---|---|
| `npm test` | 133 通过，0 失败 |
| `npm run check` | `verify.mjs` 全部通过：537 项；`_refs.mjs` 全部通过 |
| `npm run doctor -- --file real-events.json` | exit 0。585 条事件，`tool 292 / tool_end 292 / turn_end 1`，id 配对 292/292 |
| `npm run doctor -- --file <一份本机 Claude Code 转录> --profile claude-code` | exit 0。196/196 配对。`is_error` 83 条，`absent-success` 113 条 |
| `npm run doctor -- --file <一份本机 Codex 会话卷> --profile codex-session` | exit 0。140/140 配对，`turn_end` 16 |

本机转录没有放进仓库。

## 页面

Chrome headless 读取 `#startPanel` 的 `scrollHeight / clientHeight`，溢出都是 0：

- 1280×720
- 1280×768
- 800×600
- 900×700
- 1600×900

同一轮里点「进入战场」后，开始面板隐藏，状态条写明样本 292 次工具调用。本机 HTTP 打开时，钩子地址改成当前页面来源。

## 残余风险

- `cursor` 与 `codex`（exec JSON）只在合成夹具上验证过。
- `claude-code` 的 `absent=success` 是 profile 写明的缺省规则，只对照过一份转录。
- `codex-session` 的开始时刻是完成时刻减去显式 duration，不是日志里的另一条开始记录。没有 `exit_code` 或 `status` 的记录会跳过。
- 没有单文件离线包。离线使用就是本机 `npm run demo`。
- 包保持 `private: true`，不发到 npm。
