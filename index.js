// dsh-oks —— DSH 能力扩展：把"某个领域的知识服务（OKS）"接成三个原生工具。
// 插件不认识任何模型：开放哪个模型、模型在哪，由**会话所在工作区**根目录的 oks.json 声明
// （{"domain":"...","artifact":"...wasm"}）。工作区是会话属性，所以一份插件能服务任意多工作区。
//
// 三个工具：ontology_info（按 key 读知识节点，入口是 key "index"）、
// ontology_map（概念图，动态伺服不落盘）、ontology_transform（Intent → SQL + bindings，不执行）。
// 插件只写一样东西：计划文件（.sql/.json，落点由工作区声明，可关）。
// 每次调用都在结果开头打印发给 OKS 的请求与响应摘要，工具卡因此自己呈现推理轨迹。
//
// 零依赖：直接注册原始工具定义，因此装在 profile 里或从工作区加载都不会有模块解析问题。
// parameters 只用受支持的 JSON Schema 关键字子集，数量校验放在 execute 里。

import { createHash } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

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
 *  config.workspace 只在会话头取不到 cwd 时兜底。 */
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
  description: 'Use when a user intent must become a query plan over domain data: discover the ontology with ontology_info, express the plan as structured intents through ontology_transform, and confirm alignment by restating the plan as a business intent.',
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

// ── 概念图：把知识地图投影成 Mermaid，动态伺服，不落盘 ───────────────────────
// 节点、关系、术语、计数全部来自知识服务，所以模型一改重新生成即可，没有第二份数据；
// 页面只带框架，图源在打开时向 <base>/map.mmd 取。

const MERMAID_CDN = 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js';
const MAP_KIND_CN = {
  Dimension: '维度', Measure: '度量', Field: '字段', Value: '值',
  TimeRole: '时间角色', Metric: '指标', BusinessLink: '业务链接', Relation: '关系',
};
const MAP_ESCAPE = (value) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** 读知识地图并组装概念图的输入，id 与归属都取自 detail（不切分 key）。 */
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

  // 术语 → 它指向的概念 → 该概念所属的数据集（图上虚线）。三个坑：
  //   1. Value 的 detail.dimension 是**维度 id**，要再走一跳（维度详情的 dataset）才落到数据集；
  //   2. 目标 id 取自节点自己声明的 detail/target，**不切分 key**；
  //   3. 维度归属按需构建（没有 Value 术语就不读）。
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

/** 把知识地图渲染成 Mermaid 源。 */
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

/** 页面外壳：只带框架，图源在打开时向 /map.mmd 取。 */
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
  <p class="meta">每次打开都重新从知识服务生成——节点、关系、术语、计数全部取自知识节点。</p>
  <p class="note">术语层（红色虚线）仅供发现：它指出常见俗称/别名指向哪个 canonical ID。</p>
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
  const lines = ['概念图（生成自知识地图）'];
  lines.push(`  数据集 ${counts.datasets ?? 0} · 关系 ${counts.relations ?? 0} · 术语 ${counts.terms ?? 0} · 知识节点 ${counts.nodes ?? 0}`);
  const census = Object.entries(value?.kinds ?? {}).sort().map(([kind, n]) => `${kind} ${n}`).join(' · ');
  if (census !== '') lines.push(`  按 kind：${census}`);
  if (typeof value?.workspace === 'string' && value.workspace !== '') {
    lines.push(`  工作区：${value.workspace}`);
  }
  lines.push('', `用浏览器打开：${value.url}`);
  lines.push('  动态伺服：每次打开都重新从知识服务生成。');
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

/** 目录节点的紧凑名册渲染。逐条 JSON 实测 83 KB，而工具结果截断到**尾部**——正好把开头
 *  "该怎么用"的协议节点截掉。所以按 type 分组、每行一个 key，协议类节点保留全文简述。 */
const INDEX_PROTOCOL_TYPES = ['Index', 'Terminology', 'Schema'];

/** 目录节点用紧凑名册，其余给完整 JSON（分派依据是节点内容）。 */
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
  lines.push('', `知识地图共 ${entries.length} 个节点。key 原样传给 ontology_info。`);
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
    lines.push('', '没有任何 Intent 通过。用 ontology_info 找到已声明的词汇（完整目录在 key "index"）再修 Intent，保持业务含义不变。');
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

  // 插件不认识模型：设置、wasm 宿主、地图缓存与路由都在**第一次用到某个工作区**时按那份
  // oks.json 惰性建立；一个进程里可以有任意多个工作区，互不影响。
  const workspaces = new Map(); // root -> entry

  // webServer 是可选依赖，用 ctx.get 取，第一次用到时再解析并记住（apply 阶段它可能还没激活）。
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

  /** 每个工作区一个 handler，闭包捕获自己的 entry，不会错配模型。 */
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

  /** 路由在第一次用到该工作区时注册一次。 */
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

  // 工具描述在注册时写死，此时还不知道任何工作区，所以文本里不出现领域名。
  const definitions = [
    {
      name: 'ontology_info',
      description: 'Read one knowledge node of this workspace\'s knowledge service by its opaque string key. Start with key "index": it is the one key you may supply from memory, and it returns the complete flat catalog of every visible node with its key, type and brief description. Keys are opaque — copy each one verbatim from what the service returned: an index entry, a node\'s links, or a diagnostic. Use only these canonical IDs when writing Intents; display names and physical column names are not substitutes.',
      parameters: {
        type: 'object',
        properties: {
          key: {
            type: 'string',
            description: 'Opaque knowledge key, copied verbatim from what the service returned — an index entry, a node\'s links, or a diagnostic. "index" is the one key you may supply from memory.',
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
      description: 'Generate a browsable concept map of this workspace\'s domain and serve it live over HTTP as Mermaid. Nodes, relations, terminology and counts all come from the knowledge service, so the map always matches the current model. The route is registered per workspace, so the URL identifies which model the picture came from. Use it when a human wants to see the domain\'s shape, or when a picture answers better than prose.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: { schema: OBJECT_OUTPUT, render: renderMap },
      async execute(_args, exec) {
        const entry = ensureWorkspace(exec);
        ensureRoute(entry);
        if (!entry.routeRegistered) {
          throw new Error(
            'dsh-oks: 概念图是动态伺服的，需要 profile 里有 web 服务；当前没有，所以给不出地址。',
          );
        }
        const server = resolveWebServer();
        const cached = await currentConceptMap(entry, true, exec?.signal);
        // 返回值必须是 lossless JSON（内部的 map 含 Map 实例）。
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
      description: 'Validate one to five independent graph Intents against this workspace\'s ontology and return an executable query plan (parameterized SQL + bindings) for each. Nothing is executed. All Intents are checked even if one fails, and every accepted Intent comes back as a plan. On rejection, read the diagnostics and repair the Intent with its business meaning intact.',
      parameters: {
        type: 'object',
        properties: {
          intents: {
            type: 'array',
            description: 'One to five independent graph Intents, e.g. {"op":"Graph","root":"d","nodes":[{"id":"d","entity":"<dataset id>"}],"edges":[],"select":[],"count":"d"}. Closed Intent choices use the declared enum spelling in PascalCase (e.g. op "Graph", filter op "Eq", direction "Desc", row_grain "Root"); the Intent-syntax knowledge nodes listed in the knowledge index (type Schema) hold the authoritative list.',
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
