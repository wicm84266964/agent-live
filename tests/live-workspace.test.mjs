import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, appendFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openSessionTail } from '../adapters/session-tail.mjs';
import { LiveBuffer } from '../protocol/live-buffer.mjs';
import { Director } from '../director.mjs';
import { startHttpHook } from '../adapters/http-hook.mjs';
import { Renderer } from '../render.mjs';
import { FlightScene } from '../flight-scene.mjs';
import { classify, TIER } from '../bestiary.mjs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Isolated fixtures only; none of these events are sent to the running application.
test('pilot swept collisions, invulnerability, health lock and capped healing', () => {
  const scene = new FlightScene();
  scene.spawnClock = 999;
  scene.missiles.push({x:0,y:90,vx:0,speed:2000,warning:0,age:0});
  scene.advance(.05, []);
  assert.equal(scene.hp, 90);
  assert.equal(scene.effects[0].kind, 'hit');
  assert.equal(scene.missiles.length, 0);
  assert.equal(scene.damage(100), false);
  scene.advance(.7, []);
  scene.damage(1000);
  assert.equal(scene.hp, 1);
  assert.equal(scene.heal(), 12);
  assert.equal(scene.hp, 13);
  scene.heal(100);
  assert.equal(scene.hp, 100);
});

test('boss continuously exchanges fire but cannot be killed by cosmetic damage', () => {
  assert.equal(classify('spawn_agent').tier, TIER.BOSS);
  const scene = new FlightScene();
  const boss = {tier:TIER.BOSS,diedAt:null,deathT:0};
  let fired = false, shot = false;
  for(let i=0;i<60*90;i++) {
    scene.advance(1/60,[boss]);
    fired ||= scene.missiles.some(m=>m.boss);
    shot ||= scene.shots.length>0;
  }
  assert.ok(fired && shot);
  assert.equal(boss.flight.hull,.05);
  assert.equal(boss.diedAt,null);
  assert.ok(scene.hp >= 1);
  boss.diedAt=1; boss.deathT=2;
  scene.missiles=[];scene.shots=[];scene.spawnClock=999;
  scene.advance(2,[boss]);
  assert.equal(scene.missiles.length,0);
  assert.equal(scene.shots.length,0);
});

const completed = (id, tool = 'exec_command') => ({
  timestamp: '2026-10-27T13:00:01.000Z', type: 'event_msg',
  payload: { type: 'item_completed', item: { type: 'CommandExecution', id, tool,
    exit_code: 0, duration: { secs: 1, nanos: 0 } } },
});
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'agent-live-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'session.jsonl');
  await writeFile(path, JSON.stringify(completed('old')) + '\n');
  return path;
}
test('session tail ignores history, preserves a UTF-8 split and emits one exact pair', async t => {
  const path = await fixture(t);
  const source = await openSessionTail(path);
  t.after(() => source.close());
  assert.deepEqual((await source.poll()).events, []);
  const record = Buffer.from(JSON.stringify(completed('new', '中文工具')) + '\n');
  const split = record.indexOf(Buffer.from('中文')) + 1;
  await appendFile(path, record.subarray(0, split));
  assert.deepEqual((await source.poll()).events, []);
  await appendFile(path, record.subarray(split));
  const result = await source.poll();
  assert.equal(result.events.length, 2);
  assert.equal(result.events[0].tool, '中文工具');
  assert.equal(result.events[0].id, 'new');
  assert.equal(result.events[1].ts - result.events[0].ts, 1000);
  assert.equal(result.events[1].ok, true);
  assert.deepEqual((await source.poll()).events, []);
});
test('bad JSON and missing success are visible; a later valid call remains usable', async t => {
  const path = await fixture(t);
  const source = await openSessionTail(path);
  t.after(() => source.close());
  const missing = completed('missing'); delete missing.payload.item.exit_code;
  await appendFile(path, 'broken\n' + JSON.stringify(missing) + '\n' + JSON.stringify(completed('valid')) + '\n');
  const result = await source.poll();
  assert.equal(result.events.length, 2);
  assert.equal(result.issues.length, 2);
  assert.equal(source.stats.badLines, 1);
  assert.equal(source.stats.issues, 2);
});
test('tail reports truncation and never replays a rewritten source', async t => {
  const path = await fixture(t);
  const source = await openSessionTail(path);
  t.after(() => source.close());
  await writeFile(path, '');
  await assert.rejects(source.poll(), /截断/);
});
test('pause queue bounds memory and reconnect cursor prevents repeated execution', () => {
  const buffer = new LiveBuffer(2);
  assert.equal(buffer.accept({ streamId: 'a', seq: 1 }).accepted, true);
  assert.equal(buffer.accept({ streamId: 'a', seq: 1 }).accepted, false);
  assert.equal(buffer.enqueue('one'), true);
  assert.equal(buffer.enqueue('two'), true);
  assert.equal(buffer.enqueue('three'), false);
  assert.deepEqual(buffer.drain(), ['one', 'two']);
  assert.equal(buffer.accept({ streamId: 'b', seq: 1 }).changed, true);
  assert.equal(buffer.overflow, false);
});
test('duplicate starts cannot create extra enemies or inflate successful calls', () => {
  const director = new Director();
  const start = { kind: 'tool', id: 'one', tool: 'read_file', ts: 0 };
  director.handle(start, 0);
  director.handle(start, 1);
  assert.equal(director.seen, 1);
  director.handle({ ...start, kind: 'tool_end', ok: true }, 2);
  director.handle(start, 3);
  assert.equal(director.seen, 1);
  assert.equal(director.kills, 1);
  assert.equal(director.duplicates, 2);
});
test('an idle arena never fires or accumulates combat damage', () => {
  const director = new Director();
  for (let i = 0; i < 600; i++) director.advance(1 / 60, i * 1000 / 60, { x: 0, y: 0 });
  assert.equal(director.swings, 0);
  assert.equal(director.damage, 0);
  assert.equal(director.lightning.length, 0);
});
test('ambient flight remains bounded, pauses exactly, and never changes task outcomes', () => {
  const scene = new FlightScene();
  const director = new Director();
  let peak = 0, evasions = 0;
  for (let i = 0; i < 3600; i++) {
    scene.advance(1/60, director.enemies);
    peak = Math.max(peak, scene.missiles.length);
    if (scene.dodging) evasions++;
    assert.ok(Math.abs(scene.hero.x) <= 180);
    assert.ok(scene.hero.y > 140);
  }
  assert.ok(peak > 0 && peak < 30);
  assert.ok(evasions > 0);
  assert.equal(director.seen, 0);
  assert.equal(director.kills, 0);
  assert.equal(director.failures, 0);
  const snapshot = JSON.stringify(scene);
  scene.advance(0, []);
  assert.equal(JSON.stringify(scene), snapshot);
});
test('narrow viewports fit the entire arena instead of clamping zoom to one', () => {
  const fake = { clientWidth: 340, clientHeight: 400, width: 0, height: 0 };
  const original = globalThis.window;
  globalThis.window = { devicePixelRatio: 2 };
  try {
    const renderer = Object.create(Renderer.prototype);
    renderer.cv = fake; renderer.sprites = {};
    renderer.resize();
    assert.ok(renderer.scale < 1);
    assert.ok(580 * renderer.scale <= 340);
    assert.equal(fake.width, 680);
  } finally { globalThis.window = original; }
});
async function readSse(url, lastId, until) {
  const control = new AbortController();
  const timer = setTimeout(() => control.abort(), 2500);
  try {
    const response = await fetch(url, { headers: lastId ? { 'last-event-id': lastId } : {}, signal: control.signal });
    let text = '';
    for await (const chunk of response.body) {
      text += new TextDecoder().decode(chunk);
      if (until(text)) return text;
    }
    return text;
  } finally { clearTimeout(timer); control.abort(); }
}
test('SSE resumes after Last-Event-ID, reset changes identity, and gaps are explicit', async t => {
  const hook = await startHttpHook({ port: 0, replay: 2 });
  t.after(() => hook.close());
  const event = { kind: 'turn_end', ok: true, ts: 100 };
  hook.push(event); hook.push(event);
  const first = await readSse(hook.url + '/events', null, text => text.includes('replay '));
  const ids = [...first.matchAll(/^id: (.+)$/gm)].map(m => m[1]);
  assert.equal(ids.length, 2);
  const resumed = await readSse(hook.url + '/events', ids[0], text => text.includes('replay '));
  assert.equal([...resumed.matchAll(/^data:/gm)].length, 1);
  assert.ok(resumed.includes(ids[1]));
  hook.push(event); hook.push(event);
  const gap = await readSse(hook.url + '/events', ids[0], text => text.includes('replay '));
  assert.ok(gap.includes('event: gap'));
  hook.reset(); hook.push(event);
  const reset = await readSse(hook.url + '/events', ids[1], text => text.includes('replay '));
  assert.equal(hook.stats().total, 1);
  assert.ok(!reset.includes(ids[0].split(':')[0]));
});

test('one-command server discovers sessions, streams new calls and isolates source switches', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-live-server-'));
  const first = join(dir, 'rollout-test-one.jsonl');
  const second = join(dir, 'rollout-test-two.jsonl');
  const user = title => ({ type: 'event_msg', payload: { type: 'item_completed', item: {
    type: 'UserMessage', content: [{ type: 'text', text: title }],
  } } });
  await writeFile(first, JSON.stringify(user('测试会话一')) + '\n');
  await writeFile(second, JSON.stringify(user('测试会话二')) + '\n');
  const child = spawn(process.execPath, ['tools/app-server.mjs', '--port', '0', '--file', first], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: { ...process.env, AGENT_LIVE_SESSIONS: dir }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  t.after(async () => {
    if (child.exitCode === null) { child.kill(); await new Promise(resolve => child.once('exit', resolve)); }
    await rm(dir, { recursive: true, force: true });
  });
  const url = await new Promise((yes, no) => {
    const timer = setTimeout(() => no(new Error('Server did not become ready')), 5000);
    child.stdout.on('data', chunk => { const match = String(chunk).match(/http:\/\/127\.0\.0\.1:\d+/); if (match) { clearTimeout(timer); yes(match[0]); } });
    child.once('error', err => { clearTimeout(timer); no(err); });
    child.once('exit', code => { clearTimeout(timer); no(new Error(`Server exited ${code}`)); });
  });
  const listing = await (await fetch(url + '/api/sessions')).json();
  assert.equal(listing.sessions.length, 2);
  assert.ok(listing.sessions.some(s => s.title === '测试会话一'));
  assert.equal((await fetch(url + '/')).status, 200);
  assert.equal((await fetch(url + '/codex-events.jsonl')).status, 403);
  const initial = await (await fetch(url + '/api/status')).json();
  assert.equal(initial.source.id, 'rollout-test-one.jsonl');
  assert.equal(initial.transport, 0);
  await appendFile(first, JSON.stringify(completed('integration')) + '\n');
  let after;
  for (let i = 0; i < 60; i++) {
    after = await (await fetch(url + '/api/status')).json();
    if (after.transport === 2) break;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.equal(after.transport, 2);
  const switched = await fetch(url + '/api/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'rollout-test-two.jsonl' }) });
  assert.equal(switched.status, 200);
  const state = await switched.json();
  assert.equal(state.transport, 0);
  assert.equal(state.source.title, '测试会话二');
  const forbidden = await fetch(url + '/api/session', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://unrelated.example' }, body: JSON.stringify({ id: 'rollout-test-one.jsonl' }) });
  assert.equal(forbidden.status, 403);
});
