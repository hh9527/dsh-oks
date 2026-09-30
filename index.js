// dsh-oks —— 一项 DSH 能力扩展：把"某个领域的知识服务（OKS）"接进 DSH，成为三个原生工具。
//
// 它**不是某个具体 OKS 的包装**，插件本身不认识任何模型：开放哪个模型、模型在哪，
// 一律由**会话所在工作区**根目录的 oks.json 声明（{"domain":"...","artifact":"...wasm"}）。
// 工作区是会话属性（会话创建时的 cwd，由 harness 记录），不是进程属性；
// 于是同一个插件能同时服务任意多个工作区，每个会话各用自己工作区声明的模型。
//
// 三个工具：ontology_info / ontology_map / ontology_transform。
// 读知识地图不需要专门工具：ontology_info {key:"index"} 就是入口，key 从目录/links/诊断里原样取。
// ontology_transform 返回**可执行查询计划**（SQL + bindings），不执行任何查询。
// ontology_map 动态伺服概念图（Mermaid），图由知识节点投影而来，不新增知识。
//
// 插件只写一样东西：**计划文件**（.sql / .json，落点由工作区在 oks.json 里声明，可关）。
// 地图只动态伺服、不落盘；工作区里的模型与 oks.json 是工作区
// 自己的配置，插件只读。
//
// 过程可见：每次调用都在结果开头打印发给 OKS 的请求与响应摘要（含重试），
// 让工具卡自身呈现推理轨迹，而不是一个黑盒。
//
// **反向解读由 Agent 做，工具不代劳**——这里曾经有一份"机械反查"（把 Intent 里的稳定 ID
// 逐个换成模型声明的标签），已被删除。理由值得记住，免得有人再把它加回来：
//   1. 它是 Intent schema 的第二份表示（DSL 每加一个字段它就得跟，而没有机制强制它跟上）；
//   2. 它要预热整个知识点目录（每个工作区 235 次读、约 4.8 s），只为换一次查表；
//   3. 它已经静默腐烂过一次：契约改成 PascalCase 之后它的 op 比较还是小写，
//      于是**每个 Intent 都走兜底分支**，一直没被发现；
//   4. 最要紧的是——**错的业务读法比没有更糟**，而这段读法正是用户用来对齐的东西。
// 需要标签时，Agent 用 ontology_info 查它真正要说的那几个 ID。
//
// 刻意零依赖：不 import @deepseek-ai/dsh-tools，而是注册与该包 defineTool 产物等价
// 的原始定义（parameters 已是 JSON Schema，output.schema 用受支持的子集）。
// 这样插件无论被安装在 profile 里还是直接从工作区加载，都不会有模块解析问题。
//
// 支持的 JSON Schema 关键字子集（dsh-tools 的约束）只有：
// type / oneOf / properties / required / additionalProperties / items / enum / const，
// 外加 description / title / default / examples 注解，因此这里不用 minItems 等。

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
import { Worker } from 'node:worker_threads';
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

export const inject = ['tools'];

// 这里只放与机器、与模型都无关的默认值：路径、领域名、模型一律来自工作区声明，
// 代码里不留任何绝对路径，插件因此可以整体搬走。
const DEFAULTS = {
  requestFuel: 10000,
  memoryLimit: 512,
  // 单次请求的墙钟上限，也是进程内宿主唯一能兜住死循环的东西（没有 fuel/抢占）：
  // 到点 terminate 整个 worker 代，并立刻拒掉排队中的请求；下一次请求再拉起（约 30 ms）。
  // 60s 是"一次 hang 的容忍时间"，不是正常请求的预期耗时——实测单次约 2.5 ms。
  requestTimeoutMs: 60000,
  // 服务只在整批 Intent 全部通过时返回 queries；开启后会把已通过的子集单独再降一次，
  // 让被拒批次里成功的 Intent 也能看到 SQL。设 false 可关闭。
  retryAcceptedSubset: true,
};

/** 从工作区读 oks.json —— 泛化的关键：**"哪个模型"由工作区声明，不由插件行声明**。
 *  于是 profile 里这一行不需要知道任何模型；一份配置服务任意工作区。
 *
 *  路径语义（重要）：`artifact` 一律**相对 oks.json 所在目录**解析，绝不相对于 cwd。
 *  oks.json 是那份声明，它所在的目录就是基准；cwd 是进程属性，与模型无关。 */
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

/** 会话 → 工作区目录。
 *
 *  工作区是**会话属性**（会话创建时的 cwd，由 harness 记录在会话头里），不是进程属性，
 *  所以绝不能拿 process.cwd() 顶替。三个容器按文档里出现过的位置依次探测，取第一个非空，
 *  并把命中的那一层记下来（这样只需一次确认就能删掉多余的分支）。
 *  `config.workspace` 只作为取不到会话 cwd 时的显式兜底，不参与正常路径。 */
function workspaceRootFor(exec, config) {
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
  const declared = typeof config?.workspace === 'string' && config.workspace.length > 0
    ? config.workspace
    : null;
  if (declared !== null) return { root: declared, from: 'config.workspace' };
  throw new Error(
    'dsh-oks: 无法确定当前会话的工作区目录（会话头里没有 cwd），因此不知道用哪个模型。'
    + '可在插件行的 config 里显式给 workspace。',
  );
}

/** 工作区在 URL 里的短名：可读的目录名 + 路径哈希，不同工作区互不冲突。
 *  概念图路由**按工作区注册**（/ontology-map/<slug>/）——HTTP 请求没有会话，
 *  所以"这是哪一份模型"只能由 URL 自己带上。 */
function workspaceSlug(root) {
  const base = basename(root).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'workspace';
  const digest = createHash('sha256').update(root).digest('hex').slice(0, 8);
  return `${base}-${digest}`;
}

/** 把一个工作区解析成一份运行设置。缺必要声明时给可执行的报错，而不是带着半截默认值去 spawn。 */
function resolveSettings(root, config) {
  const workspace = loadWorkspaceConfig(root);
  // 优先级：插件行的显式 config > 工作区的 oks.json > 与机器/模型无关的 DEFAULTS。
  const fromWorkspace = {
    domain: workspace.oks.domain,
    artifact: workspace.artifact,
    runner: workspace.oks.runner,
    transport: workspace.oks.transport,
    requestFuel: workspace.oks.requestFuel ?? DEFAULTS.requestFuel,
    memoryLimit: workspace.oks.memoryLimit ?? DEFAULTS.memoryLimit,
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

/** 插件**自带**的引导技能：注册进 ctx.skills 的 runtime 层，因此对所有工作区可见——
 *  它和工具同生共死，谁都不用再往工作区里拷一份提示词。
 *
 *  主体在同目录的 skill.md（纯正文，元数据在这里）。rank 250 的语义正好合用：
 *  工作区自己的 .dsh/skills(100) / .agents/skills(200) 能覆盖它，用户级(400/500)覆盖不了
 *  ——"插件给默认引导、工作区可以覆盖"。 */
const SKILL = {
  name: 'ontology-query',
  description: 'Use when a user intent must become a query plan over domain data: discover the ontology with ontology_info, express the plan as structured intents through ontology_transform, and confirm alignment by restating the plan as a business intent.',
  source: 'runtime',
};

/** 产物里有没有可直接导入的服务快照（有就能走进程内宿主）。 */
function hasSnapshot(artifactPath) {
  try {
    const module = new WebAssembly.Module(readFileSync(artifactPath));
    return WebAssembly.Module.customSections(module, 'telora.snapshot').length > 0;
  } catch (cause) {
    throw new Error(`cannot read telora artifact ${artifactPath}: ${cause?.message ?? cause}`);
  }
}

// 进程内宿主的 worker 源码。用 eval 形式内联，插件因此保持单文件、可从任意位置加载。
//
// 为什么放 worker：Node 没有 fuel/指令计量，也就没有抢占——一次死循环会卡死宿主线程。
// 放进 worker 之后，超时可以直接 terminate()，这是"没有 fuel"下唯一可用的强杀手段。
//
// ABI 依据 crates/telora-run/src/engine.rs：零导入；mem-alloc 写请求；
// run-service(in_ptr,in_len,1,0,record)，record 是 12 字节 (out_ptr,out_len,out_cap)。
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

/**
 * 进程内 runner：wasm 跑在 worker 里，超时直接 terminate 并复活。
 * 与 createStdioRunner 暴露同一个 { send(method, input, signal), dispose() } 接口。
 */
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
      if (message?.kind === 'fatal') { log(`[oks] worker init failed: ${message.message}`); return; }
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
      // 没有 fuel 就没有抢占：唯一的强杀手段是终止整个 worker 代。
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

  return { send, dispose, transport: 'worker' };
}

/** 常驻 JSONL 服务进程：一次一个在途请求，保证请求/响应按序配对。 */
function createStdioRunner(config, log) {
  let child = null;
  const pending = [];
  let chain = Promise.resolve();

  const failAll = (error) => {
    while (pending.length > 0) {
      const entry = pending.shift();
      clearTimeout(entry.timer);
      if (!entry.settled) {
        entry.settled = true;
        entry.reject(error);
      }
    }
  };

  const start = () => {
    const args = [
      config.artifact,
      '--serve', 'stdio+jsonl://',
      '--request-fuel', String(config.requestFuel),
      '--with-memory-limit', String(config.memoryLimit),
    ];
    log(`[oks] starting ${config.runner} ${args.join(' ')}`);
    child = spawn(config.runner, args, { stdio: ['pipe', 'pipe', 'pipe'] });

    createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', (line) => {
      const entry = pending.shift();
      if (!entry) return;
      clearTimeout(entry.timer);
      if (entry.settled) return;
      entry.settled = true;
      try {
        entry.resolve(JSON.parse(line));
      } catch {
        entry.reject(new Error(`ontology service returned invalid JSON: ${String(line).slice(0, 200)}`));
      }
    });

    child.stderr.on('data', (chunk) => log(`[oks] ${String(chunk).trim()}`));
    child.on('error', (cause) => { child = null; failAll(cause); });
    child.on('close', (code) => { child = null; failAll(new Error(`ontology runner exited (${code})`)); });
  };

  const dispatch = (method, input, signal) => new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('ontology request was aborted before dispatch'));
      return;
    }
    if (!child) {
      try {
        start();
      } catch (cause) {
        reject(cause);
        return;
      }
    }
    const entry = { resolve, reject, settled: false, timer: null };
    entry.timer = setTimeout(() => {
      if (entry.settled) return;
      entry.settled = true;
      reject(new Error(`ontology request timed out after ${config.requestTimeoutMs} ms`));
    }, config.requestTimeoutMs);
    signal?.addEventListener?.('abort', () => {
      if (entry.settled) return;
      entry.settled = true;
      clearTimeout(entry.timer);
      reject(new Error('ontology request was aborted'));
    }, { once: true });
    // entry 即使已结算也留在队列里，等对应响应到达时再出队，保证配对不乱序。
    pending.push(entry);
    try {
      child.stdin.write(`${JSON.stringify({ method, input })}\n`);
    } catch (cause) {
      reject(cause);
    }
  });

  const send = (method, input, signal) => {
    const run = chain.then(() => dispatch(method, input, signal));
    chain = run.then(() => undefined, () => undefined);
    return run;
  };

  const dispose = () => {
    const current = child;
    child = null;
    if (current) {
      try { current.stdin.end(); } catch { /* already closed */ }
      try { current.kill(); } catch { /* already gone */ }
    }
    failAll(new Error('ontology service was disposed'));
  };

  return { send, dispose };
}

/**
 * 选宿主。默认 auto：产物带服务快照就走进程内 worker（无子进程、无 JSONL），
 * 否则退回 telora-run 子进程（非快照产物需要注入 module sources，那条路只实现了 stdio）。
 */
function createRunner(config, log) {
  let transport = config.transport ?? 'auto';
  if (transport === 'auto') transport = hasSnapshot(config.artifact) ? 'worker' : 'stdio';
  if (transport === 'worker') {
    log(`[oks] transport=worker (in-process wasm, artifact ${config.artifact})`);
    return createWorkerRunner(config, log);
  }
  if (typeof config.runner !== 'string' || config.runner.length === 0) {
    throw new Error(
      `dsh-oks: artifact ${config.artifact} has no telora.snapshot section, so it `
      + 'needs the telora-run subprocess — but no `runner` is configured. Rebuild the artifact with '
      + '`--snapshot`, or set `runner` in oks.json / the plugin row.',
    );
  }
  log(`[oks] transport=stdio (telora-run subprocess ${config.runner})`);
  return createStdioRunner(config, log);
}

// ── 渲染 ────────────────────────────────────────────────────────────────────

// ── 概念图：把知识地图投影成 Mermaid，动态伺服，不落盘 ───────────────────────
//
// 这个能力**不新增任何知识**：节点、关系、术语、计数全部来自知识服务。它只是把
// 地图换一种载体——布局交给 Mermaid，这里只负责"描述"。所以模型一改，重新生成即可，
// 不存在需要同步的第二份数据。
//
// 页面只带框架，图源在打开时向 <base>/map.mmd 取：图永远是刚生成的，工作区里也不会
// 留下会过期的产物。Mermaid 包本身由浏览器缓存（这里 302 到 CDN），所以也不落盘。

const MERMAID_CDN = 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js';
const MAP_KIND_CN = {
  Dimension: '维度', Measure: '度量', Field: '字段', Value: '值',
  TimeRole: '时间角色', Metric: '指标', BusinessLink: '业务链接', Relation: '关系',
};
const MAP_ESCAPE = (value) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** 读知识地图并组装概念图的输入。只读，且不解析 key（id 与归属来自 detail）。 */
async function collectConceptMap(runner, domain, signal) {
  const info = async (key) => {
    const response = await runner.send(`${domain}/info`, { key }, signal);
    const document = response?.ok?.Document;
    return document === undefined || typeof document === 'string' ? null : document.Found;
  };
  const shortId = (key) => String(key).split('/').pop();

  const index = await info('index');
  const roster = new Map((index?.detail?.entries ?? []).map((entry) => [entry.key, entry]));
  if (roster.size === 0) throw new Error('knowledge index returned no entries');
  const ofType = (type) => [...roster.values()].filter((entry) => entry.type === type);
  const kinds = [...roster.values()].reduce((acc, entry) => {
    acc[entry.type] = (acc[entry.type] ?? 0) + 1;
    return acc;
  }, {});

  const datasets = new Map();
  for (const entry of ofType('Dataset')) {
    const node = await info(entry.key);
    const members = {};
    for (const link of node?.links ?? []) {
      const type = roster.get(link.key)?.type ?? '?';
      (members[type] ??= []).push(link.key);
    }
    datasets.set(entry.key, {
      key: entry.key,
      id: node?.detail?.id ?? shortId(entry.key),
      label: entry.description?.label ?? shortId(entry.key),
      members,
    });
  }
  const byId = new Map([...datasets.values()].map((item) => [item.id, item]));

  const relations = [];
  for (const entry of ofType('Relation')) {
    const detail = (await info(entry.key))?.detail ?? {};
    const from = byId.get(detail.from_dataset);
    const to = byId.get(detail.to_dataset);
    if (from && to) {
      relations.push({
        label: entry.description?.label ?? shortId(entry.key),
        kind: detail.kind ?? '',
        from,
        to,
      });
    }
  }

  // 术语 → 它指向的概念，以及该概念所属的数据集（图上用虚线连过去）。
  //
  // 三个坑都在这里：
  //   1. Value 的 detail.dimension 给的是**所属维度 id**，不是数据集 id——要再走一跳
  //      （维度详情的 detail.dataset）才能落到数据集上，否则那条虚线永远画不出来。
  //   2. 目标 id 一律取自节点自己声明的 detail/target，**不切分 key**（契约明令禁止）。
  //   3. 维度归属按需构建：没有 Value 类术语时一次也不去读。
  let dimensionOwners = null;
  const ensureDimensionOwners = async () => {
    if (dimensionOwners !== null) return dimensionOwners;
    dimensionOwners = new Map();
    for (const entry of ofType('Dimension')) {
      const detail = (await info(entry.key))?.detail ?? {};
      if (detail.id !== undefined && detail.dataset !== undefined) {
        dimensionOwners.set(String(detail.id), String(detail.dataset));
      }
    }
    return dimensionOwners;
  };

  const terms = [];
  for (const item of (await info('terminology'))?.detail?.entries ?? []) {
    const type = roster.get(item.key)?.type ?? '?';
    const detail = type === 'Dataset' ? null : (await info(item.key))?.detail ?? {};
    const target = type === 'Dataset'
      ? String(datasets.get(item.key)?.id ?? '')
      : String(detail.id ?? '');
    let owner = '';
    if (type === 'Dataset') owner = target;
    else if (type === 'Relation') owner = String(detail.from_dataset ?? '');
    else if (type === 'Value') {
      owner = (await ensureDimensionOwners()).get(String(detail.dimension ?? '')) ?? '';
    } else owner = String(detail.dataset ?? '');
    terms.push({ term: item.term, type, target, owner });
  }

  return { datasets, relations, terms, nodeCount: roster.size, kinds };
}

/** 生成 Mermaid 描述。布局不在这里做——那是渲染器的事。 */
function renderMermaidMap(map) {
  const quote = (value) => String(value).replace(/"/g, '&quot;').replace(/[<>]/g, '');
  const counts = (members) => Object.entries(members)
    .sort((a, b) => b[1].length - a[1].length)
    .map(([kind, keys]) => `${keys.length} ${MAP_KIND_CN[kind] ?? kind}`)
    .join(' · ');

  const nodeIds = new Map([...map.datasets.keys()].map((key, i) => [key, `d${i}`]));
  const lines = ['---', `title: ${map.domainLabel ?? 'Ontology'} 概念图（生成自知识地图）`, '---', 'flowchart LR'];
  for (const item of map.datasets.values()) {
    const title = item.label && item.label !== item.id ? item.label : item.id;
    lines.push(`  ${nodeIds.get(item.key)}["<b>${quote(title)}</b><br/><small>${quote(item.id)}</small><br/><small>${quote(counts(item.members))}</small>"]:::dataset`);
  }
  const seen = new Set();
  for (const edge of map.relations) {
    const line = `${nodeIds.get(edge.from.key)} -->|"${quote(edge.label)}"| ${nodeIds.get(edge.to.key)}`;
    if (!seen.has(line)) { seen.add(line); lines.push(`  ${line}`); }
  }
  lines.push('  subgraph TERMS["术语层 · 模型声明的俗称/别名，仅供发现，不是查询词汇"]');
  lines.push('    direction TB');
  map.terms.forEach((term, i) => lines.push(`    t${i}{{"${quote(term.term)}"}}:::term`));
  lines.push('  end');
  map.terms.forEach((term, i) => {
    const owner = [...map.datasets.values()].find((item) => item.id === term.owner);
    if (owner) lines.push(`  t${i} -.->|"${quote(term.type)} ${quote(term.target)}"| ${nodeIds.get(owner.key)}`);
  });
  lines.push('  classDef dataset fill:#ffffff,stroke:#2c4a57,stroke-width:2px,color:#10232c;');
  lines.push('  classDef term fill:#fff5f5,stroke:#c92a2a,color:#c92a2a;');
  const census = Object.entries(map.kinds).sort().map(([kind, n]) => `${kind} ${n}`).join(' · ');
  lines.push(`  %% ${map.nodeCount} 个知识节点：${census}`);
  return lines.join('\n');
}

/** 动态伺服的页面外壳：只带框架与 Mermaid，图源在打开时向 /map.mmd 取。
 *  好处是页面本身很小、浏览器缓存 Mermaid 包，而图**永远是刚生成的**。 */
function renderMapShellLive(basePath, domain) {
  return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${MAP_ESCAPE(domain)} 本体概念图</title>
<style>
  body { margin:0; background:#fbfcfd; color:#10232c;
         font:15px/1.6 ui-sans-serif,-apple-system,"Segoe UI","Noto Sans CJK SC",Roboto,sans-serif; }
  header { padding:26px 32px 16px; background:#fff; border-bottom:1px solid #e3e8ea; }
  h1 { margin:0 0 6px; font-size:25px; }
  .meta { margin:0; color:#5b6b73; font-size:14px; }
  .note { margin:8px 0 0; color:#c92a2a; font-size:13px; }
  main { padding:20px 32px 36px; overflow:auto; }
  #map { background:#fff; border:1px solid #e3e8ea; border-radius:12px; padding:20px; }
  #map:empty::after { content:"正在从知识服务读取地图…"; color:#8a979e; }
</style>
<script src="${basePath}/mermaid.min.js"></script>
</head>
<body>
<header>
  <h1>${MAP_ESCAPE(domain)} 本体概念图</h1>
  <p class="meta">每次打开都重新从知识服务生成——节点、关系、术语、计数全部取自知识节点，未手工编造，因此不会过期。</p>
  <p class="note">术语层（红色虚线）仅供发现：它指出常见俗称/别名指向哪个 canonical ID，不参与匹配、不做替换。</p>
  <p class="meta"><a href="${basePath}/map.mmd">查看 Mermaid 源</a> · <a href="${basePath}/?refresh=1">强制刷新</a></p>
</header>
<main><pre class="mermaid" id="map"></pre></main>
<script>
  mermaid.initialize({
    startOnLoad: false, securityLevel: 'loose', theme: 'base',
    flowchart: { htmlLabels: true, curve: 'basis', nodeSpacing: 34, rankSpacing: 90 },
    themeVariables: {
      fontFamily: 'ui-sans-serif,-apple-system,"Segoe UI","Noto Sans CJK SC",Roboto,sans-serif',
      fontSize: '14px', lineColor: '#9fb3bd', primaryColor: '#ffffff',
      primaryBorderColor: '#2c4a57', primaryTextColor: '#10232c',
      tertiaryColor: '#fffafa', tertiaryBorderColor: '#c92a2a', tertiaryTextColor: '#c92a2a',
    },
  });
  const target = document.getElementById('map');
  fetch('${basePath}/map.mmd', { cache: 'no-store' })
    .then((response) => { if (!response.ok) throw new Error('HTTP ' + response.status); return response.text(); })
    .then((source) => { target.textContent = source; return mermaid.run({ nodes: [target] }); })
    .catch((error) => { target.textContent = '生成失败：' + error.message; });
</script>
</body>
</html>
`;
}

/** ontology_map 的模型可见渲染：计数 + 伺服地址。 */
function renderMap(_args, value) {
  const counts = value?.counts ?? {};
  const lines = ['概念图（生成自知识地图，未手工编造）'];
  lines.push(`  数据集 ${counts.datasets ?? 0} · 关系 ${counts.relations ?? 0} · 术语 ${counts.terms ?? 0} · 知识节点 ${counts.nodes ?? 0}`);
  const census = Object.entries(value?.kinds ?? {}).sort().map(([kind, n]) => `${kind} ${n}`).join(' · ');
  if (census !== '') lines.push(`  按 kind：${census}`);
  if (typeof value?.workspace === 'string' && value.workspace !== '') {
    lines.push(`  工作区：${value.workspace}`);
  }
  lines.push('', `用浏览器打开：${value.url}`);
  lines.push('  动态伺服：每次打开都重新从知识服务生成，不落文件；Mermaid 包由浏览器缓存。');
  lines.push(`  强制刷新：${value.url}?refresh=1 · 图源：${value.url}map.mmd`);
  return [{ type: 'text', text: `${lines.join('\n')}\n` }];
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
    const entries = found?.detail?.entries;
    if (Array.isArray(entries)) {
      return `error=false · Document=${shape} · ${found.type} · entries=${entries.length}`;
    }
    return `error=false · Document=${shape}`;
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

function renderJson(_args, value) {
  const lines = renderTrace(value?.trace);
  lines.push('', JSON.stringify(value?.trace?.[0]?.response ?? value, null, 2));
  return [{ type: 'text', text: `${lines.join('\n')}\n` }];
}

/**
 * 目录节点（key "index"）的紧凑名册渲染，由 renderInfo 按内容分派调用。
 * 地图必须完整，但逐条 JSON 实测 83 KB（约 20k token），而工具结果会被截断到**尾部**
 * ——恰好把开头那几个"说明该怎么用"的协议节点截掉。所以这里按 type 分组、每行一个 key：
 * 协议类节点（Index / Terminology / Schema）的简述全文保留，其余仅在非空时给出并截断。
 */
const INDEX_PROTOCOL_TYPES = ['Index', 'Terminology', 'Schema'];

/** ontology_info 的渲染：读到的若是**目录节点**（detail.entries 是列表）就用紧凑名册，
 *  其余节点一律给完整 JSON。分派依据是节点内容，不是某个专门工具——入口只剩 info 一个。 */
function renderInfo(args, value) {
  const entries = value?.trace?.[0]?.response?.ok?.Document?.Found?.detail?.entries;
  return Array.isArray(entries) ? renderIndex(args, value) : renderJson(args, value);
}

function renderIndex(_args, value) {
  const lines = renderTrace(value?.trace);
  const response = value?.trace?.[0]?.response ?? {};
  const entries = response?.ok?.Document?.Found?.detail?.entries;
  if (!Array.isArray(entries)) {
    lines.push('', JSON.stringify(response, null, 2));
    return [{ type: 'text', text: `${lines.join('\n')}\n` }];
  }
  const groups = new Map();
  for (const entry of entries) {
    const type = String(entry?.type ?? '?');
    if (!groups.has(type)) groups.set(type, []);
    groups.get(type).push(entry);
  }
  const rank = (type) => {
    const at = INDEX_PROTOCOL_TYPES.indexOf(type);
    return at === -1 ? INDEX_PROTOCOL_TYPES.length : at;
  };
  const types = [...groups.keys()].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  lines.push('', `知识地图共 ${entries.length} 个节点。key 原样传给 ontology_info，不要构造或猜。`);
  for (const type of types) {
    const items = groups.get(type);
    lines.push('', `── ${type} (${items.length}) ──`);
    for (const entry of items) {
      const key = String(entry?.key ?? '');
      const id = key.split('/').pop();
      const label = String(entry?.description?.label ?? '');
      const summary = String(entry?.description?.summary ?? '').trim();
      lines.push(`  ${key}${label && label !== id ? ` — ${label}` : ''}`);
      if (summary !== '') {
        const keepWhole = INDEX_PROTOCOL_TYPES.includes(type) || summary.length <= 140;
        lines.push(`      ${keepWhole ? summary : `${summary.slice(0, 140)}…`}`);
      }
    }
  }
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

  // 批次级诊断是扁平数组，每条带 index 与 severity。没有 per-Intent 的 valid 字段了，
  // 所以「哪个 Intent 失败」要从 Error 级诊断推导。
  const errorIndexes = [...new Set(diagnostics
    .filter((item) => item?.diagnostic?.severity === 'Error')
    .map((item) => item.index))].sort((left, right) => left - right);

  // 成功的 Intent 也可能带 Warning，所以诊断必须全列——只在失败时看 results 会漏掉它。
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
      // 内容寻址：同一份计划重复问到的是同一对文件，所以要点明"这是复用，不是又长了一份"。
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
    lines.push('', '没有任何 Intent 通过。用 ontology_info 找到已声明的词汇（完整目录在 key "index"）再修 Intent；不要为了通过而改变业务含义。');
  }

  lines.push('', '上面的 SQL 是给授权执行层的中间计划，此处没有执行。');
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

/** 写一对**内容寻址**的文件：名字 = 计划内容的 sha256 前 16 位十六进制。
 *
 *  为什么不是时间戳：计划是 (intents, model) 的派生结果，同一批 Intent 反复问、重试、
 *  换措辞问，时间戳命名会一遍遍长出内容相同的副本（实测 113 份里只有 13 份不同）。
 *  按内容命名则天然去重：同样的计划永远落在同一个名字上，而且这个名字是**可引用的身份**。
 *
 *  纯在哪：.json 的字节**就是**被哈希的内容，所以 `sha256sum plan-<hash>.json` 可以自校验
 *  （前缀即文件名）。里面不放时间戳、不放模型名——名字已经把它是什么说完了。
 *  文件一旦写下就不再改动，唯一的后续动作是把 mtime 跟到最近一次用到，好让 `ls -t` 仍有意义。 */
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

  // ── 工作区注册表 ─────────────────────────────────────────────────────────
  //
  // 插件不认识模型：设置、wasm 宿主、知识目录、地图缓存、地图路由，全部在**第一次用到
  // 某个工作区**时按那份 oks.json 惰性建立并缓存。一个进程里可以有任意多个工作区：
  // 各自的模型、各自的 .oks/plans、各自的伺服地址，互不影响。
  const workspaces = new Map(); // root -> entry

  // ── web 服务：可选依赖 ───────────────────────────────────────────────────
  //
  // 用文档里的 ctx.get（"read a service from the store without the inject requirement"）取，
  // 而不是写成必需 inject——否则没有 web 服务的组合里，另外三个工具也会跟着失效。
  // apply 阶段它可能还没激活，所以第一次用到时再解析，并把结果记住。
  const MAP_BASE = '/ontology-map';
  const MAP_TTL_MS = 60000; // 同一分钟内重复打开不重复读服务
  let webServer; // undefined = 还没解析过；null = 解析过但没有
  const resolveWebServer = () => {
    if (webServer !== undefined) return webServer;
    try {
      webServer = ctx.get?.('webServer') ?? null;
    } catch {
      webServer = null;
    }
    return webServer;
  };
  /** 伺服地址：优先用 harness 自己公布的 URL，否则按 web 服务的 host:port 拼。 */
  const publicBase = (server) => {
    const announced = process.env.DSH_WEB_URL;
    if (typeof announced === 'string' && announced.length > 0) return announced.replace(/\/+$/, '');
    const host = server?.host === '0.0.0.0' ? '127.0.0.1' : (server?.host ?? '127.0.0.1');
    return `http://${host}:${server?.port}`;
  };

  const currentConceptMap = async (entry, refresh, signal) => {
    const now = Date.now();
    if (!refresh && entry.mapCache.source !== null && now - entry.mapCache.at < MAP_TTL_MS) {
      return entry.mapCache;
    }
    const map = await collectConceptMap(entry.runner, entry.settings.domain, signal);
    map.domainLabel = entry.settings.domain;
    entry.mapCache.map = map;
    entry.mapCache.source = renderMermaidMap(map);
    entry.mapCache.at = now;
    return entry.mapCache;
  };

  /** 每个工作区一个 handler，闭包捕获自己的 entry——路由按工作区注册，绝不错配模型。 */
  const handlerFor = (entry) => async (req, res) => {
    const base = `${MAP_BASE}/${entry.slug}`;
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const send = (status, type, body, extra = {}) => {
      res.writeHead(status, { 'content-type': type, ...extra });
      res.end(body);
    };
    try {
      if (path === `${base}/mermaid.min.js`) {
        // 不落盘：让浏览器去取并缓存 CDN 上的包。
        send(302, 'text/plain; charset=utf-8', '', { location: MERMAID_CDN });
        return;
      }
      if (path === `${base}/map.mmd`) {
        const cached = await currentConceptMap(entry, url.searchParams.has('refresh'));
        send(200, 'text/plain; charset=utf-8', cached.source, { 'cache-control': 'no-store' });
        return;
      }
      if (path === base || path === `${base}/index.html`) {
        // 打开页面顺手刷新一次，让"看到的就是刚生成的"。
        await currentConceptMap(entry, url.searchParams.has('refresh'));
        send(200, 'text/html; charset=utf-8', renderMapShellLive(base, entry.settings.domain), {
          'cache-control': 'no-store',
        });
        return;
      }
      send(404, 'text/plain; charset=utf-8', 'not found');
    } catch (cause) {
      send(500, 'text/plain; charset=utf-8', `ontology map failed: ${cause?.message ?? cause}`);
    }
  };

  /** 路由只在第一次用到该工作区时注册一次；注册时机可以是任意一次工具调用。 */
  const ensureRoute = (entry) => {
    if (entry.routeRegistered) return;
    const server = resolveWebServer();
    if (typeof server?.register !== 'function') return;
    const path = `${MAP_BASE}/${entry.slug}`;
    try {
      const handler = handlerFor(entry);
      ctx.effect(() => server.register({ kind: 'prefix', path, handler }));
      entry.routeRegistered = true;
      log(`[oks] concept map of ${entry.root} served at ${path}/`);
    } catch (cause) {
      log(`[oks] cannot register ${path}: ${cause?.message ?? cause}`);
    }
  };

  // 自带引导：能注册就注册。技能服务是**可选**依赖（和 webServer 一样用 ctx.get 取），
  // 没有它的组合里三个工具照常工作；加载时它可能还没起来，所以第一次工具调用会再试一次。
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
    const { root, from } = workspaceRootFor(exec, config);
    const existing = workspaces.get(root);
    if (existing !== undefined) return existing;
    const settings = resolveSettings(root, config);
    const entry = {
      root,
      from,
      settings,
      slug: workspaceSlug(root),
      runner: null,
      mapCache: { source: null, map: null, at: 0 },
      routeRegistered: false,
    };
    workspaces.set(root, entry);
    log(`[oks] workspace ${root} (cwd from ${from}) · domain=${settings.domain} · model=${settings.artifact}`);
    entry.runner = createRunner(settings, log);
    ensureRoute(entry);
    return entry;
  };

  // 工具描述按寄存器一次性注册，此时**还不知道**任何工作区，所以文本里不出现领域名：
  // 领域由工作区的 oks.json 声明，插件本身不认识任何模型。
  const definitions = [
    {
      name: 'ontology_info',
      description: 'Read one knowledge node of this workspace\'s knowledge service by its opaque string key. Start with key "index": it is the one key you may supply from memory, and it returns the complete flat catalog of every visible node with its key, type and brief description. Every other key must be passed unchanged from an index entry, from a node\'s links, or from a diagnostic — never construct, split, decode or guess one. Use only these canonical IDs when writing Intents; display names and physical column names are not substitutes.',
      parameters: {
        type: 'object',
        properties: {
          key: {
            type: 'string',
            description: 'Opaque knowledge key, taken unchanged from an index entry, a node link, or a diagnostic. The only key you may supply from memory is "index" — start there. Do not construct or guess keys.',
          },
        },
        required: ['key'],
        additionalProperties: false,
      },
      output: { schema: OBJECT_OUTPUT, render: renderInfo },
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
      name: 'ontology_map',
      description: 'Generate a browsable concept map of this workspace\'s domain, from the knowledge map itself, and serve it live over HTTP as Mermaid. Nothing is hand-authored — nodes, relations, terminology and counts all come from the knowledge service, so the map follows the model automatically and cannot drift. Nothing is written to disk: the route is registered per workspace, so the URL identifies which model the picture came from. Use it when a human wants to see the domain\'s shape, or when a picture answers better than prose.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: { schema: OBJECT_OUTPUT, render: renderMap },
      async execute(_args, exec) {
        const entry = ensureWorkspace(exec);
        ensureRoute(entry);
        if (!entry.routeRegistered) {
          throw new Error(
            'dsh-oks: 概念图是动态伺服的，需要 profile 里有 web 服务；当前没有，所以给不出地址。'
            + '（本插件不为地图落盘，以免在工作区里留下会过期的产物。）',
          );
        }
        const server = resolveWebServer();
        const cached = await currentConceptMap(entry, true, exec?.signal);
        // 返回值必须是 lossless JSON：内部的 map 含 Map 实例，不能直接交给 harness。
        return {
          mode: 'served',
          workspace: entry.root,
          url: `${publicBase(server)}${MAP_BASE}/${entry.slug}/`,
          counts: {
            nodes: cached.map.nodeCount,
            datasets: cached.map.datasets.size,
            relations: cached.map.relations.length,
            terms: cached.map.terms.length,
          },
          kinds: cached.map.kinds,
        };
      },
    },
    {
      name: 'ontology_transform',
      description: 'Validate one to five independent graph Intents against this workspace\'s ontology and return an executable query plan (parameterized SQL + bindings) for each. Nothing is executed. All Intents are checked even if one fails; queries come back only when every Intent is accepted. On rejection, read the diagnostics and repair the Intent instead of changing the business meaning.',
      parameters: {
        type: 'object',
        properties: {
          intents: {
            type: 'array',
            description: 'One to five independent graph Intents, e.g. {"op":"Graph","root":"d","nodes":[{"id":"d","entity":"<dataset id>"}],"edges":[],"select":[],"count":"d"}. Closed Intent choices use the declared enum spelling in PascalCase (e.g. op "Graph", filter op "Eq", direction "Desc", row_grain "Root"); read the Intent-syntax knowledge nodes listed in the knowledge index (type Schema) for the authoritative list instead of relying on memory.',
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
