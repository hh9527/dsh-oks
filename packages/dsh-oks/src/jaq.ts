// 结构化查询的求值层：把「行对象数组」交给一个 jaq 表达式，取回结果。
//
// 为什么单独一层：**求值器从哪来**是实现细节，不该泄进工具契约。这一版走系统里的 jaq 可执行文件
// （`spawn`，不经 shell，因此表达式里没有命令注入面）；将来换成内嵌求值器或内置子集，只改这个文件。
//
// 契约只到这里为止：输入是一个行对象数组，输出是若干 JSON 值。结果文件的内部结构
// （name/key/at/intent/columns/rowCount）不进这一层，也不进 agent 的视野。

import { spawn } from 'node:child_process';

export interface JaqOutcome {
  /** jaq 的紧凑输出，一行一个值。 */
  text: string;
  /** 输出是否到达上限而被截断（截断时进程已被终止）。 */
  truncated: boolean;
}

export interface JaqOptions {
  /** 表达式作用的输入值（这里始终是行对象数组）。 */
  input: unknown;
  /** 墙钟上限，到点终止。 */
  timeoutMs: number;
  /** 输出的字符上限，到点终止并标记截断。 */
  maxChars: number;
  /** 可执行文件名，默认 'jaq'。 */
  binary?: string;
  signal?: AbortSignal;
}

/** 跑一次 jaq：表达式从 stdin 取输入，结果从 stdout 读回。 */
export const runJaq = (query: string, options: JaqOptions): Promise<JaqOutcome> =>
  new Promise<JaqOutcome>((resolve, reject) => {
    const binary = options.binary ?? 'jaq';
    const child = spawn(binary, ['-c', query], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    let truncated = false;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (done: () => void): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      done();
    };
    const abort = (): void => {
      child.kill('SIGKILL');
    };
    const onAbort = (): void => {
      abort();
      finish(() => reject(new Error('aborted')));
    };
    timer = setTimeout(() => {
      abort();
      finish(() => reject(new Error(`jaq 求值超过 ${options.timeoutMs} ms（已终止）`)));
    }, options.timeoutMs);
    if (options.signal?.aborted === true) {
      onAbort();
      return;
    }
    options.signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (truncated) return;
      out += chunk;
      if (out.length > options.maxChars) {
        truncated = true;
        // 回退到最后一个换行：jaq -c 一行一个值，切在行中间会把一个 JSON 值劈成两半，
        // 调用方解析时就会把残片当成结果。
        const cut = out.lastIndexOf('\n');
        out = cut > 0 ? out.slice(0, cut) : '';
        abort();
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      if (err.length < 8000) err += chunk;
    });
    child.on('error', (cause: NodeJS.ErrnoException) => {
      // 这台机器没有 jaq 的时候就是 ENOENT：给一句能照着做的错误，而不是一个 errno。
      const message = cause.code === 'ENOENT'
        ? `这台机器上没有 jaq（找不到可执行文件 ${binary}）：结构化查询暂不可用。`
        : `jaq 启动失败：${cause.message}`;
      finish(() => reject(new Error(message)));
    });
    child.on('close', (code: number | null) => {
      if (truncated) {
        finish(() => resolve({ text: out, truncated: true }));
        return;
      }
      if (code === 0) {
        finish(() => resolve({ text: out, truncated: false }));
        return;
      }
      // jaq 的错误信息带位置指示，对写表达式的人很有用，尽量原样带回去。
      const detail = err.trim().slice(0, 600);
      finish(() => reject(new Error(`jaq 表达式执行失败（退出码 ${code}）：${detail === '' ? '(没有错误输出)' : detail}`)));
    });
    child.stdin.on('error', () => { /* 进程被终止时写 stdin 可能报错，忽略 */ });
    child.stdin.end(JSON.stringify(options.input ?? null));
  });
