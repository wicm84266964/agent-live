# Changelog

## 0.1.0

First public candidate.

- Real events drive the battle. The bundled sample has 292 tool calls.
- Protocol v1: `tool`, `tool_end`, `turn_end`.
- File, stdin, and localhost HTTP hook inputs, plus `doctor`.
- `claude-code` flattens nested `message.content[]` and reports `absent-success` when `is_error` is omitted.
- `codex-session` projects completion records that carry an explicit exit code or status.
- `cursor` and `codex` exec-stream profiles remain fixture-checked.
- Start panel fits the measured 1280×720, 800×600, and 1600×900 viewports. The hook field uses the page origin when the page is served from loopback HTTP.
