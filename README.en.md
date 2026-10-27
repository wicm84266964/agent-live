# agent-live

[中文说明](README.md)

## Install: paste this whole block to your agent

Do not hunt for logs or guess a profile yourself. Copy the block below to Codex, Claude Code, Cursor, or your own agent. It is a complete ticket, including which Codex profile to use and how to export a file the page can play.

```
Task: connect my agent log to agent-live in this repository (package.json name must be "agent-live").
Do not npm install. Do not add a bundler.

1) From the repository root, run:
     node -e "console.log(require('./package.json').name)"
     npm run check
   Both must succeed. If they do not, stop and report. Do not continue.

2) Look at my real log before choosing a profile.

Codex session rollout (usual case). Files live in %USERPROFILE%\.codex\sessions\ or ~/.codex/sessions/, usually rollout-*.jsonl, with "type":"event_msg" and "item_completed":
     npm run doctor -- --file "<absolute path>" --profile codex-session --out codex-events.jsonl
   Use codex-session. Do not use --profile codex for a session rollout. That profile is for `codex exec --json` and is fixture-checked only.
   --out writes the file only when doctor exits 0. If it does not exit 0, do not invent a playback file.
   Then run npm run demo and tell me to drop codex-events.jsonl onto the page.
   Do not drop the raw session file. The page does not read Codex fields.
   Do not tail the raw session into npm run hook. The hook does not apply a profile.
   Records without exit_code or status=completed|failed are skipped. Do not fill in success.

Claude Code transcript under ~/.claude/projects/ or %USERPROFILE%\.claude\projects\:
     npm run doctor -- --file "<path>" --profile claude-code --out claude-events.jsonl
   doctor flattens message.content[] first. After exit 0, npm run demo and drop the written jsonl.

Cursor profile name is cursor. It is fixture-checked only. Do not treat it as connected until doctor exits 0 on my real log.

Already-protocol JSONL: no --profile.
     npm run doctor -- --file "<path>" --out play.jsonl

Exit codes: 0 accepted, 1 the stream is semantically wrong, 2 the source cannot be opened or the arguments are wrong.
If you cannot find any tool call, stop and say so. Do not invent events. Do not guess fields.

Report the command, the doctor exit code, the pairing line, and the playback file path if you wrote one.
```

Watch an agent work as a live battle. Each tool call is an enemy. The defender keeps attacking. The enemy dies only when that call actually finishes.

Zero dependencies. No build step. Node.js 18 or newer.

## What it does

| Agent event | On screen |
|---|---|
| `tool` | An enemy appears. Its size follows the tool, not a guessed duration. |
| `tool_end` with `ok: true` | That enemy is destroyed. |
| `tool_end` with `ok: false` | A failure mark. It is not a kill. |
| `turn_end` with `ok: true` | The field clears. |
| No events | Nothing happens. |

The health bar is an estimate. An empty bar does not kill the enemy. A kill happens only when the real end event arrives, even if the bar is still full.

## Run the demo

```powershell
npm run demo
```

Open the printed local URL. **Enter battle** plays the bundled sample: 292 real tool calls. You can also drop a `session-analysis.json`, `real-events.json`, or `.jsonl` file.

`npm run demo` serves the page and proxies the hook, so the hook field is rewritten to the page origin. Do not point it at port 8787 while the page is on 5173. The browser will block the cross-origin stream.

## Connect your agent

The stable interface is three JSON events:

```json
{"kind":"tool","tool":"read_file","id":"c1","ts":1730000000000}
{"kind":"tool_end","tool":"read_file","id":"c1","ok":true,"ts":1730000000799,"realMs":799}
{"kind":"turn_end","ok":true,"ts":1730000000900}
```

Pair by `id`, not by tool name. `ts` is a real millisecond timestamp. Do not invent missing fields.

```powershell
npm run doctor -- --file .\my-log.jsonl
npm run doctor -- --stdin
npm run hook
```

`doctor` exit codes: `0` accepted, `1` the stream is semantically wrong, `2` the source cannot be opened or the arguments are wrong.

Built-in profiles:

| Profile | Use |
|---|---|
| `claude-code` | Claude Code JSONL. Flattens `message.content[]` first. Checked on one local transcript: 196/196 paired. |
| `codex-session` | Codex session rollout. Uses explicit `exit_code` or `status`. Checked on one local session: 140/140 paired. |
| `codex` | `codex exec --json` shape. Fixture-checked only. |
| `cursor` | Fixture-checked only. |

These checks are not a promise that every future log shape will match. Run `doctor` on your own transcript before you treat a profile as connected. The Chinese README has the paste-ready agent prompt.

Protocol details: [docs/PROTOCOL.md](docs/PROTOCOL.md). Adapters: [docs/ADAPTERS.md](docs/ADAPTERS.md). Published shape: [protocol/event.v1.json](protocol/event.v1.json).

## Develop

```powershell
npm test
npm run check
npm run doctor -- --file real-events.json
```

There is no `npm install` step. The package stays private so it is not published to npm by accident. Clone the repository and run it locally.

## License

MIT. See [LICENSE](LICENSE).
