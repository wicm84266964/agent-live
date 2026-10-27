import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function validateVersion(version, packageVersion, prerelease) {
  if (!/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/.test(version)) {
    throw new Error('Version must be vMAJOR.MINOR.PATCH or a prerelease such as v0.0.2-rc.1');
  }
  if (version !== `v${packageVersion}`) throw new Error('Release version must match package.json');
  if (version.includes('-') && !prerelease) throw new Error('A prerelease version must be marked as a prerelease');
}

export function requireGreenCi(runs, sha) {
  // Require the latest push CI for this exact main commit, never unrelated checks or older green runs.
  const candidates = runs.filter(r => r.head_sha === sha && r.head_branch === 'main' && r.event === 'push');
  candidates.sort((a,b) => b.id-a.id);
  const run = candidates[0];
  if (!run || run.status !== 'completed' || run.conclusion !== 'success') {
    throw new Error('Latest main push CI on this exact commit must complete successfully before release');
  }
  return run;
}

async function main() {
  const { VERSION: version, PRERELEASE: prerelease, GITHUB_REPOSITORY: repo, GITHUB_SHA: sha,
    GITHUB_REF: ref, GH_TOKEN: token } = process.env;
  if (ref !== 'refs/heads/main') throw new Error('Only main can publish a release');
  if (!repo || !sha || !token) throw new Error('GitHub repository, SHA and token are required');
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  validateVersion(version, pkg.version, prerelease === 'true');
  const notes = await readFile(new URL(`../docs/releases/${version}.md`, import.meta.url), 'utf8');
  if (!notes.trim()) throw new Error('Reviewed release notes must not be empty');
  async function api(path, allowMissing = false) {
    const response = await fetch(`https://api.github.com/repos/${repo}/${path}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    });
    if (allowMissing && response.status === 404) return null;
    if (!response.ok) throw new Error(`GitHub API request failed (${response.status}) for ${path}`);
    return response.json();
  }
  if (await api(`git/ref/tags/${encodeURIComponent(version)}`, true)) throw new Error('Tag already exists; published tags are immutable');
  if (await api(`releases/tags/${encodeURIComponent(version)}`, true)) throw new Error('Release already exists');
  const result = await api(`actions/workflows/ci.yml/runs?head_sha=${sha}&branch=main&event=push&per_page=100`);
  const run = requireGreenCi(result.workflow_runs, sha);
  console.log(`Release gate passed: ${version}, commit ${sha}, CI ${run.id}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
