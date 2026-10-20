// 加工求值层：把一份 JSON 输入交给求值器，取回它输出的单个值。
//
// **求值器从哪来**是实现细节，不泄进工具契约：这一版是我们自己编的 wasm 引擎
// （`crates/oks-wti`：jaq 的库 + 白名单 builtin），就是与 `index.mjs` **同目录**的
// `oks-wti.wasm` —— 没有环境、没有时钟、没有文件系统（见 rfc/0009）。
//
// 为什么放 worker：死循环只能靠超时 `terminate()` 兜住；worker 是唯一能被强杀的边界。
// trap（栈溢出之类）同样使整代实例失效，下一次调用重新装载。
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import type { JsonValue } from './project.ts';
import { JAQ_WORKER_SOURCE } from './jaq-worker.ts';

export type JaqOutcome =
  | { ok: true; data: unknown }
  | { ok: false; shape: JsonValue };

export interface JaqOptions {
  /** 表达式作用的输入值（按资源名组装成对象）。 */
  input: unknown;
  /** 墙钟上限，到点终止这一代 worker。 */
  timeoutMs: number;
  /** 输出 UTF-8 字节预算：引擎有界序列化，超限时返回该值的形状。 */
  maxBytes: number;
  signal?: AbortSignal;
  /** 程序来自哪个文件（`jq.src` 指向的那一份）：用于报错定位，正文由调用方通过 query 提供。 */
  programFile?: string;
  /** 常驻文档在程序输入对象中的键名；省略时直接在文档上求值。 */
  inputName?: string;
}

export type JaqDiagnostic = {path:string;stage:string;message:string;start:number;end:number;related:{start:number;end:number}[]};
export class JaqCompileError extends Error {
  readonly diagnostics:JaqDiagnostic[];
  constructor(message:string,diagnostics:JaqDiagnostic[] = []) { super(message);this.name='JaqCompileError';this.diagnostics=diagnostics; }
}

export type JaqCheckOptions = Pick<JaqOptions, 'timeoutMs' | 'signal' | 'programFile'>;

/** 引擎的位置：与 `index.mjs` 同目录（profile 里是 `link:` 装的，运行时就是这个 `lib/`）。 */
const enginePath = (): string => join(dirname(fileURLToPath(import.meta.url)), 'oks-wti.wasm');

/** 引擎回的两种东西：报错文本、完整单值，或超限值的形状。 */
type EngineReply =
  | { status: 1; message: string }
  | { status: 3; data: {message:string;diagnostics:JaqDiagnostic[]} }
  | { status: 0; data: unknown }
  | { status: 2; data: JsonValue };

interface Pending {
  resolve: (value: EngineReply) => void;
  reject: (error: unknown) => void;
  timer: NodeJS.Timeout;
}

interface WorkerMessage {
  kind?: string;
  id?: number;
  response?: EngineReply;
  error?: string;
  trap?: string;
}

/** 一个执行器独占 worker / Wasm 实例；知识执行器与计算器复用代码、隔离状态。 */
export function createJaqEngine(wasmPath = enginePath()) {
  let worker: Worker | null = null;
  const pending = new Map<number, Pending>();
  let nextId = 1;
  let loaded: { worker: Worker; promise: Promise<number> } | undefined;

  const failAll = (error: unknown): void => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
  };
  const discard = (target: Worker, error: unknown): void => {
    if (worker !== target) return;
    worker = null;
    loaded = undefined;
    void target.terminate();
    failAll(error);
  };
  const spawn = (): Worker => {
    const wasm = wasmPath;
    if (!existsSync(wasm)) throw new Error(`找不到求值器 ${wasm}：请先构建 oks-wti.wasm。`);
    const created = new Worker(JAQ_WORKER_SOURCE, { eval: true, workerData: { wasm } });
    created.on('message', (message: WorkerMessage) => {
      if (worker !== created || message.kind === 'ready') return;
      // trap 使实例失效：整代排队请求失败，下次调用重新装载，旧 handle 不会进入新实例。
      if (message.trap !== undefined) {
        discard(created, new Error(`jaq 求值失败（引擎 trap：${message.trap}）`));
        return;
      }
      const entry = message.id === undefined ? undefined : pending.get(message.id);
      if (entry === undefined) return;
      pending.delete(message.id as number);
      clearTimeout(entry.timer);
      if (message.error !== undefined) entry.reject(new Error(message.error));
      else entry.resolve(message.response as EngineReply);
    });
    created.on('error', (cause: Error) => discard(created, cause));
    created.on('exit', (code) => discard(created, new Error(`jaq 求值器 worker 退出（退出码 ${code}）`)));
    worker = created;
    return created;
  };
  const send = (target: Worker, message: Record<string, unknown>, options: JaqCheckOptions): Promise<EngineReply> =>
    new Promise((resolve, reject) => {
      if (options.signal?.aborted === true) { reject(new Error('aborted')); return; }
      if (worker !== target) { reject(new Error('jaq 实例已失效，请重新调用')); return; }
      const id = nextId++;
      const onAbort = (): void => discard(target, new Error('aborted'));
      const timer = setTimeout(() => discard(target,
        new Error(`jaq 求值超过 ${options.timeoutMs} ms（已终止）`)), options.timeoutMs);
      const finish = (): void => options.signal?.removeEventListener('abort', onAbort);
      pending.set(id, {
        timer,
        resolve: (reply) => { finish(); resolve(reply); },
        reject: (error) => { finish(); reject(error); },
      });
      options.signal?.addEventListener('abort', onAbort, { once: true });
      target.postMessage({ ...message, id });
    });
  const outcome = (reply: EngineReply): JaqOutcome => {
    if (reply.status === 1) throw new Error(`jaq 表达式执行失败：\n${reply.message}`);
    if (reply.status === 3) throw new JaqCompileError(reply.data.message,reply.data.diagnostics);
    return reply.status === 2 ? { ok: false, shape: reply.data } : { ok: true, data: reply.data };
  };
  const program = (query: string, options: JaqOptions) => ({
    program: query, path: options.programFile ?? '', maxBytes: options.maxBytes,
  });
  const run = async (query: string, options: JaqOptions): Promise<JaqOutcome> => {
    if (options.signal?.aborted === true) throw new Error('aborted');
    const target = worker ?? spawn();
    return outcome(await send(target, {
      ...program(query, options), input: JSON.stringify(options.input ?? null),
    }, options));
  };
  /** Compiles using the exact runtime whitelist, without evaluating an arbitrary test input. */
  const check = async (query: string, options: JaqCheckOptions): Promise<{ cached: boolean }> => {
    if (options.signal?.aborted === true) throw new Error('aborted');
    const target = worker ?? spawn();
    const reply = await send(target, {
      kind: 'check', program: query, path: options.programFile ?? '',
    }, options);
    if (reply.status === 1) throw new JaqCompileError(reply.message);
    if (reply.status === 3) throw new JaqCompileError(reply.data.message,reply.data.diagnostics);
    const result = outcome(reply);
    if (!result.ok || !result.data || typeof result.data !== 'object' ||
        typeof (result.data as { cached?: unknown }).cached !== 'boolean') {
      throw new Error('jaq 编译检查未返回有效状态');
    }
    return result.data as { cached: boolean };
  };
  // 每个知识执行器只绑定一份文档。Promise 成功后保留，失败移除，随实例失效。
  const runDocument = async (query: string, document: unknown, options: JaqOptions): Promise<JaqOutcome> => {
    if (options.signal?.aborted === true) throw new Error('aborted');
    const target = worker ?? spawn();
    if (loaded?.worker !== target) {
      const promise = send(target, { kind: 'load', input: JSON.stringify(document) }, options)
        .then((reply) => {
          const result = outcome(reply);
          if (!result.ok) throw new Error('jaq 文档装载返回了超限状态');
          const handle = result.data;
          if (typeof handle !== 'number' || !Number.isInteger(handle) || handle < 1) {
            throw new Error('jaq 文档装载没有返回有效 handle');
          }
          return handle;
        });
      const record = { worker: target, promise };
      loaded = record;
      void promise.catch(() => { if (loaded === record) loaded = undefined; });
    }
    const handle = await loaded.promise;
    return outcome(await send(target, { ...program(query, options), handle, inputName: options.inputName }, options));
  };
  const dispose = (): void => {
    if (worker !== null) discard(worker, new Error('jaq 引擎已释放'));
  };
  return { run, runDocument, check, dispose };
}

const calculator = createJaqEngine();
/** 程序正文由调用方读取一次，programFile 仅用于诊断定位。 */
export const runJaq = calculator.run;
export const checkJaq = calculator.check;
export const disposeJaqEngine = calculator.dispose;
