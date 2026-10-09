import { Worker } from 'node:worker_threads';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { hasSnapshot } from './config.ts';
import type { Settings } from './config.ts';
import { errorText, isRecord } from './host.ts';
import type { LogFn, ServiceResponse } from './host.ts';

/** 数据目录清单（若在）：数据窗口与来源 revision。 */
export interface DataManifest {
  window: { start: string; endExclusive: string } | null;
  revision: string | null;
}

/** wasm 宿主：接口只有 { send(method, input, signal), dispose() }。 */
export interface Runner {
  send(method: string, input: unknown, signal?: AbortSignal): Promise<ServiceResponse>;
  dispose(): void;
}

/** 只读执行器取回的一页：行、是否截断，以及 SQL 元数据给的列名（空结果也有）。 */
export interface QueryOutcome {
  rows: Array<Record<string, unknown>>;
  truncated: boolean;
  columns: string[];
}

/** 只读查询执行器：接口是 { send(sql, bindings, signal, maxRows), dispose() }。
 *  maxRows 由调用方按该 Intent 的 limit 给出（缺省才回落到 queryMaxRows）。 */
export interface Executor {
  send(sql: string, bindings: unknown[], signal?: AbortSignal, maxRows?: number): Promise<QueryOutcome>;
  dispose(): void;
}

/** worker 回包：ready / 应答 / 错误三种。 */
interface RunnerReply {
  kind?: string;
  restored?: number;
  id: number;
  response: ServiceResponse;
  error?: string;
}

interface ExecutorReply {
  kind?: string;
  id: number;
  rows: Array<Record<string, unknown>>;
  truncated: boolean;
  columns?: string[];
  error?: string;
}

interface Pending<T> {
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
  timer: NodeJS.Timeout;
}

// 宿主 worker 的源码，eval 内联，插件因此保持单文件。
// 放 worker 是为了能强杀：死循环只能靠超时 terminate() 兜住。
//
// ABI：零导入；mem-alloc 写请求；run-service(in_ptr,in_len,1,0,record)，
// record 是 12 字节 (out_ptr,out_len,out_cap)。
export const WORKER_SOURCE = [
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
export function createWorkerRunner(config: Settings, log: LogFn): Runner {
  const pending = new Map<number, Pending<ServiceResponse>>();
  let worker: Worker | null = null;
  let nextId = 1;

  const failAll = (error: unknown): void => {
    for (const [, entry] of pending) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
  };

  const spawn = (): Worker => {
    const created = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: { artifact: config.artifact },
    });
    // 初始化失败（或之后崩溃）都当作这一代的死亡；下一次 send 会重新拉起。
    created.on('message', (message: RunnerReply) => {
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
    created.on('error', (cause: Error) => {
      log(`[oks] worker error: ${errorText(cause)}`);
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

  const send = (method: string, input: unknown, signal?: AbortSignal): Promise<ServiceResponse> =>
    new Promise<ServiceResponse>((resolve, reject) => {
    if (signal?.aborted) { reject(new Error('aborted')); return; }
    const line = JSON.stringify({ method, input });
    let target = worker;
    if (target === null) target = spawn();
    const id = nextId; nextId += 1;
    const timer = setTimeout(() => {
      // 到点终止整个 worker 代。
      pending.delete(id);
      const dead = worker; worker = null;
      if (dead !== null) dead.terminate();
      reject(new Error(`wasm request timed out after ${config.requestTimeoutMs} ms (worker terminated)`));
    }, config.requestTimeoutMs);
    pending.set(id, { resolve, reject, timer });
    target.postMessage({ id, line });
  }).catch((cause: unknown) => {
    log(`[oks] worker request failed: ${errorText(cause)}`);
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
export function createRunner(config: Settings, log: LogFn): Runner {
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
export const EXECUTOR_SOURCE = [
  "const { parentPort, workerData } = require('node:worker_threads');",
  "const { DatabaseSync } = require('node:sqlite');",
  'const READ_ONLY = /^\\s*(select|with)\\b/i;',
  'let db = null;',
  'function open() { db = new DatabaseSync(workerData.dataFile, { readOnly: true }); }',
  'function run(sql, bindings, maxRows) {',
  '  if (!READ_ONLY.test(sql)) throw new Error(\'only read-only SELECT/WITH statements are executed\');',
  '  if (db === null) open();',
  '  const statement = db.prepare(sql);',
  // 列名取自 SQL 元数据，空结果也能拿到（结果文件因此始终有列信息）。
  '  const columns = typeof statement.columns === \'function\' ? statement.columns().map((column) => column.name) : [];',
  '  const rows = []; let truncated = false;',
  '  for (const row of statement.iterate(...bindings)) {',
  '    if (rows.length >= maxRows) { truncated = true; break; }',
  '    rows.push(row);',
  '  }',
  '  return { rows: rows, truncated: truncated, columns: columns };',
  '}',
  "parentPort.postMessage({ kind: 'ready' });",
  "parentPort.on('message', (message) => {",
  '  try {',
  '    const result = run(message.sql, message.bindings || [], message.maxRows);',
  "    parentPort.postMessage({ id: message.id, rows: result.rows, truncated: result.truncated, columns: result.columns });",
  '  } catch (cause) {',
  "    parentPort.postMessage({ id: message.id, error: String((cause && cause.message) || cause) });",
  '  }',
  '});',
].join('\n');

/** 只读查询执行器：一个数据文件一个 worker，超时 terminate 并复活。
 *  接口是 { send(sql, bindings, signal), dispose() }。 */
export function createExecutor(config: Settings, log: LogFn): Executor {
  const pending = new Map<number, Pending<QueryOutcome>>();
  let worker: Worker | null = null;
  let nextId = 1;

  const failAll = (error: unknown): void => {
    for (const [, entry] of pending) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
  };

  const spawn = (): Worker => {
    const created = new Worker(EXECUTOR_SOURCE, {
      eval: true,
      workerData: { dataFile: config.dataFile },
    });
    created.on('message', (message: ExecutorReply) => {
      if (message?.kind === 'ready') { log(`[oks] executor ready (read-only ${config.dataFile})`); return; }
      const entry = pending.get(message?.id);
      if (entry === undefined) return;
      pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error !== undefined) entry.reject(new Error(message.error));
      else entry.resolve({ rows: message.rows, truncated: message.truncated, columns: message.columns ?? [] });
    });
    // 同模型宿主：晚到的旧代 exit 不能影响新一代的排队请求。
    created.on('error', (cause: Error) => {
      log(`[oks] executor error: ${errorText(cause)}`);
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

  const send = (
    sql: string,
    bindings: unknown[],
    signal?: AbortSignal,
    maxRows?: number,
  ): Promise<QueryOutcome> =>
    new Promise<QueryOutcome>((resolve, reject) => {
    if (signal?.aborted) { reject(new Error('aborted')); return; }
    let target = worker;
    if (target === null) target = spawn();
    const id = nextId; nextId += 1;
    const timer = setTimeout(() => {
      pending.delete(id);
      const dead = worker; worker = null;
      if (dead !== null) dead.terminate();
      reject(new Error(`query timed out after ${config.queryTimeoutMs} ms (executor terminated)`));
    }, config.queryTimeoutMs);
    pending.set(id, { resolve, reject, timer });
    target.postMessage({ id, sql, bindings, maxRows: maxRows ?? config.queryMaxRows });
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
export function readDataManifest(dataFile: string): DataManifest | null {
  try {
    const manifest: unknown = JSON.parse(readFileSync(join(dirname(dataFile), 'manifest.json'), 'utf8'));
    if (manifest === null || typeof manifest !== 'object') return null;
    // JSON 结果当字典读——原写法就是 typeof === 'object'，数组也走得通。
    const source = manifest as Record<string, unknown>;
    let windowValue: DataManifest['window'] = null;
    if (isRecord(source.window)) {
      const start = source.window.start;
      const endExclusive = source.window.endExclusive;
      if (typeof start === 'string' && typeof endExclusive === 'string') {
        windowValue = { start, endExclusive };
      }
    }
    return {
      window: windowValue,
      revision: typeof source.revision === 'string' ? source.revision : null,
    };
  } catch {
    return null;
  }
}
