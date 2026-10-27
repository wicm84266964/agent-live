import test from 'node:test';
import assert from 'node:assert/strict';
import { validateVersion, requireGreenCi } from '../tools/release-gate.mjs';

test('release tags match the package and prereleases cannot become stable by accident', () => {
  validateVersion('v0.0.2', '0.0.2', false);
  validateVersion('v0.0.2-rc.1', '0.0.2-rc.1', true);
  for (const tag of ['v01.0.0', '../notes', '0.0.2', 'v0.0.2;echo', 'v0.0.2/notes']) {
    assert.throws(() => validateVersion(tag, tag.slice(1), false));
  }
  assert.throws(() => validateVersion('v0.0.2', '0.0.1', false));
  assert.throws(() => validateVersion('v0.0.2-rc.1', '0.0.2-rc.1', false));
});

test('only latest successful main push CI on the exact release commit authorizes release', () => {
  const green = {id:1,head_sha:'release',head_branch:'main',event:'push',status:'completed',conclusion:'success'};
  assert.equal(requireGreenCi([green],'release'),green);
  assert.throws(() => requireGreenCi([],'release'));
  for (const change of [{head_sha:'other'}, {head_branch:'topic'}, {event:'pull_request'},
    {status:'in_progress'}, {conclusion:'failure'}, {conclusion:'cancelled'}, {conclusion:'skipped'}]) {
    assert.throws(() => requireGreenCi([{...green,...change}],'release'));
  }
  assert.throws(() => requireGreenCi([green,{...green,id:2,status:'in_progress',conclusion:null}],'release'));
  assert.throws(() => requireGreenCi([green,{...green,id:3,conclusion:'failure'}],'release'));
});
