import { createServer, request as httpRequest } from 'node:http';
import { readFile, readdir, stat, open } from 'node:fs/promises';
import { dirname, resolve, join, extname, basename, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { startHttpHook } from '../adapters/http-hook.mjs';
import { openSessionTail } from '../adapters/session-tail.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sessionRoot = process.env.AGENT_LIVE_SESSIONS || join(homedir(), '.codex', 'sessions');
const args = process.argv.slice(2);
let selectedFile = null;
let port = Number(process.env.PORT || 5173);
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--file' && args[i + 1]) selectedFile = resolve(args[++i]);
  else if (args[i] === '--port' && args[i + 1]) port = Number(args[++i]);
  else throw new Error('Usage: npm start -- [--file <rollout.jsonl>] [--port 5173]');
}
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid port');
let sessions = [];
let reader = null;
let selected = null;
let lastEventAt = null;
let readError = null;
let warnings = [];
let busy = false;
let switching = false;
let shuttingDown = false;
const hook = await startHttpHook({ port: 0, replay: 1000 });

async function discover() {
  const files = [];
  async function walk(dir, depth = 0) {
    if (depth > 4) return;
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path, depth + 1);
      else if (entry.isFile() && /^rollout-.*\.jsonl$/.test(entry.name)) {
        const info = await stat(path).catch(() => null);
        if (info) files.push({ id: entry.name, path, updatedAt: info.mtimeMs, size: info.size });
      }
    }
  }
  await walk(sessionRoot);
  files.sort((a, b) => b.updatedAt - a.updatedAt);
  sessions = await Promise.all(files.slice(0, 30).map(async file => {
    let cwd = '', title = '';
    const input = await open(file.path, 'r').catch(() => null);
    if (input) {
      try {
        const buffer = Buffer.alloc(1024 * 1024);
        const { bytesRead } = await input.read(buffer, 0, buffer.length, 0);
        for (const line of buffer.subarray(0, bytesRead).toString('utf8').split('\n')) {
          try {
            const rec = JSON.parse(line);
            if (rec.type === 'session_meta') cwd = rec.payload?.cwd || '';
            if (rec.type === 'event_msg' && rec.payload?.type === 'user_message') {
              title = String(rec.payload.message || '').replace(/<[^>]*>[\s\S]*?<\/[^>]*>/g, '').trim().slice(0, 70);
              if (title) break;
            }
            if (rec.type === 'event_msg' && rec.payload?.type === 'item_completed' && rec.payload.item?.type === 'UserMessage') {
              title = (rec.payload.item.content || []).filter(c => typeof c.text === 'string').map(c => c.text).join(' ').replace(/<[^>]*>[\s\S]*?<\/[^>]*>/g, '').replace(/\s+/g, ' ').trim().slice(0, 70);
              if (title) break;
            }
          } catch { /* incomplete line is not a record */ }
        }
      } finally { await input.close(); }
    }
    return { ...file, cwd, title: title || basename(cwd) || file.id.slice(8, 27) };
  }));
  return sessions;
}
async function select(file) {
  if (switching) throw new Error('正在切换会话，请稍候');
  switching = true;
  try {
    // Opening first preserves the previous source when selection fails.
    const next = await openSessionTail(file.path);
    if (reader) await reader.close();
    reader = next;
    selected = file;
    readError = null;
    warnings = [];
    lastEventAt = null;
    hook.reset();
  } finally { switching = false; }
}
const publicSession = s => s && ({ id: s.id, title: s.title, cwd: s.cwd, updatedAt: s.updatedAt });
const status = () => ({
  ok: !readError, source: publicSession(selected), mode: 'completion',
  reader: reader ? { ...reader.stats } : null, lastEventAt,
  error: readError, warnings, transport: hook.stats().total,
});
const json = (res, code, value) => {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
};
const mime = { '.html': 'text/html', '.css': 'text/css', '.mjs': 'text/javascript', '.js': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (['/event', '/events', '/stats', '/health'].includes(url.pathname)) {
      const upstream = httpRequest({ hostname: '127.0.0.1', port: hook.port, path: req.url, method: req.method, headers: req.headers }, reply => {
        res.writeHead(reply.statusCode, reply.headers);
        reply.pipe(res);
      });
      upstream.on('error', () => { if (!res.headersSent) json(res, 502, { error: '事件通道不可用' }); else res.end(); });
      res.on('close', () => upstream.destroy());
      req.pipe(upstream);
      return;
    }
    if (url.pathname === '/api/status' && req.method === 'GET') return json(res, 200, status());
    if (url.pathname === '/api/sessions' && req.method === 'GET') return json(res, 200, { sessions: (await discover()).map(publicSession) });
    if (url.pathname === '/api/session' && req.method === 'POST') {
      if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) return json(res, 403, { error: '只接受当前页面发起的切换' });
      let body = '';
      for await (const chunk of req) { body += chunk; if (body.length > 4096) return json(res, 413, { error: '请求过大' }); }
      let id;
      try { id = JSON.parse(body).id; } catch { return json(res, 400, { error: '无效请求' }); }
      const file = sessions.find(s => s.id === id);
      if (!file) return json(res, 404, { error: '会话不在发现列表中，请刷新列表' });
      if (busy || switching) return json(res, 409, { error: '正在读取日志，请重试' });
      await select(file);
      return json(res, 200, status());
    }
    if (!['GET', 'HEAD'].includes(req.method)) return json(res, 405, { error: 'Method not allowed' });
    let relative;
    try { relative = decodeURIComponent(url.pathname); } catch { return json(res, 400, { error: 'Invalid path' }); }
    if (relative === '/') relative = '/index.html';
    const path = resolve(root, '.' + relative);
    const segments = relative.split(/[\\/]/);
    if (!path.startsWith(root + sep) || segments.some(s => s.startsWith('.')) || !mime[extname(path)] || /^(tools|tests|sample|adapters|protocol)\b/.test(segments[1]) && extname(path) !== '.mjs') {
      return json(res, 403, { error: 'Forbidden' });
    }
    // Only product assets are public; generated session exports are private.
    if (/codex-events|rollout-|tmp-live-proof/.test(relative)) return json(res, 403, { error: 'Private local artifact' });
    const data = await readFile(path).catch(() => null);
    if (!data) return json(res, 404, { error: 'Not found' });
    res.writeHead(200, { 'content-type': mime[extname(path)] + '; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    res.end(req.method === 'HEAD' ? undefined : data);
  } catch (err) { if (!res.headersSent) json(res, 500, { error: err.message }); else res.end(); }
});
await discover();
const initial = selectedFile ? sessions.find(s => s.path === selectedFile) || { path: selectedFile, id: basename(selectedFile), title: basename(dirname(root)), cwd: root } : sessions[0];
if (initial) await select(initial);
await new Promise((yes, no) => { server.once('error', no); server.listen(port, '127.0.0.1', yes); });
console.log(`\n  AGENT LIVE · http://127.0.0.1:${server.address().port}/\n  ${selected?.title || '尚未发现 Codex 会话'}\n  工具完成后自动同步 · 仅本机 · Ctrl+C 停止\n`);
const timer = setInterval(async () => {
  if (busy || switching || !reader || readError || shuttingDown) return;
  busy = true;
  try {
    const result = await reader.poll();
    warnings = [...warnings, ...result.issues].slice(-10);
    for (const event of result.events) {
      const pushed = hook.push(event);
      if (!pushed.ok) throw new Error('事件校验失败，已停止读取');
      lastEventAt = Date.now();
    }
  } catch (err) { readError = err.message; console.error(`[session] ${readError}`); }
  finally { busy = false; }
}, 250);
async function stop() {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(timer);
  server.close();
  await hook.close();
  if (reader) await reader.close();
  process.exit(0);
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
