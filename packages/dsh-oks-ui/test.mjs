// 本地模拟**页面的模块加载器**与**插件的端点**，把"只在浏览器里报"的失败挪到这里来。
// 前几轮踩过的坑各有一条断言：ESM 交付、缺 inject、缺 guide、顶层声明撞全局、
// 读清单的通道、机械通道的请求形状。每条都是先在现场炸、再补上的。

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const source = readFileSync(fileURLToPath(new URL('./lib/client.mjs', import.meta.url)), 'utf8');

// —— 1. 交付形态：经典脚本 + 宿主模块加载器协议
assert.equal(/^\s*(import|export)\s/m.test(source), false, 'client.mjs 顶层出现了 import/export');
assert.ok(source.includes('__ModuleLoader__.load('), 'client.mjs 没有走宿主的模块加载器协议');
const topLevel = source.split('\n').filter((line) => /^(const|let|var|function|class)\s/.test(line));
assert.deepEqual(topLevel, [], `client.mjs 顶层出现了声明：${topLevel.join(' | ')}`);

// —— 2. 装载：假 window + 假 require（只用得到 createElement 与三个 hook）
let entry;
globalThis.window = { __ModuleLoader__: { load: (value) => { entry = value; } } };
await import('./lib/client.mjs');
assert.ok(entry !== undefined, '模块没有把自己注册进 __ModuleLoader__');
assert.equal(entry.id, '@local/dsh-oks-ui');

const fakeReact = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useCallback: (fn) => fn,
  useRef: (initial) => ({ current: initial }),
  useEffect: () => {},
  useState: (initial) => [initial, () => {}],
};
const module = entry.factory((id) => {
  if (id === 'react') return fakeReact;
  if (id === '@deepseek-ai/dsh-client-ui-primitives') return { GuideArtworkFiles: () => null };
  throw new Error(`工厂 require 了没有桩的模块：${id}`);
});

// —— 3. 激活契约：apply 与 inject 都在，inject 覆盖我们用到的服务
assert.equal(typeof module.apply, 'function', 'factory 没有返回 apply');
assert.ok(Array.isArray(module.inject) && module.inject.length > 0, 'factory 没有返回 inject（服务键）');
for (const key of ['slots', 'sidebarRightTabs', 'sidebarRight']) {
  assert.ok(module.inject.includes(key), `inject 少了服务键 ${key}`);
}

// —— 4. apply 真跑：只给 inject 列出的那些服务，抛了就是契约不符
const calls = { tab: null, pane: null, effects: 0 };
const ctx = {
  effect: (run) => { calls.effects += 1; run(); },
  slots: {
    inject: (name, register) => { calls.pane = name; return register(); },
    register: (definition) => { calls.paneDefinition = definition; return () => {}; },
  },
  sidebarRightTabs: { register: (definition) => { calls.tab = definition; return () => {}; } },
};
module.apply(ctx);
assert.equal(calls.tab?.id, 'oks-artifacts', '没有注册 tab 类型');
// 右栏空着时播的是引导页，它只列登记过 guide 条目的 tab 类型——没登记就等于"看不见"。
assert.ok(Array.isArray(calls.tab?.guide) && calls.tab.guide.length > 0, 'tab 类型没有登记 guide 条目（界面上不会露出来）');
assert.equal(typeof calls.tab.guide[0]?.title, 'function', 'guide 条目的 title 应当是取文案的函数');
assert.equal(calls.pane, 'sidebar.right.pane.tab', '正文没有挂到 sidebar.right.pane.tab 这个槽上');
assert.equal(calls.paneDefinition?.key, 'oks-artifacts', '槽的 key 应当是 tab id');
assert.ok(calls.effects >= 1, 'apply 没有用 ctx.effect 注册（清理函数会拿不到）');

// —— 5. 清单走插件端点
const listing = { keepAliveMinutes: 60, entries: [{ file: 'a.chart.svg', kind: 'chart', pinned: false }] };
const requests = [];
globalThis.fetch = async (url, init) => {
  requests.push({ url, init });
  return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, value: listing }) };
};
assert.deepEqual(await module.readListing('session-1'), listing, '清单要从端点的 value 里取出来');
assert.match(requests[0].url, /^\/oks\/artifacts\?sessionId=session-1$/, '清单端点的路径与查询要正确');

// 端点说不行时要把话说出来，而不是静默成功
globalThis.fetch = async () => ({ ok: false, status: 400, text: async () => JSON.stringify({ ok: false, message: '找不到会话' }) });
await assert.rejects(() => module.readListing('session-1'), /找不到会话/);

// —— 6. 机械通道：★ 直接打后台端点（不经过 agent）
globalThis.fetch = async (url, init) => {
  requests.push({ url, init });
  return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, value: { pinned: true } }) };
};
const before = requests.length;
await module.postPin('session-1', 'artifacts/a.chart.svg', true);
assert.equal(requests.length, before + 1, 'postPin 应当发一次请求');
const sent = requests[requests.length - 1];
assert.equal(sent.url, '/oks/pin', '打的是插件开的保留端点');
assert.equal(sent.init?.method, 'POST');
assert.deepEqual(JSON.parse(sent.init.body),
  { sessionId: 'session-1', src: 'artifacts/a.chart.svg', pinned: true }, '请求体要是那三个字段');

globalThis.fetch = async () => ({ ok: false, status: 400, text: async () => JSON.stringify({ ok: false, message: '这份产物没有自述' }) });
await assert.rejects(() => module.postPin('session-1', 'artifacts/a.chart.svg', true), /没有自述/);

// —— 7. 点条目：在右栏新开一个页签打开它（地址格式与文件面板一致）
assert.equal(module.artifactAddress('session-1', 'a.chart.svg'),
  'dsh-resource://file/session/session-1/artifacts/a.chart.svg', '资源地址的格式要与文件面板一致');
assert.equal(module.artifactAddress('s/1', 'a b.chart.svg'),
  'dsh-resource://file/session/s%2F1/artifacts/a%20b.chart.svg', '地址要逐段编码');

// apply 里那次注册之后，宿主会调用 openResource；这里只确认它确实被接线到了 ctx.sidebarRight
const opened = [];
ctx.sidebarRight = { openResource: (address) => { opened.push(address); } };
assert.equal(typeof ctx.sidebarRight.openResource, 'function', 'sidebarRight.openResource 是打开页签的入口');

// —— 7b. 下载链接：打的是插件的字节端点
assert.equal(module.downloadHref('session-1', 'a.report.html'),
  '/oks/download?sessionId=session-1&file=a.report.html');
assert.equal(module.downloadHref('s/1', 'a b.report.html'),
  '/oks/download?sessionId=s%2F1&file=a%20b.report.html', '两个参数都要编码');

// —— 8. 轮询去重：内容没变就不该更新状态
const base = { keepAliveMinutes: 60, entries: [{ file: 'a.chart.svg', kind: 'chart', title: 't', at: 'now', pinned: false }] };
assert.equal(module.sameListing(base, JSON.parse(JSON.stringify(base))), true, '同样内容算同一份');
assert.equal(module.sameListing(null, base), false, '还没有清单时必须更新');
assert.equal(module.sameListing(base, { ...base, keepAliveMinutes: 30 }), false, '保活窗口变了要更新');
assert.equal(module.sameListing(base, { ...base, entries: [...base.entries, { ...base.entries[0], file: 'b.chart.svg' }] }), false, '多了一条要更新');
assert.equal(module.sameListing(base, { ...base, entries: [{ ...base.entries[0], pinned: true }] }), false, '保留状态变了要更新');
assert.equal(module.sameListing(base, { ...base, entries: [{ ...base.entries[0], title: '改了' }] }), false, '标题变了要更新');

// —— 9. 时间说法（本地时区：从文件名那段 UTC 换算过来）
const at = '20261012T092654Z';
const stamp = Date.UTC(2026, 9, 12, 9, 26, 54);
assert.equal(module.friendlyTime(at, stamp + 5_000), '刚刚');
assert.equal(module.friendlyTime(at, stamp + 8 * 60_000), '8 分钟前');
assert.equal(module.friendlyTime(at, stamp + 3600_000), '今天 17:26', '同一本地日给"今天 + 时刻"');
assert.equal(module.friendlyTime(at, stamp + 26 * 3600_000), '昨天 17:26', '跨一天给"昨天 + 时刻"');
// 格式化的永远是**产物自己**的时间（这里是 2026-10-12 17:26 本地），now 只决定相对说法。
assert.equal(module.friendlyTime(at, stamp + 5 * 86400_000), '10月12日 17:26', '同年给月日 + 时刻');
assert.equal(module.friendlyTime(at, stamp + 400 * 86400_000), '2026年10月12日', '跨年给年月日');
assert.equal(module.friendlyTime('不是时间戳', stamp), '不是时间戳', '认不出就原样返回');

// —— 10. 第二行：精确分类（缺了就"即时分析"）+ 友好时间；不再重复大类"报表"
assert.equal(module.metaLine({ category: '周报', at }, stamp), '周报 · 刚刚');
assert.equal(module.metaLine({ at }, stamp), '即时分析 · 刚刚', '缺分类要落到"即时分析"，不是"报表"');
assert.equal(module.metaLine({ category: '月报', at }, stamp + 8 * 60_000), '月报 · 8 分钟前');

console.log('client.mjs：交付形态、激活契约、三条端点都对 ✓');
console.log(`  inject = ${module.inject.join(', ')} · tab=${calls.tab.kind} · pane=${calls.pane}`);
