# Contributing

agent-live is a local visualizer. Changes should keep three properties:

- A kill happens only on a real `tool_end` with `ok: true`. An empty health bar is not a kill.
- Missing fields are reported. They are not filled in with a guess, unless a profile file explicitly declares a default and `doctor` prints that count.
- The project stays zero-dependency. Do not add a bundler or an `npm install` step.

## Checks

```powershell
npm test
npm run check
npm run doctor -- --file real-events.json
```

`npm run check` must exit 0. If a new assertion can be turned green by deleting the behavior it guards, tighten the assertion instead.

## Profiles

A new agent profile is a JSON file in `adapters/profiles/` plus a fixture in `tests/`. Do not write "supported" in the README until `doctor` has exited 0 on a real transcript of that agent. Record the pairing count, and do not commit the transcript.

## Public copy

The release mirror is `open-source/agent-live`. Do not copy `.lab-agent/`, local transcripts, or machine paths into it.
