// 右侧栏的「产出」页签：列出这个工作区产出的**制品**（图与报告：标题、类别、时间、是否保留）。
//
// 数据来自**插件自己开的两个同源端点**（`packages/dsh-oks/src/endpoint.ts`）：
//
//   GET  /oks/artifacts?sessionId=…   清单
//   POST /oks/pin                     保留 / 取消保留（{ sessionId, src, pinned }）
//
// 所以前端不读文件、不碰工作区布局：清单是插件知道的事实，问它最直接；保留是机械操作，
// 直接落后台——都不经过 agent。
//
// 交付形态是**经典脚本 + 宿主的模块加载器协议**（与 DSH 自己的 client 包一致）：
//
//   window.__ModuleLoader__.load({ id, factory: (require) => module.exports })
//
// 三条硬约束（测试里各有一条断言）：
//   1. **没有顶层 import/export**——按经典脚本执行，出现 ESM 语法就整条 entry 不激活；
//   2. **运行时的东西全部在 factory 里**——顶层声明会落在同一个全局作用域，两条插件（或一次
//      reload）同名就 `Identifier 'X' has already been declared`；
//   3. **要导出 `apply` 与 `inject`**——`inject` 是运行时注入的**服务键**（不是包名），
//      少了它 cordis 不会把 `ctx.slots` / `ctx.sidebarRightTabs` 注进来，激活时一进门就抛。
//
// 还有一个界面上的前提：右栏空着时播的是**引导页**，它只列登记过 `guide` 条目的 tab 类型。

import type { ReactElement } from 'react';

/** 一条制品（与宿主侧 `ArtifactEntry` 同形）。 */
interface ArtifactEntry {
  file: string;
  name: string;
  kind: 'chart' | 'report';
  at: string;
  title: string;
  /** 更精确的分类（周报、月报、即时分析…）；自述里没有就不写这一项。 */
  category?: string;
  source?: 'query' | 'agent';
  pinned: boolean;
}

interface Listing {
  keepAliveMinutes: number;
  entries: ArtifactEntry[];
}

interface Context {
  effect(run: () => void | (() => void), name?: string): void;
  sidebarRightTabs: { register(definition: Record<string, unknown>): unknown };
  /** 打开一个资源地址（`dsh-resource://file/session/<sid>/<path>`）——文件面板用的就是它：
   *  它会**新开一个页签**在右栏里显示那个文件。 */
  sidebarRight: { openResource(address: string): void };
  slots: {
    inject(name: string, register: () => Disposer): Disposer;
    register(definition: Record<string, unknown>, component: unknown): Disposer;
  };
}

type Disposer = void | (() => void);

/** 正文组件拿到的框架 props（只声明我们用到的：当前会话）。 */
interface BodyProps {
  sessionId?: string;
}

interface ModuleExports {
  apply: (ctx: Context) => void;
  /** 运行时注入的**服务键**（不是包名）。 */
  inject: string[];
  /** 给本地测试用：读清单。 */
  readListing: (sessionId: string) => Promise<Listing>;
  /** 给本地测试用：那条机械通道的写。 */
  postPin: (sessionId: string, src: string, pinned: boolean) => Promise<void>;
  /** 给本地测试用：一份产物的资源地址（点条目会用它在右栏新开页签）。 */
  artifactAddress: (sessionId: string, file: string) => string;
  /** 给本地测试用：下载一份报表的 URL。 */
  downloadHref: (sessionId: string, file: string) => string;
  /** 给本地测试用：判断"清单没变"的规则（轮询靠它避免无谓重渲染）。 */
  sameListing: (a: Listing | null, b: Listing) => boolean;
  /** 给本地测试用：时间戳 → 友好说法。 */
  friendlyTime: (at: string, now: number) => string;
  /** 给本地测试用：一行下面那行的文案（精确分类 + 友好时间）。 */
  metaLine: (entry: { category?: string; at: string }, now: number) => string;
}

declare const window: {
  __ModuleLoader__: { load(entry: { id: string; factory: (require: (id: string) => unknown) => unknown }): void };
};

// 唯一的顶层语句：把自己注册进宿主的模块加载器。运行时的一切都在 factory 里。
window.__ModuleLoader__.load({
  id: '@local/dsh-oks-ui',
  factory: (require) => {
    const ID = 'oks-artifacts';
    /** 与 `packages/dsh-oks/src/endpoint.ts` 约定的两条路径。 */
    const ARTIFACTS_ENDPOINT = '/oks/artifacts';
    const PIN_ENDPOINT = '/oks/pin';
    const DOWNLOAD_ENDPOINT = '/oks/download';
    /** 我们真正用到的服务：槽与右栏 tab 注册表（清单与保留走 fetch，不占服务）。 */
    const inject = ['slots', 'sidebarRightTabs', 'sidebarRight'];
    /** 清单的刷新间隔：够快（新产物几秒内出现），又够省（本地端点、一次扫描）。 */
    const REFRESH_MS = 4000;

    /** 出错时打成**一行**：贴到聊天里就能定位（浏览器控制台会把对象折叠成 `Object`）。 */
    const describe = (value: unknown): string => {
      if (value === null) return 'null';
      if (typeof value !== 'object') return `${typeof value} ${String(value)}`;
      const node = value as { ok?: unknown; code?: unknown; message?: unknown; error?: { code?: unknown; message?: unknown } };
      return [
        `ok=${String(node.ok)}`,
        `code=${String(node.error?.code ?? node.code ?? '-')}`,
        `message=${String(node.error?.message ?? node.message ?? '-')}`,
        `keys=${Object.keys(node).join(',') || '-'}`,
      ].join(' · ');
    };

    /** 时间戳（文件名里那段 UTC：`YYYYMMDDTHHmmssZ`）→ 本地时间的友好说法。 */
    const friendlyTime = (at: string, now: number): string => {
      const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(at);
      if (m === null) return at;
      const when = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])));
      const diffSeconds = Math.floor((now - when.getTime()) / 1000);
      if (diffSeconds < 60) return '刚刚';
      if (diffSeconds < 3600) return `${Math.floor(diffSeconds / 60)} 分钟前`;
      const two = (value: number): string => String(value).padStart(2, '0');
      const clock = `${two(when.getHours())}:${two(when.getMinutes())}`;
      const startOfDay = (value: Date): number => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
      const days = Math.round((startOfDay(new Date(now)) - startOfDay(when)) / 86400000);
      if (days <= 0) return `今天 ${clock}`;
      if (days === 1) return `昨天 ${clock}`;
      const today = new Date(now);
      if (when.getFullYear() === today.getFullYear()) return `${when.getMonth() + 1}月${when.getDate()}日 ${clock}`;
      return `${when.getFullYear()}年${when.getMonth() + 1}月${when.getDate()}日`;
    };

    /** 一行下面那行的文案：**精确分类** + 友好时间。大类已经由图标的图标说了，所以这里不再
     *  重复"报表"——缺分类（更早产生的产物没写这一项）就按最一般的"即时分析"。 */
    const metaLine = (entry: { category?: string; at: string }, now: number): string =>
      `${entry.category ?? '即时分析'} · ${friendlyTime(entry.at, now)}`;

    /** 大颗粒类型用图标说（当前只有报表算制品；图是一份报表里的图）。 */
    const kindIcon: Record<string, string> = { report: '📄', chart: '📈' };

    /** 行样式：hover 要 CSS（内联样式表达不了伪类），所以装一份到文档里。 */
    const CSS = [
      '.oks-artifact-row{border-radius:6px;transition:background-color .12s ease}',
      '.oks-artifact-row:hover{background:color-mix(in srgb, currentColor 10%, transparent)}',
      '.oks-artifact-row:active{background:color-mix(in srgb, currentColor 16%, transparent)}',
      '.oks-artifact-download{opacity:.45;text-decoration:none;color:inherit;cursor:pointer}',
      '.oks-artifact-download:hover{opacity:1}',
      '.oks-artifact-pin{opacity:.35;filter:grayscale(1);cursor:pointer}',
      '.oks-artifact-pin[data-pinned="true"]{opacity:1;filter:none}',
      '.oks-artifact-pin:hover{opacity:1;filter:none}',
    ].join('\n');

    const installCss = (): void => {
      if (typeof document === 'undefined') return;   // 本地测试（node）里没有文档
      if (document.querySelector('style[data-oks-css]') !== null) return;
      const style = document.createElement('style');
      style.setAttribute('data-oks-css', '');
      style.textContent = CSS;
      document.head.append(style);
    };

    /** 两份清单是不是同一份。轮询会反复读，内容没变就不该重置状态（否则每轮都重渲染）。 */
    const sameListing = (a: Listing | null, b: Listing): boolean => {
      if (a === null) return false;
      if (a.keepAliveMinutes !== b.keepAliveMinutes) return false;
      if (a.entries.length !== b.entries.length) return false;
      return a.entries.every((entry, index) => {
        const other = b.entries[index];
        return other !== undefined
          && entry.file === other.file && entry.title === other.title && entry.at === other.at
          && entry.kind === other.kind && entry.pinned === other.pinned;
      });
    };

    /** 调一次端点：成功取 `value`，失败把 `message` 抛出来（回执统一一层包装）。 */
    const callEndpoint = async (url: string, init?: RequestInit): Promise<unknown> => {
      const response = await fetch(url, init);
      const text = await response.text();
      let payload: { ok?: unknown; value?: unknown; message?: unknown } = {};
      try { payload = JSON.parse(text) as typeof payload; } catch { /* 不是 JSON：下面按状态码报 */ }
      if (!response.ok || payload.ok !== true) {
        throw new Error(typeof payload.message === 'string' ? payload.message : `请求失败（HTTP ${response.status}）`);
      }
      return payload.value;
    };

    const readListing = async (sessionId: string): Promise<Listing> =>
      await callEndpoint(`${ARTIFACTS_ENDPOINT}?sessionId=${encodeURIComponent(sessionId)}`) as Listing;

    /** 下载一份报表的 URL：插件那条字节端点（浏览器拿它当一个普通链接用）。 */
    const downloadHref = (sessionId: string, file: string): string =>
      `${DOWNLOAD_ENDPOINT}?sessionId=${encodeURIComponent(sessionId)}&file=${encodeURIComponent(file)}`;

    /** 下载图标：一个很普通的"箭头落进托盘"（内联 SVG，跟着文字颜色与大小走）。 */
    const downloadIcon = (): ReactElement => createElement('svg', {
      key: 'glyph',
      viewBox: '0 0 16 16',
      width: '13', height: '13',
      fill: 'none', stroke: 'currentColor', strokeWidth: '1.5',
      strokeLinecap: 'round', strokeLinejoin: 'round',
      'aria-hidden': 'true',
      style: { display: 'block' },
    },
    createElement('path', { key: 'shaft', d: 'M8 2.5v7' }),
    createElement('path', { key: 'head', d: 'M4.75 6.75 8 10l3.25-3.25' }),
    createElement('path', { key: 'tray', d: 'M2.75 12.75h10.5' }));

    /** 一份产物在宿主里的**文件地址**：与文件面板同一个格式（逐段编码，保留盘符里的冒号）。 */
    const artifactAddress = (sessionId: string, file: string): string => {
      const encoded = `artifacts/${file}`.split('/').map(
        (segment) => encodeURIComponent(segment).replace(/%3A/gi, ':'),
      ).join('/');
      return `dsh-resource://file/session/${encodeURIComponent(sessionId)}/${encoded}`;
    };

    const postPin = async (sessionId: string, src: string, pinned: boolean): Promise<void> => {
      await callEndpoint(PIN_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId, src, pinned }),
      });
    };

    const module = { exports: {} as ModuleExports };
    const exports = module.exports;
    const React = require('react') as typeof import('react');
    const { createElement, useCallback, useEffect, useRef, useState } = React;
    // 引导页里那一条要一个图标；图标来自宿主的 primitives 包（与 files / terminal 同源）。
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives') as { GuideArtworkFiles?: unknown };

    const apply = (ctx: Context): void => {
      installCss();
      // `guide` 这一项是**露出的前提**：右栏空着时播引导页，它只列登记过引导条目的 tab 类型。
      ctx.sidebarRightTabs.register({
        id: ID,
        kind: ID,
        priority: 'builtin',
        title: () => '产出',
        guide: [{
          id: 'artifacts',
          order: 30,
          title: () => '产出',
          description: () => '本工作区产出的图与报告：点条目新开页签看，📌 一下就保留下来',
          icon: primitives.GuideArtworkFiles,
        }],
      });

      const Body = ({ sessionId }: BodyProps): ReactElement => {
        const [listing, setListing] = useState<Listing | null>(null);
        const [error, setError] = useState<string | null>(null);
        const [busy, setBusy] = useState(false);
        /** 手上这份清单（给"变空了要再问一次"的判断用；state 在闭包里读不到最新的）。 */
        const heldListing = useRef<Listing | null>(null);
        useEffect(() => { heldListing.current = listing; }, [listing]);

        const load = useCallback(async () => {
          if (typeof sessionId !== 'string' || sessionId.length === 0) {
            setError('拿不到当前会话，因此不知道看哪个工作区。');
            return;
          }
          try {
            let fresh = await readListing(sessionId);
            // 一次"清单变空"可能是宿主那边一次误判（例如目录一时看不见）。再问一次，
            // 只有第二次也是空才接受——否则用户会看到清单凭空清空、要刷新才回来。
            const held = heldListing.current;
            if (fresh.entries.length === 0 && held !== null && held.entries.length > 0) {
              console.warn(`[oks-ui] 清单从 ${held.entries.length} 条变成 0 条，立刻再问一次`);
              fresh = await readListing(sessionId);
            }
            setListing((current) => (sameListing(current, fresh) ? current : fresh));
            setError(null);
          } catch (cause) {
            console.warn(`[oks-ui] 读不到清单（session=${sessionId}）：${describe(cause)}`);
            setError(String((cause as Error)?.message ?? cause));
          }
        }, [sessionId]);

        // 新产物是**别处**（这一轮对话里）产生的，页签不会自己知道：我们的接口没有推送通道，
        // 所以按一个不长不短的间隔主动问一次，另外窗口重新聚焦时也问一次。
        useEffect(() => {
          void load();
          const timer = setInterval(() => { void load(); }, REFRESH_MS);
          const onFocus = (): void => { void load(); };
          globalThis.addEventListener?.('focus', onFocus);
          return () => {
            clearInterval(timer);
            globalThis.removeEventListener?.('focus', onFocus);
          };
        }, [load]);

        const toggle = async (entry: ArtifactEntry): Promise<void> => {
          if (typeof sessionId !== 'string' || sessionId.length === 0) {
            setError('拿不到当前会话，因此不知道改哪个工作区的状态。');
            return;
          }
          setBusy(true);
          try {
            await postPin(sessionId, `artifacts/${entry.file}`, !entry.pinned);
            await load();   // 落完状态重新读一次，界面与后台一致
          } catch (cause) {
            setError(String((cause as Error)?.message ?? cause));
          } finally {
            setBusy(false);
          }
        };

        if (error !== null) {
          return createElement('p', { className: 'oks-artifacts-error', style: { fontSize: '13px' } }, error);
        }
        if (listing === null) {
          return createElement('p', { className: 'oks-artifacts-status', style: { fontSize: '13px' } }, '正在读取产出…');
        }
        if (listing.entries.length === 0) {
          return createElement('p', {
            className: 'oks-artifacts-status',
            style: { fontSize: '13px', opacity: 0.8 },
          }, `这个工作区还没有图或报告。未保留的产物会在 ${listing.keepAliveMinutes} 分钟后被清理。`);
        }

        /** 点条目：在右栏**新开一个页签**打开这份产物（与文件面板同一个地址格式）。 */
        const openArtifact = (entry: ArtifactEntry): void => {
          if (typeof sessionId !== 'string' || sessionId.length === 0) {
            setError('拿不到当前会话，因此不知道打开哪个工作区的产物。');
            return;
          }
          try {
            ctx.sidebarRight.openResource(artifactAddress(sessionId, entry.file));
          } catch (cause) {
            setError(String((cause as Error)?.message ?? cause));
          }
        };

        const now = Date.now();
        const rows = listing.entries.map((entry) => createElement('div', {
          key: entry.file,
          className: 'oks-artifact-row',
          onClick: () => { openArtifact(entry); },
          title: '点一下在右栏新开一个页签打开它',
          style: { display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 8px', cursor: 'pointer' },
        },
        // 大颗粒类型用图标（当前只有报表算制品）：文字留给更精确的分类与时间。
        createElement('span', { key: 'icon', style: { flex: 'none', fontSize: '15px', lineHeight: '1' } },
          kindIcon[entry.kind] ?? '📄'),
        createElement('div', { key: 'text', style: { minWidth: 0, flex: '1 1 auto' } },
          // 名称是主信息：大一号、加粗，与下面那行拉开距离。
          createElement('div', {
            style: {
              fontSize: '15px', fontWeight: 600, lineHeight: '1.35',
              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
            },
          }, entry.title),
          createElement('div', { style: { fontSize: '11.5px', opacity: 0.65, marginTop: '2px' } },
            metaLine(entry, now))),
        // 图钉左边的下载：一个普通链接，浏览器原生下载（服务端带 attachment 头）。
        typeof sessionId === 'string' && sessionId.length > 0
          ? createElement('a', {
            key: 'download',
            className: 'oks-artifact-download',
            href: downloadHref(sessionId, entry.file),
            download: entry.file,
            onClick: (event?: { stopPropagation?(): void }) => { event?.stopPropagation?.(); },
            title: '下载这份报表',
            'aria-label': '下载这份报表',
            style: { flex: 'none', lineHeight: '1', padding: '3px', display: 'flex', alignItems: 'center' },
          }, downloadIcon())
          : null,
        // 图钉在右侧，和行一起垂直居中。
        createElement('button', {
          key: 'pin',
          type: 'button',
          className: 'oks-artifact-pin',
          'data-pinned': String(entry.pinned),
          disabled: busy,
          onClick: (event?: { stopPropagation?(): void }) => { event?.stopPropagation?.(); void toggle(entry); },
          title: entry.pinned ? '已保留（点一下取消）' : '点一下保留下来（不再被清理）',
          style: {
            flex: 'none', fontSize: '14px', lineHeight: '1', padding: '2px',
            background: 'none', border: 'none', color: 'inherit',
          },
        }, '📌')));

        return createElement('div', { className: 'oks-artifacts' },
          createElement('div', { style: { fontSize: '12px', opacity: 0.7, padding: '2px 0 6px' } },
            `${listing.entries.length} 条 · 未保留的在 ${listing.keepAliveMinutes} 分钟后清理`),
          ...rows);
      };

      // 正文挂在 pane 这个 keyed 槽上，key 就是我们注册的 tab id（与 files / terminal 同样的路子）。
      ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
        name: 'sidebar.right.pane.tab',
        key: ID,
      }, Body)), 'oks-ui: artifacts pane');
    };

    exports.apply = apply;
    exports.inject = inject;
    exports.readListing = readListing;
    exports.postPin = postPin;
    exports.artifactAddress = artifactAddress;
    exports.downloadHref = downloadHref;
    exports.sameListing = sameListing;
    exports.friendlyTime = friendlyTime;
    exports.metaLine = metaLine;
    return module.exports;
  },
});
