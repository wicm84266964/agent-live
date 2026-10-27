/**
 * tools/http-server.mjs —— 启动本地事件钩子（给页面/doctor 消费）
 *
 *   node tools/http-server.mjs --port 8787
 *   node tools/http-server.mjs --port 8787 --file my-log.jsonl   # 顺便 tail 一个文件并转发
 *
 * 默认**只绑 127.0.0.1**（见 adapters/http-hook.mjs 的安全说明）。
 * 这里的 `--host` 参数被刻意**不提供** —— 那是常量，不是配置项。
 */
import { openFileSource } from '../adapters/jsonl-file.mjs';
import { startHttpHook } from '../adapters/http-hook.mjs';

const USAGE = `
用法：
  node tools/http-server.mjs [--port <n>] [--file <path>] [--interval <ms>]

可选：
  --port <n>        监听端口（0 = 让系统挑，默认 8787）
  --file <path>     顺便 tail 这个日志文件，把新事件转发进钩子
  --interval <ms>   文件轮询间隔（默认 250）
  --quiet           不打每条转发日志

端点（只在本机 127.0.0.1 上）：
  POST /event       收一条事件，或一批（数组 / {"events":[...]}）
  GET  /events      SSE 事件流（新订阅者会补发最近 200 条）
  GET  /stats       计数与未知 kind 明细
`;

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  process.stdout.write(USAGE);
  process.exit(0);
}

function parseArgs(argv) {
  const o = { port: 8787, file: null, interval: 250, quiet: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') o.port = Number(argv[++i]);
    else if (a === '--file') o.file = argv[++i];
    else if (a === '--interval') o.interval = Number(argv[++i]);
    else if (a === '--quiet') o.quiet = true;
    else if (a === '-h' || a === '--help') o.help = true;
    else {
      process.stderr.write(`[http-server] 不认识的参数：${a}\n${USAGE}`);
      process.exit(2);
    }
  }
  return o;
}

const hook = await startHttpHook({ port: args.port, replay: 500 });
process.stdout.write(`[http-server] 监听 ${hook.url}（只接受本机连接）\n`);
process.stdout.write(`[http-server] POST ${hook.url}/event  ·  SSE ${hook.url}/events\n`);

/** 定期把统计打出来，"转发了几条"必须是可见数字。 */
const tick = () => {
  const s = hook.stats();
  process.stdout.write(
    `[http-server] 收 ${s.total} / 成功 ${s.accepted} / 拒收 ${s.rejected}`
      + ` / 未知 ${s.unknown}${s.unknown > 0 ? `（${s.unknownKindsText}）` : ''}`
      + ` / 订阅者 ${hook.clientCount()}\n`,
  );
};

let fileSrc = null;
let pollTimer = null;
if (args.file) {
  try {
    fileSrc = await openFileSource(args.file);
  } catch (err) {
    process.stderr.write(`[http-server] 打不开文件 ${args.file}：${err.message}\n`);
    await hook.close();
    process.exit(2);
  }
  process.stdout.write(`[http-server] tail ${args.file}（形态 ${fileSrc.shape}，每 ${args.interval}ms）\n`);

  pollTimer = setInterval(async () => {
    try {
      const r = await fileSrc.poll();
      for (const ev of r.events) {
        const res = hook.push(ev);
        if (!res.ok) {
          /* 转发失败的必须说出来，不能默默丢 */
          process.stderr.write(`[http-server] 转发被拒：${JSON.stringify(res.issues)}\n`);
        } else if (!args.quiet) {
          process.stdout.write(`[http-server] -> ${JSON.stringify(res.event)}\n`);
        }
      }
    } catch (err) {
      process.stderr.write(`[http-server] 轮询出错：${err.message}\n`);
    }
  }, args.interval);
  pollTimer.unref?.();
}

const statTimer = setInterval(tick, 5000);
statTimer.unref?.();

/** Ctrl+C 干净收尾：先播尾巴，再关服务。 */
const shutdown = async (sig) => {
  process.stdout.write(`\n[http-server] 收到 ${sig}，关闭中…\n`);
  clearInterval(statTimer);
  if (pollTimer) clearInterval(pollTimer);
  if (fileSrc) await fileSrc.close();
  tick();
  await hook.close();
  process.stdout.write('[http-server] 已关闭\n');
  process.exit(0);
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
