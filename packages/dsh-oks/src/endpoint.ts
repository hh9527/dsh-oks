// 界面的**机械通道**：插件在宿主的 web 服务上开一对同源端点。
//
//   GET  /oks/artifacts?sessionId=…   → 这个工作区的制品清单（界面要的就这些）
//   POST /oks/pin                     → 保留 / 取消保留（{ sessionId, src, pinned }）
//   POST /oks/delete                  → 删掉一份**未保留**的产物（{ sessionId, src }）
//   POST /oks/collect                 → 按工作区的 manual 窗口清一次（{ sessionId }）
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
import { adoptArtifacts, listArtifacts, openState, pinBySrc, readLastCleanup, usageByKind,
  VISIBLE } from './state.ts';

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
export const COLLECT_ENDPOINT = '/oks/collect';

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
  pin(root: string, asset: string, pinned: boolean): { asset: string; pinned: boolean };
  /** 删掉一份**未保留**的产物：工作区与清单一起去掉。 */
  remove(root: string, src: string): { asset: string };
  /** 这个工作区的报表保留窗口（分钟）：来自它的 `oks.json`，界面据此说明"多久后清理"。 */
  keepAliveMinutes(root: string): number;
  /** 按这个工作区配置的 manual 窗口清一次（材料 + `.work/`）：产出页签里那个按钮的动作。
   *  回执要够界面写一句话：截止时刻、清掉几个（含程序）、还剩几个、总大小、释放多少。 */
  collect(root: string, ttl?: unknown): {
    cutoffMs: number;
    windowSeconds: number;
    removedMaterials: number;
    removedWork: number;
    freedBytes: number;
    remainingMaterials: number;
    remainingMaterialBytes: number;
    remainingWork: number;
    remainingWorkBytes: number;
  };
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
        // 页签那边"清单是空的"最常见的原因就是它问的是另一个工作区：这一行把**工作区、会话、
        // 条数**一起记下，服务端日志与页签显示的能直接对上。
        deps.log?.(`[oks] artifacts · ${root} · 会话 ${sessionId.slice(0, 24)}`
          + ` · ${entries.length} 条（保留 ${entries.filter((item) => item.pinned).length}）`);
        // 那块概览用的四类占用与"最后清理"，跟清单同一次请求回来（界面不用多问一次）。
        const usage = usageByKind(root, entries);
        reply(res, 200, {
          ok: true,
          value: {
            keepAliveMinutes: deps.keepAliveMinutes(root),
            usage: { ...usage, lastCleanup: readLastCleanup(state) ?? null },
            entries,
          },
        });
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
/** 宿主的会话持久化服务：宿主自己的面板就是用它兜"活会话表里还没有这个会话"。 */
export interface SessionPersistenceLike {
  stat?(sessionId: string): Promise<{ header?: { cwd?: unknown } } | undefined>;
}

const cwdOf = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  return text.length > 0 ? text : undefined;
};

export function sessionRootResolver(
  sources: {
    sessions?: LiveSessionsLike | undefined;
    persistence?: SessionPersistenceLike | undefined;
  },
  options: { attempts?: number; waitsMs?: number[] } = {},
): (sessionId: string) => Promise<string> {
  const known = new Map<string, string>();
  const attempts = Math.max(1, options.attempts ?? 3);
  const waits = options.waitsMs ?? [150, 500];
  const pause = async (ms: number): Promise<void> =>
    await new Promise((resolve) => { setTimeout(resolve, ms); });
  return async (sessionId: string): Promise<string> => {
    const cached = known.get(sessionId);
    if (cached !== undefined) return cached;
    // 两段式，与宿主自己的面板一致：活会话表的会话头 → 宿主的会话持久化。
    // 活表覆盖"本进程里活着的会话"（新建的会话在 `create` 返回前就已经 publish，第一轮对话
    // 之前就有 `cwd`）；持久化覆盖"进程重启前建的会话"，其 jsonl 后端连刚写入、尚未落盘的
    // pending header 也能读到。
    //
    // 这里**不碰** `sandboxPolicy.workspaceRoot`：它是部署值（`process.cwd()`），不是"这个会话的
    // 工作区"；拿它顶替只会给出一个看起来对、其实别处的目录。解析不出来就明确报错。
    for (let round = 0; round < attempts; round += 1) {
      const live = cwdOf(sources.sessions?.get?.(sessionId)?.header?.cwd);
      if (live !== undefined) {
        known.set(sessionId, live);
        return live;
      }
      try {
        const snapshot = await sources.persistence?.stat?.(sessionId);
        const stored = cwdOf(snapshot?.header?.cwd);
        if (stored !== undefined) {
          known.set(sessionId, stored);
          return stored;
        }
      } catch {
        // 读不出来就等下一轮：会话可能刚建出来，登记晚一拍。
      }
      if (round < attempts - 1) await pause(waits[Math.min(round, waits.length - 1)] ?? 0);
    }
    throw new Error(`找不到会话 ${sessionId} 的工作区目录`);
  };
}

/** 清理端点：按工作区配置的 manual 窗口清一次——材料（`.oks/`）与代码区（`.work/`）。
 *  与其它端点同源同窄：只认这一个工作区、只做这一件事；窗口来自工作区声明，界面不传参数。 */
export function createCollectEndpoint(deps: PanelDeps): PanelHandler {
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
    const { sessionId, ttl } = body;
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      reply(res, 400, { ok: false, message: 'sessionId 必需' });
      return;
    }
    try {
      // `ttl` 是页签那两个菜单项给的可选窗口（"30m" / "5m" / 秒数）；不给就用工作区的 manual 策略。
      const result = deps.collect(await deps.rootFor(sessionId), ttl);
      deps.log?.(`[oks] collect（页签按钮）· 材料 ${result.removedMaterials} 份`
        + ` · 程序 ${result.removedWork} 个 · 释放 ${(result.freedBytes / 1024).toFixed(1)} KB`);
      reply(res, 200, { ok: true, value: result });
    } catch (cause) {
      reply(res, 400, { ok: false, message: String((cause as Error)?.message ?? cause) });
    }
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
      deps.log?.(`[oks] 删除产物 ${result.asset}`);
      reply(res, 200, { ok: true, value: { asset: result.asset } });
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
      const root = await deps.rootFor(sessionId);
      const result = deps.pin(root, src, pinned);
      reply(res, 200, { ok: true, value: { asset: result.asset, pinned: result.pinned, keepAliveMinutes: deps.keepAliveMinutes(root) } });
    } catch (cause) {
      reply(res, 400, { ok: false, message: String((cause as Error)?.message ?? cause) });
    }
  };
}
