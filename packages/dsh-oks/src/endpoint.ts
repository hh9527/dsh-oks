// 界面的**机械通道**：插件在宿主的 web 服务上开一对同源端点。
//
//   GET  /oks/artifacts?sessionId=…   → 这个工作区的制品清单（界面要的就这些）
//   POST /oks/pin                     → 保留 / 取消保留（{ sessionId, src, pinned }）
//   POST /oks/delete                  → 删掉一份**未保留**的产物（{ sessionId, src }）
//
// "点条目打开某一份产物"不走这里：那是**右栏的一个页签**（`dsh-resource://file/…` 资源地址），
// 由界面直接交给宿主的文件页签去打开——产物内容因此从来不经过我们。
//
// 为什么是端点而不是让界面读文件：清单本来就是**插件知道的事实**，没有理由把它先写成文件
// 再让前端解析——直接问插件最直接（也因此不需要给前端"读文件"这条路）。写仍然只有插件在做
// （`.oks/state.db` 是插件的），界面只是发起点；两个端点都只认这一个工作区的产出。
//
// 端点是**窄**的：只认这两条路径、只做这一件事（`pinBySrc` 自己会校验 src 属于那个工作区的
// 产物目录），所以它不成为通用写入口。
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { errorText } from './host.ts';
import { ARTIFACT_DIR } from './results.ts';
import { adoptArtifacts, KEEP_ALIVE_MINUTES, listArtifacts, openState, pinBySrc, VISIBLE } from './state.ts';

/** 端点两头的**最小形状**：req 只要能给 method/url 与异步迭代出请求体，res 只要能 head/end。
 *  （宿主给的是 Node 的 IncomingMessage / ServerResponse，这两个形状是它们的子集。） */
export interface PanelRequestLike extends AsyncIterable<unknown> {
  method?: unknown;
  url?: unknown;
}

export interface PanelResponseLike {
  writeHead(status: number, headers?: Record<string, string>): { end(body?: string): void };
}

export type PanelHandler = (req: PanelRequestLike, res: PanelResponseLike) => Promise<void>;

/** 请求体上限：保留请求只收三个字段，读超了就拒。 */
const MAX_BODY_BYTES = 4096;

/** 界面与插件约定的两条路径。 */
export const ARTIFACTS_ENDPOINT = '/oks/artifacts';
export const PIN_ENDPOINT = '/oks/pin';
export const DOWNLOAD_ENDPOINT = '/oks/download';
export const DELETE_ENDPOINT = '/oks/delete';

/** 下载的大小上限：报表远小于它（几十 KB）。 */
const MAX_DOWNLOAD_BYTES = 8 * 1024 * 1024;

/** 产物文件名 → 它的类型与给浏览器下载用的 MIME。只认工作区里符合命名规则的**报表**。 */
function reportFile(file: string): boolean {
  return !file.includes('/') && !file.includes('\\') && VISIBLE.test(file);
}


export interface PanelDeps {
  /** 会话 → 工作区根；取不到就抛，端点回 400（不猜一个工作区出来）。
   *  可以是异步的：**活的会话注册表只认识本进程起来之后创建的会话**，而页签可能在看重启之前
   *  那个会话——那时要去读磁盘上的会话头（见 `sessionRootResolver`）。 */
  rootFor(sessionId: string): string | Promise<string>;
  /** 记一行（可选）：清单里移除了行时说明一下，事后能自证。 */
  log?(message: string): void;
  /** 落状态：与 `oks_pin` / `oks_unpin` 走的是同一个函数。 */
  pin(root: string, src: string, pinned: boolean): { file: string; pinned: boolean };
  /** 删掉一份**未保留**的产物：工作区与清单一起去掉。 */
  remove(root: string, src: string): { file: string };
}

/** 逐块读请求体；超过上限直接拒（不把请求体攒在内存里）。 */
async function readJsonBody(req: AsyncIterable<unknown>): Promise<unknown> {
  let text = '';
  for await (const chunk of req) {
    text += typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf8');
    if (text.length > MAX_BODY_BYTES) throw new Error(`请求体超过 ${MAX_BODY_BYTES} 字节`);
  }
  if (text.trim() === '') return {};
  return JSON.parse(text);
}

/** 回执统一成一层包装：成功 `{ ok: true, value }`、失败 `{ ok: false, message }`。 */
function reply(res: PanelResponseLike, status: number, payload: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    .end(JSON.stringify(payload));
}

/** 清单端点：读一次状态库，回当前清单（界面要的字段都在里面）。 */
export function createArtifactsEndpoint(deps: PanelDeps): PanelHandler {
  return async (req, res) => {
    if (req.method !== 'GET') {
      reply(res, 405, { ok: false, message: '只接受 GET' });
      return;
    }
    let sessionId: string | null;
    try {
      const url = new URL(typeof req.url === 'string' ? req.url : '/', 'http://127.0.0.1');
      sessionId = url.searchParams.get('sessionId');
    } catch (cause) {
      reply(res, 400, { ok: false, message: String((cause as Error)?.message ?? cause) });
      return;
    }
    if (sessionId === null || sessionId.length === 0) {
      reply(res, 400, { ok: false, message: 'sessionId 必需' });
      return;
    }
    try {
      const root = await deps.rootFor(sessionId);
      const state = openState(root);
      try {
        // 读路径以账本为准，只做一件事：**补登**目录里有、账本上没有的可读产物（只加不删）。
        // 没有要补的时候连事务都不开，本质是纯读；补登失败也只记一行日志，照旧给库里已有的行。
        try {
          const { adopted } = adoptArtifacts(state, root);
          if (adopted > 0) {
            deps.log?.(`[oks] 账本 · 补登了 ${adopted} 份产物（目录里有、账本上没有）`);
          }
        } catch (cause) {
          deps.log?.(`[oks] 补登失败了（这次的清单按账本已有的给出）：${errorText(cause)}`);
        }
        const entries = listArtifacts(state);
        // 把读到的工作区一起交出去：页签于是能说清"我看的是哪个工作区"——
        // 这次排查里最难分辨的一种情形就是"清单空"与"看错了工作区"长得一模一样。
        reply(res, 200, { ok: true, value: { keepAliveMinutes: KEEP_ALIVE_MINUTES, root, entries } });
      } finally {
        state.close();
      }
    } catch (cause) {
      reply(res, 400, { ok: false, message: String((cause as Error)?.message ?? cause) });
    }
  };
}

/** 会话 → 工作区根的解析器（端点用）。两条路，按顺序试：
 *   1. **活的会话注册表**（`ctx.sessions`）：本进程当前握着的会话，最快；
 *   2. **磁盘上的会话头**（`ctx.sessionQuery.readSession`）：本进程起来之前创建的会话——
 *      宿主为了打开文件/资源本来就能解析它们，而页签看重启前那个会话时，路 1 一定落空。
 *      没有这条兜底，"重启服务 → 页签什么也不显示"就是必然而不是偶然。
 *  解析出来的映射在内存里记住（一个会话的工作区不会变），于是轮询不会反复读日志。
 *  两条路都落空才抛——让端点回 400 并带上会话 id，而不是猜一个工作区出来。 */
export interface LiveSessionsLike {
  get?(sessionId: string): { header?: { cwd?: unknown } } | undefined;
}
export interface PersistedSessionsLike {
  readSession?(sessionId: string): Promise<{ header?: { cwd?: unknown } }>;
}

const cwdOf = (value: unknown): string | undefined =>
  (typeof value === 'string' && value.length > 0 ? value : undefined);

export function sessionRootResolver(
  sessions: LiveSessionsLike | undefined,
  persisted: PersistedSessionsLike | undefined,
): (sessionId: string) => Promise<string> {
  const known = new Map<string, string>();
  return async (sessionId: string): Promise<string> => {
    const cached = known.get(sessionId);
    if (cached !== undefined) return cached;
    const live = cwdOf(sessions?.get?.(sessionId)?.header?.cwd);
    if (live !== undefined) {
      known.set(sessionId, live);
      return live;
    }
    try {
      const snapshot = await persisted?.readSession?.(sessionId);
      const fromLog = cwdOf(snapshot?.header?.cwd);
      if (fromLog !== undefined) {
        known.set(sessionId, fromLog);
        return fromLog;
      }
    } catch {
      // 落到底下那句错误：会话不存在（或读不出来）与"没有这条兜底"对外是同一种情形。
    }
    throw new Error(`找不到会话 ${sessionId} 的工作区目录`);
  };
}

/** 下载端点：把一份报表**原样**交给浏览器（`content-disposition: attachment`），
 *  这样界面用一个普通 `<a download>` 就能下载——不需要把内容读进页面再拼 Blob。
 *  只认 `artifacts/` 里符合命名规则的报表：不接受路径、不读状态库。 */
export function createDeleteEndpoint(deps: PanelDeps): PanelHandler {
  return async (req, res) => {
    if (req.method !== 'POST') {
      reply(res, 405, { ok: false, message: '只接受 POST' });
      return;
    }
    let body: Record<string, unknown>;
    try {
      const parsed = await readJsonBody(req);
      if (parsed === null || typeof parsed !== 'object') throw new Error('请求体要是一个对象');
      body = parsed as Record<string, unknown>;
    } catch (cause) {
      reply(res, 400, { ok: false, message: String((cause as Error)?.message ?? cause) });
      return;
    }
    const { sessionId, src } = body;
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      reply(res, 400, { ok: false, message: 'sessionId 必需' });
      return;
    }
    if (typeof src !== 'string' || src.length === 0) {
      reply(res, 400, { ok: false, message: 'src 必需' });
      return;
    }
    try {
      const result = deps.remove(await deps.rootFor(sessionId), src);
      deps.log?.(`[oks] 删除产物 ${result.file}`);
      reply(res, 200, { ok: true, value: { file: result.file } });
    } catch (cause) {
      reply(res, 400, { ok: false, message: String((cause as Error)?.message ?? cause) });
    }
  };
}

export function createDownloadEndpoint(deps: PanelDeps): PanelHandler {
  return async (req, res) => {
    if (req.method !== 'GET') {
      reply(res, 405, { ok: false, message: '只接受 GET' });
      return;
    }
    let sessionId: string | null;
    let file: string | null;
    try {
      const url = new URL(typeof req.url === 'string' ? req.url : '/', 'http://127.0.0.1');
      sessionId = url.searchParams.get('sessionId');
      file = url.searchParams.get('file');
    } catch (cause) {
      reply(res, 400, { ok: false, message: String((cause as Error)?.message ?? cause) });
      return;
    }
    if (sessionId === null || sessionId.length === 0) {
      reply(res, 400, { ok: false, message: 'sessionId 必需' });
      return;
    }
    if (file === null || !reportFile(file)) {
      reply(res, 400, { ok: false, message: '只能下载这个工作区里的报表' });
      return;
    }
    try {
      const target = join(await deps.rootFor(sessionId), ARTIFACT_DIR, file);
      if (!existsSync(target)) {
        reply(res, 404, { ok: false, message: `没有这份报表：${file}` });
        return;
      }
      const size = statSync(target).size;
      if (size > MAX_DOWNLOAD_BYTES) {
        reply(res, 400, { ok: false, message: `报表太大（${size} 字节）` });
        return;
      }
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-disposition': `attachment; filename="${file}"`,
        'content-length': String(size),
        'cache-control': 'no-store',
      }).end(readFileSync(target, 'utf8'));
    } catch (cause) {
      reply(res, 400, { ok: false, message: String((cause as Error)?.message ?? cause) });
    }
  };
}

/** 保留端点：机械操作，直接落状态。 */
export function createPinEndpoint(deps: PanelDeps): PanelHandler {
  return async (req, res) => {
    if (req.method !== 'POST') {
      reply(res, 405, { ok: false, message: '只接受 POST' });
      return;
    }
    let body: Record<string, unknown>;
    try {
      const parsed = await readJsonBody(req);
      if (parsed === null || typeof parsed !== 'object') throw new Error('请求体要是一个对象');
      body = parsed as Record<string, unknown>;
    } catch (cause) {
      reply(res, 400, { ok: false, message: String((cause as Error)?.message ?? cause) });
      return;
    }
    const { sessionId, src, pinned } = body;
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      reply(res, 400, { ok: false, message: 'sessionId 必需' });
      return;
    }
    if (typeof src !== 'string' || src.length === 0) {
      reply(res, 400, { ok: false, message: 'src 必需' });
      return;
    }
    if (typeof pinned !== 'boolean') {
      reply(res, 400, { ok: false, message: 'pinned 必须是 true 或 false' });
      return;
    }
    try {
      const result = deps.pin(await deps.rootFor(sessionId), src, pinned);
      reply(res, 200, { ok: true, value: { file: result.file, pinned: result.pinned, keepAliveMinutes: KEEP_ALIVE_MINUTES } });
    } catch (cause) {
      reply(res, 400, { ok: false, message: String((cause as Error)?.message ?? cause) });
    }
  };
}
