// 本地冒烟测试（TS 脚本，不纳入 tsc 检查）：用假的 cordis ctx 加载插件，直接调用各工具的真实实现，不安装进 profile。
// 其中两个与模型无关的时间工具（time_now / time_calc）不需要工作区，也在这里单测。
// 插件行**什么都不配**——领域、模型、数据文件全部来自工作区，正是要验证的那一点。
//
// 夹具**不含任何领域知识、也不假设地图形状**：实体 id 是运行时从服务里走出来的——读
// `index`，按节点自己给出的 key 逐级跟随，直到拿到一个声明了 id 的成员。所以模型换形状
// 不会让这份测试失效；这也正是"代码里不写形状假设"这条原则的自我验证。
//
// 被测工作区默认取**当前目录**（必须有 oks.json，否则明确报错），也可用环境变量指定：
//   cd /path/to/workspace && node /path/to/dsh-oks/smoke.ts
//   OKS_WORKSPACE=/path/to/workspace node smoke.ts
import { apply, artifactName, buildOption, CHART_WIDTH, embedArtifactMeta, NAME_MAX, readArtifactMeta,
  renderEchartsSvg, resultStamp, saveArtifact } from './lib/index.mjs';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { applyOps, encode, parseMoment } from './src/time.ts';
import { singleFlight } from './src/single-flight.ts';
import { intentKey } from './src/key.ts';
import { CHART_KINDS, supports } from './src/chart/shared.ts';
import { tableMarkdown } from './src/view/table.ts';
import { readReportProvenance } from './src/chart/report.ts';
// 保留走的是 `pinBySrc`——界面端点与冒烟都直接调它（这条能力不在工具面里）。
import { adoptArtifacts, deleteArtifact, KEEP_ALIVE_MINUTES, MATERIAL_KEEP_ALIVE_MINUTES, VISIBLE, listArtifacts,
  openState, pinBySrc, pruneArtifacts, pruneMaterials, reconcileArtifacts, recordArtifact } from './src/state.ts';
// 来源链的读取与易读视图：冒烟直接调这一层，验证编码与边界（不经工具）。
import { chainLines, readChartInput, readEnvelope, readTableView, rowsOf } from './src/results.ts';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync,
  utimesSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DEV_ROOT = process.env.OKS_WORKSPACE ?? process.cwd();
const SCRATCH = `${DEV_ROOT}/.oks-smoke`;
// 插件只在工作区的内部材料目录（.oks/data、.oks/charts）与交付目录（artifacts/）里写东西。
const workspaceListing = () => readdirSync(DEV_ROOT).filter((name) => name !== '.oks-smoke').sort().join(',');
const listingBefore = workspaceListing();
// 目录里可能已经躺着上次跑剩下的文件，所以只看"这次新增的"。
const dataListingBefore = new Set(existsSync(`${DEV_ROOT}/artifacts`) ? readdirSync(`${DEV_ROOT}/artifacts`) : []);

const registered = new Map();
const disposers = [];
const skillsRegistered = [];
const events = new Map();
const logs = [];
// 插件可能在同一事件上注册多个监听器，桩必须按事件名把**全部**监听器收下来；触发时按注册顺序
// 走 cordis 的 waterfall：每个监听器拿到 next 继续，最外层监听器的返回值就是这一步的决策。
const listen = (map, name, listener) => {
  const list = map.get(name) ?? [];
  list.push(listener);
  map.set(name, list);
  return () => {
    const rest = (map.get(name) ?? []).filter((item) => item !== listener);
    if (rest.length > 0) map.set(name, rest); else map.delete(name);
  };
};
const listenersOf = (map, name) => map.get(name) ?? [];
const waterfall = (listeners, payload, terminal) => {
  const at = (index) => async () => (index >= listeners.length ? terminal() : listeners[index](payload, at(index + 1)));
  return at(0)();
};
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
  // 插件按规范监听 agent/pre-step 以取得上下文时区；桩把监听器全部记下来，测试里手动触发。
  on: (name, listener) => listen(events, name, listener),
};

apply(ctx, {});
const toolNames = [...registered.keys()];
console.error(`registered tools: ${toolNames.join(', ')}\n`);
const EXPECTED_TOOLS = ['work_read', 'work_write', 'work_edit', 'oks_search', 'oks_references', 'oks_info', 'oks_check_intent', 'oks_query', 'create_data', 'jq_transform', 'jq_transform_into', 'oks_chart', 'oks_view', 'oks_report', 'oks_artifacts', 'time_now', 'time_calc', 'va_ask'];
console.log(`=== 工具集 ===\n  ${toolNames.join(', ')} ${
  EXPECTED_TOOLS.every((name) => toolNames.includes(name)) && toolNames.length === EXPECTED_TOOLS.length ? '✓' : '✗'}`);
for (const name of EXPECTED_TOOLS) {
  if (!toolNames.includes(name)) throw new Error(`missing tool: ${name}（实际 ${toolNames.join(', ')}）`);
}
{
  const described = EXPECTED_TOOLS.every((name) => {
    const description = registered.get(name)?.description;
    return typeof description === 'string' && description.length > 0;
  });
  console.log(`  每个工具都有非空描述: ${described ? '✓' : '✗'}`);
  if (!described) throw new Error('有工具的描述为空');
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
  const text = tool.output.render(args, value).map((block) => block.text ?? '').join('');
  // 宿主还会把 presentationMeta 投影进工具结果的 meta（不进模型上下文）；这里照做一遍，
  // 好让冒烟能断言「哪些东西只留在 meta 里」。
  const meta = typeof tool.output.presentationMeta === 'function'
    ? tool.output.presentationMeta(args, value)
    : undefined;
  return { value, text, meta };
};

// 程序夹具：工具现在**只认文件**（参数是 `by`），所以测试也把 jq 程序写进 `.work/` 再引用。
const progDir = resolve(DEV_ROOT, '.work');
let progSeq = 0;
const prog = (program) => {
  mkdirSync(progDir, { recursive: true });
  const name = `smoke_p${++progSeq}.jq`;
  writeFileSync(resolve(progDir, name), program.endsWith('\n') ? program : `${program}\n`);
  return name;
};
const foundOf = (value) => value?.trace?.[0]?.response?.ok?.Document?.Found;
// 每个实例一套独立的假 ctx：工具表、事件表（按名字收全部监听器）、日志。disposer 统一在最后收尾。
const makeHarness = (config = {}) => {
  const tools = new Map();
  const harnessEvents = new Map();
  const harnessLogs = [];
  const localDisposers = [];
  apply({
    logger: { info: (message) => harnessLogs.push(message) },
    get: () => undefined,
    tools: { register: (tool) => { tools.set(tool.name, tool); return () => tools.delete(tool.name); } },
    effect: (fn) => { const d = fn(); if (typeof d === 'function') localDisposers.push(d); },
    on: (name, listener) => listen(harnessEvents, name, listener),
  }, config);
  disposers.push(...localDisposers);
  return { tools, events: harnessEvents, logs: harnessLogs, disposers: localDisposers };
};
const buildCtx = (config) => {
  const harness = makeHarness(config);
  return { tools: harness.tools, events: harness.events, logs: harness.logs };
};
// 只有 oks_info / oks_check_intent / oks_query 需要工作区；时间工具不需要。
const NOWHERE = `${SCRATCH}/nowhere`;
mkdirSync(NOWHERE, { recursive: true });

// ── 自带技能 ────────────────────────────────────────────────────────────────
console.log('=== 自带技能（注册进 runtime 层，所有工作区可见）===');
{
  const body = readFileSync(new URL('./src/skill.md', import.meta.url), 'utf8');
  const skill = skillsRegistered[0];
  console.log(`  注册次数 ${skillsRegistered.length} ${skillsRegistered.length === 1 ? '✓' : '✗'}`);
  if (skill === undefined) throw new Error('没有注册任何技能');
  console.log(`  name=${skill.name} · source=${skill.source} · ${Buffer.byteLength(skill.content, 'utf8')} 字节`);
  console.log(`  名字合法(kebab): ${/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skill.name) ? '✓' : '✗'}`
    + ` · 描述非空: ${String(skill.description ?? '').length > 0 ? '✓' : '✗'}`);
  console.log(`  正文 = src/skill.md 原文: ${skill.content === body ? '✓' : '✗'}`);
  console.log(`  正文不含具体领域名: ${/\bic\b|icloud/i.test(skill.content) ? '✗' : '✓'}`);
}

// ── 与模型无关的时间工具（不依赖工作区、不解释领域格式）─────────────────────
console.log('=== 时间辅助工具 ===');
{
  const Z = 'Asia/Shanghai';
  const firePreStep = (cwd, messages) => {
    const list = listenersOf(events, 'agent/pre-step');
    if (list.length === 0) throw new Error('插件没有监听 agent/pre-step');
    return waterfall(list, { agent: { session: sessionFor(cwd).agent.session }, messages }, async () => ({ kind: 'enter' }));
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
    await waterfall(listenersOf(built, 'agent/pre-step'), {
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

// ── 词汇助手（va）：装配、标记与咨询语义 ────────────────────────────────────
// 插件自己建一个顶层助手 agent（preset、工作区、模型都继承调用方），装配时把整份词表与专属人设
// 放进它的**系统提示词**（不发任何消息、助手零工具），此后每次咨询只发一个说法，拿到回答后把
// 锚点之后的问答从**模型可见表面**收进一个固定文本的标记节点。这一段用假 ctx + 假 agents 服务
// 驱动真实的 va_ask：会话桩按 harness 的规则维护 surface.nodes 与 eventAt，所以收起范围、
// sourceEventSeqs、标记推进都能逐项检查。
let passed = 0;
const ok = (label, condition) => {
  if (!condition) throw new Error('✗ ' + label);
  passed += 1;
  console.log(`  ✓ ${label}`);
};

console.log('=== 检索层：并发的首次检索只派生一次索引 ===');
{
  const [left, right] = await Promise.all([
    call('oks_search', { query: 'packet' }),
    call('oks_search', { query: 'loss' }),
  ]);
  ok('并发两次首次检索只派生一次索引',
    logs.filter((line) => line.includes('discovery index')).length === 1);
  ok('两个并发调用都拿到了结果', left.text.length > 0 && right.text.length > 0);
}


const VA_MARKER_TEXT = '（上文问答已收起）';
/** 与 harness 同形状的一条消息（id 由角色 + 文本铸出，source 按角色给）。 */
const message = (role, text, extra = {}) => ({
  id: `${role}-${text}`,
  role,
  content: [{ type: 'text', text }],
  source: { kind: role === 'system' ? 'system-prompt' : role === 'tool' ? 'tool' : role === 'assistant' ? 'model' : 'user' },
  ...extra,
});
/** 从一个 user/message 的 data 或一个带 message 包封的事件 data 里取纯文本。 */
const messageText = (data) => {
  const content = Array.isArray(data?.content) ? data.content
    : Array.isArray(data?.message?.content) ? data.message.content : [];
  return content.filter((block) => block?.type === 'text').map((block) => String(block.text ?? '')).join('');
};
/** surface.nodes → 模型可见的消息行（非消息事件不参与渲染）。 */
const renderSurface = (session, nodes = session.surface.nodes) => nodes.map((seq) => {
  const event = session.eventAt(seq);
  if (event?.type === 'user/message') return `user:${messageText(event.data)}`;
  if (event?.type === 'assistant/message') return `assistant:${messageText(event.data?.message)}`;
  if (event?.type === 'system/message' || event?.type === 'developer/message') return `system:${messageText(event.data?.message)}`;
  return null;
}).filter((line) => line !== null);
/** 到最后一个标记节点为止的可见前缀（冻结前缀缓存要保的就是这一段）。 */

const collapseEvents = (session) => session.entries.filter((event) => event.surfaceOp?.op === 'replace');
const surfaceHas = (session, seq) => session.surface.nodes.includes(seq);

// va_ask 的假 agents 服务：create 装配出一个假助手，会话真的维护 surface.nodes / eventAt；followup
// 同步落 user/message → assistant/message → turn/end，于是 va_ask 的第一次轮询就看见回合结束。
// 开关把下一条 turn/end 换成 cancelled（`cancelNext`）、把某条消息之前的回合变成外来的
// （`foreignTurn`）、让第 N 条之后的发送收不到 turn/end（`stuck` / `stuckAfter`）、或在某个说法的
// 回合中间播一条有内容的系统消息（`systemAfter`）。
// 每条 followup 之前记一份表面快照（nodes），用来检查"提问前"模型看到的前缀。
const makeVaAskHarness = ({ agents = true, config = {}, stuck = false, stuckAfter = null, systemAfter = null, sessionTitle = true, createFailsOnce = false } = {}) => {
  // stuck 从第一条就卡；stuckAfter=N 表示前 N 条正常收场、第 N+1 条起卡住。
  let stuckFrom = stuck === true ? 0 : (stuckAfter ?? Number.POSITIVE_INFINITY);
  const tools = new Map();
  const eventBus = new Map();
  const logs = [];
  const localDisposers = [];
  const created = [];
  const followups = [];
  const registryCalls = [];
  const snapshots = [];
  const sessions = [];
  const createdAgents = [];
  const helperAppends = [];
  const timeline = []; // rename 与 followup 按真实发生顺序记下来，验证标题先于第一条提示词
  let cancelNext = false;
  let foreignNext = false;
  const composeCalls = [];
  const agentPresetsStub = { composeFrom: (target, source) => { composeCalls.push([target, source]); } };
  const personaSections = [];
  const promptSections = [];
  const sessionTitleCalls = [];
  const sessionTitleStub = {
    get: (session) => { sessionTitleCalls.push(['get', session]); return { title: '上个月丢包排查' }; },
    rename: (session, title) => { sessionTitleCalls.push(['rename', session, title]); timeline.push({ kind: 'rename', title }); },
  };
  const titleService = sessionTitle === false ? undefined : sessionTitleStub;
  const restrictions = [];
  const agentCtx = {
    get: (name) => (name === 'agentPresets' ? agentPresetsStub : undefined),
    systemPrompt: {
      section: (section) => {
        promptSections.push(section);
        if (section.name === 'deployment:persona-prefix') personaSections.push(section);
      },
      getSectionOrder: () => 0,
    },
    tools: { restrict: (filter) => { restrictions.push(filter); return () => {}; } },
  };
  let failNextCreate = createFailsOnce;
  const agentsService = agents ? {
    create: async (options) => {
      created.push(options);
      if (failNextCreate) {
        failNextCreate = false;
        throw new Error('create 失败（测试用）');
      }
      const entries = [];
      const sessionAppends = [];
      const session = {
        id: options.sessionId,
        header: { cwd: options.meta?.cwd },
        surface: { nodes: [] },
        entries,
        get seq() { return entries.length; },
        snapshotEvents: () => entries,
        eventAt: (seq) => entries[seq],
        append(type, data, options2) {
          const event = { type, seq: entries.length, data, ...(options2 ?? {}) };
          entries.push(event);
          sessionAppends.push({ type, data });
          const op = options2?.surfaceOp;
          // 宿主的规则（@deepseek-ai/dsh-session）：`isSurfaceEvent = event.surfaceOp !== undefined`
          // ——没有 surfaceOp 的事件只是日志事件，不进模型可见表面。这里必须照抄这条规则，
          // 否则 sandbox/mode、approval/policy 这类元数据会被误当成表面节点。
          if (op === undefined) return event;
          if (typeof op === 'object' && op.op === 'replace') {
            const { startSeq, endSeq } = op;
            for (let at = this.surface.nodes.length - 1; at >= 0; at -= 1) {
              const seq = this.surface.nodes[at];
              if (seq >= startSeq && seq <= endSeq) this.surface.nodes.splice(at, 1);
            }
            this.surface.nodes.push(event.seq);
          } else {
            this.surface.nodes.push(event.seq);
          }
          return event;
        },
      };
      // 真实宿主会把装配好的系统提示词作为一条 `system/message`（surfaceOp: append）放进表面，
      // 它和我们后面插入的标记一样，都是"不可收"的节点。假宿主照抄这一条，否则测不出
      // "提问前那次收起应该跳过"。
      session.append('system/message', {
        turn: 0,
        step: 0,
        message: { id: `sys-prompt-${entries.length}`, role: 'system', content: [{ type: 'text', text: '（测试用）系统提示词' }] },
      }, { surfaceOp: 'append' });
      sessions.push(session);
      helperAppends.push(sessionAppends);
      options.setup?.(agentCtx, { session });
      const agent = {
        status: 'idle',
        session,
        followup(message) {
          const text = messageText(message);
          followups.push(text);
          timeline.push({ kind: 'followup', text });
          snapshots.push({ text, nodes: [...session.surface.nodes] });
          if (foreignNext) {
            foreignNext = false;
            session.append('assistant/message', {
              message: { id: `foreign-${entries.length}`, role: 'assistant', content: [{ type: 'text', text: '上一个回合的回答，别当成这次的' }] },
              interrupted: false,
            }, { surfaceOp: 'append' });
            session.append('turn/end', { reason: { kind: 'completed' } });
          }
          session.append('user/message', message, { surfaceOp: 'append' });
          if (text === systemAfter) {
            // 回合中间播一条有内容的系统消息：收起必须绕过它、分成多段，而不是把它一起收掉。
            session.append('system/message', {
              turn: followups.length,
              step: 1,
              message: { id: `sys-${followups.length}`, role: 'system', content: [{ type: 'text', text: '补充指令' }] },
            }, { surfaceOp: 'append' });
          }
          if (followups.length > stuckFrom) return; // 只落消息，永不结束这一轮（模拟卡住的回合）
          if (cancelNext) {
            cancelNext = false;
            session.append('turn/end', { reason: { kind: 'cancelled' } });
            return;
          }
          session.append('assistant/message', {
            message: { id: `a-${followups.length}`, role: 'assistant', content: [{ type: 'text', text: `第 ${followups.length} 轮回答：${text}` }] },
            interrupted: false,
          }, { surfaceOp: 'append' });
          session.append('turn/end', { reason: { kind: 'completed' } });
        },
      };
      createdAgents.push(agent);
      return { agent };
    },
  } : undefined;
  const registry = {
    unarchiveSession: async (sessionId) => { registryCalls.push(['unarchiveSession', sessionId]); },
    archiveSession: async (sessionId, options) => { registryCalls.push(['archiveSession', sessionId, options]); },
  };
  apply({
    logger: { info: (message) => logs.push(message) },
    get: (name) => (name === 'agents' ? agentsService
      : name === 'workspaceRegistry' ? registry
      : name === 'sessionTitle' ? titleService
      : undefined),
    tools: { register: (tool) => { tools.set(tool.name, tool); return () => tools.delete(tool.name); } },
    effect: (fn) => { const dispose = fn(); if (typeof dispose === 'function') localDisposers.push(dispose); },
    on: (name, listener) => listen(eventBus, name, listener),
  }, config);
  disposers.push(...localDisposers);
  return {
    tools, created, followups, registryCalls, composeCalls, personaSections, promptSections, helperAppends, restrictions,
    sessions, snapshots, logs, timeline, sessionTitleCalls,
    cancelNext: () => { cancelNext = true; },
    foreignTurn: () => { foreignNext = true; },
    unstick: () => { stuckFrom = Number.POSITIVE_INFINITY; },
    setStatus: (status) => { for (const agent of createdAgents) agent.status = status; },
  };
};
const refusalOf = async (run) => {
  try { await run(); return null; } catch (cause) { return String(cause?.message ?? cause); }
};

// 调用方是普通会话：id 不以 session-va- 开头、有 cwd，options 带 provider/model。
const vaCaller = { id: 'session-main-1', header: { cwd: DEV_ROOT } };
const callerPresets = { composedPreset: () => 'oks' };
const vaCallerCtx = { get: (name) => (name === 'agentPresets' ? callerPresets : undefined) };
const vaExec = (session = vaCaller) => ({
  signal: new AbortController().signal,
  agent: { session, ctx: vaCallerCtx, options: { provider: 'test-provider', model: 'test-model' } },
});

console.log('=== va_ask（词汇助手咨询）：注册与渲染 ===');
const vaAskTool = registered.get('va_ask');
ok('注册了 va_ask', vaAskTool !== undefined);
ok('参数必填 query 且不收多余字段', Array.isArray(vaAskTool.parameters?.required)
  && vaAskTool.parameters.required.includes('query')
  && vaAskTool.parameters?.additionalProperties === false);
ok('描述非空', typeof vaAskTool.description === 'string' && vaAskTool.description.length > 0);
{
  const render = (value) => vaAskTool.output.render({}, value)[0].text;
  ok('渲染：给出回答文本', render({ answer: 'x', interrupted: false }).includes('x'));
  ok('渲染：没有文本时说清楚', /没有给出文本回答/.test(render({ answer: '', interrupted: false })));
  ok('渲染：被中断过时附一行说明', /被中断过/.test(render({ answer: 'x', interrupted: true })));
}

console.log('=== va_ask：装配（词表进系统提示词、零工具）与咨询（收起 + 标记）===');
{
  const harness = makeVaAskHarness();
  const tool = harness.tools.get('va_ask');
  const first = await tool.execute({ query: '丢包' }, vaExec());

  // 装配的形状：preset / cwd / 模型继承调用方，人设与权限被插件显式钉住。
  ok('create 只调用一次', harness.created.length === 1);
  ok('装配用 preset oks、cwd 取调用方会话头', harness.created[0]?.meta?.agentPreset === 'oks'
    && harness.created[0]?.meta?.cwd === DEV_ROOT);
  ok('助手会话 id 带 session-va- 前缀', String(harness.created[0]?.sessionId).startsWith('session-va-'));
  ok('助手在创建时 join 了调用方的 preset（composeFrom 被调用一次）',
    harness.composeCalls.length === 1 && harness.composeCalls[0][1] === vaCallerCtx);
  ok('默认给助手 off 档（关掉思考：它的活儿不需要）',
    harness.created[0]?.agentOptions?.reasoningEffort === 'off');
  ok('助手的工具面被收成空的（它一个工具都不需要）',
    harness.restrictions.length === 1
    && Array.isArray(harness.restrictions[0]?.allow)
    && harness.restrictions[0].allow.length === 0);
  ok('助手被钉成只读、不问审批',
    harness.helperAppends[0]?.some((item) => item.type === 'sandbox/mode' && item.data.mode === 'read-only')
    && harness.helperAppends[0]?.some((item) => item.type === 'approval/policy' && item.data.policy === 'never'));
  ok('助手换上自己的人设（遮蔽 deployment:persona-prefix）',
    harness.personaSections.length === 1
    && harness.personaSections[0].name === 'deployment:persona-prefix'
    && /词汇助手/.test(harness.personaSections[0].text ?? ''));
  ok('provider / model 继承调用方', harness.created[0]?.agentOptions?.provider === 'test-provider'
    && harness.created[0]?.agentOptions?.model === 'test-model');

  // 助手会话在日志级标题服务上有一个"一眼认得出是内部会话"的标题，并且带上调用方标题。
  const renames = harness.sessionTitleCalls.filter((call) => call[0] === 'rename');
  ok('助手会话被改过一次标题', renames.length === 1 && renames[0][1] === harness.sessions[0]);
  ok('标题以"词汇助手（内部）"开头并带上调用方标题',
    String(renames[0]?.[2] ?? '').startsWith('词汇助手（内部）')
    && String(renames[0]?.[2] ?? '').includes('上个月丢包排查'));
  const titleAt = harness.timeline.findIndex((step) => step.kind === 'rename');
  const firstPromptAt = harness.timeline.findIndex((step) => step.kind === 'followup');
  ok('标题设置发生在第一次提问之前', titleAt !== -1 && firstPromptAt !== -1 && titleAt < firstPromptAt);

  // 装配**不发任何消息**：词表（模板 + 整份词条）是助手**系统提示词**里的一个 section，
  // 所以既没有"喂词表"那个回合，也没有"它读完的回执"。断言只盯机制，不盯提示词措辞。
  const vocabSection = harness.promptSections.find((section) => section.name === 'oks:vocabulary');
  const feed = String(vocabSection?.text ?? '');
  const tpl = readFileSync(new URL('./src/va-prompt-tpl.md', import.meta.url), 'utf8');
  const [tplHead = '', tplTail = ''] = tpl.split('<!-- 词表 -->');
  // 模板以占位符收尾时，词表之后就没有别的正文了——两种形状都算对。
  const tailProbe = tplTail.trim().slice(0, 30);
  ok('词表是助手系统提示词里的一个 section（模板占位符处插入整份词条）',
    vocabSection !== undefined
    && feed.includes(tplHead.trim()) && (tailProbe === '' || feed.includes(tailProbe))
    && Buffer.byteLength(feed, 'utf8') > 20000);
  ok('词表 section 关掉变量插值（逐字原文）', vocabSection?.interpolate === false);
  ok('词条以文档格式一行一条（"<key>" "<name>" [aliases] "<doc>"）',
    feed.split('\n').filter((line) => /^".*" ".*" \[.*\] "/.test(line)).length > 20);
  ok('装配不发消息：followup 只有那次提问', harness.followups.length === 1 && harness.followups[0] === '丢包');
  ok('返回的 helper 是那个助手会话', first.helper === harness.created[0].sessionId);
  ok('返回的 answer 含这个说法', String(first.answer).includes('丢包'));
  // 装配完先归档一次（就绪到第一次被咨询之间不该在活跃列表里），咨询时先恢复、最后再归档。
  const registryOps = harness.registryCalls.map((call) => call[0]);
  ok('先 unarchive 再 archive，且归档时停掉活跃度',
    registryOps.includes('unarchiveSession')
    && registryOps.lastIndexOf('archiveSession') > registryOps.indexOf('unarchiveSession')
    && harness.registryCalls.filter((call) => call[0] === 'archiveSession').every((call) => call[1] === harness.created[0].sessionId
      && call[2]?.stopActivity === true));
  const rendered = tool.output.render({ query: '丢包' }, first).map((block) => block.text ?? '').join('');
  ok('工具结果渲染出回答文本', /丢包/.test(rendered));

  // 表面上没有"喂词表"的痕迹：第一次收起就是把 [提问, 回答] 收成一个标记。
  const session = harness.sessions[0];
  const query = session.entries.find((event) => event.type === 'user/message' && messageText(event.data) === '丢包');
  const answer = session.entries.find((event) => event.seq > query.seq && event.type === 'assistant/message');
  const firstCollapse = collapseEvents(session)[0];
  ok('一次咨询后收起的范围就是[提问, 回答]', firstCollapse !== undefined
    && firstCollapse.surfaceOp.startSeq === query.seq
    && firstCollapse.surfaceOp.endSeq === answer.seq
    && firstCollapse.sourceEventSeqs.includes(query.seq)
    && firstCollapse.sourceEventSeqs.includes(answer.seq));
  ok('收起插入的标记是一条固定文本的用户消息', firstCollapse?.type === 'user/message'
    && messageText(firstCollapse.data) === VA_MARKER_TEXT);
  ok('咨询后问答都不在 surface.nodes 里', !surfaceHas(session, query.seq) && !surfaceHas(session, answer.seq));
  const surfaceTexts = session.surface.nodes.map((seq) => messageText(session.eventAt(seq)?.data));
  ok('咨询后表面上只剩系统提示词 + 一个标记（系统提示词没被收掉）',
    session.surface.nodes.length === 2
    && surfaceTexts.filter((text) => text === VA_MARKER_TEXT).length === 1
    && surfaceTexts.some((text) => /（测试用）系统提示词/.test(text)));
  ok('日志一条不少（问答原样保留）', session.entries.some((event) => event.seq === query.seq)
    && session.entries.some((event) => event.seq === answer.seq));
}

console.log('=== va_ask：没有 sessionTitle 服务时装配照常 ===');
{
  const harness = makeVaAskHarness({ sessionTitle: false });
  const tool = harness.tools.get('va_ask');
  const first = await tool.execute({ query: '丢包' }, vaExec());
  ok('没有 sessionTitle 服务也能装配并回答', /丢包/.test(first?.answer ?? ''));
  ok('写了一条 no-sessionTitle 日志', harness.logs.some((line) => /no sessionTitle service/.test(line)));
}

console.log('=== va_ask：第二次咨询复用助手 + 冻结前缀 ===');
{
  const harness = makeVaAskHarness();
  const tool = harness.tools.get('va_ask');
  const first = await tool.execute({ query: '丢包' }, vaExec());
  const second = await tool.execute({ query: '端口压力' }, vaExec());
  ok('第一次回答含第一个说法', String(first.answer).includes('丢包'));
  ok('第二次咨询复用同一个助手', harness.created.length === 1);
  ok('第二次 followup 是第二个说法', harness.followups[1] === '端口压力');
  ok('第二次回答含第二个说法', String(second.answer).includes('端口压力'));
  const session = harness.sessions[0];
  const snapshotOf = (text) => harness.snapshots.filter((item) => item.text === text).at(-1);
  const textAt = (seq) => messageText(session.eventAt(seq)?.data);
  const beforeFirst = snapshotOf('丢包')?.nodes ?? [];
  const beforeSecond = snapshotOf('端口压力')?.nodes ?? [];
  ok('第一次提问前表面上只有系统提示词（词表在系统提示词里，不在表面上）',
    beforeFirst.length === 1 && /（测试用）系统提示词/.test(textAt(beforeFirst[0])));
  ok('第二次提问前表面是系统提示词 + 一个标记',
    beforeSecond.length === 2
    && beforeSecond.filter((seq) => textAt(seq) === VA_MARKER_TEXT).length === 1);
  // 收起若把锚点往后挪，每咨询一次表面上就多堆一个标记——这条就是盯它（曾经漏过）。
  const visibleMarkers = session.surface.nodes.filter((seq) => textAt(seq) === VA_MARKER_TEXT);
  ok('两次咨询之后可见表面上只有一个标记', visibleMarkers.length === 1);
  // 系统提示词那条不可收，所以"提问前"那次收起必须是空操作——一共只该有两次收起（每次咨询一次）。
  ok('两次咨询一共只发生两次收起（提问前那次跳过）', collapseEvents(session).length === 2);
}

console.log('=== va_ask：有回合在飞时不收（status 辅助判据）===');
{
  const harness = makeVaAskHarness();
  const tool = harness.tools.get('va_ask');
  await tool.execute({ query: '丢包' }, vaExec());
  const session = harness.sessions[0];
  const beforeRunning = collapseEvents(session).length;
  harness.setStatus('running');
  const running = await tool.execute({ query: '端口压力' }, vaExec());
  ok('有回合在飞时这次回答后没有新增收起事件', collapseEvents(session).length === beforeRunning);
  ok('在飞期间回答照常拿回来', String(running.answer).includes('端口压力'));
  const runningQuery = session.entries.find((event) => event.type === 'user/message' && messageText(event.data) === '端口压力');
  ok('在飞期间那条问答仍在表面上', surfaceHas(session, runningQuery.seq));

  harness.setStatus('idle');
  const beforeIdle = collapseEvents(session).length;
  await tool.execute({ query: '时延' }, vaExec());
  const caughtUp = collapseEvents(session).slice(beforeIdle);
  const delayQuery = session.entries.find((event) => event.type === 'user/message' && messageText(event.data) === '时延');
  ok('恢复 idle 后下一次提问之前把上一轮问答收了',
    caughtUp.some((event) => event.sourceEventSeqs.includes(runningQuery.seq) && event.seq < delayQuery.seq));
}

console.log('=== va_ask：回合中间的系统消息留在原地（分段收起）===');
{
  const harness = makeVaAskHarness({ systemAfter: '丢包' });
  const tool = harness.tools.get('va_ask');
  await tool.execute({ query: '丢包' }, vaExec());
  const session = harness.sessions[0];
  const systemEvent = session.entries.find((event) => event.type === 'system/message');
  const query = session.entries.find((event) => event.type === 'user/message' && messageText(event.data) === '丢包');
  const answer = session.entries.find((event) => event.seq > systemEvent.seq && event.type === 'assistant/message');
  const post = collapseEvents(session).filter((event) => event.sourceEventSeqs.includes(query.seq)
    || event.sourceEventSeqs.includes(answer.seq));
  ok('系统消息夹在中间时，这一次收起分成两段', post.length === 2
    && post[0].surfaceOp.endSeq === query.seq
    && post[1].surfaceOp.startSeq === answer.seq);
  ok('非空系统消息仍在表面上', surfaceHas(session, systemEvent.seq));
  ok('两段各自换成标记节点，系统消息没有被任何收起遮蔽',
    session.surface.nodes.includes(post[0]?.seq) && session.surface.nodes.includes(post[1]?.seq)
    && collapseEvents(session).every((event) => !event.sourceEventSeqs.includes(systemEvent.seq)));
}

console.log('=== va_ask：并发（不同说法 → 装配一次 + 排队咨询）===');
{
  const harness = makeVaAskHarness();
  const tool = harness.tools.get('va_ask');
  const [first, second] = await Promise.all([
    tool.execute({ query: '丢包' }, vaExec()),
    tool.execute({ query: '端口压力' }, vaExec()),
  ]);
  ok('并发两次只装配一个助手', harness.created.length === 1);
  ok('两次都拿到回答', /丢包/.test(first?.answer ?? '') && /端口压力/.test(second?.answer ?? ''));
  ok('两次咨询按到达顺序排队', harness.followups.join(',') === '丢包,端口压力');
  ok('每条咨询结束后都归档（外加装配完那一次）',
    harness.registryCalls.filter((call) => call[0] === 'archiveSession').length === harness.created.length + 2);
}

console.log('=== va_ask：并发（同一个说法 → single flight）===');
{
  const harness = makeVaAskHarness();
  const tool = harness.tools.get('va_ask');
  const [first, second] = await Promise.all([
    tool.execute({ query: '丢包' }, vaExec()),
    tool.execute({ query: '丢包' }, vaExec()),
  ]);
  ok('同一个说法只装配一个助手', harness.created.length === 1);
  ok('同一个说法只咨询一次', harness.followups.filter((text) => text === '丢包').length === 1);
  ok('两个调用拿到同一个回答', first?.answer === second?.answer && /丢包/.test(first?.answer ?? ''));
}

console.log('=== va_ask：有外来回合在飞时，回答仍然是我们的 ===');
{
  const harness = makeVaAskHarness();
  const tool = harness.tools.get('va_ask');
  await tool.execute({ query: '丢包' }, vaExec());
  harness.foreignTurn();
  const second = await tool.execute({ query: '端口压力' }, vaExec());
  ok('外来回合的回答不会被当成本次的', /端口压力/.test(second?.answer ?? '')
    && !/上一个回合的回答/.test(second?.answer ?? ''));
}

console.log('=== va_ask：装配失败后的状态 ===');
{
  const harness = makeVaAskHarness({ createFailsOnce: true });
  const tool = harness.tools.get('va_ask');
  const failed = await refusalOf(() => tool.execute({ query: '丢包' }, vaExec()));
  ok('装配失败明确报错', /没有装配起来/.test(failed ?? ''));
  ok('装配失败会把那条助手会话归档',
    harness.registryCalls.some((call) => call[0] === 'archiveSession' && call[1] === harness.created[0]?.sessionId));
  await tool.execute({ query: '丢包' }, vaExec());
  ok('装配失败不会把坏的助手留在表里（下次重建）', harness.created.length === 2);
}

console.log('=== va_ask：回合卡住超时 → 丢掉助手重建，且不收起 ===');
{
  const harness = makeVaAskHarness({ config: { vaAskTimeoutMs: 5 }, stuck: true });
  const tool = harness.tools.get('va_ask');
  const timedOut = await refusalOf(() => tool.execute({ query: '丢包' }, vaExec()));
  ok('卡住的回合会超时报错', /没有结束|没有落到/.test(timedOut ?? ''));
  ok('卡住的装配没有产生任何收起事件', collapseEvents(harness.sessions[0]).length === 0);
  harness.unstick();
  const second = await tool.execute({ query: '端口压力' }, vaExec());
  ok('超时后助手记录被丢掉，下次重建', harness.created.length === 2);
  ok('重建后的回答是我们的', /端口压力/.test(second?.answer ?? ''));
}

console.log('=== va_ask：还有没被回答的发送时不收（pending 主判据）===');
{
  // 所有发送都卡住（装配不发消息了，所以第一条 followup 就是提问）：先跑的两条并发咨询都超时，
  // 第二条在提问前试收时看到前一条的 pending 还是 1，于是跳过——这就是计数语义。
  const harness = makeVaAskHarness({ config: { vaAskTimeoutMs: 5 }, stuckAfter: 0 });
  const tool = harness.tools.get('va_ask');
  const [first, second] = await Promise.all([
    refusalOf(() => tool.execute({ query: '丢包' }, vaExec())),
    refusalOf(() => tool.execute({ query: '端口压力' }, vaExec())),
  ]);
  ok('两条卡住的咨询都报错', /没有结束|没有落到/.test(first ?? '') && /没有结束|没有落到/.test(second ?? ''));
  ok('pending 不为 0 时写下跳过收起的日志',
    harness.logs.some((line) => /rewind skipped · 还有 1 条没被回答的发送/.test(line)));
  const session = harness.sessions[0];
  ok('卡住期间没有发生任何收起事件', collapseEvents(session).length === 0);
  const stuckSeqs = session.entries
    .filter((event) => event.type === 'user/message' && ['丢包', '端口压力'].includes(messageText(event.data)))
    .map((event) => event.seq);
  ok('卡住的那两条问答都留在表面上', stuckSeqs.every((seq) => surfaceHas(session, seq)));
  ok('卡住的那两条问答没有被任何收起事件遮蔽',
    collapseEvents(session).every((event) => !event.sourceEventSeqs.some((seq) => stuckSeqs.includes(seq))));
  harness.unstick();
  const rebuilt = await tool.execute({ query: '时延' }, vaExec());
  ok('卡住后助手被丢掉，下次重建', harness.created.length === 2);
  ok('重建后的回答是我们的', /时延/.test(rebuilt?.answer ?? ''));
}

console.log('=== va_ask：调用方没有 cwd ===');
{
  const harness = makeVaAskHarness();
  const noCwd = await refusalOf(() => harness.tools.get('va_ask').execute({ query: '丢包' },
    { signal: new AbortController().signal, agent: { session: { id: 'session-main-2' }, ctx: vaCallerCtx, options: {} } }));
  ok('调用方没有 cwd 时早失败', /没有 cwd/.test(noCwd ?? ''));
  ok('没有 cwd 时不会去建助手', harness.created.length === 0);
}

console.log('=== va_ask：推理档位可配（默认 off）===');
{
  const asked = makeVaAskHarness({ config: { vaReasoningEffort: 'medium' } });
  await asked.tools.get('va_ask').execute({ query: '丢包' }, vaExec());
  ok('配了就透传配置里的档位', asked.created[0]?.agentOptions?.reasoningEffort === 'medium');

  const inherit = makeVaAskHarness({ config: { vaReasoningEffort: 'inherit' } });
  await inherit.tools.get('va_ask').execute({ query: '丢包' }, vaExec());
  ok('写 inherit 就不传档位（跟着部署默认走）',
    inherit.created[0]?.agentOptions !== undefined
    && !Object.hasOwn(inherit.created[0].agentOptions, 'reasoningEffort'));
}

console.log('=== va_ask：拒绝的调用 ===');
{
  const harness = makeVaAskHarness();
  const tool = harness.tools.get('va_ask');
  const empty = await refusalOf(() => tool.execute({ query: '   ' }, vaExec()));
  ok('空 query 明确报错', /需要一个说法/.test(empty ?? ''));
  const self = await refusalOf(() => tool.execute({ query: '丢包' }, vaExec({ id: 'session-va-xxx', header: { cwd: DEV_ROOT } })));
  ok('词汇助手不咨询自己', /不咨询自己/.test(self ?? ''));
  ok('被拒绝的调用没有起助手', harness.created.length === 0);
  const bare = makeVaAskHarness({ agents: false });
  const noAgents = await refusalOf(() => bare.tools.get('va_ask').execute({ query: '丢包' }, vaExec()));
  ok('没有 agent 注册表时明确报错', /agent 注册表/.test(noAgents ?? ''));
}

// ── surface replace 的真会话契约 ────────────────────────────────────────────
// 假桩只能证明调用形状；这一段拿 harness 自己的 @deepseek-ai/dsh-session 建一个真会话，验证
// 插件收起所依赖的 surface replace 真的把问答从 deriveMessages() 里收起、日志一条不少、标记
// 节点在模型那边只有一行固定文本，漏掉遮蔽节点的替换会被平台拒绝。找不到那个包就跳过，不算错。
const findSessionPackage = () => {
  if (process.env.DSH_SESSION_PACKAGE !== undefined) {
    return existsSync(join(process.env.DSH_SESSION_PACKAGE, 'lib/index.js')) ? process.env.DSH_SESSION_PACKAGE : null;
  }
  // pnpm 的 dlx store：<dlx>/<run>/<run>/node_modules/.pnpm/@deepseek-ai+dsh-session@…/node_modules/…
  const roots = [join(homedir(), '.cache/pnpm/dlx')];
  const seen = new Set();
  const visit = (dir, depth) => {
    if (depth > 3 || seen.has(dir) || !existsSync(dir)) return null;
    seen.add(dir);
    const pnpm = join(dir, 'node_modules/.pnpm');
    if (existsSync(pnpm)) {
      for (const entry of readdirSync(pnpm)) {
        if (!entry.startsWith('@deepseek-ai+dsh-session@')) continue;
        const candidate = join(pnpm, entry, 'node_modules/@deepseek-ai/dsh-session');
        if (existsSync(join(candidate, 'lib/index.js'))) return candidate;
      }
    }
    for (const child of readdirSync(dir)) {
      const found = visit(join(dir, child), depth + 1);
      if (found !== null) return found;
    }
    return null;
  };
  for (const root of roots) {
    const found = visit(root, 0);
    if (found !== null) return found;
  }
  return null;
};

const sessionPackage = findSessionPackage();
if (sessionPackage === null) {
  console.log('=== surface replace 真会话语义：跳过（没找到 @deepseek-ai/dsh-session，可用 DSH_SESSION_PACKAGE 指定）===');
} else {
  console.log(`=== surface replace 真会话语义（${sessionPackage.replace(homedir(), '~')}）===`);
  const { Session, SessionId, deriveEventMessage } = await import(`${sessionPackage}/lib/index.js`);
  const session = Session.create(SessionId('va-smoke'));
  const system = message('system', 'S');
  const user = (text) => message('user', text);
  session.append('system/message', { turn: 1, step: 1, message: system }, { surfaceOp: 'append' });
  session.append('user/message', user('读词表'), { surfaceOp: 'append' });
  const question = session.append('user/message', user('问题一'), { surfaceOp: 'append' });
  const answer = session.append('assistant/message', {
    turn: 2,
    step: 1,
    message: message('assistant', '答一'),
    stream: [],
  }, { surfaceOp: 'append' });

  const visibleBefore = session.deriveMessages().map((item) => item.content?.[0]?.text);
  ok('收起之前模型看得到问答', visibleBefore.includes('问题一') && visibleBefore.includes('答一'));
  const nodesBefore = session.surface.nodes.length;

  const replacement = session.append('user/message', user(VA_MARKER_TEXT), {
    surfaceOp: { op: 'replace', startSeq: question.seq, endSeq: answer.seq },
    sourceEventSeqs: [question.seq, answer.seq],
  });
  const nodesAfter = session.surface.nodes.length;
  ok(`表面节点数从 ${nodesBefore} 收到 ${nodesAfter}`, nodesAfter === nodesBefore - 1);
  const visibleAfter = session.deriveMessages().map((item) => item.content?.[0]?.text);
  ok('收起之后模型看不到问答', !visibleAfter.includes('问题一') && !visibleAfter.includes('答一'));
  ok('边界之前的内容还在（系统提示与读词表）', visibleAfter.includes('S') && visibleAfter.includes('读词表'));
  const logSeqs = session.snapshotEvents().map((event) => event.seq);
  ok('日志里问答原样保留', logSeqs.includes(question.seq) && logSeqs.includes(answer.seq));
  ok('替换节点记录了被遮蔽的节点', Array.isArray(replacement.sourceEventSeqs)
    && replacement.sourceEventSeqs.includes(question.seq) && replacement.sourceEventSeqs.includes(answer.seq));
  const markerMessage = deriveEventMessage(replacement);
  ok('标记节点在模型那边只有一行固定文本',
    markerMessage?.content?.length === 1 && markerMessage.content[0].text === VA_MARKER_TEXT);
  ok('会话仍然可以继续追加', session.append('user/message', user('问题二'), { surfaceOp: 'append' }).seq > replacement.seq);

  let refused = false;
  try {
    session.append('system/message', { turn: 4, step: 1, message: message('system', '') }, {
      surfaceOp: { op: 'replace', startSeq: question.seq, endSeq: question.seq },
      sourceEventSeqs: [question.seq + 1],
    });
  } catch { refused = true; }
  ok('平台自己会拒绝漏掉遮蔽节点的替换', refused);
}

console.log('=== 惰性初始化：single flight 的机制 ===');
{
  const inflight = new Map();
  let started = 0;
  let release = null;
  const gate = new Promise((done) => { release = done; });
  const start = async () => { started += 1; await gate; return 'index'; };
  const both = Promise.all([singleFlight(inflight, 'k', start), singleFlight(inflight, 'k', start)]);
  ok('并发两次只触发一次初始化', started === 1);
  release();
  ok('两个调用拿到同一个结果', (await both).every((value) => value === 'index'));
  ok('落地后从表里撤掉（下一次可以重新触发）', inflight.size === 0);

  const failing = new Map();
  let attempts = 0;
  const boom = async () => { attempts += 1; throw new Error('boom'); };
  const first = await singleFlight(failing, 'k', boom).catch((cause) => String(cause.message));
  ok('初始化抛错时把错误交给调用者', first === 'boom');
  ok('失败不留缓存', failing.size === 0);
  const second = await singleFlight(failing, 'k', boom).catch((cause) => String(cause.message));
  ok('下一次调用会重新触发', attempts === 2 && second === 'boom');
}

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
  const model = resolve(DEV_ROOT, workspace.model);
  const base = model.replace(/\.snapshot\.wasm$/, '').replace(/\.wasm$/, '');
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
    // 发布物的 counts 以组名记账，工具面以声明的 kind 名回答；这层对应关系只能在测试里手工列出。
    const groups = { Dataset: 'datasets', Dimension: 'dimensions', Measure: 'measures', Relation: 'rels', Ty: 'types', Value: 'values', BusinessLink: 'business_links' };
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

// 命名批次：名字用于回执对应、结果文件名与来源核对。
const countNamed = { count: { op: 'Graph', root: 'x', nodes: [{ id: 'x', entity: member.id }], edges: [], select: [], count: 'x', limit: 100 } };
const brokenNamed = { broken: { op: 'Graph', root: 'x', nodes: [{ id: 'x', entity: 'no_such_entity_from_smoke' }], edges: [], select: [], count: 'x', limit: 100 } };

/** 先用 oks_check_intent 取 key，再拼成 oks_query 要的 {intent, key}。 */
const withKeys = async (named, dir) => {
  const checked = await call('oks_check_intent', { intents: named }, dir);
  return Object.fromEntries(Object.entries(named).map(([name, intent]) => {
    const item = (checked.value.results ?? []).find((result) => result.name === name);
    if (item === undefined || typeof item.key !== 'string') throw new Error(`校验没有通过：${name}`);
    return [name, { intent, key: item.key }];
  }));
};

// ── 校验路径：只回诊断与 key，不回任何语句 ──────────────────────────────────
console.log('=== oks_check_intent（只校验，通过项给 key）===');
{
  // 批次名字也走同一套校验：名字是标识不是标题，所以在**校验阶段**就被挡下，不会白跑一次查询。
  {
    const bad = await call('oks_check_intent', { intents: { '告警-分布': countNamed.count } });
    // 校验工具把名字问题当"这一批的结论"回出来（不抛），所以断言看回执正文。
    if (!/0-9/.test(bad.text)) throw new Error(`批次名字里的中文与连字符应当被拒：${bad.text.slice(0, 120)}`);
    if ((bad.value.results ?? []).some((item) => item.key !== null)) throw new Error('名字不合法时不该给出 key');
    console.log(`  批次名字的字符集：${bad.text.split('\n').find((line) => /0-9/.test(line))?.trim().slice(0, 70)}`);
  }
  const accepted = await call('oks_check_intent', { intents: countNamed });
  console.log(accepted.text.split('\n').filter((line) => /◂|key=|校验结论/.test(line)).map((l) => `  ${l}`).join('\n'));
  if (!/全部可用/.test(accepted.text)) throw new Error('有效批次应当判定为可用');
  const item = (accepted.value.results ?? [])[0] ?? null;
  console.log(`  通过项带 32 位 key: ${typeof item?.key === 'string' && item.key.length === 32 ? '✓' : '✗'}`);
  if (typeof item?.key !== 'string' || item.key.length !== 32) throw new Error('通过校验的项应当给出 32 位 key');
  const leak = /select\s|sql:|bindings:/i.test(accepted.text);
  console.log(`  渲染里没有语句: ${leak ? '✗' : '✓'}`);
  if (leak) throw new Error('校验路径不应当出现语句');
  const structured = JSON.stringify(accepted.value);
  console.log(`  结构化值里也没有 queries: ${/"queries"/.test(structured) ? '✗' : '✓'}`);
  if (/"queries"/.test(structured)) throw new Error('校验路径的结构化值里仍然带着 queries');

  const partial = await call('oks_check_intent', { intents: { ...countNamed, ...brokenNamed } });
  console.log(partial.text.split('\n').filter((line) => /◂|✕|再校验|校验结论/.test(line)).map((l) => `  ${l}`).join('\n').slice(0, 700));
  if (!/✕\s*Error/.test(partial.text)) throw new Error('坏 Intent 应当报 Error 诊断');
  if (!/再校验一次.*通过/.test(partial.text)) throw new Error('未报 Error 的子集应当被单独确认');
  if (!/被拒绝/.test(partial.text)) throw new Error('被拒的 Intent 应当单独列出');
  const rows = partial.value.results ?? [];
  const good = rows.find((row) => row.name === 'count');
  const bad = rows.find((row) => row.name === 'broken');
  console.log(`  好项给 key、坏项不给: ${typeof good?.key === 'string' && bad?.key === null ? '✓' : '✗'}`);
  if (typeof good?.key !== 'string' || bad?.key !== null) throw new Error('只有通过校验的项才应当拿到 key');
}

// ── 查询路径：真的执行、结果落盘，模型可见面只留引用 ────────────────────────
console.log('=== oks_query（只读执行 + 结果落盘）===');
{
  const answer = await call('oks_query', {
    intents: await withKeys(countNamed),
    motivation: '冒烟：核对动机进入来源链',
  });
  const first = answer.value.results?.[0] ?? null;
  console.log(answer.text.split('\n').filter((line) => /◂|── |status:|dataSrc:|columns:|sql:/.test(line)).map((l) => `  ${l}`).join('\n').slice(0, 800));
  if (first === null) throw new Error('有效查询没有产生结果');
  if (first.status !== 'saved') throw new Error(`查询没有保存成功：${first.status} ${first.error ?? ''}`);
  console.log(`  行数 ${first.rowCount} · 渲染 ${answer.text.length} 字符（pruner 阈值 8192）`);
  if (first.rowCount < 1) throw new Error('查询应当至少返回一行');
  if (typeof first.dataSrc !== 'string' || !first.dataSrc.startsWith('.oks/data/')) throw new Error('成功项应当返回 .oks/data/ 下的 dataSrc');
  if (/sql:/.test(answer.text) || !/status:\s+saved/.test(answer.text)) throw new Error('回执应当是结构（保存状态），语句不进模型可见文本');
  const metaSql = answer.meta?.results?.[0]?.sql ?? null;
  console.log(`  语句只留在呈现记录里（meta.sql ${typeof metaSql === 'string' ? `${metaSql.length} 字符` : '缺失'}）: ${typeof metaSql === 'string' && metaSql.length > 0 ? '✓' : '✗'}`);
  if (typeof metaSql !== 'string' || metaSql.length === 0) throw new Error('语句应当留在 presentationMeta 里');
  if (answer.text.length >= 8192) throw new Error('模型可见文本超过了 pruner 阈值');
  if (/^\|.*\|$/m.test(answer.text)) throw new Error('数据行不该出现在查询回执里（它们只在结果文件里）');

  const saved = JSON.parse(readFileSync(resolve(DEV_ROOT, first.dataSrc), 'utf8'));
  console.log(`  结果文件 ${first.dataSrc}：${saved.data.rows.length} 行 · 列 ${saved.data.columns.map((column) => column.name).join(',')}`);
  if (saved.data.rows.length !== first.rowCount) throw new Error('结果文件的行数与回执不一致');
  if (!Array.isArray(saved.data.rows) || saved.data.rows.length !== first.rowCount) throw new Error('结果文件里没有完整数据行');
  if (saved.data.columns.some((column) => !Array.isArray(column.types) || column.types.length === 0)) throw new Error('结果文件的列信息缺少类型');
  // 文件的三段：自述、来源链（节点表）、数据本身。形状靠结构认，没有版本号。
  ok('文件是 { meta, origin, data } 三段，形状里没有版本号',
    saved.meta?.kind === 'query' && typeof saved.meta?.name === 'string'
    && /^\d{8}T\d{6}Z$/.test(String(saved.meta?.at))
    && saved.origin?.version === undefined
    && JSON.stringify(saved.data.columns.map((column) => column.name))
      === JSON.stringify(first.columns.map((column) => column.name)));
  // 来源链：整份链以节点表写在文件里，root 指向产生这份 data 的那次查询。
  const chain = saved.origin;
  const nodes = chain?.nodes ?? {};
  const root = nodes?.[chain?.root] ?? null;
  console.log(`  来源链 · ${Object.keys(nodes).length} 个节点 · root=[${chain?.root}] ${root?.kind ?? '(缺失)'}`);
  ok('来源链的根节点是 12 位十六进制',
    /^[0-9a-f]{12}$/.test(String(chain?.root)));
  ok('根节点是这次查询（带实际提交的 Intent）',
    root?.kind === 'query' && JSON.stringify(root.intent) === JSON.stringify(countNamed.count));
  ok('根节点带这次查询的动机', root?.motivation === '冒烟：核对动机进入来源链');
  ok('根节点带执行时实际观察到的数据来源',
    typeof root?.source?.dataFile === 'string' && root.source.dataFile.length > 0);
  console.log(`  source: ${JSON.stringify(root?.source).slice(0, 120)}`);

  // 易读视图：按依赖顺序摊开，并且不把节点表原样倒给模型。
  const view = chainLines(chain);
  console.log(view.map((line) => `    ${line}`).join('\n'));
  ok('易读视图按依赖顺序列出根节点', view.length >= 2 && view[0].includes(String(chain.root)));
  ok('易读视图带动机', view.some((line) => line.includes('动机：')));
  ok('没有输入的查询不出现输入行', !view.some((line) => line.includes('输入：')));
  // 手写的夹具（不进回执、不进清单），覆盖读取边界：旧平面封装、悬空引用、非行数组的 data。
  const fixture = (name: string, content: unknown): string => {
    writeFileSync(resolve(DEV_ROOT, '.oks', 'data', name), `${JSON.stringify(content, null, 2)}\n`);
    return name;
  };
  const stale = [];
  try {
    // 阶段 1b 写下的平面 origin：读取时归一成单节点链，旧文件不因为编码变化就读不了。
    const flatName = fixture(`${resultStamp()}-legacy_flat.query.json`, {
      origin: { kind: 'query', intent: { from: 'stage 1b' }, motivation: '旧的平面封装' },
      data: [{ n: 1 }],
      columns: [{ name: 'n', types: ['number'], nullable: false }],
    });
    stale.push(flatName);
    const legacy = readEnvelope(DEV_ROOT, `.oks/data/${flatName}`);
    const legacyRoot = legacy.origin.nodes[legacy.origin.root];
    ok('阶段 1b 的平面 origin 读取时归一成单节点链',
      Object.keys(legacy.origin.nodes).length === 1 && legacyRoot?.kind === 'query'
      && legacyRoot.motivation === '旧的平面封装' && legacy.data.length === 1);
    // 老文件没有自述：按文件名现造一份，读的人不必面对"没有自述"。
    ok('没有自述的老文件按文件名现造自述',
      legacy.meta.kind === 'query' && legacy.meta.name === 'legacy_flat');

    // 引用必须在文件内闭合：被引用的上游节点不在这个文件里，读取就要报出来。
    const danglingName = fixture(`${resultStamp()}-dangling.query.json`, {
      origin: { version: 1, root: 'aaaaaaaaaaaa', nodes: {
        aaaaaaaaaaaa: { kind: 'transform', snip: '.events', inputs: { events: 'bbbbbbbbbbbb' } },
      } },
      data: [],
    });
    stale.push(danglingName);
    let dangling = '';
    try {
      readEnvelope(DEV_ROOT, `.oks/data/${danglingName}`);
    } catch (cause) {
      dangling = String(cause?.message ?? cause);
    }
    console.log(`  悬空引用被拒: ${/不在这个文件里/.test(dangling) ? '✓' : `✗ ${dangling}`}`);
    ok('被引用的上游节点不在文件里时读取报错', /不在这个文件里/.test(dangling));

    // 标量、对象、嵌套是加工数据的常态：readEnvelope 照读，消费边界 rowsOf 明确拒绝。
    const scalarName = fixture(`${resultStamp()}-scalar.query.json`, {
      origin: { version: 1, root: 'cccccccccccc', nodes: { cccccccccccc: { kind: 'transform', snip: '1' } } },
      data: 42,
    });
    stale.push(scalarName);
    ok('标量结果能从封装里读回', readEnvelope(DEV_ROOT, `.oks/data/${scalarName}`).data === 42);
    let notRows = '';
    try {
      rowsOf(readEnvelope(DEV_ROOT, `.oks/data/${scalarName}`).data, scalarName);
    } catch (cause) {
      notRows = String(cause?.message ?? cause);
    }
    console.log(`  非行数组被图表读取拒绝: ${/不是行对象数组/.test(notRows) ? '✓' : `✗ ${notRows}`}`);
    ok('图表那一侧的读取拒绝非行对象数组', /不是行对象数组/.test(notRows));
    // 消费边界认两种行形状：查询结果的 { rows, columns } 与"data 直接就是数组"（加工/给定数据）。
    let boxed = '';
    try {
      rowsOf({ rows: 1 }, 'x');
    } catch (cause) {
      boxed = String(cause?.message ?? cause);
    }
    ok('消费边界两种行形状都认（{rows, …} 与直接是数组），别的形状明确被拒',
      rowsOf({ rows: [{ a: 1 }] }, 'x').length === 1 && rowsOf([{ a: 1 }], 'x').length === 1
      && /不是行对象数组/.test(boxed));
  } finally {
    for (const name of stale) rmSync(resolve(DEV_ROOT, '.oks', 'data', name), { force: true });
  }

  // key 对得上（自算），但这个 Intent 本身被服务拒：这才是 rejected。
  const rejected = await call('oks_query', { intents: { broken: { intent: brokenNamed.broken, key: intentKey(brokenNamed.broken) } } });
  const rejectedFirst = rejected.value.results?.[0] ?? null;
  console.log(rejected.text.split('\n').filter((line) => /◂|✕|被拒绝|status:/.test(line)).map((l) => `  ${l}`).join('\n').slice(0, 600));
  console.log(`  被拒项 status=${rejectedFirst?.status} · dataSrc=${rejectedFirst?.dataSrc}`);
  if (rejectedFirst?.status !== 'rejected' || rejectedFirst?.dataSrc !== null) throw new Error('被拒批次应当给出 rejected 且没有 dataSrc');

  // key 与 Intent 不符：不执行，直接拒。
  const mismatched = await call('oks_query', { intents: { count: { intent: countNamed.count, key: 'f'.repeat(32) } } });
  const mismatchFirst = mismatched.value.results?.[0] ?? null;
  console.log(`  改了 Intent 复用别的 key → status=${mismatchFirst?.status}`);
  if (mismatchFirst?.status !== 'key_mismatch') throw new Error('key 与 Intent 不符时应当拒掉');
  if (mismatchFirst?.sql !== null) throw new Error('key 不符的项不应被执行');
}

// ── 加工：探索（只看）与物化（写进 .oks/data/）共用一套具名输入与求值语义 ──────
console.log('=== jq_transform / jq_transform_into（具名输入 + 自动来源链）===');
{
  const answer = await call('oks_query', { intents: await withKeys(countNamed) });
  const first = answer.value.results?.[0] ?? null;
  const column = first.columns[0]?.name;
  const numeric = first.columns.find((entry) => entry.types.includes('number'))?.name ?? column;
  const dataSrc = first.dataSrc;
  const rowTotal = first.rowCount;
  const failureOf = async (args) => {
    try {
      await call('jq_transform', args);
      return '';
    } catch (cause) {
      return String(cause?.message ?? cause);
    }
  };

  // 具名输入：程序读到的是一个对象，键就是 inputs 里的名字
  const one = await call('jq_transform', { inputs: { q: dataSrc }, byFile: prog(`.q.rows[0].${column}`) });
  console.log(`  .q.rows[0].${column} → ${JSON.stringify(one.value.data)} · outputs=${one.value.outputs}`);
  ok('探索：恰好一个输出时 data 就是那个值',
    one.value.outputs === 1 && !Array.isArray(one.value.data) && one.value.inputs?.[0]?.name === 'q');
  // 查询结果的 data 是 { rows, columns }：行在 .q.rows，列信息也在同一份数据里。
  ok('探索：回执报告每份输入的形状（查询结果是 { rows, columns }）',
    one.value.inputs?.[0]?.shape.startsWith('对象 · 字段 rows, columns') && one.value.inputs?.[0]?.src === dataSrc);

  // 一个数组值 vs 多个输出：data 形状一样，靠 outputs 分开（这就是约定要消掉的那个歧义）
  const arrayValue = await call('jq_transform', { byFile: prog('[range(3)]') });
  const stream = await call('jq_transform', { byFile: prog('range(3)') });
  console.log(`  [range(3)] → outputs=${arrayValue.value.outputs} · range(3) → outputs=${stream.value.outputs}`);
  ok('探索：一个数组值与多个输出靠 outputs 分开',
    arrayValue.value.outputs === 1 && JSON.stringify(arrayValue.value.data) === '[0,1,2]'
    && stream.value.outputs === 3 && JSON.stringify(stream.value.data) === '[0,1,2]');

  // 零输出：data 是空数组，回执明说没有产出值
  const none = await call('jq_transform', { inputs: { q: dataSrc }, byFile: prog('empty') });
  console.log(`  empty → outputs=${none.value.outputs} · data=${JSON.stringify(none.value.data)}`);
  ok('探索：零输出是 outputs=0 且 data 为空数组',
    none.value.outputs === 0 && Array.isArray(none.value.data) && none.value.data.length === 0);

  // 无输入的程序看到 {}：常量也这么算
  const constant = await call('jq_transform', { byFile: prog('{threshold: 100, unit: "ms"}') });
  console.log(`  无输入常量 → ${JSON.stringify(constant.value.data)}`);
  ok('探索：无输入的程序看到 {}（常量）',
    constant.value.outputs === 1 && constant.value.data?.threshold === 100 && constant.value.inputs.length === 0);

  // 代码区的三个工具：写、读、改都只在 .work/ 内（宿主那三个通用工具不在这个 profile 里，
  // 而它们的沙箱根是整个工作区——"只能 .work/" 这条约束只能由插件自己在执行层给出）。
  const workWritten = await call('work_write', {
    file_path: 'smoke_prog.jq',
    content: '.q.rows | length\n',
  });
  const workListed = await call('work_read', { file_path: '.' });
  const workReadBack = await call('work_read', { file_path: '.work/smoke_prog.jq' });
  console.log(workReadBack.text.split('\n').slice(0, 3).map((line) => `  ${line}`).join('\n'));
  ok('work_write / work_read：写进 .work/、能按行读回、用 "." 能列出目录',
    workWritten.value.ok === true && workWritten.value.file === '.work/smoke_prog.jq'
    && workWritten.value.created === true
    && (workListed.value.entries ?? []).some((e) => e.name === '.work/smoke_prog.jq')
    && (workReadBack.value.lines ?? []).join('\n') === '.q.rows | length'
    && workReadBack.value.total === 1);
  const workEdited = await call('work_edit', {
    file_path: 'smoke_prog.jq', old_string: '| length', new_string: '| length # 改过',
  });
  const workReadAgain = await call('work_read', { file_path: 'smoke_prog.jq' });
  ok('work_edit：字面替换后就地生效（改一句不必重发整份文件）',
    workEdited.value.replaced === 1 && (workReadAgain.value.lines ?? []).join('') === '.q.rows | length # 改过');
  const failureOfTool = async (name, args) => {
    try { await call(name, args); return ''; } catch (cause) { return String(cause?.message ?? cause); }
  };
  const scoped = await Promise.all([
    failureOfTool('work_read', { file_path: '../../etc/passwd' }),
    failureOfTool('work_write', { file_path: '/tmp/x.jq', content: 'x' }),
    failureOfTool('work_write', { file_path: '.work/../evil.jq', content: 'x' }),
    failureOfTool('work_edit', { file_path: 'nope.jq', old_string: 'a', new_string: 'b' }),
    failureOfTool('work_write', { file_path: 'big.jq', content: 'x'.repeat(300 * 1024) }),
  ]);
  console.log(`  代码区越界 → ${scoped[0].slice(0, 60)} / ${scoped[1].slice(0, 50)}`);
  ok('代码区只在 .work/ 内：越界、绝对路径、`..`、读不到、超限各自明确报错',
    /只能读写工作区 \.work\//.test(scoped[0]) && /不能是绝对路径/.test(scoped[1])
    && /不能越出这一层|只能读写工作区/.test(scoped[2]) && /读不到/.test(scoped[3])
    && /超过 \.work\/ 单份文件的上限/.test(scoped[4]));

  // jq 程序也可以写进 .work/ 下的 .jq 文件、由 byFile 交进来：jq 语法于是不和调用的 JSON 相邻
  // （实测的整轮失败正是模型把 jq 的 {a: b} 直接写成了 JSON 值）。
  const workDir = resolve(DEV_ROOT, '.work');
  mkdirSync(workDir, { recursive: true });
  const progFile = 'snip_probe.jq';
  writeFileSync(resolve(workDir, progFile), '# 冒烟：程序正文来自 .work/\n.q.rows\n| length\n');
  rmSync(resolve(workDir, 'smoke_prog.jq'), { force: true });
  const viaFile = await call('jq_transform', { inputs: { q: dataSrc }, byFile: progFile });
  console.log(`  byFile: ${progFile} → ${JSON.stringify(viaFile.value.data)} · snipFile=${viaFile.value.snipFile}`);
  ok('by 指向 .work/ 下的程序文件，回执写明程序来自哪份文件',
    viaFile.value.ok !== false && viaFile.value.data === rowTotal && viaFile.value.snipFile === `.work/${progFile}`);
  const intoViaFile = await call('jq_transform_into', {
    name: 'from_code_file',
    motivation: '冒烟：程序来自 .work/ 里的文件',
    inputs: { q: dataSrc },
    byFile: progFile,
  });
  const intoViaFileBody = JSON.parse(readFileSync(resolve(DEV_ROOT, intoViaFile.value.dataSrc), 'utf8'));
  const intoViaFileRoot = intoViaFileBody.origin.nodes[intoViaFileBody.origin.root];
  ok('来源链记的是程序正文（另附 snipFile）：.work/ 被清掉也不影响来路',
    intoViaFileRoot?.snip?.startsWith('# 冒烟') === true
    && intoViaFileRoot?.snipFile === `.work/${progFile}` && intoViaFileBody.data === rowTotal);
  rmSync(resolve(DEV_ROOT, intoViaFile.value.dataSrc), { force: true });

  // 引用的三种不合规：不存在（要列出 .work/ 里现有的）、越界、超过单份代码上限
  writeFileSync(resolve(workDir, 'huge.jq'), `# ${'x'.repeat(70 * 1024)}\n`);
  const missingCode = await failureOf({ inputs: { q: dataSrc }, byFile: 'nope.jq' });
  const outsideCode = await failureOf({ inputs: { q: dataSrc }, byFile: '../evil.jq' });
  const hugeCode = await failureOf({ inputs: { q: dataSrc }, byFile: 'huge.jq' });
  const notCode = await failureOf({ inputs: { q: dataSrc }, byFile: 'notes.txt' });
  console.log(`  代码引用不存在 → ${missingCode.slice(0, 110)}`);
  ok('代码引用不存在时报出 .work/ 里现有哪些文件',
    /读不到/.test(missingCode) && missingCode.includes(`.work/${progFile}`));
  ok('程序文件不能越过 .work/、必须是 .jq、超过单份代码上限时明确报错',
    /只能读写工作区 \.work\//.test(outsideCode) && /超过单份代码的上限/.test(hugeCode)
    && /要以 \.jq 结尾/.test(notCode));
  rmSync(resolve(workDir, 'huge.jq'), { force: true });
  rmSync(resolve(workDir, progFile), { force: true });
  // 不写程序时结果就是「名字 → 那一段」的对象；pick 再从它里面取回一段。
  const shortForm = await call('jq_transform', { inputs: { q: dataSrc } });
  const explicit = await call('jq_transform', { inputs: { q: { src: dataSrc, root: '.data' } } });
  const picked = await call('jq_transform', { inputs: { q: dataSrc }, pick: '.q' });
  const rowsSlice = await call('jq_transform', { inputs: { q: { src: dataSrc, root: '.data.rows' } } });
  console.log(`  短写法 → ${JSON.stringify(shortForm.value.data).slice(0, 60)}`
    + ` · pick → ${JSON.stringify(picked.value.data).slice(0, 60)}`);
  ok('不写程序：结果是「名字 → 那一段」的对象，短写法与 {src, root: ".data"} 等价',
    shortForm.value.ok !== false && shortForm.value.generated === true
    && Array.isArray(shortForm.value.data?.q?.rows) && shortForm.value.data.q.rows.length === rowTotal
    && JSON.stringify(shortForm.value.data) === JSON.stringify(explicit.value.data));
  ok('pick 从结果里取回一段：单份输入于是能按裸名字读出来，回执写明取的是哪一段',
    picked.value.ok !== false && picked.value.pick === '.q'
    && Array.isArray(picked.value.data?.rows) && picked.value.data.rows.length === rowTotal);
  ok('每个输入条目各带自己的 root：只把那一段交出去',
    Array.isArray(rowsSlice.value.data?.q) && rowsSlice.value.data.q.length === rowTotal
    && rowsSlice.value.inputs?.[0]?.root === '.data.rows');
  const zeroInput = await call('jq_transform', {});
  ok('零输入：结果是 {}（常量走程序文件）',
    zeroInput.value.ok !== false && JSON.stringify(zeroInput.value.data) === '{}'
    && zeroInput.value.inputs.length === 0);
  const bothWays = await failureOf({ inputs: { q: dataSrc }, pick: '.q', byFile: prog('.') });
  const strayBy = await failureOf({ inputs: { q: dataSrc }, by: 'peek.jq' });
  const strayRoot = await failureOf({ inputs: { q: dataSrc }, root: '.origin' });
  console.log(`  取法互斥 → ${bothWays.slice(0, 90)}`);
  ok('pick 与 byFile 二选一；退场的 by 与顶层 root 各自指到现在的写法',
    /二选一/.test(bothWays) && /byFile/.test(strayBy) && /pick/.test(strayRoot));

  // 嵌套结构：加工结果是通用 JSON，投影只产出选中的字段
  const projected = await call('jq_transform', {
    inputs: { q: dataSrc },
    byFile: prog(`{n: (.q.rows | length), first: (.q.rows[0] | {${column}, ${numeric}})}`),
  });
  const keys = Object.keys(projected.value.data?.first ?? {});
  const expectedKeys = [...new Set([column, numeric])];
  console.log(`  嵌套 → ${JSON.stringify(projected.value.data)}`);
  ok('探索：嵌套对象与投影都按 snip 的形状产出',
    projected.value.outputs === 1 && projected.value.data?.n === rowTotal
    && expectedKeys.every((name) => keys.includes(name)) && keys.length === expectedKeys.length);

  // 形状与采样都在回执里：先看清是什么形状，再决定怎么加工
  console.log(none.text.split('\n').filter((line) => /形状|输入 q/.test(line)).map((line) => `  ${line}`).join('\n'));
  ok('探索：回执里有输入形状、结果形状与"没有产出值"',
    /输入 q ← /.test(none.text) && /形状：/.test(none.text) && /没有产出值/.test(none.text));

  // 明确回执：语法错误带求值器自己的话；读不到的输入报出是哪一个；越界引用被拒
  const syntax = await failureOf({ inputs: { q: dataSrc }, byFile: prog('.q.rows[] |') });
  console.log(`  表达式错误 → ${syntax.split('\n')[0].slice(0, 96)}`);
  ok('探索：表达式错误带回求值器自己的报错', /jaq 表达式执行失败/.test(syntax));
  // 语法错要**自足**：报错里指出是哪份文件的哪一行（`-f` 让 jaq 自己读文件，于是不是 `<inline>`），
  // 再附上这次各输入交出的形状——照着改就行，不必先写一个探针程序去问。
  console.log(`  语法错的定位 → ${(syntax.split('\n')[2] ?? '').trim().slice(0, 60)}`);
  ok('语法错指出是哪份文件的哪一行（程序按文件交给求值器）',
    /\.work\/smoke_p\d+\.jq/.test(syntax) && /\d+ │/.test(syntax));
  ok('失败回执附上这次各输入交出的形状', /输入 q ← /.test(syntax) && /对象 · 字段 rows, columns/.test(syntax));
  const shapeError = await failureOf({ inputs: { q: dataSrc }, byFile: prog('.q.rows | .foo') });
  console.log(`  形状错 → ${shapeError.split('\n')[0].slice(0, 90)}`);
  ok('取错键时：求值器原话 + 输入形状一起给（少写一个探针程序）',
    /cannot index/.test(shapeError) && /输入 q ← /.test(shapeError) && /\.data/.test(shapeError));
  const missing = await failureOf({ inputs: { rows: '.oks/data/20260101T000000Z-nope.query.json' }, byFile: prog('.') });
  console.log(`  读不到的输入 → ${missing.slice(0, 120)}`);
  ok('探索：读不到的输入报出是哪一个', /读不到输入 rows/.test(missing));
  const outside = await failureOf({ inputs: { rows: '../oks.json' }, byFile: prog('.') });
  ok('探索：越界的 dataSrc 被拒', /只能指向/.test(outside));
  // 不填 by 的语义见后面的「纯读取」断言：缺程序不再是错误。


  // agent 自填的数据经 create_data 变成一份封装：它与查询结果平级，于是也能被加工与图引用
  const created = await call('create_data', {
    name: 'thresholds',
    motivation: '业务口头给的阈值（冒烟夹具）',
    data: { warn: 1, crit: 2 },
  });
  console.log(`  create_data → ${created.value.dataSrc} · ${created.value.shape} · ${created.value.bytes} B`);
  const createdFile = JSON.parse(readFileSync(resolve(DEV_ROOT, created.value.dataSrc), 'utf8'));
  const createdRoot = createdFile.origin.nodes[createdFile.origin.root];
  ok('create_data：落成 .oks/data/ 下的封装，节点记着"数据是给定的"与动机',
    created.value.dataSrc.startsWith('.oks/data/') && created.value.dataSrc.endsWith('.data.json')
    && createdRoot?.kind === 'input' && createdRoot.motivation === '业务口头给的阈值（冒烟夹具）'
    && createdFile.meta.kind === 'data' && createdFile.data.warn === 1
    && createdRoot.outputs === undefined);
  const noMotivation = await (async () => {
    try {
      await call('create_data', { name: 'nameless_reason', data: [1] });
      return '';
    } catch (cause) {
      return String(cause?.message ?? cause);
    }
  })();
  ok('create_data：缺动机明确报错（给定数据没有别的解释）', /需要 motivation/.test(noMotivation));
  const badDataName = await (async () => {
    try {
      await call('create_data', { name: '阈值', motivation: '冒烟', data: [1] });
      return '';
    } catch (cause) {
      return String(cause?.message ?? cause);
    }
  })();
  ok('create_data：名字不合法时明确报错', /名字只能是/.test(badDataName));

  // 给定数据当具名输入：加工链因此有两个起点（查询与给定），各自记在一处
  const mixed = await call('jq_transform_into', {
    name: 'with_thresholds',
    motivation: '冒烟：查询结果与给定数据一起用',
    inputs: { q: dataSrc, thresholds: created.value.dataSrc },
    byFile: prog('{n: (.q.rows | length), warn: .thresholds.warn}'),
  });
  const mixedFile = JSON.parse(readFileSync(resolve(DEV_ROOT, mixed.value.dataSrc), 'utf8'));
  const mixedRoot = mixedFile.origin.nodes[mixedFile.origin.root];
  const queryRootId = JSON.parse(readFileSync(resolve(DEV_ROOT, dataSrc), 'utf8')).origin.root;
  console.log(`  给定数据参与加工 · ${Object.keys(mixedFile.origin.nodes).length} 个节点 · 输入 ${JSON.stringify(mixedRoot?.inputs)}`);
  ok('create_data：给定数据能作为具名输入参与加工（链上两个起点）',
    mixedRoot?.inputs?.thresholds === createdFile.origin.root
    && mixedRoot?.inputs?.q === queryRootId
    && Object.keys(mixedFile.origin.nodes).length === 3);

  // 身份属于**一次记录**，不只属于操作定义：同动机、同名字、不同数据必须是两个节点。
  // （只按定义算身份时，这两个 create_data 会塌成一个节点，链上就再也分不出两份数据。）
  const twinA = await call('create_data', {
    name: 'twin',
    motivation: '同一句动机，两份不同的数据',
    data: { v: 1 },
  });
  const twinB = await call('create_data', {
    name: 'twin',
    motivation: '同一句动机，两份不同的数据',
    data: { v: 2 },
  });
  const rootOf = (src) => JSON.parse(readFileSync(resolve(DEV_ROOT, src), 'utf8')).origin.root;
  console.log(`  同定义两份数据 → root ${rootOf(twinA.value.dataSrc)} / ${rootOf(twinB.value.dataSrc)}`);
  ok('同定义、不同数据是两条记录（节点 ID 不同）',
    rootOf(twinA.value.dataSrc) !== rootOf(twinB.value.dataSrc));
  const twinUse = await call('jq_transform_into', {
    name: 'twin_use',
    motivation: '冒烟：把两份同定义的数据一起用上',
    inputs: { a: twinA.value.dataSrc, b: twinB.value.dataSrc },
    byFile: prog('{sum: (.a.v + .b.v)}'),
  });
  const twinFile = JSON.parse(readFileSync(resolve(DEV_ROOT, twinUse.value.dataSrc), 'utf8'));
  const twinRoot = twinFile.origin.nodes[twinFile.origin.root];
  console.log(`  两份一起用 · ${Object.keys(twinFile.origin.nodes).length} 个节点`);
  ok('两份同定义的给定数据在链上各占一个节点（合并不会把它们混成一个）',
    Object.keys(twinFile.origin.nodes).length === 3
    && twinRoot?.inputs?.a !== twinRoot?.inputs?.b
    && twinFile.data.sum === 3);

  // 常量也可以由 snip 生成（省略 inputs）：这时来源链里留下的是代码与动机，而不是"给定"
  const derived = await call('jq_transform_into', {
    name: 'thresholds_by_snip',
    motivation: '冒烟：用 snip 算出来的常量',
    byFile: prog('{warn: 70, crit: 90}'),
  });
  const derivedFile = JSON.parse(readFileSync(resolve(DEV_ROOT, derived.value.dataSrc), 'utf8'));
  const derivedRoot = derivedFile.origin.nodes[derivedFile.origin.root];
  ok('物化：无输入的 snip 生成常量封装（记下代码与动机，没有上游）',
    derivedRoot?.kind === 'transform' && derivedRoot.snip === '{warn: 70, crit: 90}'
    && derivedRoot.inputs === undefined && Object.keys(derivedFile.origin.nodes).length === 1
    && derivedFile.data.crit === 90);

  // 截断：按行边界截断，绝不留下半个 JSON 值；这一条在物化那边必须变成失败
  // 数据接口不截断：求值到上限 → 报错（合法 JSON）；返回体超上限 → 报错（合法 JSON）。
  const bulk = await call('jq_transform', { inputs: { rows: dataSrc }, byFile: prog('range(1; 200000)') });
  console.log(`  求值到上限 → ${bulk.text.trim().slice(0, 150)}`);
  ok('探索：求值到上限时报错而不是返回半份数据（错误本身是合法 JSON）',
    bulk.value.ok === false && bulk.value.error?.code === 'evaluation_truncated'
    && bulk.value.error?.limitBytes === 16 * 1024
    && (() => { try { JSON.parse(bulk.text.trim()); return true; } catch { return false; } })());
  const big = await call('jq_transform', { byFile: prog('range(1; 8000)') });
  console.log(`  返回体超上限 → ${big.text.trim().slice(0, 150)}`);
  ok('探索：返回体超上限时报错（带上限与实测字节数，错误本身是合法 JSON）',
    big.value.ok === false && big.value.error?.code === 'payload_too_large'
    && big.value.error?.limitBytes === 16 * 1024
    && BigInt(big.value.error?.actualBytes ?? 0) > 16n * 1024n
    && (() => { try { JSON.parse(big.text.trim()); return true; } catch { return false; } })());

  // 物化：来源链由工具组装——本次操作 + 各输入的根节点，上游的 data 不进新链
  const queryOrigin = JSON.parse(readFileSync(resolve(DEV_ROOT, dataSrc), 'utf8')).origin;
  const snap = await call('jq_transform_into', {
    name: 'snap',
    motivation: '物化：取第一行',
    inputs: { q: dataSrc },
    byFile: prog('.q.rows[0]'),
  });
  console.log(`  物化 snap → ${snap.value.dataSrc} · ${snap.value.shape} · outputs=${snap.value.outputs}`);
  const snapFile = JSON.parse(readFileSync(resolve(DEV_ROOT, snap.value.dataSrc), 'utf8'));
  const snapRoot = snapFile.origin.nodes[snapFile.origin.root];
  console.log(snap.value.chain.map((line) => `    ${line}`).join('\n'));
  ok('物化：落点是 .oks/data/ 下的加工结果，回执给形状与输出个数',
    snap.value.dataSrc.startsWith('.oks/data/') && snap.value.dataSrc.endsWith('.transform.json')
    && snap.value.outputs === 1 && snap.value.shape.startsWith('对象'));
  ok('物化：新链 = 上游节点 + 本次操作（snip 与动机都记下）',
    Object.keys(snapFile.origin.nodes).length === 2 && snapRoot?.kind === 'transform'
    && snapRoot.snip === '.q.rows[0]' && snapRoot.motivation === '物化：取第一行');
  ok('物化：具名输入指向那份输入的根节点',
    snapRoot?.inputs?.q === queryOrigin.root);
  ok('物化：上游的 data 不进新来源链（链里只有操作）',
    Object.values(snapFile.origin.nodes).every((node) => !('data' in node))
    && JSON.stringify(snapFile.origin).includes('"intent"'));
  ok('物化：回执里的来源链是易读视图（输入在前、本次操作在最后）',
    snap.value.chain.some((line) => line.includes('query')) && snap.value.chain.some((line) => line.includes('本次操作')));

  // 多输入 + 共享祖先：raw 直接引用查询，snapshot 引用上一级加工——查询节点只该留一份
  const both = await call('jq_transform_into', {
    name: 'both',
    motivation: '物化：两份输入一起用',
    inputs: { raw: dataSrc, snapshot: snap.value.dataSrc },
    byFile: prog(`{rows: (.raw.rows | length), value: .snapshot.${column}}`),
  });
  const bothFile = JSON.parse(readFileSync(resolve(DEV_ROOT, both.value.dataSrc), 'utf8'));
  const bothRoot = bothFile.origin.nodes[bothFile.origin.root];
  console.log(`  物化 both · ${Object.keys(bothFile.origin.nodes).length} 个节点 · 输入 ${JSON.stringify(bothRoot?.inputs)}`);
  ok('物化：多输入按名字各自指向自己的来源',
    bothRoot?.inputs?.raw === queryOrigin.root && bothRoot?.inputs?.snapshot === snapFile.origin.root);
  ok('物化：共享祖先只留一份节点（查询 + snap + both）',
    Object.keys(bothFile.origin.nodes).length === 3);

  // 第三级：链继续长，后面的文件仍带着最前面的 Intent
  const again = await call('jq_transform_into', {
    name: 'again',
    motivation: '物化：再加工一级',
    inputs: { prev: both.value.dataSrc },
    byFile: prog('.prev.rows'),
  });
  const againFile = JSON.parse(readFileSync(resolve(DEV_ROOT, again.value.dataSrc), 'utf8'));
  console.log(`  物化 again · ${Object.keys(againFile.origin.nodes).length} 个节点 · data=${JSON.stringify(againFile.data)}`);
  ok('物化：三级加工后链仍是 4 个节点，根是最新一级',
    Object.keys(againFile.origin.nodes).length === 4
    && againFile.origin.nodes[againFile.origin.root].inputs.prev === bothFile.origin.root);
  ok('物化：标量结果照写（data 就是那个值，输出个数记在节点上）',
    againFile.data === rowTotal
    && againFile.origin.nodes[againFile.origin.root].outputs === 1);

  // 明确回执：名字不合法、缺 name、截断的结果不物化
  const badName = await (async () => {
    try {
      await call('jq_transform_into', { name: '告警-分布', inputs: { q: dataSrc }, byFile: prog('.q.rows[0]') });
      return '';
    } catch (cause) {
      return String(cause?.message ?? cause);
    }
  })();
  console.log(`  名字不合法 → ${badName.slice(0, 96)}`);
  ok('物化：名字不合法时明确报错', /名字只能是/.test(badName));
  const noName = await (async () => {
    try {
      await call('jq_transform_into', { inputs: { q: dataSrc }, byFile: prog('.q.rows[0]') });
      return '';
    } catch (cause) {
      return String(cause?.message ?? cause);
    }
  })();
  ok('物化：缺 name 明确报错', /需要 name/.test(noName));
  const truncatedInto = await (async () => {
    try {
      await call('jq_transform_into', { name: 'bulk', inputs: { rows: dataSrc }, byFile: prog('range(1; 200000)') });
      return '';
    } catch (cause) {
      return String(cause?.message ?? cause);
    }
  })();
  console.log(`  截断不物化 → ${truncatedInto.slice(0, 120)}`);
  ok('物化：截断的结果是残缺的，明确失败而不落盘', /不完整，没有物化/.test(truncatedInto));

  // 祖先文件删掉之后，最后一份封装仍然读得出完整来源链（操作与关系都在文件里）
  rmSync(resolve(DEV_ROOT, dataSrc), { force: true });
  rmSync(resolve(DEV_ROOT, snap.value.dataSrc), { force: true });
  rmSync(resolve(DEV_ROOT, both.value.dataSrc), { force: true });
  rmSync(resolve(DEV_ROOT, mixed.value.dataSrc), { force: true });
  rmSync(resolve(DEV_ROOT, derived.value.dataSrc), { force: true });
  for (const made of [twinA, twinB, twinUse]) rmSync(resolve(DEV_ROOT, made.value.dataSrc), { force: true });
  const orphan = readEnvelope(DEV_ROOT, again.value.dataSrc);
  const orphanView = chainLines(orphan.origin);
  console.log(orphanView.map((line) => `    ${line}`).join('\n'));
  ok('祖先被删后仍读出完整来源链（4 次操作，含最初的 Intent 与三级 snip）',
    Object.keys(orphan.origin.nodes).length === 4
    && orphanView.filter((line) => /^\[/.test(line)).length === 4
    && orphanView.some((line) => line.startsWith('[') && line.includes('query'))
    && orphanView.some((line) => line.includes('.prev.rows')));
  rmSync(resolve(DEV_ROOT, again.value.dataSrc), { force: true });
}

// ── 行数由 Intent 的 limit 决定：服务限行，插件完整保存（不再另有 queryMaxRows 截断）──
console.log('=== Intent 的 limit 决定取回行数（limit=2）===');
if (dimension === null) {
  console.log('  （跳过：发现协议没走到维度节点）');
} else {
  const { tools } = buildCtx({});
  const named = {
    rows: {
      op: 'Graph', root: 'x', nodes: [{ id: 'x', entity: member.id }], edges: [],
      select: [{ node: 'x', dimension: dimension.id }], limit: 2,
    },
  };
  const exec = { signal: new AbortController().signal, ...sessionFor(DEV_ROOT) };
  const checked = await tools.get('oks_check_intent').execute({ intents: named }, exec);
  const key = (checked.results ?? [])[0]?.key ?? null;
  const args = { intents: { rows: { intent: named.rows, key } } };
  const tool = tools.get('oks_query');
  const value = await tool.execute(args, exec);
  const text = tool.output.render(args, value).map((block) => block.text ?? '').join('');
  const first = value.results?.[0] ?? null;
  console.log(text.split('\n').filter((line) => /status:|dataSrc:/.test(line)).map((l) => `  ${l}`).join('\n'));
  if (first === null || first.status !== 'saved') throw new Error(`多行查询失败：${first?.status ?? '(无结果)'} ${first?.error ?? ''}`);
  console.log(`  limit=2 → 落盘 ${first.rowCount} 行`);
  if (first.rowCount > 2) throw new Error('limit 应当在服务侧限行');
  if (first.truncated) throw new Error('服务已按 limit 限行时，插件不该再报「还有更多」');
  const savedFile = JSON.parse(readFileSync(resolve(DEV_ROOT, first.dataSrc), 'utf8'));
  if (savedFile.data.rows.length !== first.rowCount) throw new Error('结果文件应当完整保存这次 Intent 的结果');
  if (savedFile.data.rows.length !== 2) throw new Error('limit=2 的结果文件里应当只有两行');
}

// ── 命名：<时间>-<名字>[-<内容哈希>].<类别><扩展名>（内部材料与交付物同一套）────────
console.log('=== 产物命名 ===');
{
  const sha = (text) => createHash('sha256').update(text).digest('hex');
  const svg = '<svg/>';
  const named = artifactName({ at: '20261010T115343Z', name: 'alarm_by_level', kind: 'chart', extension: '.svg', content: svg });
  ok('名字里那段就是内容哈希（前缀 8 位）',
    named === `20261010T115343Z-alarm_by_level-${sha(svg).slice(0, 8)}.chart.svg`);
  ok('时间戳到秒', /^\d{8}T\d{6}Z$/.test(resultStamp()));
  // 内容不是一次拿到时那一段可以省掉（现在没有调用方这么做，但格式留了这个位置）。
  ok('没有内容就没有哈希段',
    artifactName({ at: '20261010T115343Z', name: 'x', kind: 'query', extension: '.json' }) === '20261010T115343Z-x.query.json');

  // 超长名字：前 53 + `~` + 6 位哈希，总长仍在上限内；`~` 是允许字符集之外的唯一记号。
  const nameOf = (fileName) => fileName.slice('20261010T115343Z-'.length).replace(/-[0-9a-f]{8}\.report\.html$/, '');
  const long = 'a'.repeat(NAME_MAX - 7) + 'XXXXXXX' + 'b'.repeat(20);
  const cut = artifactName({ at: '20261010T115343Z', name: long, kind: 'report', extension: '.html', content: svg });
  const cutName = nameOf(cut);
  ok(`超长名字截到 ${NAME_MAX} 字符且留了 ~ 记号`,
    cutName.length === NAME_MAX && cutName === `${long.slice(0, NAME_MAX - 7)}~${sha(long.slice(NAME_MAX - 7)).slice(0, 6)}`);
  // 只差"被截掉的那一段"的两个长名字仍要分得开：哈希覆盖的是**整个**被丢掉的部分。
  // （若按 name[N..] 取哈希，这两个名字会塌成同一个文件名。）
  const twin = artifactName({ at: '20261010T115343Z', name: `${long.slice(0, NAME_MAX - 7)}YYYYYYY${'b'.repeat(20)}`, kind: 'report', extension: '.html', content: svg });
  ok('被截掉的那一段参与哈希', nameOf(twin) !== cutName);

  // 名字是标识：字符集收得紧，`-` 与 `.` 才能当无歧义的分隔符。
  // 校验在工具入口：非法名字进不了文件名（这里先只核对纯函数，工具那条在图表一节里真跑）。
  console.log(`  命名：${named}`);
}


// ── 产物自述：写进文件里的元数据（报告 <meta>，图 <title> / <metadata>）──────────────
console.log('=== 产物自述 ===');
{
  const meta = { name: 'alarm_by_level', kind: 'chart', at: '20261010T115343Z', title: '告警等级 <分布>' };
  const svg = embedArtifactMeta('<svg width="10"><path d="M0 0"/></svg>', meta);
  ok('图的自述写在根 <svg> 之后', svg.startsWith('<svg width="10"><title>') && svg.includes('id="dsh-oks-artifact"'));
  const back = readArtifactMeta(svg);
  ok('图的自述能读回（标题里的尖括号走 XML 转义）',
    back?.title === meta.title && back?.at === meta.at && back?.name === meta.name);

  const html = embedArtifactMeta('<html><head><meta charset="utf-8"></head><body></body></html>', { ...meta, kind: 'report' });
  ok('报告的自述插在 <head> 之后', html.startsWith('<html><head>\n<meta name="dsh-oks-artifact"'));
  ok('报告的自述能读回', readArtifactMeta(html)?.kind === 'report' && readArtifactMeta(html)?.title === meta.title);
  ok('没有自述的产物读回 null', readArtifactMeta('<svg/>') === null && readArtifactMeta('{}') === null);

  // 形状不认识时报错而不是原样返回：渲染层形状变了要立刻知道，静默写出一份没有自述的产物更糟。
  const throwsWith = (run, needle) => {
    try { run(); return null; } catch (err) { const text = String(err?.message ?? err); return text.includes(needle) ? text : null; }
  };
  ok('报告形状不符时报错', throwsWith(() => embedArtifactMeta('<html><body>没有 head</body></html>', { ...meta, kind: 'report' }), '<head>') !== null);
  ok('图形状不符时报错', throwsWith(() => embedArtifactMeta('not svg', meta), '<svg>') !== null);

  // 标题永不为空：这是存储层守的门（工具侧会先造一个，见图表一节）。
  const emptyTitle = throwsWith(
    () => saveArtifact({ root: SCRATCH, name: 'no_title', content: '<svg/>', extension: '.svg', kind: 'chart', title: '   ' }),
    '标题不能为空');
  ok('空标题被存储层拒掉', emptyTitle !== null);
  console.log(`  自述：${back?.title} · at=${back?.at}`);
}

console.log('=== oks_chart（服务端出图）===');
{
  // 图表只认封装引用：自填的行先经 create_data 变成一份封装（.data.json），再当 src 用。
  // 这个 helper 只活在冒烟里——工具面上没有"内联 data"这条路。
  const chart = async (args) => {
    if (args.data === undefined) return call('oks_chart', args);
    const made = await call('create_data', {
      name: typeof args.name === 'string' ? `${args.name}_data` : 'smoke_chart_rows',
      motivation: '冒烟夹具：把自填的行变成一份封装，图才能引用它',
      data: args.data,
    });
    const { data: inlineRows, ...rest } = args;
    void inlineRows;
    return call('oks_chart', { ...rest, src: made.value.dataSrc });
  };
  // 自填数据：先 create_data 落成一份封装（.data.json），图再用 src 引用它——
  // 工具面上没有内联 data 这条路；图里也不再画"来源标识"——标签说不清，改由来源链自己说。
  const inlineRejected = await (async () => {
    try {
      await call('oks_chart', {
        spec: { kind: 'bar', x: 'label', value: 'value' },
        data: [{ label: 'A', value: 3 }],
      });
      return '';
    } catch (cause) {
      return String(cause?.message ?? cause);
    }
  })();
  console.log(`  内联 data → ${inlineRejected.slice(0, 96)}`);
  ok('图拒绝内联 data（行必须先成为一份封装）', /行不能直接填在图里/.test(inlineRejected));
  const inline = await chart({
    spec: { kind: 'bar', title: '方案对比', x: 'label', value: 'value' },
    data: [{ label: 'A', value: 3 }, { label: 'B', value: 5 }],
    name: 'probe_inline',
  });
  console.log(inline.text.split('\n').filter(Boolean).map((line) => `  ${line}`).join('\n').slice(0, 520));
  if (inline.value.ok !== true) throw new Error('自填数据（先落成封装）应当能画出图');
  if (inline.value.rowCount !== 2) throw new Error('图应当报告画了多少行');
  const inlineRaw = readFileSync(resolve(DEV_ROOT, inline.value.svgSrc), 'utf8');
  if (/自主填写|基于查询结果/.test(inline.text) || /自主填写|基于查询结果/.test(inlineRaw)) {
    throw new Error('来源标签已经取消：图与回执里都不该再出现它');
  }
  if (inline.value.title !== '方案对比') throw new Error('回执里的标题应当是 agent 给的那个');
  // 图真的落成了 SVG
  const inlineSvg = readFileSync(resolve(DEV_ROOT, inline.value.svgSrc), 'utf8');
  console.log(`  落盘 ${inline.value.svgSrc}（${inlineSvg.length} 字符）: ${inlineSvg.startsWith('<svg') ? '✓' : '✗'}`);
  if (!inlineSvg.startsWith('<svg')) throw new Error('产物应当是 SVG');
  // 自述就写在文件最前面：标题、类别、时间、来源都在里面，读开头一段就够。
  const inlineMeta = readArtifactMeta(inlineSvg);
  if (inlineMeta === null) throw new Error('落盘的图应当带自述');
  if (inlineMeta.title !== '方案对比' || inlineMeta.kind !== 'chart') {
    throw new Error(`自述里的 title / kind / source 不对：${JSON.stringify(inlineMeta)}`);
  }
  if (inlineMeta.at !== inline.value.at || !inline.value.svgSrc.includes(inlineMeta.at)) {
    throw new Error('自述里的 at 应当与回执、文件名里的时间一致');
  }
  if (inlineSvg.indexOf('dsh-oks-artifact') > 400) throw new Error('自述应当写在文件最前面');
  // 名字自证内容：`sha256sum` 出来的前 8 位就是名字里那一段，回执的 at 就是名字里那段时间。
  {
    const fileName = String(inline.value.svgSrc).split('/').pop();
    const digest = createHash('sha256').update(inlineSvg).digest('hex').slice(0, 8);
    if (!fileName.includes(`-${digest}.chart.svg`)) {
      throw new Error(`文件名里的哈希应当等于内容的 sha256 前 8 位：${fileName} vs ${digest}`);
    }
    if (!fileName.startsWith(`${inline.value.at}-`)) {
      throw new Error(`文件名应当以回执给的 at 开头：${fileName} vs ${inline.value.at}`);
    }
    console.log(`  名字自证：${fileName.split('-').slice(-1)[0]} = sha256(内容) 前 8 位 · at 一致`);
  }
  // 图里的文字是真 <text>（echarts 不把文字转成路径），标题则从回执字段核对。
  if (!inlineSvg.includes('<path')) throw new Error('SVG 里应当有图形');
  // 产物必须是"没有任何动画的静态图"：浏览器会真的执行 SVG 里的 @keyframes，
  // 而入场动画的起始态是 transform: scale(0,0) / opacity: 0，播完若不保持就看不见了。
  if (inlineSvg.includes('@keyframes')) throw new Error('SVG 里不该有 @keyframes');
  if (inlineSvg.includes('scale(0,0)') || inlineSvg.includes('opacity:0')) {
    throw new Error('SVG 里不该有入场动画的起始态（opacity:0 / scale(0,0)）');
  }
  if (inline.value.title !== '方案对比') throw new Error('回执应当带上标题');
  // 回执给出的 markdown 指向同一个文件
  const expectedMarkdown = `![方案对比](${inline.value.svgSrc})`;
  if (inline.value.markdown !== expectedMarkdown) {
    throw new Error(`回执应当给出指向该 SVG 的 markdown，收到 ${JSON.stringify(inline.value.markdown)}`);
  }
  console.log(`  回执给出的 markdown: ${inline.value.markdown}`);

  // 同一份产物写两次：名字里有内容哈希，所以"撞名"只可能是同一份内容。
  // 同一秒里是去重（指同一个文件），跨秒就是两个文件——两条路都不该出现"-2"这种序号补丁。
  {
    const spec = { kind: 'bar', x: 'label', value: 'value' };
    const data = [{ label: 'A', value: 3 }, { label: 'B', value: 5 }];
    const before = new Set(readdirSync(resolve(DEV_ROOT, '.oks', 'charts')));
    const first = await chart({ spec, data, name: 'probe_dup' });
    const second = await chart({ spec, data, name: 'probe_dup' });
    const added = readdirSync(resolve(DEV_ROOT, '.oks', 'charts')).filter((name) => !before.has(name));
    const same = first.value.svgSrc === second.value.svgSrc;
    console.log(`  同一份产物写两次：${same ? '同一秒 → 去重' : '跨了秒 → 各存一份'}（新增 ${added.length} 个）`);
    if (same ? added.length !== 1 : added.length !== 2) {
      throw new Error(`去重与否都只该按内容算，新增文件数 ${added.length}`);
    }
    // 只抓"序号补丁"（`-2.chart.svg` 这种短计数器），别误伤**内容哈希恰好全是数字**的文件：
    // 8 位十六进制里全落在 0-9 的概率约 2%，那不是序号。
    if (added.some((name) => /-\d{1,4}\.(?:chart|report|query)\./.test(name))) {
      throw new Error(`不该再出现序号补丁：${added.join(', ')}`);
    }
  }

  // src 路径：引用一份查询结果封装，回执给出它的来源链。
  const answer = await call('oks_query', { intents: await withKeys(countNamed) });
  const saved = (answer.value.results ?? [])[0] ?? null;
  const firstColumn = saved.columns[0]?.name;
  const numeric = saved.columns.find((entry) => entry.types.includes('number'))?.name ?? firstColumn;
  const fromSrc = await chart({
    spec: { kind: 'bar', x: firstColumn, value: numeric, title: '来自查询' },
    src: saved.dataSrc,
    note: '来源是查询结果文件',
  });
  if (fromSrc.value.ok !== true) throw new Error('引用查询结果的图应当画得出来');
  if (fromSrc.value.src !== saved.dataSrc) throw new Error('src 路径应当回带 dataSrc');
  if (!Array.isArray(fromSrc.value.chain) || !fromSrc.value.chain.some((line) => line.includes('query'))) {
    throw new Error('回执应当给出这份图的来源链（易读视图）');
  }
  const fromSrcSvg = readFileSync(resolve(DEV_ROOT, fromSrc.value.svgSrc), 'utf8');
  if (!fromSrcSvg.startsWith('<svg')) throw new Error('src 路径也应当落一份 SVG');
  console.log(`  src 路径：${fromSrc.value.rowCount} 行 → ${fromSrc.value.svgSrc} · 来源链 ${fromSrc.value.chain.length} 行`);
  // 图自带绘图材料：画出来的行、绘图规格与完整来源链都写在 SVG 里——
  // 工作区是可回收的，图要能自己说清这些数字从哪来。
  const carried = readChartInput(fromSrcSvg);
  ok('图里带着绘图材料（画出来的行 + 规格 + 来源链）',
    carried !== null && Array.isArray(carried.data.rows) && carried.data.rows.length === fromSrc.value.rowCount
    && carried.data.spec?.kind === 'bar' && carried.origin.root !== undefined
    && carried.origin.nodes[carried.origin.root]?.kind === 'query');

  // 给定数据当 src：来源标签由来源链推导，数据文件被回收后图仍旧说得清
  const given = await call('create_data', {
    name: 'chart_given',
    motivation: '冒烟夹具：一小组自填的行',
    data: [{ label: 'A', value: 1 }, { label: 'B', value: 2 }],
  });
  const givenChart = await call('oks_chart', {
    spec: { kind: 'bar', title: '自填数据', x: 'label', value: 'value' },
    src: given.value.dataSrc,
  });
  rmSync(resolve(DEV_ROOT, given.value.dataSrc), { force: true });
  const givenSvg = readFileSync(resolve(DEV_ROOT, givenChart.value.svgSrc), 'utf8');
  const givenCarried = readChartInput(givenSvg);
  ok('create_data 的封装能直接当图的 src', givenChart.value.ok === true && givenChart.value.rowCount === 2);
  ok('数据文件被回收后，图仍带着那些行与自己的来源链',
    givenCarried?.data?.rows?.[0]?.label === 'A' && givenCarried?.data?.rows?.length === 2
    && givenCarried?.origin?.nodes?.[givenCarried.origin.root]?.kind === 'input'
    && readArtifactMeta(givenSvg)?.kind === 'chart');
  // 来源标签已取消：图里不画那行小字，回执里也没有这一项——要说来源，看嵌在图里的来源链。
  const inlineLowering = renderEchartsSvg(
    buildOption([{ label: 'A', value: 1 }], {
      kind: 'bar', title: null, x: 'label', value: 'value',
      series: null, xType: null, xLabel: null, valueLabel: null, unit: null,
    }).option,
    CHART_WIDTH,
    200,
  );
  if (/来源：/.test(inlineLowering)) throw new Error('图里不该再画来源脚注');
  if (inline.value.source !== undefined || fromSrc.value.source !== undefined) {
    throw new Error('回执里不该再有来源标签字段');
  }
  console.log('  来源标签：图内脚注与回执字段都已取消 ✓');

  // 负值走 0 轴另一侧，并且换色，方向一眼可辨。
  const signed = await chart({
    spec: { kind: 'bar', title: '正负对照', x: 'label', value: 'value' },
    data: [{ label: '正', value: 5 }, { label: '负', value: -3 }],
    name: 'probe_signed',
  });
  const signedSvg = readFileSync(resolve(DEV_ROOT, signed.value.svgSrc), 'utf8');
  console.log(`  正负对照：${signedSvg.includes('#c0567a') ? '负值用区分色 ✓' : '✗ 没有区分色'}`);
  if (!signedSvg.includes('#c0567a')) throw new Error('负值应当用区分色绘制');

  // 分组柱：横轴是类别，每个类别里按 series 分成相邻的柱子。
  const column = await chart({
    spec: {
      kind: 'column', title: '月销售额（按渠道）', x: 'month', series: 'channel', value: 'amount',
      valueLabel: '销售额（万元）',
    },
    data: [
      { month: '1月', channel: '零售', amount: 120 },
      { month: '1月', channel: '批发', amount: 90 },
      { month: '2月', channel: '零售', amount: 135 },
      // 2 月的批发刻意缺失：它的位置应当留空，而不是让后面的柱子挤过来
    ],
    name: 'probe_column',
  });
  const columnSvg = readFileSync(resolve(DEV_ROOT, column.value.svgSrc), 'utf8');
  console.log(`  分组柱：${column.value.rowCount} 行 → ${column.value.svgSrc} · ${(columnSvg.match(/<path/g) ?? []).length} 个 <path>`);
  if (!columnSvg.startsWith('<svg')) throw new Error('分组柱应当落一份 SVG');
  if (!columnSvg.includes('<path')) throw new Error('分组柱的 SVG 里应当有图形');

  // 饼图：只画正数，负数与零跳过；配色按扇区轮转。
  const pie = await chart({
    spec: { kind: 'pie', title: '各级别占比', x: 'label', value: 'value' },
    data: [
      { label: '甲', value: 3 },
      { label: '乙', value: 5 },
      { label: '丙', value: 2 },
      { label: '零', value: 0 },
      { label: '负', value: -1 },
    ],
    name: 'probe_pie',
  });
  const pieSvg = readFileSync(resolve(DEV_ROOT, pie.value.svgSrc), 'utf8');
  console.log(`  饼图：${pie.value.rowCount} 行 → ${(pieSvg.match(/<path/g) ?? []).length} 个 <path>`);
  if (!pieSvg.startsWith('<svg') || !pieSvg.includes('<path')) throw new Error('饼图应当落一份有图形的 SVG');
  // 没有正数时也不该报错：出一张只有说明的图。
  const pieEmpty = await chart({
    spec: { kind: 'pie', x: 'label', value: 'value' },
    data: [{ label: '零', value: 0 }],
    name: 'probe_pie_empty',
  });
  if (pieEmpty.value.ok !== true) throw new Error('没有正数时饼图也应当出图');

  // 面积图：字段与折线一致，x 轴同样支持 number / time。
  const area = await chart({
    spec: { kind: 'area', title: '每日告警数', x: 'day', value: 'count', xType: 'number' },
    data: [{ day: 0, count: 15 }, { day: 1, count: 25 }, { day: 2, count: 18 }],
    name: 'probe_area',
  });
  const areaSvg = readFileSync(resolve(DEV_ROOT, area.value.svgSrc), 'utf8');
  console.log(`  面积图：${area.value.rowCount} 行 → ${(areaSvg.match(/<path/g) ?? []).length} 个 <path>`);
  if (!areaSvg.startsWith('<svg') || !areaSvg.includes('<path')) throw new Error('面积图应当落一份有图形的 SVG');

  // 排版覆盖项：用户不满意时 agent 可以调字号与高度，越界或写错项直接拒绝。
  const tuned = await chart({
    spec: { kind: 'bar', x: 'label', value: 'value', layout: { labelFont: 14, height: 240, slantTicks: false } },
    data: [{ label: '甲', value: 3 }, { label: '乙', value: 5 }],
    name: 'probe_layout',
  });
  const tunedSvg = readFileSync(resolve(DEV_ROOT, tuned.value.svgSrc), 'utf8');
  console.log(`  排版覆盖：labelFont/height/slantTicks 生效 → ${(tunedSvg.match(/<path/g) ?? []).length} 个 path`);
  if (!tunedSvg.includes('<path')) throw new Error('覆盖排版后仍应出图');
  // 这张图没有标题：自述里那一行**永不为空**，工具按"维度 × 度量"造一个（只进自述，不改绘制）。
  const tunedMeta = readArtifactMeta(tunedSvg);
  if (tunedMeta === null) throw new Error('落盘的图应当带自述');
  if (tunedMeta.title !== 'label × value') {
    throw new Error(`没给标题时应当按维度与度量造一个，收到 ${JSON.stringify(tunedMeta.title)}`);
  }
  if (!tunedSvg.includes('<title>label × value</title>')) throw new Error('自述应当把造出来的标题也写进 <title>');
  // 造出来的标题只进自述：绘图区仍由 agent 的 spec 决定，没标题就不该有标题位。
  if (/<text[^>]*>label × value<\/text>/.test(tunedSvg)) throw new Error('造标题不该顺手把标题画进图里');
  console.log(`  自述：${tunedMeta.title}（agent 没给标题，工具造的）`);

  // 报告：markdown 正文（章节 + 叙述 + 引用的图）→ 自足的 HTML（图内联、无外链、无脚本）。
  // 图只有一种来源：工作区里**已经画好**的 SVG（上面那张 tuned 就是现成的）。
  const report = await call('oks_report', {
    spec: {
      title: '周报（冒烟）',
      subtitle: '2026-09-09 ~ 10-08',
      markdown: [
        '## 一、等级分布',
        '',
        '本周期共 **100** 条告警，其中：',
        '',
        '- 严重 15 条',
        '- 提示 36 条',
        '',
        `![各级别条数](${tuned.value.svgSrc})`,
        '',
        '## 二、口径说明',
        '',
        '> 度量取自知识模型声明，未自定义聚合。',
        '',
        '| 项 | 值 |',
        '| --- | --- |',
        '| 时间窗 | 30 天 |',
        '| 明细 | 甲站 96 条<br>乙站 78 条 |',
        '',
        '这一段里有硬换行：',
        '第一行<br>第二行  ', 
        '第三行\\',
        '第四行（软换行会并成一行）',
        '',
        '```sql',
        'select alarm_count from current_alarm',
        '```',
        '',
        '---',
        '',
        '**注意**：`weighted` 是加权分，不可与条数直接相加。',
        '',
        '<script>alert(1)</script>',
        '',
        '还有一段 <span>不该放行</span> 的标签。',
      ].join('\n'),
    },
    name: 'probe_report',
  });
  const reportHtml = readFileSync(resolve(DEV_ROOT, report.value.htmlSrc), 'utf8');
  console.log(`  报告：${report.value.figureCount} 张引用的图 → ${report.value.htmlSrc}`);
  if (report.value.figureCount !== 1) throw new Error(`这份报告引用了一张图，收到 ${report.value.figureCount}`);
  if (!reportHtml.includes('<figcaption><span class="item-no">图 1</span>各级别条数</figcaption>')) {
    throw new Error('引用的图应当按出现顺序拿到编号与图注');
  }
  if (!reportHtml.includes('<svg class="chart"')) throw new Error('报告里的图应当以 svg 元素内联，而不是 base64 图片');
  const reportMeta = readArtifactMeta(reportHtml);
  if (reportMeta === null) throw new Error('落盘的报告应当带自述');
  if (reportMeta.title !== '周报（冒烟）' || reportMeta.kind !== 'report') {
    throw new Error(`报告自述里的 title / kind 不对：${JSON.stringify(reportMeta)}`);
  }
  if (reportMeta.source !== undefined) throw new Error('自述里不该有来源这一项（它已经取消）');
  if (reportHtml.indexOf('dsh-oks-artifact') > 400) throw new Error('自述应当写在文件最前面');
  if (/<script(?![^>]*type="application\/json")/.test(reportHtml)) throw new Error('报告里不应有可执行脚本');
  if (/src="http/.test(reportHtml)) throw new Error('报告应当是自足的，不该有外链');
  // 图是内联的，所以可以直接在 HTML 里核对内容；也顺带确认清理没有漏掉脚本。
  if (/来源：agent 自主填写|来源：基于查询结果/.test(reportHtml)) throw new Error('图内来源脚注已经取消');
  if (/<svg[^>]*\son[a-z]+=/i.test(reportHtml)) throw new Error('内联 SVG 上不应留下事件属性');
  // 根元素不该再带固定宽高——那样就不能随栏宽自适应了。
  if (/<svg class="chart"[^>]*\swidth=/i.test(reportHtml)) throw new Error('内联 SVG 不应保留固定宽度');

  // 堆叠：column / area 的 stack 开关（绝对量与占比两种）。
  const stackRows = [
    { m: '1月', sev: '严重', n: 4 }, { m: '1月', sev: '重要', n: 8 },
    { m: '2月', sev: '严重', n: 5 }, { m: '2月', sev: '重要', n: 10 },
  ];
  for (const [label, stack] of [['绝对量', 'total'], ['占比', 'percent']]) {
    const stacked = await chart({
      spec: { kind: 'column', x: 'm', series: 'sev', value: 'n', stack },
      data: stackRows,
      name: 'probe_stack_' + stack,
    });
    const svg = readFileSync(resolve(DEV_ROOT, stacked.value.svgSrc), 'utf8');
    console.log(`  堆叠（${label}）：${(svg.match(/<path/g) ?? []).length} 个 path`);
    if (!svg.includes('<path')) throw new Error(`堆叠（${label}）应当出图`);
  }

  // 散点：两个量的关系；给了 size 就是气泡。
  const scatter = await chart({
    spec: { kind: 'scatter', title: 'CPU vs 内存', x: 'cpu', value: 'mem', size: 'samples', valueLabel: '内存', unit: '%' },
    data: [
      { cpu: 74.4, mem: 88.8, samples: 720 },
      { cpu: 40.4, mem: 48.4, samples: 120 },
      { cpu: 10.4, mem: 22.4, samples: 24 },
    ],
    name: 'probe_scatter',
  });
  const scatterSvg = readFileSync(resolve(DEV_ROOT, scatter.value.svgSrc), 'utf8');
  console.log(`  散点（带点大小）：${(scatterSvg.match(/<path/g) ?? []).length} 个 path`);
  if (!scatterSvg.includes('<path')) throw new Error('散点应当出图');

  // 组合图：第二个度量走独立的右侧数值轴。
  const comboRows = [
    { m: '1月', cpu: 36.9, ports: 526150 }, { m: '2月', cpu: 41.2, ports: 531200 },
    { m: '3月', cpu: 43.4, ports: 540880 }, { m: '4月', cpu: 39.8, ports: 549310 },
  ];
  const combo = await chart({
    spec: { kind: 'column', title: 'CPU 与端口数', x: 'm', value: 'cpu', valueLabel: 'CPU 使用率', unit: '%', second: { value: 'ports', label: '端口数', unit: '个' } },
    data: comboRows,
    name: 'probe_combo',
  });
  const comboSvg = readFileSync(resolve(DEV_ROOT, combo.value.svgSrc), 'utf8');
  // 两个轴的名字都要在：右侧轴是第二维度的落地标志。
  if (!comboSvg.includes('CPU 使用率')) throw new Error('组合图应当有左轴说明');
  if (!comboSvg.includes('端口数（个）')) throw new Error('组合图应当有右侧数值轴');
  console.log('  组合图：两个数值轴都在（' + (comboSvg.match(/<path/g) ?? []).length + ' 个 path）');

  // 阈值线：值超出数据范围时，轴要撑开把它容纳进去（否则 echarts 直接不画）。
  const threshold = await chart({
    spec: { kind: 'column', x: 'm', value: 'cpu', valueLabel: 'CPU 使用率', unit: '%', marks: [{ value: 40, label: '基线 40%' }, { value: 55, label: '上限 55%' }] },
    data: comboRows,
    name: 'probe_marks',
  });
  const marksSvg = readFileSync(resolve(DEV_ROOT, threshold.value.svgSrc), 'utf8');
  if (!marksSvg.includes('stroke-dasharray')) throw new Error('阈值线应当是虚线');
  if (!marksSvg.includes('基线 40%') || !marksSvg.includes('上限 55%')) {
    throw new Error('两条阈值线都应当画出来（超出数据范围的那条靠撑开的轴容纳）');
  }
  const dashedCount = (marksSvg.match(/stroke-dasharray/g) ?? []).length;
  if (dashedCount < 2) throw new Error(`两条阈值线应当在图里，只找到 ${dashedCount} 条`);
  console.log('  阈值线：' + dashedCount + ' 条虚线，标签都在');
  // 参考线属于**绘图规格**，随规格一起进图：它不进来源链（不是数据），但要能核对。
  const marksSpec = readChartInput(marksSvg)?.data.spec;
  ok('参考线随绘图规格存进图里（它属于规格，不属于数据）',
    (marksSpec?.marks ?? []).length === 2 && marksSpec.marks[1].label === '上限 55%'
    && marksSpec.unit === '%' && marksSpec.kind === 'column');

  // 横条图：数值在 x 轴上，second 与 marks 都要跟着换边。
  const barSecond = await chart({
    spec: {
      kind: 'bar', x: 'm', value: 'cpu', valueLabel: 'CPU 使用率', unit: '%',
      second: { value: 'ports', label: '端口数', unit: '个' },
      marks: [{ value: 50, label: '阈值 50%' }, { value: '3月', label: '重点', axis: 'x' }],
    },
    data: comboRows,
    name: 'probe_bar_second',
  });
  const barSvg = readFileSync(resolve(DEV_ROOT, barSecond.value.svgSrc), 'utf8');
  if (!barSvg.includes('端口数（个）')) throw new Error('横条图上的第二个度量应当有自己的轴');
  if (!barSvg.includes('阈值 50%') || !barSvg.includes('重点')) throw new Error('横条图上的两条参考线标签都该在');
  const barDashed = [...barSvg.matchAll(/<path d="M([\d.]+) ([\d.]+)L([\d.]+) ([\d.]+)"[^>]*stroke-dasharray/g)]
    .map((m) => ({ x1: Number(m[1]), y1: Number(m[2]), x2: Number(m[3]), y2: Number(m[4]) }));
  // 数值轴在 x 上：阈值是竖线；类别轴在 y 上：类别标记是横线。
  if (!barDashed.some((d) => d.x1 === d.x2)) throw new Error('横条图上的阈值线应当是竖线（数值轴在 x）');
  if (!barDashed.some((d) => d.y1 === d.y2)) throw new Error('横条图上的类别标记应当是横线');
  console.log('  横条图：second 换到 x 轴，阈值竖线 + 类别横线都在');

  // xType 不填时从数据推断。这条同时钉住"年份数字不能被当成 epoch 毫秒"——
  // 那会把横轴画到 1970 年，而且图看起来还挺正常。
  const inferredTime = await chart({
    spec: { kind: 'line', x: 't', value: 'v' },
    data: [{ t: '2026-01-01T00:00:00Z', v: 1 }, { t: '2026-01-02T00:00:00Z', v: 2 }, { t: '2026-01-03T00:00:00Z', v: 3 }],
    name: 'probe_infer_time',
  });
  if (inferredTime.value.spec.xType !== 'time') throw new Error('时间文本应当被推断成 time');
  const inferredNumber = await chart({
    spec: { kind: 'line', x: 'y', value: 'v' },
    data: [{ y: 2026, v: 1 }, { y: 2027, v: 2 }, { y: 2028, v: 3 }],
    name: 'probe_infer_number',
  });
  if (inferredNumber.value.spec.xType !== 'number') {
    throw new Error('年份数字应被推断成 number，而不是当作 epoch 毫秒');
  }
  const inferredCategory = await chart({
    spec: { kind: 'line', x: 'k', value: 'v' },
    data: [{ k: '甲', v: 1 }, { k: '乙', v: 2 }],
    name: 'probe_infer_category',
  });
  if (inferredCategory.value.spec.xType !== null) throw new Error('文本类别应当留空（走类目轴）');
  console.log('  横轴推断：时间文本→time · 年份数字→number · 文本类别→类目轴');

  // 放错层时，报错要指出正确位置——agent 靠它自己纠正，比让它在两层之间猜好。
  let misplacedMessage = '';
  try {
    await chart({
      spec: { kind: 'column', x: 'label', value: 'value', layout: { labels: true } },
      data: [{ label: 'A', value: 1 }],
    });
  } catch (cause) {
    misplacedMessage = String((cause as { message?: string })?.message ?? cause);
  }
  if (!misplacedMessage.includes('spec.style')) {
    throw new Error(`放错层的报错应当指出 labels 属于 spec.style，实际：${misplacedMessage}`);
  }
  console.log('  放错层：' + misplacedMessage.slice(0, 72));

  // 百分比堆叠：顶部要有余量（否则 100% 那条线压在轴顶上，像图被截断），但刻度仍只到 100%。
  const pctRows = Array.from({ length: 6 }, (_, i) => [
    { m: 'M' + i, s: 'a', v: 60 + i },
    { m: 'M' + i, s: 'b', v: 30 - i },
    { m: 'M' + i, s: 'c', v: 10 },
  ]).flat();
  const pct = await chart({
    spec: { kind: 'area', x: 'm', series: 's', value: 'v', stack: 'percent', valueLabel: '占比', unit: '%' },
    data: pctRows,
    name: 'probe_percent_headroom',
  });
  const pctSvg = readFileSync(resolve(DEV_ROOT, pct.value.svgSrc), 'utf8');
  const pctTicks = [...pctSvg.matchAll(/<text[^>]*>([^<]{1,10})<\/text>/g)].map((m) => m[1].trim()).filter((t) => /%$/.test(t));
  if (!pctTicks.includes('100%')) throw new Error('百分比堆叠的刻度应当到 100%');
  if (pctTicks.some((t) => t !== '100%' && Number.parseInt(t, 10) > 100)) {
    throw new Error(`留余量用的上限不该出现在刻度上，实际刻度：${JSON.stringify(pctTicks)}`);
  }
  console.log('  百分比堆叠：刻度 ' + JSON.stringify(pctTicks) + '（上限被隐掉，顶部留了余量）');
  // 描边要比填充深一档：同色叠同色时，堆叠最上层那条外缘线会整个消失
  //（层与层之间因为有别的颜色垫着还看得出来，所以只有最上面那条出问题）。
  const strokeColors = [...new Set([...pctSvg.matchAll(/stroke="(#[0-9a-fA-F]{6})"[^>]*stroke-width="2"/g)].map((m) => m[1]))];
  const fillColors = new Set([...pctSvg.matchAll(/fill="(#[0-9a-fA-F]{6})"/g)].map((m) => m[1]));
  const sameColor = strokeColors.filter((color) => fillColors.has(color));
  if (sameColor.length > 0) {
    throw new Error(`描边不该与填充同色（同色等于看不见），发现：${JSON.stringify(sameColor)}`);
  }
  console.log('  描边与填充不同色：' + JSON.stringify(strokeColors));
  // 时间轴 + stack='percent'：归一化不能被时间轴分支覆盖。这条曾经让总和线一路爬出绘图区，
  // 真机上看起来就是"图被截断了"——比数值错更难发现，因为图还画得出来。
  const timePctRows = ['a', 'b', 'c'].flatMap((s2, j) =>
    Array.from({ length: 6 }, (_, i) => ({
      t: `2024-${String(i + 1).padStart(2, '0')}-01T00:00:00Z`, s: s2, v: 20 + i * 5 + j * 3,
    })));
  const timePct = await chart({
    spec: { kind: 'area', x: 't', series: 's', value: 'v', xType: 'time', stack: 'percent', valueLabel: '占比', unit: '%' },
    data: timePctRows,
    name: 'probe_time_percent',
  });
  const timePctSvg = readFileSync(resolve(DEV_ROOT, timePct.value.svgSrc), 'utf8');
  // 总和线 = 最后一条系列的描边；归一化生效时它应当是一条平线（y 的极差极小）。
  const sumTags = [...timePctSvg.matchAll(/<path[^>]*>/g)].map((m) => m[0])
    .filter((t) => t.includes('stroke-width="2"') && /stroke="(#[0-9a-fA-F]{6})"/.test(t) && /d="M[0-9.]+ /.test(t) && !/d="M0 /.test(t));
  const last = sumTags[sumTags.length - 1];
  const sumYs = last === undefined ? [] : [...(/d="([^"]+)"/.exec(last)[1]).matchAll(/[0-9.]+ (-?[0-9.]+)/g)].map((m) => Number(m[1]));
  const spread = sumYs.length === 0 ? Infinity : Math.max(...sumYs) - Math.min(...sumYs);
  if (spread > 3) {
    throw new Error(`时间轴上的百分比堆叠应当归一化（总和线接近水平），实际 y 极差 ${spread.toFixed(1)}px`);
  }
  console.log(`  时间轴 + percent：总和线 y 极差 ${spread.toFixed(1)}px（归一化生效）`);



  // 直方图：一列数值分箱。histogram 不需要 x，列校验也不该因此报"列不存在"。
  const manyRows = Array.from({ length: 60 }, (_, i) => ({ v: 10 + (i % 3) * 30 + i * 0.001, s: i % 2 ? 'p' : 'q' }));
  const hist = await chart({
    spec: { kind: 'histogram', value: 'v', valueLabel: '设备数', unit: '台', bins: 6, title: '取值分布' },
    data: manyRows,
    name: 'probe_hist',
  });
  const histSvg = readFileSync(resolve(DEV_ROOT, hist.value.svgSrc), 'utf8');
  const histLabels = [...histSvg.matchAll(/<text[^>]*>([^<]{1,20})<\/text>/g)].map((m) => m[1].trim());
  if (!histSvg.includes('设备数')) throw new Error('直方图的数值轴该有名字');
  if (!histLabels.some((t) => t.includes('–'))) throw new Error('直方图的横轴该是分箱区间');
  console.log('  直方图：' + histLabels.filter((t) => t.includes('–')).length + ' 个箱');

  // 箱线图：按类别算四分位与离群点。
  const boxRows = [
    ...[12, 18, 22, 30, 45, 51, 60].map((v) => ({ site: '甲', v })),
    ...[20, 26, 31, 38, 52, 58, 70].map((v) => ({ site: '乙', v })),
    { site: '甲', v: 200 },
  ];
  const box = await chart({
    spec: { kind: 'box', x: 'site', value: 'v', valueLabel: '响应时间', unit: 'ms', title: '响应时间分布' },
    data: boxRows,
    name: 'probe_box',
  });
  const boxSvg = readFileSync(resolve(DEV_ROOT, box.value.svgSrc), 'utf8');
  if (!boxSvg.includes('响应时间')) throw new Error('箱线图的数值轴该有名字');
  if (!boxSvg.includes('甲') || !boxSvg.includes('乙')) throw new Error('箱线图每个类别一个箱');
  console.log('  箱线图：两个类别都在');

  // 矩阵：两个类别维度 + 数值决定深浅。它是分组柱的另一种画法，同一份三元组。
  const heatRows = [
    { day: '周一', level: '严重', n: 12 }, { day: '周二', level: '严重', n: 18 },
    { day: '周一', level: '重要', n: 25 }, { day: '周二', level: '重要', n: 31 },
    { day: '周一', level: '次要', n: 40 },
    { day: '周一', level: '提示', n: 61 }, { day: '周二', level: '提示', n: 74 },
  ];
  const heatSpec = { kind: 'heatmap', title: '等级 × 星期', x: 'day', value: 'n', series: 'level' };
  const heat = await chart({ spec: heatSpec, data: heatRows, name: 'probe_heatmap' });
  const heatSvg = readFileSync(resolve(DEV_ROOT, heat.value.svgSrc), 'utf8');
  if (!heatSvg.startsWith('<svg') || !heatSvg.includes('<path')) throw new Error('矩阵应当落一份有图形的 SVG');
  const heatBuilt = buildOption(heatRows, {
    kind: 'heatmap', title: null, sourceLabel: 'agent 自主填写', x: 'day', value: 'n', series: 'level',
    xType: null, xLabel: null, valueLabel: null, unit: null,
  });
  const heatCells = heatBuilt.option.series[0].data;
  // 4 个等级 × 2 天 = 8 个组合，数据里只有 7 个：缺的那格不画，也不补 0。
  if (heatCells.length !== 7) throw new Error(`矩阵应当只画有数据的格子（8 个组合里 7 个有数据，画了 ${heatCells.length} 个）`);
  // 颜色标尺：两端是数据里的最小 / 最大值，中间是一支连续色阶。
  const scale = heatBuilt.option.visualMap;
  if (scale.min !== 12 || scale.max !== 74) throw new Error(`颜色标尺的上下限应当是 12 与 74，收到 ${scale.min} / ${scale.max}`);
  if (!Array.isArray(scale.inRange.color) || scale.inRange.color.length < 3) {
    throw new Error('矩阵该有一条连续色阶，不是一组序列色板');
  }
  // 格子里的数字：深色格子配浅字、浅色格子配深字——中段两边都只有 3.5:1，取好的那一边。
  const labelColorOf = (value) => heatCells.find((cell) => Array.isArray(cell?.value) && cell.value[2] === value)?.label?.color;
  if (labelColorOf(74) !== '#ffffff') throw new Error(`最深那格的数字该用浅色，收到 ${labelColorOf(74)}`);
  if (labelColorOf(12) !== '#2a3540') throw new Error(`最浅那格的数字该用深色，收到 ${labelColorOf(12)}`);
  console.log(`  矩阵：8 个组合画了 ${heatCells.length} 格（缺格留白）· 色标 12–74`);

  // 最浅的那一格也要和"没数据留的白"分得开：真机上 21 个有数据的格子里有 13 个是 rgb(242,246,254)，
  // 与纯白只差 (13,9,1)——同一张图里还有 15 个空格，读者分不出哪些格子在说话。
  const wide = await chart({
    spec: { kind: 'heatmap', x: 'k', value: 'v', series: 's' },
    data: [
      { k: 'a', s: '甲', v: 1 }, { k: 'b', s: '甲', v: 100 },
      { k: 'a', s: '乙', v: 2 }, { k: 'b', s: '乙', v: 60 },
    ],
    name: 'probe_heatmap_light',
  });
  const wideSvg = readFileSync(resolve(DEV_ROOT, wide.value.svgSrc), 'utf8');
  const fills = [...wideSvg.matchAll(/fill="rgb\((\d+),(\d+),(\d+)\)"/g)]
    .map((match) => [Number(match[1]), Number(match[2]), Number(match[3])]);
  const lightest = fills.reduce((best, fill) => (Math.min(...fill) > Math.min(...best) ? fill : best), [0, 0, 0]);
  const gap = Math.max(...lightest.map((channel) => 255 - channel));
  if (gap < 20) {
    throw new Error(`矩阵最浅的一格与纯白只差 ${gap}（${lightest}）：有数据和没数据会分不开`);
  }
  console.log(`  矩阵最浅一格 ${lightest.join(',')}，与纯白差 ${gap}`);

  // 雷达：一圈指标轴，每个对象一条闭合折线，每个指标一根自己的量纲。
  const radarRows = [
    { metric: '可用率', device: '核心', v: 99 }, { metric: '时延', device: '核心', v: 12 },
    { metric: '端口占用', device: '核心', v: 71 },
    { metric: '可用率', device: '汇聚', v: 96 }, { metric: '时延', device: '汇聚', v: 31 },
    { metric: '端口占用', device: '汇聚', v: 88 },
  ];
  const radarSpec = { kind: 'radar', title: '两台设备', x: 'metric', value: 'v', series: 'device' };
  const radar = await chart({ spec: radarSpec, data: radarRows, name: 'probe_radar' });
  const radarSvg = readFileSync(resolve(DEV_ROOT, radar.value.svgSrc), 'utf8');
  if (!radarSvg.includes('核心') || !radarSvg.includes('汇聚')) throw new Error('雷达上的每个对象都该出现（图例）');
  const radarBuilt = buildOption(radarRows, {
    kind: 'radar', title: null, sourceLabel: 'agent 自主填写', x: 'metric', value: 'v', series: 'device',
    xType: null, xLabel: null, valueLabel: null, unit: null,
  });
  const peaks = radarBuilt.option.radar.indicator.map((entry) => entry.max);
  // 上限取 1/2/5 的整十倍数：时延最大 31 → 50，可用率最大 99 → 100。
  // 三个指标共用一根轴的话，时延会被压成贴着圆心的一道。
  if (JSON.stringify(peaks) !== '[100,50,100]') throw new Error(`每个指标该有自己的量纲，收到 ${JSON.stringify(peaks)}`);
  console.log(`  雷达：3 个指标各一根量纲 ${JSON.stringify(peaks)} · 2 个对象`);


  // 轴名里的单位不该拼两遍：agent 常把单位写进 valueLabel，同时又给 unit（真机反馈）。
  const dupUnit = await chart({
    spec: { kind: 'column', x: 'm', value: 'cpu', valueLabel: 'CPU 使用率 (%)', unit: '%' },
    data: comboRows,
    name: 'probe_unit_once',
  });
  const dupSvg = readFileSync(resolve(DEV_ROOT, dupUnit.value.svgSrc), 'utf8');
  if (!dupSvg.includes('CPU 使用率 (%)')) throw new Error('轴名应当保留 valueLabel');
  if (dupSvg.includes('(%)（%）') || dupSvg.includes('(%)(%)')) {
    throw new Error('valueLabel 里已带单位时不该再拼一次');
  }
  // 第二个度量同理：它的轴名走的也是同一条规则。
  const secondUnit = await chart({
    spec: { kind: 'column', x: 'm', value: 'cpu', second: { value: 'ports', label: '端口数 (个)', unit: '个' } },
    data: comboRows,
    name: 'probe_unit_second',
  });
  const secondSvg = readFileSync(resolve(DEV_ROOT, secondUnit.value.svgSrc), 'utf8');
  if (secondSvg.includes('(个)（个）') || secondSvg.includes('(个)(个)')) {
    throw new Error('第二个度量的轴名也不该重复单位');
  }
  console.log('  轴名去重：valueLabel 带单位时不再重复');

  // 纵向参考线：画在类别轴上。
  const vertical = await chart({
    spec: { kind: 'column', x: 'm', value: 'cpu', marks: [{ value: '3月', label: '变更窗口', axis: 'x' }] },
    data: comboRows,
    name: 'probe_marks_x',
  });
  const vertSvg = readFileSync(resolve(DEV_ROOT, vertical.value.svgSrc), 'utf8');
  if (!vertSvg.includes('变更窗口')) throw new Error('纵向参考线的标签应当画出来');
  console.log('  纵向参考线：标签在');

  // 通用表达开关：排序与配色。
  const styled = await chart({
    spec: { kind: 'bar', x: 'site', value: 'n', style: { sort: 'desc', labels: true, colors: ['#8a6ad0'] } },
    data: [{ site: '甲', n: 1 }, { site: '乙', n: 9 }, { site: '丙', n: 5 }],
    name: 'probe_style',
  });
  const styledSvg = readFileSync(resolve(DEV_ROOT, styled.value.svgSrc), 'utf8');
  console.log(`  表达开关（排序 + 标签 + 配色）：${styledSvg.includes('#8a6ad0') ? '配色生效' : '✗ 配色没生效'}`);
  if (!styledSvg.includes('#8a6ad0')) throw new Error('style.colors 应当覆盖色板');

  // markdown 子集的几个要点：白名单语法要渲染出来，子集之外的一律当文本。
  if (!reportHtml.includes('<ul>')) throw new Error('列表应当渲染成 ul');
  if (!reportHtml.includes('<blockquote>')) throw new Error('引用应当渲染成 blockquote');
  if (!reportHtml.includes('<table>')) throw new Error('表格应当渲染成 table');
  if (!reportHtml.includes('<hr>')) throw new Error('分隔线应当渲染成 hr');
  if (!reportHtml.includes('<strong>100</strong>')) throw new Error('加粗应当渲染成 strong');
  // 报告要能直接打印：打印样式里图与表不跨页、标题不落在页尾。
  if (!reportHtml.includes('@media print')) throw new Error('报告应当带打印样式');
  if (!/break-inside:\s*avoid/.test(reportHtml)) throw new Error('打印时图与表不应被分页截断');
  if (!reportHtml.includes('class="language-sql"')) throw new Error('非 chart 围栏应当渲染成代码块，并带上语言标注');
  // `<br>`、行尾两空格与行尾反斜杠都应当渲染成换行；软换行并成一行。
  if ((reportHtml.match(/<br>/g) ?? []).length < 3) throw new Error('三种硬换行都应当渲染成 br');
  if (!reportHtml.includes('第四行（软换行会并成一行）')) throw new Error('软换行应当并进同一段');
  if (!reportHtml.includes('&lt;script&gt;')) throw new Error('内嵌 HTML 应当被转义成文本，而不是解释成标签');
  if (/<script>alert/.test(reportHtml)) throw new Error('内嵌 HTML 绝不能穿透成真标签');
  if (!reportHtml.includes('&lt;span&gt;不该放行&lt;/span&gt;')) throw new Error('span 应当被转义成文本');
  if (reportHtml.includes('<span>不该放行')) throw new Error('只白名单 br，其它标签必须仍然转义');
  // 表格单元格里同样能换行——它走的是同一套行内渲染。
  if (!/<td>甲站 96 条<br>乙站 78 条<\/td>/.test(reportHtml)) {
    throw new Error('表格单元格里的 br 应当渲染成换行');
  }
  // 手打的表不带编号 chip、也不进展示项清单：它没有来源，就不该看起来像有来源。
  if ((reportHtml.match(/<table>/g) ?? []).length !== 1) throw new Error('这份报告里只有一张手打的表');
  if ((reportHtml.match(/class="table-block"/g) ?? []).length !== 0) {
    throw new Error('手打的表不该被当成有来源的展示项（不该有 table-block 包装与编号）');
  }

  // 展示件各有各的来路，报表不要求"同源"。这里验三件事：一张给定数据的图、一张查询结果的图、
  // 一张查询结果的**表**——表与图共用同一份查询，报表级节点表里那个查询只该有一个节点。
  const sharedView = await call('oks_view', {
    spec: { kind: 'table', src: saved.dataSrc, title: '查询结果的表' },
    name: 'probe_report_table',
  });
  const mixed = await call('oks_report', {
    spec: {
      title: '多来源报告（冒烟）',
      markdown: [
        '## 多来源',
        '',
        `![自填的那张](${tuned.value.svgSrc})`,
        '',
        `![查询结果的那张](${fromSrc.value.svgSrc})`,
        '',
        `![查询结果的表](${sharedView.value.viewSrc})`,
      ].join('\n'),
    },
    name: 'probe_report_mixed',
  });
  const mixedHtml = readFileSync(resolve(DEV_ROOT, mixed.value.htmlSrc), 'utf8');
  console.log(`  多来源报告：${mixed.value.figureCount} 张图，各自带着自己那份来源链`);
  // 辨识度：有来源的展示项戴编号 chip 并且可寻址；手打的表既没有编号、也没有锚点。
  if ((mixedHtml.match(/class="item-no"/g) ?? []).length !== 3) {
    throw new Error('每个有来源的展示项都该戴一枚编号 chip');
  }
  if ((mixedHtml.match(/id="oks-item-\d+"/g) ?? []).length !== 3) {
    throw new Error('每个展示项都要有可寻址的锚点（id="oks-item-N"）');
  }
  if (!/<span class="item-no">表 1<\/span>查询结果的表/.test(mixedHtml)) {
    throw new Error('表的编号应当是 chip 化的「表 1」');
  }
  if (/来源：agent 自主填写|来源：基于查询结果/.test(mixedHtml)) {
    throw new Error('图内来源脚注已经取消');
  }
  const mixedProvenance = readReportProvenance(mixedHtml);
  if (mixedProvenance === null) throw new Error('报告里应当有一份报表级来源结构');
  if (JSON.stringify(mixedProvenance.data.items.map((item) => item.kind)) !== JSON.stringify(['chart', 'chart', 'table'])) {
    throw new Error(`展示项清单不对：${JSON.stringify(mixedProvenance.data.items.map((item) => item.kind))}`);
  }
  if ((mixedHtml.match(/<table>/g) ?? []).length !== 1) throw new Error('表应当内联成真 <table>');
  // 表与图共用同一份查询：报表级节点表里那个查询只该有一个节点（共享祖先只存一份）。
  const queryNodes = Object.values(mixedProvenance.origin.nodes).filter((node) => node.kind === 'query');
  console.log(`  报表级来源结构：${Object.keys(mixedProvenance.origin.nodes).length} 个节点 · 查询 ${queryNodes.length} 个`);
  if (queryNodes.length !== 1) throw new Error(`共用同一份查询时只该有一个查询节点，收到 ${queryNodes.length}`);
  if (mixedProvenance.data.items[2]?.root !== mixedProvenance.data.items[1]?.root) {
    throw new Error('表与图引用的同一份查询应当是同一个根节点');
  }
  if (JSON.stringify(mixedProvenance.data.items[2]?.data) !== JSON.stringify(mixedProvenance.data.items[1]?.data)) {
    throw new Error('展示项里该带着各自实际展示的数据');
  }
  // 报表整体的 origin 是**一个**：根是"组装这份报告"那个节点，各展示项的根是它的 inputs。
  ok('报表的来源是一个：根是组装节点，inputs 指向各展示项',
    mixedProvenance.origin.nodes[mixedProvenance.origin.root]?.kind === 'report'
    && Object.values(mixedProvenance.origin.nodes[mixedProvenance.origin.root]?.inputs ?? {}).length === 3);
  // data 与 origin 分家：骨架与展示数据在 data 里，节点表在 origin 里。
  ok('报表的 data 是 { chapters, plainTables, items }，没有节点表',
    Array.isArray(mixedProvenance.data.chapters) && mixedProvenance.data.plainTables === 0
    && mixedProvenance.data.chapters.length === 1
    && mixedProvenance.data.chapters[0].figures.length === 2
    && mixedProvenance.data.chapters[0].tables.length === 1
    && mixedProvenance.data.nodes === undefined && mixedProvenance.data.version === undefined);
  if (mixedHtml.includes('dsh-oks-chart-input')) {
    throw new Error('图自带的材料应当搬进报表级结构，而不是在内联的那份里重复一遍');
  }
  if ((mixedHtml.match(/data-oks-item="/g) ?? []).length !== 3) {
    throw new Error('每个展示项都要有 data-oks-item 把画面与展示项对上');
  }


  // 报告里的展示件只有一种来源：工作区里**已经物化**的那一份（图或表），两种写法都认
  // （带材料目录前缀、或只给裸名）。编号按正文出现顺序给；`chart` 围栏块已经不接受。
  // 取不到材料是另一条路：整份报告失败（见下面那段），不在原处留说明。
  {
    const drawn = await chart({
      spec: { kind: 'bar', x: 'label', value: 'value', title: '被引用的图' },
      data: [{ label: '甲', value: 3 }, { label: '乙', value: 5 }],
      name: 'probe_report_ref',
    });
    const refPath = drawn.value.svgSrc;                       // .oks/charts/<...>.chart.svg
    const bare = refPath.replace('.oks/charts/', '');             // 图就住在 .oks/charts/ 里，裸名同样自然
    // 再画一张，用来充当"报告里的第一张图"。
    const extra = await chart({
      spec: { kind: 'bar', x: 'label', value: 'value', title: '第一张' },
      data: [{ label: '甲', value: 2 }],
      name: 'probe_report_ref_first',
    });
    const fence = (label) => ['```chart', JSON.stringify({
      kind: 'bar', x: 'label', value: 'value', data: [{ label, value: 2 }], caption: `${label}图`,
    }), '```'].join('\n');
    const ref = await call('oks_report', {
      spec: {
        title: '引用图（冒烟）',
        markdown: [
          '## 一、引用的第一张',
          '',
          `![第一张](${extra.value.svgSrc})`,
          '',
          '## 二、引用已落盘的',
          '',
          `![引用带前缀](${refPath})`,
          '',
          `![引用裸名](${bare})`,
          '',
          '## 三、再引一张，编号要接着走',
          '',
          `![第四张](${tuned.value.svgSrc})`,
          '',
          '## 四、chart 块已经不接受',
          '',
          fence('老的写法'),
        ].join('\n'),
      },
      name: 'probe_report_ref',
    });
    const refHtml = readFileSync(resolve(DEV_ROOT, ref.value.htmlSrc), 'utf8');
    const inline = (refHtml.match(/<svg class="chart"/g) ?? []).length;
    const captions = [...refHtml.matchAll(/<figcaption><span class="item-no">图 (\d+)<\/span>([^<]*)<\/figcaption>/g)]
      .map((m) => `${m[1]}:${m[2]}`);
    console.log(`  引用图：内联 ${inline} 张 · 图注 ${captions.join(' ')} · figureCount=${ref.value.figureCount}`);
    if (inline !== 4) throw new Error(`四张图都该内联成 <svg class="chart">，收到 ${inline}`);
    if (JSON.stringify(captions) !== JSON.stringify(['1:第一张', '2:引用带前缀', '3:引用裸名', '4:第四张'])) {
      throw new Error(`编号应当按正文出现顺序走（取不到的图不占号），实际 ${JSON.stringify(captions)}`);
    }
    if (ref.value.figureCount !== 4) throw new Error(`回执的图数应当只数画出来的，收到 ${ref.value.figureCount}`);
    // chart 块已经不接受：说明要指回去（先画一次、再把那一行放进正文），而不是静默变成代码块。
    const errors = [...refHtml.matchAll(/<div class="figure-error">([^<]*)<\/div>/g)].map((m) => m[1]);
    if (errors.length !== 1) throw new Error(`chart 块该留一段说明，收到 ${errors.length} 段`);
    if (!errors[0].includes('oks_chart')) {
      throw new Error(`chart 块被拒时应当指路：${JSON.stringify(errors)}`);
    }
    // 取不到的展示件：**整份报告失败**，错误里要点出是哪一行引用、正确写法是什么。
    for (const broken of ['nope.chart.svg', 'nope.table.md', '../oks.json']) {
      let failure = '';
      try {
        await call('oks_report', {
          spec: { title: '取不到材料', markdown: `正文\n\n![取不到](${broken})\n` },
          name: 'probe_report_broken',
        });
      } catch (cause) {
        failure = String(cause?.message ?? cause);
      }
      console.log(`  引用 ${broken} → ${failure.slice(0, 96)}`);
      if (!/取不到/.test(failure)) throw new Error(`取不到材料要整份失败并说清是哪一行：${broken} → ${failure}`);
    }
    if (refHtml.includes('language-chart')) throw new Error('chart 块不该退化成普通代码块');
    // 说明块里会带着"正确写法"的例子（那本身就是图片语法），所以只在正文里查残留。
    const prose = refHtml.replace(/<div class="figure-error">[\s\S]*?<\/div>/g, '');
    if (/!\[[^\]]*\]\(/.test(prose)) throw new Error('图片语法不该以字面文本出现在正文里');
    if (refHtml.includes('evil.chart.svg</svg>')) throw new Error('越界的引用不该被读进来');
  }

  // 规格与图的校验：这些都要在画图之前被拒。
  // 分组柱 vs 堆叠柱：真机上报回来的问题——不给 stack 时柱子变成多段的一根（永远堆叠）。
  // 原来这里只断言"有图形"，而那种断言抓不到它：堆叠也是一个 <path>。所以要断言几何关系。
  const groupRows = [
    { q: 'Q1', c: '线上', v: 320 }, { q: 'Q1', c: '门店', v: 180 }, { q: 'Q1', c: '政企', v: 90 },
    { q: 'Q2', c: '线上', v: 360 }, { q: 'Q2', c: '门店', v: 175 }, { q: 'Q2', c: '政企', v: 120 },
  ];
  // 柱子是 d="M<x> <y>l<宽> 0l0 <高>l-<宽> 0Z"：竖柱看 x 与底边 y，横条看 y 与厚度。
  const barsOf = (svg) => [...svg.matchAll(/<path\b[^>]*>/g)].flatMap((match) => {
    const d = /d="M([\d.]+) ([\d.]+)l([\d.]+) 0l0 (-?[\d.]+)l-/.exec(match[0]);
    const fill = /fill="(#[0-9a-f]{6})"/.exec(match[0]);
    return d === null || fill === null ? [] : [{ x: Number(d[1]), y: Number(d[2]), w: Number(d[3]), h: Number(d[4]) }];
  });
  const barSpread = (values) => Math.max(...values) - Math.min(...values);
  const columnSpec = { kind: 'column', x: 'q', value: 'v', series: 'c' };
  const grouped = await chart({ spec: columnSpec, data: groupRows, name: 'probe_grouped' });
  const stacked = await chart({ spec: { ...columnSpec, stack: 'total' }, data: groupRows, name: 'probe_stacked' });
  const groupedBars = barsOf(readFileSync(resolve(DEV_ROOT, grouped.value.svgSrc), 'utf8'));
  const stackedBars = barsOf(readFileSync(resolve(DEV_ROOT, stacked.value.svgSrc), 'utf8'));
  const distinctX = (bars) => [...new Set(bars.map((bar) => bar.x))];
  // 并排：6 根柱子各占一个 x，而且都踩在同一条基线上。
  if (groupedBars.length !== 6 || distinctX(groupedBars).length !== 6 || barSpread(groupedBars.map((bar) => bar.y)) > 1) {
    throw new Error(`不给 stack 时柱子应当并排（各占一个 x、同一条基线），实际 ${JSON.stringify(groupedBars)}`);
  }
  // 堆叠：一个类别一个 x（2 个类别 2 个位置），同一个 x 上垒着三段、底边各不相同。
  const stackedX = distinctX(stackedBars);
  const legs = stackedBars.filter((bar) => bar.x === stackedX[0]).map((bar) => bar.y);
  if (stackedX.length !== 2 || legs.length !== 3 || barSpread(legs) < 10) {
    throw new Error(`stack: total 时柱子应当垒起来（同一个 x、三段不同的底），实际 ${JSON.stringify(stackedBars)}`);
  }
  // 同一个默认值不落在别的图元上：area 不给 stack 是叠着画、line 从来不分段。
  const stackOf = (kind, spec) => buildOption(groupRows, {
    kind, title: null, sourceLabel: 'agent 自主填写', x: 'q', value: 'v', series: 'c',
    xType: null, xLabel: null, valueLabel: null, unit: null, ...spec,
  }).option.series.map((item) => item.stack ?? null);
  if (JSON.stringify(stackOf('area', {})) !== '[null,null,null]') throw new Error('area 不给 stack 时不该堆叠');
  if (JSON.stringify(stackOf('line', {})) !== '[null,null,null]') throw new Error('line 没有堆叠这个说法');
  console.log('  分组柱 vs 堆叠柱：并排与垒起各就各位');

  // 横条图 + series：横向的分组条。它原来按"类别数"算高度，一个类别三条时每根只有 5px 高。
  const groupedBar = await chart({
    spec: { kind: 'bar', x: 'q', value: 'v', series: 'c' },
    data: groupRows,
    name: 'probe_bar_grouped',
  });
  const barBars = barsOf(readFileSync(resolve(DEV_ROOT, groupedBar.value.svgSrc), 'utf8'));
  if (barBars.length !== 6) throw new Error(`横条分组应当是 6 条，收到 ${barBars.length}`);
  if (new Set(barBars.map((bar) => bar.y)).size !== 6) throw new Error('横条分组应当是 6 条各自一个 y');
  if (Math.min(...barBars.map((bar) => Math.abs(bar.h))) < 12) {
    throw new Error(`分组横条的厚度应当够读（≥12px），实际 ${Math.min(...barBars.map((bar) => Math.abs(bar.h)))}px`);
  }
  console.log(`  分组横条：6 条各自 ${Math.abs(barBars[0].h).toFixed(1)}px 厚`);

  // 折线的数值轴跟着数据收紧（柱与面积仍然从 0 起）。真机报告里的图 9/图 10 是这事的第一现场：
  // 可用率 98.4–99.9% 落在 0–100 的轴上，三条线的全部差距只有 3px，图注说的"一起下沉"根本看不见。
  const kpiRows = ['1月', '2月', '3月'].flatMap((month, index) => [
    { month, device: '甲', v: [99.8, 99.4, 99.9][index] },
    { month, device: '乙', v: [99.6, 98.41, 99.9][index] },
  ]);
  const axisTicksOf = (svg) => [...svg.matchAll(/<text[^>]*>([^<]{1,12})<\/text>/g)]
    .map((match) => match[1].trim()).filter((text) => /^-?[\d.]+$/.test(text)).map(Number);
  const lineSpec = { kind: 'line', x: 'month', value: 'v', series: 'device', unit: '%' };
  const kpiLine = await chart({ spec: lineSpec, data: kpiRows, name: 'probe_line_kpi' });
  const lineTicks = axisTicksOf(readFileSync(resolve(DEV_ROOT, kpiLine.value.svgSrc), 'utf8'));
  if (Math.min(...lineTicks) < 90) {
    throw new Error(`折线的数值轴应当贴住数据（98.4% 起），实际最低刻度 ${Math.min(...lineTicks)}`);
  }
  // 面积与柱不从 0 起会说谎（长度/面积本身就是量），所以它们照旧。
  const kpiArea = await chart({ spec: { ...lineSpec, kind: 'area' }, data: kpiRows, name: 'probe_area_kpi' });
  const areaTicks = axisTicksOf(readFileSync(resolve(DEV_ROOT, kpiArea.value.svgSrc), 'utf8'));
  if (Math.min(...areaTicks) !== 0) throw new Error(`面积的数值轴应当从 0 起，实际最低刻度 ${Math.min(...areaTicks)}`);
  // 轴收紧之后，比数据还低的参考线不能像上一波那样静默消失。
  const marked = await chart({
    spec: { ...lineSpec, marks: [{ value: 98, label: '可用率下限' }] },
    data: kpiRows,
    name: 'probe_line_mark_low',
  });
  const markedSvg = readFileSync(resolve(DEV_ROOT, marked.value.svgSrc), 'utf8');
  if (!markedSvg.includes('可用率下限')) throw new Error('低于数据的参考线也该画出来（轴要为它让出下界）');
  console.log(`  折线轴收紧：线图最低刻度 ${Math.min(...lineTicks)} · 面积图 ${Math.min(...areaTicks)} · 轴外阈值线仍在`);

  // 竖着排的类别轴自上而下：横条图的"第一名"在最上面，矩阵的第一行在最上面。
  // 横条原来是从下往上（Top-N 排名得反着读），矩阵的行也一样——而我们还把数值写进格子里、
  // 说它"同时就是一张表"。表格不会从最后一行开始读。
  const rankRows = [{ k: '第一项', v: 100 }, { k: '第二项', v: 60 }, { k: '第三项', v: 20 }];
  const rankBars = async (kind, name) => barsOf(readFileSync(resolve(DEV_ROOT, (await chart({
    spec: { kind, x: 'k', value: 'v' },
    data: rankRows,
    name,
  })).value.svgSrc), 'utf8'));
  const horizontalBars = (await rankBars('bar', 'probe_bar_rank')).sort((a, b) => b.w - a.w);
  if (!(horizontalBars[0].y < horizontalBars[horizontalBars.length - 1].y)) {
    throw new Error(`横条最长的那根（第一名）应当在最上面，实际 y=${horizontalBars[0].y} 与 ${horizontalBars[2].y}`);
  }
  // 竖柱照旧从左往右：这条规则只落在"竖着排的类别轴"上。
  const verticalBars = await rankBars('column', 'probe_column_rank');
  if (!(verticalBars[0].x < verticalBars[verticalBars.length - 1].x)) {
    throw new Error('竖柱的第一项应当仍在最左边');
  }
  const matrixRows = await chart({
    spec: { kind: 'heatmap', x: 'k', value: 'v', series: 's' },
    data: rankRows.flatMap((row, index) => [{ ...row, s: '甲' }, { ...row, s: '乙', v: 3 - index }]),
    name: 'probe_heatmap_rows',
  });
  const matrixSvg = readFileSync(resolve(DEV_ROOT, matrixRows.value.svgSrc), 'utf8');
  const labelY = (svg, text) => {
    for (const match of svg.matchAll(/<text[^>]*transform="translate\(([\d.]+) ([\d.]+)\)"[^>]*>([\s\S]*?)<\/text>/g)) {
      if (match[3].includes(text)) return Number(match[2]);
    }
    return null;
  };
  const firstRow = labelY(matrixSvg, '甲');
  const secondRow = labelY(matrixSvg, '乙');
  if (!(firstRow !== null && secondRow !== null && firstRow < secondRow)) {
    throw new Error(`矩阵的第一行应当在最上面，实际甲 y=${firstRow}、乙 y=${secondRow}`);
  }
  console.log(`  竖着排的类别轴：横条第一名 y=${horizontalBars[0].y}（最上）· 矩阵第一行 y=${firstRow}`);

  // 图元专属开关的适用表只有一份（shared.ts）。把"开关 × 图元"逐个真跑一遍：
  // 表里写支持的必须收下，不支持的必须按表报错。表改了而校验没跟上，这里当场露馅；
  // 报错文案也必须是"spec.<开关>"这一条，免得它其实是因为别的原因被拒、看起来却像通过了。
  const minimalSpec: Record<string, Record<string, unknown>> = {
    bar: { x: 'k', value: 'w' },
    line: { x: 'k', value: 'w' },
    column: { x: 'k', value: 'w' },
    pie: { x: 'k', value: 'w' },
    area: { x: 'k', value: 'w' },
    scatter: { x: 'w', value: 'w' },
    histogram: { value: 'w' },
    box: { x: 'k', value: 'w' },
    heatmap: { x: 'k', value: 'w', series: 's' },
    radar: { x: 'k', value: 'w', series: 's' },
  };
  const switchValue: Record<string, unknown> = {
    stack: 'total', size: 'w', bins: 4, second: { value: 'w' }, marks: [{ value: 1 }],
  };
  // 一份能让所有图元都过关的数据：两个分组 × 三个类别（雷达因此有 3 个指标且没有缺口）。
  const gridRows = ['a', 'b', 'c'].flatMap((k, i) => ['p', 'q'].map((s, j) => ({ k, s, w: i + j + 1 })));
  let checked = 0;
  for (const feature of Object.keys(switchValue)) {
    for (const kind of CHART_KINDS) {
      const expected = supports(kind, feature);
      let message = '';
      let accepted = true;
      try {
        await chart({
          spec: { kind, ...minimalSpec[kind], [feature]: switchValue[feature] },
          data: gridRows,
        });
      } catch (cause) { accepted = false; message = String(cause?.message ?? cause); }
      if (accepted !== expected) {
        throw new Error(`${kind} + ${feature}：表里写${expected ? '支持' : '不支持'}，实际${accepted ? '收下了' : '被拒了'}（${message.slice(0, 60)}）`);
      }
      if (!expected && !message.includes(`spec.${feature}`)) {
        throw new Error(`${kind} + ${feature}：被拒的理由不是这个开关，而是 ${message.slice(0, 60)}`);
      }
      checked += 1;
    }
  }
  console.log(`  开关适用表：${Object.keys(switchValue).length} 个开关 × ${CHART_KINDS.length} 种图元 = ${checked} 组，逐一核对`);

  const failures = [
    ['两个都缺', { spec: { kind: 'bar', x: 'a', value: 'b' } }],
    ['两个都给', { spec: { kind: 'bar', x: 'a', value: 'b' }, src: saved.dataSrc, data: [{}] }],
    ['未知 kind', { spec: { kind: 'pie' }, data: [{}] }],
    ['table 退场', { spec: { kind: 'table' }, data: [{}] }],
    ['列不存在', { spec: { kind: 'bar', x: 'nope', value: 'nope2' }, data: [{ a: 1 }] }],
    ['bar 缺 value', { spec: { kind: 'bar', x: 'label' }, data: [{ label: 'A' }] }],
    ['pie 缺 value', { spec: { kind: 'pie', x: 'label' }, data: [{ label: 'A' }] }],
    ['layout 越界', { spec: { kind: 'bar', x: 'label', value: 'value', layout: { labelFont: 4 } }, data: [{ label: 'A', value: 1 }] }],
    ['layout 写错项', { spec: { kind: 'bar', x: 'label', value: 'value', layout: { nope: 1 } }, data: [{ label: 'A', value: 1 }] }],
    ['图表名越界', { spec: { kind: 'bar', x: 'label', value: 'value' }, data: [{ label: 'A', value: 1 }], name: '../evil' }],
    // 名字是标识不是标题：大小写、连字符、点、空格、中文都进不了文件名
    //（收得这么紧，`-` 与 `.` 才能当无歧义的分隔符）。
    ['名字带大写', { spec: { kind: 'bar', x: 'label', value: 'value' }, data: [{ label: 'A', value: 1 }], name: 'Probe' }],
    ['名字带连字符', { spec: { kind: 'bar', x: 'label', value: 'value' }, data: [{ label: 'A', value: 1 }], name: 'probe-a' }],
    ['名字是中文', { spec: { kind: 'bar', x: 'label', value: 'value' }, data: [{ label: 'A', value: 1 }], name: '告警分布' }],
    // 图元专属字段填给别的图元要报错，不静默忽略。
    ['stack 填给 bar', { spec: { kind: 'bar', x: 'label', value: 'value', stack: 'total' }, data: [{ label: 'A', value: 1 }] }],
    ['size 填给 column', { spec: { kind: 'column', x: 'label', series: 's', value: 'value', size: 'n' }, data: [{ label: 'A', s: 'x', value: 1 }] }],
    ['stack 取值非法', { spec: { kind: 'column', x: 'label', series: 's', value: 'value', stack: 'nope' }, data: [{ label: 'A', s: 'x', value: 1 }] }],
    ['style.sort 非法', { spec: { kind: 'bar', x: 'label', value: 'value', style: { sort: 'nope' } }, data: [{ label: 'A', value: 1 }] }],
    ['style.colors 非法', { spec: { kind: 'bar', x: 'label', value: 'value', style: { colors: ['red'] } }, data: [{ label: 'A', value: 1 }] }],
    ['scatter 缺 value', { spec: { kind: 'scatter', x: 'a' }, data: [{ a: 1 }] }],
    ['histogram 缺 value', { spec: { kind: 'histogram' }, data: [{ a: 1 }] }],
    ['box 缺 x', { spec: { kind: 'box', value: 'v' }, data: [{ v: 1 }] }],
    ['bins 填给 column', { spec: { kind: 'column', x: 'label', value: 'value', bins: 5 }, data: [{ label: 'A', value: 1 }] }],
    ['bins 越界', { spec: { kind: 'histogram', value: 'value', bins: 999 }, data: [{ value: 1 }] }],
    ['heatmap 缺 series', { spec: { kind: 'heatmap', x: 'day', value: 'n' }, data: [{ day: 'a', n: 1 }] }],
    ['radar 缺 series', { spec: { kind: 'radar', x: 'm', value: 'v' }, data: [{ m: 'a', v: 1 }] }],
    ['radar 指标不足 3', { spec: { kind: 'radar', x: 'm', value: 'v', series: 's' }, data: [{ m: 'a', s: 'x', v: 1 }, { m: 'b', s: 'x', v: 2 }] }],
    // 雷达没有"留白"这个选项：缺的顶点 echarts 会画在圆心，看起来就是"这一维是 0"。
    ['radar 有缺口', {
      spec: { kind: 'radar', x: 'm', value: 'v', series: 's' },
      data: [{ m: 'a', s: 'x', v: 1 }, { m: 'b', s: 'x', v: 2 }, { m: 'c', s: 'x', v: 3 }, { m: 'a', s: 'y', v: 4 }, { m: 'b', s: 'y', v: 5 }],
    }],
    ['second 填给 pie', { spec: { kind: 'pie', x: 'label', value: 'value', second: { value: 'n' } }, data: [{ label: 'A', value: 1, n: 2 }] }],
    ['second 缺 value', { spec: { kind: 'column', x: 'label', series: 's', value: 'value', second: { label: 'x' } }, data: [{ label: 'A', s: 'p', value: 1 }] }],
    ['second.kind 非 line', { spec: { kind: 'column', x: 'label', series: 's', value: 'value', second: { value: 'n', kind: 'bar' } }, data: [{ label: 'A', s: 'p', value: 1, n: 2 }] }],
    ['marks 填给 scatter', { spec: { kind: 'scatter', x: 'a', value: 'b', marks: [{ value: 1 }] }, data: [{ a: 1, b: 2 }] }],
    ['marks.axis 非法', { spec: { kind: 'bar', x: 'label', value: 'value', marks: [{ value: 1, axis: 'z' }] }, data: [{ label: 'A', value: 1 }] }],
    ['marks.value 类型非法', { spec: { kind: 'bar', x: 'label', value: 'value', marks: [{ value: true }] }, data: [{ label: 'A', value: 1 }] }],
    ['second 指向不存在的列', { spec: { kind: 'column', x: 'label', series: 's', value: 'value', second: { value: 'nope' } }, data: [{ label: 'A', s: 'p', value: 1 }] }],
  ];
  for (const [label, args] of failures) {
    let rejected = false;
    let message = '';
    try { await chart( args); } catch (cause) { rejected = true; message = String(cause?.message ?? cause); }
    console.log(`  ${String(label).padEnd(10)} → ${rejected ? '✓ 被拒' : '✗ 未拒'} ${message.slice(0, 64)}`);
    if (!rejected) throw new Error(`oks_chart ${label} 应当被拒`);
  }
  const empty = await chart({ spec: { kind: 'bar', x: 'label', value: 'value' }, data: [] });
  console.log(`  空数组有效: ${empty.value.ok === true && empty.value.rowCount === 0 ? '✓' : '✗'}`);
  if (empty.value.ok !== true) throw new Error('空数组应当是有效输入');
}

// ── limit 必填、范围 1..100：插件在调用服务之前就判定 ────────────────────────
// ── 展示件：表格落成 markdown 文件（流里与报表里都能渲染），材料藏在文件头 ──────────
console.log('=== oks_view（表格展示件）===');
{
  const answer = await call('oks_query', { intents: await withKeys(countNamed) });
  const first = (answer.value.results ?? [])[0] ?? null;
  const rowsSrc = first?.dataSrc;
  const rowsTotal = first?.rowCount ?? 0;
  const column = first?.columns?.[0]?.name;

  const view = await call('oks_view', {
    spec: { kind: 'table', src: rowsSrc, title: '汇总表' },
    name: 'summary_table',
  });
  console.log(view.text.split('\n').filter(Boolean).map((line) => `  ${line}`).join('\n').slice(0, 640));
  ok('表格落成 .oks/views/ 下的 markdown 文件，回执给报表用的那一行',
    view.value.viewSrc?.startsWith('.oks/views/') === true && view.value.viewSrc?.endsWith('.table.md') === true
    && view.value.markdown === `![汇总表](${view.value.viewSrc})`);
  ok('回执同时给可粘贴的 markdown 表本体（流里直接显示）',
    typeof view.value.table === 'string' && view.value.table.includes(`| ${column} |`)
    && view.value.table.split('\n').length === rowsTotal + 3);
  ok('数字列右对齐（markdown 的 ---: 两处都认）',
    (view.value.table.split('\n')[1] ?? '').includes('---:'));

  const viewFile = readFileSync(resolve(DEV_ROOT, view.value.viewSrc), 'utf8');
  const parsedView = readTableView(viewFile);
  const sourceRoot = JSON.parse(readFileSync(resolve(DEV_ROOT, rowsSrc), 'utf8')).origin.root;
  ok('文件头藏着材料：自述、来源链、展示数据与规格',
    parsedView !== null && parsedView.material.origin.root === sourceRoot
    && parsedView.material.meta.kind === 'table' && parsedView.material.meta.title === '汇总表'
    && Array.isArray(parsedView.material.data.rows) && parsedView.material.data.rows.length === rowsTotal
    && parsedView.material.data.spec.kind === 'table'
    && parsedView.material.data.spec.title === '汇总表');
  ok('文件本体就是一段 markdown 表（工作区里直接打开也读得懂）',
    viewFile.startsWith('<!-- dsh-oks-table-input ') && parsedView?.markdown.startsWith('| ') === true);

  // 材料是**复制**：数据文件被回收之后，表仍说得清自己展示的是什么
  rmSync(resolve(DEV_ROOT, rowsSrc), { force: true });
  const orphanView = readTableView(readFileSync(resolve(DEV_ROOT, view.value.viewSrc), 'utf8'));
  ok('数据文件被回收后，表里仍带着自己展示的那些行',
    orphanView?.material.data.rows.length === rowsTotal
    && orphanView.material.origin.nodes[orphanView.material.origin.root] !== undefined);

  // 明确回执：空数据、超列数、缺列、不支持的 kind 都在工具里挡住
  const failureOfView = async (spec, name = 'probe_bad_view') => {
    try {
      await call('oks_view', { spec, name });
      return '';
    } catch (cause) {
      return String(cause?.message ?? cause);
    }
  };
  const empty = await call('create_data', { name: 'empty_rows', motivation: '冒烟：空数据', data: [] });
  const emptyMessage = await failureOfView({ kind: 'table', src: empty.value.dataSrc });
  console.log(`  空表 → ${emptyMessage.slice(0, 80)}`);
  ok('空数据明确报错（空表不落盘）', /没有行/.test(emptyMessage));
  const wideRows = Array.from({ length: 2 }, () => Object.fromEntries(
    Array.from({ length: 14 }, (_, i) => [`c${i}`, i]),
  ));
  const wide = await call('create_data', { name: 'wide_rows', motivation: '冒烟：列太多', data: wideRows });
  ok('列数超上限时报错并指出用 spec.columns 选列',
    /最多 12 列/.test(await failureOfView({ kind: 'table', src: wide.value.dataSrc })));
  const chosen = await failureOfView({ kind: 'table', src: wide.value.dataSrc, columns: ['nope'] });
  ok('要展示的列不在数据里时报错', /不在数据里/.test(chosen));
  ok('不支持的展示件明确报错', /不支持的展示件/.test(await failureOfView({ kind: 'chart', src: wide.value.dataSrc })));

  // 纯函数那一层：转义、截断与列选择
  const messy = tableMarkdown(
    [{ name: '一|二', n: 1, big: 1234567 }, { name: 'A\nB', n: 2, big: 3 }],
    {},
  );
  ok('单元格里的竖线与换行被挡住（表不会因此断列）',
    'error' in messy === false && messy.markdown.includes('一\\|二') && messy.markdown.includes('A B'));
  const truncated = tableMarkdown([{ long: 'x'.repeat(200) }], {});
  ok('超长单元格截断并留 …（完整值在来源块的 data 里）',
    'error' in truncated === false && truncated.markdown.includes('…'));
  const picked = tableMarkdown([{ a: 1, b: 'x' }], { columns: ['b'] });
  ok('spec.columns 决定展示哪几列与顺序', 'error' in picked === false && picked.columns.join() === 'b');

  for (const made of [empty, wide]) rmSync(resolve(DEV_ROOT, made.value.dataSrc), { force: true });
}

console.log('=== Intent 的 limit 必填且限于 1..100 ===');
{
  const base = { op: 'Graph', root: 'x', nodes: [{ id: 'x', entity: member.id }], edges: [], select: [] };
  const cases = [
    ['缺失', { ...base }],
    ['null', { ...base, limit: null }],
    ['非整数', { ...base, limit: 1.5 }],
    ['0', { ...base, limit: 0 }],
    ['101', { ...base, limit: 101 }],
  ];
  for (const [label, intent] of cases) {
    const answer = await call('oks_check_intent', { intents: { x: intent } });
    const message = (answer.value.diagnostics ?? [])[0]?.diagnostic?.message ?? '';
    const rejected = /limit/.test(message);
    console.log(`  ${String(label).padEnd(6)} → ${rejected ? '✓ 被拒' : '✗ 未拒'} ${message.slice(0, 76)}`);
    if (!rejected) throw new Error(`limit ${label} 应当被拒`);
  }
}

// ── 第二个工作区：model 与 dataFile 都相对 oks.json 解析 ─────────────────
console.log('=== 第二个工作区（嵌套目录，路径都相对 oks.json）===');
{
  mkdirSync(`${SCRATCH}/nested`, { recursive: true });
  const anchor = JSON.parse(readFileSync(`${DEV_ROOT}/oks.json`, 'utf8'));
  const nested = `${SCRATCH}/nested`;
  const entry = {
    version: 1,
    domain: anchor.domain,
    model: relative(nested, resolve(DEV_ROOT, anchor.model)),
  };
  if (typeof anchor.dataFile === 'string') entry.dataFile = relative(nested, resolve(DEV_ROOT, anchor.dataFile));
  writeFileSync(`${nested}/oks.json`, `${JSON.stringify(entry, null, 2)}\n`);
  const nestedAnswer = await call('oks_query', { intents: await withKeys(countNamed, nested) }, nested);
  const first = nestedAnswer.value.results?.[0] ?? null;
  console.log(`  相对路径解析 → ${first === null ? '✗ 无结果' : `行数 ${first.rowCount} ✓`}`);
  if (first === null || first.status !== 'saved') throw new Error('嵌套工作区的相对路径没有解析对');
}

// ── 第三个工作区：没有 dataFile → 查询报错，校验照常 ────────────────────────
console.log('=== 没有 dataFile 的工作区（只能校验）===');
{
  mkdirSync(`${SCRATCH}/no-data`, { recursive: true });
  const anchor = JSON.parse(readFileSync(`${DEV_ROOT}/oks.json`, 'utf8'));
  const dir = `${SCRATCH}/no-data`;
  writeFileSync(`${dir}/oks.json`, `${JSON.stringify({
    version: 1, domain: anchor.domain, model: relative(dir, resolve(DEV_ROOT, anchor.model)),
  }, null, 2)}\n`);
  try {
    await call('oks_query', { intents: await withKeys(countNamed, dir) }, dir);
    console.log('  ✗ 没有 dataFile 却查成功了');
    throw new Error('没有 dataFile 时 oks_query 应当报错');
  } catch (cause) {
    if (!/没有声明 dataFile/.test(String(cause?.message ?? cause))) throw cause;
    console.log(`  ✓ oks_query 拒绝: ${String(cause.message).split('\n')[0].slice(0, 110)}`);
  }
  const checked = await call('oks_check_intent', { intents: countNamed }, dir);
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
    model: relative(dir, resolve(DEV_ROOT, anchor.model)),
    dataFile: 'junk.txt',
  }, null, 2)}\n`);
  const failed = await call('oks_query', { intents: await withKeys(countNamed, dir) }, dir);
  const first = failed.value.results?.[0] ?? null;
  console.log(`  ${String(first?.error ?? '(没有错误)').slice(0, 120)}`);
  console.log(`  渲染里写明执行失败: ${/status:\s+query_error/.test(failed.text) ? '✓' : '✗'}`);
  if (!/status:\s+query_error/.test(failed.text)) throw new Error('坏数据文件必须在结果里写明');
  if (first?.dataSrc !== null) throw new Error('执行失败不应留下 dataSrc');
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
    version: 1, domain: 'ic', model: 'empty.wasm',
  }, null, 2)}\n`);
  try {
    await call('oks_info', { key: 'index' }, empty);
    console.log('  ✗ 本该报错，却成功了');
  } catch (cause) {
    console.log(`  ✓ 拒绝: ${String(cause?.message ?? cause).split('\n')[0].slice(0, 140)}`);
  }
}

// ── 插件只写工作区的 artifacts/（交付物）与 .oks/（状态与内部材料），别处不碰 ──────
console.log('=== 插件只写 artifacts/ 与 .oks/ ===');
{
  const after = workspaceListing();
  const before = new Set(listingBefore.split(',').filter(Boolean));
  const added = after.split(',').filter(Boolean).filter((name) => !before.has(name));
  console.log(`  顶层新增条目：${added.join(', ') || '(无)'}`);
  const allowed = ['artifacts', '.oks'];
  if (added.some((name) => !allowed.includes(name))) throw new Error(`插件创建了 ${allowed.join(' / ')} 之外的东西：${added.join(', ')}`);
  // 状态目录里只有状态库：没有计划文件，也没有缓存出来的产物。
  const stateFiles = existsSync(`${DEV_ROOT}/.oks`) ? readdirSync(`${DEV_ROOT}/.oks`) : [];
  console.log(`  .oks/ 里：${stateFiles.join(', ') || '(没有)'}`);
  // `.oks/` 里只有：状态库 + 内部材料目录（data 封装数据 / charts 图 / views 其他展示件）。
  if (stateFiles.some((name) => !['state.db', 'state.db-journal', 'data', 'charts', 'views'].includes(name))) {
    throw new Error(`.oks/ 里出现了状态与内部材料之外的东西：${stateFiles.join(', ')}`);
  }
  if (existsSync(`${DEV_ROOT}/artifacts`)) {
    const files = readdirSync(`${DEV_ROOT}/artifacts`).filter((name) => !dataListingBefore.has(name));
    // 三类产物一套命名：<时间>-<名字>[-<内容哈希>].<类别><扩展名>。
    const PRODUCT = /^\d{8}T\d{6}Z-[0-9a-z_~]+-[0-9a-f]{8,}\.(query\.json|chart\.svg|report\.html)$/;
    const allProducts = files.length > 0 && files.every((name) => PRODUCT.test(name));
    console.log(`  artifacts/ 里 ${files.length} 个产物、都是 <时间>-<名字>-<哈希>.<类别><扩展名>: ${allProducts ? '✓' : '✗'}`);
    if (!allProducts) {
      throw new Error(`artifacts/ 里出现了不按命名规则落地的产物：${files.filter((name) => !PRODUCT.test(name)).slice(0, 3).join(', ')}`);
    }
  }
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
    const checked = await tools.get('oks_check_intent').execute(
      { intents: countNamed },
      { signal: new AbortController().signal, ...sessionFor(DEV_ROOT) },
    );
    const key = (checked.results ?? [])[0]?.key ?? null;
    const value = await tool.execute(
      { intents: { count: { intent: countNamed.count, key } } },
      { signal: new AbortController().signal, ...sessionFor(DEV_ROOT) },
    );
    const first = value.results?.[0] ?? null;
    if (first === null) return '没有结果';
    return first.status === 'saved'
      ? `ok（1 ms 内跑完，${first.rowCount} 行）`
      : `拒绝: ${String(first.error ?? first.status).slice(0, 70)}`;
  };
  console.log(`  第 1 次: ${await attempt()}`);
  console.log(`  第 2 次: ${await attempt()}`);
}

// ── 自包含：把 lib/ 整个目录搬进空目录（没有 node_modules、没有源码）也能用 ──────
// 提示词与 echarts 都在构建期内联进产物，lib/ 里没有旁资产。
// ── 产出层的状态：清单、pin 与保活清理 ─────────────────────────────────────────
console.log('=== 清单、pin 与保活清理 ===');
{
  // 清单：图与报告进清单，查询结果（内部制品）不出现；每条标题永不为空；最新在前。
  const listed = await call('oks_artifacts', {});
  const entries = listed.value.entries;
  console.log(`  清单：${entries.length} 条（保留 ${entries.filter((entry) => entry.pinned).length} 条）`);
  ok('清单列出了产物', entries.length >= 2);
  ok('查询结果是内部制品，不进清单', !entries.some((entry) => entry.file.endsWith('.query.json')));
  ok('清单里每一条都有标题（自述里那一行永不为空）',
    entries.every((entry) => typeof entry.title === 'string' && entry.title.length > 0));
  ok('清单最新在前', entries.every((entry, index) => index === 0 || entries[index - 1].at >= entry.at));

  // 保留：只改存留、不改位置。这条能力**不在工具面里**（界面端点直接调它），所以这里直接调函数。
  const target = entries.find((entry) => entry.file.endsWith('.report.html')) ?? entries[0];
  const src = `artifacts/${target.file}`;
  const indexBefore = entries.findIndex((entry) => entry.file === target.file);
  pinBySrc(DEV_ROOT, src, true);
  const afterPin = (await call('oks_artifacts', {})).value.entries;
  ok('保留之后清单里那一条是已保留', afterPin.find((entry) => entry.file === target.file)?.pinned === true);
  ok('保留不改变条目在清单里的位置', afterPin.findIndex((entry) => entry.file === target.file) === indexBefore);
  ok('取消保留之后回到未保留', pinBySrc(DEV_ROOT, src, false).pinned === false);

  // 非法 src 要有明确的话：越界、不是可见产物、找不到。
  const refused = (bad) => {
    try {
      pinBySrc(DEV_ROOT, bad, true);
      return '';
    } catch (cause) {
      return String(cause?.message ?? cause);
    }
  };
  ok('保留拒绝可读目录之外的路径', refused('.oks/state.db').includes('只能指向'));
  ok('保留拒绝不存在的产物', refused('.oks/charts/nope.chart.svg').includes('找不到'));
  const internals = readdirSync(join(DEV_ROOT, '.oks', 'data')).filter((name) => name.endsWith('.query.json'));
  ok('工作区里确实有内部制品（好让下一条有意义）', internals.length > 0);
  ok(`保留拒绝内部制品（查询结果）（实际：${refused(`.oks/data/${internals[0]}`) || '（没有报错）'}）`,
    refused(`.oks/data/${internals[0]}`).includes('只有报表可以保留'));
  // 图表当前**不算制品**（它是一份报表里的图）：清单里没有它，也就不该能被保留。
  const chartFiles = () => (existsSync(join(DEV_ROOT, '.oks', 'charts'))
    ? readdirSync(join(DEV_ROOT, '.oks', 'charts')) : []);
  const figure = chartFiles().find((name) => name.endsWith('.chart.svg'));
  ok('工作区里确实有图（好让下一条有意义）', typeof figure === 'string');
  ok('保留拒绝图（当前只有报表算制品）', refused(`.oks/charts/${figure}`).includes('只有报表可以保留'));

  // 保活清理：种三份"过期"的东西——一份过期报告（该清）、一份过期但保留的报告（该留）、
  // 一份认不出的文件（不碰）；然后写一张图触发清理（清理发生在**写产物之前**）。
  const oldStamp = '20200101T000000Z';
  const hashOf = (text) => createHash('sha256').update(text).digest('hex').slice(0, 8);
  const oldReport = `${oldStamp}-old_report-${hashOf('old-report')}.report.html`;
  const keptReport = `${oldStamp}-old_kept-${hashOf('old-kept')}.report.html`;
  const stranger = `${oldStamp}-stranger.txt`;
  const oldBody = (name, title) => embedArtifactMeta('<html><head></head><body>old</body></html>',
    { name, kind: 'report', at: oldStamp, title });
  writeFileSync(join(DEV_ROOT, 'artifacts', oldReport), oldBody('old_report', '很久以前的报告'));
  writeFileSync(join(DEV_ROOT, 'artifacts', keptReport), oldBody('old_kept', '要留住的旧报告'));
  writeFileSync(join(DEV_ROOT, 'artifacts', stranger), '用户自己放在这里的东西');
  // 保活清理遍历**账本的行**，所以先给这两份记账（人工写进目录的文件不走这条路）。
  {
    const state = openState(DEV_ROOT);
    try {
      recordArtifact(state, oldReport, { name: 'old_report', kind: 'report', at: oldStamp, title: '很久以前的报告' });
      recordArtifact(state, keptReport, { name: 'old_kept', kind: 'report', at: oldStamp, title: '要留住的旧报告' });
    } finally {
      state.close();
    }
  }
  pinBySrc(DEV_ROOT, `artifacts/${keptReport}`, true);
  const logsBefore = logs.length;
  const pruneRows = await call('create_data', {
    name: 'probe_prune_rows',
    motivation: '冒烟夹具：保活清理要用的图',
    data: [{ label: 'A', value: 1 }],
  });
  await call('oks_chart', { spec: { kind: 'bar', x: 'label', value: 'value' }, src: pruneRows.value.dataSrc, name: 'probe_prune' });
  ok('过期且未保留的产物被清理', !existsSync(join(DEV_ROOT, 'artifacts', oldReport)));
  ok('保留过的产物不会被清理', existsSync(join(DEV_ROOT, 'artifacts', keptReport)));
  ok('没登记的文件不在清理范围里（清理只认账本上的行）', existsSync(join(DEV_ROOT, 'artifacts', stranger)));
  const pruneLog = logs.slice(logsBefore).find((line) => line.includes('prune'));
  console.log(`  清理留痕：${pruneLog ?? '(没有)'}`);
  // 日志只说数量：至少清了一条，保留了几个也报出来。
  const cleanedCount = typeof pruneLog === 'string' ? Number(/清理 (\d+) 个过期产物/.exec(pruneLog)?.[1] ?? 0) : 0;
  ok('清理留痕（宿主日志里有一行、至少清了一条、保留数也报出来）',
    cleanedCount >= 1 && typeof pruneLog === 'string' && /保留 \d+ 个/.test(pruneLog));
  const listedAfter = (await call('oks_artifacts', {})).value.entries;
  ok('清理之后清单里没有它了', !listedAfter.some((entry) => entry.file === oldReport));
  ok('保留的那条还在清单里', listedAfter.some((entry) => entry.file === keptReport && entry.pinned === true));

  // 清单能从目录重建：删掉状态库再列一次，条目还在——pin 丢了，这是预期（它是唯一不能重建的东西）。
  rmSync(join(DEV_ROOT, '.oks'), { recursive: true, force: true });
  const rebuilt = (await call('oks_artifacts', {})).value.entries;
  ok('删掉状态库之后清单仍能从目录重建', rebuilt.length === listedAfter.length);
  ok('重建之后 pin 丢了（pin 是唯一不能从产物重建的东西）', !rebuilt.some((entry) => entry.pinned === true));
}

// ── 给界面的清单：`.oks/index.json`（页签只读它，不碰 sqlite、也不解析产物文件）────────
// ── 右侧栏页签的交付形态：经典脚本 + 宿主模块加载器协议 ───────────────────────
console.log('=== 页签的交付形态 ===');
{
  const client = readFileSync(new URL('../dsh-oks-ui/lib/client.mjs', import.meta.url), 'utf8');
  ok('用宿主的模块加载器协议交付',
    client.includes('__ModuleLoader__.load(') && /id:\s*["']@local\/dsh-oks-ui["']/.test(client));
  // 页面加载器按经典脚本执行它：顶层出现 import/export 就会整条 entry 不激活。
  ok('没有顶层 import / export', !/^\s*(import|export)\s/m.test(client));
  ok('依赖走工厂的 require()', /factory: \(require\)/.test(client) || /factory: \(require\)\s*=>/.test(client));
}

// ── 精确分类：报表可以带 category；清单里只有报表（图当前不算制品）────────────────────
console.log('=== 分类与"当前只算报表" ===');
{
  const saved = await call('oks_report', {
    spec: { title: '分类探针', markdown: '## 一\n\n正文。' },
    name: 'probe_category',
    category: '周报',
  });
  ok('报表可以带精确分类', String(saved.value.htmlSrc).includes('probe_category'));
  const listed = await call('oks_artifacts', {});
  const entries = listed.value.entries;
  const probe = entries.find((entry) => entry.file.includes('probe_category'));
  ok('清单里带着那个分类', probe?.category === '周报');
  const others = entries.filter((entry) => !entry.file.includes('probe_category'));
  ok('没给分类的报表落在默认分类上（即时分析）',
    others.length === 0 || others.every((entry) => entry.category === '即时分析'));
  ok('清单里只有报表（图当前不算制品）', entries.every((entry) => entry.kind === 'report'));
  // 自述在 HTML 里是转义过的（&quot;），所以只看键与值都在。
  const described = readFileSync(join(DEV_ROOT, 'artifacts', String(probe?.file)), 'utf8');
  ok('自述里也写着分类（换成别的工具读也一样）',
    described.includes('category') && described.includes('周报'));
}

// ── 账本：清单只依赖数据库，不依赖文件系统 ────────────────────────────────────
//   读路径一个字节的文件系统都不碰（只 `SELECT`），碰目录的三件事都在写路径：
//   收养（只在库空时）、补登与清悬挂（写产物之前的懒惰清理里）、删除（用户点 ✕）。
console.log('=== 账本：清单不依赖文件系统 ===');
{
  const dir = mkdtempSync(join(tmpdir(), 'oks-ledger-'));
  const report = readdirSync(join(DEV_ROOT, 'artifacts')).find((name) => VISIBLE.test(name));
  const source = readFileSync(join(DEV_ROOT, 'artifacts', String(report)), 'utf8');
  const target = join(dir, 'artifacts', String(report));
  mkdirSync(join(dir, 'artifacts'), { recursive: true });
  copyFileSync(join(DEV_ROOT, 'artifacts', String(report)), target);
  const state = openState(dir);
  try {
    // 补登（读路径）：目录里有、账本上没有的可读产物就地登记；只加不删。
    ok('库空时把目录里的产物补登进来', adoptArtifacts(state, dir).adopted === 1
      && listArtifacts(state).length === 1);
    const handDropped = `${resultStamp()}-hand_dropped.report.html`;
    writeFileSync(join(dir, 'artifacts', handDropped), source);
    ok('文件在、账本上没有：一次读就补进来（不必等写操作）',
      adoptArtifacts(state, dir).adopted === 1 && listArtifacts(state).length === 2);
    ok('补登不重复：再补一次什么都不做', adoptArtifacts(state, dir).adopted === 0
      && listArtifacts(state).length === 2);

    // 读路径不写：同一个库**只读**打开也能出清单（`ensureLedger` 在表非空时只是一句 count）。
    {
      const readOnly = new DatabaseSync(join(dir, '.oks', 'state.db'), { readOnly: true });
      try {
        const state2 = { db: readOnly, close: () => { /* 只读的那份自己关 */ } };
        ok('读路径不写：库只读打开也能出清单，没有要补登的就不动手',
          adoptArtifacts(state2, dir).adopted === 0 && listArtifacts(state2).length === 2);
      } finally {
        readOnly.close();
      }
    }

    // 目录整个看不见：清单照旧（读路径不碰目录，所以"看不见"不会变成"没有"）。
    rmSync(join(dir, 'artifacts'), { recursive: true, force: true });
    ok('目录不在时清单照旧（补登也不凭空加行、更不删行）',
      adoptArtifacts(state, dir).adopted === 0 && listArtifacts(state).length === 2);
    ok('目录不在时补登/清悬挂都什么都不做',
      reconcileArtifacts(state, dir).removed.length === 0 && listArtifacts(state).length === 2);

    mkdirSync(join(dir, 'artifacts'), { recursive: true });
    copyFileSync(join(DEV_ROOT, 'artifacts', String(report)), target);
    writeFileSync(join(dir, 'artifacts', handDropped), source);
    // 一个**从没被读过**的新产物：写路径的对账也要能补登它（人工放进来、或刚好错过一次读）。
    const writeOnly = `${resultStamp()}-write_only.report.html`;
    writeFileSync(join(dir, 'artifacts', writeOnly), source);

    const reconciled = reconcileArtifacts(state, dir);
    ok('写路径的对账也补登目录里还没登记的产物',
      reconciled.adopted === 1 && listArtifacts(state).length === 3);

    // 行是权威：文件还在、自述读不出时**不重新解析**，原来那一行（含标题与保留）照旧。
    const before = listArtifacts(state).find((row) => row.file === String(report));
    pinBySrc(dir, `artifacts/${String(report)}`, true);
    writeFileSync(target, '<!doctype html><html><head><title>只写了一半');
    const afterHalf = reconcileArtifacts(state, dir);
    const kept = listArtifacts(state).find((row) => row.file === String(report));
    ok('文件还在但读不出自述：那一行照旧，标题与保留都不动（不重新解析文件）',
      afterHalf.unreadable.length === 0 && kept?.title === before?.title && kept?.pinned === true);

    // 文件真的没了：行才被清掉（连同保留）。
    copyFileSync(join(DEV_ROOT, 'artifacts', String(report)), target);
    rmSync(target, { force: true });
    const gone = reconcileArtifacts(state, dir);
    ok('文件真的不在时才清掉那一行', gone.removed.length === 1 && listArtifacts(state).length === 2);

    // 保活清理遍历**行**：过期的删文件 + 删行；保留的跳过。
    const expiredMeta = (name: string, title: string) => ({ name, kind: 'report' as const, at: '20200101T000000Z', title });
    const stale = '20200101T000000Z-stale_probe.report.html';
    const keep = '20200101T000000Z-kept_probe.report.html';
    writeFileSync(join(dir, 'artifacts', stale), source);
    writeFileSync(join(dir, 'artifacts', keep), source);
    recordArtifact(state, stale, expiredMeta('stale_probe', '过期的探针报告'));
    recordArtifact(state, keep, expiredMeta('kept_probe', '留住的探针报告'));
    pinBySrc(dir, `artifacts/${keep}`, true);
    const pruned = pruneArtifacts(state, dir, KEEP_ALIVE_MINUTES);
    ok('保活清理按行做：过期的文件与行一起没，保留的那份（行与文件）都不动',
      pruned.removed.includes(stale) && !existsSync(join(dir, 'artifacts', stale))
      && !listArtifacts(state).some((row) => row.file === stale)
      && existsSync(join(dir, 'artifacts', keep))
      && listArtifacts(state).some((row) => row.file === keep && row.pinned === true));
    ok('目录看不见时保活清理什么都不做（那次"看不见"不当成"都没了"）',
      (() => {
        rmSync(join(dir, 'artifacts'), { recursive: true, force: true });
        const idle = pruneArtifacts(state, dir, 0);   // 保活设成 0：所有行都过期
        return idle.removed.length === 0 && listArtifacts(state).length >= 1;
      })());

    // 记账用的是**手里的那份 meta**，不是从文件里读回来的：标题里的 `&` 与引号在库里是原文。
    const raw = '原文 & "引号" 的标题';
    const written = saveArtifact({
      root: dir,
      name: 'raw_meta',
      content: `<!doctype html><html><head><title>${raw}</title></head><body>x</body></html>`,
      extension: '.html',
      kind: 'report',
      title: raw,
    });
    recordArtifact(state, written.src.slice(written.src.lastIndexOf('/') + 1), written.meta);
    const onDisk = readFileSync(join(dir, written.src), 'utf8');
    const row = listArtifacts(state).find((item) => item.file === written.src.slice(written.src.lastIndexOf('/') + 1));
    ok('库里的标题是原文，文件里的自述是转义后的（不靠解析文件记账）',
      row?.title === raw && onDisk.includes('&amp;') && onDisk.includes('&quot;')
      && readArtifactMeta(onDisk)?.title === raw);
  } finally {
    state.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── 内部材料的保活：比报表多 2 分钟；回收材料不碰保留状态 ───────────────────────
console.log('=== 内部材料的回收 ===');
{
  const dir = mkdtempSync(join(tmpdir(), 'oks-materials-'));
  mkdirSync(join(dir, '.oks', 'data'), { recursive: true });
  mkdirSync(join(dir, '.oks', 'charts'), { recursive: true });
  const stale = join(dir, '.oks', 'data', '20200101T000000Z-old-aaaaaaaa.query.json');
  const stranger = join(dir, '.oks', 'charts', 'notes.txt');
  writeFileSync(stale, '{}');
  writeFileSync(stranger, '用户自己放在这里的东西');
  const longAgo = new Date(Date.now() - 6 * 3600_000);   // 6 小时前：比任何保活窗口都旧
  utimesSync(stale, longAgo, longAgo);
  const state = openState(dir);
  try {
    const { removed, untouched } = pruneMaterials(state, dir, 60);
    ok('过期的内部材料被回收', removed.length === 1 && !existsSync(stale));
    ok('内部材料里认不出的不动', existsSync(stranger) && untouched >= 1);
    ok('内部材料比报表多活 2 分钟', MATERIAL_KEEP_ALIVE_MINUTES === KEEP_ALIVE_MINUTES + 2);
  } finally {
    state.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log('=== 界面那两条端点 ===');
{
  const { createArtifactsEndpoint, createDeleteEndpoint, createDownloadEndpoint, createPinEndpoint } = await import('./src/endpoint.ts');
  const asked: string[] = [];
  const deps = {
    rootFor: (sessionId: string) => { asked.push(sessionId); return DEV_ROOT; },
    pin: (root: string, src: string, pinned: boolean) => pinBySrc(root, src, pinned),
    remove: (root: string, src: string) => deleteArtifact(root, src),
  };
  const artifacts = createArtifactsEndpoint(deps);
  const pin = createPinEndpoint(deps);
  const del = createDeleteEndpoint(deps);
  const download = createDownloadEndpoint(deps);
  const call = async (
    handler: (req: never, res: never) => Promise<void>,
    method: string,
    url: string,
    body?: unknown,
  ): Promise<{ status: number; body: Record<string, unknown>; text: string; headers: Record<string, string> }> => {
    const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
    const req = { method, url, [Symbol.asyncIterator]: async function* () { for (const chunk of chunks) yield chunk; } };
    let status = 0;
    let text = '';
    let headers: Record<string, string> = {};
    const res = {
      writeHead(value: number, extra?: Record<string, string>) {
        status = value;
        headers = extra ?? {};
        return { end(payload?: string) { text = payload ?? ''; } };
      },
    };
    await handler(req as never, res as never);
    // 回执是 JSON 就解析（下载端点是 HTML，原样留着给断言看）。注意别和入参 body 撞名。
    const parsed = (headers['content-type'] ?? '').startsWith('application/json') && text !== ''
      ? JSON.parse(text) as Record<string, unknown>
      : {};
    return { status, body: parsed, text, headers };
  };

  // 会话 → 工作区的解析：活会话表只认识**本进程起来之后**创建的会话，而页签可能在看重启前
  // 那个会话（现场就是"刷新一下就好了"）。所以落空时要读磁盘上的会话头。
  {
    const { sessionRootResolver } = await import('./src/endpoint.ts');
    let persistedReads = 0;
    const resolver = sessionRootResolver(
      { get: (id: string) => (id === 'live' ? { header: { cwd: '/w/live' } } : undefined) },
      {
        readSession: async (id: string) => {
          persistedReads += 1;
          if (id === 'from-log') return { header: { cwd: '/w/from-log' } };
          throw new Error('没有这个会话');
        },
      },
    );
    ok('活会话表里有时直接用它的工作区', await resolver('live') === '/w/live');
    ok('活会话表落空时读磁盘上的会话头（重启后旧会话靠这条）',
      await resolver('from-log') === '/w/from-log' && persistedReads === 1);
    ok('解析过的记在内存里：同一次运行里不反复读日志',
      await resolver('from-log') === '/w/from-log' && persistedReads === 1);
    let bothMissed = '';
    try { await resolver('nope'); } catch (cause) { bothMissed = String((cause as Error).message); }
    ok('两条路都落空才报错（带上会话 id，不猜一个工作区出来）', /找不到会话 nope/.test(bothMissed));
    const liveOnly = sessionRootResolver({ get: () => undefined }, undefined);
    let noFallback = '';
    try { await liveOnly('x'); } catch (cause) { noFallback = String((cause as Error).message); }
    ok('没有 sessionQuery 的部署里，行为与从前一样（回 400，不炸）', /找不到会话 x/.test(noFallback));
  }

  const first = await call(artifacts, 'GET', '/oks/artifacts?sessionId=probe');
  const value = first.body.value as { keepAliveMinutes: number; entries: { file: string; pinned: boolean }[] } | undefined;
  ok('GET 清单：回执是 { ok, value }', first.status === 200 && first.body.ok === true && Array.isArray(value?.entries));
  ok('清单里有产物（界面要的就是这些）', (value?.entries.length ?? 0) > 0);
  ok('回执带着保活窗口', Number(value?.keepAliveMinutes) > 0);

  const target = value?.entries[0];
  const pinned = await call(pin, 'POST', '/oks/pin', { sessionId: 'probe', src: `artifacts/${target?.file}`, pinned: true });
  ok(`POST 保留：落状态并回执（实际 ${pinned.status} ${JSON.stringify(pinned.body)}）`,
    pinned.status === 200 && (pinned.body.value as { pinned: boolean } | undefined)?.pinned === true);

  const again = await call(artifacts, 'GET', '/oks/artifacts?sessionId=probe');
  const after = (again.body.value as { entries: { file: string; pinned: boolean }[] }).entries;
  ok('再问一次清单：状态已经变了（界面重读即见）', after.find((item) => item.file === target?.file)?.pinned === true);
  ok('两条端点都按 sessionId 找过工作区', asked.join(',') === 'probe,probe,probe');

  // 同步这一步失败不该让这次刷新变成"读不到清单"：清单是**投影**，库里已有的行照旧给出。
  // （这里把 artifacts 换成一个同名文件，让扫描报 ENOTDIR——现场更常见的是撞上清理或写锁。）
  const artifactsDir = join(DEV_ROOT, 'artifacts');
  const stashed = `${artifactsDir}.stash`;
  renameSync(artifactsDir, stashed);
  writeFileSync(artifactsDir, '不是一个目录\n');
  try {
    const degraded = await call(artifacts, 'GET', '/oks/artifacts?sessionId=probe');
    const entries = (degraded.body.value as { entries: unknown[] } | undefined)?.entries;
    ok('同步失败不吞掉清单：按库里已有的照常回执',
      degraded.status === 200 && Array.isArray(entries) && entries.length > 0);
  } finally {
    rmSync(artifactsDir, { force: true });
    renameSync(stashed, artifactsDir);
  }
  const restored = await call(artifacts, 'GET', '/oks/artifacts?sessionId=probe');
  ok('恢复之后清单照旧', ((restored.body.value as { entries: unknown[] }).entries).length > 0);

  // 现场那个形态：文件在磁盘上（能打开），账本里没有它那一行——**一次读**就该补进来，
  // 而不是等下一次写产物。以前只在"库空"时收养，于是这种产物会一直不可见。
  const unlisted = `${resultStamp()}-adopted_by_read.report.html`;
  copyFileSync(join(DEV_ROOT, 'artifacts', String(target?.file)), join(DEV_ROOT, 'artifacts', unlisted));
  const adoptedRead = await call(artifacts, 'GET', '/oks/artifacts?sessionId=probe');
  const adoptedEntries = (adoptedRead.body.value as { entries: { file: string }[] }).entries;
  ok('文件在、账本上没有时：一次读就补进来（不必等写操作）',
    adoptedEntries.some((entry) => entry.file === unlisted));
  await call(del, 'POST', '/oks/delete', { sessionId: 'probe', src: `artifacts/${unlisted}` });

  // 主动删除（界面每行那个 x）：只有未保留的能删；文件与行一起去掉。
  const doomed = saveArtifact({
    root: DEV_ROOT,
    name: 'delete_probe',
    content: '<!doctype html><html><head><title>待删的冒烟报告</title></head><body>删我</body></html>',
    extension: '.html',
    kind: 'report',
    title: '待删的冒烟报告',
  });
  const doomedFile = doomed.src.slice(doomed.src.lastIndexOf('/') + 1);
  const listFiles = async (): Promise<string[]> => {
    const listing = await call(artifacts, 'GET', '/oks/artifacts?sessionId=probe');
    return ((listing.body.value as { entries: { file: string }[] } | undefined)?.entries ?? [])
      .map((entry) => entry.file);
  };
  {
    const state = openState(DEV_ROOT);
    try { reconcileArtifacts(state, DEV_ROOT); } finally { state.close(); }
  }
  ok('删除前：产物在磁盘上、也在清单里',
    existsSync(join(DEV_ROOT, doomed.src)) && (await listFiles()).includes(doomedFile));
  await call(pin, 'POST', '/oks/pin', { sessionId: 'probe', src: doomed.src, pinned: true });
  const pinnedDelete = await call(del, 'POST', '/oks/delete', { sessionId: 'probe', src: doomed.src });
  ok('保留中的产物删不掉：报错，文件与那一行都还在',
    pinnedDelete.status === 400 && /先取消保留/.test(String(pinnedDelete.body.message))
    && existsSync(join(DEV_ROOT, doomed.src)) && (await listFiles()).includes(doomedFile));
  await call(pin, 'POST', '/oks/pin', { sessionId: 'probe', src: doomed.src, pinned: false });
  const removed = await call(del, 'POST', '/oks/delete', { sessionId: 'probe', src: doomed.src });
  ok('未保留的产物能删：文件与那一行一起没了',
    removed.status === 200 && removed.body.ok === true
    && !existsSync(join(DEV_ROOT, doomed.src)) && !(await listFiles()).includes(doomedFile));
  // 文件已经不在磁盘上时，那一行仍然删得掉：用户点的是**清单上的那一行**，清单是权威。
  // （这里不经过清单端点，避免读路径的同步先把那一行收掉。）
  const orphan = saveArtifact({
    root: DEV_ROOT,
    name: 'orphan_probe',
    content: '<!doctype html><html><head><title>文件先没了</title></head><body>删我</body></html>',
    extension: '.html',
    kind: 'report',
    title: '文件先没了',
  });
  const orphanFile = orphan.src.slice(orphan.src.lastIndexOf('/') + 1);
  {
    const state = openState(DEV_ROOT);
    try { reconcileArtifacts(state, DEV_ROOT); } finally { state.close(); }
  }
  rmSync(join(DEV_ROOT, orphan.src), { force: true });
  const orphanGone = await call(del, 'POST', '/oks/delete', { sessionId: 'probe', src: orphan.src });
  const orphanRows = (() => {
    const state = openState(DEV_ROOT);
    try { return listArtifacts(state); } finally { state.close(); }
  })();
  ok('文件已经不在时那一行照样能删掉（清单是权威，用户点的是清单上的行）',
    orphanGone.status === 200 && !orphanRows.some((row) => row.file === orphanFile));

  ok('再删一次明确报错（登记已经没了）',
    (await call(del, 'POST', '/oks/delete', { sessionId: 'probe', src: doomed.src })).status === 400);
  ok('删除只接受 POST', (await call(del, 'GET', '/oks/delete')).status === 405);
  ok('删除缺字段明确报错', (await call(del, 'POST', '/oks/delete', { sessionId: 'probe' })).status === 400);

  // 边界：这两条端点很窄，不能被当成通用入口
  ok('清单只接受 GET', (await call(artifacts, 'POST', '/oks/artifacts?sessionId=probe')).status === 405);
  ok('保留只接受 POST', (await call(pin, 'GET', '/oks/pin')).status === 405);
  ok('清单缺 sessionId 明确报错', (await call(artifacts, 'GET', '/oks/artifacts')).status === 400);
  ok('保留缺字段明确报错', (await call(pin, 'POST', '/oks/pin', { sessionId: 'probe' })).status === 400);
  ok('pinned 必须是布尔', (await call(pin, 'POST', '/oks/pin', { sessionId: 'probe', src: `artifacts/${target?.file}`, pinned: 'yes' })).status === 400);
  ok('不存在的产物不静默成功',
    (await call(pin, 'POST', '/oks/pin', { sessionId: 'probe', src: '.oks/charts/nope.chart.svg', pinned: true })).status === 400);

  await call(pin, 'POST', '/oks/pin', { sessionId: 'probe', src: `artifacts/${target?.file}`, pinned: false });

  // 下载：报表内容原样交给浏览器（带 attachment 头），界面用一个普通链接就能下载。
  const file = encodeURIComponent(String(target?.file));
  const got = await call(download, 'GET', `/oks/download?sessionId=probe&file=${file}`);
  ok('GET 下载：报表内容原样返回', got.status === 200 && /<html/i.test(got.text));
  ok('下载带 attachment 头（浏览器才当下载）', /attachment/.test(got.headers['content-disposition'] ?? ''));
  ok('下载带文件名', (got.headers['content-disposition'] ?? '').includes(String(target?.file)));
  ok('下载只接受 GET', (await call(download, 'POST', `/oks/download?sessionId=probe&file=${file}`)).status === 405);
  ok('下载不接受路径', (await call(download, 'GET', '/oks/download?sessionId=probe&file=../state.db')).status === 400);
  const figureFile = (existsSync(join(DEV_ROOT, '.oks', 'charts'))
    ? readdirSync(join(DEV_ROOT, '.oks', 'charts')) : []).find((name) => name.endsWith('.chart.svg'));
  ok('下载不读图（当前只有报表算制品）',
    (await call(download, 'GET', `/oks/download?sessionId=probe&file=${encodeURIComponent(String(figureFile))}`)).status === 400);
  ok('不存在的报表回 404',
    (await call(download, 'GET', '/oks/download?sessionId=probe&file=20260101T000000Z-nope.report.html')).status === 404);


}

// ── 报表自足：它引用的材料全被回收之后，报表仍带着最终展示数据与每次操作 ──────────
console.log('=== 报表自足（材料回收之后）===');
{
  const answer = await call('oks_query', { intents: await withKeys(countNamed) });
  const first = (answer.value.results ?? [])[0] ?? null;
  const src = first?.dataSrc;
  const column = first?.columns?.[0]?.name;
  const view = await call('oks_view', {
    spec: { kind: 'table', src, title: '自足用表' },
    name: 'self_contained_table',
  });
  const figure = await call('oks_chart', {
    spec: { kind: 'bar', x: column, value: column, title: '自足用图' },
    src,
  });
  const report = await call('oks_report', {
    spec: {
      title: '自足（冒烟）',
      markdown: [`![自足用表](${view.value.viewSrc})`, '', `![自足用图](${figure.value.svgSrc})`].join('\n'),
    },
    name: 'probe_self_contained',
  });
  // 三份材料都被回收：数据、表、图。
  for (const gone of [src, view.value.viewSrc, figure.value.svgSrc]) {
    rmSync(resolve(DEV_ROOT, gone), { force: true });
  }
  const html = readFileSync(resolve(DEV_ROOT, report.value.htmlSrc), 'utf8');
  const provenance = readReportProvenance(html);
  console.log(`  材料清空后：${Object.keys(provenance?.origin.nodes ?? {}).length} 个节点 · `
    + `${provenance?.data.items.length ?? 0} 个展示项 · 页面里 ${(html.match(/<table>/g) ?? []).length} 张表`);
  ok('材料回收后，页面上的表与图照旧显示',
    /<table>/.test(html) && /<svg class="chart"/.test(html) && report.value.tableCount === 1);
  ok('材料回收后，报表仍带着最终展示数据与每次操作',
    provenance !== null && provenance.data.items.length === 2
    && Array.isArray(provenance.data.items[1]?.data)
    && typeof provenance.data.items[1]?.data?.[0]?.[column] === 'number'
    && Object.values(provenance.origin.nodes).some((node) => node.kind === 'query')
    && Object.values(provenance.origin.nodes).every((node) => node.data === undefined));
}

// ── 报表里的 JSON 块：数据里的尖括号要挡住（`<script>` 是 raw text，实体不还原）──────
console.log('=== 来源结构的转义 ===');
{
  const nasty = '</script><img src=x onerror=alert(1)><!--';
  const literal = 'backslash-u003c: \\u003c';
  const made = await call('create_data', {
    name: 'nasty_rows',
    motivation: '冒烟：数据里带尖括号与转义序列',
    data: [{ text: nasty }, { text: literal }],
  });
  const view = await call('oks_view', {
    spec: { kind: 'table', src: made.value.dataSrc, title: '危险文本' },
    name: 'nasty_table',
  });
  const report = await call('oks_report', {
    spec: { title: '转义（冒烟）', markdown: `![危险文本](${view.value.viewSrc})\n` },
    name: 'probe_report_escape',
  });
  const html = readFileSync(resolve(DEV_ROOT, report.value.htmlSrc), 'utf8');
  const raw = /<script type="application\/json" id="dsh-oks-provenance">([\s\S]*?)<\/script>/.exec(html)?.[1] ?? '';
  ok('JSON 块里没有裸的 <（`</script>` 挡得住）', raw !== '' && !raw.includes('<'));
  const back = readReportProvenance(html);
  ok('转义之后仍原样读回（含字面量 \\u003c 这种文本）',
    back?.data?.items?.[0]?.data?.[0]?.text === nasty && back?.data?.items?.[0]?.data?.[1]?.text === literal);
  // 单元格里的危险文本要以**转义后的文本**出现：`onerror=` 作为文字留着没关系，
  // 关键是它前面没有真的标签（没有 <img / 没有可执行的 <script>）。
  ok('页面上的单元格是转义后的文本，没有变成标签',
    html.includes('&lt;/script&gt;') && !html.includes('<img')
    && !/<script(?![^>]*type="application\/json")/.test(html));
  for (const gone of [made.value.dataSrc, view.value.viewSrc]) rmSync(resolve(DEV_ROOT, gone), { force: true });
}

// ── 报告侧四个工具：清单 → 取数（看）→ 取数（物化）→ 来源跟踪 ────────────────────
console.log('=== 报告的清单 / 取数 / 来源跟踪 ===');
{
  // 先造一份报告，再把它的三份材料删掉——验"报告自足，所以材料回收后照样能取数"。
  const answer = await call('oks_query', { intents: await withKeys(countNamed) });
  const rowsSrc = (answer.value.results ?? [])[0]?.dataSrc;
  const column = (answer.value.results ?? [])[0]?.columns?.[0]?.name;
  const view = await call('oks_view', {
    spec: { kind: 'table', src: rowsSrc, title: '取数用表' },
    name: 'probe_extract_table',
  });
  const figure = await call('oks_chart', {
    spec: { kind: 'bar', x: column, value: column, title: '取数用图' },
    src: rowsSrc,
  });
  const built = await call('oks_report', {
    spec: {
      title: '取数（冒烟）',
      markdown: [
        '## 一、级别与清除',
        '',
        `![取数用表](${view.value.viewSrc})`,
        '',
        '| 手打 | 表 |',
        '| --- | --- |',
        '| 甲乙 | 1 |',
        '',
        '### 1.1 明细',
        '',
        `![取数用图](${figure.value.svgSrc})`,
      ].join('\n'),
    },
    name: 'probe_extract_report',
  });
  const reportSrc = built.value.htmlSrc;
  // 图的读路径先验（下面就把它的材料删掉，用来验"报告自足"）。
  const viaChart = await call('jq_transform', {
    inputs: { c: figure.value.svgSrc },
    byFile: prog('{kind: .c.spec.kind, rows: (.c.rows | length)}'),
  });
  console.log(`  jq 读图 → ${JSON.stringify(viaChart.value.data)}`);
  ok('jq 直接吃图：拿到 { rows, spec }',
    viaChart.value.ok !== false && viaChart.value.data?.kind === 'bar' && viaChart.value.data?.rows === 1);

  // 读产物是**就地**的：图、表、报告的材料块在读的那一刻解析，不落派生文件。
  const dataFilesBefore = readdirSync(resolve(DEV_ROOT, '.oks', 'data')).length;
  const chartOrigin = await call('jq_transform', {
    inputs: { c: { src: figure.value.svgSrc, root: '.origin' } },
    byFile: prog('{root: .c.root, kinds: [.c.nodes[].kind]}'),
  });
  const dataFilesAfter = readdirSync(resolve(DEV_ROOT, '.oks', 'data')).length;
  console.log(`  图的来源链 → 根 ${chartOrigin.value.data?.root} · ${JSON.stringify(chartOrigin.value.data?.kinds)}`);
  ok('读来源只取 root ".origin"，而且就地读：.oks/data/ 里不多出任何文件',
    chartOrigin.value.ok !== false && chartOrigin.value.data?.kinds?.includes('query')
    && dataFilesAfter === dataFilesBefore);

  for (const gone of [rowsSrc, view.value.viewSrc, figure.value.svgSrc]) {
    rmSync(resolve(DEV_ROOT, gone), { force: true });
  }
  // 材料已经全部回收：读这份报告只有一条路——jq 投影它的 data。
  const viaReport = await call('jq_transform', {
    inputs: { r: reportSrc },
    byFile: prog('{chapters: [.r.chapters[] | .caption], level1: .r.chapters[1].level, '
      + 'figure: ([.r.items[] | select(.kind == "chart")][0] | {no: .no, kind: .spec.kind}), '
      + 'table: ([.r.items[] | select(.kind == "table")][0] | {no: .no, rows: (.data | length)})}'),
  });
  console.log(`  jq 读报告 → ${JSON.stringify(viaReport.value.data).slice(0, 200)}`);
  ok('jq 直接吃报告：章节骨架（含 level）、图元与展示项数据都在',
    viaReport.value.ok !== false
    && JSON.stringify(viaReport.value.data?.chapters) === JSON.stringify(['一、级别与清除', '1.1 明细'])
    && viaReport.value.data?.level1 === 'h3'
    && viaReport.value.data?.figure?.kind === 'bar' && viaReport.value.data?.figure?.no === 1
    && viaReport.value.data?.table?.no === 1 && viaReport.value.data?.table?.rows > 0);

  // 展示项清单（原来由专门的读工具给）：现在就是从报告自己的 data 里投影出来的一段。
  const itemList = await call('jq_transform', {
    inputs: { r: { src: reportSrc, root: '.data.items' } },
    byFile: prog('[.r[] | {kind, no, caption}]'),
  });
  console.log(`  展示项：${JSON.stringify(itemList.value.data)}`);
  ok('展示项清单由 jq 从报告的 data 里投影：类型、报告上印的编号与注解都在',
    itemList.value.ok !== false && itemList.value.data?.length === 2
    && itemList.value.data[0].kind === 'table' && itemList.value.data[0].no === 1
    && itemList.value.data[1].kind === 'chart' && itemList.value.data[1].no === 1);

  // root "."：交给程序的是整份文件 { meta, origin, data }——读自述与来源链用它。
  const whole = await call('jq_transform', {
    inputs: { r: { src: reportSrc, root: '.' } },
    byFile: prog('{kind: .r.meta.kind, nodes: (.r.origin.nodes | keys | length), '
      + 'kinds: [.r.origin.nodes[].kind], root: .r.origin.nodes[.r.origin.root].kind, '
      + 'chapters: (.r.data.chapters | length)}'),
  });
  console.log(`  root "." → ${JSON.stringify(whole.value.data)}`);
  ok('root "." 交出整份文件（自述 + 来源链 + 数据）',
    whole.value.ok !== false && whole.value.data?.kind === 'report' && whole.value.data?.root === 'report'
    && whole.value.data?.chapters === 2 && whole.value.data?.nodes >= 2
    && (whole.value.data?.kinds ?? []).includes('query'));

  // root 只取一段：只要来源链 / 只要骨架，都不必把整份文件交给 jaq；回执里带上实际用的 root。
  const onlyOrigin = await call('jq_transform', {
    inputs: { r: { src: reportSrc, root: '.origin' } },
    byFile: prog('{nodes: (.r.nodes | keys | length), root: .r.root}'),
  });
  const onlyChapters = await call('jq_transform', {
    inputs: { r: { src: reportSrc, root: '.data.chapters' } },
    byFile: prog('[.r[] | .caption]'),
  });
  ok('root 只取一段：来源链与章节骨架各自单独可读，回执写明每份输入用了哪个 root',
    onlyOrigin.value.ok !== false && onlyOrigin.value.inputs?.[0]?.root === '.origin'
    && onlyOrigin.value.data?.nodes >= 2 && typeof onlyOrigin.value.data?.root === 'string'
    && JSON.stringify(onlyChapters.value.data) === JSON.stringify(['一、级别与清除', '1.1 明细']));
  const badRoot = await (async () => {
    try {
      await call('jq_transform', { inputs: { r: { src: reportSrc, root: '.nope' } }, byFile: prog('.') });
      return '';
    } catch (cause) {
      return String(cause?.message ?? cause);
    }
  })();
  const badSyntax = await (async () => {
    try {
      await call('jq_transform', { inputs: { r: { src: reportSrc, root: '.data | keys' } }, byFile: prog('.') });
      return '';
    } catch (cause) {
      return String(cause?.message ?? cause);
    }
  })();
  console.log(`  root 不存在 → ${badRoot.slice(0, 100)}`);
  ok('root 指向不存在的段时报出该层可用的键；写成表达式则明确拒绝',
    /\.data/.test(badRoot) && /\.meta/.test(badRoot) && /\.origin/.test(badRoot)
    && /只接受点路径/.test(badSyntax));

  // 数据封装（.oks/data/ 里的 JSON）自己就是数据：读它就是读它，不派生也不再写文件。
  const probe = await call('create_data', {
    name: 'origin_probe', motivation: '冒烟：读封装就是读它自己', data: [{ n: 1 }],
  });
  const beforeProbe = readdirSync(resolve(DEV_ROOT, '.oks', 'data')).length;
  const probeJq = await call('jq_transform', { inputs: { p: probe.value.dataSrc }, byFile: prog('.p[0].n') });
  const probeOrigin = await call('jq_transform', {
    inputs: { p: { src: probe.value.dataSrc, root: '.origin' } },
    byFile: prog('.p.nodes[.p.root].motivation'),
  });
  ok('读数据封装：jq 拿到的就是它的 data，读来源就地取 .origin，都不落新文件',
    probeJq.value.data === 1 && probeOrigin.value.data === '冒烟：读封装就是读它自己'
    && readdirSync(resolve(DEV_ROOT, '.oks', 'data')).length === beforeProbe);
  rmSync(resolve(DEV_ROOT, probe.value.dataSrc), { force: true });

  // 报表来源块是"理解面"的权威：逐项带着最终展示数据、规格与根节点（工具的读法只是 jq 投影）。
  const reportProvenance = readReportProvenance(readFileSync(resolve(DEV_ROOT, reportSrc), 'utf8'));
  const provenanceItems = reportProvenance?.data.items ?? [];
  ok('来源块逐项带着展示数据与根节点，根节点在节点表里可解析',
    provenanceItems.length === 2
    && provenanceItems.every((item) => item.root in (reportProvenance?.origin.nodes ?? {}))
    && Array.isArray(provenanceItems[1]?.data) && provenanceItems[1].data.length > 0);

  // 报表整体的 origin 是**一个**：根是组装节点，inputs 指向各展示项。
  const reportOrigin = await call('jq_transform', {
    inputs: { r: { src: reportSrc, root: '.origin' } },
    byFile: prog('{root: .r.root, rootKind: .r.nodes[.r.root].kind, inputs: .r.nodes[.r.root].inputs, '
      + 'nodes: (.r.nodes | keys | length)}'),
  });
  const refs = provenanceItems.map((item) => `${item.kind === 'table' ? '表' : '图'} ${item.no}`);
  console.log(`  报表 origin：根 ${reportOrigin.value.data?.root} · ${reportOrigin.value.data?.nodes} 个节点`
    + ` · 组装节点的输入 ${JSON.stringify(reportOrigin.value.data?.inputs ?? {})}`);
  ok('报表整体的 origin 是**一个**：根是组装节点，inputs 指向所有展示项的链',
    reportOrigin.value.ok !== false && reportOrigin.value.data?.rootKind === 'report'
    && reportOrigin.value.data?.nodes >= 2
    && Object.keys(reportOrigin.value.data?.inputs ?? {}).join() === refs.join());

  // 从一个数据元关联到 origin 上的来源解释：链上每一项的可读字段都在，不必另有读接口。
  const figureChain = await call('jq_transform', {
    inputs: { r: { src: reportSrc, root: '.origin' } },
    byFile: prog('[.r.nodes[] | select(.kind == "query") | {intent, source}] | .[0]'),
  });
  const fileIntent = (() => {
    const queryNode = Object.values(reportProvenance?.origin.nodes ?? {}).find((node) => node.kind === 'query');
    return JSON.stringify(queryNode?.intent);
  })();
  console.log(`  链上的来路：intent ${JSON.stringify(figureChain.value.data?.intent).slice(0, 90)}`
    + ` · source ${JSON.stringify(figureChain.value.data?.source).slice(0, 80)}`);
  ok('从 root ".origin" 读到每一项背后的查询意图与实际数据来源（逐字完整，不带省略号）',
    typeof figureChain.value.data?.intent === 'object'
    && JSON.stringify(figureChain.value.data.intent) === fileIntent
    && !JSON.stringify(figureChain.value.data.intent).includes('…')
    && typeof figureChain.value.data?.source?.dataFile === 'string');

  // 链里记着"当时观察到的数据文件"，读得到；**不做核对**——链解释过去、不承诺现状。
  const fakeSrc = `${resultStamp()}-observed_probe.query.json`;
  writeFileSync(resolve(DEV_ROOT, '.oks', 'data', fakeSrc), `${JSON.stringify({
    meta: { kind: 'query', name: 'observed_probe', at: resultStamp() },
    origin: { root: 'aaaaaaaaaaaa', nodes: { aaaaaaaaaaaa: {
      kind: 'query', intent: { op: 'Graph' },
      source: { dataFile: '/nowhere/gone.sqlite', bytes: 1, modifiedAt: '2020-01-01T00:00:00Z' },
    } } },
    data: { rows: [], columns: [] },
  }, null, 2)}\n`);
  const observed = await call('jq_transform', {
    inputs: { o: { src: `.oks/data/${fakeSrc}`, root: '.origin' } },
    byFile: prog('.o.nodes[.o.root].source'),
  });
  console.log(`  当时观察到的事实 → ${JSON.stringify(observed.value.data)}`);
  ok('当时的数据文件与观察时刻仍写在链里（读得到；是否还算数由调用方重新查）',
    observed.value.data?.dataFile === '/nowhere/gone.sqlite' && observed.value.data?.bytes === 1);
  rmSync(resolve(DEV_ROOT, '.oks', 'data', fakeSrc), { force: true });
}

console.log('=== 自包含（把 lib/ 整个目录放进空目录）===');
{
  mkdirSync(SCRATCH, { recursive: true });
  const alone = mkdtempSync(join(SCRATCH, 'alone-'));
  try {
    const libDir = fileURLToPath(new URL('./lib', import.meta.url));
    for (const name of readdirSync(libDir)) {
      cpSync(join(libDir, name), join(alone, name), { recursive: true });
    }
    const mod = await import(pathToFileURL(join(alone, 'index.mjs')).href);
    const captured = [];
    mod.apply({
      logger: { info: () => {} },
      get: (name) => (name === 'skills'
        ? { register: (skill) => { captured.push(skill); return () => {}; } }
        : undefined),
      tools: { register: () => () => {} },
      // effect 的回调必须真的执行：技能注册就在里面（收 dispose 即可）。
      effect: (fn) => { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {}; },
      on: () => () => {},
    }, {});
    ok('空目录里只放整个 lib/ 就能加载', typeof mod.apply === 'function' && captured.length === 1);
    ok('技能正文来自内联（与 src/skill.md 逐字一致）',
      captured[0]?.content === readFileSync(new URL('./src/skill.md', import.meta.url), 'utf8'));
    const text = readFileSync(join(alone, 'index.mjs'), 'utf8');
    ok('助手提示词也内联在产物里（占位符在同一份源码里）',
      text.includes('<!-- 词表 -->')
      && readFileSync(new URL('./src/va-prompt-tpl.md', import.meta.url), 'utf8').includes('<!-- 词表 -->'));
    // 产物自足：从空目录里真画一张图。echarts 已经打进 index.mjs，没有旁资产要读。
    const built = mod.buildOption([{ k: 'A', n: 1 }], {
      kind: 'bar', title: null, sourceLabel: 'agent 自主填写', x: 'k', value: 'n',
      series: null, xType: null, xLabel: null, valueLabel: null, unit: null,
    });
    const svg = mod.renderEchartsSvg(built.option, mod.CHART_WIDTH, built.height);
    ok('空目录里也能出图（echarts 已打进产物，无旁资产）',
      svg.startsWith('<svg') && svg.includes('<path'));
  } finally {
    rmSync(alone, { recursive: true, force: true });
  }
}

for (const dispose of disposers.reverse()) dispose();
rmSync(SCRATCH, { recursive: true, force: true });
// 走到这里说明没有一条 ✗（any failure throws above）；N 是 ok() 断言的条数。
console.log(`\n✓ ${passed} / ✗ 0`);
console.error('disposed cleanly');
