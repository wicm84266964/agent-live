#!/usr/bin/env node
/**
 * tools/doctor.mjs —— 事件源自检
 *
 * ===== 它回答的问题 =====
 *
 * "我接的这个数据源，到底能不能用？"
 *
 * 不是"看起来还行"，而是可判定的结论：
 *   - 事件总数 / 分类型计数
 *   - 未知 kind 计数（不认识的类型有多少，分别叫什么）
 *   - id 配对率（每次调用是不是都有对应的结束）
 *   - 重复上报数
 *   - 时间跨度 + 耗时分布（min / median / p90 / max，以及有多少种不同耗时）
 *   - 坏记录数（不是合法 JSON 的行、缺字段的记录）
 *
 * 有问题 → **exit 非 0**。这样它能进 CI、能进 `npm run check`，
 * 而不是又一个"跑完打印一堆绿色但没人看"的脚本。
 *
 * ===== 为什么三种输入都要有 =====
 *
 *   --file <path>   本地文件（JSONL 追加中 / JSON 带 events 数组 / JSON 数组）
 *   --stdin         管道（任何能吐一行 JSON 的智能体）
 *   --http <url>    正在跑的 http-hook（读 SSE，收到 N 条就断）
 *
 * 三种输入的失败模式完全不同（文件被截断 / 管道提前关闭 / 服务没起），
 * 所以分三条路径实现，不硬凑成一个抽象。
 *
 * ===== 退出码 =====
 *   0  一切正常
 *   1  数据有问题（配对漏了、未知 kind、坏记录、重复上报……）
 *   2  用法错误 / 输入源根本打不开
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import {
  createInbox,
  pairReport,
  duplicateReport,
  describeTimeline,
  KIND,
} from '../protocol/events.mjs';
import { readFileOnce, FILE_SHAPE } from '../adapters/jsonl-file.mjs';
import { collectStdin } from '../adapters/stdin.mjs';
import { consumeSse } from '../adapters/http-hook.mjs';
import { loadProfile, createMapStats } from '../adapters/generic.mjs';
import { prepareSourceRecords } from '../adapters/prepare.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROFILE_DIR = join(HERE, '..', 'adapters', 'profiles');

const USAGE = `
用法：
  node tools/doctor.mjs --file <path>            检查本地文件（JSONL 或带 events 数组的 JSON）
  node tools/doctor.mjs --stdin                  从标准输入检查（管道）
  node tools/doctor.mjs --http <url>             连一个 http-hook 的 SSE 端点检查

可选：
  --profile <name|path>   先用 adapters/profiles 里的映射配置翻译再检查
                          （内置：claude-code / codex / codex-session / cursor；也可给 .json 路径）
  --max <n>               --http / --stdin 最多收多少条（--http 默认 200，收满即断）
  --strict                把 warn 也当失败（缺 id 之类）
  --json                  输出机器可读 JSON
  --quiet                 只打结论行

示例：
  node tools/doctor.mjs --file real-events.json
  cat my-log.jsonl | node tools/doctor.mjs --stdin
  node tools/doctor.mjs --file codex.jsonl --profile codex
  node tools/doctor.mjs --http http://127.0.0.1:8787/events --max 50
`;

const args = parseArgs(process.argv.slice(2));

if (args.help || (!args.file && !args.stdin && !args.http)) {
  process.stdout.write(USAGE);
  /* 什么都不给 = 用法错误；--help 是正常退出 */
  process.exit(args.help ? 0 : 2);
}

main().catch((err) => {
  console.error(`[doctor] 致命错误：${err && err.message ? err.message : err}`);
  process.exit(2);
});

/* ------------------------------------------------------------------ *
 * 参数
 * ------------------------------------------------------------------ */

function parseArgs(argv) {
  const out = {
    file: null,
    stdin: false,
    http: null,
    profile: null,
    max: null,
    strict: false,
    json: false,
    quiet: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--file': out.file = need(argv, ++i, a); break;
      case '--stdin': out.stdin = true; break;
      case '--http': out.http = need(argv, ++i, a); break;
      case '--profile': out.profile = need(argv, ++i, a); break;
      case '--max': out.max = Number(need(argv, ++i, a)); break;
      case '--strict': out.strict = true; break;
      case '--json': out.json = true; break;
      case '--quiet': out.quiet = true; break;
      case '-h': case '--help': out.help = true; break;
      default:
        if (a.startsWith('--')) {
          console.error(`[doctor] 不认识的参数：${a}\n${USAGE}`);
          process.exit(2);
        }
        /* 裸参数当文件名，方便 `doctor my-log.jsonl` */
        if (!out.file) out.file = a;
        else {
          console.error(`[doctor] 多余的参数：${a}`);
          process.exit(2);
        }
    }
  }
  return out;
}

function need(argv, i, flag) {
  const v = argv[i];
  if (v == null || v.startsWith('--')) {
    console.error(`[doctor] ${flag} 需要一个值`);
    process.exit(2);
  }
  return v;
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

async function main() {
  const inbox = createInbox();
  let mapper = null;

  if (args.profile) {
    try {
      mapper = loadProfile(args.profile, {
        readFile: (p) => readFileSync(p, 'utf8'),
        profileDir: PROFILE_DIR,
      });
    } catch (err) {
      console.error(`[doctor] 加载映射配置失败：${err.message}`);
      process.exit(2);
    }
  }

  const mapStats = mapper ? createMapStats({ maxExamples: 8 }) : null;

  /** 所有来源最终都汇到 collected 这一个数组 + inbox。 */
  const collected = [];
  const source = { type: null, target: null, shape: null, lines: 0, badLines: 0, note: '' };
  /*
   * **文件层** issue（适配器 `readFileOnce()` 的产物），与 inbox 的 issue 不是一回事。
   * 单独存一份，才能保证"解析失败"这类**病因**被优先呈现，而不是被
   * 下游派生出来的症状（"事件流是空的"）盖住。
   */
  const fileIssues = [];

  let prepareInfo = null;

  function ingest(raw, opts) {
    if (mapper && !(opts && opts.alreadyProtocol)) {
      const r = mapper.mapRecord(raw, opts);
      mapStats.count(raw, r);
      if (!r.mapped) return; // 如实跳过，已在 mapStats 里分类计数
      const res = inbox.push(r.event, { now: opts && opts.now });
      if (res.ok) collected.push(res.event);
      return;
    }
    const res = inbox.push(raw, opts && opts.now ? { now: opts.now } : undefined);
    if (res.ok) collected.push(res.event);
  }

  function feedIncoming(records) {
    if (mapper && mapper.config && mapper.config.preprocess) {
      prepareInfo = prepareSourceRecords(mapper.config, records);
      if (prepareInfo.events) {
        for (const ev of prepareInfo.events) ingest(ev, { alreadyProtocol: true });
        return;
      }
      for (const ev of prepareInfo.records) ingest(ev);
      return;
    }
    for (const ev of records) ingest(ev);
  }

  /* ---------------- --file ---------------- */
  if (args.file) {
    source.type = 'file';
    source.target = resolve(args.file);
    let r;
    try {
      r = await readFileOnce(source.target);
    } catch (err) {
      console.error(`[doctor] 打不开文件 ${source.target}：${err.message}`);
      process.exit(2);
    }
    source.shape = r.shape;
    source.badLines = r.badLines.length;
    /*
     * 文件层 issue（`readFileOnce()` 返回的 `r.issues`）**必须消费**。
     *
     * 这里曾有一个只吃 `r.shape / r.badLines / r.events` 的版本：
     * 整份 JSON 解析失败时适配器已经如实返回
     * `issues: [{ code: 'parse-failed', message: <真实原因> }]`，
     * 而 doctor 把它整个丢掉 → 屏幕上只剩"事件流是空的"。
     * 病因 100% 丢失，读的人会去查"通道是不是没接上"，
     * 而真正的问题是"这份文件本身就没写完 / 写坏了"。
     *
     * 注意别和 `printReport()` 里的 `r.issues` 搞混：那里是
     * `inboxSnap.issues.slice().**字符串**数组`（来自 inbox），
     * 这里是**适配器的对象数组**（来自文件解析）。同名不同源。
     */
    const landedIssues = Array.isArray(r.issues) ? r.issues : [];
    /*
     * `bad-line` 不收进来：它们已经逐条走了 `inbox.bad()`。
     * 再在这里收一遍就成了"同一条坏行打印两次"，
     * 看起来像"有两处不同的错"，实际只有一处 —— 重复报错本身也是失真。
     * 这里只留 bad-line 之外的**文件层** issue（parse-failed 之类）。
     */
    for (const i of landedIssues) {
      if (i && i.code !== 'bad-line') fileIssues.push(i);
    }
    const fatalFileIssue = fileIssues.find((i) => i && i.code === 'parse-failed');
    /*
     * 整份 JSON 解析失败时，逐行口径可能吐出几十条碎片化坏行。
     * 那些碎片是**一个**病因的症状，不是几十个独立问题：
     * 逐条刷屏会把真病因挤到屏幕最下面。这里折叠成一条。
     * （单个坏行的 JSONL 不走这条分支，行为保持不变。）
     */
    if (!fatalFileIssue) {
      for (const b of r.badLines) {
        inbox.bad(`第 ${b.line} 行不是合法 JSON：${b.message}`, { line: b.line });
      }
    }
    feedIncoming(r.events);
  }

  /* ---------------- --stdin ---------------- */
  if (args.stdin) {
    source.type = 'stdin';
    source.target = '<stdin>';
    const r = await collectStdin(process.stdin, {
      maxEvents: Number.isFinite(args.max) ? args.max : undefined,
    });
    source.lines = r.linesSeen;
    source.badLines = r.badLines.length;
    source.shape = 'jsonl';
    if (r.truncated) {
      inbox.note('warn', 'stdin-truncated', `stdin 事件超过 --max ${args.max}，后续已忽略`);
    }
    for (const b of r.badLines) {
      inbox.bad(`第 ${b.line} 行不是合法 JSON：${b.message}`, { line: b.line });
    }
    feedIncoming(r.events);
    if (r.lines === 0 && r.badLines.length === 0) {
      inbox.note('warn', 'stdin-empty', 'stdin 没有任何非空行');
    }
  }

  /* ---------------- --http ---------------- */
  if (args.http) {
    source.type = 'http';
    source.target = args.http;
    const want = Number.isFinite(args.max) ? args.max : 200;
    const ctrl = new AbortController();
    let connectFailed = false;
    const r = await consumeSse(args.http, {
      signal: ctrl.signal,
      stopWhen: (n) => n >= want,
      onEvent: (ev) => ingest(ev),
      onIssue: (i) => {
        /*
         * 连不上 / 非 2xx 属于**输入源打不开**，不是"数据有问题"。
         * 两者都是失败，但意义不同：前者是接线没接好（exit 2），
         * 后者是接好了但数据脏（exit 1）。混为一谈会让人查错方向。
         */
        if (i.code === 'connect-failed' || i.code === 'bad-status') connectFailed = true;
        inbox.note('error', i.code, i.message);
      },
    });
    ctrl.abort();
    source.note = r.aborted && r.received >= want ? `收到 ${want} 条后主动断开` : '';
    if (connectFailed) {
      process.stderr.write(`[doctor] 打不开事件源 ${args.http}（连不上或状态码异常）\n`);
      process.exit(2);
    }
    if (r.received === 0) {
      inbox.note('error', 'http-no-events', `${args.http} 连上了但没收到任何事件`);
    }
  }

  /* ---------------- 统计与判定 ---------------- */
  const inboxSnap = inbox.snapshot();
  const pairs = pairReport(collected);
  const dups = duplicateReport(collected);
  const timeline = describeTimeline(collected);
  const kindCounts = countKinds(collected);

  const problems = [];
  const warnings = [];

  /*
   * 0. **病因优先**：文件层解析失败。
   *
   * 顺序很重要。下面第 1 条"事件流是空的"是从 `collected.length === 0`
   * 派生出来的**症状**；而"整份 JSON 解析失败：……"才是**病因**。
   * 症状排在病因前面，读的人就会去查"通道是不是没接上"，
   * 而实际上只是那份文件没写完 / 写坏了。
   * 先报病因，并且当它存在时**不再重复报"事件流是空的"**。
   */
  const fatalFileIssue = fileIssues.find((i) => i && i.code === 'parse-failed');
  if (fatalFileIssue) {
    problems.push(fatalFileIssue.message);
  }

  /* 1. 有事件吗 */
  if (collected.length === 0 && !fatalFileIssue) {
    problems.push('没有解析出任何合法事件（事件流是空的）');
  }

  /* 1b. 文件层其余 issue（bad-line 已在上面逐条走 inbox.bad()，不重复报） */
  for (const i of fileIssues) {
    if (!i || i.code === 'parse-failed' || i.code === 'bad-line') continue;
    problems.push(`文件层问题 ${i.code}：${i.message}`);
  }

  /* 2. 未知 kind */
  if (inboxSnap.unknown > 0) {
    problems.push(
      `未知 kind ${inboxSnap.unknown} 条（${inboxSnap.unknownKindsText}）—— `
        + '协议不认识它们，它们不会驱动玩法',
    );
  }

  /* 3. 坏记录 */
  if (inboxSnap.badRecords > 0) {
    problems.push(`坏记录 ${inboxSnap.badRecords} 条（不是合法 JSON）`);
  }
  if (inboxSnap.rejected > inboxSnap.badRecords) {
    problems.push(`校验不通过 ${inboxSnap.rejected - inboxSnap.badRecords} 条（缺字段/类型错）`);
  }

  /* 4. 配对 */
  /*
   * 注意判定条件是 calls OR results。
   *
   * 只看 calls 会漏掉一整类坏数据源：**只报结束、一条开始都没有**。
   * 那种输入 callsTotal=0，条件不成立 → 跳过检查 → 结论"通过"，
   * 而它其实是配对彻底失败（0/N）。最烂的输入被显示成绿灯，
   * 这正是自检工具最不能犯的错。
   */
  if ((pairs.callsTotal > 0 || pairs.resultsTotal > 0) && !pairs.perfect) {
    const bits = [];
    if (pairs.orphanCalls || pairs.anonymousOrphanCalls) {
      bits.push(`孤儿开始 ${pairs.orphanCalls + pairs.anonymousOrphanCalls}`);
    }
    if (pairs.orphanResults) bits.push(`孤儿结束 ${pairs.orphanResults}`);
    if (pairs.duplicateResults) bits.push(`重复结束 ${pairs.duplicateResults}`);
    if (pairs.duplicateCallIds) bits.push(`重复开始 ${pairs.duplicateCallIds}`);
    if (pairs.callsTotal !== pairs.resultsTotal) {
      bits.push(`开始 ${pairs.callsTotal} != 结束 ${pairs.resultsTotal}`);
    }
    problems.push(`id 配对不完整：${bits.join('，')}（配对率 ${pct(pairs.pairingRate)}）`);
  }

  /* 5. 重复上报 */
  if (dups.count > 0) {
    problems.push(`重复上报 ${dups.count} 个 id（多出 ${dups.totalExtra} 条），例如 ${dups.ids.join(', ')}`);
  }

  /* 6. 耗时异常 */
  if (timeline.durationCount > 0 && timeline.durationMaxMs != null && timeline.durationMaxMs < 0) {
    problems.push('存在负耗时');
  }

  /* 7. 时间戳：全部相同 = 时间轴没有信息量 */
  if (collected.length > 1 && timeline.spanMs === 0) {
    warnings.push('所有事件 ts 完全相同（时间跨度为 0）—— 回放会全部挤在一瞬间');
  }

  /* 8. 缺 id（warn） */
  const noId = collected.filter(
    (e) => (e.kind === KIND.TOOL || e.kind === KIND.TOOL_END) && e.id == null,
  ).length;
  if (noId > 0) {
    warnings.push(`${noId} 条 tool/tool_end 没有 id，只能退回同工具 FIFO 配对`);
  }

  /* 9. 映射层：映射率与失败原因 */
  const mapSnap = mapStats ? mapStats.snapshot() : null;
  if (mapSnap) {
    const projected = prepareInfo && Array.isArray(prepareInfo.events) ? prepareInfo.events.length : 0;
    if (mapSnap.mapped === 0 && projected === 0) {
      problems.push(
        `映射配置 ${mapper.profile} 一条都没匹配上（喂入 ${mapSnap.total} 条）—— `
          + '请检查 profile 的 start/end 规则是否对得上你的日志',
      );
    }
    const failReasons = Object.keys(mapSnap.byCode);
    if (failReasons.length) {
      const text = failReasons.map((c) => `${c}x${mapSnap.byCode[c]}`).join(', ');
      /*
       * 跳过记录不等于错误：日志里天然有大量非工具记录。
       * 但"跳过了多少、为什么"必须打出来 —— 这是不伪造的证明。
       */
      warnings.push(`映射跳过 ${mapSnap.unmapped}/${mapSnap.total} 条（${text}）`);
    }
  }

  /* 10. 文件形态提示 */
  if (source.type === 'file' && source.shape === FILE_SHAPE.JSONL && collected.length > 0) {
    /* JSONL 正常，不提示 */
  }

  const exitCode = problems.length > 0 || (args.strict && warnings.length > 0) ? 1 : 0;

  /* ---------------- 输出 ---------------- */
  const report = {
    ok: exitCode === 0,
    source,
    profile: mapper ? mapper.profile : null,
    totals: {
      events: collected.length,
      records: inboxSnap.total,
      accepted: inboxSnap.accepted,
      rejected: inboxSnap.rejected,
      badRecords: inboxSnap.badRecords,
      unknown: inboxSnap.unknown,
      unknownKinds: inboxSnap.unknownKinds,
      byKind: kindCounts,
    },
    pairing: {
      calls: pairs.callsTotal,
      results: pairs.resultsTotal,
      paired: pairs.paired,
      pairingRate: pairs.pairingRate,
      orphanCalls: pairs.orphanCalls + pairs.anonymousOrphanCalls,
      orphanResults: pairs.orphanResults,
      duplicateResults: pairs.duplicateResults,
      duplicateCalls: pairs.duplicateCallIds,
      anonymousCalls: pairs.anonymousCalls,
      perfect: pairs.perfect,
    },
    duplicates: dups,
    timeline,
    mapping: mapSnap,
    prepare: prepareInfo,
    problems,
    warnings,
    /*
     * `issues` 是 **inbox** 的 issue（字符串），保持不变 —— 有别的消费者按它断言。
     * 文件层 issue 单独一段，避免"同名不同源"再次让人误读。
     */
    issues: inboxSnap.issues.slice(0, 20).map((i) => `${i.severity} ${i.code}: ${i.message}`),
    fileIssues: fileIssues.slice(0, 20).map((i) => `${i.code}: ${i.message}`),
  };

  if (args.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    process.exit(exitCode);
  }

  printReport(report, inboxSnap);
  process.exit(exitCode);
}

function countKinds(events) {
  const m = Object.create(null);
  for (const e of events) {
    const k = typeof e.kind === 'string' ? e.kind : '(无 kind)';
    m[k] = (m[k] || 0) + 1;
  }
  return m;
}

function pct(x) {
  return `${(x * 100).toFixed(1)}%`;
}

function ms(v) {
  if (v == null) return '-';
  if (v < 1000) return `${Math.round(v)}ms`;
  return `${(v / 1000).toFixed(2)}s`;
}

function printReport(r, inboxSnap) {
  const q = args.quiet;
  const p = (s) => {
    if (!q) process.stdout.write(s + '\n');
  };

  process.stdout.write('=== 事件源自检 ===\n');
  process.stdout.write(`  输入        ${r.source.type} ${r.source.target}\n`);
  if (r.source.shape) process.stdout.write(`  文件形态    ${r.source.shape}\n`);
  if (r.profile) process.stdout.write(`  映射配置    ${r.profile}\n`);
  if (r.source.note) process.stdout.write(`  备注        ${r.source.note}\n`);

  process.stdout.write(`  事件总数    ${r.totals.events}\n`);
  const kinds = Object.entries(r.totals.byKind)
    .map(([k, v]) => `${k} ${v}`)
    .join(' / ');
  process.stdout.write(`  分类型      ${kinds || '(无)'}\n`);
  process.stdout.write(
    `  未知 kind   ${r.totals.unknown}${r.totals.unknown > 0 ? `（${inboxSnap.unknownKindsText}）` : ''}\n`,
  );
  process.stdout.write(
    `  坏记录      ${r.totals.badRecords}${r.totals.rejected > r.totals.badRecords
      ? ` + 校验不通过 ${r.totals.rejected - r.totals.badRecords}` : ''}\n`,
  );

  const pa = r.pairing;
  process.stdout.write(
    `  id 配对     ${pa.paired}/${pa.calls}（${pct(pa.pairingRate)}）`
      + `${pa.perfect ? ' 完美' : ' 不完美'}\n`,
  );
  if (pa.orphanCalls || pa.orphanResults || pa.duplicateResults || pa.duplicateCalls) {
    process.stdout.write(
      `             孤儿开始 ${pa.orphanCalls} / 孤儿结束 ${pa.orphanResults}`
        + ` / 重复结束 ${pa.duplicateResults} / 重复开始 ${pa.duplicateCalls}\n`,
    );
  }
  if (pa.anonymousCalls) {
    process.stdout.write(`             其中无 id（FIFO 配对）${pa.anonymousCalls} 条\n`);
  }
  process.stdout.write(`  重复上报    ${r.duplicates.count} 个 id（多出 ${r.duplicates.totalExtra} 条）\n`);

  const t = r.timeline;
  process.stdout.write(`  时间跨度    ${ms(t.spanMs)}\n`);
  process.stdout.write(
    `  耗时分布    min ${ms(t.durationMinMs)} / median ${ms(t.durationMedianMs)}`
      + ` / p90 ${ms(t.durationP90Ms)} / max ${ms(t.durationMaxMs)}`
      + `（${t.durationCount} 条，${t.distinctDurations} 种不同值，合计 ${ms(t.durationSumMs)}）\n`,
  );

  if (r.prepare && r.prepare.mode) {
    const st = r.prepare.stats || {};
    process.stdout.write(
      `  预处理      ${r.prepare.mode}`
        + (st.projected != null ? ` 投影 ${st.projected} 条工具` : '')
        + (st.outputRecords != null ? ` 展平 ${st.outputRecords} 条` : '')
        + (st.skippedNoStatus ? ` 无显式成败跳过 ${st.skippedNoStatus}` : '')
        + '\n',
    );
  }

  if (r.mapping) {
    process.stdout.write(
      `  映射结果    成功 ${r.mapping.mapped}/${r.mapping.total}`
        + `（${pct(r.mapping.mapRate)}）`
        + `${Object.keys(r.mapping.byCode).length
          ? `，跳过原因 ${Object.entries(r.mapping.byCode).map(([k, v]) => `${k}x${v}`).join(', ')}`
          : ''}\n`,
    );
    if (r.mapping.okVia && Object.keys(r.mapping.okVia).length) {
      const via = Object.entries(r.mapping.okVia).map(([k, v]) => `${k}x${v}`).join(', ');
      process.stdout.write(`  ok 缺省规则  ${via}（profile 写明的 absent，不是运行时猜测）\n`);
    }
    if (r.mapping.examples.length) {
      for (const ex of r.mapping.examples.slice(0, 3)) {
        p(`              · ${ex.code}: ${ex.reason}`);
      }
    }
  }

  if (r.warnings.length) {
    for (const w of r.warnings) p(`  [warn] ${w}`);
  }
  /*
   * 文件层 issue 排在最前（紧跟 [warn]）：这是**病因**，
   * 不该被徽标式的下游症状埋在结论下方。
   */
  if (r.fileIssues && r.fileIssues.length) {
    for (const i of r.fileIssues.slice(0, 8)) p(`  [file] ${i}`);
  }
  if (r.issues.length) {
    for (const i of r.issues.slice(0, 8)) p(`  [issue] ${i}`);
  }

  if (r.problems.length) {
    process.stdout.write('  结论        不通过\n');
    for (const pr of r.problems) process.stdout.write(`    x ${pr}\n`);
  } else if (args.strict && r.warnings.length) {
    process.stdout.write('  结论        不通过（--strict：warn 视为失败）\n');
  } else {
    process.stdout.write('  结论        通过\n');
  }
}

/* 本文件是纯 CLI 脚本：import 它就会直接执行，测试请用子进程驱动。 */
