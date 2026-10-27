/**
 * adapters/http-hook.mjs —— 本地 HTTP 事件接收器 + SSE 推送
 *
 * ===== 为什么是 HTTP，而不是让页面直接读文件 =====
 *
 * 浏览器读不到本地文件，更读不到"正在被别的进程追加"的文件。
 * 所以需要一个本机进程站在中间：
 *
 *   你的智能体 --POST--> 127.0.0.1:PORT/event
 *                                   |
 *                                   +--GET /events (SSE)--> 页面 / doctor
 *
 * ===== 只绑 127.0.0.1（安全红线）=====
 *
 * 这个服务**没有任何鉴权** —— 能往它 POST 的人就能往画面上塞事件。
 * 所以它绝不能监听 0.0.0.0：那等于把"往你屏幕上造假战报"的权限
 * 开放给整个局域网。绑定地址是常量 `LISTEN_HOST`，不接受覆盖，
 * 并且 `startHttpHook()` 会**校验**实际监听地址，不是 127.0.0.1 就直接关掉报错。
 *
 * ===== 诚实约束 =====
 *
 * - 非法 JSON / 缺字段：**收下并如实回 400 + 可读原因**，同时计数，
 *   不会因为一条坏事件就把服务弄崩，也不会静默 200 假装收下了。
 * - 未知 kind：**照收**（200），但在响应体里明确告诉我们不认识它、会计入 unknown。
 *   不猜它是哪种已知类型。
 * - 慢客户端：写失败就踢掉，不让一个死连接拖垮整个服务。
 */
import { createServer } from 'node:http';
import { createInbox, normalize, formatIssues } from '../protocol/events.mjs';

/** 唯一允许的监听地址。刻意不做成参数。 */
export const LISTEN_HOST = '127.0.0.1';

/** 新订阅者最多补发多少条历史事件（防止一次灌满浏览器）。 */
export const DEFAULT_REPLAY = 200;

/** POST body 上限，防止一条巨大 body 吃光内存。 */
const MAX_BODY_BYTES = 1024 * 1024;

/**
 * 启动 HTTP 事件钩子。
 *
 * @param {{
 *   port?: number,            0 = 让内核挑一个空闲端口（测试用）
 *   replay?: number,          新订阅者补发最近多少条
 *   now?: () => number,       时钟（测试注入）
 *   onEvent?: (ev, meta) => void,
 *   onIssue?: (issue) => void,
 * }} [opts]
 * @returns {Promise<{
 *   url: string, port: number, host: string,
 *   inbox: ReturnType<typeof createInbox>,
 *   recent: () => object[],
 *   stats: () => object,
 *   close: () => Promise<void>,
 *   push: (ev) => { ok, event, issues },
 *   clientCount: () => number,
 * }>}
 */
export async function startHttpHook(opts = {}) {
  const inbox = createInbox();
  const now = typeof opts.now === 'function' ? opts.now : Date.now;
  const replay = Number.isInteger(opts.replay) ? opts.replay : DEFAULT_REPLAY;
  const onEvent = typeof opts.onEvent === 'function' ? opts.onEvent : () => {};
  const onIssue = typeof opts.onIssue === 'function' ? opts.onIssue : () => {};

  /** 环形缓冲：给后到的 SSE 订阅者补历史，避免"页面打开时已经错过了开头" */
  const buffer = [];
  /** 已连接的 SSE 客户端 */
  const clients = new Set();
  let nextSeq = 1;

  function push(raw, meta = {}) {
    const r = normalize(raw, { now, source: 'http' });
    const accepted = r.ok;
    const result = inbox.push(raw, { now, source: 'http' });

    if (!accepted) {
      for (const i of r.issues) onIssue(i);
      return { ok: false, event: null, issues: r.issues, unknownKind: result.unknownKind };
    }

    const ev = { ...r.event };
    /* seq 只是传输层序号，不属于协议字段；契约里可选、消费方可忽略 */
    if (ev.seq == null) ev.seq = nextSeq++;
    else nextSeq = Math.max(nextSeq, Number(ev.seq) + 1 || nextSeq);

    buffer.push(ev);
    if (buffer.length > replay) buffer.shift();
    broadcast(ev, meta);
    onEvent(ev, meta);
    return { ok: true, event: ev, issues: r.issues, unknownKind: result.unknownKind };
  }

  function broadcast(ev, meta) {
    const payload = `id: ${ev.seq ?? ''}\ndata: ${JSON.stringify(ev)}\n\n`;
    for (const res of [...clients]) {
      try {
        res.write(payload);
      } catch {
        clients.delete(res); // 慢/死客户端：踢掉，不影响别人
      }
    }
    void meta;
  }

  function sseWrite(res, comment) {
    try {
      res.write(`: ${comment}\n\n`);
    } catch {
      clients.delete(res);
    }
  }

  const server = createServer((req, res) => {
    /* 只允许本机来源，且不设宽松 CORS —— 页面和本服务同机即可。
       预检带上最小必要头，其余一律不放开。 */
    const url = new URL(req.url || '/', `http://${LISTEN_HOST}`);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-allow-headers': 'content-type',
        'access-control-max-age': '600',
      });
      res.end();
      return;
    }

    if (req.method === 'POST' && (path === '/event' || path === '/events')) {
      let size = 0;
      const chunks = [];
      let aborted = false;
      req.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY_BYTES) {
          aborted = true;
          res.writeHead(413, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: `body 超过 ${MAX_BODY_BYTES} 字节` }));
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => {
        if (aborted) return;
        const body = Buffer.concat(chunks).toString('utf8');
        if (body.trim() === '') {
          res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: '空 body' }));
          return;
        }

        let parsed;
        try {
          parsed = JSON.parse(body);
        } catch (err) {
          /*
           * 坏 JSON 必须回 400 并说清楚 —— 回 200 会让上游以为发成功了，
           * 然后"事件丢了但没人知道"，这是最糟的失败模式。
           */
          inbox.bad(`POST /event body 不是合法 JSON：${err.message}`);
          res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: `JSON 解析失败：${err.message}` }));
          return;
        }

        /* 允许一次 POST 一批：数组 或 { events: [...] } */
        const batch = Array.isArray(parsed)
          ? parsed
          : parsed && Array.isArray(parsed.events)
            ? parsed.events
            : null;

        if (batch) {
          const results = batch.map((item) => push(item, { via: 'batch' }));
          const rejected = results.filter((r) => !r.ok);
          res.writeHead(rejected.length ? 207 : 200, {
            'content-type': 'application/json; charset=utf-8',
          });
          res.end(
            JSON.stringify({
              ok: rejected.length === 0,
              accepted: results.length - rejected.length,
              rejected: rejected.length,
              issues: rejected.flatMap((r) => formatIssues(r.issues)),
            }),
          );
          return;
        }

        const r = push(parsed, { via: 'single' });
        if (!r.ok) {
          res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
          res.end(
            JSON.stringify({
              ok: false,
              accepted: false,
              rejected: true,
              unknownKind: r.unknownKind || null,
              issues: formatIssues(r.issues),
            }),
          );
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(
          JSON.stringify({
            ok: true,
            accepted: true,
            seq: r.event.seq,
            /*
             * 未知 kind：收下，但明说"我不认识它"。计数在 /stats 里。
             * 不假装它是 tool/tool_end —— 猜错就是伪造战果。
             */
            unknownKind: r.unknownKind || null,
            warnings: formatIssues(r.issues.filter((i) => i.severity === 'warn')),
          }),
        );
      });
      req.on('error', () => {
        /* 客户端半路断开是常态，不是错误 */
      });
      return;
    }

    if (req.method === 'GET' && path === '/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        /* 明确不缓存、不做 X-Accel 缓冲 */
        'x-accel-buffering': 'no',
      });
      res.write(': connected 实况智能体事件流\n\n');
      /*
       * 补发历史：页面晚打开时不该"从下一个事件开始"，
       * 那样它会以为战场是空的。补发多少由 replay 决定，上限如实写进头里。
       */
      try {
        res.write(`retry: 1000\n\n`);
      } catch {
        /* ignore */
      }
      for (const ev of buffer) {
        try {
          res.write(`id: ${ev.seq ?? ''}\ndata: ${JSON.stringify(ev)}\n\n`);
        } catch {
          break;
        }
      }
      clients.add(res);
      sseWrite(res, `replay ${buffer.length} / clients ${clients.size}`);

      /* 心跳：防止中间设备把空闲连接掐掉，也让写失败能被及时发现 */
      const hb = setInterval(() => sseWrite(res, 'ping'), 15000);
      hb.unref?.();

      const drop = () => {
        clearInterval(hb);
        clients.delete(res);
      };
      req.on('close', drop);
      req.on('error', drop);
      res.on('error', drop);
      return;
    }

    if (req.method === 'GET' && (path === '/stats' || path === '/health')) {
      const s = inbox.snapshot();
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(
        JSON.stringify({
          ok: true,
          host: LISTEN_HOST,
          clients: clients.size,
          buffered: buffer.length,
          stats: {
            total: s.total,
            accepted: s.accepted,
            rejected: s.rejected,
            unknown: s.unknown,
            unknownKinds: s.unknownKinds,
            unknownKindsText: s.unknownKindsText,
            byKind: s.byKind,
            badRecords: s.badRecords,
          },
        }),
      );
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
    res.end(
      JSON.stringify({
        ok: false,
        error: `没有这个路径：${req.method} ${path}`,
        routes: ['POST /event', 'GET /events (SSE)', 'GET /stats'],
      }),
    );
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, LISTEN_HOST, () => resolve());
  });

  /*
   * 校验实际监听地址。
   * 这不是形式主义：如果哪天有人把 LISTEN_HOST 改成 0.0.0.0，
   * 这里会立刻关掉服务并报错，而不是安静地把写权限开放到局域网。
   */
  const addr = server.address();
  if (!addr || addr.address !== LISTEN_HOST) {
    await new Promise((r) => server.close(r));
    throw new Error(
      `拒绝启动：实际监听 ${addr && addr.address}，协议要求必须只绑 ${LISTEN_HOST}`,
    );
  }

  const port = addr.port;

  return {
    url: `http://${LISTEN_HOST}:${port}`,
    port,
    host: LISTEN_HOST,
    inbox,
    recent: () => buffer.slice(),
    stats: () => inbox.snapshot(),
    push,
    clientCount: () => clients.size,
    async close() {
      for (const res of [...clients]) {
        try {
          res.write(': bye\n\n');
          res.end();
        } catch {
          /* ignore */
        }
        clients.delete(res);
      }
      await new Promise((resolve) => {
        server.close(() => resolve());
        /* SSE 的 keep-alive 连接会拖住 close，主动断掉 */
        server.closeAllConnections?.();
      });
    },
  };
}

/**
 * 消费一个 SSE 端点，逐个产出事件。给 doctor 的 `--http <url>` 用。
 *
 * @param {string} url  形如 http://127.0.0.1:8787/events 或 http://127.0.0.1:8787
 * @param {{ onEvent, onIssue?, signal?, idleMs? }} opts
 * @returns {Promise<{ received: number, aborted: boolean }>}
 */
export async function consumeSse(url, opts = {}) {
  const onEvent = opts.onEvent || (() => {});
  const onIssue = opts.onIssue || (() => {});
  const target = normalizeSseUrl(url);
  let received = 0;
  let aborted = false;

  let res;
  try {
    res = await fetch(target, {
      headers: { accept: 'text/event-stream' },
      signal: opts.signal,
    });
  } catch (err) {
    onIssue({ code: 'connect-failed', message: `连不上 ${target}：${err.message}` });
    return { received, aborted: true };
  }
  if (!res.ok || !res.body) {
    onIssue({ code: 'bad-status', message: `${target} 返回 ${res.status}` });
    return { received, aborted: true };
  }

  const decoder = new TextDecoder();
  let buf = '';
  try {
    for await (const chunk of res.body) {
      buf += decoder.decode(chunk, { stream: true });
      let idx = buf.indexOf('\n\n');
      while (idx !== -1) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const data = frame
          .split('\n')
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trim())
          .join('\n');
        if (data) {
          try {
            onEvent(JSON.parse(data));
            received++;
          } catch (err) {
            onIssue({ code: 'bad-sse-frame', message: `SSE 帧不是合法 JSON：${err.message}` });
          }
        }
        idx = buf.indexOf('\n\n');
      }
      if (opts.stopWhen && opts.stopWhen(received)) {
        aborted = true;
        break;
      }
    }
  } catch (err) {
    if (err && err.name === 'AbortError') aborted = true;
    else onIssue({ code: 'stream-failed', message: `SSE 流中断：${err.message}` });
  }
  return { received, aborted };
}

/** 把 `http://host:port` 补成 `.../events`，其他路径原样。 */
export function normalizeSseUrl(url) {
  const u = new URL(url);
  if (u.pathname === '/' || u.pathname === '') u.pathname = '/events';
  return u.toString();
}
