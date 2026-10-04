// 本地冒烟测试：用假的 cordis ctx 加载插件，直接调用各工具的真实实现，不安装进 profile。
// 其中两个与模型无关的时间工具（time_now / time_calc）不需要工作区，也在这里单测。
// 插件行**什么都不配**——领域、模型、数据文件全部来自工作区，正是要验证的那一点。
//
// 夹具**不含任何领域知识、也不假设地图形状**：实体 id 是运行时从服务里走出来的——读
// `index`，按节点自己给出的 key 逐级跟随，直到拿到一个声明了 id 的成员。所以模型换形状
// 不会让这份测试失效；这也正是"代码里不写形状假设"这条原则的自我验证。
//
// 被测工作区默认取**当前目录**（必须有 oks.json，否则明确报错），也可用环境变量指定：
//   cd /path/to/workspace && node /path/to/dsh-oks/smoke.mjs
//   OKS_WORKSPACE=/path/to/workspace node smoke.mjs
import { apply } from './index.js';
import { applyOps, encode, parseMoment } from './time.js';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';

const DEV_ROOT = process.env.OKS_WORKSPACE ?? process.cwd();
const SCRATCH = `${DEV_ROOT}/.oks-smoke`;
// 插件**不在工作区里写任何东西**，所以顶层清单在整场测试前后必须一致。
const workspaceListing = () => readdirSync(DEV_ROOT).filter((name) => name !== '.oks-smoke').sort().join(',');
const listingBefore = workspaceListing();

const registered = new Map();
const disposers = [];
const skillsRegistered = [];
const events = new Map();
const logs = [];
const ctx = {
  logger: { info: (message) => { logs.push(message); console.error(`[log] ${message}`); } },
  // 技能服务是可选的：插件能拿到就注册，拿不到就静默降级。
  get: (name) => (name === 'skills'
    ? { register: (skill) => { skillsRegistered.push(skill); return () => {}; } }
    : undefined),
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
  // 插件按规范监听 agent/pre-step 以取得上下文时区；桩把监听器记下来，测试里手动触发。
  on: (name, listener) => { events.set(name, listener); return () => events.delete(name); },
};

apply(ctx, {});
const toolNames = [...registered.keys()];
console.error(`registered tools: ${toolNames.join(', ')}\n`);
const EXPECTED_TOOLS = ['oks_search', 'oks_references', 'oks_info', 'oks_check_intent', 'oks_query', 'time_now', 'time_calc'];
console.log(`=== 工具集 ===\n  ${toolNames.join(', ')} ${
  EXPECTED_TOOLS.every((name) => toolNames.includes(name)) && toolNames.length === EXPECTED_TOOLS.length ? '✓' : '✗'}`);
for (const name of EXPECTED_TOOLS) {
  if (!toolNames.includes(name)) throw new Error(`missing tool: ${name}（实际 ${toolNames.join(', ')}）`);
}

// exec 模拟 harness 传进来的 ToolRunContext：工作区从会话头里取，不由调用方给。
const sessions = new Map();
const sessionFor = (cwd) => {
  if (!sessions.has(cwd)) sessions.set(cwd, { meta: { cwd } });
  return { agent: { session: sessions.get(cwd) } };
};
const call = async (name, args, cwd = DEV_ROOT) => {
  const tool = registered.get(name);
  if (!tool) throw new Error(`tool ${name} was not registered`);
  const value = await tool.execute(args, { signal: new AbortController().signal, ...sessionFor(cwd) });
  return { value, text: tool.output.render(args, value).map((block) => block.text ?? '').join('') };
};
const foundOf = (value) => value?.trace?.[0]?.response?.ok?.Document?.Found;
const buildCtx = (config) => {
  const tools = new Map();
  const events = new Map();
  apply({
    logger: { info: () => {} },
    get: () => undefined,
    tools: { register: (tool) => { tools.set(tool.name, tool); return () => {}; } },
    effect: (fn) => { const d = fn(); if (typeof d === 'function') disposers.push(d); },
    on: (name, listener) => { events.set(name, listener); return () => {}; },
  }, config);
  return { tools, events };
};
// 只有 oks_info / oks_check_intent / oks_query 需要工作区；时间工具不需要。
const NOWHERE = `${SCRATCH}/nowhere`;
mkdirSync(NOWHERE, { recursive: true });

// ── 自带技能 ────────────────────────────────────────────────────────────────
console.log('=== 自带技能（注册进 runtime 层，所有工作区可见）===');
{
  const body = readFileSync(new URL('./skill.md', import.meta.url), 'utf8');
  const skill = skillsRegistered[0];
  console.log(`  注册次数 ${skillsRegistered.length} ${skillsRegistered.length === 1 ? '✓' : '✗'}`);
  if (skill === undefined) throw new Error('没有注册任何技能');
  console.log(`  name=${skill.name} · source=${skill.source} · ${Buffer.byteLength(skill.content, 'utf8')} 字节`);
  console.log(`  名字合法(kebab): ${/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skill.name) ? '✓' : '✗'}`
    + ` · 描述非空: ${String(skill.description ?? '').length > 0 ? '✓' : '✗'}`);
  console.log(`  正文 = skill.md 原文: ${skill.content === body ? '✓' : '✗'}`);
  console.log(`  正文不含具体领域名: ${/\bic\b|icloud/i.test(skill.content) ? '✗' : '✓'}`);
}

// ── 与模型无关的时间工具（不依赖工作区、不解释领域格式）─────────────────────
console.log('=== 时间辅助工具 ===');
{
  const Z = 'Asia/Shanghai';
  const firePreStep = (cwd, messages) => {
    const listener = events.get('agent/pre-step');
    if (listener === undefined) throw new Error('插件没有监听 agent/pre-step');
    return listener({ agent: { session: sessionFor(cwd).agent.session }, messages }, async () => ({ kind: 'enter' }));
  };
  // 先让上下文带上浏览器时区，后面的日历运算都用它
  await firePreStep(NOWHERE, [{ source: { kind: 'user', rpcId: 'r1', clientTimeZone: Z } }]);
  const fromNowhere = await call('time_now', {}, NOWHERE);
  console.log(`  本地 ${fromNowhere.value.local.text} (${fromNowhere.value.offset})`
    + ` → UTC 文本 ${fromNowhere.value.utc.text} · RFC 3339 ${fromNowhere.value.utc.rfc3339}`);
  const week = await call('time_calc', {
    base: '2026-09-30T12:00:00+08:00',
    operations: [{ op: 'floor', unit: 'week', weekStartsOn: 1 }, { op: 'convert', zone: 'UTC' }],
  }, NOWHERE);
  const weekEnd = await call('time_calc', {
    base: '2026-09-30T12:00:00+08:00',
    operations: [{ op: 'floor', unit: 'week', weekStartsOn: 1 }, { op: 'add', unit: 'week', amount: 1 }, { op: 'convert', zone: 'UTC' }],
  }, NOWHERE);
  console.log(`  上周（周一到周日）半开区间 → [${week.value.utc.text}, ${weekEnd.value.utc.text})`);
  if (week.value.utc.text !== '2026-09-27 16:00:00' || weekEnd.value.utc.text !== '2026-10-04 16:00:00') {
    throw new Error('周对齐或时区换算不对');
  }
  const clamped = await call('time_calc', { base: '2026-01-31T12:00:00+08:00', operations: [{ op: 'add', unit: 'month', amount: 1 }] }, NOWHERE);
  console.log(`  1/31 + 1 月 → ${clamped.value.local.text}（钳制到月末）`);
  if (!clamped.value.local.text.startsWith('2026-02-28')) throw new Error('月末没有钳制');
  const dst = await call('time_calc', {
    base: '2026-03-07T12:00:00', timeZone: 'America/New_York',
    operations: [{ op: 'add', unit: 'day', amount: 1 }],
  }, NOWHERE);
  console.log(`  跨 DST：NY 3/7 12:00 + 1 天 → ${dst.value.local.text}，偏移 ${dst.value.offset}（保持墙钟）`);
  if (!dst.value.local.text.startsWith('2026-03-08')) throw new Error('跨 DST 的一天没有保持墙钟');
  // 上下文里没有时区 → 报错并要求向用户澄清
  await firePreStep(NOWHERE, [{ source: { kind: 'user', rpcId: 'r0' } }]);
  try {
    await call('time_now', {}, NOWHERE);
    console.log('  ✗ 上下文没有时区却成功了');
    throw new Error('没有时区时不应成功');
  } catch (cause) {
    if (!/没有带浏览器时区/.test(String(cause?.message ?? cause))) throw cause;
    console.log('  ✓ 上下文没有时区时明确报错，要求向用户澄清');
  }
  // 上下文带来浏览器时区 → 自动取用（规范字段 source.clientTimeZone）
  await firePreStep(NOWHERE, [{ source: { kind: 'user', rpcId: 'r1', clientTimeZone: Z } }]);
  const fromContext = await call('time_now', {}, NOWHERE);
  console.log(`  上下文浏览器时区 → source=${fromContext.value.timeZoneSource} · zone=${fromContext.value.timeZone}`);
  if (fromContext.value.timeZoneSource !== 'context' || fromContext.value.timeZone !== Z) {
    throw new Error('上下文时区没有生效');
  }
  // 同一回合的第 2 步：payload.messages 为空，不能把已取到的时区覆盖成 missing
  await firePreStep(NOWHERE, []);
  const afterEmptyStep = await call('time_now', {}, NOWHERE);
  if (afterEmptyStep.value.timeZoneSource !== 'context' || afterEmptyStep.value.timeZone !== Z) {
    throw new Error('空消息的那一步把上下文时区覆盖掉了');
  }
  console.log('  ✓ 同回合后续步骤（无用户消息）不会覆盖已取到的上下文时区');
  // 上下文时区冲突 → 按规范请用户澄清，而不是随便挑一个
  await firePreStep(NOWHERE, [
    { source: { kind: 'user', rpcId: 'r1', clientTimeZone: Z } },
    { source: { kind: 'user', rpcId: 'r2', clientTimeZone: 'UTC' } },
  ]);
  try {
    await call('time_now', {}, NOWHERE);
    console.log('  ✗ 时区冲突却成功了');
    throw new Error('时区冲突时不应成功');
  } catch (cause) {
    if (!/不一致/.test(String(cause?.message ?? cause))) throw cause;
    console.log('  ✓ 上下文时区冲突时明确报错，要求澄清');
  }
  // 显式参数可以覆盖上下文
  await firePreStep(NOWHERE, [{ source: { kind: 'user', rpcId: 'r1', clientTimeZone: 'UTC' } }]);
  const overridden = await call('time_now', { timeZone: Z }, NOWHERE);
  console.log(`  显式参数覆盖上下文 → source=${overridden.value.timeZoneSource} · zone=${overridden.value.timeZone}`);
  if (overridden.value.timeZoneSource !== 'argument' || overridden.value.timeZone !== Z) {
    throw new Error('显式参数没有覆盖上下文');
  }
  // 设置里能覆盖的只有那几个键：给了别的键，行为照旧（时区来自上下文，工作区来自会话头）
  {
    const { tools, events: built } = buildCtx({ timeZone: 'UTC' });
    const session = { meta: { cwd: NOWHERE } };
    await built.get('agent/pre-step')({
      agent: { session },
      messages: [{ source: { kind: 'user', rpcId: 'r1', clientTimeZone: Z } }],
    }, async () => ({ kind: 'enter' }));
    const value = await tools.get('time_now').execute({}, { signal: new AbortController().signal, agent: { session } });
    console.log('  config.timeZone=UTC 时实际用 → ' + value.timeZoneSource + ' / ' + value.timeZone);
    if (value.timeZoneSource !== 'context' || value.timeZone !== Z) throw new Error('时区应当只来自上下文');
    try {
      await tools.get('oks_info').execute({ key: 'index' }, { signal: new AbortController().signal, agent: { session: { meta: {} } } });
      throw new Error('工作区应当只来自会话头');
    } catch (cause) {
      if (!/无法确定当前会话的工作区目录/.test(String(cause?.message ?? cause))) throw cause;
      console.log('  ✓ 工作区只来自会话头：没有 cwd 时在运行时报错');
    }
  }
  // 会话头里没有 cwd 时明确报错，而不是回落到别的目录
  try {
    await registered.get('oks_info').execute({ key: 'index' }, { signal: new AbortController().signal, agent: { session: { meta: {} } } });
    console.log('  ✗ 会话头没有 cwd 却成功了');
    throw new Error('没有 cwd 时不应成功');
  } catch (cause) {
    if (!/无法确定当前会话的工作区目录/.test(String(cause?.message ?? cause))) throw cause;
    console.log('  ✓ 会话头没有 cwd 时明确报错');
  }
}

// ── 发现协议：从 index 出发，只跟随节点给出的 key ────────────────────────────
console.log('=== 发现协议（不假设形状，只跟随服务给出的 key）===');
const seenKeys = new Set();
const trail = [];
let reached = null;
const walk = async (key, depth) => {
  if (depth > 6 || seenKeys.size >= 24 || seenKeys.has(key)) return;
  seenKeys.add(key);
  const found = foundOf((await call('oks_info', { key })).value);
  trail.push(`${'· '.repeat(depth)}${found?.type ?? '?'}  ${key}`);
  const detail = found?.detail;
  if (reached === null && typeof detail?.id === 'string' && detail.id !== '') {
    reached = { key, id: detail.id, type: found?.type, links: found?.links ?? [] };
  }
  const children = [];
  if (Array.isArray(detail?.entries)) {
    for (const entry of detail.entries) if (typeof entry?.key === 'string') children.push(entry.key);
  }
  if (Array.isArray(detail?.schemas)) {
    for (const schema of detail.schemas) if (typeof schema === 'string') children.push(schema);
  }
  for (const link of found?.links ?? []) if (typeof link?.key === 'string') children.push(link.key);
  for (const child of children) await walk(child, depth + 1);
};
await walk('index', 0);
for (const line of trail) console.log(`  ${line}`);
console.log(`  跟随 ${seenKeys.size} 个 key${reached === null ? '（入口没直接落到成员）' : ` · 落到声明了 id 的节点: ${reached.type}`}`);

// Intent 的实体是服务声明的数据集 id：用 oks_search 拿到词条，再按 index 声明的 key 模式
// 拼出 key 去读节点——这就是 agent 的拼法（填声明的模式，名字各编码一次）。
let member = reached !== null && reached.type === 'Dataset' ? reached : null;
if (member === null) {
  const indexNode = foundOf((await call('oks_info', { key: 'index' })).value);
  const pattern = (indexNode?.detail?.key_patterns ?? []).find((item) => item.kind === 'Dataset'
    || String(item.pattern).startsWith('Dataset/'));
  const datasets = await call('oks_search', { kind: 'Dataset' });
  for (const row of datasets.value.matched) {
    if (pattern === undefined) break;
    const key = String(pattern.pattern).replace(/\{(\w+)\}/g, () => encodeURIComponent(row.name));
    const found = foundOf((await call('oks_info', { key })).value);
    if (found?.type === 'Dataset' && typeof found.detail?.id === 'string') {
      member = { key, id: found.detail.id, type: found.type, links: found.links ?? [] };
      console.log(`  按声明的模式拼出实体 key: ${key} → id=${found.detail.id}`);
      break;
    }
  }
}
if (member === null) throw new Error('没有找到任何声明了 id 的数据集实体');
console.log(`  实体：${member.type} · id=${member.id}`);
// 再从那个成员往下找**第一个声明了 id 的 Dimension**（用来问"多行结果"）。
// 找不到就跳过那一段——测试不写形状假设，模型的形状由服务回答。
let dimension = null;
{
  const seen = new Set();
  let budget = 60;
  const seek = async (key, depth) => {
    if (dimension !== null || budget <= 0 || depth > 6 || seen.has(key)) return;
    seen.add(key); budget -= 1;
    const found = foundOf((await call('oks_info', { key })).value);
    const detail = found?.detail;
    if (found?.type === 'Dimension' && typeof detail?.id === 'string') { dimension = { key, id: detail.id }; return; }
    const children = [];
    if (Array.isArray(detail?.entries)) for (const entry of detail.entries) if (typeof entry?.key === 'string') children.push(entry.key);
    for (const link of found?.links ?? []) if (typeof link?.key === 'string') children.push(link.key);
    for (const child of children) await seek(child, depth + 1);
  };
  await seek(member.key, 0);
}
console.log(`  维度（多行用例）：${dimension === null ? '未找到，跳过' : `id=${dimension.id}`}`);

// ── 检索层：词汇表与引用图（按服务声明的发现契约派生）───────────────────────
console.log('=== oks_search（按名词/说法找 key）===');
let seed = null;
{
  const started = Date.now();
  const all = await call('oks_search', {});
  console.log(`  首次检索（含按发现契约建索引）${Date.now() - started} ms · 命中 ${all.value.total} 条`);
  // 没有 limit：页大小按字节定，装不下就整条截断并报出剩余
  const capped = all.value.more !== null && all.value.matched.length < all.value.total;
  console.log(`  超容量时整条截断并报出 more: ${capped ? '✓' : '✗'}`);
  if (!capped) throw new Error('空查询应当匹配全部词条并按容量截断');
  const bytes = Buffer.byteLength(all.text, 'utf8');
  console.log(`  渲染 ${bytes} 字节 ≤ 8192: ${bytes <= 8192 ? '✓' : '✗'}`);
  if (bytes > 8192) throw new Error('检索渲染超过了宿主裁剪阈值');
  // 翻页：第二页与第一页不重叠，start 回显请求的 skip
  const skip = all.value.matched.length;
  const page2 = await call('oks_search', { skip });
  const firstPage = new Set(all.value.matched.map((row) => JSON.stringify(row)));
  const overlap = page2.value.matched.filter((row) => firstPage.has(JSON.stringify(row))).length;
  console.log(`  skip=${skip} 翻页不重复: ${overlap === 0 ? '✓' : '✗'} · start 回显: ${page2.value.start === skip ? '✓' : '✗'}`);
  if (overlap !== 0) throw new Error('翻页出现重复条目');
  // 数据驱动：拿一条真实词条去搜它自己的名字
  seed = all.value.matched.find((row) => row.name.length >= 4 && row.kind !== 'Value') ?? all.value.matched[0];
  const hit = await call('oks_search', { query: seed.name });
  const self = hit.value.matched.find((row) => row.kind === seed.kind && row.name === seed.name
    && (seed.dataset === undefined || row.dataset === seed.dataset));
  console.log(`  按名字 ${seed.kind}/${seed.name} 检索命中它本身: ${self === undefined ? '✗' : '✓'}`
    + ` · 首位 field=${hit.value.matched[0]?.field} score=${hit.value.matched[0]?.score}`);
  if (self === undefined) throw new Error('按名字检索没有命中该词条本身');
  const byKind = await call('oks_search', { kind: 'Dataset' });
  console.log(`  kind=Dataset 过滤生效: ${byKind.value.matched.every((row) => row.kind === 'Dataset') ? '✓' : '✗'} · 命中 ${byKind.value.total}`);
  if (seed.dataset !== undefined) {
    const byDataset = await call('oks_search', { kind: seed.kind, dataset: seed.dataset });
    console.log(`  dataset=${seed.dataset} 过滤生效: ${byDataset.value.matched.every((row) => row.dataset === seed.dataset) ? '✓' : '✗'} · 命中 ${byDataset.value.total}`);
  }
  const again = await call('oks_search', { query: seed.name });
  const stable = JSON.stringify(again.value) === JSON.stringify(hit.value);
  console.log(`  同参数逐字可复现: ${stable ? '✓' : '✗'}`);
  if (!stable) throw new Error('同参数两次结果不同');
  const zero = await call('oks_search', { query: 'zzz-no-such-term-zzz' });
  console.log(`  0 命中给出 facet: ${zero.value.total === 0 && /可用的 kind/.test(zero.text) ? '✓' : '✗'}`);
  if (zero.value.total !== 0) throw new Error('不存在的词不该有命中');
}

// 与服务发布物对比：派生结果必须与同一份产物的发布物逐项相同（存在发布物才比）
console.log('=== 与发布物对比 ===');
{
  const workspace = JSON.parse(readFileSync(`${DEV_ROOT}/oks.json`, 'utf8'));
  const artifact = resolve(DEV_ROOT, workspace.artifact);
  const base = artifact.replace(/\.snapshot\.wasm$/, '').replace(/\.wasm$/, '');
  const reportPath = [`${base}.report.json`, `${base}.derived.report.json`]
    .find((candidate) => existsSync(candidate));
  if (reportPath === undefined) {
    console.log('  未找到同前缀的 report.json，跳过');
  } else {
    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    const line = logs.find((message) => message.includes('discovery index')) ?? '';
    const nodes = Number(/·\s*(\d+) 节点/.exec(line)?.[1] ?? -1);
    const links = Number(/·\s*(\d+) 引用/.exec(line)?.[1] ?? -1);
    console.log(`  ${relative(DEV_ROOT, reportPath)} · 节点 ${nodes} = ${report.nodes} ${nodes === report.nodes ? '✓' : '✗'}`);
    if (nodes !== report.nodes) throw new Error('派生节点数与发布物不一致');
    console.log(`  引用 ${links} = ${report.links} ${links === report.links ? '✓' : '✗'}`);
    if (links !== report.links) throw new Error('派生引用数与发布物不一致');
    const groups = { Dataset: 'datasets', Dimension: 'dimensions', Measure: 'measures', Relation: 'rels', Type: 'types', Value: 'values' };
    for (const [kind, group] of Object.entries(groups)) {
      if (report.counts?.[group] === undefined) continue;
      const total = (await call('oks_search', { kind })).value.total;
      console.log(`  ${kind} ${total} = ${report.counts[group]} ${total === report.counts[group] ? '✓' : '✗'}`);
      if (total !== report.counts[group]) throw new Error(`词条计数与发布物不一致：${kind}`);
    }
  }
}

console.log('=== oks_references（按 key 反向找引用）===');
{
  // 用正向图做往返验证：节点 A 指向 B，则 B 的反向引用里必须能看到 A
  const node = foundOf((await call('oks_info', { key: member.key })).value);
  const forward = (node?.links ?? []).find((link) => typeof link?.key === 'string');
  if (forward === undefined) {
    console.log('  该成员没有正向引用，跳过往返验证');
  } else {
    const back = await call('oks_references', { key: forward.key });
    const roundTrip = back.value.references.some((ref) => ref.source === node.key && ref.link === forward.type);
    console.log(`  ${node.key} → ${forward.key} 的反向引用含它自己: ${roundTrip ? '✓' : '✗'} · 该 key 共 ${back.value.total} 条引用`);
    if (!roundTrip) throw new Error('正向引用没有出现在反向结果里');
    const filtered = await call('oks_references', { key: forward.key, link: forward.type });
    console.log(`  link=${forward.type} 过滤生效: ${filtered.value.references.every((ref) => ref.link === forward.type) ? '✓' : '✗'}`);
    if (back.value.total > back.value.references.length) {
      const next = await call('oks_references', { key: forward.key, skip: back.value.references.length });
      console.log(`  skip 翻页 start=${next.value.start} ${next.value.start === back.value.references.length ? '✓' : '✗'}`);
    } else {
      console.log(`  一页装得下（more=null ${back.value.more === null ? '✓' : '✗'}）`);
    }
  }
  let rejected = false;
  try {
    await call('oks_references', { key: 'Dataset/zzz-no-such-key-zzz' });
  } catch (cause) {
    rejected = /不是这个产物里的知识 key/.test(String(cause?.message ?? cause));
  }
  console.log(`  未知 key 明确报错: ${rejected ? '✓' : '✗'}`);
  if (!rejected) throw new Error('未知 key 应当报错，而不是回空');
}

const countIntents = [{ op: 'Graph', root: 'x', nodes: [{ id: 'x', entity: member.id }], edges: [], select: [], count: 'x' }];
const brokenIntents = [{ op: 'Graph', root: 'x', nodes: [{ id: 'x', entity: 'no_such_entity_from_smoke' }], edges: [], select: [], count: 'x' }];

// ── 校验路径：只回诊断，不回任何语句 ────────────────────────────────────────
console.log('=== oks_check_intent（只校验）===');
{
  const accepted = await call('oks_check_intent', { intents: countIntents });
  console.log(accepted.text.split('\n').filter((line) => /◂|校验结论/.test(line)).map((l) => `  ${l}`).join('\n'));
  if (!/全部可用/.test(accepted.text)) throw new Error('有效批次应当判定为可用');
  const leak = /select\s|sql:|bindings:/i.test(accepted.text);
  console.log(`  渲染里没有语句: ${leak ? '✗' : '✓'}`);
  if (leak) throw new Error('校验路径不应当出现语句');
  const structured = JSON.stringify(accepted.value);
  console.log(`  结构化值里也没有 queries: ${/"queries"/.test(structured) ? '✗' : '✓'}`);
  if (/"queries"/.test(structured)) throw new Error('校验路径的结构化值里仍然带着 queries');

  const partial = await call('oks_check_intent', { intents: [...countIntents, ...brokenIntents] });
  console.log(partial.text.split('\n').filter((line) => /◂|✕|再校验|校验结论/.test(line)).map((l) => `  ${l}`).join('\n').slice(0, 700));
  if (!/✕\s*Error/.test(partial.text)) throw new Error('坏 Intent 应当报 Error 诊断');
  if (!/再校验一次.*通过/.test(partial.text)) throw new Error('未报 Error 的子集应当被单独确认');
  if (!/被拒绝/.test(partial.text)) throw new Error('被拒的 Intent 应当单独列出');
}

// ── 查询路径：真的执行、真的返回行，并且带上来源语句 ────────────────────────
console.log('=== oks_query（只读执行）===');
{
  const answer = await call('oks_query', { intents: countIntents });
  const first = answer.value.results?.[0] ?? null;
  console.log(answer.text.split('\n').filter((line) => /◂|── 结果|执行：|^\|/.test(line)).map((l) => `  ${l}`).join('\n').slice(0, 700));
  if (first === null) throw new Error('有效查询没有产生结果');
  if (first.error !== null) throw new Error(`查询失败：${first.error}`);
  console.log(`  行数 ${first.rows.length} · 渲染 ${answer.text.length} 字符（pruner 阈值 8192）`);
  if (first.rows.length < 1) throw new Error('查询应当至少返回一行');
  if (!/sql:/.test(answer.text) || !/执行：\d+ 行/.test(answer.text)) throw new Error('查询结果应当带上语句与执行摘要');
  if (answer.text.length >= 8192) throw new Error('模型可见文本超过了 pruner 阈值');

  const rejected = await call('oks_query', { intents: brokenIntents });
  console.log(rejected.text.split('\n').filter((line) => /◂|✕|被拒绝|没有/.test(line)).map((l) => `  ${l}`).join('\n').slice(0, 500));
  if ((rejected.value.results ?? []).length !== 0) throw new Error('被拒批次不应产生结果');
  if (!/被拒绝/.test(rejected.text)) throw new Error('被拒批次应当列出诊断');
}

// ── 行数上限：换一个 queryMaxRows=2 的实例，看截断有没有说出来 ───────────────
console.log('=== 行数上限与截断说明（queryMaxRows=2）===');
if (dimension === null) {
  console.log('  （跳过：发现协议没走到维度节点）');
} else {
  const { tools } = buildCtx({ queryMaxRows: 2 });
  const tool = tools.get('oks_query');
  const intents = [{ op: 'Graph', root: 'x', nodes: [{ id: 'x', entity: member.id }], edges: [], select: [{ node: 'x', dimension: dimension.id }] }];
  const value = await tool.execute({ intents }, { signal: new AbortController().signal, ...sessionFor(DEV_ROOT) });
  const text = tool.output.render({ intents }, value).map((block) => block.text ?? '').join('');
  const first = value.results?.[0] ?? null;
  console.log(text.split('\n').filter((line) => /执行：|只显示/.test(line)).map((l) => `  ${l}`).join('\n'));
  if (first === null || first.error !== null) throw new Error(`多行查询失败：${first?.error ?? '(无结果)'}`);
  if (first.truncated) {
    if (first.rows.length !== 2) throw new Error('截断时应当恰好取回上限行数');
    if (!/已到行数上限 2|只显示前 2 行/.test(text)) throw new Error('截断必须在模型可见文本里写明');
    console.log('  ✓ 取回行数等于上限，渲染里写明截断');
  } else {
    console.log(`  （跳过：这个数据集只有 ${first.rows.length} 行，未触及上限）`);
  }
}

// ── 第二个工作区：artifact 与 dataFile 都相对 oks.json 解析 ─────────────────
console.log('=== 第二个工作区（嵌套目录，路径都相对 oks.json）===');
{
  mkdirSync(`${SCRATCH}/nested`, { recursive: true });
  const anchor = JSON.parse(readFileSync(`${DEV_ROOT}/oks.json`, 'utf8'));
  const nested = `${SCRATCH}/nested`;
  const entry = {
    version: 1,
    domain: anchor.domain,
    artifact: relative(nested, resolve(DEV_ROOT, anchor.artifact)),
  };
  if (typeof anchor.dataFile === 'string') entry.dataFile = relative(nested, resolve(DEV_ROOT, anchor.dataFile));
  writeFileSync(`${nested}/oks.json`, `${JSON.stringify(entry, null, 2)}\n`);
  const nestedAnswer = await call('oks_query', { intents: countIntents }, nested);
  const first = nestedAnswer.value.results?.[0] ?? null;
  console.log(`  相对路径解析 → ${first === null ? '✗ 无结果' : `行数 ${first.rows.length} ✓`}`);
  if (first === null || first.error !== null) throw new Error('嵌套工作区的相对路径没有解析对');
}

// ── 第三个工作区：没有 dataFile → 查询报错，校验照常 ────────────────────────
console.log('=== 没有 dataFile 的工作区（只能校验）===');
{
  mkdirSync(`${SCRATCH}/no-data`, { recursive: true });
  const anchor = JSON.parse(readFileSync(`${DEV_ROOT}/oks.json`, 'utf8'));
  const dir = `${SCRATCH}/no-data`;
  writeFileSync(`${dir}/oks.json`, `${JSON.stringify({
    version: 1, domain: anchor.domain, artifact: relative(dir, resolve(DEV_ROOT, anchor.artifact)),
  }, null, 2)}\n`);
  try {
    await call('oks_query', { intents: countIntents }, dir);
    console.log('  ✗ 没有 dataFile 却查成功了');
    throw new Error('没有 dataFile 时 oks_query 应当报错');
  } catch (cause) {
    if (!/没有声明 dataFile/.test(String(cause?.message ?? cause))) throw cause;
    console.log(`  ✓ oks_query 拒绝: ${String(cause.message).split('\n')[0].slice(0, 110)}`);
  }
  const checked = await call('oks_check_intent', { intents: countIntents }, dir);
  console.log(`  oks_check_intent 仍可用: ${/全部可用/.test(checked.text) ? '✓' : '✗'}`);
}

// ── 第四个工作区：dataFile 不是数据库 → 结果里说明执行失败 ──────────────────
console.log('=== 坏 dataFile（不是 SQLite）===');
{
  mkdirSync(`${SCRATCH}/bad-data`, { recursive: true });
  const anchor = JSON.parse(readFileSync(`${DEV_ROOT}/oks.json`, 'utf8'));
  const dir = `${SCRATCH}/bad-data`;
  writeFileSync(`${dir}/junk.txt`, 'not a database\n');
  writeFileSync(`${dir}/oks.json`, `${JSON.stringify({
    version: 1, domain: anchor.domain,
    artifact: relative(dir, resolve(DEV_ROOT, anchor.artifact)),
    dataFile: 'junk.txt',
  }, null, 2)}\n`);
  const failed = await call('oks_query', { intents: countIntents }, dir);
  const first = failed.value.results?.[0] ?? null;
  console.log(`  ${String(first?.error ?? '(没有错误)').slice(0, 120)}`);
  console.log(`  渲染里写明执行失败: ${/执行失败/.test(failed.text) ? '✓' : '✗'}`);
  if (!/执行失败/.test(failed.text)) throw new Error('坏数据文件必须在结果里写明');
}

// ── 没有 oks.json 的工作区：明确报错，不回落到别的模型 ─────────────────────
console.log('=== 没有 oks.json 的工作区 ===');
{
  const bare = `${SCRATCH}/bare`;
  mkdirSync(bare, { recursive: true });
  try {
    await call('oks_info', { key: 'index' }, bare);
    console.log('  ✗ 本该报错，却成功了');
  } catch (cause) {
    console.log(`  ✓ 拒绝: ${String(cause?.message ?? cause).split('\n')[0].slice(0, 120)}`);
  }
}

// ── 没有快照段的产物：准入检查要在第一次用到该工作区时就报错 ────────────────
console.log('=== 非快照产物（只有 wasm 头，没有 telora.snapshot 段）===');
{
  const empty = `${SCRATCH}/empty`;
  mkdirSync(empty, { recursive: true });
  writeFileSync(`${empty}/empty.wasm`, Uint8Array.of(0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00));
  writeFileSync(`${empty}/oks.json`, `${JSON.stringify({
    version: 1, domain: 'ic', artifact: 'empty.wasm',
  }, null, 2)}\n`);
  try {
    await call('oks_info', { key: 'index' }, empty);
    console.log('  ✗ 本该报错，却成功了');
  } catch (cause) {
    console.log(`  ✓ 拒绝: ${String(cause?.message ?? cause).split('\n')[0].slice(0, 140)}`);
  }
}

// ── 插件不写工作区：整场测试前后顶层清单必须一致，且没有 .oks/plans ─────────
console.log('=== 插件不在工作区里写任何东西 ===');
{
  const after = workspaceListing();
  console.log(`  顶层清单未变: ${after === listingBefore ? '✓' : `✗ (${listingBefore} → ${after})`}`);
  console.log(`  没有 .oks/plans: ${existsSync(`${DEV_ROOT}/.oks`) ? '✗' : '✓'}`);
  if (after !== listingBefore) throw new Error('插件在工作区里创建了文件');
  if (existsSync(`${DEV_ROOT}/.oks`)) throw new Error('计划文件目录不该存在');
}

// ── 超时强杀：1 ms 上限，验证 worker 被终止而且不会把测试挂住 ───────────────
console.log('=== 超时强杀 + 复活（requestTimeoutMs=1）===');
{
  const { tools } = buildCtx({ requestTimeoutMs: 1 });
  const tool = tools.get('oks_info');
  const attempt = async () => {
    try {
      await tool.execute({ key: 'index' }, { signal: new AbortController().signal, ...sessionFor(DEV_ROOT) });
      return 'ok（在 1 ms 内完成）';
    } catch (cause) {
      return `拒绝: ${String(cause?.message ?? cause).slice(0, 80)}`;
    }
  };
  console.log(`  第 1 次: ${await attempt()}`);
  console.log(`  第 2 次: ${await attempt()}`);
}

// ── 查询超时：同样的强杀路径要对执行器也成立 ────────────────────────────────
console.log('=== 查询超时 + 复活（queryTimeoutMs=1）===');
{
  const { tools } = buildCtx({ queryTimeoutMs: 1 });
  const tool = tools.get('oks_query');
  const attempt = async () => {
    const value = await tool.execute({ intents: countIntents }, { signal: new AbortController().signal, ...sessionFor(DEV_ROOT) });
    const first = value.results?.[0] ?? null;
    if (first === null) return '没有结果';
    return first.error === null ? `ok（1 ms 内跑完，${first.rows.length} 行）` : `拒绝: ${first.error.slice(0, 70)}`;
  };
  console.log(`  第 1 次: ${await attempt()}`);
  console.log(`  第 2 次: ${await attempt()}`);
}

for (const dispose of disposers.reverse()) dispose();
rmSync(SCRATCH, { recursive: true, force: true });
console.error('disposed cleanly');
