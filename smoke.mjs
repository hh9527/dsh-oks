// 本地冒烟测试：用一个假的 cordis ctx 加载插件，直接调用三个工具的真实实现，
// 验证 runner 生命周期、请求配对、SQL+bindings 的渲染、按工作区注册的地图路由，
// 以及"两个工作区各用自己 oks.json 声明的模型"。不安装进 profile。
//
// 插件行这里**什么都不配**：模型、领域、路径全部来自工作区，正是要验证的那一点。
//
// 被测工作区默认取**当前目录**（它必须有 oks.json，否则会明确报错），也可以用环境变量指定：
//
//   cd /path/to/workspace && node /path/to/dsh-oks/smoke.mjs
//   ONTOLOGY_WORKSPACE=/path/to/workspace node smoke.mjs
import { apply } from './index.js';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, relative, resolve } from 'node:path';

const DEV_ROOT = process.env.ONTOLOGY_WORKSPACE ?? process.cwd();

const registered = new Map();
const disposers = [];
const routes = [];

// 假的 web 服务：只记录注册的路由，之后直接调用 handler 验证响应。
const webServer = {
  host: '127.0.0.1',
  port: 10922,
  register: (route) => { routes.push(route); return () => {}; },
};

// 假的技能服务：插件应当自己把引导技能注册进来，而不是靠工作区里放文件。
const skillsRegistered = [];
const skills = {
  register: (skill) => { skillsRegistered.push(skill); return () => {}; },
};

const ctx = {
  logger: { info: (message) => console.error(`[log] ${message}`) },
  // 真实 harness 里服务通过 ctx.get(...) 取（不写进 inject），所以桩照做。
  get: (name) => (name === 'webServer' ? webServer : name === 'skills' ? skills : undefined),
  tools: {
    register: (tool) => {
      registered.set(tool.name, tool);
      return () => registered.delete(tool.name);
    },
  },
  effect: (fn) => {
    const dispose = fn();
    if (typeof dispose === 'function') disposers.push(dispose);
  },
};

apply(ctx, {});
console.error(`registered tools: ${[...registered.keys()].join(', ')}\n`);

// 自带技能：名字、描述、正文都要对；正文与 skill.md 必须逐字一致（单一来源）。
console.log('=== 自带技能（注册进 runtime 层，所有工作区可见）===');
{
  const body = readFileSync(new URL('./skill.md', import.meta.url), 'utf8');
  const skill = skillsRegistered[0];
  console.log(`  注册次数 ${skillsRegistered.length} ${skillsRegistered.length === 1 ? '✓' : '✗'}`);
  if (skill === undefined) {
    console.log('  ✗ 没有注册任何技能');
  } else {
    console.log(`  name=${skill.name} · source=${skill.source} · ${Buffer.byteLength(skill.content, "utf8")} 字节`);
    console.log(`  名字合法(kebab): ${/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skill.name) ? '✓' : '✗'}`
      + ` · 描述非空: ${String(skill.description ?? '').length > 0 ? '✓' : '✗'}`);
    console.log(`  正文 = skill.md 原文: ${skill.content === body ? '✓' : '✗'}`);
    console.log(`  正文不含具体领域名: ${/\bic\b|icloud/i.test(skill.content) ? '✗' : '✓'}`);
  }
}

// exec 模拟 harness 传进来的 ToolRunContext：工作区从会话头里取，不由调用方给。
const sessionFor = (cwd) => ({ agent: { session: { meta: { cwd } } } });

const call = async (name, args, cwd = DEV_ROOT) => {
  const tool = registered.get(name);
  if (!tool) throw new Error(`tool ${name} was not registered`);
  const value = await tool.execute(args, { signal: new AbortController().signal, ...sessionFor(cwd) });
  const content = tool.output.render(args, value);
  return { value, text: content.map((block) => block.text ?? '').join('') };
};

const index = await call('ontology_info', { key: 'index' });
console.log('=== ontology_info {key:"index"} (complete catalog, compact render) ===');
console.log(index.text.split('\n').slice(0, 6).join('\n'));
console.log(`  … 名册共 ${index.text.split('\n').length} 行 · 含 Schema 分组=${index.text.includes('── Schema') ? '✓' : '✗'}`);

const info = await call('ontology_info', { key: 'Dataset/device' });
console.log('=== ontology_info device ===');
console.log(info.text.slice(0, 1200));

const plan = await call('ontology_transform', {
  intents: [
    { op: 'Graph', root: 'd', nodes: [{ id: 'd', entity: 'device' }], edges: [], select: [], count: 'd' },
    { op: 'Graph', root: 'd', nodes: [{ id: 'd', entity: 'device' }], edges: [], select: [], count: 'nope' },
  ],
});
console.log('=== ontology_transform (1 valid + 1 invalid intent) ===');
console.log(plan.text);

const twoIntents = [
  { op: 'Graph', root: 'd', nodes: [{ id: 'd', entity: 'device' }], edges: [], select: [], count: 'd' },
  { op: 'Graph', root: 't', nodes: [{ id: 't', entity: 'tenant' }], edges: [], select: [], count: 't' },
];
const clean = await call('ontology_transform', { intents: twoIntents });
console.log('=== ontology_transform (2 valid intents) ===');
console.log(clean.text);

// 计划文件是**内容寻址**的：名字即内容哈希，同一批 Intent 重复问不新增文件。
console.log('=== 计划文件（ws1 未声明 planDir → 默认落点）===');
const ws1Files = clean.value.plans?.planFiles ?? null;
if (ws1Files === null) {
  console.log('  ✗ 没有写出计划文件');
} else {
  const planDir = `${DEV_ROOT}/.oks/plans`;
  for (const [kind, file] of Object.entries(ws1Files)) {
    if (kind !== 'reused') console.log(`  ${kind}: ${file} · 存在=${existsSync(file)}`);
  }
  console.log(`  落在默认目录下: ${String(ws1Files.sql).startsWith(`${planDir}/`) ? '✓' : '✗'}`);
  // 纯：名字就是文件内容的 sha256 前缀，可以自校验。
  const named = /^plan-([0-9a-f]{16})\.json$/.exec(basename(ws1Files.json));
  const digest = createHash('sha256').update(readFileSync(ws1Files.json)).digest('hex').slice(0, 16);
  console.log(`  名字 = 文件内容的 sha256 前缀: ${named !== null && named[1] === digest ? '✓' : '✗'}`);
  // 同一批 Intent 再问一次：复用同一对文件，目录不增长。
  const before = readdirSync(planDir).length;
  const again = await call('ontology_transform', { intents: twoIntents });
  const againFiles = again.value.plans?.planFiles ?? null;
  const after = readdirSync(planDir).length;
  console.log(`  重问同一批 → reused=${againFiles?.reused} · 路径相同=${againFiles?.json === ws1Files.json ? '✓' : '✗'}`
    + ` · 目录文件数 ${before} → ${after} ${before === after ? '✓' : '✗'}`);
  console.log(`  重问时的渲染: ${/内容与已有计划一致，直接复用/.test(again.text) ? '✓ 明说复用' : '✗ 没说复用'}`);
}

// 这一批会 accepted=true 但带 Warning——验证成功路径上的诊断没有被丢掉。
const warned = await call('ontology_transform', {
  intents: [{
    op: 'Graph', root: 'a', nodes: [{ id: 'a', entity: 'current_alarm' }], edges: [],
    select: [{ node: 'a', dimension: 'alarm_severity' }],
    measures: [{ node: 'a', measure: 'alarm_count' }],
    group_by_identity: ['a'],
    top_by_measure: { node: 'a', measure: 'alarm_count', direction: 'Desc', take: 3 },
  }],
});
console.log('=== ontology_transform (accepted + Warning) ===');
console.log(warned.text);

const conceptMap = await call('ontology_map', {});
console.log('=== ontology_map ===');
console.log(conceptMap.text);

// 直接调用注册到 web 服务的 handler，验证动态伺服的四种响应。
// 基准路径不写死：它由工作区 slug 决定，从工具返回的 URL 里取，顺便验证两者一致。
console.log('=== http 路由（直接调用 handler）===');
const base = new URL(conceptMap.value.url).pathname.replace(/\/+$/, '');
const route = routes.find((item) => item.path === base);
if (!route) {
  console.log(`  ✗ 未注册 ${base} 路由（已注册：${routes.map((r) => r.path).join(', ') || '无'}）`);
} else {
  const request = async (path) => {
    const captured = {};
    const res = {
      writeHead: (status, headers) => { captured.status = status; captured.headers = headers; },
      end: (body) => { captured.body = typeof body === 'string' ? body : ''; },
    };
    await route.handler({ url: path, method: 'GET' }, res);
    return captured;
  };
  for (const path of [`${base}/`, `${base}/map.mmd`, `${base}/mermaid.min.js`, `${base}/nope`]) {
    const got = await request(path);
    const body = String(got.body);
    const extra = path.endsWith('map.mmd') ? ` · 含 flowchart=${body.includes('flowchart LR')} · 含术语子图=${body.includes('subgraph TERMS')}`
      : path.endsWith('mermaid.min.js') ? ` · 302 → ${got.headers?.location ?? '(无)'}`
        : path.endsWith('/') ? ` · 含 fetch 图源=${body.includes(`${base}/map.mmd`)}` : '';
    console.log(`  ${path.replace(base, '').padEnd(16) || '/'} → ${got.status} ${String(got.headers?.['content-type'] ?? '').split(';')[0]} ${body.length}B${extra}`);
  }
  // 另一个工作区的 slug 不该命中这一条路由。
  const foreign = await request('/ontology-map/some-other-workspace/');
  console.log(`  别的 slug 落到本条路由 → ${foreign.status}（前缀不匹配时本不该到达这里）`);
}

// ── 多工作区：同一个插件，两份 oks.json ──────────────────────────────────────
//
// 关键验证：工作区由**会话头**定位；artifact 相对 **oks.json** 解析（这里刻意多套一层目录，
// cwd 相对解析会失败）；地图路由按工作区注册，两个工作区拿到不同的地址。
//
// 第二个工作区复用基准工作区的模型：领域与 artifact 从它的 oks.json 抄，路径按新目录
// 重算相对路径——所以这份测试里不出现任何领域名，插件本来也不该认识领域。
console.log('=== 第二个工作区（嵌套目录，artifact 相对 oks.json 解析）===');
const second = `${DEV_ROOT}/.oks-smoke/nested`;
mkdirSync(second, { recursive: true });
const anchor = JSON.parse(readFileSync(`${DEV_ROOT}/oks.json`, 'utf8'));
writeFileSync(`${second}/oks.json`, `${JSON.stringify({
  version: 1,
  domain: anchor.domain,
  artifact: relative(second, resolve(DEV_ROOT, anchor.artifact)),
  planDir: 'plans',   // 相对 oks.json 解析 → <second>/plans
}, null, 2)}\n`);

const secondIndex = await call('ontology_info', { key: 'index' }, second);
console.log(`  ws2 第一行: ${secondIndex.text.split('\n')[0]}`);
const secondMap = await call('ontology_map', {}, second);
console.log(`  ws1 url: ${conceptMap.value.url}`);
console.log(`  ws2 url: ${secondMap.value.url}`);
console.log(`  地址不同: ${conceptMap.value.url !== secondMap.value.url ? '✓' : '✗'}`);
console.log(`  两条路由: ${[...new Set(routes.map((r) => r.path))].join(', ')}`);
console.log(`  ws2 计数: 数据集 ${secondMap.value.counts.datasets} · 关系 ${secondMap.value.counts.relations}`);

// 计划落点也要跟着工作区走：ws2 在 oks.json 里声明了 planDir。
const secondPlan = await call('ontology_transform', {
  intents: [{ op: 'Graph', root: 'd', nodes: [{ id: 'd', entity: 'device' }], edges: [], select: [], count: 'd' }],
}, second);
const ws2Files = secondPlan.value.plans?.planFiles ?? null;
console.log(`  ws2 计划文件: ${ws2Files?.sql ?? '(未写)'} · 存在=${ws2Files !== null && existsSync(ws2Files.sql)}`);
console.log(`  ws2 落点取自 oks.json 的 planDir: ${ws2Files !== null && String(ws2Files.sql).startsWith(`${second}/plans/`) ? '✓' : '✗'}`);

// ── planDir: false：工作区可以要求"不写计划文件" ─────────────────────────────
console.log('=== 第三个工作区（planDir: false → 不写）===');
const third = `${DEV_ROOT}/.oks-smoke/off`;
mkdirSync(third, { recursive: true });
writeFileSync(`${third}/oks.json`, `${JSON.stringify({
  version: 1,
  domain: anchor.domain,
  artifact: relative(third, resolve(DEV_ROOT, anchor.artifact)),
  planDir: false,
}, null, 2)}\n`);
const thirdPlan = await call('ontology_transform', {
  intents: [{ op: 'Graph', root: 'd', nodes: [{ id: 'd', entity: 'device' }], edges: [], select: [], count: 'd' }],
}, third);
console.log(`  计划文件: ${thirdPlan.value.plans?.planFiles ?? '(未写)'} · 目录存在=${existsSync(`${third}/plans`)}`);
console.log(`  SQL 仍然返回: ${/sql:\s+\S/.test(thirdPlan.text) ? '✓' : '✗'}`);

// ── 没有 oks.json 的工作区：必须报错，而不是悄悄用别的模型 ─────────────────────
console.log('=== 没有 oks.json 的工作区 ===');
try {
  await call('ontology_info', { key: 'index' }, '/tmp');
  console.log('  ✗ 本该报错，却成功了');
} catch (cause) {
  console.log(`  ✓ 拒绝: ${String(cause?.message ?? cause).split('\n')[0]}`);
}

// ── 超时强杀 + 复活：用 1ms 上限的实例，验证 worker 被终止、而且不会把测试挂住 ──
console.log('=== worker 超时强杀 + 复活 ===');
{
  const hostileRegistered = new Map();
  const hostileCtx = {
    logger: { info: () => {} },
    get: (name) => (name === 'webServer' ? webServer : undefined),
    tools: { register: (tool) => { hostileRegistered.set(tool.name, tool); return () => {}; } },
    effect: (fn) => { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose); },
  };
  apply(hostileCtx, { requestTimeoutMs: 1 });
  const tool = hostileRegistered.get('ontology_info');
  const attempt = async () => {
    try {
      await tool.execute({ key: 'index' }, { signal: new AbortController().signal, ...sessionFor(DEV_ROOT) });
      return 'ok（在 1ms 内完成）';
    } catch (cause) {
      return `拒绝: ${cause?.message ?? cause}`;
    }
  };
  console.log(`  第 1 次: ${await attempt()}`);
  console.log(`  第 2 次: ${await attempt()}`);
  console.log('  → 两次都返回而非挂住，说明 terminate 与重新拉起都生效');
}

for (const dispose of disposers.reverse()) dispose();
console.error('disposed cleanly');
