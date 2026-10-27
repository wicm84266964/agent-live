/**
 * tools/demo-http-hook.mjs —— 一次性演示：真起 HTTP 服务、POST、SSE 收到、再关闭
 *
 * 这不是产品入口（正式用法见 docs/ADAPTERS.md），
 * 它的唯一作用是**把 HTTP 接入的完整生命周期跑一遍并留证据**：
 *
 *   1. startHttpHook() 起服务（绑 127.0.0.1:随机端口）
 *   2. 先连 SSE（GET /events），确认连接建立
 *   3. POST 一条真实形状的事件
 *   4. 确认 SSE 端真的收到了这一条
 *   5. 再 POST 一条**坏的**，确认被 400 拒收且原因可读
 *   6. 再 POST 一条**未知 kind**，确认被收下但明确报告"不认识"
 *   7. 打印 /stats
 *   8. 关闭服务，确认端口释放
 *
 * 任何一步不符合预期就 exit 1 —— 这样它能进 CI。
 */
import { startHttpHook, consumeSse } from '../adapters/http-hook.mjs';

const log = (s) => process.stdout.write(`${s}\n`);
const fail = (s) => {
  process.stderr.write(`  x ${s}\n`);
  process.exitCode = 1;
};

async function waitFor(cond, timeoutMs = 3000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return false;
}

const hook = await startHttpHook({ port: 0 });
const ctrl = new AbortController();
const received = [];

try {
  log('=== HTTP 接入端到端 ===');
  log(`  1) 服务已启动   ${hook.url}（host=${hook.host}）`);

  /* 先连 SSE，确保后面测的是"实时推送"而不是 replay 补发 */
  const sseDone = consumeSse(hook.url, {
    signal: ctrl.signal,
    stopWhen: (n) => n >= 1,
    onEvent: (e) => received.push(e),
    onIssue: (i) => fail(`SSE 问题：${i.code} ${i.message}`),
  });
  const connected = await waitFor(() => hook.clientCount() > 0);
  if (!connected) fail('SSE 订阅者没有连上');
  log(`  2) SSE 已连接   订阅者 ${hook.clientCount()} 个，端点 ${hook.url}/events`);

  /* 3) POST 一条真实形状的事件 */
  const payload = { kind: 'tool', tool: 'read_file', id: 'demo-1', ts: 1000, realMs: 42 };
  const res = await fetch(`${hook.url}/event`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await res.json();
  log(`  3) POST /event  ${res.status} ${JSON.stringify(body)}`);
  if (res.status !== 200 || body.ok !== true) fail('POST 没有被接受');

  /* 4) SSE 必须收到 */
  const sse = await sseDone;
  if (sse.received !== 1 || received[0]?.tool !== 'read_file') {
    fail(`SSE 没收到预期事件（收到 ${sse.received} 条）`);
  } else {
    log(`  4) SSE 收到     ${JSON.stringify(received[0])}`);
  }

  /* 5) 坏 JSON 必须被拒且原因可读 */
  const badRes = await fetch(`${hook.url}/event`, { method: 'POST', body: '{not json' });
  const badBody = await badRes.json();
  log(`  5) 坏 JSON      ${badRes.status} ${JSON.stringify(badBody)}`);
  if (badRes.status !== 400 || badBody.ok !== false) fail('坏 JSON 没有被拒绝');

  /* 6) 缺字段必须被拒且说清缺什么 */
  const missRes = await fetch(`${hook.url}/event`, {
    method: 'POST',
    body: JSON.stringify({ kind: 'tool_end', ts: 1 }),
  });
  const missBody = await missRes.json();
  log(`  6) 缺字段       ${missRes.status} issues=${JSON.stringify(missBody.issues)}`);
  if (missRes.status !== 400) fail('缺字段事件没有被拒绝');

  /* 7) 未知 kind：收下但如实报告 */
  const unkRes = await fetch(`${hook.url}/event`, {
    method: 'POST',
    body: JSON.stringify({ kind: 'tool_use', tool: 'Read', ts: 2 }),
  });
  const unkBody = await unkRes.json();
  log(`  7) 未知 kind    ${unkRes.status} unknownKind=${JSON.stringify(unkBody.unknownKind)}`);
  if (unkRes.status !== 200 || unkBody.unknownKind !== 'tool_use') {
    fail('未知 kind 的处理不符合"照收 + 如实报告"');
  }

  /* 8) /stats */
  const st = await (await fetch(`${hook.url}/stats`)).json();
  log(
    `  8) GET /stats   accepted=${st.stats.accepted} unknown=${st.stats.unknown}`
      + ` badRecords=${st.stats.badRecords} 未知明细=${st.stats.unknownKindsText}`,
  );
} catch (err) {
  fail(`异常：${err.message}`);
} finally {
  ctrl.abort();
  await hook.close();

  /* 9) 关掉之后确实连不上了（证明真的关干净了，没有残留监听） */
  let closed = false;
  try {
    await fetch(`${hook.url}/stats`, { signal: AbortSignal.timeout(500) });
  } catch {
    closed = true;
  }
  log(`  9) 服务已关闭   端口 ${hook.port} 不再响应 ${closed ? 'OK' : '（仍在响应？）'}`);
  if (!closed) fail('close() 之后服务还在响应');
  log(`  结论            ${process.exitCode ? '不通过' : '通过'}`);
}
