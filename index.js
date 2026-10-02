// dsh-oks —— DSH 能力扩展：把"某个领域的知识服务（OKS）"接成两个原生工具。
// 插件不认识任何模型：开放哪个模型、模型在哪，由**会话所在工作区**根目录的 oks.json 声明
// （{"domain":"...","artifact":"...wasm"}）。工作区是会话属性，所以一份插件能服务任意多工作区。
//
// 两个工具：ontology_info（按服务给出的不透明 key 读节点，入口是 key "index"）、
// ontology_transform（把结构化 Intent 降成可执行查询计划，不执行）。
// 外加两个与模型无关的辅助工具：time_now（当前时刻的各种标准表示）、
// time_calc（日历代数：加减 / 对齐到日历边界 / 换时区）——服务不读时钟，相对时间
// 必须在提交前换成绝对边界；这两个工具只做标准表示，不解释任何领域格式。
// 插件只写一样东西：计划文件（.sql/.json，落点由工作区声明，可关）。
// 每次调用都在结果开头打印发给 OKS 的请求与响应摘要，工具卡因此自己呈现推理轨迹。
//
// **代码里不写任何"地图长什么样"的假设**（有哪些种类、入口、字段、格式、路由、分页）：
// 那些是服务自己的声明，由 agent 按 key 自主探索；插件只负责协议与呈现。
//
// 零依赖：直接注册原始工具定义，因此装在 profile 里或从工作区加载都不会有模块解析问题。
// parameters 只用受支持的 JSON Schema 关键字子集，数量校验放在 execute 里。

import { createHash } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyOps, deriveContextTimeZone, encode, parseMoment, resolveZone } from './time.js';

export const inject = ['tools'];

// 与机器、模型无关的默认值：路径、领域名、模型一律来自工作区声明。
const DEFAULTS = {
  // 墙钟上限：死循环只能靠它兜住——到点 terminate 整个 worker 代并拒掉排队请求，下次请求
  // 再拉起。正常单次请求约 2.5 ms。
  requestTimeoutMs: 60000,
  // 服务只在整批 Intent 通过时才返回 queries；开启后会把没有 Error 的子集再降一次。
  retryAcceptedSubset: true,
};

/** 读工作区的 oks.json：**"哪个模型"由工作区声明**。
 *  `artifact` 相对 oks.json 所在目录解析（绝对路径原样用）。 */
function loadWorkspaceConfig(root) {
  const file = join(root, 'oks.json');
  let oks;
  try {
    oks = JSON.parse(readFileSync(file, 'utf8'));
  } catch (cause) {
    throw new Error(
      `dsh-oks: 这个会话的工作区里没有可用的 ${file}（${cause?.message ?? cause}）。`
      + '在工作区根目录放一份 oks.json 即可开放模型，例如 '
      + '{"domain":"<知识服务领域名>","artifact":"<相对 oks.json 的 .wasm 路径>"}。'
      + '插件不提供默认模型——用错模型比报错贵。',
    );
  }
  const artifact = typeof oks?.artifact === 'string' && oks.artifact.length > 0
    ? (oks.artifact.startsWith('/') ? oks.artifact : join(root, oks.artifact))
    : undefined;
  return { root, file, oks, artifact };
}

/** 会话 → 工作区目录。工作区是**会话属性**（会话头里的 cwd），不是进程属性；
 *  取不到就报错——插件不接受配置兜底。 */
function workspaceRootFor(exec) {
  const session = exec?.agent?.session;
  const probes = [
    ['session.meta.cwd', () => session?.meta?.cwd],
    ['session.header.cwd', () => session?.header?.cwd],
    ['session.cwd', () => session?.cwd],
  ];
  for (const [where, pick] of probes) {
    try {
      const value = pick();
      if (typeof value === 'string' && value.length > 0) return { root: value, from: where };
    } catch { /* 这一层取不到，试下一层 */ }
  }
  throw new Error(
    'dsh-oks: 无法确定当前会话的工作区目录（会话头里没有 cwd），因此不知道用哪个模型。'
    + '工作区是会话属性，插件不接受配置兜底——请让会话带上 cwd。',
  );
}

/** 把一个工作区解析成一份运行设置。缺 domain / artifact 时报错并给出补法。 */
function resolveSettings(root, config) {
  const workspace = loadWorkspaceConfig(root);
  // 优先级：插件行的显式 config > 工作区的 oks.json > 与机器/模型无关的 DEFAULTS。
  const fromWorkspace = {
    domain: workspace.oks.domain,
    artifact: workspace.artifact,
    requestTimeoutMs: workspace.oks.requestTimeoutMs ?? DEFAULTS.requestTimeoutMs,
    retryAcceptedSubset: workspace.oks.retryAcceptedSubset ?? DEFAULTS.retryAcceptedSubset,
    workspaceRoot: workspace.root,
    workspaceFile: workspace.file,
  };
  const settings = { ...DEFAULTS, ...fromWorkspace, ...(config ?? {}) };
  // 计划落点：声明成字符串就写在那儿（相对 oks.json 解析，和 artifact 同一条规则），
  // 声明成 false（或 config 里 false）就不写，什么都不说才用默认的 <ws>/.oks/plans。
  const planDirFrom = (value) => {
    if (value === false || value === null) return null;
    if (typeof value !== 'string' || value.length === 0) return undefined;
    return value.startsWith('/') ? value : join(workspace.root, value);
  };
  const fromConfig = planDirFrom(config?.planDir);
  const declaredPlanDir = fromConfig !== undefined ? fromConfig : planDirFrom(workspace.oks.planDir);
  settings.planDir = declaredPlanDir === undefined
    ? join(workspace.root, '.oks', 'plans')
    : declaredPlanDir;
  const missing = ['domain', 'artifact']
    .filter((key) => typeof settings[key] !== 'string' || settings[key].length === 0);
  if (missing.length > 0) {
    throw new Error(
      `dsh-oks: ${workspace.file} 缺少必要声明: ${missing.join(', ')}。`
      + '需要 {"domain":"<知识服务领域名>","artifact":"<相对 oks.json 的 .wasm 路径>"}，'
      + '也可以在插件行的 config 里覆盖。',
    );
  }
  return settings;
}

const OBJECT_OUTPUT = { type: 'object', additionalProperties: true };

/** 自带的引导技能：注册进 ctx.skills 的 runtime 层，对所有工作区可见；正文在 skill.md。
 *  rank 250：工作区自己的 skill(100/200) 能覆盖它，用户级(400/500) 不能。 */
const SKILL = {
  name: 'ontology-query',
  description: 'Use when a user intent must become a query plan over domain data: discover the ontology with ontology_info, express the plan as structured intents through ontology_transform, and confirm alignment by restating the plan as a business intent. Resolve relative time into absolute boundaries first — time_now and time_calc do that without knowing any domain format.',
  source: 'runtime',
};

/** 产物里有没有可直接导入的服务快照。 */
function hasSnapshot(artifactPath) {
  try {
    const module = new WebAssembly.Module(readFileSync(artifactPath));
    return WebAssembly.Module.customSections(module, 'telora.snapshot').length > 0;
  } catch (cause) {
    throw new Error(`cannot read telora artifact ${artifactPath}: ${cause?.message ?? cause}`);
  }
}

// 宿主 worker 的源码，eval 内联，插件因此保持单文件。
// 放 worker 是为了能强杀：死循环只能靠超时 terminate() 兜住。
//
// ABI：零导入；mem-alloc 写请求；run-service(in_ptr,in_len,1,0,record)，
// record 是 12 字节 (out_ptr,out_len,out_cap)。
const WORKER_SOURCE = [
  "const { parentPort, workerData } = require('node:worker_threads');",
  "const { readFileSync } = require('node:fs');",
  'function decodeSnapshot(buf) {',
  '  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);',
  "  if (String.fromCharCode.apply(null, Array.from(buf.subarray(0, 8))) !== 'TLSART01') throw new Error('bad snapshot magic');",
  '  let at = 8;',
  '  if (view.getUint32(at, true) !== 1) throw new Error(\'unsupported snapshot version\'); at += 4;',
  '  const guestLen = view.getUint32(at, true); at += 4;',
  '  const guest = buf.subarray(at, at + guestLen); at += guestLen;',
  '  const count = view.getUint32(at, true); at += 4;',
  '  const globals = []; const decoder = new TextDecoder();',
  '  for (let i = 0; i < count; i += 1) {',
  '    const nameLen = view.getUint32(at, true); at += 4;',
  '    const name = decoder.decode(buf.subarray(at, at + nameLen)); at += nameLen;',
  '    const tag = buf[at]; at += 1; let value;',
  '    if (tag === 0) { value = view.getInt32(at, true); at += 4; }',
  '    else if (tag === 1) { value = view.getBigInt64(at, true); at += 8; }',
  '    else if (tag === 2) { value = view.getUint32(at, true); at += 4; }',
  '    else if (tag === 3) { value = view.getBigUint64(at, true); at += 8; }',
  '    else throw new Error(\'unknown snapshot global tag \' + tag);',
  '    globals.push([name, value]);',
  '  }',
  '  if (at !== buf.byteLength) throw new Error(\'trailing snapshot bytes\');',
  '  return { guest: guest, globals: globals };',
  '}',
  'const module = new WebAssembly.Module(readFileSync(workerData.artifact));',
  'const imports = WebAssembly.Module.imports(module);',
  'if (imports.length !== 0) throw new Error(\'expected a zero-import guest, got \' + imports.length);',
  'const exports_ = new WebAssembly.Instance(module, {}).exports;',
  'const memory = exports_.memory;',
  'const encoder = new TextEncoder(); const textDecoder = new TextDecoder();',
  'const section = WebAssembly.Module.customSections(module, \'telora.snapshot\')[0];',
  'if (section === undefined) throw new Error(\'artifact has no telora.snapshot section\');',
  'const snapshot = decodeSnapshot(new Uint8Array(section));',
  'const boot = exports_[\'mem-alloc\'](snapshot.guest.length, 1);',
  'new Uint8Array(memory.buffer, boot, snapshot.guest.length).set(snapshot.guest);',
  'exports_.telora_snapshot_import(boot, snapshot.guest.length);',
  'let restored = 0;',
  'for (const [name, value] of snapshot.globals) {',
  '  const global = exports_[name];',
  '  if (global instanceof WebAssembly.Global) { global.value = value; restored += 1; }',
  '}',
  "exports_['reset-service']();",
  'function invoke(line) {',
  '  const input = encoder.encode(line);',
  '  const ptr = exports_[\'mem-alloc\'](input.length, 1);',
  '  new Uint8Array(memory.buffer, ptr, input.length).set(input);',
  '  const record = exports_[\'mem-alloc\'](12, 4);',
  "  exports_['run-service'](ptr, input.length, 1, 0, record);",
  "  exports_['mem-free'](ptr, input.length, 1);",
  '  const view = new DataView(memory.buffer);',
  '  const outPtr = view.getUint32(record, true);',
  '  const outLen = view.getUint32(record + 4, true);',
  '  const outCap = view.getUint32(record + 8, true);',
  '  if (outPtr === 0 || outLen > outCap) throw new Error(\'guest returned an invalid output record\');',
  '  const text = textDecoder.decode(new Uint8Array(memory.buffer, outPtr, outLen).slice());',
  "  exports_['mem-free'](outPtr, outCap, 1);",
  "  exports_['mem-free'](record, 12, 4);",
  '  return JSON.parse(text);',
  '}',
  "parentPort.postMessage({ kind: 'ready', restored: restored });",
  "parentPort.on('message', (message) => {",
  '  try { parentPort.postMessage({ id: message.id, response: invoke(message.line) }); }',
  "  catch (cause) { parentPort.postMessage({ id: message.id, error: String((cause && cause.message) || cause) }); }",
  '});',
].join('\n');

/** 宿主：wasm 在进程内 worker 里，超时 terminate 并复活。
 *  接口只有 { send(method, input, signal), dispose() }。 */
function createWorkerRunner(config, log) {
  const pending = new Map();
  let worker = null;
  let nextId = 1;

  const failAll = (error) => {
    for (const [, entry] of pending) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
  };

  const spawn = () => {
    const created = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: { artifact: config.artifact },
    });
    // 初始化失败（或之后崩溃）都当作这一代的死亡；下一次 send 会重新拉起。
    created.on('message', (message) => {
      if (message?.kind === 'ready') { log(`[oks] worker ready (globals restored: ${message.restored})`); return; }
      const entry = pending.get(message?.id);
      if (entry === undefined) return;
      pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error !== undefined) entry.reject(new Error(message.error));
      else entry.resolve(message.response);
    });
    created.on('error', (cause) => {
      log(`[oks] worker error: ${cause?.message ?? cause}`);
      if (worker === created) worker = null;
      failAll(cause);
    });
    created.on('exit', (code) => {
      log(`[oks] worker exited with code ${code}`);
      if (worker === created) worker = null;
      failAll(new Error(`ontology worker exited with code ${code}`));
    });
    worker = created;
    return created;
  };

  const send = (method, input, signal) => new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error('aborted')); return; }
    const line = JSON.stringify({ method, input });
    if (worker === null) spawn();
    const id = nextId; nextId += 1;
    const timer = setTimeout(() => {
      // 到点终止整个 worker 代。
      pending.delete(id);
      const dead = worker; worker = null;
      if (dead !== null) dead.terminate();
      reject(new Error(`ontology request timed out after ${config.requestTimeoutMs} ms (worker terminated)`));
    }, config.requestTimeoutMs);
    pending.set(id, { resolve, reject, timer });
    worker.postMessage({ id, line });
  }).catch((cause) => {
    log(`[oks] worker request failed: ${cause?.message ?? cause}`);
    throw cause;
  });

  const dispose = () => {
    failAll(new Error('ontology worker was disposed'));
    const dead = worker; worker = null;
    if (dead !== null) dead.terminate();
  };

  return { send, dispose };
}

/** 当前只支持快照产物：产物必须带 `telora.snapshot` 段，Node 内置引擎直接导入它。 */
function createRunner(config, log) {
  if (!hasSnapshot(config.artifact)) {
    throw new Error(
      `dsh-oks: artifact ${config.artifact} 里没有 telora.snapshot 段。`
      + '当前只支持快照产物，请按 README 的「快照怎么来」用 `--snapshot` 重新构建。',
    );
  }
  log(`[oks] in-process wasm worker (artifact ${config.artifact})`);
  return createWorkerRunner(config, log);
}

function summarize(response) {
  if (response?.error === true) {
    const count = Array.isArray(response.diagnostics) ? response.diagnostics.length : 0;
    return `error=true · ${count} diagnostic(s)`;
  }
  const ok = response?.ok ?? {};
  if (ok.Document !== undefined) {
    const document = ok.Document;
    if (typeof document === 'string') return `error=false · Document=${document}`;
    const found = document?.Found;
    const shape = Object.keys(document ?? {})[0] ?? 'Document';
    const detail = found?.detail;
    // 只报"收回了什么形状"，不解释字段含义——字段语义由节点自己的 description 讲。
    if (detail !== null && typeof detail === 'object') {
      const parts = Object.entries(detail).map(([k, v]) => {
        if (Array.isArray(v)) return `${k}#${v.length}`;
        if (v !== null && typeof v === 'object') return `${k}={…}`;
        return `${k}=${String(v)}`;
      }).join(' ');
      return `error=false · Document=${shape} · ${found?.type ?? '?'}${parts === '' ? '' : ` · ${parts}`}`;
    }
    return `error=false · Document=${shape} · ${found?.type ?? '?'}`;
  }
  if (ok.accepted !== undefined) {
    // 批次级诊断：成功路径也可能带 Warning，所以要分别数 error / warning。
    const diagnostics = Array.isArray(ok.diagnostics) ? ok.diagnostics : [];
    const errors = diagnostics.filter((item) => item?.diagnostic?.severity === 'Error').length;
    const warnings = diagnostics.filter((item) => item?.diagnostic?.severity === 'Warning').length;
    return `error=false · accepted=${ok.accepted} · errors=${errors} · warnings=${warnings} · queries=${Array.isArray(ok.queries) ? ok.queries.length : 'null'}`;
  }
  return 'error=false';
}

/** 过程轨迹：让工具卡自己呈现「发了什么、收回了什么」。 */
function renderTrace(trace) {
  const lines = [];
  for (const step of trace ?? []) {
    const note = step.note ? `  （${step.note}）` : '';
    lines.push(`▸ OKS ${step.method}${note}`);
    lines.push(`  请求 ${JSON.stringify(step.request)}`);
    lines.push(`◂ OKS ${step.method}  ${summarize(step.response)}`);
  }
  return lines;
}

/** 纯计算类工具（不经过 OKS）的渲染：直接给结构化结果。 */
function renderValue(_args, value) {
  return [{ type: 'text', text: `${JSON.stringify(value, null, 2)}\n` }];
}

/** 渲染不做形状分类：同一套 JSON 通道对任何节点都成立。
 *  （早期版本按 type 分组渲染"目录名册"，那正是形状假设——模型一改就腐坏，所以删了。） */
function renderJson(_args, value) {
  const lines = renderTrace(value?.trace);
  lines.push('', JSON.stringify(value?.trace?.[0]?.response ?? value, null, 2));
  return [{ type: 'text', text: `${lines.join('\n')}\n` }];
}

/** ontology_transform 的模型可见渲染：过程轨迹 → 诊断 → 计划。 */
function renderPlan(_args, value) {
  const envelope = value?.response ?? {};
  const ok = envelope.ok ?? {};
  const diagnostics = Array.isArray(ok.diagnostics) ? ok.diagnostics : [];
  const intents = value?.intents ?? [];
  const plans = value?.plans ?? null;
  const lines = renderTrace(value?.trace);

  // 失败的 Intent 从 Error 级诊断的 index 推导。
  const errorIndexes = [...new Set(diagnostics
    .filter((item) => item?.diagnostic?.severity === 'Error')
    .map((item) => item.index))].sort((left, right) => left - right);

  // 成功的 Intent 也可能带 Warning，所以诊断要全列。
  if (diagnostics.length > 0) {
    lines.push('', '诊断（批次级；成功的 Intent 也可能带 Warning，使用 Queries 前先读这里）');
    for (const item of diagnostics) {
      const severity = item?.diagnostic?.severity ?? '?';
      const mark = severity === 'Error' ? '✕' : severity === 'Warning' ? '⚠' : '·';
      lines.push(`  #${(item?.index ?? 0) + 1}  ${mark} ${severity} — ${item?.diagnostic?.message ?? JSON.stringify(item)}`);
    }
  }

  if (plans) {
    if (plans.planFiles) {
      // 内容寻址：同一份计划重复问到的是同一对文件，渲染里要点明是复用。
      lines.push('', plans.planFiles.reused
        ? '计划文件（内容与已有计划一致，直接复用）'
        : '计划文件（按内容命名，可直接点开）',
      `  ${plans.planFiles.sql}`, `  ${plans.planFiles.json}`);
    }
    if (ok.accepted !== true) {
      lines.push('', '整批并未全部通过，所以服务没有返回 queries；上面第二次调用是把没有报 Error 的子集单独重降的结果。');
    }
    const planQueries = plans.response?.ok?.queries ?? [];
    planQueries.forEach((query, index) => {
      const original = (plans.indexes?.[index] ?? index) + 1;
      lines.push('', `── plan #${index + 1}（来自 intent #${original}）─────────────────`);
      lines.push(`sql:      ${query.sql}`);
      lines.push(`bindings: ${JSON.stringify(query.bindings)}`);
    });
  }

  for (const index of errorIndexes) {
    lines.push('', `── intent #${index + 1} — 被拒绝 ─────────────────`);
    lines.push(`intent:   ${JSON.stringify(intents[index])}`);
  }

  if (!plans) {
    lines.push('', '没有任何 Intent 通过。用 ontology_info 按服务给出的 key 读它声明的词汇，再修 Intent，保持业务含义不变。');
  }

  lines.push('', '上面的 SQL 是给授权执行层的中间计划，此处没有执行——也不会由你去执行。');
  lines.push('  计划就是这次任务的全部交付物：不要去找数据库、连接串或执行器，不要读回计划文件，');
  lines.push('  把上面的 SQL、bindings 与文件路径交给用户即可。');
  return [{ type: 'text', text: `${lines.join('\n')}\n` }];
}

/** 把同一份内容的可读渲染写成 .sql：SQL 与 bindings 都做成注释，便于直接贴给执行层。 */
function renderPlanSql(items) {
  return `${items
    .map((item, index) => [
      `-- plan ${index + 1}`,
      `-- intent: ${JSON.stringify(item.intent)}`,
      `${item.sql};`,
      `-- bindings: ${JSON.stringify(item.bindings)}`,
    ].join('\n'))
    .join('\n\n')}\n`;
}

/** 写一对**内容寻址**的文件：名字 = 计划内容的 sha256 前 16 位。
 *  同一批 Intent 反复问、重试、换措辞问都落在同一对文件上。
 *  .json 的字节**就是**被哈希的内容（`sha256sum` 可自校验，前缀即文件名）。
 *  写下后不再改动，只把 mtime 跟到最近一次用到，`ls -t` 因此仍有意义。 */
function writePlan(config, envelope, intents) {
  const queries = envelope?.ok?.queries ?? [];
  const items = queries.map((query, index) => ({
    index,
    intent: intents[index],
    sql: query.sql,
    bindings: query.bindings,
  }));
  const json = `${JSON.stringify({ items }, null, 2)}\n`;
  const hash = createHash('sha256').update(json).digest('hex').slice(0, 16);
  const base = join(config.planDir, `plan-${hash}`);
  const jsonFile = `${base}.json`;
  const sqlFile = `${base}.sql`;

  mkdirSync(config.planDir, { recursive: true });
  const reused = existsSync(jsonFile) || existsSync(sqlFile);
  if (reused) {
    const now = new Date();
    for (const file of [jsonFile, sqlFile]) {
      if (existsSync(file)) utimesSync(file, now, now);
    }
  } else {
    writeFileSync(jsonFile, json);
    writeFileSync(sqlFile, renderPlanSql(items));
  }
  return { sql: sqlFile, json: jsonFile, reused };
}

export function apply(ctx, config = {}) {
  const log = (message) => {
    try {
      if (ctx.logger?.info) ctx.logger.info(message);
      else console.error(message);
    } catch {
      console.error(message);
    }
  };

  // 上下文时区：按插件规范，浏览器时区挂在**当轮用户消息**的 source.clientTimeZone 上
  // （与 dsh-time-context 同一套字段与 resolved / mixed / missing 三态）。这里在 agent/pre-step
  // 时读一次并按会话记下，供两个时间工具取用。取不到就报错让 agent 去问用户，不做宿主兜底。
  const contextTimeZones = new Map(); // session -> 规范推导结果
  try {
    ctx.on('agent/pre-step', async (payload, next) => {
      const decision = await next();
      if (decision?.kind !== 'reject' && payload?.agent?.session !== undefined) {
        const derived = deriveContextTimeZone(payload.messages);
        const carriesMessages = Array.isArray(payload.messages) && payload.messages.length > 0;
        // 同一回合从第 2 步起 payload.messages 是空的（用户消息只在"进入"那一步），
        // 此时不能把已知时区覆盖成 missing；只有这一步确实带了用户消息才更新。
        if (derived.kind !== 'missing' || carriesMessages) contextTimeZones.set(payload.agent.session, derived);
      }
      return decision;
    });
  } catch (cause) {
    log('[oks] cannot observe agent/pre-step: ' + String(cause?.message ?? cause));
  }

  // 不接受任何"兜底"配置：时区来自本次请求的上下文（用户消息上的浏览器时区），
  // 工作区来自会话头的 cwd。配了就直接报错——缺东西应该看得见，而不是让插件猜。
  for (const key of ['timeZone', 'workspace']) {
    if (config?.[key] !== undefined) {
      throw new Error('dsh-oks: 不接受 config.' + key + ' 这种兜底配置（'
        + (key === 'timeZone'
          ? '时区只来自本次请求的上下文，或工具调用的 timeZone 参数'
          : '工作区是会话属性，来自会话头的 cwd')
        + '）。请删掉它；缺了就应该报错。');
    }
  }
  // 插件不认识模型：设置与 wasm 宿主都在**第一次用到某个工作区**时按那份 oks.json 惰性建立；
  // 一个进程里可以有任意多个工作区，互不影响。
  const workspaces = new Map(); // root -> entry

  // 技能服务是可选依赖（ctx.get 取），加载时它可能还没起来，所以第一次工具调用会再试一次。
  let skillRegistered = false;
  const registerSkill = () => {
    if (skillRegistered) return true;
    let content;
    try {
      content = readFileSync(new URL('./skill.md', import.meta.url), 'utf8');
    } catch (cause) {
      log(`[oks] skill body unreadable: ${cause?.message ?? cause}`);
      skillRegistered = true; // 部署缺文件，重试没有意义
      return true;
    }
    let skills = null;
    try {
      skills = ctx.get?.('skills') ?? null;
    } catch {
      skills = null;
    }
    if (typeof skills?.register !== 'function') return false;
    try {
      ctx.effect(() => skills.register({ ...SKILL, content }));
      skillRegistered = true;
      log(`[oks] skill "${SKILL.name}" registered (runtime) · ${Buffer.byteLength(content, "utf8")} bytes`);
    } catch (cause) {
      log(`[oks] cannot register skill "${SKILL.name}": ${cause?.message ?? cause}`);
      skillRegistered = true;
    }
    return skillRegistered;
  };
  registerSkill();

  /** 每个工具的入口动作：由**会话**定位工作区，再拿到（或惰性建立）它的运行环境。 */
  const ensureWorkspace = (exec) => {
    registerSkill(); // 加载时技能服务若还没起来，这里补上（已注册则是空操作）
    const { root, from } = workspaceRootFor(exec);
    const existing = workspaces.get(root);
    if (existing !== undefined) return existing;
    const settings = resolveSettings(root, config);
    const entry = {
      root,
      from,
      settings,
      runner: null,
    };
    workspaces.set(root, entry);
    log(`[oks] workspace ${root} (cwd from ${from}) · domain=${settings.domain} · model=${settings.artifact}`);
    entry.runner = createRunner(settings, log);
    return entry;
  };

  // 工具描述在注册时写死，此时还不知道任何工作区，所以文本里不出现领域名。
  // 设计约束：**这里也不写任何"地图长什么样"的假设**。工具描述只说协议（怎么打交道）
  // 与呈现（收到什么就原样给什么）；具体有哪些种类、入口、字段、格式、路由、分页，
  // 一律由服务自己的声明回答——模型换了形状，这里一行都不用改。
  const definitions = [
    {
      name: 'ontology_info',
      description: 'Read one knowledge node of this workspace\'s knowledge service by its opaque string key. Start with key "index" — the one key you may supply from memory; it tells you where to go next. From there, follow the keys the service returns, whatever shape it declares, and copy each key verbatim: never construct, split or decode one. Use only the canonical IDs the service declares when writing Intents; display names and physical column names are not substitutes.',
      parameters: {
        type: 'object',
        properties: {
          key: {
            type: 'string',
            description: 'Opaque knowledge key, copied verbatim from what the service returned — another node, a link, or a diagnostic. "index" is the one key you may supply from memory.',
          },
        },
        required: ['key'],
        additionalProperties: false,
      },
      output: { schema: OBJECT_OUTPUT, render: renderJson },
      async execute(args, exec) {
        const entry = ensureWorkspace(exec);
        const method = `${entry.settings.domain}/info`;
        const request = args?.key !== undefined && args?.key !== null ? { key: args.key } : null;
        if (request === null) {
          return {
            trace: [{
              method,
              request: {},
              response: { error: true, diagnostics: [{ message: 'ontology_info needs a knowledge key' }] },
            }],
          };
        }
        const response = await entry.runner.send(method, request, exec?.signal);
        return { trace: [{ method, request, response }] };
      },
    },
    {
      name: 'ontology_transform',
      description: 'Validate one to five independent graph Intents against this workspace\'s ontology and return an executable query plan (parameterized SQL + bindings) for each. Nothing is executed, and nothing should be executed by you: the plan itself is the deliverable — report the SQL, the bindings and the file path, then stop. Do not hunt for a database, connection string or executor, and do not read the plan files back. All Intents are checked even if one fails, and every accepted Intent comes back as a plan. On rejection, read the diagnostics and repair the Intent with its business meaning intact.',
      parameters: {
        type: 'object',
        properties: {
          intents: {
            type: 'array',
            description: 'One to five independent graph Intents, e.g. {"op":"Graph","root":"d","nodes":[{"id":"d","entity":"<dataset id>"}],"edges":[],"select":[],"count":"d"}. Closed Intent choices use the declared enum spelling in PascalCase (e.g. op "Graph", filter op "Eq", direction "Desc", row_grain "Root"); the entity is the declared dataset id, not the knowledge key. The service also declares the authoritative Intent syntax — read it from the knowledge nodes it points you to instead of relying on memory.',
            items: { type: 'object', additionalProperties: true },
          },
        },
        required: ['intents'],
        additionalProperties: false,
      },
      output: { schema: OBJECT_OUTPUT, render: renderPlan },
      async execute(args, exec) {
        const entry = ensureWorkspace(exec);
        const intents = Array.isArray(args?.intents) ? args.intents : [];
        const method = `${entry.settings.domain}/transform`;
        if (intents.length < 1 || intents.length > 5) {
          return {
            trace: [{
              method,
              request: { intents },
              response: { error: true, diagnostics: [{ message: 'ontology_transform requires one to five independent Intents' }] },
            }],
            intents,
          };
        }

        const trace = [];
        const response = await entry.runner.send(method, { intents }, exec?.signal);
        trace.push({ method, request: { intents }, response });

        const diagnostics = Array.isArray(response?.ok?.diagnostics) ? response.ok.diagnostics : [];
        const errorIndexes = new Set(diagnostics
          .filter((item) => item?.diagnostic?.severity === 'Error')
          .map((item) => item.index));
        let plans = null;
        const planFor = (subsetResponse, subsetIntents, indexes) => {
          let planFiles = null;
          if (entry.settings.planDir !== null) {
            try {
              planFiles = writePlan(entry.settings, subsetResponse, subsetIntents);
            } catch (cause) {
              log(`[oks] failed to write plan files: ${cause?.message ?? cause}`);
            }
          }
          return { response: subsetResponse, intents: subsetIntents, indexes, planFiles };
        };
        if (response?.ok?.accepted === true && Array.isArray(response?.ok?.queries)) {
          plans = planFor(response, intents, intents.map((_intent, index) => index));
        } else if (entry.settings.retryAcceptedSubset !== false) {
          // 服务只在整批通过时返回 queries；把没有报 Error 的子集单独再降一次，用户就能看到 SQL。
          const indexes = intents
            .map((_intent, index) => index)
            .filter((index) => !errorIndexes.has(index));
          if (indexes.length > 0 && indexes.length < intents.length) {
            const subsetIntents = indexes.map((index) => intents[index]);
            const retry = await entry.runner.send(method, { intents: subsetIntents }, exec?.signal);
            trace.push({ method, request: { intents: subsetIntents }, response: retry, note: '仅未报 Error 的子集，重降一次以取出 SQL' });
            if (retry?.ok?.accepted === true && Array.isArray(retry?.ok?.queries)) {
              plans = planFor(retry, subsetIntents, indexes);
            }
          }
        }

        return { trace, response, intents, plans };
      },
    },
    {
      name: 'time_now',
      description: 'Read the current instant from the host clock in several standard forms — epoch milliseconds and seconds, UTC text, RFC 3339, local text with its UTC offset, calendar date, and ISO week. The knowledge service never reads the clock, so every relative expression ("last week", "the last 24 hours") has to become an absolute boundary before it is submitted: resolve it here, state the time zone you used, and pick whichever form the knowledge node itself declares. This tool knows nothing about domain time formats.',
      parameters: {
        type: 'object',
        properties: {
          timeZone: {
            type: 'string',
            description: 'IANA time zone such as "Asia/Shanghai". By default the zone comes from the request context — the browser zone the client attached to the current turn messages, read per the plugin spec — so pass one only to override it (for example when the context zone is mixed or missing). There is no host-zone fallback: with no context zone and no argument, the call fails and tells you to ask the user. The source actually used is echoed back.',
          },
        },
        additionalProperties: false,
      },
      output: { schema: OBJECT_OUTPUT, render: renderValue },
      async execute(args, exec) {
        const { zone, source } = resolveZone(args?.timeZone, contextTimeZones.get(exec?.agent?.session));
        return { timeZone: zone, timeZoneSource: source, ...encode(Date.now(), zone) };
      },
    },
    {
      name: 'time_calc',
      description: 'Apply ordered calendar arithmetic to an instant and return every standard form of the result: add (year/quarter/month/week/day/hour/minute/second), floor/ceil to a calendar boundary (weeks start on Monday unless weekStartsOn is given), and convert between time zones. Day and week arithmetic keeps the local wall clock, so a day across a daylight-saving change is not always 24 hours; month/quarter/year addition clamps to the last valid day. Intervals are half-open [start, end), so compute both ends. base accepts "now" (the default), epoch milliseconds as a number, RFC 3339 text, or zone-less text "YYYY-MM-DD[ HH:MM[:SS]]" read as local time in the given zone.',
      parameters: {
        type: 'object',
        properties: {
          base: {
            oneOf: [{ type: 'string' }, { type: 'number' }],
            description: '"now" (default), epoch milliseconds as a number, RFC 3339 text, or zone-less "YYYY-MM-DD[ HH:MM[:SS]]" read as local time in timeZone.',
          },
          timeZone: {
            type: 'string',
            description: 'IANA time zone such as "Asia/Shanghai". By default the zone comes from the request context — the browser zone the client attached to the current turn messages, read per the plugin spec — so pass one only to override it (for example when the context zone is mixed or missing). There is no host-zone fallback: with no context zone and no argument, the call fails and tells you to ask the user. The source actually used is echoed back.',
          },
          operations: {
            type: 'array',
            description: 'Applied in order, e.g. {"op":"add","unit":"month","amount":-1}, {"op":"floor","unit":"week","weekStartsOn":1}, {"op":"ceil","unit":"day"}, {"op":"convert","zone":"UTC"}.',
            items: { type: 'object', additionalProperties: true },
          },
        },
        additionalProperties: false,
      },
      output: { schema: OBJECT_OUTPUT, render: renderValue },
      async execute(args, exec) {
        const { zone, source } = resolveZone(args?.timeZone, contextTimeZones.get(exec?.agent?.session));
        const base = parseMoment(args?.base, zone);
        const result = applyOps({ epochMillis: base, zone }, args?.operations);
        return {
          timeZone: result.zone,
          timeZoneSource: source,
          base: { input: args?.base ?? 'now', ...encode(base, zone) },
          operations: result.applied,
          ...encode(result.epochMillis, result.zone),
        };
      },
    },
  ];

  for (const definition of definitions) {
    const dispose = ctx.tools.register(definition);
    if (typeof dispose === 'function') ctx.effect(() => dispose);
  }

  // 卸载时把每个工作区的 wasm 宿主都关掉。
  ctx.effect(() => () => {
    for (const entry of workspaces.values()) {
      try {
        entry.runner?.dispose();
      } catch { /* 尽量都关掉，不让一个失败挡住其余 */ }
    }
    workspaces.clear();
  });
}
