// dsh-oks —— DSH 能力扩展：把"某个领域的知识服务（OKS）"接成五个原生工具。
// 插件不认识任何模型：开放哪个模型、模型在哪，由**会话所在工作区**根目录的 oks.json 声明
// （{"domain":"...","artifact":"...wasm","dataFile":"...sqlite"}）。
// 工作区是会话属性，所以一份插件能服务任意多工作区。
//
// 五个工具：oks_search（按名词/说法在词汇表里找到 key）、
// oks_references（按 key 反向找到引用它的节点）、
// oks_info（按服务给出的不透明 key 读节点，入口是 key "index"）、
// oks_check_intent（只校验结构化 Intent，只回诊断）、
// oks_query（校验后**只读查询**数据文件，回结果；SQL/bindings 只在这一条路径上出现）。
// 外加两个与模型无关的辅助工具：time_now（当前时刻的各种标准表示）、
// time_calc（日历代数：加减 / 对齐到日历边界 / 换时区）——服务不读时钟，相对时间
// 必须在提交前换成绝对边界；这两个工具只做标准表示，不解释任何领域格式。
//
// 词汇表与引用图：第一次用到检索时，插件按服务声明的**发现契约**（`<domain>/discovery`
// 给出可见入口，沿 `info` 的引用图走完，再在本地派生）在内存里建好词汇表与反向引用索引，
// 之后整个进程按产物的 artifact_sha256 复用。索引里只有词汇与引用边，不含节点内容——
// 读节点始终由 oks_info 透传给服务。它不写工作区、也不进模型上下文。
//
// **插件在工作区里不写任何东西**：没有计划文件、没有缓存产物。每次执行的 SQL、bindings、
// 行数与耗时写进宿主日志（ctx.logger），工作区保持干净。
//
// **代码里不写任何"地图长什么样"的假设**（有哪些种类、入口、字段、格式、路由、分页）：
// 那些是服务自己的声明，由 agent 按 key 自主探索。唯一的例外是服务自己声明的消费契约
// ——发现入口与派生规则；检索层照它派生，对不上时直接报错，不静默降级。
//
// 零依赖：直接注册原始工具定义，因此装在 profile 里或从工作区加载都不会有模块解析问题；
// 查询用 Node 自带的 node:sqlite（只读打开）。parameters 只用受支持的 JSON Schema
// 关键字子集，数量校验放在 execute 里。

import { createHash } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { applyOps, deriveContextTimeZone, encode, parseMoment, resolveZone } from './time.js';

export const inject = ['tools'];

// 与机器、模型无关的默认值：路径、领域名、模型一律来自工作区声明。
const DEFAULTS = {
  // 墙钟上限：死循环只能靠它兜住——到点 terminate 整个 worker 代并拒掉排队请求，下次请求
  // 再拉起。正常单次请求约 2.5 ms。
  requestTimeoutMs: 60000,
  // 服务只在整批 Intent 通过时才返回 queries；开启后会把没有 Error 的子集再降一次。
  retryAcceptedSubset: true,
  // 只读查询的墙钟上限与被取回的最大行数（node:sqlite 是同步 API，卡住只能靠 terminate）。
  queryTimeoutMs: 30000,
  queryMaxRows: 200,
};

// 模型可见文本的预算：留在宿主 tool-result pruner 的阈值（8192 字符）以下，否则结果会被
// 从**中间**截掉，反而同时丢掉 SQL 和一部分行。
const RESULT_BUDGET_CHARS = 6000;
const RESULT_MAX_COLUMNS = 32;
const RESULT_MAX_CELL_CHARS = 200;
const SQL_DISPLAY_CHARS = 1200;
const BINDINGS_DISPLAY_CHARS = 400;
const REQUEST_DISPLAY_CHARS = 300;

const capLine = (text, max) => (text.length <= max ? text : `${text.slice(0, max)}…`);

/** 读工作区的 oks.json：**"哪个模型、哪份数据"由工作区声明**。
 *  `artifact` 与 `dataFile` 都相对 oks.json 所在目录解析（绝对路径原样用）。 */
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
  const resolve = (value) => (typeof value === 'string' && value.length > 0
    ? (value.startsWith('/') ? value : join(root, value))
    : undefined);
  return { root, file, oks, artifact: resolve(oks?.artifact), dataFile: resolve(oks?.dataFile) };
}

/** 会话 → 工作区目录。工作区是**会话属性**（会话头里的 cwd），不是进程属性；
 *  取不到就报错，让会话把 cwd 带上。 */
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
    + '工作区是会话属性，来源是会话头的 cwd——请让会话带上它。',
  );
}

/** 把一个工作区解析成一份运行设置。缺 domain / artifact 时报错并给出补法。 */
function resolveSettings(root, config) {
  const workspace = loadWorkspaceConfig(root);
  // 优先级：插件行的显式 config > 工作区的 oks.json > 与机器/模型无关的 DEFAULTS。
  const fromWorkspace = {
    domain: workspace.oks.domain,
    artifact: workspace.artifact,
    dataFile: workspace.dataFile,
    requestTimeoutMs: workspace.oks.requestTimeoutMs ?? DEFAULTS.requestTimeoutMs,
    retryAcceptedSubset: workspace.oks.retryAcceptedSubset ?? DEFAULTS.retryAcceptedSubset,
    queryTimeoutMs: workspace.oks.queryTimeoutMs ?? DEFAULTS.queryTimeoutMs,
    queryMaxRows: workspace.oks.queryMaxRows ?? DEFAULTS.queryMaxRows,
    workspaceRoot: workspace.root,
    workspaceFile: workspace.file,
  };
  // 设置有三个来源：与机器无关的默认值、工作区的 oks.json、插件行 config 里的这几个覆盖键。
  const overrides = {};
  for (const key of ['domain', 'artifact', 'dataFile', 'requestTimeoutMs',
    'retryAcceptedSubset', 'queryTimeoutMs', 'queryMaxRows']) {
    if (config?.[key] !== undefined) overrides[key] = config[key];
  }
  const settings = { ...DEFAULTS, ...fromWorkspace, ...overrides };
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
  name: 'oks-query',
  description: 'Use when a business question must be answered from domain data: discover the domain model with oks_info, validate structured intents with oks_check_intent, and get actual rows with oks_query. Resolve relative time into absolute boundaries first — time_now and time_calc do that without knowing any domain format.',
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
  'const encoder = new TextEncoder(); const textDecoder = new TextDecoder();',
  'const section = WebAssembly.Module.customSections(module, \'telora.snapshot\')[0];',
  'if (section === undefined) throw new Error(\'artifact has no telora.snapshot section\');',
  'const snapshot = decodeSnapshot(new Uint8Array(section));',
  'let exports_ = null; let memory = null; let resetGlobals = [];',
  'function instantiate() {',
  '  const next = new WebAssembly.Instance(module, {}).exports;',
  '  const boot = next[\'mem-alloc\'](snapshot.guest.length, 1);',
  '  new Uint8Array(next.memory.buffer, boot, snapshot.guest.length).set(snapshot.guest);',
  '  next.telora_snapshot_import(boot, snapshot.guest.length);',
  '  let restored = 0;',
  '  for (const [name, value] of snapshot.globals) {',
  '    const global = next[name];',
  '    if (global instanceof WebAssembly.Global) { global.value = value; restored += 1; }',
  '  }',
  '  if (restored === 0) throw new Error(\'snapshot restored no globals\');',
  '  exports_ = next; memory = next.memory;',
  '  next[\'reset-service\']();',
  '  // 复位基线：运行时契约要求每次请求前把 telora_reset_global_* 恢复到初始化后的值，',
  '  // 否则状态会在请求之间累积（长会话里表现为 guest trap：unreachable）。',
  '  resetGlobals = [];',
  '  for (const name of Object.keys(next)) {',
  '    const global = next[name];',
  '    if (name.indexOf(\'telora_reset_global_\') !== 0 || !(global instanceof WebAssembly.Global)) continue;',
  '    try { global.value = global.value; resetGlobals.push([name, global.value]); } catch (ignored) { }',
  '  }',
  '  return restored;',
  '}',
  'const restored = instantiate();',
  'function resetService() {',
  '  try { exports_[\'reset-service\'](); }',
  '  catch (ignored) { instantiate(); return; }',
  '  for (const [name, value] of resetGlobals) exports_[name].value = value;',
  '}',
  'function invoke(line) {',
  '  resetService();',
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
    // 只有**当前这一代**的死亡才能影响排队请求：被超时 terminate 的旧代，它的 exit
    // 事件会晚到，而那时 worker 已经指向新一代了——不设这道门槛就会误杀新一代的请求。
    created.on('error', (cause) => {
      log(`[oks] worker error: ${cause?.message ?? cause}`);
      if (worker !== created) return;
      worker = null;
      failAll(cause);
    });
    created.on('exit', (code) => {
      log(`[oks] worker exited with code ${code}`);
      if (worker !== created) return;
      worker = null;
      failAll(new Error(`wasm worker exited with code ${code}`));
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
      reject(new Error(`wasm request timed out after ${config.requestTimeoutMs} ms (worker terminated)`));
    }, config.requestTimeoutMs);
    pending.set(id, { resolve, reject, timer });
    worker.postMessage({ id, line });
  }).catch((cause) => {
    log(`[oks] worker request failed: ${cause?.message ?? cause}`);
    throw cause;
  });

  const dispose = () => {
    failAll(new Error('wasm worker was disposed'));
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

// 只读执行器的 worker 源码。放在 worker 里有两个理由：
//   1. node:sqlite 是同步 API，一条慢查询会卡死宿主线程（GUI 一起卡）；
//   2. 只有独立线程才能被超时 terminate。
// 双重保险：连接以只读打开，且只允许 SELECT / WITH 开头的语句。
const EXECUTOR_SOURCE = [
  "const { parentPort, workerData } = require('node:worker_threads');",
  "const { DatabaseSync } = require('node:sqlite');",
  'const READ_ONLY = /^\\s*(select|with)\\b/i;',
  'let db = null;',
  'function open() { db = new DatabaseSync(workerData.dataFile, { readOnly: true }); }',
  'function run(sql, bindings, maxRows) {',
  '  if (!READ_ONLY.test(sql)) throw new Error(\'only read-only SELECT/WITH statements are executed\');',
  '  if (db === null) open();',
  '  const rows = []; let truncated = false;',
  '  for (const row of db.prepare(sql).iterate(...bindings)) {',
  '    if (rows.length >= maxRows) { truncated = true; break; }',
  '    rows.push(row);',
  '  }',
  '  return { rows: rows, truncated: truncated };',
  '}',
  "parentPort.postMessage({ kind: 'ready' });",
  "parentPort.on('message', (message) => {",
  '  try {',
  '    const result = run(message.sql, message.bindings || [], message.maxRows);',
  "    parentPort.postMessage({ id: message.id, rows: result.rows, truncated: result.truncated });",
  '  } catch (cause) {',
  "    parentPort.postMessage({ id: message.id, error: String((cause && cause.message) || cause) });",
  '  }',
  '});',
].join('\n');

/** 只读查询执行器：一个数据文件一个 worker，超时 terminate 并复活。
 *  接口是 { send(sql, bindings, signal), dispose() }。 */
function createExecutor(config, log) {
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
    const created = new Worker(EXECUTOR_SOURCE, {
      eval: true,
      workerData: { dataFile: config.dataFile },
    });
    created.on('message', (message) => {
      if (message?.kind === 'ready') { log(`[oks] executor ready (read-only ${config.dataFile})`); return; }
      const entry = pending.get(message?.id);
      if (entry === undefined) return;
      pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error !== undefined) entry.reject(new Error(message.error));
      else entry.resolve({ rows: message.rows, truncated: message.truncated });
    });
    // 同模型宿主：晚到的旧代 exit 不能影响新一代的排队请求。
    created.on('error', (cause) => {
      log(`[oks] executor error: ${cause?.message ?? cause}`);
      if (worker !== created) return;
      worker = null;
      failAll(cause);
    });
    created.on('exit', (code) => {
      log(`[oks] executor exited with code ${code}`);
      if (worker !== created) return;
      worker = null;
      failAll(new Error(`sqlite executor exited with code ${code}`));
    });
    worker = created;
    return created;
  };

  const send = (sql, bindings, signal) => new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error('aborted')); return; }
    if (worker === null) spawn();
    const id = nextId; nextId += 1;
    const timer = setTimeout(() => {
      pending.delete(id);
      const dead = worker; worker = null;
      if (dead !== null) dead.terminate();
      reject(new Error(`query timed out after ${config.queryTimeoutMs} ms (executor terminated)`));
    }, config.queryTimeoutMs);
    pending.set(id, { resolve, reject, timer });
    worker.postMessage({ id, sql, bindings, maxRows: config.queryMaxRows });
  });

  const dispose = () => {
    failAll(new Error('sqlite executor was disposed'));
    const dead = worker; worker = null;
    if (dead !== null) dead.terminate();
  };

  return { send, dispose };
}

/** 数据目录里的清单（若在）：只取两处声明——数据窗口与来源 revision。
 *  两处都按"有就用、没有就算了"处理，缺字段不影响查询。 */
function readDataManifest(dataFile) {
  try {
    const manifest = JSON.parse(readFileSync(join(dirname(dataFile), 'manifest.json'), 'utf8'));
    if (manifest === null || typeof manifest !== 'object') return null;
    const window = manifest.window;
    const hasWindow = window !== null && typeof window === 'object'
      && typeof window.start === 'string' && typeof window.endExclusive === 'string';
    return {
      window: hasWindow ? { start: window.start, endExclusive: window.endExclusive } : null,
      revision: typeof manifest.revision === 'string' ? manifest.revision : null,
    };
  } catch {
    return null;
  }
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
    const parts = ['error=false', `accepted=${ok.accepted}`, `errors=${errors}`, `warnings=${warnings}`];
    // 校验路径会把 queries 摘掉（那是 SQL/bindings），所以这里只在真的有 queries 时才报数量。
    if (Array.isArray(ok.queries)) parts.push(`queries=${ok.queries.length}`);
    return parts.join(' · ');
  }
  return 'error=false';
}

/** 校验路径的响应：**摘掉 queries**。SQL/bindings 只在 oks_query 的结果里出现，
 *  而轨迹里的响应会被工具卡与宿主日志留存，所以这里必须真的摘掉，不能只靠渲染不打印。 */
function withoutQueries(response) {
  const ok = response?.ok;
  if (ok === null || typeof ok !== 'object') return response;
  const { queries: _queries, ...rest } = ok;
  return { ...response, ok: rest };
}

/** 过程轨迹：让工具卡自己呈现「发了什么、收回了什么」。
 *  请求回显只留一小段——Intent 批次可能很长，而写它的人正是读它的模型。 */
function renderTrace(trace) {
  const lines = [];
  for (const step of trace ?? []) {
    const note = step.note ? `  （${step.note}）` : '';
    lines.push(`▸ OKS ${step.method}${note}`);
    lines.push(`  请求 ${capLine(JSON.stringify(step.request), REQUEST_DISPLAY_CHARS)}`);
    lines.push(`◂ OKS ${step.method}  ${summarize(step.response)}`);
  }
  return lines;
}

/** 纯计算类工具（不经过 OKS）的渲染：直接给结构化结果。 */
function renderValue(_args, value) {
  return [{ type: 'text', text: `${JSON.stringify(value, null, 2)}\n` }];
}

/** 渲染不做形状分类：同一套 JSON 通道对任何节点都成立。 */
function renderJson(_args, value) {
  const lines = renderTrace(value?.trace);
  lines.push('', JSON.stringify(value?.trace?.[0]?.response ?? value, null, 2));
  return [{ type: 'text', text: `${lines.join('\n')}\n` }];
}

/** 诊断段：批次级诊断必须全列——成功的 Intent 也可能带 Warning。 */
function diagnosticLines(diagnostics) {
  const lines = [];
  if (!Array.isArray(diagnostics) || diagnostics.length === 0) return lines;
  lines.push('', '诊断（批次级；成功的 Intent 也可能带 Warning）');
  for (const item of diagnostics) {
    const severity = item?.diagnostic?.severity ?? '?';
    const mark = severity === 'Error' ? '✕' : severity === 'Warning' ? '⚠' : '·';
    lines.push(`  #${(item?.index ?? 0) + 1}  ${mark} ${severity} — ${item?.diagnostic?.message ?? JSON.stringify(item)}`);
  }
  return lines;
}

const rejectedIndexes = (diagnostics) => [...new Set((diagnostics ?? [])
  .filter((item) => item?.diagnostic?.severity === 'Error')
  .map((item) => item.index))].sort((left, right) => left - right);

/** oks_check_intent 的模型可见渲染：只有校验结论与诊断，**没有 SQL**。 */
function renderCheck(_args, value) {
  const lines = renderTrace(value?.trace);
  const intents = value?.intents ?? [];
  lines.push(...diagnosticLines(value?.diagnostics));
  if (value?.subset) {
    lines.push('', `再校验一次（把没有报 Error 的 ${value.subset.indexes.length} 个 Intent 单独提交）：`
      + `${value.subset.accepted ? '通过' : '仍被拒'}`);
  }
  for (const index of rejectedIndexes(value?.diagnostics)) {
    lines.push('', `── intent #${index + 1} — 被拒绝 ──`);
    lines.push(`intent:   ${capLine(JSON.stringify(intents[index]), 600)}`);
  }
  const passed = intents.length - rejectedIndexes(value?.diagnostics).length;
  const runnable = value?.queryCount ?? 0;
  lines.push('', passed === intents.length
    ? `校验结论：${intents.length} 个 Intent 全部可用（${runnable} 个查询可执行）。用 oks_query 提交同一批就能拿到结果。`
    : `校验结论：${passed}/${intents.length} 可用（${runnable} 个查询可执行）。用 oks_info 按服务给出的 key 读它声明的词汇再修，保持业务含义不变。`);
  return [{ type: 'text', text: `${lines.join('\n')}\n` }];
}

/** 一张有预算的表：列数、单元格长度、行数都受限，截断要写明。 */
function renderTable(rows, budget) {
  if (!Array.isArray(rows) || rows.length === 0) return { lines: ['结果：0 行'], truncated: false };
  const allColumns = Object.keys(rows[0] ?? {});
  const columns = allColumns.slice(0, RESULT_MAX_COLUMNS);
  const cell = (value) => {
    const text = value === null || value === undefined ? 'NULL'
      : typeof value === 'bigint' ? value.toString()
        : typeof value === 'object' ? JSON.stringify(value)
          : String(value);
    return (text.length > RESULT_MAX_CELL_CHARS ? `${text.slice(0, RESULT_MAX_CELL_CHARS)}…` : text)
      .replace(/\|/g, '\\|').replace(/\n/g, ' ');
  };
  const lines = [`| ${columns.join(' | ')} |`, `| ${columns.map(() => '---').join(' | ')} |`];
  let used = lines.reduce((total, line) => total + line.length + 1, 0);
  let shown = 0;
  let truncated = false;
  for (const row of rows) {
    const line = `| ${columns.map((column) => cell(row[column])).join(' | ')} |`;
    if (used + line.length > budget) { truncated = true; break; }
    lines.push(line);
    used += line.length + 1;
    shown += 1;
  }
  const notes = [];
  if (allColumns.length > columns.length) notes.push(`只显示前 ${columns.length} 列（共 ${allColumns.length} 列）`);
  if (truncated) notes.push(`只显示前 ${shown} 行（共 ${rows.length} 行）`);
  return { lines, truncated, notes };
}

/** oks_query 的模型可见渲染：轨迹 → 诊断 → 每个结果的 SQL/bindings 与行。 */
function renderQuery(_args, value) {
  const lines = renderTrace(value?.trace);
  let used = lines.reduce((total, line) => total + line.length + 1, 0);
  const push = (line) => { lines.push(line); used += line.length + 1; };
  for (const line of diagnosticLines(value?.diagnostics)) push(line);

  (value?.results ?? []).forEach((result, at) => {
    push('');
    push(`── 结果 #${at + 1}（来自 intent #${result.index + 1}）──`);
    push(`sql:      ${capLine(String(result.sql).replace(/\s+/g, ' '), SQL_DISPLAY_CHARS)}`);
    push(`bindings: ${capLine(JSON.stringify(result.bindings), BINDINGS_DISPLAY_CHARS)}`);
    if (result.error !== null && result.error !== undefined) {
      push(`执行失败（数据文件 ${basename(value.dataFile)}）：${result.error}`);
      return;
    }
    push(`执行：${result.rows.length} 行 · ${result.ms} ms`
      + `${result.truncated ? `（已到行数上限 ${value.queryMaxRows}，结果还有更多）` : ''}`);
    const table = renderTable(result.rows, Math.max(240, RESULT_BUDGET_CHARS - used));
    for (const line of table.lines) push(line);
    for (const note of table.notes ?? []) push(`（${note}）`);
    if (result.rows.length === 0 && value?.window) {
      push(`提示：这份数据的窗口是 [${value.window.start}, ${value.window.endExclusive})，被过滤掉的可能是时间落在窗口之外。`);
    }
  });

  const rejected = rejectedIndexes(value?.diagnostics);
  for (const index of rejected) {
    push('');
    push(`── intent #${index + 1} — 被拒绝 ──`);
    push(`intent:   ${capLine(JSON.stringify((value?.intents ?? [])[index]), 600)}`);
  }
  if ((value?.results ?? []).length === 0) {
    push('', rejected.length === 0
      ? '没有可执行的查询。'
      : '没有任何 Intent 通过校验，所以没有执行。修 Intent 后再提交。');
  }
  return [{ type: 'text', text: `${lines.join('\n')}\n` }];
}

// ── 检索层 ───────────────────────────────────────────────────────────────────
// 派生规则来自服务自己声明的**发现契约**：`<domain>/discovery` 返回可见的 Dataset /
// Relation 入口 key；消费方沿 `info` 的引用图（`node.links`，`Index` 另加
// `detail.schemas`）走完整个图，再把节点派生成词汇表与引用边。物理字段与基础类型不进
// 词汇表——它们的语义由维度与度量承载。任何一步对不上契约都直接报错，不静默降级。

const SEARCH_BUDGET_CHARS = 5600;
const REFERENCE_BUDGET_CHARS = 5600;
const FACET_DATASET_CHARS = 300;
// 工具面上的 kind 就是 key 前缀：与 agent 拼 key 时看到的字面一致（Type 而非 DataType）。
const TERM_KINDS = ['Dataset', 'Dimension', 'Measure', 'Relation', 'Type', 'Value'];
const REFERENCE_KINDS = ['Member', 'Traversable', 'Related'];

const normalize = (text) => String(text).replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
const tokenize = (text) => normalize(text).split(/[^0-9a-z\u4e00-\u9fff]+/).filter((token) => token !== '');
const uniqueText = (values) => [...new Set(values.filter((value) => typeof value === 'string' && value !== ''))];

/** 一个节点 → 一条词条。文本只取自节点自己声明的描述（summary/label/aliases、localized、terms）。 */
function deriveTerm(node) {
  const parts = node.key.split('/').map((part) => decodeURIComponent(part));
  const kind = parts[0];
  const name = parts[parts.length - 1];
  const detail = node.detail ?? {};
  const description = node.description ?? {};
  const localized = [...(description.localized ?? []), ...(detail.localized ?? [])];
  const terms = description.terms ?? [];
  const aliases = uniqueText([
    description.label,
    ...(description.aliases ?? []),
    ...localized.map((item) => item.label),
    ...terms.map((term) => term.term),
  ]).filter((alias) => alias !== name);
  const aliasDoc = (description.aliases ?? []).some((alias) => !terms.some((term) => term.term === alias))
    ? (description.summary || description.label)
    : '';
  const doc = uniqueText([
    description.summary,
    ...localized.map((item) => item.summary),
    ...terms.map((term) => term.description),
    aliasDoc,
  ]).join('\n');
  const entry = { key: node.key, kind, name, doc, aliases };
  if (kind === 'Dimension' || kind === 'Measure') entry.dataset = parts[1];
  if (kind === 'Value') entry.typeId = parts[1];
  // 关系的 naming 链是它两端的数据集，取自该节点自己声明的 from/to。
  if (kind === 'Relation' && typeof detail.from_dataset === 'string' && typeof detail.to_dataset === 'string') {
    entry.link = [detail.from_dataset, detail.to_dataset];
  }
  return entry;
}

/** 派生：词条 + 反向引用索引 + 已知 key 集合。断言保留自发现契约，走样时直接报错。
 *  这里只留下检索需要的东西；节点本身不保留——读节点始终由 oks_info 透传给服务。 */
function deriveIndex(nodes) {
  const byKey = new Map(nodes.map((node) => [node.key, node]));
  const revision = byKey.get('index')?.detail?.revision;
  if (typeof revision !== 'string') throw new Error('dsh-oks: 知识入口 index 没有声明 revision');
  const terms = [];
  const edges = new Map();
  for (const node of [...nodes].sort((left, right) => left.key.localeCompare(right.key, 'en'))) {
    for (const link of node.links) {
      if (!byKey.has(link.key)) throw new Error(`dsh-oks: 知识引用无法解析 ${node.key} → ${link.key}`);
      if (!REFERENCE_KINDS.includes(link.type)) throw new Error(`dsh-oks: 未知的引用种类 ${link.type}`);
      const edge = `${node.key}|${link.key}|${link.type}`;
      if (!edges.has(edge)) edges.set(edge, { source: node.key, target: link.key, link: link.type });
    }
    const kind = node.key.split('/')[0];
    if (!TERM_KINDS.includes(kind)) continue;
    // 基础类型（没有 storage 的 DataType）不是业务词条：它们由维度/度量承载。
    if (kind === 'Type' && typeof node.detail?.storage !== 'string') continue;
    terms.push(deriveTerm(node));
  }
  const linksByTarget = new Map();
  for (const edge of edges.values()) {
    if (!linksByTarget.has(edge.target)) linksByTarget.set(edge.target, []);
    linksByTarget.get(edge.target).push({ link: edge.link, source: edge.source });
  }
  const kindCounts = TERM_KINDS
    .map((kind) => [kind, terms.filter((term) => term.kind === kind).length])
    .filter(([, count]) => count > 0);
  const datasets = terms.filter((term) => term.kind === 'Dataset').map((term) => term.name).sort();
  return {
    revision,
    terms,
    keys: new Set(byKey.keys()),
    links: [...edges.values()],
    linksByTarget,
    facets: {
      kinds: kindCounts.map(([kind, count]) => `${kind} ${count}`).join(' · '),
      datasets: `${datasets.length} 个：${capLine(datasets.join(', '), FACET_DATASET_CHARS)}`,
    },
  };
}

/** 按发现契约爬完整个图并派生。首次检索时同步执行（同步阻塞，便于先跑通）。 */
async function buildRetrievalIndex(entry, sha, log) {
  const started = Date.now();
  const { domain } = entry.settings;
  const discovery = await entry.runner.send(`${domain}/discovery`, {});
  if (discovery?.error === true) {
    throw new Error(`dsh-oks: ${domain}/discovery 失败：`
      + `${discovery?.diagnostics?.[0]?.message ?? '未知错误'}；检索需要这条路由。`);
  }
  const roots = Array.isArray(discovery?.ok) ? discovery.ok : [];
  if (roots.length === 0) throw new Error(`dsh-oks: ${domain}/discovery 没有返回任何入口 key`);
  const pending = [...new Set(['index', ...roots])];
  const seen = new Set(pending);
  const nodes = [];
  for (const key of pending) {
    const response = await entry.runner.send(`${domain}/info`, { key });
    const node = response?.ok?.Document?.Found;
    if (node?.key !== key || !Array.isArray(node.links)) {
      throw new Error(`dsh-oks: 无法解析知识 key ${key}（发现契约要求每个入口都能取到节点）`);
    }
    nodes.push(node);
    for (const link of node.links) {
      if (typeof link?.key === 'string' && !seen.has(link.key)) {
        seen.add(link.key);
        pending.push(link.key);
      }
    }
    if (node.type === 'Index' && Array.isArray(node.detail?.schemas)) {
      for (const schema of node.detail.schemas) {
        if (typeof schema === 'string' && !seen.has(schema)) {
          seen.add(schema);
          pending.push(schema);
        }
      }
    }
  }
  const index = deriveIndex(nodes);
  log(`[oks] discovery index · ${index.revision} · ${sha.slice(0, 12)} · `
    + `${nodes.length} 节点 · ${index.terms.length} 词条 · ${index.links.length} 引用 · ${Date.now() - started} ms`);
  return index;
}

/** 一条词条 → 检索结果行（不含 key：agent 按声明的 key 模式自己拼）。 */
function termRow(term, field, score) {
  const row = { kind: term.kind, name: term.name, field, score };
  if (term.dataset !== undefined) row.dataset = term.dataset;
  if (term.typeId !== undefined) row.type_id = term.typeId;
  if (term.link !== undefined) row.link = term.link;
  return row;
}

const termOwner = (row) => (row.dataset !== undefined ? `[${row.dataset}]`
  : row.type_id !== undefined ? `[${row.type_id}]`
    : row.link !== undefined ? `[${row.link.join(' → ')}]` : '');
const termLine = (row) => {
  const owner = termOwner(row);
  return `${row.kind}  ${row.name}${owner === '' ? '' : `  ${owner}`}  ${row.field} ${row.score}`;
};

/** 匹配：对 name / aliases / doc 做模糊匹配（AND 全部查询词），报出命中的那一类。 */
function matchTerm(term, tokens, query) {
  const name = normalize(term.name);
  const aliasText = normalize(term.aliases.join(' '));
  const docText = normalize(term.doc);
  const all = `${name} ${aliasText} ${docText}`;
  if (!tokens.every((token) => all.includes(token))) return null;
  if (tokens.every((token) => name.includes(token))) return { field: 'name', score: name === query ? 1 : 0.9 };
  if (tokens.every((token) => aliasText.includes(token))) return { field: 'alias', score: 0.7 };
  if (tokens.every((token) => docText.includes(token))) return { field: 'doc', score: 0.5 };
  return { field: 'doc', score: 0.3 };
}

/** 检索：过滤 → 稳定排序 → 按字节装页。`skip` 是分页起点，`more` 是剩余条数。 */
function searchIndex(index, args) {
  const query = normalize(args?.query ?? '').trim();
  const kind = typeof args?.kind === 'string' && args.kind !== '' ? args.kind : null;
  const dataset = typeof args?.dataset === 'string' && args.dataset !== '' ? args.dataset : null;
  const skip = Number.isInteger(args?.skip) && args.skip > 0 ? args.skip : 0;
  if (kind !== null && !TERM_KINDS.includes(kind)) {
    throw new Error(`dsh-oks: kind 只能是 ${TERM_KINDS.join(' / ')}`);
  }
  const tokens = tokenize(query);
  const matched = [];
  for (const term of index.terms) {
    if (kind !== null && term.kind !== kind) continue;
    if (dataset !== null && term.dataset !== dataset) continue;
    if (tokens.length === 0) { matched.push({ term, field: 'all', score: 0 }); continue; }
    const hit = matchTerm(term, tokens, query);
    if (hit !== null) matched.push({ term, ...hit });
  }
  matched.sort((left, right) => right.score - left.score
    || left.term.kind.localeCompare(right.term.kind, 'en')
    || String(left.term.dataset ?? left.term.typeId ?? left.term.link?.join('/') ?? '')
      .localeCompare(String(right.term.dataset ?? right.term.typeId ?? right.term.link?.join('/') ?? ''), 'en')
    || left.term.name.localeCompare(right.term.name, 'en'));
  const total = matched.length;
  const page = matched.slice(skip);
  const rows = [];
  let used = 0;
  for (const item of page) {
    const row = termRow(item.term, item.field, item.score);
    const size = termLine(row).length + 1;
    if (used + size > SEARCH_BUDGET_CHARS) break;
    used += size;
    rows.push(row);
  }
  const remaining = total - skip - rows.length;
  return { start: skip, total, more: remaining > 0 ? remaining : null, matched: rows, facets: index.facets };
}

/** 反向引用：`skip` 分页；未知 key 直接报错（区别于"没有任何引用"）。 */
function referencesOf(index, args) {
  const key = typeof args?.key === 'string' && args.key !== '' ? args.key : null;
  if (key === null) throw new Error('dsh-oks: oks_references 需要 key');
  const link = typeof args?.link === 'string' && args.link !== '' ? args.link : null;
  const kind = typeof args?.kind === 'string' && args.kind !== '' ? args.kind : null;
  const skip = Number.isInteger(args?.skip) && args.skip > 0 ? args.skip : 0;
  if (link !== null && !REFERENCE_KINDS.includes(link)) {
    throw new Error(`dsh-oks: link 只能是 ${REFERENCE_KINDS.join(' / ')}`);
  }
  if (kind !== null && !TERM_KINDS.includes(kind)) {
    throw new Error(`dsh-oks: kind 只能是 ${TERM_KINDS.join(' / ')}`);
  }
  if (!index.keys.has(key)) {
    throw new Error(`dsh-oks: ${key} 不是这个产物里的知识 key（用 oks_search 先找到 key）`);
  }
  const all = (index.linksByTarget.get(key) ?? [])
    .filter((reference) => link === null || reference.link === link)
    .filter((reference) => kind === null || reference.source.split('/')[0] === kind)
    .sort((left, right) => left.link.localeCompare(right.link, 'en') || left.source.localeCompare(right.source, 'en'));
  const total = all.length;
  const page = all.slice(skip);
  const rows = [];
  let used = 0;
  for (const reference of page) {
    const line = `${reference.link}  ${reference.source}`;
    if (used + line.length + 1 > REFERENCE_BUDGET_CHARS) break;
    used += line.length + 1;
    rows.push(reference);
  }
  const remaining = total - skip - rows.length;
  return { key, start: skip, total, more: remaining > 0 ? remaining : null, references: rows };
}

/** oks_search 的模型可见渲染：命中概况 + 一行一条（key 由 agent 按声明的模式拼）。 */
function renderSearch(_args, value) {
  const lines = [`命中 ${value.total} · 从 ${value.start} 起显示 ${value.matched.length} 条`
    + `${value.more === null ? '（已到底）' : ` · 还有 ${value.more}`}`];
  if (value.matched.length === 0) {
    lines.push('', '没有匹配。可用的 kind：' + value.facets.kinds, '可用的 dataset：' + value.facets.datasets,
      '换个说法，或用 kind= / dataset= 收窄。');
  } else {
    for (const row of value.matched) lines.push(termLine(row));
    lines.push('', '用 index 里声明的 key 模式把 kind/name[/owner] 拼成 key，再用 oks_info 读节点。');
  }
  return [{ type: 'text', text: `${lines.join('\n')}\n` }];
}

/** oks_references 的模型可见渲染：谁引用了这个 key（`link` 是引用种类）。 */
function renderReferences(_args, value) {
  const lines = [`引用 ${value.key} 的共 ${value.total} 条 · 从 ${value.start} 起显示 ${value.references.length} 条`
    + `${value.more === null ? '（已到底）' : ` · 还有 ${value.more}`}`];
  if (value.references.length === 0) lines.push('', '没有任何节点引用它。');
  else for (const row of value.references) lines.push(`${row.link}  ${row.source}`);
  return [{ type: 'text', text: `${lines.join('\n')}\n` }];
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
  // 时读一次并按会话记下，供两个时间工具取用；取不到就报错，让 agent 去问用户。
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

  // 插件不认识模型：设置与 wasm 宿主都在**第一次用到某个工作区**时按那份 oks.json 惰性建立；
  // 一个进程里可以有任意多个工作区，互不影响。
  const workspaces = new Map(); // root -> entry
  // 执行器按**数据文件**持有：同一个数据文件被多个工作区声明时共享一个只读连接。
  const executors = new Map(); // dataFile -> { executor, manifest }

  const executorFor = (settings) => {
    if (typeof settings.dataFile !== 'string' || settings.dataFile.length === 0) {
      throw new Error(
        `dsh-oks: ${settings.workspaceFile} 没有声明 dataFile，oks_query 无处可查。`
        + '需要 {"dataFile":"<相对 oks.json 的 .sqlite 路径>"}；'
        + '只做校验可以用 oks_check_intent。',
      );
    }
    const existing = executors.get(settings.dataFile);
    if (existing !== undefined) return existing;
    if (!existsSync(settings.dataFile)) {
      throw new Error(
        `dsh-oks: ${settings.workspaceFile} 声明的 dataFile 不存在：${settings.dataFile}`,
      );
    }
    const manifest = readDataManifest(settings.dataFile);
    const entry = { executor: createExecutor(settings, log), manifest };
    executors.set(settings.dataFile, entry);
    log(`[oks] read-only executor for ${settings.dataFile}`
      + `${manifest?.revision ? ` · data revision=${manifest.revision}` : ''}`
      + `${manifest?.window ? ` · window=[${manifest.window.start}, ${manifest.window.endExclusive})` : ''}`);
    return entry;
  };

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
      index: null, // 检索层：词汇表 + 反向引用索引
    };
    workspaces.set(root, entry);
    log(`[oks] workspace ${root} (cwd from ${from}) · domain=${settings.domain} · model=${settings.artifact}`);
    entry.runner = createRunner(settings, log);
    return entry;
  };

  // 词汇表与引用图按**产物**持有：同一份产物被多个工作区、多个会话声明时只派生一次。
  // 身份用 artifact_sha256（revision 字符串在两次不同构建之间可能不变，不能当身份）。
  const indexes = new Map(); // artifact sha256 -> index

  /** 惰性同步建立检索层：第一次检索时执行，之后按产物哈希复用。 */
  const ensureIndex = async (entry) => {
    if (entry.index !== null) return entry.index;
    const sha = createHash('sha256').update(readFileSync(entry.settings.artifact)).digest('hex');
    const shared = indexes.get(sha);
    if (shared !== undefined) {
      entry.index = shared;
      return shared;
    }
    const index = await buildRetrievalIndex(entry, sha, log);
    indexes.set(sha, index);
    entry.index = index;
    return index;
  };

  /** 降一批 Intent。服务只在整批通过时才回 queries，所以被拒批次里没有报 Error 的子集
   *  会再提交一次——这样"5 个里坏了 1 个"仍能拿到其余 4 个的执行物。 */
  const lowerBatch = async (entry, intents, signal) => {
    const method = `${entry.settings.domain}/transform`;
    const trace = [];
    const response = await entry.runner.send(method, { intents }, signal);
    trace.push({ method, request: { intents }, response });
    const diagnostics = Array.isArray(response?.ok?.diagnostics) ? response.ok.diagnostics : [];
    const errors = new Set(diagnostics
      .filter((item) => item?.diagnostic?.severity === 'Error')
      .map((item) => item.index));
    let batch = null;
    let subset = null;
    if (response?.ok?.accepted === true && Array.isArray(response?.ok?.queries)) {
      batch = { response, intents, indexes: intents.map((_intent, index) => index) };
    } else if (entry.settings.retryAcceptedSubset !== false) {
      const indexes = intents.map((_intent, index) => index).filter((index) => !errors.has(index));
      if (indexes.length > 0 && indexes.length < intents.length) {
        const subsetIntents = indexes.map((index) => intents[index]);
        const retry = await entry.runner.send(method, { intents: subsetIntents }, signal);
        trace.push({ method, request: { intents: subsetIntents }, response: retry, note: '仅未报 Error 的子集，再降一次' });
        const passed = retry?.ok?.accepted === true && Array.isArray(retry?.ok?.queries);
        subset = { indexes, accepted: passed };
        if (passed) batch = { response: retry, intents: subsetIntents, indexes };
      }
    }
    return { method, trace, response, diagnostics, batch, subset };
  };

  const arityError = (method, intents, toolName) => ({
    trace: [{
      method,
      request: { intents },
      response: { error: true, diagnostics: [{ message: `${toolName} requires one to five independent Intents` }] },
    }],
    intents,
    diagnostics: [{ index: 0, diagnostic: { severity: 'Error', message: `${toolName} requires one to five independent Intents` } }],
  });

  // 工具描述在注册时写死，此时还不知道任何工作区，所以文本里不出现领域名。
  // 设计约束：**这里也不写任何"地图长什么样"的假设**。工具描述只说协议（怎么打交道）
  // 与呈现（收到什么就原样给什么）；具体有哪些种类、入口、字段、格式、路由、分页，
  // 一律由服务自己的声明回答——模型换了形状，这里一行都不用改。
  const definitions = [
    {
      name: 'oks_info',
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
              response: { error: true, diagnostics: [{ message: 'oks_info needs a knowledge key' }] },
            }],
          };
        }
        const response = await entry.runner.send(method, request, exec?.signal);
        return { trace: [{ method, request, response }] };
      },
    },
    {
      name: 'oks_search',
      description: 'Find this workspace\'s knowledge vocabulary by name, alias or description and get what you need to address a node: its kind, its name, its owner, where the term matched and how well. Keys are not returned — compose the key with the pattern the service declares for that kind in index.detail.key_patterns, then read the node with oks_info. Use it when you know what a thing is called but not its key; narrow with kind= or dataset=, and page with skip=.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Words to look for in a term\'s name, aliases or description. Matching is case-insensitive and splits camelCase and separators; every word must appear somewhere in the term. Omit it to list everything the filters allow.',
          },
          kind: { type: 'string', enum: TERM_KINDS, description: 'Restrict to one kind of term.' },
          dataset: { type: 'string', description: 'Restrict to terms whose owner dataset is this one (dimensions and measures declare one).' },
          skip: { type: 'number', description: 'Start at this match (default 0). The response reports how many matches remain, so page with skip = start + matched.length.' },
        },
        additionalProperties: false,
      },
      output: { schema: OBJECT_OUTPUT, render: renderSearch },
      async execute(args, exec) {
        const entry = ensureWorkspace(exec);
        const index = await ensureIndex(entry);
        const result = searchIndex(index, args);
        log(`[oks] search query=${JSON.stringify(args?.query ?? '')} kind=${args?.kind ?? '-'}`
          + ` dataset=${args?.dataset ?? '-'} skip=${result.start} → ${result.total} 命中 · 返回 ${result.matched.length}`
          + `${result.more === null ? '' : ` · 还有 ${result.more}`}`);
        return result;
      },
    },
    {
      name: 'oks_references',
      description: 'List what references a knowledge key, from the reference graph the plugin derives when the vocabulary is built. Each row names the reference kind and the referencing node\'s key, so you can read that node with oks_info or follow it further. Use it to see where a measure, dimension, type or dataset is used before you change how you address it.',
      parameters: {
        type: 'object',
        properties: {
          key: {
            type: 'string',
            description: 'A knowledge key that exists in this artifact — composed from the declared key patterns, or taken verbatim from what a node returned.',
          },
          link: { type: 'string', enum: REFERENCE_KINDS, description: 'Restrict to one reference kind.' },
          kind: { type: 'string', enum: TERM_KINDS, description: 'Restrict to referencing nodes of one kind.' },
          skip: { type: 'number', description: 'Start at this reference (default 0).' },
        },
        required: ['key'],
        additionalProperties: false,
      },
      output: { schema: OBJECT_OUTPUT, render: renderReferences },
      async execute(args, exec) {
        const entry = ensureWorkspace(exec);
        const index = await ensureIndex(entry);
        const result = referencesOf(index, args);
        log(`[oks] references key=${result.key} link=${args?.link ?? '-'} kind=${args?.kind ?? '-'}`
          + ` skip=${result.start} → ${result.total} 条 · 返回 ${result.references.length}`);
        return result;
      },
    },
    {
      name: 'oks_check_intent',
      description: 'Validate one to five independent graph Intents against this workspace\'s knowledge model and report the diagnostics. Nothing is executed and no query text comes back — this is the cheap way to find out whether a batch is acceptable. All Intents are checked even if one fails, and the subset without Error diagnostics is checked again so a partially bad batch still tells you which members are good. On rejection, read the diagnostics and repair the Intent with its business meaning intact.',
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
      output: { schema: OBJECT_OUTPUT, render: renderCheck },
      async execute(args, exec) {
        const entry = ensureWorkspace(exec);
        const intents = Array.isArray(args?.intents) ? args.intents : [];
        const method = `${entry.settings.domain}/transform`;
        if (intents.length < 1 || intents.length > 5) return arityError(method, intents, 'oks_check_intent');
        const { trace, response, diagnostics, batch, subset } = await lowerBatch(entry, intents, exec?.signal);
        return {
          trace: trace.map((step) => ({ ...step, response: withoutQueries(step.response) })),
          intents,
          accepted: response?.ok?.accepted === true,
          diagnostics,
          subset,
          queryCount: Array.isArray(batch?.response?.ok?.queries) ? batch.response.ok.queries.length : 0,
        };
      },
    },
    {
      name: 'oks_query',
      description: 'Answer a business question from this workspace\'s data: validate one to five independent graph Intents, then run the accepted ones as read-only queries against the data file the workspace declares, returning the rows together with the statement and bindings that produced them. A rejected Intent returns diagnostics instead of rows. Use oks_check_intent first when you only want to iterate on the Intent shape.',
      parameters: {
        type: 'object',
        properties: {
          intents: {
            type: 'array',
            description: 'One to five independent graph Intents, same shape as oks_check_intent accepts.',
            items: { type: 'object', additionalProperties: true },
          },
        },
        required: ['intents'],
        additionalProperties: false,
      },
      output: { schema: OBJECT_OUTPUT, render: renderQuery },
      async execute(args, exec) {
        const entry = ensureWorkspace(exec);
        const intents = Array.isArray(args?.intents) ? args.intents : [];
        const method = `${entry.settings.domain}/transform`;
        if (intents.length < 1 || intents.length > 5) {
          return { ...arityError(method, intents, 'oks_query'), results: [], dataFile: entry.settings.dataFile ?? null };
        }
        const { trace, response, diagnostics, batch } = await lowerBatch(entry, intents, exec?.signal);
        const answers = {
          trace,
          intents,
          accepted: response?.ok?.accepted === true,
          diagnostics,
          results: [],
          dataFile: entry.settings.dataFile ?? null,
          window: null,
          queryMaxRows: entry.settings.queryMaxRows,
        };
        if (batch === null) return answers;

        const { executor, manifest } = executorFor(entry.settings);
        answers.window = manifest?.window ?? null;
        const queries = batch.response?.ok?.queries ?? [];
        for (let at = 0; at < queries.length; at += 1) {
          const query = queries[at];
          const index = batch.indexes[at] ?? at;
          const sql = String(query?.sql ?? '');
          const bindings = Array.isArray(query?.bindings) ? query.bindings : [];
          const started = Date.now();
          try {
            const outcome = await executor.send(sql, bindings, exec?.signal);
            const ms = Date.now() - started;
            answers.results.push({
              index, sql, bindings, rows: outcome.rows, truncated: outcome.truncated, error: null, ms,
            });
            // 执行留痕进宿主日志：模型可见面之外唯一能查到"跑了什么"的地方。
            log(`[oks] query intent#${index + 1} → ${outcome.rows.length}${outcome.truncated ? '+' : ''} row(s)`
              + ` · ${ms} ms · sql=${capLine(sql.replace(/\s+/g, ' '), 200)}`
              + ` · bindings=${capLine(JSON.stringify(bindings), 200)}`);
          } catch (cause) {
            const ms = Date.now() - started;
            const message = String(cause?.message ?? cause);
            answers.results.push({ index, sql, bindings, rows: null, truncated: false, error: message, ms });
            log(`[oks] query intent#${index + 1} failed after ${ms} ms: ${message}`);
          }
        }
        return answers;
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
            description: 'IANA time zone such as "Asia/Shanghai". By default the zone comes from the request context — the browser zone the client attached to the current turn messages, read per the plugin spec — so pass one only to override it (for example when the context zone is mixed or missing). The zone comes from the request context or from this argument; with neither, the call fails and asks you to confirm it with the user. The source actually used is echoed back.',
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
            description: 'IANA time zone such as "Asia/Shanghai". By default the zone comes from the request context — the browser zone the client attached to the current turn messages, read per the plugin spec — so pass one only to override it (for example when the context zone is mixed or missing). The zone comes from the request context or from this argument; with neither, the call fails and asks you to confirm it with the user. The source actually used is echoed back.',
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

  // 卸载时把每个工作区的 wasm 宿主与每个数据文件的执行器都关掉。
  ctx.effect(() => () => {
    for (const entry of workspaces.values()) {
      try {
        entry.runner?.dispose();
      } catch { /* 尽量都关掉，不让一个失败挡住其余 */ }
    }
    workspaces.clear();
    for (const entry of executors.values()) {
      try {
        entry.executor?.dispose();
      } catch { /* 同上 */ }
    }
    executors.clear();
  });
}
