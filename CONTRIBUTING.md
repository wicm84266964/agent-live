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

## Pull requests and releases

Work in a topic branch based on current `main`, push the branch and open a pull request. Do not push directly to `main`. The required `test suite` check must pass before merging, including for administrators. A second reviewer is not required; resolve review conversations before merging.

Do not commit `.lab-agent/`, local transcripts, credentials, machine paths, screenshots or runtime output. Synthetic test fixtures are welcome.

After merging a version update and reviewed notes at `docs/releases/vMAJOR.MINOR.PATCH.md`, wait for main's CI to pass. Run **Create release** from GitHub Actions on `main`. The workflow checks that the tag matches `package.json`, the exact commit has successful push CI, and the tag/release does not already exist. Public `v*` tags cannot be moved or deleted. Never manually create or overwrite release tags.

See [the release workflow](docs/maintenance/release_workflow_zh.md) for the full procedure. The existing `v0.0.1` release is preserved; these gates apply to future releases.
