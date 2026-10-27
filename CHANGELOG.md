# Changelog

## Unreleased

- Align repository governance: required pull-request CI, protected main and release tags, a gated release workflow, and issue/PR templates.

## 0.0.1 — 2026-10-28

- One-command local workspace, Codex session discovery, selection and incremental synchronization.
- Responsive mission console, live call activity, pause buffering and SSE recovery.
- Vertical flight combat, automatic evasion, hit effects, 1 HP health lock and kill healing.
- Boss exchanges fire until real task settlement; presentation armor cannot cause a task kill.
- Codex completion logs remain completion-only; in-progress combat requires lifecycle events.

## Historical candidate (original label 0.1.0, never released)

First public candidate.

- Real events drive the battle. The bundled sample has 292 tool calls.
- Protocol v1: `tool`, `tool_end`, `turn_end`.
- File, stdin, and localhost HTTP hook inputs, plus `doctor`.
- `claude-code` flattens nested `message.content[]` and reports `absent-success` when `is_error` is omitted.
- `codex-session` projects completion records that carry an explicit exit code or status.
- `cursor` and `codex` exec-stream profiles remain fixture-checked.
- Start panel fits the measured 1280×720, 800×600, and 1600×900 viewports. The hook field uses the page origin when the page is served from loopback HTTP.
