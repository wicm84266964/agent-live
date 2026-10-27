/**
 * adapters/expand.mjs —— 预展平层：把"工具块藏在 message.content[] 里"的日志摊平
 *
 * ===== 这个文件存在的理由 =====
 *
 * `adapters/generic.mjs` 的映射层是按**记录级字段**取值的（`start: {"type":["tool_use"]}`），
 * 它假定"一条记录 = 一个工具调用开始/结束"。
 *
 * 但 Claude Code 的 transcript 不是这个形状：
 *
 *   {"type":"assistant","timestamp":"2025-01-01T00:00:00Z",
 *    "message":{"role":"assistant","content":[
 *      {"type":"text","text":"我先读一下文件"},
 *      {"type":"tool_use","id":"toolu_01A","name":"Read","input":{"file_path":"a.mjs"}},
 *      {"type":"tool_use","id":"toolu_01B","name":"Bash","input":{...}}
 *    ]}}
 *
 * 一条记录里可能含 **0 到 N 个** 工具块，而且块在数组元素里 —— 顶层没有 `type:"tool_use"`。
 * 直接喂给 generic.mjs，结果是**每一条都 `no-rule-matched`**：如实报告，但毫无用处。
 *
 * 所以必须先有一层"展开"：一条记录 → 若干条扁平记录（一条一个工具块），
 * 扁平记录再交给 generic.mjs + `profiles/claude-code.json` 翻译成协议事件。
 *
 * ===== 它不发明协议 =====
 *
 * 这一层**不产出** `{kind,tool,id}` 协议事件 —— 那是 generic.mjs 的活。
 * 它产出的字段名，全部是 `profiles/claude-code.json` 里**已经点名**的路径：
 *
 *   工具名 → `name`          调用 id → `id` / `tool_use_id`
 *   时刻   → `timestamp`     耗时   → `duration_ms`
 *   失败   → `is_error`      会话   → `session_id`
 *
 * 所以链路是：原始记录 → expand → 扁平记录 → generic+profile → 协议事件 → validate。
 * 想验证这条链路，看 `tests/expand.test.mjs`（合成夹具）。
 *
 * ===== 三条诚实红线 =====
 *
 * 1. **配对语义不许丢**：`tool_use.id` / `tool_result.tool_use_id` **原样保留**。
 *    这是回归红线 —— 历史事故里 292 次调用被算成 283 次配对，原因就是配对口径
 *    从"按 callId"漂成"按工具名"。展平层如果在这里改写/重新编号 id，
 *    等于把那个事故重新制造一遍，而且更隐蔽（能跑通，只是配对率悄悄掉）。
 *    所以：id 只做**搬运**，不做生成、不做去重、不做格式化。
 *
 * 2. **不伪造时刻**：块自己没有时刻时，只允许继承**同一份记录里真实存在**的时刻
 *    （记录级 `timestamp` / `message.timestamp`）。继承来的是"这条记录写下的时刻"，
 *    是真实存在的值，不是编的。
 *    拿不到就**如实缺失**（扁平记录里干脆没有 `timestamp` 键），让 generic.mjs
 *    报 `missing-ts`、让 doctor 把这条算进"没映射成功"的分类计数里。
 *    **绝不 `Date.now()`** —— 历史记录配"现在"是最典型的假进度。
 *
 * 3. **不搬运工具入参/结果正文**：`block.input`（工具参数）与 `tool_result.content`
 *    （工具输出）**不**进扁平记录。原因有两条：
 *    a) 体积：一个 Read 的输出可能是几万字符，摊进事件流会淹没统计；
 *    b) 内容：参数里可能有 token、路径、私密数据。generic.mjs 的 `extra`
 *       设计原则就是"只透传配置点名的字段"，这一层遵守同一个原则。
 *    需要正文的人应该去看原始日志，不该指望事件流。
 *
 * ===== 为什么是纯 ESM、零依赖、不引 node: =====
 *
 * 展平本身是**纯函数**（记录数组进、记录数组出），不读文件、不碰时钟、不做 IO。
 * 这样它能被浏览器直接 import、能被测试直接喂合成数据 ——
 * 而"怎么把文件读成记录数组"是调用方的事（doctor 的 `readFileOnce()`、
 * 或你自己 `JSON.parse` 每行）。读文件与展平分开，是这个模块能被单测的前提。
 */

/* ------------------------------------------------------------------ *
 * 1. 常量
 * ------------------------------------------------------------------ */

/** 展平层版本。输出形状变了就 +1（调用方可以据此判断要不要重跑）。 */
export const EXPAND_VERSION = 1;

/** 认得的 content 块类型。只列这个文件**真的要处理**的两个，其余一律如实计数丢弃。 */
export const BLOCK_TYPE = Object.freeze({
  TOOL_USE: 'tool_use',
  TOOL_RESULT: 'tool_result',
});

/**
 * 丢弃原因码（稳定字符串，测试按这些码断言，别随便改）。
 *
 * "丢了 N 个块"和"丢了 N 个块，原因分别是 text/thinking/unknown-block"
 * 是两件性质完全不同的事 —— 后者才能告诉你展平层是不是漏了某种形状。
 */
export const DROP_CODE = Object.freeze({
  /** 普通文本块（assistant 的叙述），天然不是工具调用 */
  TEXT_BLOCK: 'text-block',
  /** 思考块 */
  THINKING_BLOCK: 'thinking-block',
  /** 认得数组形状但没有可识别的块类型 */
  UNKNOWN_BLOCK: 'unknown-block',
  /** 记录里有 message 但没有 content 数组（字符串 content / 缺字段） */
  NO_CONTENT: 'no-content',
  /** 块是 null / 数字 / 字符串，不是对象 */
  NOT_OBJECT: 'not-object',
});

/* ------------------------------------------------------------------ *
 * 2. 小工具（纯函数）
 * ------------------------------------------------------------------ */

function isPlainObject(v) {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * 按候选键取第一个"存在且不是 null/undefined"的值。
 *
 * 注意这里用 `hasOwnProperty` 而不是 `in`：原型链上的 `constructor` 之类
 * 不该被当成日志字段。取值口径与 `generic.mjs` 的 `getPath()` 保持一致。
 */
function pick(obj, keys) {
  if (!isPlainObject(obj)) return { found: false };
  for (const k of keys) {
    if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
    const v = obj[k];
    if (v == null) continue;
    return { found: true, value: v, via: k };
  }
  return { found: false };
}

/** 只在这些键上找时刻。`created_at` 是若干 SDK 的写法。 */
const TS_KEYS = ['timestamp', 'ts', 'time', 'created_at'];
/** 只在块上找调用 id。`tool_use_id` 是 tool_result 的写法。 */
const ID_KEYS = ['id', 'tool_use_id', 'toolUseId', 'callId'];
/** 会话 id */
const SESSION_KEYS = ['session_id', 'sessionId'];

/**
 * 一条"承载工具块的容器"：可能是记录本身，也可能是 `record.message` / 某条 message。
 *
 * @returns {object[]} 依次尝试的容器（由内到外：块 → message → record）
 */
function contentOf(container) {
  if (!isPlainObject(container)) return null;
  const c = container.content;
  return Array.isArray(c) ? c : null;
}

/**
 * 把一条原始记录拆成"容器列表"。
 *
 * 支持的常见形态（都是合成夹具里出现过的形状，不是从真实转录总结的）：
 *   1. `{type:'assistant', message:{content:[...]}}`   —— 最常见
 *   2. `{content:[...]}`                                —— 裸记录
 *   3. `{message:[{content:[...]}, {content:[...]}]}`    —— message 是数组
 *   4. `{messages:[{content:[...]}, ...]}`               —— 批量导出
 *
 * 一个记录可能同时命中多种（比如既有 `messages[]` 又有顶层 `content`），
 * 那就在一起全展开 —— 宁可多展开也不要漏，漏了就是"静默丢事件"。
 */
function carriersOf(record) {
  const out = [];

  const pushContainer = (container, owner) => {
    const blocks = contentOf(container);
    if (!blocks) return;
    out.push({ blocks, message: container === record ? null : container, record, owner });
  };

  if (Array.isArray(record.messages)) {
    for (const m of record.messages) pushContainer(m, 'messages[]');
  }
  if (Array.isArray(record.message)) {
    for (const m of record.message) pushContainer(m, 'message[]');
  } else if (isPlainObject(record.message)) {
    pushContainer(record.message, 'message');
  }
  pushContainer(record, 'record');

  return out;
}

/**
 * 在"块 → 容器 → 记录"这条链上找时刻。
 *
 * 这是**继承**，不是伪造：取到的是同一份记录上真实写着的某个时刻字段。
 * 三者都没有 → `found:false`，调用方如实不写 `timestamp`。
 */
function findTs(block, container, record) {
  for (const src of [block, container && container.message, record]) {
    const got = pick(src, TS_KEYS);
    if (got.found) return got;
  }
  return { found: false };
}

function findSession(block, container, record) {
  for (const src of [block, container && container.message, record]) {
    const got = pick(src, SESSION_KEYS);
    if (got.found && typeof got.value === 'string' && got.value.trim() !== '') return got;
  }
  return { found: false };
}

/* ------------------------------------------------------------------ *
 * 3. 单块 → 扁平记录
 * ------------------------------------------------------------------ */

/**
 * 把块上取到的非空字符串写进扁平记录（取不到就不写这个键）。
 *
 * 为什么"取不到就不写键"而不是写 `undefined`：
 * `generic.mjs` 用 `hasOwnProperty` 判断"字段存在与否"。
 * 一个值为 `undefined` 的键会被判成"存在"，于是
 * `toMs(undefined) === null` → 报 `bad-field-type`（说"时间字段存在但解析不了"），
 * 而真实病因是"根本没有时间字段"（应该是 `missing-ts`）。
 * 报错码错一个，排错方向就错一片。
 */
function setIfString(target, key, value) {
  if (typeof value === 'string' && value.trim() !== '') target[key] = value;
}

function setIfId(target, key, value) {
  /* id 允许数字（有些智能体用自增序号），generic.mjs 会 String() 规范化 */
  if (typeof value === 'string' && value.trim() !== '') target[key] = value;
  else if (typeof value === 'number' && Number.isFinite(value)) target[key] = value;
}

/**
 * 处理一个 `tool_use` 块 → 一条扁平记录（`type:"tool_use"`，命中 profile 的 start 规则）。
 *
 * @returns {{ record: object, issues: object[] }}
 */
function flattenToolUse(block, container, record) {
  const flat = { type: BLOCK_TYPE.TOOL_USE };
  const issues = [];

  /*
   * id：**原样搬运**。这是配对主键，只搬不改。
   * 取不到也照样发这条记录 —— generic.mjs 会如实报 missing-id 并退回 FIFO，
   * 而"因为没 id 就丢掉这次调用"会让 star 少一颗星，属于静默丢事件。
   */
  const id = pick(block, ID_KEYS);
  if (id.found) setIfId(flat, 'id', id.value);
  else {
    issues.push({
      code: 'missing-block-id',
      message: `tool_use 块没有调用 id（试过 ${ID_KEYS.join(', ')}）—— `
        + '配对只能退回同工具 FIFO，同名多次调用无法区分',
      tool: typeof block.name === 'string' ? block.name : undefined,
    });
  }

  const name = pick(block, ['name', 'tool_name', 'toolName']);
  if (name.found) setIfString(flat, 'name', name.value);
  else {
    issues.push({
      code: 'missing-tool-name',
      message: 'tool_use 块没有工具名（试过 name, tool_name, toolName）—— '
        + 'generic.mjs 会如实报 missing-tool，不猜名字',
      id: flat.id,
    });
  }

  /* 时刻：块 → message → 记录，逐级继承；都没有就不写 */
  const ts = findTs(block, container, record);
  if (ts.found) flat.timestamp = ts.value;
  else {
    issues.push({
      code: 'missing-timestamp',
      message: 'tool_use 块及其所属记录都没有时刻字段 —— 不补造，'
        + 'generic.mjs 会报 missing-ts（没有实时时钟时）',
      id: flat.id,
    });
  }

  const sess = findSession(block, container, record);
  if (sess.found) flat.session_id = sess.value;

  /*
   * `duration_ms` 一般出现在结果块上，但个别日志把它放在调用块上。
   * 有就带、没有就不带（负数/非数字一律不带，绝不编）。
   */
  const dur = pick(block, ['duration_ms', 'durationMs', 'elapsed_ms']);
  if (dur.found && typeof dur.value === 'number' && Number.isFinite(dur.value) && dur.value >= 0) {
    flat.duration_ms = dur.value;
  }

  return { record: flat, issues };
}

/**
 * 处理一个 `tool_result` 块 → 一条扁平记录（`type:"tool_result"`，命中 end 规则）。
 *
 * 关键点：`tool_use_id` **原样保留**在这个键名上（不改写成 `id`）。
 * 理由：语义要说清楚"这是指向某个调用 id 的引用"，而不是"我自己有个 id"。
 * profile 的 `id` 候选列表里 `tool_use_id` 排第二，取得到；配对按同一个字符串比。
 */
function flattenToolResult(block, container, record) {
  const flat = { type: BLOCK_TYPE.TOOL_RESULT };
  const issues = [];

  const id = pick(block, ['tool_use_id', 'toolUseId', 'id', 'callId']);
  if (id.found) setIfId(flat, 'tool_use_id', id.value);
  else {
    issues.push({
      code: 'missing-block-id',
      message: 'tool_result 块没有 tool_use_id —— 无法与任何调用配对，'
        + '只能退回同工具 FIFO',
    });
  }

  /* 工具名：真实数据里 tool_result 常常**只有** tool_use_id（协议里 tool 在
   * tool_end 上本来就可缺）。有就带，没有就不带，绝不猜一个名字填上。 */
  const name = pick(block, ['name', 'tool_name', 'toolName']);
  if (name.found) setIfString(flat, 'name', name.value);

  /* 成功/失败：只接受真布尔（或布尔字符串）。其它值一律不带 ——
   * generic.mjs 的 resolveOk 也是这个口径，两边不能打架。 */
  const err = pick(block, ['is_error', 'isError']);
  if (err.found && (typeof err.value === 'boolean' || err.value === 'true' || err.value === 'false')) {
    flat.is_error = err.value;
  }

  const ts = findTs(block, container, record);
  if (ts.found) flat.timestamp = ts.value;
  else {
    issues.push({
      code: 'missing-timestamp',
      message: 'tool_result 块及其所属记录都没有时刻字段 —— 不补造，'
        + 'generic.mjs 会报 missing-ts（没有实时时钟时）',
      id: flat.tool_use_id,
    });
  }

  const dur = pick(block, ['duration_ms', 'durationMs', 'elapsed_ms']);
  if (dur.found && typeof dur.value === 'number' && Number.isFinite(dur.value) && dur.value >= 0) {
    flat.duration_ms = dur.value;
  }

  const sess = findSession(block, container, record);
  if (sess.found) flat.session_id = sess.value;

  return { record: flat, issues };
}

/* ------------------------------------------------------------------ *
 * 4. 主入口
 * ------------------------------------------------------------------ */

/** 一个块该不该被丢掉，以及为什么。 */
function classifyBlock(block) {
  if (!isPlainObject(block)) return { drop: DROP_CODE.NOT_OBJECT };
  const t = typeof block.type === 'string' ? block.type : '';
  if (t === BLOCK_TYPE.TOOL_USE) return { kind: 'tool_use' };
  if (t === BLOCK_TYPE.TOOL_RESULT) return { kind: 'tool_result' };
  if (t === 'text' || t === 'output_text' || t === 'input_text') {
    return { drop: DROP_CODE.TEXT_BLOCK, type: t };
  }
  if (t === 'thinking' || t === 'redacted_thinking' || t === 'reasoning') {
    return { drop: DROP_CODE.THINKING_BLOCK, type: t };
  }
  return { drop: DROP_CODE.UNKNOWN_BLOCK, type: t || '(无 type)' };
}

/**
 * 展平一条记录。**纯函数**：不读文件、不看时钟、不改入参。
 *
 * @param {object} record 原始记录（Claude Code 风格）
 * @param {{ stats?: object, issues?: object[], maxIssues?: number }} [ctx] 内部收集器
 * @returns {object[]} 扁平记录（可能为空数组）
 */
export function expandRecord(record, ctx = {}) {
  const stats = ctx.stats;
  const issues = ctx.issues;
  const maxIssues = Number.isFinite(ctx.maxIssues) ? ctx.maxIssues : 50;

  const addIssue = (i) => {
    if (!issues) return;
    if (issues.length >= maxIssues) return;
    issues.push(i);
  };

  const bump = (key) => {
    if (!stats) return;
    stats[key] = (stats[key] || 0) + 1;
  };

  if (!isPlainObject(record)) {
    bump('dropped');
    if (stats) stats.droppedByCode[DROP_CODE.NOT_OBJECT] =
      (stats.droppedByCode[DROP_CODE.NOT_OBJECT] || 0) + 1;
    return [];
  }

  const carriers = carriersOf(record);

  /*
   * 没有 content 数组的记录：**原样透传**。
   *
   * 这类记录是"本身已经是扁平形状"的那种 —— 典型是 Claude Code 结尾的
   * `{"type":"result","subtype":"success","timestamp":...}`（对应协议 turn_end），
   * 或者别人已经预展平过的行。透传让 profile 的 `turnEnd` 规则也能生效。
   *
   * 注意：透传不是"什么都过"，非对象/无 type 的记录在上/下面会被计数丢弃。
   */
  if (carriers.length === 0) {
    if (typeof record.type === 'string') {
      bump('passthrough');
      return [record];
    }
    bump('dropped');
    if (stats) {
      stats.droppedByCode[DROP_CODE.NO_CONTENT] =
        (stats.droppedByCode[DROP_CODE.NO_CONTENT] || 0) + 1;
    }
    return [];
  }

  const out = [];
  for (const container of carriers) {
    for (const block of container.blocks) {
      const c = classifyBlock(block);
      if (c.drop) {
        bump('dropped');
        if (stats) {
          stats.droppedByCode[c.drop] = (stats.droppedByCode[c.drop] || 0) + 1;
          if (c.type) stats.droppedBlockTypes[c.type] = (stats.droppedBlockTypes[c.type] || 0) + 1;
        }
        continue;
      }
      if (c.kind === 'tool_use') {
        const r = flattenToolUse(block, container, record);
        for (const i of r.issues) addIssue(i);
        if (r.issues.some((i) => i.code === 'missing-timestamp')) bump('missingTimestamp');
        if (r.issues.some((i) => i.code === 'missing-block-id')) bump('missingId');
        out.push(r.record);
        continue;
      }
      const r = flattenToolResult(block, container, record);
      for (const i of r.issues) addIssue(i);
      if (r.issues.some((i) => i.code === 'missing-timestamp')) bump('missingTimestamp');
      if (r.issues.some((i) => i.code === 'missing-block-id')) bump('missingId');
      out.push(r.record);
    }
  }

  return out;
}

/**
 * 把工具名从同 id 的 `tool_use` 记录回填到 `tool_result` 记录上。
 *
 * ===== 为什么这是"查表"而不是"猜" =====
 *
 * 真实的 `tool_result` 块一般**只带** `tool_use_id`，不带工具名
 * （协议的 `tool` 在 `tool_end` 上本来就允许缺，见 SCHEMA.tool）。
 * 缺了名的后果不是配对错（配对按 id 走），而是：
 *   - 画面上的击杀没有工具名可显示（`missing-tool-on-end` warn）；
 *   - 人读 doctor 输出时看不出是哪次调用结束了。
 *
 * 回填的值来自**同一份日志里、通过同一个 id 关联的那条 tool_use 记录** ——
 * 这是货真价实的外键 join，不是"看起来像就填一个"。
 * 找不到对应的 tool_use（比如日志从会话中途开始、开始记录被轮转掉了）时
 * **就不填**：宁可缺，也不许补 `"unknown"` 之类的占位名。
 *
 * 一致性：一个 id 对应多个工具名（数据源脏）时**不填**并计 `conflicts`，
 * 因为挑一个就是猜。
 *
 * @returns {number} 回填条数
 */
function backfillToolNames(records, stats) {
  /** id -> name（只在同一个 id 上见过**同一个**名字时才算可信） */
  const names = new Map();
  const conflicts = new Set();
  for (const r of records) {
    if (r.type !== BLOCK_TYPE.TOOL_USE) continue;
    if (r.id == null || typeof r.name !== 'string' || r.name === '') continue;
    const key = String(r.id);
    const prev = names.get(key);
    if (prev === undefined) names.set(key, r.name);
    else if (prev !== r.name) conflicts.add(key);
  }
  let filled = 0;
  for (const r of records) {
    if (r.type !== BLOCK_TYPE.TOOL_RESULT) continue;
    if (r.name !== undefined) continue;
    if (r.tool_use_id == null) continue;
    const key = String(r.tool_use_id);
    if (conflicts.has(key)) continue;
    const name = names.get(key);
    if (name === undefined) continue;
    r.name = name;
    filled++;
  }
  if (stats) {
    stats.nameBackfilled = filled;
    stats.nameBackfillConflicts = conflicts.size;
  }
  return filled;
}

/**
 * 展平一组记录。
 *
 * 返回值里的 `stats` 是**如实报告**的载体：
 *   - `toolUse` / `toolResult`：展平出多少条
 *   - `dropped` / `droppedByCode` / `droppedBlockTypes`：丢了多少、为什么丢
 *   - `missingTimestamp` / `missingId`：有多少条缺时刻/缺 id（这些会在下游变成
 *     `missing-ts` / `missing-id`，doctor 会分类计数）
 *   - `nameBackfilled`：有多少条 tool_result 的工具名是按 id 从 tool_use 查回来的
 *     （纯查表，查不到就不填；`nameBackfillConflicts` 是同 id 多名字的对数）
 *
 * 丢了东西不报，等于静默失真 —— 所以这些计数是必须的，不是可选装饰。
 *
 * @param {object[]} records
 * @param {{ maxIssues?: number, backfillNames?: boolean }} [opts]
 *        `backfillNames:false` 关掉"按 id 回填工具名"（默认开）。
 * @returns {{ records: object[], issues: object[], stats: object }}
 */
export function expandRecords(records, opts = {}) {
  const stats = {
    version: EXPAND_VERSION,
    inputRecords: 0,
    outputRecords: 0,
    toolUse: 0,
    toolResult: 0,
    passthrough: 0,
    dropped: 0,
    droppedByCode: Object.create(null),
    droppedBlockTypes: Object.create(null),
    missingTimestamp: 0,
    missingId: 0,
    /** 从同 id 的 tool_use 记录里回填到 tool_result 上的工具名条数（见 backfillToolNames） */
    nameBackfilled: 0,
  };
  const issues = [];
  const maxIssues = Number.isFinite(opts.maxIssues) ? opts.maxIssues : 50;
  const out = [];

  for (const rec of Array.isArray(records) ? records : []) {
    stats.inputRecords++;
    for (const f of expandRecord(rec, { stats, issues, maxIssues })) out.push(f);
  }
  stats.outputRecords = out.length;

  for (const r of out) {
    if (r.type === BLOCK_TYPE.TOOL_USE) stats.toolUse++;
    else if (r.type === BLOCK_TYPE.TOOL_RESULT) stats.toolResult++;
  }

  if (opts.backfillNames !== false) backfillToolNames(out, stats);

  return { records: out, issues, stats };
}

/**
 * 一行式便捷函数：原始记录数组 → 扁平记录数组（只要结果、不要统计）。
 *
 * 需要看"丢了什么"的时候请用 `expandRecords()`，别用这个。
 */
export function flatten(records, opts = {}) {
  return expandRecords(records, opts).records;
}
