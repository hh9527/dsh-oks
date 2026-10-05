// dsh-oks —— DSH 能力扩展：把"某个领域的知识服务（OKS）"接成七个原生工具。
// 插件不认识任何模型：开放哪个模型、模型在哪，由**会话所在工作区**根目录的 oks.json 声明
// （{"domain":"...","artifact":"...wasm","dataFile":"...sqlite"}）。
// 工作区是会话属性，所以一份插件能服务任意多工作区。
//
// 七个工具：oks_search（按名词/说法在词汇表里找到 key）、
// oks_references（按 key 反向找到引用它的节点）、
// oks_vocabulary（把整份词汇按 key 顺序分页交出，交给词汇助手做说法对照）、
// oks_info（按服务给出的不透明 key 读节点，入口是 key "index"）、
// oks_check_intent（只校验结构化 Intent，只回诊断）、
// oks_query（校验后**只读查询**数据文件，回结果；SQL/bindings 只在这一条路径上出现）。
// 外加两个与模型无关的辅助工具：time_now（当前时刻的各种标准表示）、
// time_calc（日历代数：加减 / 对齐到日历边界 / 换时区）——服务不读时钟，相对时间
// 必须在提交前换成绝对边界；这两个工具只做标准表示，不解释任何领域格式。
// 第七个是 va_ask：咨询一个**词汇助手**——插件自己建（顶层 agent，同工作区、同 preset）、
// 自己喂（角色与读法 → 回答方法 → 预热问题）、自己收（每次拿到回答后把问答从模型可见表面
// 收回到标记点）；助手每轮只看到「词汇 + 方法 + 标记 + 当前这个问题」，会话日志保持 append-only。
//
// 词汇表与引用图：第一次用到检索时（三个检索出口都用这一份），插件按服务声明的**发现契约**
// （`<domain>/discovery` 声明 revision、入口 roots、每类 key 的 key 模式，以及哪些 kind 进
// 词汇表、每类词条的归属字段与必须非空的字段；沿 `info` 的引用图走完，再在本地派生）在内存里
// 建好词汇表与反向引用索引，之后整个进程按产物的 artifact_sha256 复用。索引里只有词汇与
// 引用边，不含节点内容——读节点始终由 oks_info 透传给服务。它不写工作区、也不进模型上下文。
//
// **插件在工作区里不写任何东西**：没有计划文件、没有缓存产物。每次执行的 SQL、bindings、
// 行数与耗时写进宿主日志（ctx.logger），工作区保持干净。
//
// **代码里不写任何"地图长什么样"的假设**（有哪些种类、入口、字段、格式、路由、分页）：
// 那些是服务自己的声明，由 agent 按 key 自主探索。唯一的例外是服务自己声明的消费契约
// ——发现契约（入口、key 模式、词汇表）；检索层照它派生，对不上时直接报错，不静默降级。
//
// 零依赖：直接注册原始工具定义，因此装在 profile 里或从工作区加载都不会有模块解析问题；
// 查询用 Node 自带的 node:sqlite（只读打开）。parameters 只用受支持的 JSON Schema
// 关键字子集，数量校验放在 execute 里。

import { createHash, randomUUID } from 'node:crypto';
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
// 派生规则来自服务自己声明的**发现契约**：`<domain>/discovery` 返回 `revision`、入口
// `roots`、每类 key 的 `key_patterns`，以及 `vocabulary`——哪些 kind 进词汇表、每类词条的
// 归属字段（`owner`，既是 detail 字段名也是 key 模式里的占位符名）与必须非空的字段
// （`require`）。消费方沿 `info` 的引用图（`node.links`，`Index` 另加 `detail.schemas`）
// 走完整个图，再按 vocabulary 把节点派生成词汇表与引用边：不在 vocabulary 里的 kind
// 不进词汇表，即使它有声明的 key 模式。任何一步对不上契约都直接报错。

const SEARCH_BUDGET_CHARS = 5600;
const REFERENCE_BUDGET_CHARS = 5600;
// 词汇表出口：整页（首行 + 词条行 + 页脚）的 UTF-8 字节数留在 6000 以内，装页时先扣掉
// 首行与页脚的余量。按字节算是因为页里会有中文 alias/doc——同一个页在字符口径下只会更小。
const VOCABULARY_BUDGET_BYTES = 6000;
const VOCABULARY_HEADROOM_BYTES = 240;
const VOCABULARY_ENTRY_BUDGET_BYTES = VOCABULARY_BUDGET_BYTES - VOCABULARY_HEADROOM_BYTES;
// 一条词条的说明最多给这么多字符：一页要装下尽量多的词条，doc 是补充不是主体。
const VOCABULARY_DOC_CHARS = 200;
const FACET_DATASET_CHARS = 300;
const REFERENCE_KINDS = ['Member', 'Traversable', 'Related'];

const normalize = (text) => String(text).replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
const tokenize = (text) => normalize(text).split(/[^0-9a-z\u4e00-\u9fff]+/).filter((token) => token !== '');
const uniqueText = (values) => [...new Set(values.filter((value) => typeof value === 'string' && value !== ''))];
const oneLineText = (text) => String(text).replace(/\s+/g, ' ').trim();

/** 一个节点 → 一条词条。成员资格、归属与文本一律来自发现契约与节点自己的声明：
 *  `declaration` 是已确认包含该 kind 的那条 vocabulary 项。文本只取自节点自己声明的
 *  描述（summary/label/aliases、localized、terms）。 */
function deriveTerm(node, declaration) {
  const parts = node.key.split('/').map((part) => decodeURIComponent(part));
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
  // `key` 只为确定顺序（词汇表出口按它排序）；检索出口不回 key，由 agent 按声明模式自己拼。
  const entry = { key: node.key, kind: declaration.kind, name, doc, aliases, owner: null, ownerValue: null };
  // 归属：声明了 owner 就取同名 detail 字段，输出行里也用这个字段名。
  if (typeof declaration.owner === 'string' && detail[declaration.owner] != null) {
    entry.owner = declaration.owner;
    entry.ownerValue = detail[declaration.owner];
  }
  return entry;
}

/** 派生：词条 + 反向引用索引 + 已知 key 集合。断言保留自发现契约，走样时直接报错。
 *  这里只留下检索需要的东西；节点本身不保留——读节点始终由 oks_info 透传给服务。 */
function deriveIndex(nodes, contract) {
  const byKey = new Map(nodes.map((node) => [node.key, node]));
  const byKind = new Map(contract.vocabulary.map((item) => [item.kind, item]));
  const terms = [];
  const edges = new Map();
  for (const node of [...nodes].sort((left, right) => left.key.localeCompare(right.key, 'en'))) {
    for (const link of node.links) {
      if (!byKey.has(link.key)) throw new Error(`dsh-oks: 知识引用无法解析 ${node.key} → ${link.key}`);
      if (!REFERENCE_KINDS.includes(link.type)) throw new Error(`dsh-oks: 未知的引用种类 ${link.type}`);
      const edge = `${node.key}|${link.key}|${link.type}`;
      if (!edges.has(edge)) edges.set(edge, { source: node.key, target: link.key, link: link.type });
    }
    const declaration = byKind.get(node.key.split('/')[0]);
    if (declaration === undefined) continue; // 不在词汇表里的 kind：有 key 模式也不是词条
    if (declaration.require != null && (node.detail ?? {})[declaration.require] == null) continue;
    terms.push(deriveTerm(node, declaration));
  }
  const linksByTarget = new Map();
  for (const edge of edges.values()) {
    if (!linksByTarget.has(edge.target)) linksByTarget.set(edge.target, []);
    linksByTarget.get(edge.target).push({ link: edge.link, source: edge.source });
  }
  const kindCounts = contract.vocabulary
    .map((item) => [item.kind, terms.filter((term) => term.kind === item.kind).length])
    .filter(([, count]) => count > 0);
  const datasets = [...new Set(terms
    .filter((term) => term.owner === 'dataset')
    .map((term) => String(term.ownerValue)))].sort();
  return {
    revision: contract.revision,
    terms,
    keys: new Set(byKey.keys()),
    vocabKinds: contract.vocabulary.map((item) => item.kind),
    patterns: new Map(contract.keyPatterns.map((item) => [item.kind, item.pattern])),
    links: [...edges.values()],
    linksByTarget,
    facets: {
      kinds: kindCounts.map(([kind, count]) => `${kind} ${count}`).join(' · '),
      datasets: `${datasets.length} 个：${capLine(datasets.join(', '), FACET_DATASET_CHARS)}`,
    },
  };
}

/** 请求了不在词汇表里的 kind 时，把"可发现性"讲清楚：词汇表收录哪些、哪些只是有 key 模式。 */
function kindError(index, kind, where) {
  const available = index.vocabKinds.join(' / ');
  const pattern = index.patterns.get(kind);
  if (pattern === undefined) {
    return new Error(`dsh-oks: ${where} 的 kind ${kind} 不存在：发现契约的 key 模式与词汇表里都没有它。`
      + `词汇表收录的 kind：${available}。`);
  }
  return new Error(`dsh-oks: ${where} 的 kind ${kind} 不可检索：它有声明的 key 模式 ${pattern}，`
    + `但不属这个产物的词汇表；这类 key 从节点自身的引用里得到（oks_info / oks_references）。`
    + `词汇表收录的 kind：${available}。`);
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
  const ok = discovery?.ok;
  if (ok === null || typeof ok !== 'object' || Array.isArray(ok)) {
    throw new Error(`dsh-oks: ${domain}/discovery 没有返回发现契约`
      + '（ok 需要 {revision, roots, key_patterns, vocabulary}）。');
  }
  if (!Array.isArray(ok.roots)) {
    throw new Error(`dsh-oks: ${domain}/discovery 没有声明入口 roots（发现契约的 roots 是入口 key 的数组）`);
  }
  if (!Array.isArray(ok.vocabulary)) {
    throw new Error(`dsh-oks: ${domain}/discovery 没有声明 vocabulary`
      + '（发现契约用 vocabulary 声明哪些 kind 进词汇表，以及每类词条的 owner 与 require）');
  }
  if (typeof ok.revision !== 'string' || ok.revision === '') {
    throw new Error(`dsh-oks: ${domain}/discovery 没有声明 revision`);
  }
  for (const item of ok.vocabulary) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)
      || typeof item.kind !== 'string' || item.kind === '') {
      throw new Error(`dsh-oks: ${domain}/discovery 的 vocabulary 里有不合法的条目`
        + '（每条需要 kind，可带 owner / require）');
    }
    for (const field of ['owner', 'require']) {
      const value = item[field];
      if (value !== undefined && value !== null && (typeof value !== 'string' || value === '')) {
        throw new Error(`dsh-oks: ${domain}/discovery 的 vocabulary 里 ${item.kind} 的 ${field} 不是字段名`);
      }
    }
  }
  const keyPatterns = Array.isArray(ok.key_patterns)
    ? ok.key_patterns.filter((item) => item !== null && typeof item === 'object' && typeof item.kind === 'string')
    : [];
  const roots = ok.roots;
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
  const index = deriveIndex(nodes, { revision: ok.revision, vocabulary: ok.vocabulary, keyPatterns });
  log(`[oks] discovery index · ${index.revision} · ${sha.slice(0, 12)} · `
    + `${nodes.length} 节点 · ${index.terms.length} 词条 · ${index.links.length} 引用 · ${Date.now() - started} ms`);
  return index;
}

/** 一条词条 → 检索结果行（不含 key：agent 按声明的 key 模式自己拼）。
 *  词条声明了 owner 时，行里用 owner 这个名字作字段。 */
function termRow(term, field, score) {
  const row = { kind: term.kind, name: term.name, field, score };
  if (term.owner !== null) row[term.owner] = term.ownerValue;
  return row;
}

// 行里除协议字段外至多一个字段——它是该词条的归属，字段名由词汇表声明。
const ROW_FIELDS = new Set(['kind', 'name', 'field', 'score']);
const termOwner = (row) => {
  for (const [name, value] of Object.entries(row)) if (!ROW_FIELDS.has(name)) return `[${value}]`;
  return '';
};
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
  if (kind !== null && !index.vocabKinds.includes(kind)) throw kindError(index, kind, 'oks_search');
  const tokens = tokenize(query);
  const matched = [];
  for (const term of index.terms) {
    if (kind !== null && term.kind !== kind) continue;
    if (dataset !== null && !(term.owner === 'dataset' && String(term.ownerValue) === dataset)) continue;
    if (tokens.length === 0) { matched.push({ term, field: 'all', score: 0 }); continue; }
    const hit = matchTerm(term, tokens, query);
    if (hit !== null) matched.push({ term, ...hit });
  }
  matched.sort((left, right) => right.score - left.score
    || left.term.kind.localeCompare(right.term.kind, 'en')
    || String(left.term.ownerValue ?? '').localeCompare(String(right.term.ownerValue ?? ''), 'en')
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
  if (kind !== null && !index.vocabKinds.includes(kind)) throw kindError(index, kind, 'oks_references');
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

/** 一条词条 → 词汇表出口的一条：kind / name / aliases / doc，声明了 owner 就带 owner 字段。
 *  aliases 全给（它是这个出口的主要价值）；doc 是给"区分同名词条"用的，截到 DOC_CHARS。 */
function vocabularyEntry(term) {
  const entry = {
    kind: term.kind,
    name: term.name,
    aliases: term.aliases,
    doc: capLine(oneLineText(term.doc), VOCABULARY_DOC_CHARS),
  };
  if (term.owner !== null) entry[term.owner] = term.ownerValue;
  return entry;
}

// 词条里除协议字段外至多一个字段——它是该词条的归属，字段名由词汇表声明。
const VOCABULARY_FIELDS = new Set(['kind', 'name', 'aliases', 'doc']);
const vocabularyOwner = (entry) => {
  for (const [name, value] of Object.entries(entry)) if (!VOCABULARY_FIELDS.has(name)) return `[${value}]`;
  return '';
};

/** 词条行：` · ` 连接的 kind / name / [owner] / 全部 aliases。aliases 为空时 doc 是唯一能
 *  区分它的文本，再附一行。装页与渲染用的是同一份行，所以"整条截止"不会截到半条。 */
function vocabularyEntryLines(entry) {
  const parts = [entry.kind, entry.name];
  const owner = vocabularyOwner(entry);
  if (owner !== '') parts.push(owner);
  parts.push(...entry.aliases);
  const lines = [parts.join(' · ')];
  if (entry.aliases.length === 0 && entry.doc !== '') lines.push(`    ${entry.doc}`);
  return lines;
}

/** 整份词汇：按 key 排序（确定，翻页不重、不漏）→ 按字节装页（整条截止）。
 *  与检索不同，这里不筛不排：用途是把整份词汇原样交给词汇助手，而不是在工作会话里筛着看。 */
function vocabularyPage(index, args) {
  const skip = Number.isInteger(args?.skip) && args.skip > 0 ? args.skip : 0;
  const sorted = [...index.terms].sort((left, right) => left.key.localeCompare(right.key, 'en'));
  const total = sorted.length;
  const entries = [];
  let used = 0;
  for (const term of sorted.slice(skip)) {
    const entry = vocabularyEntry(term);
    const size = vocabularyEntryLines(entry)
      .reduce((sum, line) => sum + Buffer.byteLength(line, 'utf8') + 1, 0);
    if (used + size > VOCABULARY_ENTRY_BUDGET_BYTES) break;
    used += size;
    entries.push(entry);
  }
  const remaining = total - skip - entries.length;
  return { start: skip, total, more: remaining > 0 ? remaining : null, entries };
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

/** oks_vocabulary 的模型可见渲染：概况 + 一行一条。归属带方括号（与检索出口同一套写法），
 *  aliases 全给；没有 aliases 时才附 doc 行——那时它是唯一能区分这条词条的文本。 */
function renderVocabulary(_args, value) {
  const lines = [`共 ${value.total} 条 · 从 ${value.start} 起显示 ${value.entries.length} 条`
    + `${value.more === null ? '（已到底）' : ` · 还有 ${value.more}`}`];
  if (value.entries.length === 0) {
    lines.push('', value.total === 0
      ? '词汇表里没有词条。'
      : `skip=${value.start} 已越过末尾（共 ${value.total} 条）。`);
  } else {
    for (const entry of value.entries) lines.push(...vocabularyEntryLines(entry));
    if (value.more !== null) lines.push('', `下一页：skip=${value.start + value.entries.length}`);
  }
  return [{ type: 'text', text: `${lines.join('\n')}\n` }];
}

// ── 词汇助手（va）的工作台 ────────────────────────────────────────────────────
// 准备阶段三步：① 角色 + 怎么读 → 它回"读完了"；② 回答方法 → 它回"准备好了"；
// ③ 预热问题 → 它的回答（只为验证装配成功）。**标记就是第 ③ 步那个问题**，记住它的 seq。
//
// 此后每次咨询：插件把说法发过去、等到"我们那条消息"之后的回合结束、取回回答，然后把标记之后
// 的表面节点收进一个标记节点（rewind）。所以助手每轮看到的都是「词汇 + 方法 + 标记 + 这个问题」。
// 收起由插件主动做：拿到回答时助手是 idle，就顺手收；收不了（有回合在飞）就留到下一次提问之前补。
//
// 标记节点是一条**固定文本的用户消息**（与压缩用的形状相同）。这里不用空的 `system/message`：
// 那种形状会让这个子会话在冷恢复时续不上（同一个位置、同样一次收起，用户消息能续、空系统消息不能）。
//
// 会话日志保持 append-only：被收起的问答与标记节点都留在日志里，标记节点用 `sourceEventSeqs`
// 记录自己遮蔽了哪些表面节点——审计与回放都不受影响，也没有任何前缀被复制。

const VA_MARKER_TEXT = '（上文问答已收起）';
/** 助手会话的日志级标题前缀：归档列表里认得出、将来也按它找回。 */
const VA_TITLE_PREFIX = '词汇助手（内部）';

/** 准备阶段第 ③ 步的预热问题：答完就收起，只用来验证装配成功。默认值不含任何领域词，
 *  需要贴合某个领域时在 profile 的 config 里给 `vaWarmup`。 */
const VA_WARMUP_DEFAULT = '预热';

/** 进程级的检索层缓存：artifact sha256 -> 词汇表 + 反向引用索引。
 *  词汇助手是另一个 agent 作用域里的实例，它和主 agent 共用这一份，不重爬引用图。 */
const INDEX_BY_ARTIFACT = new Map();

/** 助手的专属人设：否则它会继承调用方 preset 的人设——编码 agent 与业务问答 agent 都不对。 */
const VA_PERSONA = '你是这个词表的词汇助手：提问者给一个说法（一个词、一个短语或一句话，中英不限），'
  + '你回答这份词表里有哪些等价或相近的表达、各差在哪一维。词表由你读进来，只读不改；'
  + '你不回答业务问题，也不碰文件。';

/** 词汇助手自己的两条提示词。装配时由插件直接发出去——不经过人，也不经过主 agent。 */
function readVaPrompt(name) {
  try {
    return readFileSync(new URL(`./va/${name}`, import.meta.url), 'utf8').trim();
  } catch (cause) {
    throw new Error(`dsh-oks: 读不到词汇助手的提示词 va/${name}：${cause?.message ?? cause}`);
  }
}

/** 收起之后替它们出面的标记节点。文本固定，所以它出现在哪一轮都不影响冻结前缀的缓存。 */
const vaMarker = () => ({
  id: randomUUID(),
  role: 'user',
  content: [{ type: 'text', text: VA_MARKER_TEXT }],
  source: { kind: 'user' },
});

/** `va_ask` 的模型可见渲染：把助手的回答原样交出。 */
function renderAsk(_args, value) {
  const lines = [];
  if (typeof value?.answer === 'string' && value.answer.length > 0) lines.push(value.answer);
  else lines.push('（词汇助手这一轮没有给出文本回答。）');
  if (value?.interrupted === true) lines.push('', '注意：这一轮被中断过，上面的回答可能不完整。');
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


  // ── va：词汇助手（顶层 agent，插件自己建、自己喂、自己收） ────────────────────
  // 助手不是子会话：它是 preset `oks` 下的一个**顶层 agent**，由插件持有句柄。这样回答只有
  // 一条通道（`va_ask` 的工具结果），没有父子投递，也就不会多出一份；它的会话平时处于
  // **归档**状态（分组界面不列、模型步被归档门挡住），只在被咨询时 unarchive。
  const VA_HELPER_PREFIX = 'session-va-';
  const vaPreset = typeof config?.vaPreset === 'string' && config.vaPreset.length > 0 ? config.vaPreset : 'oks';
  const vaBudgetMs = Number.isFinite(config?.vaAskTimeoutMs) && config.vaAskTimeoutMs > 0
    ? config.vaAskTimeoutMs
    : 600000;
  const vaWarmup = typeof config?.vaWarmup === 'string' && config.vaWarmup.trim().length > 0
    ? config.vaWarmup.trim()
    : VA_WARMUP_DEFAULT;
  const vaHelpers = new Map(); // 调用方 session id -> { sessionId, agent }
  // 模型可能在一个 step 里并行发两个 va_ask，所以三处都要合并：
  //  1) 装配按调用方 single flight——并发调用共享同一次在飞的装配，不会建出两个助手；
  //  2) 同一个说法的并发咨询也合并成一次，两边拿同一个回答；
  //  3) 不同说法才排队——一个助手会话一次只能答一个问题，混在一起会把 turn/end 认错。
  const vaFlights = new Map(); // 调用方 session id -> 正在装配的 promise
  const vaAskFlights = new Map(); // `${调用方}\0${说法}` -> 正在咨询的 promise
  const vaHelperChain = new Map(); // 助手 session id -> 咨询队列的尾（已吞掉拒绝）

  /** 把一次咨询挂到某个键的队尾；前一条失败不影响后一条。 */
  const vaSerialOn = (map, key, task) => {
    const previous = map.get(key) ?? Promise.resolve();
    const run = previous.then(task, task);
    const tail = run.then(() => {}, () => {});
    map.set(key, tail);
    void tail.then(() => { if (map.get(key) === tail) map.delete(key); });
    return run;
  };

  /** 一次在飞的操作：后来者共享同一个 promise；落地后从表里撤掉。 */
  const vaSingleFlight = (map, key, start) => {
    const inflight = map.get(key);
    if (inflight !== undefined) return inflight;
    const flight = start();
    map.set(key, flight);
    void flight.then(() => {}, () => {}).then(() => { if (map.get(key) === flight) map.delete(key); });
    return flight;
  };

  /** 插件自己写给助手的一条用户消息。 */
  const vaMessage = (text) => ({
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  });

  /** 边界不明的失败（取消 / 超时 / 回合没结束）：助手可能停在一个还在飞的回合上，
   *  用这个标记把它记下来，调用处据此把它丢掉、下次重建——否则后续咨询会排在那个回合后面一直等。 */
  const vaUnknownBoundary = (message) => {
    const error = new Error(message);
    error.vaDirty = true;
    return error;
  };

  /** 等**我们那条消息**真正落到助手的会话表面上，返回它的 seq。
   *  助手在忙时消息要排到下一个回合，所以不能拿"发之前"的位置当边界。 */
  const vaWaitMessage = async (session, messageId, signal, budgetMs, what) => {
    const deadline = Date.now() + budgetMs;
    for (;;) {
      if (signal?.aborted === true) throw vaUnknownBoundary('va_ask 被取消');
      const events = session.snapshotEvents();
      for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        if (event.type === 'user/message' && event.data?.id === messageId) return event.seq;
      }
      if (Date.now() > deadline) throw vaUnknownBoundary(`${what} 在 ${budgetMs} ms 内没有落到助手的会话里`);
      await new Promise((resolve) => { setTimeout(resolve, 150); });
    }
  };

  /** 等 afterSeq 之后的第一个回合结束。不用 `whenIdle()`——刚 followup 时驱动还没起来，它会立刻返回。 */
  const vaWaitTurnEndAfter = async (session, afterSeq, signal, budgetMs, what) => {
    const deadline = Date.now() + budgetMs;
    for (;;) {
      if (signal?.aborted === true) throw vaUnknownBoundary('va_ask 被取消');
      const events = session.snapshotEvents();
      for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        if (event.seq <= afterSeq) break;
        if (event.type === 'turn/end') return event.data?.reason ?? { kind: 'completed' };
      }
      if (Date.now() > deadline) throw vaUnknownBoundary(`${what} 在 ${budgetMs} ms 内没有结束`);
      await new Promise((resolve) => { setTimeout(resolve, 150); });
    }
  };

  /** 回合必须以 completed 收场——否则读词表读到一半、或回答是残的，都不能当成功。 */
  const vaRequireCompleted = (reason, what) => {
    if (reason?.kind !== undefined && reason.kind !== 'completed') {
      throw new Error(`dsh-oks: ${what}没有正常结束（${reason.kind}）。`);
    }
  };

  /** 发一条消息给助手并等它把那一轮跑完；返回我们这条消息落在哪个 seq。
   *  每发一条 `helper.pending += 1`，**观察到回合结束**才减回去——这是"没有未回应发送"的唯一依据：
   *  公开的 `agent.status` 在有投递排队时可能仍是 `idle`，拿它当依据会把还在等回答的问题收掉。 */
  const vaSendAndWait = async (helper, message, signal, budgetMs, what) => {
    const session = helper.agent.session;
    helper.pending += 1;
    helper.agent.followup(message);
    const sentSeq = await vaWaitMessage(session, message.id, signal, budgetMs, what);
    const reason = await vaWaitTurnEndAfter(session, sentSeq, signal, budgetMs, what);
    helper.pending -= 1;
    return { sentSeq, reason };
  };

  /** 从会话日志里取 sinceSeq 之后最后一条助手文本。 */
  const vaAnswerSince = (session, sinceSeq) => {
    const events = session.snapshotEvents();
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (event.seq < sinceSeq) break;
      if (event.type !== 'assistant/message') continue;
      const content = event.data?.message?.content ?? [];
      const text = content
        .filter((block) => block?.type === 'text')
        .map((block) => String(block.text ?? ''))
        .join('')
        .trim();
      if (text.length === 0) continue;
      return { text, interrupted: event.data?.interrupted === true };
    }
    return { text: '', interrupted: false };
  };

  /** 把 upToSeq 之后的表面节点收进一个标记节点——这就是 rewind。
   *  有内容的系统消息留在原地（折叠只走连续的非系统节点段），别把宿主的提示词收掉。 */
  const vaCollapse = (session, upToSeq) => {
    const nodes = session.surface?.nodes ?? [];
    const start = nodes.findIndex((seq) => seq > upToSeq);
    if (start === -1) return null;
    const after = nodes.slice(start);
    if (after.some((seq) => seq <= upToSeq)) return null;
    const isLiveSystem = (seq) => {
      const event = typeof session.eventAt === 'function' ? session.eventAt(seq) : undefined;
      if (event?.type !== 'system/message') return false;
      const content = event.data?.message?.content;
      return Array.isArray(content)
        && content.some((block) => block?.type === 'text' && String(block.text ?? '').length > 0);
    };
    const runs = [];
    let run = [];
    for (const seq of after) {
      if (isLiveSystem(seq)) {
        if (run.length > 0) runs.push(run);
        run = [];
        continue;
      }
      run.push(seq);
    }
    if (run.length > 0) runs.push(run);
    if (runs.length === 0) return null;
    let shadowed = 0;
    let startSeq = 0;
    let endSeq = 0;
    let markerSeq = 0;
    for (const range of runs) {
      startSeq = range[0];
      endSeq = range[range.length - 1];
      const marker = session.append('user/message', vaMarker(), {
        surfaceOp: { op: 'replace', startSeq, endSeq },
        sourceEventSeqs: range,
      });
      markerSeq = marker.seq;
      shadowed += range.length;
    }
    return { shadowed, runs: runs.length, startSeq, endSeq, markerSeq };
  };

  /** 助手手里没有未回应的发送（`pending === 0`）、也没有在飞的回合时，收起一次；
   *  条件不满足就等下一次（提问之前还会再试一次）。 */
  const vaTryRewind = (helper) => {
    try {
      if (helper?.pending !== 0) {
        // 只有 vaSendAndWait 会发消息、也只会在这里减回去；这个日志让计数漂移可见（漂移会静默停掉收起）。
        log(`[oks] rewind skipped · 还有 ${helper.pending} 条没被回答的发送`);
        return false;
      }
      if (helper?.agent?.status !== 'idle') return false;
      const done = vaCollapse(helper.agent.session, helper.markerSeq);
      if (done !== null) {
        // 标记往后挪到刚插入的那个节点：下一次没有新问答时，收起就是空操作，不会白插一轮标记。
        helper.markerSeq = done.markerSeq;
        log(`[oks] rewind · 收起 ${done.shadowed} 个表面节点（${done.runs} 段，seq ${done.startSeq}-${done.endSeq} → 标记 ${done.markerSeq}）`);
      }
      return true;
    } catch (cause) {
      log('[oks] rewind failed: ' + String(cause?.message ?? cause));
      return false;
    }
  };

  const vaArchive = async (sessionId) => {
    const registry = ctx.get('workspaceRegistry');
    if (typeof registry?.archiveSession !== 'function') return;
    try {
      await registry.archiveSession(sessionId, { stopActivity: true });
    } catch (cause) {
      log('[oks] cannot archive the vocabulary helper: ' + String(cause?.message ?? cause));
    }
  };

  const vaUnarchive = async (sessionId) => {
    const registry = ctx.get('workspaceRegistry');
    if (typeof registry?.unarchiveSession !== 'function') return;
    try {
      await registry.unarchiveSession(sessionId);
    } catch (cause) {
      log('[oks] cannot unarchive the vocabulary helper: ' + String(cause?.message ?? cause));
    }
  };

  /** 调用方的助手：没有就建一个顶层 agent，装配好（读词表 → 收方法 → 落边界）。
   *  并发调用共享这一次装配（single flight），不会各建一个。 */
  const vaEnsureHelper = (caller, key, signal) => vaSingleFlight(vaFlights, key, async () => {
    const existing = vaHelpers.get(key);
    if (existing !== undefined) return existing;
    const agents = ctx.get('agents');
    if (typeof agents?.create !== 'function') {
      throw new Error('dsh-oks: 这个组合里没有 agent 注册表（ctx.agents），va_ask 起不了词汇助手。');
    }
    const sessionId = `${VA_HELPER_PREFIX}${randomUUID()}`;
    const cwd = caller.session?.header?.cwd;
    if (typeof cwd !== 'string' || cwd.length === 0) {
      throw new Error('dsh-oks: 调用方会话没有 cwd，词汇助手不知道去哪个工作区读词表。');
    }
    const options = caller.options ?? {};
    // 助手要拿到和调用方一样的工具（oks_* 与 va_ask）：preset 必须**在它的作用域里拼起来**，
    // 光在会话头里写 agentPreset 不会装配它。子会话也是这么 join 父 preset 的。
    const presets = caller.ctx?.get?.('agentPresets');
    const composed = typeof presets?.composedPreset === 'function' ? presets.composedPreset(caller.ctx) : undefined;
    log(`[oks] vocabulary helper preset · ${typeof composed === 'string' && composed.length > 0 ? composed : `${vaPreset} (fallback)`}`);
    const handle = await agents.create({
      sessionId,
      meta: {
        cwd,
        agentPreset: typeof composed === 'string' && composed.length > 0 ? composed : vaPreset,
      },
      agentOptions: {
        ...(typeof options.provider === 'string' ? { provider: options.provider } : {}),
        ...(typeof options.model === 'string' ? { model: options.model } : {}),
      },
      setup(agentCtx, agent) {
        const service = agentCtx.get?.('agentPresets');
        if (typeof service?.composeFrom !== 'function') {
          throw new Error('dsh-oks: 这个组合里没有 agentPresets 服务，没法把 preset 拼进词汇助手，它会是个空 agent。');
        }
        service.composeFrom(agentCtx, caller.ctx);
        const prompt = agentCtx.systemPrompt;
        if (typeof prompt?.section !== 'function') {
          throw new Error('dsh-oks: 这个组合里没有 systemPrompt 服务，换不上词汇助手自己的人设。');
        }
        prompt.section({
          name: 'deployment:persona-prefix',
          order: typeof prompt.getSectionOrder === 'function' ? prompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX') : 0,
          text: VA_PERSONA,
        });
        // 助手的权限由插件显式钉住，不跟着部署默认走：它只读词表，不该写工作区、也不该弹审批。
        // `source: 'delegation'` 表示"这是创建时播下的覆盖"，而不是用户后来手动切的。
        agent.session.append('sandbox/mode', { mode: 'read-only', source: 'delegation' });
        agent.session.append('approval/policy', { policy: 'never', source: 'delegation' });
      },
      signal,
    });
    const helper = { sessionId, agent: handle.agent, pending: 0 };
    vaHelpers.set(key, helper);
    const session = helper.agent.session;
    // 给助手会话写一个**日志级**标题（`session/title` 只进日志，不进模型表面）：归档列表里一眼
    // 认得出这是内部会话，也是将来"重启后按标题找回助手"的抓手。
    const titles = ctx.get?.('sessionTitle');
    if (typeof titles?.rename === 'function') {
      const callerTitle = titles.get?.(caller.session)?.title;
      const suffix = typeof callerTitle === 'string' && callerTitle.length > 0 ? ` · 供「${callerTitle}」咨询` : '';
      titles.rename(session, `${VA_TITLE_PREFIX}${suffix}`);
    } else {
      log('[oks] no sessionTitle service; the vocabulary helper stays untitled');
    }
    try {
      const read = await vaSendAndWait(helper, vaMessage(readVaPrompt('1-read.md')), signal, vaBudgetMs, '词汇助手读词表');
      vaRequireCompleted(read.reason, '词汇助手读词表');
      const method = await vaSendAndWait(helper, vaMessage(readVaPrompt('2-method.md')), signal, vaBudgetMs, '词汇助手收工作方法');
      vaRequireCompleted(method.reason, '词汇助手收工作方法');
      // ③ 预热问题：它的回答只用来验证装配成功，答完立刻收起——**标记就是这个问题**，
      // 之后每次真实提问的问答都在拿到回答后收回到这里。
      const warmup = await vaSendAndWait(helper, vaMessage(vaWarmup), signal, vaBudgetMs, '词汇助手预热');
      vaRequireCompleted(warmup.reason, '词汇助手预热');
      helper.markerSeq = warmup.sentSeq;
      vaTryRewind(helper);
      await vaArchive(sessionId); // 装配完就归档：从"就绪"到"第一次被咨询"之间不该出现在活跃列表里
    } catch (cause) {
      vaHelpers.delete(key);
      void vaArchive(sessionId);
      throw new Error(`dsh-oks: 词汇助手没有装配起来：${cause?.message ?? cause}`);
    }
    log(`[oks] vocabulary helper ready · ${sessionId} · 标记 seq ${helper.markerSeq}`);
    return helper;
  });

  /** 一次咨询：归档状态先恢复 → 把说法交给它 → 等它静止 → 取它这一轮的回答。 */
  const vaConsult = async (helper, query, signal) => {
    await vaUnarchive(helper.sessionId);
    vaTryRewind(helper); // 上一次没来得及收的，提问之前补上
    const session = helper.agent.session;
    const { sentSeq, reason } = await vaSendAndWait(helper, vaMessage(query), signal, vaBudgetMs, '词汇助手回答');
    vaRequireCompleted(reason, '词汇助手这一轮');
    const answer = vaAnswerSince(session, sentSeq);
    if (answer.text.length === 0) {
      throw new Error('dsh-oks: 词汇助手这一轮没有给出文本回答（可能出错或被中断）。');
    }
    vaTryRewind(helper); // 拿到回答就收回去（助手此刻应该是 idle）
    await vaArchive(helper.sessionId);
    return { helper: helper.sessionId, answer: answer.text, interrupted: answer.interrupted };
  };

  // 插件卸载时把还活着的助手归档，别让它留在活跃列表里。
  ctx.effect(() => () => {
    for (const helper of vaHelpers.values()) void vaArchive(helper.sessionId);
  });

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
  // 缓存放在**模块级**：词汇助手是另一个 agent 作用域里的实例，它要用同一份数据模型，
  // 而不是把整棵引用图再爬一遍。
  const indexes = INDEX_BY_ARTIFACT;

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
          kind: { type: 'string', description: 'Restrict to one kind of term. The kinds that are discoverable are declared by the knowledge service of this workspace; a kind outside that declaration is rejected with the declared list.' },
          dataset: { type: 'string', description: 'Restrict to terms whose declared owner "dataset" is this one.' },
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
      name: 'oks_vocabulary',
      description: 'Page through the entire vocabulary of this workspace\'s knowledge service: every term with its kind, its declared owner, all of its aliases and a short description, in a fixed order. Paging with skip= therefore never repeats or drops a term; one page is bounded by bytes and a term is never split across pages. This tool serves the vocabulary helper that va_ask runs: it answers only inside that helper\'s session, where it is called page by page to load the whole vocabulary. In a work session, look terms up with oks_search and read them with oks_info.',
      parameters: {
        type: 'object',
        properties: {
          skip: {
            type: 'number',
            description: 'Start at this term in the fixed order (default 0). Each page reports how many terms remain, so page with skip = start + entries.length.',
          },
        },
        additionalProperties: false,
      },
      output: { schema: OBJECT_OUTPUT, render: renderVocabulary },
      async execute(args, exec) {
        const sessionId = exec?.agent?.session?.id;
        if (typeof sessionId !== 'string' || !sessionId.startsWith(VA_HELPER_PREFIX)) {
          throw new Error('dsh-oks: 整份词汇只交给词汇助手（va_ask 起的那个会话）；工作会话里找词用 oks_search，读节点用 oks_info。');
        }
        const entry = ensureWorkspace(exec);
        const index = await ensureIndex(entry);
        const result = vocabularyPage(index, args);
        log(`[oks] vocabulary skip=${result.start} → ${result.total} 条 · 返回 ${result.entries.length}`
          + `${result.more === null ? '' : ` · 还有 ${result.more}`}`);
        return result;
      },
    },
    {
      name: 'oks_references',
      description: 'List what references a knowledge key, from the reference graph the plugin derives when the vocabulary is built. Each row names the reference kind and the referencing node\'s key, so you can read that node with oks_info or follow it further. Use it to see what depends on a term before you change how you address it.',
      parameters: {
        type: 'object',
        properties: {
          key: {
            type: 'string',
            description: 'A knowledge key that exists in this artifact — composed from the declared key patterns, or taken verbatim from what a node returned.',
          },
          link: { type: 'string', enum: REFERENCE_KINDS, description: 'Restrict to one reference kind.' },
          kind: { type: 'string', description: 'Restrict to referencing nodes of one kind. The kinds that are discoverable are declared by the knowledge service of this workspace.' },
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
    {
      name: 'va_ask',
      description: 'Consult this session\'s vocabulary helper and get its answer back: send one paraphrase — a word, a phrase or a sentence, any language — and you receive the vocabulary\'s equivalent or near expressions, each with the dimension it differs on. The helper reads the whole vocabulary once, so the first call sets it up and takes longer; each later call is one question. Treat what it returns as leads: look the strings up with oks_search and read the declarations with oks_info.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'The paraphrase to consult about, e.g. "丢包" or "port pressure".',
          },
        },
        required: ['query'],
        additionalProperties: false,
      },
      output: { schema: OBJECT_OUTPUT, render: renderAsk },
      async execute(args, exec) {
        const query = typeof args?.query === 'string' ? args.query.trim() : '';
        if (query.length === 0) throw new Error('dsh-oks: va_ask 需要一个说法（query）。');
        const caller = exec?.agent;
        if (typeof caller?.session?.id === 'string' && caller.session.id.startsWith(VA_HELPER_PREFIX)) {
          throw new Error('dsh-oks: 词汇助手不咨询自己。');
        }
        const key = caller?.session?.id;
        if (typeof key !== 'string' || key.length === 0) {
          throw new Error('dsh-oks: 无法确定调用方会话，va_ask 需要它来记住词汇助手。');
        }
        const helper = await vaEnsureHelper(caller, key, exec?.signal);
        try {
          return await vaSingleFlight(vaAskFlights, `${key}\u0000${query}`, () =>
            vaSerialOn(vaHelperChain, helper.sessionId, async () => {
              const result = await vaConsult(helper, query, exec?.signal);
              log(`[oks] va_ask ${JSON.stringify(query)} → ${result.answer.length} 字符`);
              return result;
            }));
        } catch (error) {
          if (error?.vaDirty === true) {
            vaHelpers.delete(key);
            void vaArchive(helper.sessionId);
            log('[oks] vocabulary helper dropped (boundary unknown): ' + String(error?.message ?? error));
          }
          throw error;
        }
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
