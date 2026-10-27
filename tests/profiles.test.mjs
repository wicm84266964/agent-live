/**
 * 内置 profile 的真实形状夹具。
 * 夹具按公开日志形状手写，不含本机路径和工具正文。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { classify, TIER } from '../bestiary.mjs';
import { projectCodexSession, explicitOk } from '../adapters/codex-session.mjs';
import { prepareSourceRecords } from '../adapters/prepare.mjs';
import { SCHEMA, KNOWN_KINDS } from '../protocol/events.mjs';
import { pairReport } from '../protocol/events.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

function runDoctor(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['tools/doctor.mjs', ...args], {
      cwd: ROOT,
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (b) => { stdout += b; });
    child.stderr.on('data', (b) => { stderr += b; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'agent-live-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('工具名大小写不影响品级：Read/Bash/Task/CommandExecution', () => {
  assert.equal(classify('Read').tier, TIER.MINION);
  assert.equal(classify('Read').rule, true);
  assert.equal(classify('Bash').tier, TIER.ELITE);
  assert.equal(classify('Task').tier, TIER.BOSS);
  assert.equal(classify('CommandExecution').tier, TIER.ELITE);
  assert.equal(classify('McpToolCall').tier, TIER.ELITE);
  assert.equal(classify('agent_run').tier, TIER.BOSS);
});

test('Codex 会话投影：显式 exit_code / status，跳过没有成败的记录', () => {
  assert.equal(explicitOk({ exit_code: 0, status: 'failed' }), true, 'exit_code 优先于 status');
  assert.equal(explicitOk({ status: 'failed' }), false);
  assert.equal(explicitOk({ path: 'x.png' }), null);

  const projected = projectCodexSession([
    {
      timestamp: '2026-10-27T00:00:02.664Z',
      type: 'event_msg',
      payload: {
        type: 'item_completed',
        item: {
          type: 'CommandExecution',
          id: 'exec-1',
          status: 'completed',
          exit_code: 0,
          duration: { secs: 2, nanos: 664000000 },
          command: 'secret-command',
          cwd: 'C:\\secret',
        },
      },
    },
    {
      timestamp: '2026-10-27T00:00:03.000Z',
      type: 'event_msg',
      payload: {
        type: 'item_completed',
        item: { type: 'ImageView', id: 'img-1', path: 'a.png' },
      },
    },
    {
      timestamp: '2026-10-27T00:00:03.500Z',
      type: 'event_msg',
      payload: {
        type: 'item_completed',
        item: { type: 'FileChange', id: 'fc-1' },
      },
    },
    {
      timestamp: '2026-10-27T00:00:04.000Z',
      type: 'event_msg',
      payload: { type: 'task_complete' },
    },
  ]);
  assert.equal(projected.stats.projected, 1);
  assert.equal(projected.stats.skippedNoStatus, 1, 'FileChange 没有 status 必须跳过');
  assert.ok(projected.stats.skippedOther >= 1, 'ImageView 不是可投影的工具类型');
  assert.equal(projected.stats.turnEnds, 1);
  assert.equal(projected.events.some((e) => JSON.stringify(e).includes('secret')), false);
  const start = projected.events.find((e) => e.kind === 'tool');
  const end = projected.events.find((e) => e.kind === 'tool_end');
  assert.equal(end.ok, true);
  assert.equal(end.id, 'exec-1');
  assert.equal(end.realMs, 2664);
  assert.equal(start.ts, end.ts - 2664);
  assert.equal(pairReport(projected.events).perfect, true);
});

test('doctor --profile claude-code 直接吃嵌套 transcript', async () => {
  await withTempDir(async (dir) => {
    const f = join(dir, 'claude.jsonl');
    const lines = [
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-10-27T00:00:00.000Z',
        message: {
          content: [
            { type: 'text', text: 'reading' },
            { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: 'secret.txt' } },
          ],
        },
      }),
      JSON.stringify({
        type: 'user',
        timestamp: '2026-10-27T00:00:00.012Z',
        message: {
          content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'secret body' }],
        },
      }),
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-10-27T00:00:01.000Z',
        message: {
          content: [{ type: 'tool_use', id: 'toolu_2', name: 'Bash', input: { command: 'nope' } }],
        },
      }),
      JSON.stringify({
        type: 'user',
        timestamp: '2026-10-27T00:00:01.100Z',
        message: {
          content: [{ type: 'tool_result', tool_use_id: 'toolu_2', is_error: true, content: 'fail' }],
        },
      }),
    ];
    await writeFile(f, lines.join('\n') + '\n', 'utf8');
    const r = await runDoctor(['--file', f, '--profile', 'claude-code', '--json']);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    const j = JSON.parse(r.stdout);
    assert.equal(j.pairing.perfect, true);
    assert.equal(j.totals.byKind.tool, 2);
    assert.equal(j.totals.byKind.tool_end, 2);
    assert.equal(j.mapping.okVia['absent-success'], 1);
    assert.equal(r.stdout.includes('secret'), false);
    assert.match(r.stdout, /absent-success/);
  });
});

test('doctor --profile codex-session 投影后 exit 0', async () => {
  await withTempDir(async (dir) => {
    const f = join(dir, 'session.jsonl');
    await writeFile(f, JSON.stringify({
      timestamp: '2026-10-27T00:00:01.000Z',
      type: 'event_msg',
      payload: {
        type: 'item_completed',
        item: {
          type: 'McpToolCall',
          id: 'mcp-1',
          tool: 'mcp__demo__ping',
          status: 'failed',
          duration: { secs: 1, nanos: 0 },
          arguments: { token: 'leak' },
        },
      },
    }) + '\n', 'utf8');
    const r = await runDoctor(['--file', f, '--profile', 'codex-session']);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /id 配对\s+1\/1/);
    assert.match(r.stdout, /预处理\s+codex-session/);
    assert.equal(r.stdout.includes('leak'), false);
  });
});

test('doctor --out 只在 exit 0 时写出页面可拖入的 JSONL', async () => {
  await withTempDir(async (dir) => {
    const src = join(dir, 'rollout.jsonl');
    const out = join(dir, 'codex-events.jsonl');
    const badOut = join(dir, 'should-not-exist.jsonl');
    await writeFile(src, JSON.stringify({
      timestamp: '2026-10-27T00:00:01.000Z',
      type: 'event_msg',
      payload: {
        type: 'item_completed',
        item: {
          type: 'CommandExecution',
          id: 'exec-out',
          status: 'completed',
          exit_code: 0,
          duration: { secs: 1, nanos: 0 },
          command: 'do-not-copy',
        },
      },
    }) + '\n', 'utf8');
    const ok = await runDoctor(['--file', src, '--profile', 'codex-session', '--out', out]);
    assert.equal(ok.code, 0, ok.stdout + ok.stderr);
    assert.match(ok.stdout, /已写出/);
    const lines = readFileSync(out, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(lines[0].kind, 'tool');
    assert.equal(lines[1].kind, 'tool_end');
    assert.equal(lines[1].ok, true);
    assert.equal(JSON.stringify(lines).includes('do-not-copy'), false);

    const bad = await runDoctor([
      '--file', src, '--profile', 'cursor', '--out', badOut,
    ]);
    assert.notEqual(bad.code, 0);
    assert.equal(existsSync(badOut), false);
    assert.match(bad.stderr, /不写出/);
  });
});

test('协议 JSON Schema 的 kind 与必填字段跟代码一致', () => {
  const schema = JSON.parse(readFileSync(new URL('../protocol/event.v1.json', import.meta.url), 'utf8'));
  assert.deepEqual(schema.properties.kind.enum, [...KNOWN_KINDS]);
  assert.equal(schema.properties.ok.type, SCHEMA.ok.type);
  assert.equal(schema.properties.tool.type, SCHEMA.tool.type);
  assert.ok(schema.allOf.some((b) => b.then && b.then.required.includes('ok')));
  assert.equal(prepareSourceRecords({ preprocess: 'claude-content' }, []).mode, 'claude-content');
});
