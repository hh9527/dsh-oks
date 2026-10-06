import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { Worker } from "node:worker_threads";

//#region src/host.ts
/** 收窄成"非 null、非数组的对象"（JSON 边界用）。 */
const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
/** 收窄成数组（JSON 边界用；不引入 any）。 */
const isArray = (value) => Array.isArray(value);
/** 收窄成知识节点：key 是字符串、links 是数组——这正是检索层后续要用到的两处。 */
const isKnowledgeNode = (value) => isRecord(value) && typeof value.key === "string" && isArray(value.links);
/** 失败原因的文本：与原写法 `cause?.message ?? cause` 同义，只是收成 string。 */
const errorText = (cause) => {
	const message = isRecord(cause) ? cause.message : void 0;
	return String(message ?? cause);
};

//#endregion
//#region src/config.ts
const DEFAULTS = {
	requestTimeoutMs: 6e4,
	retryAcceptedSubset: true,
	queryTimeoutMs: 3e4,
	queryMaxRows: 200
};
/** 读工作区的 oks.json：**"哪个模型、哪份数据"由工作区声明**。
*  `artifact` 与 `dataFile` 都相对 oks.json 所在目录解析（绝对路径原样用）。 */
function loadWorkspaceConfig(root) {
	const file = join(root, "oks.json");
	let oks;
	try {
		oks = JSON.parse(readFileSync(file, "utf8"));
	} catch (cause) {
		throw new Error(`dsh-oks: 这个会话的工作区里没有可用的 ${file}（${errorText(cause)}）。在工作区根目录放一份 oks.json 即可开放模型，例如 {"domain":"<知识服务领域名>","artifact":"<相对 oks.json 的 .wasm 路径>"}。插件不提供默认模型——用错模型比报错贵。`);
	}
	const resolve = (value) => typeof value === "string" && value.length > 0 ? value.startsWith("/") ? value : join(root, value) : void 0;
	return {
		root,
		file,
		oks,
		artifact: resolve(oks?.artifact),
		dataFile: resolve(oks?.dataFile)
	};
}
/** 会话 → 工作区目录。工作区是**会话属性**（会话头里的 cwd），不是进程属性；
*  取不到就报错，让会话把 cwd 带上。 */
function workspaceRootFor(exec) {
	const session = exec?.agent?.session;
	const probes = [
		["session.meta.cwd", () => session?.meta?.cwd],
		["session.header.cwd", () => session?.header?.cwd],
		["session.cwd", () => session?.cwd]
	];
	for (const [where, pick] of probes) try {
		const value = pick();
		if (typeof value === "string" && value.length > 0) return {
			root: value,
			from: where
		};
	} catch {}
	throw new Error("dsh-oks: 无法确定当前会话的工作区目录（会话头里没有 cwd），因此不知道用哪个模型。工作区是会话属性，来源是会话头的 cwd——请让会话带上它。");
}
/** 把一个工作区解析成一份运行设置。缺 domain / artifact 时报错并给出补法。 */
function resolveSettings(root, config) {
	const workspace = loadWorkspaceConfig(root);
	const fromWorkspace = {
		domain: workspace.oks.domain ?? "",
		artifact: workspace.artifact ?? "",
		dataFile: workspace.dataFile,
		requestTimeoutMs: workspace.oks.requestTimeoutMs ?? DEFAULTS.requestTimeoutMs,
		retryAcceptedSubset: workspace.oks.retryAcceptedSubset ?? DEFAULTS.retryAcceptedSubset,
		queryTimeoutMs: workspace.oks.queryTimeoutMs ?? DEFAULTS.queryTimeoutMs,
		queryMaxRows: workspace.oks.queryMaxRows ?? DEFAULTS.queryMaxRows,
		workspaceRoot: workspace.root,
		workspaceFile: workspace.file
	};
	const settings = {
		...DEFAULTS,
		...fromWorkspace
	};
	if (config?.domain !== void 0) settings.domain = config.domain;
	if (config?.artifact !== void 0) settings.artifact = config.artifact;
	if (config?.dataFile !== void 0) settings.dataFile = config.dataFile;
	if (config?.requestTimeoutMs !== void 0) settings.requestTimeoutMs = config.requestTimeoutMs;
	if (config?.retryAcceptedSubset !== void 0) settings.retryAcceptedSubset = config.retryAcceptedSubset;
	if (config?.queryTimeoutMs !== void 0) settings.queryTimeoutMs = config.queryTimeoutMs;
	if (config?.queryMaxRows !== void 0) settings.queryMaxRows = config.queryMaxRows;
	const missing = [];
	if (typeof settings.domain !== "string" || settings.domain.length === 0) missing.push("domain");
	if (typeof settings.artifact !== "string" || settings.artifact.length === 0) missing.push("artifact");
	if (missing.length > 0) throw new Error(`dsh-oks: ${workspace.file} 缺少必要声明: ${missing.join(", ")}。需要 {"domain":"<知识服务领域名>","artifact":"<相对 oks.json 的 .wasm 路径>"}，也可以在插件行的 config 里覆盖。`);
	return settings;
}
/** 自带的引导技能：注册进 ctx.skills 的 runtime 层，对所有工作区可见；正文在 skill.md。
*  rank 250：工作区自己的 skill(100/200) 能覆盖它，用户级(400/500) 不能。 */
const SKILL = {
	name: "oks-query",
	description: "Use when a business question must be answered from domain data: discover the domain model with oks_info, validate structured intents with oks_check_intent, and get actual rows with oks_query. Resolve relative time into absolute boundaries first — time_now and time_calc do that without knowing any domain format.",
	source: "runtime"
};
/** skill.md 与产物同在包根（打包后 index.mjs 就在包根，所以是 `./skill.md`）。 */
function readSkillContent() {
	return readFileSync(new URL("./skill.md", import.meta.url), "utf8");
}
/** 产物里有没有可直接导入的服务快照。 */
function hasSnapshot(artifactPath) {
	try {
		const module = new WebAssembly.Module(readFileSync(artifactPath));
		return WebAssembly.Module.customSections(module, "telora.snapshot").length > 0;
	} catch (cause) {
		throw new Error(`cannot read telora artifact ${artifactPath}: ${errorText(cause)}`);
	}
}

//#endregion
//#region src/runners.ts
const WORKER_SOURCE = [
	"const { parentPort, workerData } = require('node:worker_threads');",
	"const { readFileSync } = require('node:fs');",
	"function decodeSnapshot(buf) {",
	"  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);",
	"  if (String.fromCharCode.apply(null, Array.from(buf.subarray(0, 8))) !== 'TLSART01') throw new Error('bad snapshot magic');",
	"  let at = 8;",
	"  if (view.getUint32(at, true) !== 1) throw new Error('unsupported snapshot version'); at += 4;",
	"  const guestLen = view.getUint32(at, true); at += 4;",
	"  const guest = buf.subarray(at, at + guestLen); at += guestLen;",
	"  const count = view.getUint32(at, true); at += 4;",
	"  const globals = []; const decoder = new TextDecoder();",
	"  for (let i = 0; i < count; i += 1) {",
	"    const nameLen = view.getUint32(at, true); at += 4;",
	"    const name = decoder.decode(buf.subarray(at, at + nameLen)); at += nameLen;",
	"    const tag = buf[at]; at += 1; let value;",
	"    if (tag === 0) { value = view.getInt32(at, true); at += 4; }",
	"    else if (tag === 1) { value = view.getBigInt64(at, true); at += 8; }",
	"    else if (tag === 2) { value = view.getUint32(at, true); at += 4; }",
	"    else if (tag === 3) { value = view.getBigUint64(at, true); at += 8; }",
	"    else throw new Error('unknown snapshot global tag ' + tag);",
	"    globals.push([name, value]);",
	"  }",
	"  if (at !== buf.byteLength) throw new Error('trailing snapshot bytes');",
	"  return { guest: guest, globals: globals };",
	"}",
	"const module = new WebAssembly.Module(readFileSync(workerData.artifact));",
	"const imports = WebAssembly.Module.imports(module);",
	"if (imports.length !== 0) throw new Error('expected a zero-import guest, got ' + imports.length);",
	"const encoder = new TextEncoder(); const textDecoder = new TextDecoder();",
	"const section = WebAssembly.Module.customSections(module, 'telora.snapshot')[0];",
	"if (section === undefined) throw new Error('artifact has no telora.snapshot section');",
	"const snapshot = decodeSnapshot(new Uint8Array(section));",
	"let exports_ = null; let memory = null; let resetGlobals = [];",
	"function instantiate() {",
	"  const next = new WebAssembly.Instance(module, {}).exports;",
	"  const boot = next['mem-alloc'](snapshot.guest.length, 1);",
	"  new Uint8Array(next.memory.buffer, boot, snapshot.guest.length).set(snapshot.guest);",
	"  next.telora_snapshot_import(boot, snapshot.guest.length);",
	"  let restored = 0;",
	"  for (const [name, value] of snapshot.globals) {",
	"    const global = next[name];",
	"    if (global instanceof WebAssembly.Global) { global.value = value; restored += 1; }",
	"  }",
	"  if (restored === 0) throw new Error('snapshot restored no globals');",
	"  exports_ = next; memory = next.memory;",
	"  next['reset-service']();",
	"  // 复位基线：运行时契约要求每次请求前把 telora_reset_global_* 恢复到初始化后的值，",
	"  // 否则状态会在请求之间累积（长会话里表现为 guest trap：unreachable）。",
	"  resetGlobals = [];",
	"  for (const name of Object.keys(next)) {",
	"    const global = next[name];",
	"    if (name.indexOf('telora_reset_global_') !== 0 || !(global instanceof WebAssembly.Global)) continue;",
	"    try { global.value = global.value; resetGlobals.push([name, global.value]); } catch (ignored) { }",
	"  }",
	"  return restored;",
	"}",
	"const restored = instantiate();",
	"function resetService() {",
	"  try { exports_['reset-service'](); }",
	"  catch (ignored) { instantiate(); return; }",
	"  for (const [name, value] of resetGlobals) exports_[name].value = value;",
	"}",
	"function invoke(line) {",
	"  resetService();",
	"  const input = encoder.encode(line);",
	"  const ptr = exports_['mem-alloc'](input.length, 1);",
	"  new Uint8Array(memory.buffer, ptr, input.length).set(input);",
	"  const record = exports_['mem-alloc'](12, 4);",
	"  exports_['run-service'](ptr, input.length, 1, 0, record);",
	"  exports_['mem-free'](ptr, input.length, 1);",
	"  const view = new DataView(memory.buffer);",
	"  const outPtr = view.getUint32(record, true);",
	"  const outLen = view.getUint32(record + 4, true);",
	"  const outCap = view.getUint32(record + 8, true);",
	"  if (outPtr === 0 || outLen > outCap) throw new Error('guest returned an invalid output record');",
	"  const text = textDecoder.decode(new Uint8Array(memory.buffer, outPtr, outLen).slice());",
	"  exports_['mem-free'](outPtr, outCap, 1);",
	"  exports_['mem-free'](record, 12, 4);",
	"  return JSON.parse(text);",
	"}",
	"parentPort.postMessage({ kind: 'ready', restored: restored });",
	"parentPort.on('message', (message) => {",
	"  try { parentPort.postMessage({ id: message.id, response: invoke(message.line) }); }",
	"  catch (cause) { parentPort.postMessage({ id: message.id, error: String((cause && cause.message) || cause) }); }",
	"});"
].join("\n");
/** 宿主：wasm 在进程内 worker 里，超时 terminate 并复活。
*  接口只有 { send(method, input, signal), dispose() }。 */
function createWorkerRunner(config, log) {
	const pending = /* @__PURE__ */ new Map();
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
			workerData: { artifact: config.artifact }
		});
		created.on("message", (message) => {
			if (message?.kind === "ready") {
				log(`[oks] worker ready (globals restored: ${message.restored})`);
				return;
			}
			const entry = pending.get(message?.id);
			if (entry === void 0) return;
			pending.delete(message.id);
			clearTimeout(entry.timer);
			if (message.error !== void 0) entry.reject(new Error(message.error));
			else entry.resolve(message.response);
		});
		created.on("error", (cause) => {
			log(`[oks] worker error: ${errorText(cause)}`);
			if (worker !== created) return;
			worker = null;
			failAll(cause);
		});
		created.on("exit", (code) => {
			log(`[oks] worker exited with code ${code}`);
			if (worker !== created) return;
			worker = null;
			failAll(/* @__PURE__ */ new Error(`wasm worker exited with code ${code}`));
		});
		worker = created;
		return created;
	};
	const send = (method, input, signal) => new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(/* @__PURE__ */ new Error("aborted"));
			return;
		}
		const line = JSON.stringify({
			method,
			input
		});
		let target = worker;
		if (target === null) target = spawn();
		const id = nextId;
		nextId += 1;
		const timer = setTimeout(() => {
			pending.delete(id);
			const dead = worker;
			worker = null;
			if (dead !== null) dead.terminate();
			reject(/* @__PURE__ */ new Error(`wasm request timed out after ${config.requestTimeoutMs} ms (worker terminated)`));
		}, config.requestTimeoutMs);
		pending.set(id, {
			resolve,
			reject,
			timer
		});
		target.postMessage({
			id,
			line
		});
	}).catch((cause) => {
		log(`[oks] worker request failed: ${errorText(cause)}`);
		throw cause;
	});
	const dispose = () => {
		failAll(/* @__PURE__ */ new Error("wasm worker was disposed"));
		const dead = worker;
		worker = null;
		if (dead !== null) dead.terminate();
	};
	return {
		send,
		dispose
	};
}
/** 当前只支持快照产物：产物必须带 `telora.snapshot` 段，Node 内置引擎直接导入它。 */
function createRunner(config, log) {
	if (!hasSnapshot(config.artifact)) throw new Error(`dsh-oks: artifact ${config.artifact} 里没有 telora.snapshot 段。当前只支持快照产物，请按 README 的「快照怎么来」用 \`--snapshot\` 重新构建。`);
	log(`[oks] in-process wasm worker (artifact ${config.artifact})`);
	return createWorkerRunner(config, log);
}
const EXECUTOR_SOURCE = [
	"const { parentPort, workerData } = require('node:worker_threads');",
	"const { DatabaseSync } = require('node:sqlite');",
	"const READ_ONLY = /^\\s*(select|with)\\b/i;",
	"let db = null;",
	"function open() { db = new DatabaseSync(workerData.dataFile, { readOnly: true }); }",
	"function run(sql, bindings, maxRows) {",
	"  if (!READ_ONLY.test(sql)) throw new Error('only read-only SELECT/WITH statements are executed');",
	"  if (db === null) open();",
	"  const rows = []; let truncated = false;",
	"  for (const row of db.prepare(sql).iterate(...bindings)) {",
	"    if (rows.length >= maxRows) { truncated = true; break; }",
	"    rows.push(row);",
	"  }",
	"  return { rows: rows, truncated: truncated };",
	"}",
	"parentPort.postMessage({ kind: 'ready' });",
	"parentPort.on('message', (message) => {",
	"  try {",
	"    const result = run(message.sql, message.bindings || [], message.maxRows);",
	"    parentPort.postMessage({ id: message.id, rows: result.rows, truncated: result.truncated });",
	"  } catch (cause) {",
	"    parentPort.postMessage({ id: message.id, error: String((cause && cause.message) || cause) });",
	"  }",
	"});"
].join("\n");
/** 只读查询执行器：一个数据文件一个 worker，超时 terminate 并复活。
*  接口是 { send(sql, bindings, signal), dispose() }。 */
function createExecutor(config, log) {
	const pending = /* @__PURE__ */ new Map();
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
			workerData: { dataFile: config.dataFile }
		});
		created.on("message", (message) => {
			if (message?.kind === "ready") {
				log(`[oks] executor ready (read-only ${config.dataFile})`);
				return;
			}
			const entry = pending.get(message?.id);
			if (entry === void 0) return;
			pending.delete(message.id);
			clearTimeout(entry.timer);
			if (message.error !== void 0) entry.reject(new Error(message.error));
			else entry.resolve({
				rows: message.rows,
				truncated: message.truncated
			});
		});
		created.on("error", (cause) => {
			log(`[oks] executor error: ${errorText(cause)}`);
			if (worker !== created) return;
			worker = null;
			failAll(cause);
		});
		created.on("exit", (code) => {
			log(`[oks] executor exited with code ${code}`);
			if (worker !== created) return;
			worker = null;
			failAll(/* @__PURE__ */ new Error(`sqlite executor exited with code ${code}`));
		});
		worker = created;
		return created;
	};
	const send = (sql, bindings, signal) => new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(/* @__PURE__ */ new Error("aborted"));
			return;
		}
		let target = worker;
		if (target === null) target = spawn();
		const id = nextId;
		nextId += 1;
		const timer = setTimeout(() => {
			pending.delete(id);
			const dead = worker;
			worker = null;
			if (dead !== null) dead.terminate();
			reject(/* @__PURE__ */ new Error(`query timed out after ${config.queryTimeoutMs} ms (executor terminated)`));
		}, config.queryTimeoutMs);
		pending.set(id, {
			resolve,
			reject,
			timer
		});
		target.postMessage({
			id,
			sql,
			bindings,
			maxRows: config.queryMaxRows
		});
	});
	const dispose = () => {
		failAll(/* @__PURE__ */ new Error("sqlite executor was disposed"));
		const dead = worker;
		worker = null;
		if (dead !== null) dead.terminate();
	};
	return {
		send,
		dispose
	};
}
/** 数据目录里的清单（若在）：只取两处声明——数据窗口与来源 revision。
*  两处都按"有就用、没有就算了"处理，缺字段不影响查询。 */
function readDataManifest(dataFile) {
	try {
		const manifest = JSON.parse(readFileSync(join(dirname(dataFile), "manifest.json"), "utf8"));
		if (manifest === null || typeof manifest !== "object") return null;
		const source = manifest;
		let windowValue = null;
		if (isRecord(source.window)) {
			const start = source.window.start;
			const endExclusive = source.window.endExclusive;
			if (typeof start === "string" && typeof endExclusive === "string") windowValue = {
				start,
				endExclusive
			};
		}
		return {
			window: windowValue,
			revision: typeof source.revision === "string" ? source.revision : null
		};
	} catch {
		return null;
	}
}

//#endregion
//#region src/text.ts
const capLine = (text, max) => text.length <= max ? text : `${text.slice(0, max)}…`;
const normalize = (text) => String(text).replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
const tokenize = (text) => normalize(text).split(/[^0-9a-z\u4e00-\u9fff]+/).filter((token) => token !== "");
const uniqueText = (values) => [...new Set(values.filter((value) => typeof value === "string" && value !== ""))];
const oneLineText = (text) => String(text).replace(/\s+/g, " ").trim();

//#endregion
//#region src/retrieval.ts
const SEARCH_BUDGET_CHARS = 5600;
const REFERENCE_BUDGET_CHARS = 5600;
const VOCABULARY_DOC_CHARS = 200;
const FACET_DATASET_CHARS = 300;
const REFERENCE_KINDS = [
	"Member",
	"Traversable",
	"Related"
];
/** 一个节点 → 一条词条。成员资格、归属与文本一律来自发现契约与节点自己的声明：
*  `declaration` 是已确认包含该 kind 的那条 vocabulary 项。文本只取自节点自己声明的
*  描述（summary/label/aliases、localized、terms）。 */
function deriveTerm(node, declaration) {
	const parts = node.key.split("/").map((part) => decodeURIComponent(part));
	const name = parts[parts.length - 1];
	const detail = node.detail ?? {};
	const description = node.description ?? {};
	const localized = [...description.localized ?? [], ...detail.localized ?? []];
	const terms = description.terms ?? [];
	const aliases = uniqueText([
		description.label,
		...description.aliases ?? [],
		...localized.map((item) => item.label),
		...terms.map((term) => term.term)
	]).filter((alias) => alias !== name);
	const aliasDoc = (description.aliases ?? []).some((alias) => !terms.some((term) => term.term === alias)) ? description.summary || description.label : "";
	const doc = uniqueText([
		description.summary,
		...localized.map((item) => item.summary),
		...terms.map((term) => term.description),
		aliasDoc
	]).join("\n");
	const entry = {
		key: node.key,
		kind: declaration.kind,
		name,
		doc,
		aliases,
		owner: null,
		ownerValue: null
	};
	if (typeof declaration.owner === "string" && detail[declaration.owner] != null) {
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
	const edges = /* @__PURE__ */ new Map();
	for (const node of [...nodes].sort((left, right) => left.key.localeCompare(right.key, "en"))) {
		for (const link of node.links) {
			if (!byKey.has(link.key)) throw new Error(`dsh-oks: 知识引用无法解析 ${node.key} → ${link.key}`);
			if (!REFERENCE_KINDS.includes(link.type)) throw new Error(`dsh-oks: 未知的引用种类 ${link.type}`);
			const edge = `${node.key}|${link.key}|${link.type}`;
			if (!edges.has(edge)) edges.set(edge, {
				source: node.key,
				target: link.key,
				link: link.type
			});
		}
		const declaration = byKind.get(node.key.split("/")[0]);
		if (declaration === void 0) continue;
		const required = declaration.require;
		if (required != null && (node.detail ?? {})[required] == null) continue;
		terms.push(deriveTerm(node, declaration));
	}
	const linksByTarget = /* @__PURE__ */ new Map();
	for (const edge of edges.values()) {
		const incoming = linksByTarget.get(edge.target);
		if (incoming === void 0) linksByTarget.set(edge.target, [{
			link: edge.link,
			source: edge.source
		}]);
		else incoming.push({
			link: edge.link,
			source: edge.source
		});
	}
	const kindCounts = contract.vocabulary.map((item) => [item.kind, terms.filter((term) => term.kind === item.kind).length]).filter(([, count]) => count > 0);
	const datasets = [...new Set(terms.filter((term) => term.owner === "dataset").map((term) => String(term.ownerValue)))].sort();
	return {
		revision: contract.revision,
		terms,
		keys: new Set(byKey.keys()),
		vocabKinds: contract.vocabulary.map((item) => item.kind),
		patterns: new Map(contract.keyPatterns.map((item) => [item.kind, item.pattern])),
		links: [...edges.values()],
		linksByTarget,
		facets: {
			kinds: kindCounts.map(([kind, count]) => `${kind} ${count}`).join(" · "),
			datasets: `${datasets.length} 个：${capLine(datasets.join(", "), FACET_DATASET_CHARS)}`
		}
	};
}
/** 请求了不在词汇表里的 kind 时，把"可发现性"讲清楚：词汇表收录哪些、哪些只是有 key 模式。 */
function kindError(index, kind, where) {
	const available = index.vocabKinds.join(" / ");
	const pattern = index.patterns.get(kind);
	if (pattern === void 0) return /* @__PURE__ */ new Error(`dsh-oks: ${where} 的 kind ${kind} 不存在：发现契约的 key 模式与词汇表里都没有它。词汇表收录的 kind：${available}。`);
	return /* @__PURE__ */ new Error(`dsh-oks: ${where} 的 kind ${kind} 不可检索：它有声明的 key 模式 ${pattern}，但不属这个产物的词汇表；这类 key 从节点自身的引用里得到（oks_info / oks_references）。词汇表收录的 kind：${available}。`);
}
/** 按发现契约爬完整个图并派生。首次检索时同步执行（同步阻塞，便于先跑通）。 */
async function buildRetrievalIndex(entry, sha, log) {
	const started = Date.now();
	const { domain } = entry.settings;
	const runner = entry.runner;
	const discovery = await runner.send(`${domain}/discovery`, {});
	if (discovery?.error === true) throw new Error(`dsh-oks: ${domain}/discovery 失败：${discovery?.diagnostics?.[0]?.message ?? "未知错误"}；检索需要这条路由。`);
	const ok = discovery?.ok;
	if (ok === null || typeof ok !== "object" || Array.isArray(ok)) throw new Error(`dsh-oks: ${domain}/discovery 没有返回发现契约（ok 需要 {revision, roots, key_patterns, vocabulary}）。`);
	const rawRoots = ok.roots;
	if (!isArray(rawRoots)) throw new Error(`dsh-oks: ${domain}/discovery 没有声明入口 roots（发现契约的 roots 是入口 key 的数组）`);
	const rawVocabulary = ok.vocabulary;
	if (!isArray(rawVocabulary)) throw new Error(`dsh-oks: ${domain}/discovery 没有声明 vocabulary（发现契约用 vocabulary 声明哪些 kind 进词汇表，以及每类词条的 owner 与 require）`);
	const revision = ok.revision;
	if (typeof revision !== "string" || revision === "") throw new Error(`dsh-oks: ${domain}/discovery 没有声明 revision`);
	const vocabulary = [];
	for (const item of rawVocabulary) {
		if (!isRecord(item) || typeof item.kind !== "string" || item.kind === "") throw new Error(`dsh-oks: ${domain}/discovery 的 vocabulary 里有不合法的条目（每条需要 kind，可带 owner / require）`);
		for (const field of ["owner", "require"]) {
			const value = item[field];
			if (value !== void 0 && value !== null && (typeof value !== "string" || value === "")) throw new Error(`dsh-oks: ${domain}/discovery 的 vocabulary 里 ${item.kind} 的 ${field} 不是字段名`);
		}
		vocabulary.push({
			kind: item.kind,
			owner: typeof item.owner === "string" ? item.owner : null,
			require: typeof item.require === "string" ? item.require : null
		});
	}
	const keyPatterns = isArray(ok.key_patterns) ? ok.key_patterns.filter((item) => isRecord(item) && typeof item.kind === "string") : [];
	const roots = rawRoots;
	if (roots.length === 0) throw new Error(`dsh-oks: ${domain}/discovery 没有返回任何入口 key`);
	const pending = [.../* @__PURE__ */ new Set(["index", ...roots])];
	const seen = new Set(pending);
	const nodes = [];
	for (const key of pending) {
		const document = (await runner.send(`${domain}/info`, { key }))?.ok?.Document;
		const node = document === null || typeof document !== "object" ? void 0 : document.Found;
		if (!isKnowledgeNode(node) || node.key !== key) throw new Error(`dsh-oks: 无法解析知识 key ${key}（发现契约要求每个入口都能取到节点）`);
		nodes.push(node);
		for (const link of node.links) if (typeof link?.key === "string" && !seen.has(link.key)) {
			seen.add(link.key);
			pending.push(link.key);
		}
		const schemas = node.detail?.schemas;
		if (node.type === "Index" && isArray(schemas)) {
			for (const schema of schemas) if (typeof schema === "string" && !seen.has(schema)) {
				seen.add(schema);
				pending.push(schema);
			}
		}
	}
	const index = deriveIndex(nodes, {
		revision,
		vocabulary,
		keyPatterns
	});
	log(`[oks] discovery index · ${index.revision} · ${sha.slice(0, 12)} · ${nodes.length} 节点 · ${index.terms.length} 词条 · ${index.links.length} 引用 · ${Date.now() - started} ms`);
	return index;
}
/** 一条词条 → 检索结果行（不含 key：agent 按声明的 key 模式自己拼）。
*  词条声明了 owner 时，行里用 owner 这个名字作字段。 */
function termRow(term, field, score) {
	const row = {
		kind: term.kind,
		name: term.name,
		field,
		score
	};
	if (term.owner !== null) row[term.owner] = term.ownerValue;
	return row;
}
const ROW_FIELDS = /* @__PURE__ */ new Set([
	"kind",
	"name",
	"field",
	"score"
]);
const termOwner = (row) => {
	for (const [name, value] of Object.entries(row)) if (!ROW_FIELDS.has(name)) return `[${value}]`;
	return "";
};
const termLine = (row) => {
	const owner = termOwner(row);
	return `${row.kind}  ${row.name}${owner === "" ? "" : `  ${owner}`}  ${row.field} ${row.score}`;
};
/** 匹配：对 name / aliases / doc 做模糊匹配（AND 全部查询词），报出命中的那一类。 */
function matchTerm(term, tokens, query) {
	const name = normalize(term.name);
	const aliasText = normalize(term.aliases.join(" "));
	const docText = normalize(term.doc);
	const all = `${name} ${aliasText} ${docText}`;
	if (!tokens.every((token) => all.includes(token))) return null;
	if (tokens.every((token) => name.includes(token))) return {
		field: "name",
		score: name === query ? 1 : .9
	};
	if (tokens.every((token) => aliasText.includes(token))) return {
		field: "alias",
		score: .7
	};
	if (tokens.every((token) => docText.includes(token))) return {
		field: "doc",
		score: .5
	};
	return {
		field: "doc",
		score: .3
	};
}
/** 检索：过滤 → 稳定排序 → 按字节装页。`skip` 是分页起点，`more` 是剩余条数。 */
function searchIndex(index, args) {
	const query = normalize(args?.query ?? "").trim();
	const kind = typeof args?.kind === "string" && args.kind !== "" ? args.kind : null;
	const dataset = typeof args?.dataset === "string" && args.dataset !== "" ? args.dataset : null;
	const skipValue = args?.skip;
	const skip = typeof skipValue === "number" && Number.isInteger(skipValue) && skipValue > 0 ? skipValue : 0;
	if (kind !== null && !index.vocabKinds.includes(kind)) throw kindError(index, kind, "oks_search");
	const tokens = tokenize(query);
	const matched = [];
	for (const term of index.terms) {
		if (kind !== null && term.kind !== kind) continue;
		if (dataset !== null && !(term.owner === "dataset" && String(term.ownerValue) === dataset)) continue;
		if (tokens.length === 0) {
			matched.push({
				term,
				field: "all",
				score: 0
			});
			continue;
		}
		const hit = matchTerm(term, tokens, query);
		if (hit !== null) matched.push({
			term,
			...hit
		});
	}
	matched.sort((left, right) => right.score - left.score || left.term.kind.localeCompare(right.term.kind, "en") || String(left.term.ownerValue ?? "").localeCompare(String(right.term.ownerValue ?? ""), "en") || left.term.name.localeCompare(right.term.name, "en"));
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
	return {
		start: skip,
		total,
		more: remaining > 0 ? remaining : null,
		matched: rows,
		facets: index.facets
	};
}
/** 反向引用：`skip` 分页；未知 key 直接报错（区别于"没有任何引用"）。 */
function referencesOf(index, args) {
	const key = typeof args?.key === "string" && args.key !== "" ? args.key : null;
	if (key === null) throw new Error("dsh-oks: oks_references 需要 key");
	const link = typeof args?.link === "string" && args.link !== "" ? args.link : null;
	const kind = typeof args?.kind === "string" && args.kind !== "" ? args.kind : null;
	const skipValue = args?.skip;
	const skip = typeof skipValue === "number" && Number.isInteger(skipValue) && skipValue > 0 ? skipValue : 0;
	if (link !== null && !REFERENCE_KINDS.includes(link)) throw new Error(`dsh-oks: link 只能是 ${REFERENCE_KINDS.join(" / ")}`);
	if (kind !== null && !index.vocabKinds.includes(kind)) throw kindError(index, kind, "oks_references");
	if (!index.keys.has(key)) throw new Error(`dsh-oks: ${key} 不是这个产物里的知识 key（用 oks_search 先找到 key）`);
	const all = (index.linksByTarget.get(key) ?? []).filter((reference) => link === null || reference.link === link).filter((reference) => kind === null || reference.source.split("/")[0] === kind).sort((left, right) => left.link.localeCompare(right.link, "en") || left.source.localeCompare(right.source, "en"));
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
	return {
		key,
		start: skip,
		total,
		more: remaining > 0 ? remaining : null,
		references: rows
	};
}
/** 一条词条 → 词汇表出口的一条：kind / name / aliases / doc，声明了 owner 就带 owner 字段。
*  aliases 全给（它是这个出口的主要价值）；doc 是给"区分同名词条"用的，截到 DOC_CHARS。 */
function vocabularyEntry(term) {
	const entry = {
		kind: term.kind,
		name: term.name,
		aliases: term.aliases,
		doc: capLine(oneLineText(term.doc), VOCABULARY_DOC_CHARS)
	};
	if (term.owner !== null) entry[term.owner] = term.ownerValue;
	return entry;
}
const VOCABULARY_FIELDS = /* @__PURE__ */ new Set([
	"kind",
	"name",
	"aliases",
	"doc"
]);
const vocabularyOwner = (entry) => {
	for (const [name, value] of Object.entries(entry)) if (!VOCABULARY_FIELDS.has(name)) return `[${value}]`;
	return "";
};
/** 词条行：` · ` 连接的 kind / name / [owner] / 全部 aliases。aliases 为空时 doc 是唯一能
*  区分它的文本，再附一行。装页与渲染用的是同一份行，所以"整条截止"不会截到半条。 */
function vocabularyEntryLines(entry) {
	const parts = [entry.kind, entry.name];
	const owner = vocabularyOwner(entry);
	if (owner !== "") parts.push(owner);
	parts.push(...entry.aliases);
	const lines = [parts.join(" · ")];
	if (entry.aliases.length === 0 && entry.doc !== "") lines.push(`    ${entry.doc}`);
	return lines;
}
/** 整份词汇：按 key 排序（确定，翻页不重、不漏）→ 按字节装页（整条截止）。
*  与检索不同，这里不筛不排：用途是把整份词汇原样交给词汇助手，而不是在工作会话里筛着看。 */
/** 整份词汇一次性渲染：一行一条、无页眉页脚。插件把它作为**一条消息**喂进助手的上下文，
*  所以这里没有分页、没有游标、也没有"下一页"——模型不做任何搬运。 */
function renderWholeVocabulary(index) {
	return [...index.terms].sort((left, right) => left.key.localeCompare(right.key, "en")).map((term) => vocabularyEntryLines(vocabularyEntry(term)).join("\n")).join("\n");
}
function renderSearch(_args, value) {
	const lines = [`命中 ${value.total} · 从 ${value.start} 起显示 ${value.matched.length} 条${value.more === null ? "（已到底）" : ` · 还有 ${value.more}`}`];
	if (value.matched.length === 0) lines.push("", "没有匹配。可用的 kind：" + value.facets.kinds, "可用的 dataset：" + value.facets.datasets, "换个说法，或用 kind= / dataset= 收窄。");
	else {
		for (const row of value.matched) lines.push(termLine(row));
		lines.push("", "用 index 里声明的 key 模式把 kind/name[/owner] 拼成 key，再用 oks_info 读节点。");
	}
	return [{
		type: "text",
		text: `${lines.join("\n")}\n`
	}];
}
/** oks_references 的模型可见渲染：谁引用了这个 key（`link` 是引用种类）。 */
function renderReferences(_args, value) {
	const lines = [`引用 ${value.key} 的共 ${value.total} 条 · 从 ${value.start} 起显示 ${value.references.length} 条${value.more === null ? "（已到底）" : ` · 还有 ${value.more}`}`];
	if (value.references.length === 0) lines.push("", "没有任何节点引用它。");
	else for (const row of value.references) lines.push(`${row.link}  ${row.source}`);
	return [{
		type: "text",
		text: `${lines.join("\n")}\n`
	}];
}

//#endregion
//#region src/single-flight.ts
/** 取（或触发）某个键上正在进行的初始化；`start` 只在没有在飞时被调用一次。 */
function singleFlight(map, key, start) {
	const inflight = map.get(key);
	if (inflight !== void 0) return inflight;
	const flight = start();
	map.set(key, flight);
	flight.then(() => {}, () => {}).then(() => {
		if (map.get(key) === flight) map.delete(key);
	});
	return flight;
}

//#endregion
//#region src/knowledge.ts
/** 进程级的检索层缓存：artifact sha256 -> 词汇表 + 反向引用索引。
*  词汇助手是另一个 agent 作用域里的实例，它和主 agent 共用这一份，不重爬引用图。 */
const INDEX_BY_ARTIFACT = /* @__PURE__ */ new Map();
function createKnowledge({ ctx, log, config }) {
	const workspaces = /* @__PURE__ */ new Map();
	const executors = /* @__PURE__ */ new Map();
	const executorFor = (settings) => {
		const dataFile = settings.dataFile;
		if (typeof dataFile !== "string" || dataFile.length === 0) throw new Error(`dsh-oks: ${settings.workspaceFile} 没有声明 dataFile，oks_query 无处可查。需要 {"dataFile":"<相对 oks.json 的 .sqlite 路径>"}；只做校验可以用 oks_check_intent。`);
		const existing = executors.get(dataFile);
		if (existing !== void 0) return existing;
		if (!existsSync(dataFile)) throw new Error(`dsh-oks: ${settings.workspaceFile} 声明的 dataFile 不存在：${dataFile}`);
		const manifest = readDataManifest(dataFile);
		const entry = {
			executor: createExecutor(settings, log),
			manifest
		};
		executors.set(dataFile, entry);
		log(`[oks] read-only executor for ${dataFile}${manifest?.revision ? ` · data revision=${manifest.revision}` : ""}${manifest?.window ? ` · window=[${manifest.window.start}, ${manifest.window.endExclusive})` : ""}`);
		return entry;
	};
	let skillRegistered = false;
	const registerSkill = () => {
		if (skillRegistered) return true;
		let content;
		try {
			content = readSkillContent();
		} catch (cause) {
			log(`[oks] skill body unreadable: ${errorText(cause)}`);
			skillRegistered = true;
			return true;
		}
		let found = null;
		try {
			found = ctx.get?.("skills") ?? null;
		} catch {
			found = null;
		}
		const skills = found;
		if (skills === null || typeof skills.register !== "function") return false;
		try {
			ctx.effect(() => skills.register({
				...SKILL,
				content
			}));
			skillRegistered = true;
			log(`[oks] skill "${SKILL.name}" registered (runtime) · ${Buffer.byteLength(content, "utf8")} bytes`);
		} catch (cause) {
			log(`[oks] cannot register skill "${SKILL.name}": ${errorText(cause)}`);
			skillRegistered = true;
		}
		return skillRegistered;
	};
	registerSkill();
	/** 每个工具的入口动作：由**会话**定位工作区，再拿到（或惰性建立）它的运行环境。 */
	const ensureWorkspace = (exec) => {
		registerSkill();
		const { root, from } = workspaceRootFor(exec);
		const existing = workspaces.get(root);
		if (existing !== void 0) return existing;
		const settings = resolveSettings(root, config);
		const entry = {
			root,
			from,
			settings,
			runner: null,
			index: null
		};
		workspaces.set(root, entry);
		log(`[oks] workspace ${root} (cwd from ${from}) · domain=${settings.domain} · model=${settings.artifact}`);
		entry.runner = createRunner(settings, log);
		return entry;
	};
	const indexes = INDEX_BY_ARTIFACT;
	const indexFlights = /* @__PURE__ */ new Map();
	/** 惰性建立检索层：第一次检索时执行，之后按产物哈希复用；并发时 single flight。 */
	const ensureIndex = async (entry) => {
		if (entry.index !== null) return entry.index;
		const sha = createHash("sha256").update(readFileSync(entry.settings.artifact)).digest("hex");
		const shared = indexes.get(sha);
		if (shared !== void 0) {
			entry.index = shared;
			return shared;
		}
		const index = await singleFlight(indexFlights, sha, async () => {
			const built = await buildRetrievalIndex(entry, sha, log);
			indexes.set(sha, built);
			return built;
		});
		entry.index = index;
		return index;
	};
	const dispose = () => {
		for (const entry of workspaces.values()) try {
			entry.runner?.dispose();
		} catch {}
		workspaces.clear();
		for (const entry of executors.values()) try {
			entry.executor?.dispose();
		} catch {}
		executors.clear();
	};
	return {
		ensureWorkspace,
		ensureIndex,
		executorFor,
		dispose
	};
}

//#endregion
//#region src/time.ts
const PARTS = {
	year: "numeric",
	month: "2-digit",
	day: "2-digit",
	hour: "2-digit",
	minute: "2-digit",
	second: "2-digit",
	weekday: "short",
	hourCycle: "h23"
};
const WEEKDAYS = [
	"Mon",
	"Tue",
	"Wed",
	"Thu",
	"Fri",
	"Sat",
	"Sun"
];
/** 规范里的 IANA 形态：UTC 或 Area/Location。 */
const IANA_TIME_ZONE = /^[A-Za-z][A-Za-z0-9_+.-]*(?:\/[A-Za-z0-9_+.-]+)+$/;
/**
* 按插件规范从**当轮用户消息**里推导浏览器时区（与 dsh-time-context 同一套字段与三态）：
* 只认 source.kind === "user" 且带 rpcId 的消息上的 source.clientTimeZone。
* 返回 {kind:"resolved",timeZone} | {kind:"mixed",timeZones} | {kind:"missing"} | {kind:"invalid",...}。
* 规范里不合法是抛错；这里降级成可报告的态，让工具能给出"去问用户"的指引而不是打断回合。
*/
function deriveContextTimeZone(messages) {
	const zones = /* @__PURE__ */ new Set();
	for (const message of isArray(messages) ? messages : []) {
		const source = isRecord(message) ? message.source : void 0;
		if (!isRecord(source) || source.kind !== "user" || typeof source.rpcId !== "string") continue;
		const value = source.clientTimeZone;
		if (typeof value !== "string") continue;
		if (value !== "UTC" && !IANA_TIME_ZONE.test(value)) return {
			kind: "invalid",
			timeZone: value
		};
		try {
			if (new Intl.DateTimeFormat("en-US", { timeZone: value }).resolvedOptions().timeZone !== value) return {
				kind: "invalid",
				timeZone: value
			};
		} catch {
			return {
				kind: "invalid",
				timeZone: value
			};
		}
		zones.add(value);
	}
	const sorted = [...zones].sort();
	if (sorted.length === 0) return { kind: "missing" };
	if (sorted.length === 1) return {
		kind: "resolved",
		timeZone: sorted[0]
	};
	return {
		kind: "mixed",
		timeZones: sorted
	};
}
/** 校验并规范化 IANA 时区名；不合法就明确报错，不静默回退。 */
function assertZone(zone) {
	if (typeof zone !== "string" || zone.length === 0) throw new Error("time zone must be a non-empty IANA name");
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: zone });
	} catch (cause) {
		throw new Error(`unknown time zone: ${zone}`, { cause });
	}
	return zone;
}
/**
* 时区从哪来：调用方显式给的 > **本次请求的上下文时区**（按插件规范从用户消息推导）。
* 来源要一起报出去，便于在回答里写明口径。
* 两者都没有时明确报错，并要求向用户澄清——这样"今天""上周"这类边界始终落在用户所在的时区里。
*/
function resolveZone(requested, context) {
	if (typeof requested === "string" && requested.length > 0) return {
		zone: assertZone(requested),
		source: "argument"
	};
	if (context?.kind === "resolved") return {
		zone: assertZone(context.timeZone),
		source: "context"
	};
	if (context?.kind === "mixed") throw new Error("dsh-oks: 本次请求带进来的浏览器时区不一致（" + context.timeZones.join(", ") + "）。按规范应向用户澄清用哪个时区，或显式传 timeZone。");
	if (context?.kind === "invalid") throw new Error("dsh-oks: 本次请求带的浏览器时区不合法（" + String(context.timeZone) + "）。请向用户确认时区，或显式传 timeZone。");
	throw new Error("dsh-oks: 本次请求没有带浏览器时区。请向用户确认时区后显式传入 timeZone，或让请求带上浏览器时区——上下文时区按插件规范从用户消息读取。");
}
const pad = (value, width = 2) => String(value).padStart(width, "0");
/** 该时刻在给定时区里的日历字段。 */
function localParts(epochMillis, zone) {
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone: zone,
		...PARTS
	}).formatToParts(new Date(epochMillis));
	const get = (type) => parts.find((part) => part.type === type)?.value ?? "";
	const weekday = get("weekday");
	const index = WEEKDAYS.indexOf(weekday);
	return {
		year: Number(get("year")),
		month: Number(get("month")),
		day: Number(get("day")),
		hour: Number(get("hour")),
		minute: Number(get("minute")),
		second: Number(get("second")),
		weekday,
		weekdayIndex: index < 0 ? 1 : index + 1
	};
}
/** 该时刻在给定时区的 UTC 偏移（分钟）。 */
function offsetMinutes(epochMillis, zone) {
	const p = localParts(epochMillis, zone);
	const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
	return Math.round((asUtc - Math.floor(epochMillis / 1e3) * 1e3) / 6e4);
}
function offsetText(minutes) {
	const sign = minutes < 0 ? "-" : "+";
	const abs = Math.abs(minutes);
	return `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}
/** 本地日历字段（当作 UTC 毫秒）→ 真实时刻。两趟修正，DST 也能落在一个有效时刻上。 */
function fromLocal(localMillis, zone) {
	return localMillis - offsetMinutes(localMillis - offsetMinutes(localMillis, zone) * 6e4, zone) * 6e4;
}
const localMillisOf = (epochMillis, zone) => epochMillis + offsetMinutes(epochMillis, zone) * 6e4;
/** ISO-8601 周序号（周一起算），用于"第几周"这类表述。 */
function isoWeek(year, month, day) {
	const date = new Date(Date.UTC(year, month - 1, day));
	const weekday = date.getUTCDay() || 7;
	date.setUTCDate(date.getUTCDate() + 4 - weekday);
	const yearStart = Date.UTC(date.getUTCFullYear(), 0, 1);
	return {
		weekYear: date.getUTCFullYear(),
		week: Math.ceil(((date.getTime() - yearStart) / 864e5 + 1) / 7),
		weekday
	};
}
/** 一个时刻的完整表示：调用方据此挑选知识服务声明的那种形式。 */
function encode(epochMillis, zone) {
	if (!Number.isFinite(epochMillis)) throw new Error(`not a finite instant: ${epochMillis}`);
	const p = localParts(epochMillis, zone);
	const offset = offsetMinutes(epochMillis, zone);
	const text = `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}`;
	const date = `${p.year}-${pad(p.month)}-${pad(p.day)}`;
	const uptc = localParts(epochMillis, "UTC");
	const utcText = `${uptc.year}-${pad(uptc.month)}-${pad(uptc.day)} ${pad(uptc.hour)}:${pad(uptc.minute)}:${pad(uptc.second)}`;
	const utcDate = `${uptc.year}-${pad(uptc.month)}-${pad(uptc.day)}`;
	return {
		epochMillis: Math.trunc(epochMillis),
		epochSeconds: Math.floor(epochMillis / 1e3),
		zone,
		offsetMinutes: offset,
		offset: offsetText(offset),
		utc: {
			text: utcText,
			rfc3339: `${utcDate}T${utcText.slice(11)}Z`,
			date: utcDate
		},
		local: {
			text,
			rfc3339: `${date}T${text.slice(11)}${offsetText(offset)}`,
			date,
			weekday: p.weekday,
			weekdayIndex: p.weekdayIndex
		},
		isoWeek: isoWeek(p.year, p.month, p.day)
	};
}
/** 解析调用方给的"某个时刻"：字符串按自身语法判定，不合语法就报错。 */
function parseMoment(value, zone) {
	if (value === void 0 || value === null || value === "now") return Date.now();
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new Error(`not a finite instant: ${value}`);
		return Math.trunc(value);
	}
	if (typeof value !== "string") throw new Error(`unsupported instant: ${JSON.stringify(value)}`);
	const text = value.trim();
	if (/^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.(\d{1,3}))?(Z|z|[+-]\d{2}:?\d{2})$/.exec(text) !== null) {
		const ms = Date.parse(text.replace(" ", "T"));
		if (!Number.isFinite(ms)) throw new Error(`unparsable instant: ${value}`);
		return ms;
	}
	const local = /^(\d{4})-(\d{2})-(\d{2})(?:[Tt ](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(text);
	if (local === null) throw new Error(`unparsable instant: ${JSON.stringify(value)}（要 epoch 毫秒、RFC 3339，或 "YYYY-MM-DD[ HH:MM[:SS]]"）`);
	const [, y, mo, d, h = "0", mi = "0", s = "0"] = local;
	return fromLocal(Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)), zone);
}
const UNITS = /* @__PURE__ */ new Set([
	"year",
	"quarter",
	"month",
	"week",
	"day",
	"hour",
	"minute",
	"second"
]);
const SNAPS = /* @__PURE__ */ new Set([
	"year",
	"quarter",
	"month",
	"week",
	"day"
]);
function addCalendar(localMillis, unit, amount) {
	const at = new Date(localMillis);
	const year = at.getUTCFullYear();
	const month = at.getUTCMonth();
	const day = at.getUTCDate();
	if (unit === "year") at.setUTCFullYear(year + amount);
	else if (unit === "quarter") at.setUTCMonth(month + amount * 3);
	else if (unit === "month") {
		const target = month + amount;
		at.setUTCDate(1);
		at.setUTCMonth(target);
		const lastDay = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 0)).getUTCDate();
		at.setUTCDate(Math.min(day, lastDay));
	} else at.setUTCDate(day + amount);
	return at.getTime();
}
function floorCalendar(localMillis, unit, weekStartsOn) {
	const at = new Date(localMillis);
	const year = at.getUTCFullYear();
	const month = at.getUTCMonth();
	const day = at.getUTCDate();
	if (unit === "year") return Date.UTC(year, 0, 1);
	if (unit === "quarter") return Date.UTC(year, Math.floor(month / 3) * 3, 1);
	if (unit === "month") return Date.UTC(year, month, 1);
	if (unit === "week") {
		const shift = ((at.getUTCDay() || 7) - weekStartsOn + 7) % 7;
		return Date.UTC(year, month, day - shift);
	}
	return Date.UTC(year, month, day);
}
/**
* 按顺序施加一串运算。state = { epochMillis, zone }，运算可以换时区。
* op：
*   {op:"add",   unit, amount}                日历加减（负数即减）
*   {op:"floor", unit, weekStartsOn?}         向下取整到日历边界（默认周一）
*   {op:"ceil",  unit, weekStartsOn?}         向上取整（已对齐则不动）
*   {op:"convert", zone}                      换时区（时刻不变）
*/
function applyOps(state, operations) {
	let { epochMillis, zone } = state;
	const applied = [];
	for (const raw of isArray(operations) ? operations : []) {
		const op = String(isRecord(raw) ? raw.op ?? "" : "");
		if (op === "convert") {
			zone = assertZone(String(isRecord(raw) ? raw.zone ?? "" : ""));
			applied.push(`convert → ${zone}`);
			continue;
		}
		if (op === "add") {
			const unit = String(isRecord(raw) ? raw.unit ?? "" : "");
			const amount = Number(isRecord(raw) ? raw.amount : void 0);
			if (!UNITS.has(unit)) throw new Error(`add needs a unit in ${[...UNITS].join("/")}`);
			if (!Number.isFinite(amount)) throw new Error("add needs a finite numeric amount");
			if (unit === "hour" || unit === "minute" || unit === "second") epochMillis += amount * (unit === "hour" ? 36e5 : unit === "minute" ? 6e4 : 1e3);
			else {
				const step = unit === "week" ? 7 : 1;
				epochMillis = fromLocal(addCalendar(localMillisOf(epochMillis, zone), unit === "week" ? "day" : unit, amount * step), zone);
			}
			applied.push(`add ${amount} ${unit}`);
			continue;
		}
		if (op === "floor" || op === "ceil") {
			const unit = String(isRecord(raw) ? raw.unit ?? "" : "");
			if (!SNAPS.has(unit)) throw new Error(`${op} needs a unit in ${[...SNAPS].join("/")}`);
			const requested = isRecord(raw) ? raw.weekStartsOn : void 0;
			const rawWeekStartsOn = Number.isInteger(requested) ? Number(requested) : 0;
			const weekStartsOn = rawWeekStartsOn >= 1 && rawWeekStartsOn <= 7 ? rawWeekStartsOn : 1;
			const local = localMillisOf(epochMillis, zone);
			const floored = floorCalendar(local, unit, weekStartsOn);
			let target = floored;
			if (op === "ceil" && floored < local) target = unit === "week" ? addCalendar(floored, "day", 7) : addCalendar(floored, unit, 1);
			epochMillis = fromLocal(target, zone);
			applied.push(`${op} ${unit}${unit === "week" ? `(weekStartsOn=${weekStartsOn})` : ""}`);
			continue;
		}
		throw new Error(`unsupported operation: ${JSON.stringify(raw)}`);
	}
	return {
		epochMillis,
		zone,
		applied
	};
}

//#endregion
//#region src/time-context.ts
function createTimeContext({ ctx, log }) {
	const zones = /* @__PURE__ */ new Map();
	const install = () => {
		try {
			ctx.on("agent/pre-step", async (payload, next) => {
				const decision = await next();
				const session = payload?.agent?.session;
				if (decision?.kind !== "reject" && session !== void 0) {
					const derived = deriveContextTimeZone(payload.messages);
					const carriesMessages = Array.isArray(payload.messages) && payload.messages.length > 0;
					if (derived.kind !== "missing" || carriesMessages) zones.set(session, derived);
				}
				return decision;
			});
		} catch (cause) {
			log("[oks] cannot observe agent/pre-step: " + errorText(cause));
		}
	};
	return {
		zones,
		install
	};
}

//#endregion
//#region src/response.ts
const RESULT_BUDGET_CHARS = 6e3;
const RESULT_MAX_COLUMNS = 32;
const RESULT_MAX_CELL_CHARS = 200;
const SQL_DISPLAY_CHARS = 1200;
const BINDINGS_DISPLAY_CHARS = 400;
const REQUEST_DISPLAY_CHARS = 300;
const OBJECT_OUTPUT = {
	type: "object",
	additionalProperties: true
};
function summarize(response) {
	if (response?.error === true) return `error=true · ${Array.isArray(response.diagnostics) ? response.diagnostics.length : 0} diagnostic(s)`;
	const ok = response?.ok ?? {};
	if (ok.Document !== void 0) {
		const document = ok.Document;
		if (typeof document === "string") return `error=false · Document=${document}`;
		const found = document?.Found;
		const shape = Object.keys(document ?? {})[0] ?? "Document";
		const detail = found?.detail;
		if (detail !== null && typeof detail === "object") {
			const parts = Object.entries(detail).map(([k, v]) => {
				if (Array.isArray(v)) return `${k}#${v.length}`;
				if (v !== null && typeof v === "object") return `${k}={…}`;
				return `${k}=${String(v)}`;
			}).join(" ");
			return `error=false · Document=${shape} · ${found?.type ?? "?"}${parts === "" ? "" : ` · ${parts}`}`;
		}
		return `error=false · Document=${shape} · ${found?.type ?? "?"}`;
	}
	if (ok.accepted !== void 0) {
		const diagnostics = Array.isArray(ok.diagnostics) ? ok.diagnostics : [];
		const errors = diagnostics.filter((item) => item?.diagnostic?.severity === "Error").length;
		const warnings = diagnostics.filter((item) => item?.diagnostic?.severity === "Warning").length;
		const parts = [
			"error=false",
			`accepted=${ok.accepted}`,
			`errors=${errors}`,
			`warnings=${warnings}`
		];
		if (Array.isArray(ok.queries)) parts.push(`queries=${ok.queries.length}`);
		return parts.join(" · ");
	}
	return "error=false";
}
/** 校验路径的响应：**摘掉 queries**。SQL/bindings 只在 oks_query 的结果里出现，
*  而轨迹里的响应会被工具卡与宿主日志留存，所以这里必须真的摘掉，不能只靠渲染不打印。 */
function withoutQueries(response) {
	const ok = response?.ok;
	if (ok === null || typeof ok !== "object") return response;
	const { queries: _queries, ...rest } = ok;
	return {
		...response,
		ok: rest
	};
}
/** 过程轨迹：让工具卡自己呈现「发了什么、收回了什么」。
*  请求回显只留一小段——Intent 批次可能很长，而写它的人正是读它的模型。 */
function renderTrace(trace) {
	const lines = [];
	for (const step of trace ?? []) {
		const note = step.note ? `  （${step.note}）` : "";
		lines.push(`▸ OKS ${step.method}${note}`);
		lines.push(`  请求 ${capLine(JSON.stringify(step.request), REQUEST_DISPLAY_CHARS)}`);
		lines.push(`◂ OKS ${step.method}  ${summarize(step.response)}`);
	}
	return lines;
}
/** 纯计算类工具（不经过 OKS）的渲染：直接给结构化结果。 */
function renderValue(_args, value) {
	return [{
		type: "text",
		text: `${JSON.stringify(value, null, 2)}\n`
	}];
}
/** 渲染不做形状分类：同一套 JSON 通道对任何节点都成立。 */
function renderJson(_args, value) {
	const lines = renderTrace(value?.trace);
	lines.push("", JSON.stringify(value?.trace?.[0]?.response ?? value, null, 2));
	return [{
		type: "text",
		text: `${lines.join("\n")}\n`
	}];
}
/** 诊断段：批次级诊断必须全列——成功的 Intent 也可能带 Warning。 */
function diagnosticLines(diagnostics) {
	const lines = [];
	if (!Array.isArray(diagnostics) || diagnostics.length === 0) return lines;
	lines.push("", "诊断（批次级；成功的 Intent 也可能带 Warning）");
	for (const item of diagnostics) {
		const severity = item?.diagnostic?.severity ?? "?";
		const mark = severity === "Error" ? "✕" : severity === "Warning" ? "⚠" : "·";
		lines.push(`  #${(item?.index ?? 0) + 1}  ${mark} ${severity} — ${item?.diagnostic?.message ?? JSON.stringify(item)}`);
	}
	return lines;
}
const rejectedIndexes = (diagnostics) => [...new Set((diagnostics ?? []).filter((item) => item?.diagnostic?.severity === "Error").map((item) => item.index))].sort((left, right) => left - right);
/** oks_check_intent 的模型可见渲染：只有校验结论与诊断，**没有 SQL**。 */
function renderCheck(_args, value) {
	const lines = renderTrace(value?.trace);
	const intents = value?.intents ?? [];
	lines.push(...diagnosticLines(value?.diagnostics));
	const subset = value?.subset;
	if (subset) lines.push("", `再校验一次（把没有报 Error 的 ${subset.indexes.length} 个 Intent 单独提交）：${subset.accepted ? "通过" : "仍被拒"}`);
	for (const index of rejectedIndexes(value?.diagnostics)) {
		lines.push("", `── intent #${index + 1} — 被拒绝 ──`);
		lines.push(`intent:   ${capLine(JSON.stringify(intents[index]), 600)}`);
	}
	const passed = intents.length - rejectedIndexes(value?.diagnostics).length;
	const runnable = value?.queryCount ?? 0;
	lines.push("", passed === intents.length ? `校验结论：${intents.length} 个 Intent 全部可用（${runnable} 个查询可执行）。用 oks_query 提交同一批就能拿到结果。` : `校验结论：${passed}/${intents.length} 可用（${runnable} 个查询可执行）。用 oks_info 按服务给出的 key 读它声明的词汇再修，保持业务含义不变。`);
	return [{
		type: "text",
		text: `${lines.join("\n")}\n`
	}];
}
/** 一张有预算的表：列数、单元格长度、行数都受限，截断要写明。 */
function renderTable(rows, budget) {
	if (!Array.isArray(rows) || rows.length === 0) return {
		lines: ["结果：0 行"],
		truncated: false
	};
	const allColumns = Object.keys(rows[0] ?? {});
	const columns = allColumns.slice(0, RESULT_MAX_COLUMNS);
	const cell = (value) => {
		const text = value === null || value === void 0 ? "NULL" : typeof value === "bigint" ? value.toString() : typeof value === "object" ? JSON.stringify(value) : String(value);
		return (text.length > RESULT_MAX_CELL_CHARS ? `${text.slice(0, RESULT_MAX_CELL_CHARS)}…` : text).replace(/\|/g, "\\|").replace(/\n/g, " ");
	};
	const lines = [`| ${columns.join(" | ")} |`, `| ${columns.map(() => "---").join(" | ")} |`];
	let used = lines.reduce((total, line) => total + line.length + 1, 0);
	let shown = 0;
	let truncated = false;
	for (const row of rows) {
		const line = `| ${columns.map((column) => cell(row[column])).join(" | ")} |`;
		if (used + line.length > budget) {
			truncated = true;
			break;
		}
		lines.push(line);
		used += line.length + 1;
		shown += 1;
	}
	const notes = [];
	if (allColumns.length > columns.length) notes.push(`只显示前 ${columns.length} 列（共 ${allColumns.length} 列）`);
	if (truncated) notes.push(`只显示前 ${shown} 行（共 ${rows.length} 行）`);
	return {
		lines,
		truncated,
		notes
	};
}
/** oks_query 的模型可见渲染：轨迹 → 诊断 → 每个结果的 SQL/bindings 与行。 */
function renderQuery(_args, value) {
	const lines = renderTrace(value?.trace);
	let used = lines.reduce((total, line) => total + line.length + 1, 0);
	const push = (line, ..._rest) => {
		lines.push(line);
		used += line.length + 1;
	};
	for (const line of diagnosticLines(value?.diagnostics)) push(line);
	(value?.results ?? []).forEach((result, at) => {
		push("");
		push(`── 结果 #${at + 1}（来自 intent #${result.index + 1}）──`);
		push(`sql:      ${capLine(String(result.sql).replace(/\s+/g, " "), SQL_DISPLAY_CHARS)}`);
		push(`bindings: ${capLine(JSON.stringify(result.bindings), BINDINGS_DISPLAY_CHARS)}`);
		if (result.error !== null && result.error !== void 0) {
			push(`执行失败（数据文件 ${basename(value.dataFile)}）：${result.error}`);
			return;
		}
		push(`执行：${result.rows.length} 行 · ${result.ms} ms${result.truncated ? `（已到行数上限 ${value.queryMaxRows}，结果还有更多）` : ""}`);
		const table = renderTable(result.rows, Math.max(240, RESULT_BUDGET_CHARS - used));
		for (const line of table.lines) push(line);
		for (const note of table.notes ?? []) push(`（${note}）`);
		if (result.rows.length === 0 && value?.window) push(`提示：这份数据的窗口是 [${value.window.start}, ${value.window.endExclusive})，被过滤掉的可能是时间落在窗口之外。`);
	});
	const rejected = rejectedIndexes(value?.diagnostics);
	for (const index of rejected) {
		push("");
		push(`── intent #${index + 1} — 被拒绝 ──`);
		push(`intent:   ${capLine(JSON.stringify((value?.intents ?? [])[index]), 600)}`);
	}
	if ((value?.results ?? []).length === 0) push("", rejected.length === 0 ? "没有可执行的查询。" : "没有任何 Intent 通过校验，所以没有执行。修 Intent 后再提交。");
	return [{
		type: "text",
		text: `${lines.join("\n")}\n`
	}];
}

//#endregion
//#region src/va.ts
const VA_MARKER_TEXT = "（上文问答已收起）";
/** `va/prompt.md` 里放词表的位置：插件在这行插入整份词汇。 */
const VA_VOCABULARY_MARKER = "<!-- 词表 -->";
/** 助手会话的日志级标题前缀：归档列表里认得出、将来也按它找回。 */
const VA_TITLE_PREFIX = "词汇助手（内部）";
/** 助手的专属人设：否则它会继承调用方 preset 的人设——编码 agent 与业务问答 agent 都不对。 */
const VA_PERSONA = "你是这个词表的词汇助手：提问者给一个说法（一个词、一个短语或一句话，中英不限），你回答这份词表里有哪些等价或相近的表达、各差在哪一维。词表由你读进来，只读不改；你不回答业务问题，也不碰文件。";
/** 词汇助手自己的两条提示词。装配时由插件直接发出去——不经过人，也不经过主 agent。
*  产物的 va/ 与 index.mjs 同在包根，所以是 `./va/`。 */
function readVaPrompt(name) {
	try {
		return readFileSync(new URL(`./va/${name}`, import.meta.url), "utf8").trim();
	} catch (cause) {
		throw new Error(`dsh-oks: 读不到词汇助手的提示词 va/${name}：${errorText(cause)}`);
	}
}
/** 收起之后替它们出面的标记节点。文本固定，所以它出现在哪一轮都不影响冻结前缀的缓存。 */
const vaMarker = () => ({
	id: randomUUID(),
	role: "user",
	content: [{
		type: "text",
		text: VA_MARKER_TEXT
	}],
	source: { kind: "user" }
});
/** `va_ask` 的模型可见渲染：把助手的回答原样交出。 */
function renderAsk(_args, value) {
	const lines = [];
	if (typeof value?.answer === "string" && value.answer.length > 0) lines.push(value.answer);
	else lines.push("（词汇助手这一轮没有给出文本回答。）");
	if (value?.interrupted === true) lines.push("", "注意：这一轮被中断过，上面的回答可能不完整。");
	return [{
		type: "text",
		text: `${lines.join("\n")}\n`
	}];
}
const VA_HELPER_PREFIX = "session-va-";
function createVaRuntime({ ctx, log, config, knowledge }) {
	const vaPreset = typeof config?.vaPreset === "string" && config.vaPreset.length > 0 ? config.vaPreset : "oks";
	const askedBudget = config?.vaAskTimeoutMs;
	const vaBudgetMs = typeof askedBudget === "number" && Number.isFinite(askedBudget) && askedBudget > 0 ? askedBudget : 6e5;
	const vaReasoningEffort = (() => {
		const asked = config?.vaReasoningEffort;
		if (typeof asked === "string" && asked.trim() === "inherit") return void 0;
		if (typeof asked === "string" && asked.trim().length > 0) return asked.trim();
		return "off";
	})();
	const vaHelpers = /* @__PURE__ */ new Map();
	const vaFlights = /* @__PURE__ */ new Map();
	const vaAskFlights = /* @__PURE__ */ new Map();
	const vaHelperChain = /* @__PURE__ */ new Map();
	/** 把一次咨询挂到某个键的队尾；前一条失败不影响后一条。 */
	const vaSerialOn = (map, key, task) => {
		const run = (map.get(key) ?? Promise.resolve()).then(task, task);
		const tail = run.then(() => {}, () => {});
		map.set(key, tail);
		tail.then(() => {
			if (map.get(key) === tail) map.delete(key);
		});
		return run;
	};
	/** 一次在飞的操作：后来者共享同一个 promise；落地后从表里撤掉。 */
	/** 插件自己写给助手的一条用户消息。 */
	const vaMessage = (text) => ({
		id: randomUUID(),
		role: "user",
		content: [{
			type: "text",
			text
		}],
		source: { kind: "user" }
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
			if (signal?.aborted === true) throw vaUnknownBoundary("va_ask 被取消");
			const events = session.snapshotEvents();
			for (let index = events.length - 1; index >= 0; index -= 1) {
				const event = events[index];
				if (event.type === "user/message" && event.data?.id === messageId) return event.seq;
			}
			if (Date.now() > deadline) throw vaUnknownBoundary(`${what} 在 ${budgetMs} ms 内没有落到助手的会话里`);
			await new Promise((resolve) => {
				setTimeout(resolve, 150);
			});
		}
	};
	/** 等 afterSeq 之后的第一个回合结束。不用 `whenIdle()`——刚 followup 时驱动还没起来，它会立刻返回。 */
	const vaWaitTurnEndAfter = async (session, afterSeq, signal, budgetMs, what) => {
		const deadline = Date.now() + budgetMs;
		for (;;) {
			if (signal?.aborted === true) throw vaUnknownBoundary("va_ask 被取消");
			const events = session.snapshotEvents();
			for (let index = events.length - 1; index >= 0; index -= 1) {
				const event = events[index];
				if (event.seq <= afterSeq) break;
				if (event.type === "turn/end") return event.data?.reason ?? { kind: "completed" };
			}
			if (Date.now() > deadline) throw vaUnknownBoundary(`${what} 在 ${budgetMs} ms 内没有结束`);
			await new Promise((resolve) => {
				setTimeout(resolve, 150);
			});
		}
	};
	/** 回合必须以 completed 收场——否则读词表读到一半、或回答是残的，都不能当成功。 */
	const vaRequireCompleted = (reason, what) => {
		if (reason?.kind !== void 0 && reason.kind !== "completed") throw new Error(`dsh-oks: ${what}没有正常结束（${reason.kind}）。`);
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
		return {
			sentSeq,
			reason
		};
	};
	/** 从会话日志里取 sinceSeq 之后最后一条助手文本。 */
	const vaAnswerSince = (session, sinceSeq) => {
		const events = session.snapshotEvents();
		for (let index = events.length - 1; index >= 0; index -= 1) {
			const event = events[index];
			if (event.seq < sinceSeq) break;
			if (event.type !== "assistant/message") continue;
			const text = (event.data?.message?.content ?? []).filter((block) => block?.type === "text").map((block) => String(block.text ?? "")).join("").trim();
			if (text.length === 0) continue;
			return {
				text,
				interrupted: event.data?.interrupted === true
			};
		}
		return {
			text: "",
			interrupted: false
		};
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
			const event = typeof session.eventAt === "function" ? session.eventAt(seq) : void 0;
			if (event?.type !== "system/message") return false;
			const content = event.data?.message?.content;
			return Array.isArray(content) && content.some((block) => block?.type === "text" && String(block.text ?? "").length > 0);
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
			markerSeq = session.append("user/message", vaMarker(), {
				surfaceOp: {
					op: "replace",
					startSeq,
					endSeq
				},
				sourceEventSeqs: range
			}).seq;
			shadowed += range.length;
		}
		return {
			shadowed,
			runs: runs.length,
			startSeq,
			endSeq,
			markerSeq
		};
	};
	/** 助手手里没有未回应的发送（`pending === 0`）、也没有在飞的回合时，收起一次；
	*  条件不满足就等下一次（提问之前还会再试一次）。 */
	const vaTryRewind = (helper) => {
		try {
			if (helper?.pending !== 0) {
				log(`[oks] rewind skipped · 还有 ${helper.pending} 条没被回答的发送`);
				return false;
			}
			if (helper?.agent?.status !== "idle") return false;
			const done = vaCollapse(helper.agent.session, helper.markerSeq);
			if (done !== null) {
				helper.markerSeq = done.markerSeq;
				log(`[oks] rewind · 收起 ${done.shadowed} 个表面节点（${done.runs} 段，seq ${done.startSeq}-${done.endSeq} → 标记 ${done.markerSeq}）`);
			}
			return true;
		} catch (cause) {
			log("[oks] rewind failed: " + errorText(cause));
			return false;
		}
	};
	const vaArchive = async (sessionId) => {
		const registry = ctx.get("workspaceRegistry");
		if (typeof registry?.archiveSession !== "function") return;
		try {
			await registry.archiveSession(sessionId, { stopActivity: true });
		} catch (cause) {
			log("[oks] cannot archive the vocabulary helper: " + errorText(cause));
		}
	};
	const vaUnarchive = async (sessionId) => {
		const registry = ctx.get("workspaceRegistry");
		if (typeof registry?.unarchiveSession !== "function") return;
		try {
			await registry.unarchiveSession(sessionId);
		} catch (cause) {
			log("[oks] cannot unarchive the vocabulary helper: " + errorText(cause));
		}
	};
	/** 调用方的助手：没有就建一个顶层 agent，装配好（读词表 → 收方法 → 落边界）。
	*  并发调用共享这一次装配（single flight），不会各建一个。 */
	const vaEnsureHelper = (caller, key, signal) => singleFlight(vaFlights, key, async () => {
		const existing = vaHelpers.get(key);
		if (existing !== void 0) return existing;
		const agents = ctx.get("agents");
		if (agents === void 0 || typeof agents.create !== "function") throw new Error("dsh-oks: 这个组合里没有 agent 注册表（ctx.agents），va_ask 起不了词汇助手。");
		const sessionId = `${VA_HELPER_PREFIX}${randomUUID()}`;
		const cwd = caller.session?.header?.cwd;
		if (typeof cwd !== "string" || cwd.length === 0) throw new Error("dsh-oks: 调用方会话没有 cwd，词汇助手不知道去哪个工作区读词表。");
		const options = caller.options ?? {};
		const presets = caller.ctx?.get?.("agentPresets");
		const composed = typeof presets?.composedPreset === "function" ? presets.composedPreset(caller.ctx) : void 0;
		log(`[oks] vocabulary helper preset · ${typeof composed === "string" && composed.length > 0 ? composed : `${vaPreset} (fallback)`}`);
		const helper = {
			sessionId,
			agent: (await agents.create({
				sessionId,
				meta: {
					cwd,
					agentPreset: typeof composed === "string" && composed.length > 0 ? composed : vaPreset
				},
				agentOptions: {
					...typeof options.provider === "string" ? { provider: options.provider } : {},
					...typeof options.model === "string" ? { model: options.model } : {},
					...vaReasoningEffort === void 0 ? {} : { reasoningEffort: vaReasoningEffort }
				},
				setup(agentCtx, agent) {
					const service = agentCtx.get?.("agentPresets");
					if (service === void 0 || typeof service.composeFrom !== "function") throw new Error("dsh-oks: 这个组合里没有 agentPresets 服务，没法把 preset 拼进词汇助手，它会是个空 agent。");
					service.composeFrom(agentCtx, caller.ctx);
					const prompt = agentCtx.systemPrompt;
					if (!prompt || typeof prompt.section !== "function") throw new Error("dsh-oks: 这个组合里没有 systemPrompt 服务，换不上词汇助手自己的人设。");
					prompt.section({
						name: "deployment:persona-prefix",
						order: typeof prompt.getSectionOrder === "function" ? prompt.getSectionOrder("DEPLOYMENT_PERSONA_PREFIX") : 0,
						text: VA_PERSONA
					});
					const tools = agentCtx.tools;
					if (typeof tools?.restrict !== "function") throw new Error("dsh-oks: 这个组合里没有 tools 服务，收不掉词汇助手的工具面。");
					tools.restrict({ allow: [] });
					agent.session.append("sandbox/mode", {
						mode: "read-only",
						source: "delegation"
					});
					agent.session.append("approval/policy", {
						policy: "never",
						source: "delegation"
					});
				},
				signal
			})).agent,
			pending: 0
		};
		vaHelpers.set(key, helper);
		const session = helper.agent.session;
		const titles = ctx.get?.("sessionTitle");
		if (typeof titles?.rename === "function") {
			const callerTitle = titles.get?.(caller.session)?.title;
			const suffix = typeof callerTitle === "string" && callerTitle.length > 0 ? ` · 供「${callerTitle}」咨询` : "";
			titles.rename(session, `${VA_TITLE_PREFIX}${suffix}`);
		} else log("[oks] no sessionTitle service; the vocabulary helper stays untitled");
		try {
			const entry = knowledge.ensureWorkspace({ agent: { session: caller.session } });
			const index = await knowledge.ensureIndex(entry);
			const vocabulary = renderWholeVocabulary(index);
			const template = readVaPrompt("prompt.md");
			if (!template.includes(VA_VOCABULARY_MARKER)) throw new Error(`dsh-oks: va/prompt.md 里没有 ${VA_VOCABULARY_MARKER} 占位符，词表无处可插。`);
			const feed = template.replace(VA_VOCABULARY_MARKER, vocabulary);
			log(`[oks] vocabulary fed · ${index.terms.length} 条 · ${Buffer.byteLength(feed, "utf8")} 字节 · 一条消息`);
			const read = await vaSendAndWait(helper, vaMessage(feed), signal, vaBudgetMs, "词汇助手收词表");
			vaRequireCompleted(read.reason, "词汇助手收词表");
			helper.markerSeq = read.sentSeq;
			vaTryRewind(helper);
			await vaArchive(sessionId);
		} catch (cause) {
			vaHelpers.delete(key);
			vaArchive(sessionId);
			throw new Error(`dsh-oks: 词汇助手没有装配起来：${errorText(cause)}`);
		}
		log(`[oks] vocabulary helper ready · ${sessionId} · 标记 seq ${helper.markerSeq}`);
		return helper;
	});
	/** 一次咨询：归档状态先恢复 → 把说法交给它 → 等它静止 → 取它这一轮的回答。 */
	const vaConsult = async (helper, query, signal) => {
		await vaUnarchive(helper.sessionId);
		vaTryRewind(helper);
		const session = helper.agent.session;
		const { sentSeq, reason } = await vaSendAndWait(helper, vaMessage(query), signal, vaBudgetMs, "词汇助手回答");
		vaRequireCompleted(reason, "词汇助手这一轮");
		const answer = vaAnswerSince(session, sentSeq);
		if (answer.text.length === 0) throw new Error("dsh-oks: 词汇助手这一轮没有给出文本回答（可能出错或被中断）。");
		vaTryRewind(helper);
		await vaArchive(helper.sessionId);
		return {
			helper: helper.sessionId,
			answer: answer.text,
			interrupted: answer.interrupted
		};
	};
	ctx.effect(() => () => {
		for (const helper of vaHelpers.values()) vaArchive(helper.sessionId);
	});
	const ask = async (caller, key, query, signal) => {
		const helper = await vaEnsureHelper(caller, key, signal);
		try {
			return await singleFlight(vaAskFlights, `${key}\u0000${query}`, () => vaSerialOn(vaHelperChain, helper.sessionId, async () => {
				const result = await vaConsult(helper, query, signal);
				log(`[oks] va_ask ${JSON.stringify(query)} → ${result.answer.length} 字符`);
				return result;
			}));
		} catch (error) {
			if (isRecord(error) && error.vaDirty === true) {
				vaHelpers.delete(key);
				vaArchive(helper.sessionId);
				log("[oks] vocabulary helper dropped (boundary unknown): " + errorText(error));
			}
			throw error;
		}
	};
	return { ask };
}

//#endregion
//#region src/tools.ts
function createTools({ knowledge, va, timeContext, log, config }) {
	/** 降一批 Intent。服务只在整批通过时才回 queries，所以被拒批次里没有报 Error 的子集
	*  会再提交一次——这样"5 个里坏了 1 个"仍能拿到其余 4 个的执行物。 */
	const lowerBatch = async (entry, intents, signal) => {
		const method = `${entry.settings.domain}/transform`;
		const trace = [];
		const runner = entry.runner;
		const response = await runner.send(method, { intents }, signal);
		trace.push({
			method,
			request: { intents },
			response
		});
		const rawDiagnostics = response?.ok?.diagnostics;
		const diagnostics = Array.isArray(rawDiagnostics) ? rawDiagnostics : [];
		const errors = new Set(diagnostics.filter((item) => item?.diagnostic?.severity === "Error").map((item) => item.index));
		let batch = null;
		let subset = null;
		if (response?.ok?.accepted === true && Array.isArray(response?.ok?.queries)) batch = {
			response,
			intents,
			indexes: intents.map((_intent, index) => index)
		};
		else if (entry.settings.retryAcceptedSubset !== false) {
			const indexes = intents.map((_intent, index) => index).filter((index) => !errors.has(index));
			if (indexes.length > 0 && indexes.length < intents.length) {
				const subsetIntents = indexes.map((index) => intents[index]);
				const retry = await runner.send(method, { intents: subsetIntents }, signal);
				trace.push({
					method,
					request: { intents: subsetIntents },
					response: retry,
					note: "仅未报 Error 的子集，再降一次"
				});
				const passed = retry?.ok?.accepted === true && Array.isArray(retry?.ok?.queries);
				subset = {
					indexes,
					accepted: passed
				};
				if (passed) batch = {
					response: retry,
					intents: subsetIntents,
					indexes
				};
			}
		}
		return {
			method,
			trace,
			response,
			diagnostics,
			batch,
			subset
		};
	};
	const arityError = (method, intents, toolName) => ({
		trace: [{
			method,
			request: { intents },
			response: {
				error: true,
				diagnostics: [{ message: `${toolName} requires one to five independent Intents` }]
			}
		}],
		intents,
		diagnostics: [{
			index: 0,
			diagnostic: {
				severity: "Error",
				message: `${toolName} requires one to five independent Intents`
			}
		}]
	});
	/** 上下文时区：会话不在（或没记过）时按缺失处理，与原写法 `zones.get(exec?.agent?.session)` 一致。 */
	const contextZone = (exec) => {
		const session = exec?.agent?.session;
		return session === void 0 ? void 0 : timeContext.zones.get(session);
	};
	return [
		{
			name: "oks_info",
			description: "Read one knowledge node of this workspace's knowledge service by its opaque string key. Start with key \"index\" — the one key you may supply from memory; it tells you where to go next. From there, follow the keys the service returns, whatever shape it declares, and copy each key verbatim: never construct, split or decode one. Use only the canonical IDs the service declares when writing Intents; display names and physical column names are not substitutes.",
			parameters: {
				type: "object",
				properties: { key: {
					type: "string",
					description: "Opaque knowledge key, copied verbatim from what the service returned — another node, a link, or a diagnostic. \"index\" is the one key you may supply from memory."
				} },
				required: ["key"],
				additionalProperties: false
			},
			output: {
				schema: OBJECT_OUTPUT,
				render: renderJson
			},
			async execute(args, exec) {
				const entry = knowledge.ensureWorkspace(exec);
				const method = `${entry.settings.domain}/info`;
				const request = args?.key !== void 0 && args?.key !== null ? { key: args.key } : null;
				if (request === null) return { trace: [{
					method,
					request: {},
					response: {
						error: true,
						diagnostics: [{ message: "oks_info needs a knowledge key" }]
					}
				}] };
				return { trace: [{
					method,
					request,
					response: await entry.runner.send(method, request, exec?.signal)
				}] };
			}
		},
		{
			name: "oks_search",
			description: "Find this workspace's knowledge vocabulary by name, alias or description and get what you need to address a node: its kind, its name, its owner, where the term matched and how well. Keys are not returned — compose the key with the pattern the service declares for that kind in index.detail.key_patterns, then read the node with oks_info. Use it when you know what a thing is called but not its key; narrow with kind= or dataset=, and page with skip=.",
			parameters: {
				type: "object",
				properties: {
					query: {
						type: "string",
						description: "Words to look for in a term's name, aliases or description. Matching is case-insensitive and splits camelCase and separators; every word must appear somewhere in the term. Omit it to list everything the filters allow."
					},
					kind: {
						type: "string",
						description: "Restrict to one kind of term. The kinds that are discoverable are declared by the knowledge service of this workspace; a kind outside that declaration is rejected with the declared list."
					},
					dataset: {
						type: "string",
						description: "Restrict to terms whose declared owner \"dataset\" is this one."
					},
					skip: {
						type: "number",
						description: "Start at this match (default 0). The response reports how many matches remain, so page with skip = start + matched.length."
					}
				},
				additionalProperties: false
			},
			output: {
				schema: OBJECT_OUTPUT,
				render: renderSearch
			},
			async execute(args, exec) {
				const entry = knowledge.ensureWorkspace(exec);
				const index = await knowledge.ensureIndex(entry);
				const result = searchIndex(index, args);
				log(`[oks] search query=${JSON.stringify(args?.query ?? "")} kind=${args?.kind ?? "-"} dataset=${args?.dataset ?? "-"} skip=${result.start} → ${result.total} 命中 · 返回 ${result.matched.length}${result.more === null ? "" : ` · 还有 ${result.more}`}`);
				return result;
			}
		},
		{
			name: "oks_references",
			description: "List what references a knowledge key, from the reference graph the plugin derives when the vocabulary is built. Each row names the reference kind and the referencing node's key, so you can read that node with oks_info or follow it further. Use it to see what depends on a term before you change how you address it.",
			parameters: {
				type: "object",
				properties: {
					key: {
						type: "string",
						description: "A knowledge key that exists in this artifact — composed from the declared key patterns, or taken verbatim from what a node returned."
					},
					link: {
						type: "string",
						enum: REFERENCE_KINDS,
						description: "Restrict to one reference kind."
					},
					kind: {
						type: "string",
						description: "Restrict to referencing nodes of one kind. The kinds that are discoverable are declared by the knowledge service of this workspace."
					},
					skip: {
						type: "number",
						description: "Start at this reference (default 0)."
					}
				},
				required: ["key"],
				additionalProperties: false
			},
			output: {
				schema: OBJECT_OUTPUT,
				render: renderReferences
			},
			async execute(args, exec) {
				const entry = knowledge.ensureWorkspace(exec);
				const index = await knowledge.ensureIndex(entry);
				const result = referencesOf(index, args);
				log(`[oks] references key=${result.key} link=${args?.link ?? "-"} kind=${args?.kind ?? "-"} skip=${result.start} → ${result.total} 条 · 返回 ${result.references.length}`);
				return result;
			}
		},
		{
			name: "oks_check_intent",
			description: "Validate one to five independent graph Intents against this workspace's knowledge model and report the diagnostics. Nothing is executed and no query text comes back — this is the cheap way to find out whether a batch is acceptable. All Intents are checked even if one fails, and the subset without Error diagnostics is checked again so a partially bad batch still tells you which members are good. On rejection, read the diagnostics and repair the Intent with its business meaning intact.",
			parameters: {
				type: "object",
				properties: { intents: {
					type: "array",
					description: "One to five independent graph Intents, e.g. {\"op\":\"Graph\",\"root\":\"d\",\"nodes\":[{\"id\":\"d\",\"entity\":\"<dataset id>\"}],\"edges\":[],\"select\":[],\"count\":\"d\"}. Closed Intent choices use the declared enum spelling in PascalCase (e.g. op \"Graph\", filter op \"Eq\", direction \"Desc\", row_grain \"Root\"); the entity is the declared dataset id, not the knowledge key. The service also declares the authoritative Intent syntax — read it from the knowledge nodes it points you to instead of relying on memory.",
					items: {
						type: "object",
						additionalProperties: true
					}
				} },
				required: ["intents"],
				additionalProperties: false
			},
			output: {
				schema: OBJECT_OUTPUT,
				render: renderCheck
			},
			async execute(args, exec) {
				const entry = knowledge.ensureWorkspace(exec);
				const intents = Array.isArray(args?.intents) ? args.intents : [];
				const method = `${entry.settings.domain}/transform`;
				if (intents.length < 1 || intents.length > 5) return arityError(method, intents, "oks_check_intent");
				const { trace, response, diagnostics, batch, subset } = await lowerBatch(entry, intents, exec?.signal);
				const queries = batch?.response?.ok?.queries;
				return {
					trace: trace.map((step) => ({
						...step,
						response: withoutQueries(step.response)
					})),
					intents,
					accepted: response?.ok?.accepted === true,
					diagnostics,
					subset,
					queryCount: Array.isArray(queries) ? queries.length : 0
				};
			}
		},
		{
			name: "oks_query",
			description: "Answer a business question from this workspace's data: validate one to five independent graph Intents, then run the accepted ones as read-only queries against the data file the workspace declares, returning the rows together with the statement and bindings that produced them. A rejected Intent returns diagnostics instead of rows. Use oks_check_intent first when you only want to iterate on the Intent shape.",
			parameters: {
				type: "object",
				properties: { intents: {
					type: "array",
					description: "One to five independent graph Intents, same shape as oks_check_intent accepts.",
					items: {
						type: "object",
						additionalProperties: true
					}
				} },
				required: ["intents"],
				additionalProperties: false
			},
			output: {
				schema: OBJECT_OUTPUT,
				render: renderQuery
			},
			async execute(args, exec) {
				const entry = knowledge.ensureWorkspace(exec);
				const intents = Array.isArray(args?.intents) ? args.intents : [];
				const method = `${entry.settings.domain}/transform`;
				if (intents.length < 1 || intents.length > 5) return {
					...arityError(method, intents, "oks_query"),
					results: [],
					dataFile: entry.settings.dataFile ?? null
				};
				const { trace, response, diagnostics, batch } = await lowerBatch(entry, intents, exec?.signal);
				const answers = {
					trace,
					intents,
					accepted: response?.ok?.accepted === true,
					diagnostics,
					results: [],
					dataFile: entry.settings.dataFile ?? null,
					window: null,
					queryMaxRows: entry.settings.queryMaxRows
				};
				if (batch === null) return answers;
				const { executor, manifest } = knowledge.executorFor(entry.settings);
				answers.window = manifest?.window ?? null;
				const queries = batch.response?.ok?.queries ?? [];
				for (let at = 0; at < queries.length; at += 1) {
					const query = queries[at];
					const index = batch.indexes[at] ?? at;
					const sql = String(query?.sql ?? "");
					const bindings = isArray(query?.bindings) ? query.bindings : [];
					const started = Date.now();
					try {
						const outcome = await executor.send(sql, bindings, exec?.signal);
						const ms = Date.now() - started;
						answers.results.push({
							index,
							sql,
							bindings,
							rows: outcome.rows,
							truncated: outcome.truncated,
							error: null,
							ms
						});
						log(`[oks] query intent#${index + 1} → ${outcome.rows.length}${outcome.truncated ? "+" : ""} row(s) · ${ms} ms · sql=${capLine(sql.replace(/\s+/g, " "), 200)} · bindings=${capLine(JSON.stringify(bindings), 200)}`);
					} catch (cause) {
						const ms = Date.now() - started;
						const message = errorText(cause);
						answers.results.push({
							index,
							sql,
							bindings,
							rows: null,
							truncated: false,
							error: message,
							ms
						});
						log(`[oks] query intent#${index + 1} failed after ${ms} ms: ${message}`);
					}
				}
				return answers;
			}
		},
		{
			name: "time_now",
			description: "Read the current instant from the host clock in several standard forms — epoch milliseconds and seconds, UTC text, RFC 3339, local text with its UTC offset, calendar date, and ISO week. The knowledge service never reads the clock, so every relative expression (\"last week\", \"the last 24 hours\") has to become an absolute boundary before it is submitted: resolve it here, state the time zone you used, and pick whichever form the knowledge node itself declares. This tool knows nothing about domain time formats.",
			parameters: {
				type: "object",
				properties: { timeZone: {
					type: "string",
					description: "IANA time zone such as \"Asia/Shanghai\". By default the zone comes from the request context — the browser zone the client attached to the current turn messages, read per the plugin spec — so pass one only to override it (for example when the context zone is mixed or missing). The zone comes from the request context or from this argument; with neither, the call fails and asks you to confirm it with the user. The source actually used is echoed back."
				} },
				additionalProperties: false
			},
			output: {
				schema: OBJECT_OUTPUT,
				render: renderValue
			},
			async execute(args, exec) {
				const { zone, source } = resolveZone(args?.timeZone, contextZone(exec));
				return {
					timeZone: zone,
					timeZoneSource: source,
					...encode(Date.now(), zone)
				};
			}
		},
		{
			name: "time_calc",
			description: "Apply ordered calendar arithmetic to an instant and return every standard form of the result: add (year/quarter/month/week/day/hour/minute/second), floor/ceil to a calendar boundary (weeks start on Monday unless weekStartsOn is given), and convert between time zones. Day and week arithmetic keeps the local wall clock, so a day across a daylight-saving change is not always 24 hours; month/quarter/year addition clamps to the last valid day. Intervals are half-open [start, end), so compute both ends. base accepts \"now\" (the default), epoch milliseconds as a number, RFC 3339 text, or zone-less text \"YYYY-MM-DD[ HH:MM[:SS]]\" read as local time in the given zone.",
			parameters: {
				type: "object",
				properties: {
					base: {
						oneOf: [{ type: "string" }, { type: "number" }],
						description: "\"now\" (default), epoch milliseconds as a number, RFC 3339 text, or zone-less \"YYYY-MM-DD[ HH:MM[:SS]]\" read as local time in timeZone."
					},
					timeZone: {
						type: "string",
						description: "IANA time zone such as \"Asia/Shanghai\". By default the zone comes from the request context — the browser zone the client attached to the current turn messages, read per the plugin spec — so pass one only to override it (for example when the context zone is mixed or missing). The zone comes from the request context or from this argument; with neither, the call fails and asks you to confirm it with the user. The source actually used is echoed back."
					},
					operations: {
						type: "array",
						description: "Applied in order, e.g. {\"op\":\"add\",\"unit\":\"month\",\"amount\":-1}, {\"op\":\"floor\",\"unit\":\"week\",\"weekStartsOn\":1}, {\"op\":\"ceil\",\"unit\":\"day\"}, {\"op\":\"convert\",\"zone\":\"UTC\"}.",
						items: {
							type: "object",
							additionalProperties: true
						}
					}
				},
				additionalProperties: false
			},
			output: {
				schema: OBJECT_OUTPUT,
				render: renderValue
			},
			async execute(args, exec) {
				const { zone, source } = resolveZone(args?.timeZone, contextZone(exec));
				const base = parseMoment(args?.base, zone);
				const result = applyOps({
					epochMillis: base,
					zone
				}, args?.operations);
				return {
					timeZone: result.zone,
					timeZoneSource: source,
					base: {
						input: args?.base ?? "now",
						...encode(base, zone)
					},
					operations: result.applied,
					...encode(result.epochMillis, result.zone)
				};
			}
		},
		{
			name: "va_ask",
			description: "Consult this session's vocabulary helper and get its answer back: send one paraphrase — a word, a phrase or a sentence, any language — and you receive the vocabulary's equivalent or near expressions, each with the dimension it differs on. The helper reads the whole vocabulary once, so the first call sets it up and takes longer; each later call is one question. Treat what it returns as leads: look the strings up with oks_search and read the declarations with oks_info.",
			parameters: {
				type: "object",
				properties: { query: {
					type: "string",
					description: "The paraphrase to consult about, e.g. \"丢包\" or \"port pressure\"."
				} },
				required: ["query"],
				additionalProperties: false
			},
			output: {
				schema: OBJECT_OUTPUT,
				render: renderAsk
			},
			async execute(args, exec) {
				const query = typeof args?.query === "string" ? args.query.trim() : "";
				if (query.length === 0) throw new Error("dsh-oks: va_ask 需要一个说法（query）。");
				const caller = exec?.agent;
				const key = caller?.session?.id;
				if (typeof key === "string" && key.startsWith("session-va-")) throw new Error("dsh-oks: 词汇助手不咨询自己。");
				if (caller === void 0 || typeof key !== "string" || key.length === 0) throw new Error("dsh-oks: 无法确定调用方会话，va_ask 需要它来记住词汇助手。");
				return va.ask(caller, key, query, exec?.signal);
			}
		}
	];
}

//#endregion
//#region src/index.ts
const inject = ["tools"];
function apply(ctx, config = {}) {
	const log = (message) => {
		try {
			const logger = ctx.logger;
			if (logger?.info) logger.info(message);
			else console.error(message);
		} catch {
			console.error(message);
		}
	};
	const timeContext = createTimeContext({
		ctx,
		log
	});
	timeContext.install();
	const knowledge = createKnowledge({
		ctx,
		log,
		config
	});
	const va = createVaRuntime({
		ctx,
		log,
		config,
		knowledge
	});
	const definitions = createTools({
		knowledge,
		va,
		timeContext,
		log,
		config
	});
	for (const definition of definitions) {
		const dispose = ctx.tools.register(definition);
		if (typeof dispose === "function") ctx.effect(() => dispose);
	}
	ctx.effect(() => knowledge.dispose);
}

//#endregion
export { apply, inject };