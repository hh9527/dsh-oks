// 本地冒烟测试：用假的 cordis ctx 加载插件，直接调用四个工具的真实实现，不安装进 profile。
// 其中两个与模型无关的时间工具（time_now / time_calc）不需要工作区，也在这里单测。
// 插件行**什么都不配**——模型、领域、路径全部来自工作区，正是要验证的那一点。
//
// 夹具**不含任何领域知识、也不假设地图形状**：实体 id 是运行时从服务里走出来的——读
// `index`，按节点自己给出的 key 逐级跟随，直到拿到一个声明了 id 的成员。所以模型换形状
// 不会让这份测试失效；这也正是"代码里不写形状假设"这条原则的自我验证。
//
// 被测工作区默认取**当前目录**（必须有 oks.json，否则明确报错），也可用环境变量指定：
//   cd /path/to/workspace && node /path/to/dsh-oks/smoke.mjs
//   ONTOLOGY_WORKSPACE=/path/to/workspace node smoke.mjs
import { apply } from './index.js';
import { applyOps, encode, parseMoment } from './time.js';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';

const DEV_ROOT = process.env.ONTOLOGY_WORKSPACE ?? process.cwd();
const SCRATCH = `${DEV_ROOT}/.oks-smoke`;

const registered = new Map();
const disposers = [];
const skillsRegistered = [];
const ctx = {
  logger: { info: (message) => console.error(`[log] ${message}`) },
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

const events = new Map();
apply(ctx, {});
const toolNames = [...registered.keys()];
console.error(`registered tools: ${toolNames.join(', ')}\n`);
const EXPECTED_TOOLS = ['ontology_info', 'ontology_transform', 'time_now', 'time_calc'];
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
  const base = parseMoment('2026-09-30 17:00:00', Z);
  const enc = encode(base, Z);
  console.log(`  本地 2026-09-30 17:00:00 (+08) → UTC 文本 ${enc.utc.text} · RFC 3339 ${enc.utc.rfc3339}`);
  if (enc.utc.text !== '2026-09-30 09:00:00') throw new Error(`UTC 文本错了: ${enc.utc.text}`);
  const monday = applyOps({ epochMillis: base, zone: Z }, [{ op: 'floor', unit: 'week' }]);
  const lastMonday = applyOps({ epochMillis: monday.epochMillis, zone: Z }, [{ op: 'add', unit: 'day', amount: -7 }]);
  console.log(`  上周（周一到周日）半开区间 → [${encode(lastMonday.epochMillis, Z).local.text}, ${encode(monday.epochMillis, Z).local.text})`);
  if (encode(monday.epochMillis, Z).local.text !== '2026-09-28 00:00:00') throw new Error('周一取整错了');
  if (encode(lastMonday.epochMillis, Z).local.text !== '2026-09-21 00:00:00') throw new Error('上周取整错了');
  const clamped = applyOps({ epochMillis: parseMoment('2026-01-31 12:00:00', Z), zone: Z }, [{ op: 'add', unit: 'month', amount: 1 }]);
  console.log(`  1/31 + 1 月 → ${encode(clamped.epochMillis, Z).local.text}（钳制到月末）`);
  if (encode(clamped.epochMillis, Z).local.text !== '2026-02-28 12:00:00') throw new Error('月末钳制错了');
  const ny = 'America/New_York';
  const before = parseMoment('2026-03-07 12:00:00', ny);
  const after = applyOps({ epochMillis: before, zone: ny }, [{ op: 'add', unit: 'day', amount: 1 }]);
  const hours = (after.epochMillis - before) / 3600000;
  console.log(`  跨 DST：NY 3/7 12:00 + 1 天 → ${encode(after.epochMillis, ny).local.text}，实际 ${hours} 小时（保持墙钟）`);
  if (hours !== 23) throw new Error(`DST 处理错了: ${hours} 小时`);
  // 两个工具本身：故意给一个**没有 oks.json** 的 cwd，证明它们不依赖工作区
  const nowhere = '/nonexistent-workspace-for-time-tools';
  const now = await call('time_now', { timeZone: Z }, nowhere);
  console.log(`  time_now: epochMillis=${now.value.epochMillis} · UTC ${now.value.utc.text} · 本地 ${now.value.local.text} · 第 ${now.value.isoWeek.week} 周`);
  if (typeof now.value.epochMillis !== 'number' || typeof now.value.utc.text !== 'string') throw new Error('time_now 输出不对');
  const calc = await call('time_calc', { base: '2026-09-30 17:00:00', timeZone: Z, operations: [{ op: 'floor', unit: 'week' }] }, nowhere);
  console.log(`  time_calc: ${calc.value.operations.join(' → ')} → ${calc.value.local.text}`);
  if (calc.value.local.text !== '2026-09-28 00:00:00') throw new Error('time_calc 结果不对');
  // 上下文里没有时区（本次请求没带）→ 必须报错并要求向用户澄清；宿主时区不是兜底
  const preStep = events.get('agent/pre-step');
  if (typeof preStep !== 'function') throw new Error('插件没有监听 agent/pre-step，取不到上下文时区');
  const firePreStep = (cwd, messages) => preStep(
    { agent: sessionFor(cwd).agent, messages, turn: 1, step: 1 },
    async () => ({ kind: 'enter' }),
  );
  try {
    await call('time_now', {}, nowhere);
    console.log('  ✗ 没给时区却成功了（不该用宿主时区兜底）');
    throw new Error('没有时区时 time_now 不应成功');
  } catch (cause) {
    if (!/上下文里没有时区/.test(String(cause?.message ?? cause))) throw cause;
    console.log('  ✓ 上下文没有时区时明确报错，要求向用户澄清');
  }
  // 上下文带来浏览器时区 → 自动取用（规范字段 source.clientTimeZone）
  await firePreStep(nowhere, [{ source: { kind: 'user', rpcId: 'r1', clientTimeZone: Z } }]);
  const fromContext = await call('time_now', {}, nowhere);
  console.log(`  上下文浏览器时区 → source=${fromContext.value.timeZoneSource} · zone=${fromContext.value.timeZone}`);
  if (fromContext.value.timeZoneSource !== 'context' || fromContext.value.timeZone !== Z) {
    throw new Error('上下文时区没有生效');
  }
  // 上下文时区冲突 → 按规范请用户澄清，而不是随便挑一个
  await firePreStep(nowhere, [
    { source: { kind: 'user', rpcId: 'r1', clientTimeZone: Z } },
    { source: { kind: 'user', rpcId: 'r2', clientTimeZone: 'UTC' } },
  ]);
  try {
    await call('time_now', {}, nowhere);
    console.log('  ✗ 时区冲突却成功了');
    throw new Error('时区冲突时不应成功');
  } catch (cause) {
    if (!/不一致/.test(String(cause?.message ?? cause))) throw cause;
    console.log('  ✓ 上下文时区冲突时明确报错，要求澄清');
  }
  // 显式参数可以覆盖上下文
  await firePreStep(nowhere, [{ source: { kind: 'user', rpcId: 'r1', clientTimeZone: 'UTC' } }]);
  const overridden = await call('time_now', { timeZone: Z }, nowhere);
  console.log(`  显式参数覆盖上下文 → source=${overridden.value.timeZoneSource} · zone=${overridden.value.timeZone}`);
  if (overridden.value.timeZoneSource !== 'argument' || overridden.value.timeZone !== Z) {
    throw new Error('显式参数没有覆盖上下文');
  }
  // 插件行声明了时区就按声明走
  const declared = new Map();
  apply({
    logger: { info: () => {} },
    get: () => undefined,
    tools: { register: (tool) => { declared.set(tool.name, tool); return () => {}; } },
    effect: (fn) => { const d = fn(); if (typeof d === 'function') disposers.push(d); },
  }, { timeZone: Z });
  const fromConfig = await declared.get('time_now').execute({}, { signal: new AbortController().signal, ...sessionFor(nowhere) });
  console.log(`  插件行声明 timeZone → source=${fromConfig.timeZoneSource} · zone=${fromConfig.timeZone}`);
  if (fromConfig.timeZoneSource !== 'config' || fromConfig.timeZone !== Z) throw new Error('配置声明的时区没生效');
}

// ── 发现协议：从 index 出发，只跟随节点给出的 key ────────────────────────────
console.log('=== 发现协议（不假设形状，只跟随服务给出的 key）===');
const seenKeys = new Set();
const trail = [];
let member = null;
const walk = async (key, depth) => {
  if (member !== null || depth > 6 || seenKeys.size >= 24 || seenKeys.has(key)) return;
  seenKeys.add(key);
  const found = foundOf((await call('ontology_info', { key })).value);
  trail.push(`${'· '.repeat(depth)}${found?.type ?? '?'}  ${key}`);
  const detail = found?.detail;
  if (typeof detail?.id === 'string' && detail.id !== '') {
    member = { key, id: detail.id, type: found?.type };
    return;
  }
  const children = [];
  if (Array.isArray(detail?.entries)) {
    for (const entry of detail.entries) if (typeof entry?.key === 'string') children.push(entry.key);
  }
  for (const link of found?.links ?? []) if (typeof link?.key === 'string') children.push(link.key);
  for (const child of children) await walk(child, depth + 1);
};
await walk('index', 0);
for (const line of trail) console.log(`  ${line}`);
if (member === null) throw new Error('从 index 出发没有走到任何声明了 id 的成员');
console.log(`  跟随 ${seenKeys.size} 个 key，落到成员: ${member.type} · id=${member.id}`);

// ── transform：同一批 Intent 重放，验证内容寻址去重与落点 ──────────────────
console.log('=== ontology_transform（真实提问 + 内容寻址）===');
const intents = [{
  op: 'Graph', root: 'x', nodes: [{ id: 'x', entity: member.id }], edges: [], select: [], count: 'x',
}];
const first = await call('ontology_transform', { intents });
console.log(first.text.split('\n').filter((line) => /◂|sql:|bindings:|✕|⚠/.test(line)).join('\n').slice(0, 600));
const planDir = `${DEV_ROOT}/.oks/plans`;
const firstFiles = first.value.plans?.planFiles ?? null;
if (firstFiles === null) throw new Error('一批通过的 Intent 没有写出计划文件');
console.log(`  计划文件: ${firstFiles.sql}`);
console.log(`  名字 = 内容 sha256 前缀: ${
  /^plan-([0-9a-f]{16})\.json$/.test(firstFiles.json.split('/').pop())
  && createHash('sha256').update(readFileSync(firstFiles.json)).digest('hex').slice(0, 16) === firstFiles.json.split('/').pop().slice(5, 21)
    ? '✓' : '✗'}`);
const beforeCount = existsSync(planDir) ? readdirSync(planDir).length : 0;
const again = await call('ontology_transform', { intents });
const afterCount = readdirSync(planDir).length;
console.log(`  重问同一批 → reused=${again.value.plans?.planFiles?.reused}`
  + ` · 路径相同=${again.value.plans?.planFiles?.json === firstFiles.json ? '✓' : '✗'}`
  + ` · 目录文件数 ${beforeCount} → ${afterCount} ${beforeCount === afterCount ? '✓' : '✗'}`);

// ── 被拒批次：诊断要能指路，且业务含义不被动过 ──────────────────────────────
console.log('=== ontology_transform（被拒批次）===');
const rejected = await call('ontology_transform', {
  intents: [{ op: 'Graph', root: 'x', nodes: [{ id: 'x', entity: 'no_such_entity_from_smoke' }], edges: [], select: [], count: 'x' }],
});
const rejectedLines = rejected.text.split('\n').filter((line) => /◂|✕|被拒绝/.test(line));
console.log(rejectedLines.map((l) => `  ${l}`).join('\n').slice(0, 500));
console.log(`  有 Error 诊断: ${/✕\s*Error/.test(rejected.text) ? '✓' : '✗'}`);

// ── 第二个工作区：相对路径解析 + 工作区声明的 planDir ───────────────────────
console.log('=== 第二个工作区（嵌套目录，artifact 与 planDir 都由它自己声明）===');
mkdirSync(`${SCRATCH}/nested`, { recursive: true });
const anchor = JSON.parse(readFileSync(`${DEV_ROOT}/oks.json`, 'utf8'));
const nested = `${SCRATCH}/nested`;
writeFileSync(`${nested}/oks.json`, `${JSON.stringify({
  version: 1,
  domain: anchor.domain,
  artifact: relative(nested, resolve(DEV_ROOT, anchor.artifact)),
  planDir: 'plans',
}, null, 2)}\n`);
const nestedCall = await call('ontology_transform', { intents }, nested);
const nestedFiles = nestedCall.value.plans?.planFiles ?? null;
console.log(`  计划文件: ${nestedFiles?.sql ?? '(未写)'}`);
console.log(`  落在工作区声明的目录下: ${nestedFiles !== null && nestedFiles.sql.startsWith(`${nested}/plans/`) ? '✓' : '✗'}`);

// ── 第三个工作区：planDir 显式关掉 ─────────────────────────────────────────
console.log('=== 第三个工作区（planDir: false）===');
mkdirSync(`${SCRATCH}/off`, { recursive: true });
const off = `${SCRATCH}/off`;
writeFileSync(`${off}/oks.json`, `${JSON.stringify({
  version: 1,
  domain: anchor.domain,
  artifact: relative(off, resolve(DEV_ROOT, anchor.artifact)),
  planDir: false,
}, null, 2)}\n`);
const offCall = await call('ontology_transform', { intents }, off);
console.log(`  计划文件: ${offCall.value.plans?.planFiles ?? '(未写)'} · 目录存在=${existsSync(`${off}/plans`)}`);
console.log(`  SQL 仍然返回: ${/sql:\s+\S/.test(offCall.text) ? '✓' : '✗'}`);

// ── 没有 oks.json 的工作区：明确报错，不回落到别的模型 ─────────────────────
console.log('=== 没有 oks.json 的工作区 ===');
const bare = `${SCRATCH}/bare`;
mkdirSync(bare, { recursive: true });
try {
  await call('ontology_info', { key: 'index' }, bare);
  console.log('  ✗ 本该报错，却成功了');
} catch (cause) {
  console.log(`  ✓ 拒绝: ${String(cause?.message ?? cause).split('\n')[0].slice(0, 120)}`);
}

// ── 没有快照段的产物：准入检查要在第一次用到该工作区时就报错 ────────────────
console.log('=== 非快照产物（只有 wasm 头，没有 telora.snapshot 段）===');
const empty = `${SCRATCH}/empty`;
mkdirSync(empty, { recursive: true });
writeFileSync(`${empty}/empty.wasm`, Uint8Array.of(0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00));
writeFileSync(`${empty}/oks.json`, `${JSON.stringify({
  version: 1, domain: anchor.domain, artifact: 'empty.wasm',
}, null, 2)}\n`);
try {
  await call('ontology_info', { key: 'index' }, empty);
  console.log('  ✗ 本该报错，却成功了');
} catch (cause) {
  console.log(`  ✓ 拒绝: ${String(cause?.message ?? cause).split('\n')[0].slice(0, 140)}`);
}

// ── 超时强杀：1 ms 上限，验证 worker 被终止而且不会把测试挂住 ───────────────
console.log('=== 超时强杀 + 复活（requestTimeoutMs=1）===');
{
  const hostile = new Map();
  apply({
    logger: { info: () => {} },
    get: () => undefined,
    tools: { register: (tool) => { hostile.set(tool.name, tool); return () => {}; } },
    effect: (fn) => { const d = fn(); if (typeof d === 'function') disposers.push(d); },
  }, { requestTimeoutMs: 1 });
  const tool = hostile.get('ontology_info');
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

for (const dispose of disposers.reverse()) dispose();
rmSync(SCRATCH, { recursive: true, force: true });
console.error('disposed cleanly');
