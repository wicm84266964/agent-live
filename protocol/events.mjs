/**
 * 实况智能体 —— 统一事件协议（v1）
 *
 * ===== 这个文件存在的理由 =====
 *
 * 在这个文件之前，事件形状是**口口相传**的：
 *   - `build-events.mjs` 生成 `{kind,tool,id,ts,realMs}` / `{kind,ok,ts}`
 *   - `director.mjs` 的 `handle()` 只认 `tool` / `tool_end` / `turn_end`
 *   - `main.mjs` 的 `feed()` 是唯一入口，`__shield.emit()` 直接转给它
 *
 * 三者对得上，只是因为写它们的是同一个人、在同一天。
 * 任何别的智能体（Claude Code、Codex、Cursor、自研 agent）想把自己的
 * 工具调用接进来，都只能去读源码猜字段 —— 猜错不会报错，
 * 只会表现为"画面里没东西动"。这正是这个项目一直在防的那类 bug：
 * **静默失真**。
 *
 * 所以这里把协议写成**显式清单 + 可执行校验**，
 * 字段名一个都没有发明，全部对齐现有消费方（见 SCHEMA 里每条的 consumedBy）。
 *
 * ===== 为什么不用 `node:` 内建 =====
 *
 * 这个文件必须能被浏览器直接 import（`main.mjs` 是浏览器模块），
 * 也要能被 Node 直接 import。所以它是**纯数据 + 纯函数**，
 * 只依赖 ECMAScript 本身。任何 `node:` 引入都会让它变成 Node-only。
 *
 * ===== 诚实语义（本项目的红线） =====
 *
 * 1. 不认识的事件 **不崩、不猜、不丢**：`kind` 原样保留，
 *    由 `createInbox()` 计数上报。这是项目既有的 unknown 策略
 *    （`director.mjs` 里 `this.unknown` 计的是表里没有的工具，同一个道理）。
 * 2. 校验**不抛异常**：`validate()` 返回可读问题列表。
 *    一条坏事件不该把整条事件流打死。
 * 3. **不补造字段**：缺 `ts` 就是缺，不会拿 `Date.now()` 冒充真实时刻
 *    （唯一例外是实时适配器显式传了 `now`，那时会记 `tsSource:'ingest'`
 *    并留一条 warn，见 normalize 选项）。
 * 4. **id 配对是回归红线**：见 PAIRING_RULES。历史事故：
 *    292 次工具调用曾被配对口径误判成 283 次。原因不是数据处理错，
 *    而是配对口径写错了 —— 按工具名而不是按 callId 配对，
 *    同名工具的第 2 次到第 N 次全被当成重复上报丢掉。
 *    规则和证据都在 `tests/protocol.test.mjs`。
 */

/* ------------------------------------------------------------------ *
 * 1. 事件类型
 * ------------------------------------------------------------------ */

/**
 * 已知事件类型。
 *
 * 只有三个，是因为 `director.mjs` 的 `handle()` 只认三个 ——
 * 协议不发明消费方没实现的类型。
 */
export const KIND = Object.freeze({
  /** 工具调用开始：生成一个敌人。`tool` 必填。 */
  TOOL: 'tool',
  /** 工具调用结束：真正（且唯一）的击杀时刻。`tool` + `ok` 必填。 */
  TOOL_END: 'tool_end',
  /** 本轮结束：清场。`ok` 表达这一轮是否正常收尾。 */
  TURN_END: 'turn_end',
});

/** 已知 kind 的有序列表（顺序 = 文档展示顺序，无逻辑含义）。 */
export const KNOWN_KINDS = Object.freeze([KIND.TOOL, KIND.TOOL_END, KIND.TURN_END]);

/** kind 是否已知。未知 kind 不是错误，只是要计数上报。 */
export function isKnownKind(kind) {
  return KNOWN_KINDS.includes(kind);
}

/* ------------------------------------------------------------------ *
 * 2. 字段 schema（显式清单）
 * ------------------------------------------------------------------ */

/**
 * 字段定义表。每一条都是**现有真实字段**，不是新发明的。
 *
 * `consumedBy` 说明谁在读它 —— 这是防止"协议自己和消费方脱钩"的锚点：
 * 改这里之前先去看那几个文件到底怎么用的。
 *
 * `requiredFor` 里写 kind 名表示"该 kind 的事件必须带这个字段"。
 */
export const SCHEMA = Object.freeze({
  kind: {
    type: 'string',
    requiredFor: [KIND.TOOL, KIND.TOOL_END, KIND.TURN_END],
    semantics:
      '事件类型。决定消费方走哪个分支（director.handle 的三个 if）。未知值不丢弃，计 unknown。',
    consumedBy: ['director.mjs#handle'],
    example: 'tool_end',
  },
  tool: {
    type: 'string',
    /*
     * 只在 `tool`（开始）上必填。
     *
     * 为什么 `tool_end` 不强制：真实数据里 tool_result 记录往往**只有**
     * tool_use_id，没有工具名（Claude Code 就是这样）。而 director 的
     * `_finishTool` 在有 id 时**根本不读** ev.tool —— 它按 callId 精确匹配。
     * 强行要求 tool_end 带 tool 只会逼适配器去"猜"一个名字填上，
     * 那正是本项目最不能接受的事（伪造）。
     * 缺 tool 的 tool_end 会得到一条 warn，配对照常按 id 进行。
     */
    requiredFor: [KIND.TOOL],
    semantics:
      '工具名（原始名，不做映射/美化）。开始事件必填：bestiary 查档位、HUD 显示都靠它。'
      + '结束事件可缺：有 id 时按 id 配对，tool 只用于显示与"无 id 时"的 FIFO 兜底。',
    consumedBy: ['director.mjs#_spawnTool', 'director.mjs#_finishTool', 'bestiary.mjs'],
    example: 'read_file',
  },
  id: {
    type: 'string',
    requiredFor: [],
    semantics:
      '工具调用标识（build-events 里来自 session 的 callId）。**配对主键**。'
      + '数字会被规范成字符串（String(id)），因为 director 内部就按字符串比。'
      + '强烈建议必填：缺 id 时只能退回"同工具 FIFO"，多次同名调用无法区分。',
    consumedBy: ['director.mjs#_finishTool', 'build-events.mjs'],
    example: 'call_00_kL2Mw1LBgpTGsvCevSns0816',
  },
  ts: {
    type: 'number',
    requiredFor: [KIND.TOOL, KIND.TOOL_END, KIND.TURN_END],
    semantics:
      '事件时刻（毫秒）。语义取决于数据源：build-events 写的是**播放时间轴**的 t，'
      + '实时适配器写的是**墙钟**。协议只要求"同一数据源内同一把尺子"，'
      + '并要求单调性由适配器负责（build-events 用折叠映射保证）。',
    consumedBy: ['build-events.mjs', 'main.mjs'],
    example: 799,
  },
  realMs: {
    type: 'number',
    requiredFor: [],
    semantics:
      '这次调用的**真实耗时**（毫秒）。只用于统计/展示，不影响玩法。'
      + '负数非法；缺失合法（有些数据源不给耗时）。注意它和 ts 是两把尺子：'
      + 'ts 是时刻，realMs 是时长。',
    consumedBy: ['main.mjs', 'verify.mjs', 'doctor'],
    example: 799,
  },
  ok: {
    type: 'boolean',
    requiredFor: [KIND.TOOL_END],
    semantics:
      '这次调用是否成功。false = 失败（画面记 FAIL，计入 failures）。'
      + '在 kind:"tool" 上出现表示"这是一条**已完成**的一次性事件"，'
      + 'director 会生成后立刻结算（见 `_spawnTool` 里的 typeof ev.ok === "boolean"）。',
    consumedBy: ['director.mjs#_spawnTool', 'director.mjs#_settle', 'main.mjs#feed'],
    example: true,
  },
});

/** 协议认识的字段名（按 SCHEMA 顺序）。其余字段视为扩展，原样透传。 */
export const KNOWN_FIELDS = Object.freeze(Object.keys(SCHEMA));

/* ------------------------------------------------------------------ *
 * 3. id 配对规则（回归红线）
 * ------------------------------------------------------------------ */

/**
 * 配对规则 —— 改这个之前请先读 `tests/protocol.test.mjs` 里的红线用例。
 *
 * 1. 配对键 = String(ev.id)。**不是**工具名，**不是** kind+id 组合。
 * 2. 一条 tool 开一个"未结算调用"（open call）；
 *    一条 tool_end 关闭**同 id 的、尚未关闭的**那一个，且只关一个。
 * 3. 同 id 第二次 tool_end = **重复上报**（duplicateResults）。
 *    既不是新配对，也不是新击杀。数据源重连/重放/重复消费都会产生它。
 * 4. 找不到未结算调用的 tool_end = **孤儿结束**（orphanResults）。
 *    director 的处理是"补造一个敌人再结算"（不丢事件），
 *    但配对统计必须如实把它记成**未配对**，不能算进配对率。
 * 5. 一直没有 tool_end 的 tool = **孤儿开始**（orphanCalls）。
 * 6. 没有 id 的事件：按工具名 FIFO 配对 —— 先开始的先结束。
 *    这类事件计入 anonymousCalls，并且在配对率里单独列出，
 *    不要混进按 id 配对的分母里假装精确。
 *
 * 配对率（pairingRate）分母 = max(callsTotal, resultsTotal)（两者都含匿名），
 * 分子 = pairedById + pairedAnonymous。
 *
 * 为什么是 max 而不是只看 callsTotal —— 这不是细节，是"最烂的输入必须拿不到高分"：
 *   - 只看开始：一份"只报结束、一条开始都没有"的日志是 0/0 → 100%，
 *     最烂的输入显示成最完美的分数。
 *   - 取 max 之后：结束数多于开始数时，**多出来的那些结束会把分母抬高**，
 *     所以那种输入是 0/1 = 0%，如实。
 *   - 反之开始数多于结束数时 max 就是 callsTotal，分母与"只看开始"一致。
 * 换句话说：结束数溢出不会让配对率虚高，只会让它更低 —— 这是**故意**的。
 *
 * 口径以 `docs/PROTOCOL.md`（配对率 = paired / max(calls, results)）为准。
 * 注释与实现曾经在这里对不上（注释写 callsTotal，实现是 max）；
 * 错的是注释，不是实现。`tests/protocol.test.mjs` 里有一条
 * **只锁字符串、不锁语义**的轻量断言盯着这句"max(callsTotal, resultsTotal)"，
 * 真正的语义由行为断言锁（0 calls / 1 result → rate 0，2 calls / 1 result → 0.5）。
 *
 * 事故记录：曾把 292 次调用算成 283 —— 口径是按工具名去重/配对。
 * read 被调用过 87 次、pwsh 106 次，每次都是独立 callId，
 * 按工具名算当然只剩几个。所以规则 1 是红线。
 */
export const PAIRING_RULES = Object.freeze([
  'pair key = String(ev.id)，不看工具名、不看 kind+id',
  'tool 开一个 open call；tool_end 关闭同 id 且未关闭的那一个（一对一）',
  '同 id 的第二个 tool_end = duplicateResults（不算新配对、不算新击杀）',
  '没有 open call 可关的 tool_end = orphanResults（director 会补造，但统计记为未配对）',
  '没有 tool_end 的 tool = orphanCalls',
  '无 id 事件按工具名 FIFO 配对，单独计入 anonymousCalls',
]);

/* ------------------------------------------------------------------ *
 * 4. 校验
 * ------------------------------------------------------------------ */

/** 问题严重级。error 会让 doctor 判失败；warn 只提示（--strict 时才失败）。 */
export const SEVERITY = Object.freeze({ ERROR: 'error', WARN: 'warn' });

function issue(severity, code, message, extra) {
  return { severity, code, message, ...extra };
}

function isPlainObject(v) {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * 校验一条（已规范化的）事件。
 *
 * **不抛异常**：输入再烂也只会返回问题列表。
 * 返回值：`{ ok, errors, warnings, issues, unknownKind }`
 *   - ok：无 error 级问题即为 true
 *   - unknownKind：kind 不在 KNOWN_KINDS 里 → 由调用方计数上报
 */
export function validate(ev) {
  const issues = [];

  if (!isPlainObject(ev)) {
    issues.push(
      issue(SEVERITY.ERROR, 'not-object', `事件必须是普通对象，实际是 ${describe(ev)}`),
    );
    return finish(issues, false);
  }

  /* ---- kind ---- */
  if (ev.kind == null) {
    issues.push(issue(SEVERITY.ERROR, 'missing-kind', '缺少 kind 字段'));
  } else if (typeof ev.kind !== 'string') {
    issues.push(
      issue(SEVERITY.ERROR, 'bad-kind-type', `kind 必须是字符串，实际是 ${describe(ev.kind)}`),
    );
  } else if (!isKnownKind(ev.kind)) {
    /*
     * 未知 kind 只 warn，且明确写出"将被计为 unknown"。
     * 不猜它像哪个已知类型 —— 猜错就会凭空多出一次击杀或一次出场。
     */
    issues.push(
      issue(
        SEVERITY.WARN,
        'unknown-kind',
        `未知事件类型 "${ev.kind}"，将计入 unknown 计数、不参与玩法`,
        { unknownKind: ev.kind },
      ),
    );
  }
  const unknownKind = typeof ev.kind === 'string' && !isKnownKind(ev.kind) ? ev.kind : null;

  /* ---- 按 kind 检查必填字段 ---- */
  const kind = typeof ev.kind === 'string' ? ev.kind : null;
  for (const [field, def] of Object.entries(SCHEMA)) {
    if (field === 'kind') continue;
    if (!def.requiredFor.includes(kind)) continue;
    if (ev[field] == null) {
      issues.push(
        issue(SEVERITY.ERROR, `missing-${field}`, `kind="${kind}" 缺少必填字段 ${field}`),
      );
    }
  }

  /* ---- tool ---- */
  if (ev.tool != null) {
    if (typeof ev.tool !== 'string') {
      issues.push(
        issue(SEVERITY.ERROR, 'bad-tool-type', `tool 必须是字符串，实际是 ${describe(ev.tool)}`),
      );
    } else if (ev.tool.trim() === '') {
      issues.push(issue(SEVERITY.ERROR, 'empty-tool', 'tool 是空字符串（工具名不能为空）'));
    }
  }

  /* ---- id ---- */
  if (ev.id != null) {
    const t = typeof ev.id;
    if (t !== 'string' && t !== 'number') {
      issues.push(
        issue(SEVERITY.ERROR, 'bad-id-type', `id 必须是字符串或数字，实际是 ${describe(ev.id)}`),
      );
    } else if (t === 'string' && ev.id.trim() === '') {
      issues.push(issue(SEVERITY.ERROR, 'empty-id', 'id 是空字符串（空 id 无法配对）'));
    }
  } else if (kind === KIND.TOOL || kind === KIND.TOOL_END) {
    /*
     * 缺 id 不判死 —— director 有 FIFO 兜底，真实数据里 turn_end 本来也没有 id。
     * 但它是配对精度的直接损失，必须提示，并且在配对报告里单独统计。
     */
    issues.push(
      issue(
        SEVERITY.WARN,
        'missing-id',
        `kind="${kind}" 没有 id，只能退回同工具 FIFO 配对（同名多次调用会无法区分）`,
      ),
    );
  }

  /*
   * tool_end 缺 tool：不是错误，但要说出来。
   * 有 id 时配对照常精确（director 按 callId 匹配），只是没法显示工具名；
   * 没 id 时它就彻底没法配对了 —— 那种情况上面已经有 missing-id warn。
   */
  if (kind === KIND.TOOL_END && ev.tool == null) {
    issues.push(
      issue(
        SEVERITY.WARN,
        'missing-tool-on-end',
        'tool_end 没有 tool 字段（有 id 时可正常配对，只是无法显示工具名）',
      ),
    );
  }

  /* ---- ts ---- */
  if (ev.ts != null && !isFiniteNumber(ev.ts)) {
    issues.push(
      issue(SEVERITY.ERROR, 'bad-ts', `ts 必须是有限数字（毫秒），实际是 ${describe(ev.ts)}`),
    );
  }

  /* ---- realMs ---- */
  if (ev.realMs != null) {
    if (!isFiniteNumber(ev.realMs)) {
      issues.push(
        issue(
          SEVERITY.ERROR,
          'bad-realMs',
          `realMs 必须是有限数字（毫秒），实际是 ${describe(ev.realMs)}`,
        ),
      );
    } else if (ev.realMs < 0) {
      issues.push(
        issue(SEVERITY.ERROR, 'negative-realMs', `realMs 不能为负，实际是 ${ev.realMs}`),
      );
    }
  }

  /* ---- ok ---- */
  if (ev.ok != null && typeof ev.ok !== 'boolean') {
    issues.push(issue(SEVERITY.ERROR, 'bad-ok', `ok 必须是布尔值，实际是 ${describe(ev.ok)}`));
  }

  return finish(issues, Boolean(unknownKind));
}

function finish(issues, unknownKind) {
  const errors = issues.filter((i) => i.severity === SEVERITY.ERROR);
  const warnings = issues.filter((i) => i.severity === SEVERITY.WARN);
  return {
    ok: errors.length === 0,
    errors,
    warnings,
    issues,
    /* 布尔：是否未知 kind。具体名字由 normalize() 回填（validate 不保留事件）。 */
    unknownKind: Boolean(unknownKind),
  };
}

function describe(v) {
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  if (Array.isArray(v)) return `数组(长度 ${v.length})`;
  if (typeof v === 'string') return `字符串 ${JSON.stringify(v.slice(0, 40))}`;
  if (typeof v === 'object') return `对象(键 ${Object.keys(v).slice(0, 5).join(',')})`;
  return `${typeof v} ${String(v)}`;
}

/** 把问题列表渲染成一行一条的可读文本（doctor 和测试都用它）。 */
export function formatIssues(issues) {
  return (Array.isArray(issues) ? issues : []).map(
    (i) => `[${i.severity}] ${i.code}: ${i.message}`,
  );
}

/* ------------------------------------------------------------------ *
 * 5. 规范化
 * ------------------------------------------------------------------ */

/**
 * 把"任意形状的原始记录"收敛成协议事件。
 *
 * 只做**不改变事实**的收敛：
 *   - id：number → string（director 按字符串比，见 String(ev.id)）
 *   - tool：裁两端空白（不改大小写、不做别名映射 —— 那是 generic 适配器的事）
 *   - 未知字段：原样透传（前向兼容，不丢信息）
 *   - 缺 ts：**不补**，除非调用方显式传了 now（实时数据源）
 *
 * @param {unknown} raw
 * @param {{ now?: () => number, source?: string }} [opts]
 *        now：只给**实时**适配器用。给了才允许补 ts，并打 tsSource:'ingest'。
 * @returns {{ ok, event, errors, warnings, issues, unknownKind, rejected, tsSynthesized }}
 */
export function normalize(raw, opts = {}) {
  if (!isPlainObject(raw)) {
    const v = validate(raw);
    return {
      ...v,
      event: null,
      rejected: true,
      tsSynthesized: false,
      unknownKind: null,
    };
  }

  const event = { ...raw };

  /* id 规范化：数字 id 很常见（部分智能体用自增序号） */
  if (event.id != null && typeof event.id === 'number' && Number.isFinite(event.id)) {
    event.id = String(event.id);
  }

  if (typeof event.tool === 'string') event.tool = event.tool.trim();

  let tsSynthesized = false;
  if (event.ts == null && typeof opts.now === 'function' && event.kind !== undefined) {
    /*
     * 实时源没有 ts 时，用**接收时刻**当 ts。
     * 这不是伪造"事件发生时刻"，而是"我们什么时候看到它"，
     * 所以标 tsSource:'ingest'，并留一条 warn 让它可见。
     */
    event.ts = opts.now();
    event.tsSource = 'ingest';
    tsSynthesized = true;
  }
  if (opts.source && event.source == null) event.source = opts.source;

  const v = validate(event);
  const issues = tsSynthesized
    ? [
        ...v.issues,
        issue(
          SEVERITY.WARN,
          'ts-synthesized',
          '原始事件没有 ts，已用接收时刻填充（tsSource:"ingest"）；'
            + '这是"看到它的时刻"，不是"它发生的时刻"',
        ),
      ]
    : v.issues;

  const errors = issues.filter((i) => i.severity === SEVERITY.ERROR);
  const warnings = issues.filter((i) => i.severity === SEVERITY.WARN);
  const ok = errors.length === 0;

  return {
    ok,
    event: ok ? event : null,
    rejected: !ok,
    errors,
    warnings,
    issues,
    unknownKind: v.unknownKind ? (typeof event.kind === 'string' ? event.kind : true) : null,
    tsSynthesized,
  };
}

/* ------------------------------------------------------------------ *
 * 6. 事件收件箱 / 计数
 * ------------------------------------------------------------------ */

/**
 * 事件计数器 —— 所有适配器和 doctor 共用。
 *
 * 作用有两个：
 *   1. **未知 kind 计数上报**（不崩、不猜）
 *   2. 坏输入计数（坏 JSON、缺字段）—— 让"丢了什么"变成可见数字
 *
 * 无 IO、无时钟，浏览器里也能用。
 */
export function createInbox() {
  const stats = {
    total: 0, // 收到的原始记录数
    accepted: 0, // 通过校验的事件数
    rejected: 0, // 未通过校验的事件数
    unknown: 0, // 未知 kind 的事件数
    unknownKinds: Object.create(null), // kind -> 次数
    byKind: Object.create(null), // kind -> 次数
    badRecords: 0, // 解析失败/不是对象的记录
    issues: [], // 前 maxIssues 条问题（防止内存无限增长）
  };
  const maxIssues = 200;

  function record(issueList) {
    for (const i of issueList) {
      if (stats.issues.length < maxIssues) stats.issues.push(i);
    }
  }

  return {
    /** 喂一条已经解析成对象的原始记录。 */
    push(raw, opts) {
      stats.total++;
      const r = normalize(raw, opts);
      record(r.issues);
      if (r.unknownKind) {
        const key = typeof r.unknownKind === 'string' ? r.unknownKind : '(非字符串)';
        stats.unknown++;
        stats.unknownKinds[key] = (stats.unknownKinds[key] || 0) + 1;
      }
      const k = r.event && r.event.kind;
      if (typeof k === 'string') stats.byKind[k] = (stats.byKind[k] || 0) + 1;
      if (r.ok) stats.accepted++;
      else stats.rejected++;
      return r;
    },
    /** 喂一条"根本没能解析成 JSON"的记录（坏行）。 */
    bad(message, meta) {
      stats.total++;
      stats.badRecords++;
      stats.rejected++;
      record([issue(SEVERITY.ERROR, 'bad-json', message, meta)]);
    },
    /** 只记一条问题，不计事件数（用于文件/网络层问题）。 */
    note(severity, code, message, meta) {
      record([issue(severity, code, message, meta)]);
    },
    snapshot() {
      return {
        ...stats,
        unknownKinds: { ...stats.unknownKinds },
        byKind: { ...stats.byKind },
        unknownKindsText: formatUnknown(stats.unknownKinds),
        issues: stats.issues.slice(),
      };
    },
  };
}

function formatUnknown(map) {
  const keys = Object.keys(map);
  if (!keys.length) return '(无)';
  return keys
    .sort((a, b) => map[b] - map[a])
    .map((k) => `${k}x${map[k]}`)
    .join(', ');
}

/* ------------------------------------------------------------------ *
 * 7. 配对报告
 * ------------------------------------------------------------------ */

/**
 * 按 PAIRING_RULES 统计配对情况。
 *
 * 只读 events 数组，不假设它们按 ts 排序 —— 真数据里并发事件时间戳会交叉，
 * 排序不该影响配对结果（配对看的是 id，不是顺序）。
 *
 * @param {Array<object>} events
 * @param {{ maxList?: number }} [opts]
 */
export function pairReport(events, opts = {}) {
  const maxList = opts.maxList ?? 20;
  const list = Array.isArray(events) ? events : [];

  /** id -> { tool }：未结算调用 */
  const open = new Map();
  /** 工具名 -> 无 id 的 open call 队列（FIFO） */
  const openAnon = new Map();
  /** 已关闭过的 id（用于判重复上报） */
  const closedIds = new Set();
  /** 无 id 已关闭的工具计数（用于判匿名重复上报） */
  const closedAnon = new Map();

  let callsTotal = 0;
  let resultsTotal = 0;
  let callsWithId = 0;
  let anonymousCalls = 0;
  let anonymousResults = 0;
  let pairedById = 0;
  let pairedAnonymous = 0;
  let duplicateResults = 0;
  let orphanResults = 0;
  let duplicateCallIds = 0;

  const duplicateResultIds = [];
  const orphanResultIds = [];
  const duplicateCallIdList = [];

  for (const ev of list) {
    if (!isPlainObject(ev)) continue;
    const kind = ev.kind;
    const id = ev.id != null ? String(ev.id) : null;
    const tool = typeof ev.tool === 'string' ? ev.tool : null;

    if (kind === KIND.TOOL) {
      callsTotal++;
      if (id != null) {
        callsWithId++;
        if (open.has(id)) {
          /* 同 id 又开了一次：数据源重复投递了开始事件 */
          duplicateCallIds++;
          if (duplicateCallIdList.length < maxList) duplicateCallIdList.push(id);
          continue;
        }
        open.set(id, { tool });
      } else {
        anonymousCalls++;
        if (tool != null) {
          const q = openAnon.get(tool) || [];
          q.push({ tool });
          openAnon.set(tool, q);
        }
      }
      continue;
    }

    if (kind === KIND.TOOL_END) {
      resultsTotal++;
      if (id != null) {
        if (open.has(id)) {
          open.delete(id);
          closedIds.add(id);
          pairedById++;
        } else if (closedIds.has(id)) {
          /* 规则 3：同 id 已结算过 → 重复上报 */
          duplicateResults++;
          if (duplicateResultIds.length < maxList) duplicateResultIds.push(id);
        } else {
          /* 规则 4：没有 open call 可关 */
          orphanResults++;
          if (orphanResultIds.length < maxList) orphanResultIds.push(id);
        }
      } else {
        anonymousResults++;
        const q = tool != null ? openAnon.get(tool) : null;
        if (q && q.length) {
          q.shift();
          pairedAnonymous++;
          closedAnon.set(tool, (closedAnon.get(tool) || 0) + 1);
        } else if (tool != null && (closedAnon.get(tool) || 0) > 0) {
          duplicateResults++;
        } else {
          orphanResults++;
        }
      }
      continue;
    }

    /* 未知 kind / turn_end：不参与配对，也不影响配对率 */
  }

  const orphanCalls = open.size;
  const orphanCallIds = [...open.keys()].slice(0, maxList);
  const anonymousOrphanCalls = [...openAnon.values()].reduce((a, q) => a + q.length, 0);

  const paired = pairedById + pairedAnonymous;
  /*
   * 配对率的分母取 max(开始, 结束) 而不是只看开始。
   *
   * 只看开始的话，"只报了结束、没有一次开始"的数据源会得到 0/0 → 100%，
   * 也就是**最烂的输入显示成最完美的分数**。分母带上结果数之后，
   * 那种情况是 0/1 = 0%，如实。
   */
  const pairBase = Math.max(callsTotal, resultsTotal);
  const pairingRate = pairBase === 0 ? 1 : paired / pairBase;

  return {
    callsTotal,
    resultsTotal,
    callsWithId,
    anonymousCalls,
    anonymousResults,
    paired,
    pairedById,
    pairedAnonymous,
    pairingRate,
    orphanCalls,
    orphanCallIds,
    anonymousOrphanCalls,
    orphanResults,
    orphanResultIds,
    duplicateResults,
    duplicateResultIds,
    duplicateCallIds,
    duplicateCallIdList,
    /* 判定用：配对完美 = 每次开始都有结束、每次结束都关到一个开始 */
    perfect:
      callsTotal === resultsTotal
      && paired === callsTotal
      && orphanResults === 0
      && duplicateResults === 0
      && orphanCalls === 0
      && anonymousOrphanCalls === 0
      && duplicateCallIds === 0,
  };
}

/**
 * 重复上报检测：同一 (kind, id) 出现多次。
 * 独立于 pairing 的诚实检查（build-events 里那条 kind+id 去重就是这个口径）。
 */
export function duplicateReport(events, opts = {}) {
  const maxList = opts.maxList ?? 20;
  const seen = new Map(); // `kind:id` -> count
  for (const ev of Array.isArray(events) ? events : []) {
    if (!isPlainObject(ev) || ev.id == null) continue;
    const k = `${ev.kind}:${String(ev.id)}`;
    seen.set(k, (seen.get(k) || 0) + 1);
  }
  const dups = [...seen.entries()].filter(([, v]) => v > 1);
  return {
    count: dups.length,
    totalExtra: dups.reduce((a, [, v]) => a + (v - 1), 0),
    ids: dups.slice(0, maxList).map(([k]) => k),
  };
}

/**
 * 耗时分布 + 时间跨度。用于 doctor 的"这个数据源到底长什么样"。
 *
 * ===== 为什么耗时要去重 =====
 *
 * 真实数据里 tool 和 tool_end **都带同一个 realMs**（同一调用的时长）。
 * 直接遍历会把每次调用的耗时算两遍：130.08s 变成 260.16s，
 * 和 `build-events.mjs` 写进 meta 的 `realDurSumMs` 对不上。
 * 一个"自检"工具自己先把数算错，比没有自检更糟。
 *
 * 所以按 id 去重，且**优先取 tool_end**（结束事件才是耗时的权威来源：
 * start 事件在实时流里可能压根不知道耗时）。
 * 无 id 的事件没有去重依据，各自独立计入。
 */
export function describeTimeline(events) {
  const list = Array.isArray(events) ? events : [];
  let minTs = Infinity;
  let maxTs = -Infinity;
  /** id -> { value, preferred } */
  const byId = new Map();
  const anon = [];

  for (const ev of list) {
    if (!isPlainObject(ev)) continue;
    if (isFiniteNumber(ev.ts)) {
      if (ev.ts < minTs) minTs = ev.ts;
      if (ev.ts > maxTs) maxTs = ev.ts;
    }
    if (!isFiniteNumber(ev.realMs) || ev.realMs < 0) continue;

    if (ev.id == null) {
      anon.push(ev.realMs);
      continue;
    }
    const key = String(ev.id);
    const prev = byId.get(key);
    const preferred = ev.kind === KIND.TOOL_END;
    if (!prev) byId.set(key, { value: ev.realMs, preferred });
    else if (preferred && !prev.preferred) byId.set(key, { value: ev.realMs, preferred });
  }

  const durs = [...byId.values()].map((x) => x.value).concat(anon).sort((a, b) => a - b);
  const pick = (p) => {
    if (!durs.length) return null;
    const i = Math.min(durs.length - 1, Math.max(0, Math.round((durs.length - 1) * p)));
    return durs[i];
  };
  return {
    spanMs: maxTs >= minTs ? maxTs - minTs : 0,
    firstTs: minTs === Infinity ? null : minTs,
    lastTs: maxTs === -Infinity ? null : maxTs,
    /* 去重后的调用数（有耗时的） */
    durationCount: durs.length,
    durationSumMs: durs.reduce((a, b) => a + b, 0),
    durationMinMs: durs.length ? durs[0] : null,
    durationMedianMs: pick(0.5),
    durationP90Ms: pick(0.9),
    durationMaxMs: durs.length ? durs[durs.length - 1] : null,
    distinctDurations: new Set(durs).size,
  };
}

/** 版本号：接入方可以在自己的日志里带 protocol: PROTOCOL_VERSION。 */
export const PROTOCOL_VERSION = 1;
