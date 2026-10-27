/**
 * adapters/generic.mjs —— 面向"任意智能体"的通用映射层
 *
 * ===== 这一层要解决的问题 =====
 *
 * 每个智能体的日志形状都不一样：
 *
 *   Claude Code  {"type":"tool_use","id":"toolu_01..","name":"Read"}
 *   Codex        {"type":"item.completed","item":{"type":"command_execution",...}}
 *   Cursor       {"tool":"run_terminal_cmd","callId":"abc","event":"start"}
 *
 * 统一协议（`protocol/events.mjs`）只认 `kind/tool/id/ts/realMs/ok`。
 * 中间这层就是"翻译"：**读一份 JSON 映射配置**，按配置取字段、判 kind，
 * 输出协议事件。
 *
 * ===== 为什么配置驱动而不是写死三个 if =====
 *
 * 写死意味着"每接一个新智能体就要改代码 + 发版"。
 * 配置驱动意味着"新建一个 profiles/xxx.json 就能接"——
 * 而这正是"所有智能体都能接"这句话能不能兑现的分界线。
 *
 * ===== 诚实红线（这一层最容易作恶的地方）=====
 *
 * 这一层手里握着"从别人日志里认字段"的权力，所以：
 *
 * 1. **找不到工具调用就停下并如实报告**。
 *    不匹配 → `skipped`，带 `reason` 和 `code`，进统计。
 *    绝不"看起来像工具调用就造一条"。
 * 2. **绝不为缺字段猜值**。
 *    匹配上了 start/end 但取不到工具名 → `unmapped`，报 `missing-tool`。
 *    不用 "unknown"、"tool"、下标数字之类的东西顶替 ——
 *    那会让画面里出现 292 只叫 unknown 的蚂蚁，而用户以为是真数据。
 * 3. **绝不为缺时间猜时间**。
 *    配置里没指时间字段且记录里也没有 → 交给调用方传 `now`（实时流才允许），
 *    否则报 `missing-ts`。不许拿 `Date.now()` 冒充历史事件的发生时刻。
 * 4. 每个"没映射成功"的原因都**分类计数**，doctor 会把它们打出来。
 *    "丢了 37 条"和"丢了 37 条，原因分别是 A/B/C"是两件性质完全不同的事。
 *
 * ===== 配置格式（一句话版）=====
 *
 *   {
 *     "profile": "claude-code",
 *     "source": "Claude Code transcript",
 *     "start": { "type": ["tool_use"] },
 *     "end":   { "type": ["tool_result"] },
 *     "turnEnd": { "type": ["turn_end"] },
 *     "id":    ["id", "tool_use_id", "callId"],
 *     "tool":  ["name", "tool_name", "tool"],
 *     "ts":    ["timestamp", "ts", "time"],
 *     "realMs":["duration_ms", "durationMs"],
 *     "ok":    { "path": ["is_error"], "trueMeansFail": true }
 *   }
 *
 * 完整字段说明见 docs/ADAPTERS.md。
 */

import { normalize, KIND } from '../protocol/events.mjs';

/* ------------------------------------------------------------------ *
 * 路径取值
 * ------------------------------------------------------------------ */

/**
 * 按配置里的一条路径候选取第一个存在的值。
 *
 * 支持：
 *   - `"a"`           顶层键
 *   - `"a.b"`         嵌套键
 *   - `"a[0].b"`      数组下标
 *   - 候选数组按顺序回退（`["name","tool_name"]`）
 *
 * 支持**数字下标**是有真实需求的：`item.completed` 形状里
 * 工具名藏在 `item.tool.name`，而有的事件是 `items[0].name`。
 *
 * @returns {{ found: boolean, value?: unknown, via?: string }}
 */
export function pickPath(record, paths) {
  const candidates = Array.isArray(paths) ? paths : [paths];
  for (const p of candidates) {
    if (typeof p !== 'string') continue;
    const got = getPath(record, p);
    if (got.found) return { found: true, value: got.value, via: p };
  }
  return { found: false };
}

/** 单条路径取值（不做候选回退）。 */
export function getPath(obj, path) {
  if (!path) return { found: false };
  const parts = String(path).match(/[^.[\]]+/g) || [];
  let cur = obj;
  for (const part of parts) {
    if (cur == null) return { found: false };
    if (Array.isArray(cur)) {
      const i = Number(part);
      if (!Number.isInteger(i) || i < 0 || i >= cur.length) return { found: false };
      cur = cur[i];
      continue;
    }
    if (typeof cur !== 'object') return { found: false };
    if (!Object.prototype.hasOwnProperty.call(cur, part)) return { found: false };
    cur = cur[part];
  }
  return { found: true, value: cur };
}

/* ------------------------------------------------------------------ *
 * 匹配判定
 * ------------------------------------------------------------------ */

/**
 * 判定一条记录是否命中某个规则。
 *
 * 规则形状（两种都支持）：
 *   `{ "type": ["tool_use"] }`            → 字段 type ∈ 列表
 *   `{ "path": ["k"], "in": [...] }`      → 显式写法，等价
 *   值为 `true` 表示"该字段存在且为真"；`false` 表示"存在且为假"。
 *
 * 多个键是 **AND**。
 */
export function matchRule(record, rule) {
  if (!rule || typeof rule !== 'object') return false;
  if (Array.isArray(rule.anyOf)) return rule.anyOf.some((sub) => matchRule(record, sub));
  const entries = rule.path ? [[rule.path, rule]] : Object.entries(rule);
  for (const [keys, spec] of entries) {
    const paths = Array.isArray(keys) ? keys : [keys];
    const got = pickPath(record, paths);
    const expected = spec && spec.in !== undefined ? spec.in : spec && spec.equals !== undefined ? [spec.equals] : spec;
    const list = Array.isArray(expected) ? expected : [expected];

    if (!got.found) {
      /* 期望 false 但字段不存在 → 不算命中（不知道 ≠ 假） */
      return false;
    }
    const v = got.value;
    const hit = list.some((e) => {
      if (e === true) return v === true || v === 'true';
      if (e === false) return v === false || v === 'false';
      return v === e;
    });
    if (!hit) return false;
  }
  return true;
}

/* ------------------------------------------------------------------ *
 * 映射器
 * ------------------------------------------------------------------ */

/** 未映射原因的稳定代码（doctor 与测试都按这些码断言，别随便改）。 */
export const SKIP_CODE = Object.freeze({
  NO_RULE: 'no-rule-matched',
  NOT_OBJECT: 'not-object',
  MISSING_TOOL: 'missing-tool',
  MISSING_TS: 'missing-ts',
  BAD_TYPE: 'bad-field-type',
  IGNORED_TYPE: 'ignored-record-type',
});

/**
 * 编译一份映射配置。
 *
 * 编译期就把明显的配置错误挑出来（比如 start/end 都没写），
 * 不要等到跑了 3000 条才发现"一条都没映射上"。
 *
 * @param {object} config 见文件头注释
 * @returns {{ profile: string, source: string, mapRecord: Function, config: object }}
 */
export function compileProfile(config) {
  if (!config || typeof config !== 'object') {
    throw new Error('映射配置必须是对象');
  }
  const profile = String(config.profile || '(未命名)');
  if (!config.start || !config.end) {
    throw new Error(
      `profile "${profile}" 缺少 start 或 end 规则 —— 无法区分调用开始与结束，拒绝运行（不猜）`,
    );
  }

  const idPaths = config.id ?? ['id', 'callId', 'tool_use_id', 'toolUseId'];
  const toolPaths = config.tool ?? ['tool', 'name', 'tool_name', 'toolName'];
  const tsPaths = config.ts ?? ['ts', 'timestamp', 'time', 'at'];
  const realMsPaths = config.realMs ?? ['realMs', 'duration_ms', 'durationMs', 'ms'];

  /**
   * 解析 ok 字段。
   *
   * 形状：`{ "path": [...], "trueMeansFail": true }`
   * 支持两种语义：
   *   - `trueMeansFail: true`  → 字段为 true 表示失败（Claude Code 的 is_error）
   *   - 默认（false）          → 字段为 true 表示成功（Codex 的 success）
   * 取不到就**不写 ok**（缺失合法），交给下游按"未知成功与否"处理。
   */
  function resolveOk(record) {
    if (!config.ok) return { found: false };
    const paths = config.ok.path ?? Object.keys(config.ok).filter((k) => k !== 'trueMeansFail' && k !== 'zeroMeansOk' && k !== 'statusMap' && k !== 'absent');
    for (const p of [].concat(paths)) {
      const got = pickPath(record, [p]);
      if (!got.found) continue;
      const raw = got.value;
      if (typeof raw === 'number' && Number.isFinite(raw) && config.ok.zeroMeansOk) {
        return { found: true, value: raw === 0, via: got.via };
      }
      if (typeof raw === 'boolean') {
        return { found: true, value: config.ok.trueMeansFail ? !raw : raw, via: got.via };
      }
      if (raw === 'true' || raw === 'false') {
        const b = raw === 'true';
        return { found: true, value: config.ok.trueMeansFail ? !b : b, via: got.via };
      }
      if (typeof raw === 'string' && config.ok.statusMap
        && Object.prototype.hasOwnProperty.call(config.ok.statusMap, raw)) {
        return { found: true, value: config.ok.statusMap[raw] === true, via: got.via };
      }
      /* 字段在，但形状对不上声明的规则：不落到下一个候选，也不猜 */
      return { found: false, bad: true, via: got.via };
    }
    /*
     * absent 是 profile 里写明的缺省规则，不是运行时猜测。
     * 没写 absent 时，缺字段仍然是缺字段。
     */
    if (config.ok.absent === 'success') return { found: true, value: true, via: 'absent-success' };
    if (config.ok.absent === 'fail') return { found: true, value: false, via: 'absent-fail' };
    return { found: false };
  }

  /**
   * 映射一条记录。
   *
   * @returns {{
   *   mapped: boolean,
   *   code?: string, reason?: string,
   *   event?: object,
   *   skipped?: boolean,
   * }}
   */
  function mapRecord(record, opts = {}) {
    if (record == null || typeof record !== 'object' || Array.isArray(record)) {
      return {
        mapped: false,
        code: SKIP_CODE.NOT_OBJECT,
        reason: `不是普通对象（实际 ${Array.isArray(record) ? '数组' : typeof record}）`,
      };
    }

    /* 有些日志会带一条"元信息/信封"记录（meta、session、header），先排除 */
    if (config.envelope && matchRule(record, config.envelope)) {
      return {
        mapped: false,
        skipped: true,
        code: SKIP_CODE.IGNORED_TYPE,
        reason: '命中了配置里的 envelope 规则（信封/元信息，不是事件）',
      };
    }

    let kind = null;
    if (matchRule(record, config.start)) kind = KIND.TOOL;
    else if (matchRule(record, config.end)) kind = KIND.TOOL_END;
    else if (config.turnEnd && matchRule(record, config.turnEnd)) kind = KIND.TURN_END;

    if (!kind) {
      /*
       * 关键点：**不匹配就是停下**。
       * 不尝试"猜它是不是工具调用"，那会污染战果统计。
       */
      return {
        mapped: false,
        code: SKIP_CODE.NO_RULE,
        reason: '没有任何 start/end/turnEnd 规则命中这条记录',
      };
    }

    const ev = { kind };

    /*
     * ---- tool ----
     *
     * 只有**开始**事件必须带工具名（没有名字就不知道上场的是谁）。
     * 结束事件可以缺：真实的 tool_result 常常只有 tool_use_id 没有名字，
     * 而配对按 id 走，不靠名字。这里缺了就如实不写，绝不填 "unknown" 顶上。
     */
    if (kind === KIND.TOOL) {
      const t = pickPath(record, toolPaths);
      if (!t.found || typeof t.value !== 'string' || t.value.trim() === '') {
        return {
          mapped: false,
          code: SKIP_CODE.MISSING_TOOL,
          reason: t.found
            ? `工具名字段存在但不是非空字符串（实际 ${JSON.stringify(t.value)}，取自 ${t.via}）`
            : `取不到工具名字段（试过 ${[].concat(toolPaths).join(', ')}）`,
        };
      }
      ev.tool = t.value.trim();
    } else {
      const t = pickPath(record, toolPaths);
      if (t.found && typeof t.value === 'string' && t.value.trim() !== '') {
        ev.tool = t.value.trim();
      }
    }

    /* ---- id：配对主键。没有就老实没有，不编 ---- */
    const id = pickPath(record, idPaths);
    if (id.found && (typeof id.value === 'string' || typeof id.value === 'number')) {
      ev.id = String(id.value);
    }

    /* ---- ts ---- */
    const ts = pickPath(record, tsPaths);
    if (ts.found) {
      const n = toMs(ts.value);
      if (n == null) {
        return {
          mapped: false,
          code: SKIP_CODE.BAD_TYPE,
          reason: `时间字段存在但无法解析成毫秒（实际 ${JSON.stringify(ts.value)}，取自 ${ts.via}）`,
        };
      }
      ev.ts = n;
    } else if (typeof opts.now === 'function') {
      /* 实时流允许用接收时刻，但打上标记（normalize 也会补 warn） */
      ev.ts = opts.now();
      ev.tsSource = 'ingest';
    } else {
      return {
        mapped: false,
        code: SKIP_CODE.MISSING_TS,
        reason: `取不到时间字段（试过 ${[].concat(tsPaths).join(', ')}），且没有实时时钟可用`,
      };
    }

    /* ---- realMs：缺失合法 ---- */
    const dur = pickPath(record, realMsPaths);
    if (dur.found) {
      const n = toMs(dur.value);
      if (n != null && n >= 0) ev.realMs = n;
      /* 是负数/解析不了：不写这个字段，不编 */
    }

    /* ---- ok ---- */
    let okVia = null;
    if (kind === KIND.TOOL_END || kind === KIND.TURN_END || kind === KIND.TOOL) {
      const o = resolveOk(record);
      const absentRule = o.via === 'absent-success' || o.via === 'absent-fail';
      /*
       * 开始事件缺 ok 是常态。absent 规则只补 tool_end，
       * 否则一条 tool 会被当成"已完成的一次性事件"立刻结算。
       */
      if (o.found && !(kind === KIND.TOOL && absentRule)) {
        ev.ok = o.value;
        okVia = o.via;
      } else if (kind === KIND.TURN_END) {
        ev.ok = true;
      }
    }

    /*
     * 透传 config.extra 里点名的字段（比如原始 type、session id）。
     * 只透传**配置显式点名**的，不整个 record 摊进来 ——
     * 否则一条请求头记录就可能把 token 带进事件流。
     */
    if (config.extra && typeof config.extra === 'object') {
      for (const [as, path] of Object.entries(config.extra)) {
        const got = pickPath(record, path);
        if (got.found) ev[as] = got.value;
      }
    }

    /* 只保留配置显式点名的额外字段，不把整条 record 摊进事件 */
    return { mapped: true, event: ev, profile, okVia };
  }

  if (config.preprocess === 'codex-session') {
    return {
      profile,
      source: String(config.source || ''),
      config,
      mapRecord() {
        return {
          mapped: false,
          code: 'preprocess-required',
          reason: 'codex-session 必须先经 adapters/codex-session.mjs 投影，不能把原始行直接映射',
        };
      },
    };
  }

  return { profile, source: String(config.source || ''), mapRecord, config };
}

/**
 * 把各种时间表示收敛成毫秒数。认不出来就返回 null（不猜）。
 * - 数字：< 1e12 视为已经是毫秒；据此以外的数字原样返回
 * - ISO 字符串 / 可被 Date.parse 的字符串
 * - `{ seconds, nanoseconds }`（部分日志的 proto 形状）
 */
export function toMs(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    /*
     * 先试纯数字字符串，**再**试日期解析。
     * 顺序反了会踩一个大坑：Date.parse('500') 不是 NaN，
     * 它会把 "500" 当成 2000 年的第 500 天，返回一个 1970 前的负数。
     * 于是"耗时 500ms"变成"1970 年某时刻"，而且悄无声息。
     */
    const n = Number(v);
    if (v.trim() !== '' && Number.isFinite(n)) return n;
    const t = Date.parse(v);
    if (!Number.isNaN(t)) return t;
    return null;
  }
  if (v && typeof v === 'object') {
    const secs = typeof v.seconds === 'number' ? v.seconds
      : typeof v.secs === 'number' ? v.secs : null;
    if (secs != null) {
      const nanos = typeof v.nanoseconds === 'number' ? v.nanoseconds
        : typeof v.nanos === 'number' ? v.nanos : 0;
      return secs * 1000 + Math.floor(nanos / 1e6);
    }
    if (typeof v.ms === 'number') return v.ms;
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * 内置 profile（从 JSON 文件加载；这里只做注册表）
 * ------------------------------------------------------------------ */

/** 内置 profile 名字 -> 相对路径。新增 profile 不必改代码，doctor 也认 --profile <path>。 */
export const BUILTIN_PROFILES = Object.freeze({
  'claude-code': 'claude-code.json',
  codex: 'codex.json',
  'codex-session': 'codex-session.json',
  cursor: 'cursor.json',
});

/**
 * 按名字或路径加载 profile 配置（JSON）。
 *
 * @param {string} nameOrPath 内置名（claude-code / codex / cursor）或 .json 路径
 * @param {{ readFile: (p: string) => string, profileDir: string }} io
 *        显式传 IO，别在这里偷偷 `node:fs` —— 保持本模块可被测试直接驱动。
 */
export function loadProfile(nameOrPath, io) {
  const fs = requireFs(io);
  const file = BUILTIN_PROFILES[nameOrPath]
    ? joinPath(io.profileDir, BUILTIN_PROFILES[nameOrPath])
    : nameOrPath;

  let text;
  try {
    text = fs.readFile(file);
  } catch (err) {
    throw new Error(`读不到映射配置 ${file}：${err.message}`);
  }
  let cfg;
  try {
    cfg = JSON.parse(text);
  } catch (err) {
    throw new Error(`映射配置 ${file} 不是合法 JSON：${err.message}`);
  }
  return compileProfile(cfg);
}

function requireFs(io) {
  if (!io || typeof io.readFile !== 'function') {
    throw new Error('loadProfile 需要 io.readFile（保持本模块无 node: 依赖）');
  }
  return io;
}

function joinPath(dir, name) {
  if (!dir) return name;
  const sep = dir.endsWith('/') || dir.endsWith('\\') ? '' : '/';
  return `${dir}${sep}${name}`;
}

/**
 * 映射统计 —— 每个失败原因单独计数，这是"诚实报告"的载体。
 *
 * 用法：
 *   const stats = createMapStats();
 *   const r = mapper.mapRecord(rec);
 *   stats.count(rec, r);
 *   stats.snapshot()  // { mapped, skipped, byCode: {...}, examples: [...] }
 */
export function createMapStats(opts = {}) {
  const maxExamples = opts.maxExamples ?? 10;
  const s = {
    total: 0,
    mapped: 0,
    unmapped: 0,
    okVia: Object.create(null),
    byCode: Object.create(null),
    examples: [],
  };
  return {
    count(record, result) {
      s.total++;
      if (result && result.mapped) {
        s.mapped++;
        if (result.okVia) s.okVia[result.okVia] = (s.okVia[result.okVia] || 0) + 1;
        return;
      }
      s.unmapped++;
      const code = (result && result.code) || 'unknown-reason';
      s.byCode[code] = (s.byCode[code] || 0) + 1;
      if (s.examples.length < maxExamples) {
        s.examples.push({
          code,
          reason: (result && result.reason) || '(无说明)',
          sampleKeys: record && typeof record === 'object' ? Object.keys(record).slice(0, 8) : [],
        });
      }
    },
    snapshot() {
      return {
        total: s.total,
        mapped: s.mapped,
        unmapped: s.unmapped,
        byCode: { ...s.byCode },
        okVia: { ...s.okVia },
        examples: s.examples.slice(),
        /* 映射率：分母是"喂进来的记录数"，不是"匹配上的记录数" —— 要如实 */
        mapRate: s.total === 0 ? 1 : s.mapped / s.total,
      };
    },
  };
}

/**
 * 一行式便捷函数：配置 + 原始记录 → 规范化结果（含协议校验）。
 * 给"只接一条流、不想管编译"的使用方。
 */
export function mapAndNormalize(mapper, record, opts = {}) {
  const r = mapper.mapRecord(record, opts);
  if (!r.mapped) return { ...r, normalize: null };
  return { ...r, normalize: normalize(r.event, opts) };
}
