// 加工求值层：把一份 JSON 输入交给求值器，取回它输出的值流。
//
// **求值器从哪来**是实现细节，不泄进工具契约：这一版是我们自己编的 wasm 引擎
// （`crates/oks-wti`：jaq 的库 + 白名单 builtin），就是与 `index.mjs` **同目录**的
// `oks-wti.wasm` —— 没有环境、没有时钟、没有文件系统（见 rfc/0009）。
//
// 为什么放 worker：死循环只能靠超时 `terminate()` 兜住；worker 是唯一能被强杀的边界。
// trap（栈溢出之类）则不需要杀：worker 自己「丢弃重建」实例，宿主这一侧照常收发。
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { errorText } from './host.ts';
import { JAQ_WORKER_SOURCE } from './jaq-worker.ts';

export interface JaqOutcome {
  /** 程序产出的值流（引擎回的是一份 JSON 数组，宿主只解析一次）。 */
  values: unknown[];
  /** 输出是否到达上限而被截断。 */
  truncated: boolean;
}

export interface JaqOptions {
  /** 表达式作用的输入值（工具那一层把具名输入绑成一个对象）。 */
  input: unknown;
  /** 墙钟上限，到点终止这一代 worker。 */
  timeoutMs: number;
  /** 输出字符上限：**引擎自己**到点就停并标记截断（不会先造出一个巨大的串再截）。 */
  maxChars: number;
  signal?: AbortSignal;
  /** 程序来自哪个文件（`byFile` 给出的那一份）：读出来交给引擎，报错里写**这个名字**。 */
  programFile?: string;
  /** 配 `programFile` 用：相对路径按它解析（工作区根）。 */
  cwd?: string;
}

/** 引擎的位置：与 `index.mjs` 同目录（profile 里是 `link:` 装的，运行时就是这个 `lib/`）。 */
const enginePath = (): string => join(dirname(fileURLToPath(import.meta.url)), 'oks-wti.wasm');

/** 引擎回的两种东西：报错文本，或者值流（`2` = 到上限被截断）。 */
type EngineReply =
  | { status: 1; message: string }
  | { status: 0 | 2; values: unknown[] };

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

let worker: Worker | null = null;
const pending = new Map<number, Pending>();
let nextId = 1;

const failAll = (error: unknown): void => {
  for (const [, entry] of pending) {
    clearTimeout(entry.timer);
    entry.reject(error);
  }
  pending.clear();
};

const spawn = (): Worker => {
  const wasm = enginePath();
  if (!existsSync(wasm)) {
    throw new Error(`找不到求值器 ${wasm}：它是与 index.mjs 同目录的旁资产，用 \`pnpm run wasm\` 构建它。`);
  }
  const created = new Worker(JAQ_WORKER_SOURCE, { eval: true, workerData: { wasm } });
  created.on('message', (message: WorkerMessage) => {
    if (message.kind === 'ready') return;
    const entry = message.id === undefined ? undefined : pending.get(message.id);
    if (entry === undefined) return;
    pending.delete(message.id as number);
    clearTimeout(entry.timer);
    if (message.error !== undefined) entry.reject(new Error(message.error));
    else if (message.trap !== undefined) entry.reject(new Error(`jaq 求值失败（引擎 trap：${message.trap}）`));
    else entry.resolve(message.response as EngineReply);
  });
  // 只有**当前这一代**的死亡才能影响排队请求：被超时 terminate 的旧代，退出事件会晚到。
  created.on('error', (cause: Error) => {
    if (worker !== created) return;
    worker = null;
    failAll(cause);
  });
  created.on('exit', (code) => {
    if (worker !== created) return;
    worker = null;
    failAll(new Error(`jaq 求值器 worker 退出（退出码 ${code}）`));
  });
  worker = created;
  return created;
};

/** 程序从哪来：给了 `programFile` 就自己读（报错里写字**相对**的那个名字，不是绝对路径）。 */
const readProgram = (query: string, options: JaqOptions): { program: string; path: string } => {
  if (options.programFile === undefined) return { program: query, path: '' };
  const root = options.cwd ?? process.cwd();
  const file = isAbsolute(options.programFile) ? options.programFile : resolve(root, options.programFile);
  let program: string;
  try {
    program = readFileSync(file, 'utf8');
  } catch (cause) {
    throw new Error(`读不到程序文件 ${options.programFile}：${errorText(cause)}`);
  }
  return { program, path: options.programFile };
};

/** 跑一次：表达式（或它所在的文件）与输入交给引擎，取回值流。 */
export const runJaq = (query: string, options: JaqOptions): Promise<JaqOutcome> => {
  let prepared: { program: string; path: string };
  try {
    prepared = readProgram(query, options);
  } catch (cause) {
    return Promise.reject(cause);
  }
  const input = JSON.stringify(options.input ?? null);
  return new Promise<JaqOutcome>((resolve, reject) => {
    if (options.signal?.aborted === true) {
      reject(new Error('aborted'));
      return;
    }
    let target: Worker;
    try {
      target = worker ?? spawn();
    } catch (cause) {
      reject(cause);
      return;
    }
    const id = nextId;
    nextId += 1;
    const kill = (): void => {
      const dead = worker;
      worker = null;
      if (dead !== null) void dead.terminate();
    };
    const onAbort = (): void => {
      pending.delete(id);
      kill();
      reject(new Error('aborted'));
    };
    const timer = setTimeout(() => {
      options.signal?.removeEventListener('abort', onAbort);
      pending.delete(id);
      kill();
      reject(new Error(`jaq 求值超过 ${options.timeoutMs} ms（已终止）`));
    }, options.timeoutMs);
    options.signal?.addEventListener('abort', onAbort, { once: true });
    pending.set(id, {
      resolve: (response) => {
        options.signal?.removeEventListener('abort', onAbort);
        // 状态 1 是编译期或运行时错误（连排版都是引擎自己的，和 jaq CLI 同一套）。
        if (response.status === 1) reject(new Error(`jaq 表达式执行失败：\n${response.message}`));
        else resolve({ values: response.values, truncated: response.status === 2 });
      },
      reject,
      timer,
    });
    target.postMessage({
      id, program: prepared.program, path: prepared.path, input, maxChars: options.maxChars,
    });
  });
};

/** 插件卸载时收掉 worker：它是常驻的，不收会拖着事件循环。 */
export const disposeJaqEngine = (): void => {
  failAll(new Error('jaq 引擎已释放'));
  const dead = worker;
  worker = null;
  if (dead !== null) void dead.terminate();
};
