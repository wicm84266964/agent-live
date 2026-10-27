/** Tail a single Codex session, projecting completed calls through the existing adapter. */
import { open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { projectCodexSession } from '../adapters/codex-session.mjs';
import { startHttpHook } from '../adapters/http-hook.mjs';

const argv = process.argv.slice(2);
let file;
let port = 8787;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--file' && argv[i + 1]) file = resolve(argv[++i]);
  else if (argv[i] === '--port' && argv[i + 1]) port = Number(argv[++i]);
  else throw new Error('Usage: node tools/codex-live.mjs --file <session.jsonl> [--port 8787]');
}
if (!file || !Number.isInteger(port) || port < 0 || port > 65535) {
  throw new Error('A session --file and valid port are required');
}
const input = await open(file, 'r');
let offset = (await input.stat()).size;
// Ignore a partial line already present when attaching; never parse a fragment as a record.
let skipPartial = false;
if (offset) {
  const last = Buffer.alloc(1);
  await input.read(last, 0, 1, offset - 1);
  skipPartial = last[0] !== 10;
}
const hook = await startHttpHook({ port, replay: 500 });
console.log(`[codex-live] ${file}`);
console.log(`[codex-live] ${hook.url} · watching NEW records every 250ms`);
console.log('[codex-live] Completed calls only; start/end use recorded timestamps and duration.');
let pending = Buffer.alloc(0);
let timer;
let closing = false;
let active = Promise.resolve();
let forwarded = 0;

async function poll() {
  const size = (await input.stat()).size;
  if (size < offset) throw new Error('Session was truncated; restart with the correct session file');
  if (size === offset) return;
  const chunk = Buffer.alloc(Math.min(size - offset, 1024 * 1024));
  const { bytesRead } = await input.read(chunk, 0, chunk.length, offset);
  offset += bytesRead;
  pending = Buffer.concat([pending, chunk.subarray(0, bytesRead)]);
  let end;
  while ((end = pending.indexOf(10)) !== -1) {
    const line = pending.subarray(0, end);
    pending = pending.subarray(end + 1);
    if (skipPartial) { skipPartial = false; continue; }
    if (!line.toString('utf8').trim()) continue;
    const record = JSON.parse(line.toString('utf8'));
    const result = projectCodexSession([record]);
    if (result.issues.length) throw new Error(JSON.stringify(result.issues));
    for (const event of result.events) {
      if (event.kind !== 'turn_end' && !event.id) throw new Error('Projected tool has no id');
      const pushed = hook.push(event);
      if (!pushed.ok) throw new Error(JSON.stringify(pushed.issues));
      forwarded++;
    }
    if (result.events.length) console.log(`[codex-live] forwarded ${forwarded} events; clients=${hook.clientCount()}`);
  }
}

async function stop(code) {
  if (closing) return;
  closing = true;
  clearTimeout(timer);
  await active.catch(() => {});
  await input.close();
  await hook.close();
  process.exit(code);
}
function schedule() {
  timer = setTimeout(() => {
    active = poll();
    active.then(() => { if (!closing) schedule(); }, err => {
      console.error(`[codex-live] STOP: ${err.message}`);
      void stop(1);
    });
  }, 250);
}
schedule();
process.on('SIGINT', () => void stop(0));
process.on('SIGTERM', () => void stop(0));
