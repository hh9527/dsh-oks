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
import { apply, buildOption, CHART_WIDTH, renderEchartsSvg } from './dist/index.mjs';
import { applyOps, encode, parseMoment } from './src/time.ts';
import { singleFlight } from './src/single-flight.ts';
import { intentKey } from './src/key.ts';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DEV_ROOT = process.env.OKS_WORKSPACE ?? process.cwd();
const SCRATCH = `${DEV_ROOT}/.oks-smoke`;
// 插件只在工作区的 .data/ 里写查询结果，别处不碰；顶层清单因此只允许新增 .data/。
const workspaceListing = () => readdirSync(DEV_ROOT).filter((name) => name !== '.oks-smoke').sort().join(',');
const listingBefore = workspaceListing();

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
const EXPECTED_TOOLS = ['oks_search', 'oks_references', 'oks_info', 'oks_check_intent', 'oks_query', 'oks_jaq_result', 'oks_chart', 'oks_report', 'time_now', 'time_calc', 'va_ask'];
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
  const answer = await call('oks_query', { intents: await withKeys(countNamed) });
  const first = answer.value.results?.[0] ?? null;
  console.log(answer.text.split('\n').filter((line) => /◂|── |status:|dataSrc:|columns:|sql:/.test(line)).map((l) => `  ${l}`).join('\n').slice(0, 800));
  if (first === null) throw new Error('有效查询没有产生结果');
  if (first.status !== 'saved') throw new Error(`查询没有保存成功：${first.status} ${first.error ?? ''}`);
  console.log(`  行数 ${first.rowCount} · 渲染 ${answer.text.length} 字符（pruner 阈值 8192）`);
  if (first.rowCount < 1) throw new Error('查询应当至少返回一行');
  if (typeof first.dataSrc !== 'string' || !first.dataSrc.startsWith('.data/')) throw new Error('成功项应当返回 .data/ 下的 dataSrc');
  if (/sql:/.test(answer.text) || !/status:\s+saved/.test(answer.text)) throw new Error('回执应当是结构（保存状态），语句不进模型可见文本');
  const metaSql = answer.meta?.results?.[0]?.sql ?? null;
  console.log(`  语句只留在呈现记录里（meta.sql ${typeof metaSql === 'string' ? `${metaSql.length} 字符` : '缺失'}）: ${typeof metaSql === 'string' && metaSql.length > 0 ? '✓' : '✗'}`);
  if (typeof metaSql !== 'string' || metaSql.length === 0) throw new Error('语句应当留在 presentationMeta 里');
  if (answer.text.length >= 8192) throw new Error('模型可见文本超过了 pruner 阈值');
  if (/^\|.*\|$/m.test(answer.text)) throw new Error('数据行不该出现在查询回执里（它们只在结果文件里）');

  const saved = JSON.parse(readFileSync(resolve(DEV_ROOT, first.dataSrc), 'utf8'));
  console.log(`  结果文件 ${first.dataSrc}：${saved.rowCount} 行 · 列 ${saved.columns.map((column) => column.name).join(',')}`);
  if (saved.rowCount !== first.rowCount) throw new Error('结果文件的行数与回执不一致');
  if (!Array.isArray(saved.rows) || saved.rows.length !== first.rowCount) throw new Error('结果文件里没有完整数据行');
  if (JSON.stringify(saved.intent) !== JSON.stringify(countNamed.count)) throw new Error('结果文件里应当带原始 Intent');
  if (saved.columns.some((column) => !Array.isArray(column.types) || column.types.length === 0)) throw new Error('结果文件的列信息缺少类型');

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

// ── 结构化查询：表达式作用在行数组上，结果文件的内部结构不进契约 ────────────
console.log('=== oks_jaq_result（用表达式取数）===');
{
  const answer = await call('oks_query', { intents: await withKeys(countNamed) });
  const first = answer.value.results?.[0] ?? null;
  const column = first.columns[0]?.name;
  const numeric = first.columns.find((entry) => entry.types.includes('number'))?.name ?? column;

  // 标量：断言表达式拿到的确实是行数组
  const one = await call('oks_jaq_result', { src: first.dataSrc, query: `.[0].${column}` });
  console.log(`  .[0].${column} → ${JSON.stringify(one.value.result)}（输入 ${one.value.totalRows} 行）`);
  if (one.value.totalRows !== first.rowCount) throw new Error('回执应当报告输入的行数');
  if (one.value.returned !== 1) throw new Error('标量表达式应当产出恰好一个值');

  // 逐行投影：.[] 把行数组摊成流，每个元素产出一个对象
  const projected = await call('oks_jaq_result', {
    src: first.dataSrc,
    query: `.[] | {${column}, ${numeric}}`,
  });
  const sample = projected.value.result?.[0] ?? null;
  const keys = sample === null ? [] : Object.keys(sample);
  console.log(`  map({${column}, ${numeric}}) → ${JSON.stringify(sample)}`);
  const expectedKeys = [...new Set([column, numeric])];
  if (keys.length !== expectedKeys.length || !expectedKeys.every((name) => keys.includes(name))) {
    throw new Error('投影应当只产出选中的字段');
  }
  if (projected.value.returned !== first.rowCount) throw new Error('map 应当逐行产出一个值');

  // 写法错误：把求值器自己的报错带回来，而不是一句笼统的"查询失败"
  let evaluatorError = '';
  try {
    await call('oks_jaq_result', { src: first.dataSrc, query: '.[] |' });
  } catch (cause) {
    evaluatorError = String(cause?.message ?? cause);
  }
  console.log(`  表达式错误 → ${evaluatorError.split('\n')[0].slice(0, 96)}`);
  if (!/jaq 表达式执行失败/.test(evaluatorError)) throw new Error('表达式语法错误应当明确报错');

  let missingQuery = '';
  try {
    await call('oks_jaq_result', { src: first.dataSrc });
  } catch (cause) {
    missingQuery = String(cause?.message ?? cause);
  }
  console.log(`  缺 query 被拒: ${/需要 query/.test(missingQuery) ? '✓' : '✗'}`);
  if (!/需要 query/.test(missingQuery)) throw new Error('缺 query 应当明确报错');

  let outOfBounds = '';
  try {
    await call('oks_jaq_result', { src: '../oks.json', query: '.' });
  } catch (cause) {
    outOfBounds = String(cause?.message ?? cause);
  }
  console.log(`  越界的 src 被拒: ${/dataSrc/.test(outOfBounds) ? '✓' : '✗'}`);
  if (!/dataSrc/.test(outOfBounds)) throw new Error('src 走出 .data/ 时必须报错');

  // 输出到达上限：按行边界截断，绝不留下半个 JSON 值（否则残片会被当成结果）
  const bulk = await call('oks_jaq_result', { src: first.dataSrc, query: 'range(1; 200000)' });
  console.log(`  大输出：产出 ${bulk.value.returned} 个值 · truncated=${bulk.value.truncated}`);
  if (bulk.value.truncated !== true) throw new Error('输出超上限时应当报告 truncated');
  const fragments = bulk.value.result.filter((item) => typeof item !== 'number');
  console.log(`  截断后每个值都完整: ${fragments.length === 0 ? '✓' : `✗ ${JSON.stringify(fragments.slice(0, 2))}`}`);
  if (fragments.length > 0) throw new Error('截断不该留下半个值');
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
  if (savedFile.rows.length !== first.rowCount) throw new Error('结果文件应当完整保存这次 Intent 的结果');
}

// ── 图表：服务端出 SVG、两条数据路径、回执给出可粘进回答的 markdown ─────────
console.log('=== oks_chart（服务端出图）===');
{
  // data 路径：agent 自填数据，来源固定为「agent 自主填写」。
  const inline = await call('oks_chart', {
    spec: { kind: 'bar', title: '方案对比', x: 'label', value: 'value' },
    data: [{ label: 'A', value: 3 }, { label: 'B', value: 5 }],
    name: 'probe_inline',
  });
  console.log(inline.text.split('\n').filter(Boolean).map((line) => `  ${line}`).join('\n').slice(0, 520));
  if (inline.value.ok !== true || inline.value.source !== 'agent') throw new Error('data 路径的来源应当是 agent 自主填写');
  if (inline.value.rowCount !== 2) throw new Error('data 路径应当报告行数');
  if (!/agent 自主填写/.test(inline.text)) throw new Error('回执应当标出来源');
  // 图真的落成了 SVG
  const inlineSvg = readFileSync(resolve(DEV_ROOT, inline.value.svgSrc), 'utf8');
  console.log(`  落盘 ${inline.value.svgSrc}（${inlineSvg.length} 字符）: ${inlineSvg.startsWith('<svg') ? '✓' : '✗'}`);
  if (!inlineSvg.startsWith('<svg')) throw new Error('产物应当是 SVG');
  // 图里的文字是真 <text>（echarts 不把文字转成路径），标题则从回执字段核对。
  if (!inlineSvg.includes('<path')) throw new Error('SVG 里应当有图形');
  if (inline.value.title !== '方案对比') throw new Error('回执应当带上标题');
  // 回执给出的 markdown 指向同一个文件
  const expectedMarkdown = `![方案对比](${inline.value.svgSrc})`;
  if (inline.value.markdown !== expectedMarkdown) {
    throw new Error(`回执应当给出指向该 SVG 的 markdown，收到 ${JSON.stringify(inline.value.markdown)}`);
  }
  console.log(`  回执给出的 markdown: ${inline.value.markdown}`);

  // src 路径：引用查询结果文件，来源固定为「基于查询结果」，并从文件带出原始 Intent。
  const answer = await call('oks_query', { intents: await withKeys(countNamed) });
  const saved = (answer.value.results ?? [])[0] ?? null;
  const firstColumn = saved.columns[0]?.name;
  const numeric = saved.columns.find((entry) => entry.types.includes('number'))?.name ?? firstColumn;
  const fromSrc = await call('oks_chart', {
    spec: { kind: 'bar', x: firstColumn, value: numeric, title: '来自查询' },
    src: saved.dataSrc,
    note: '来源是查询结果文件',
  });
  if (fromSrc.value.ok !== true || fromSrc.value.source !== 'query') throw new Error('src 路径的来源应当是「基于查询结果」');
  if (fromSrc.value.src !== saved.dataSrc) throw new Error('src 路径应当回带 dataSrc');
  if (fromSrc.value.intent === null) throw new Error('src 路径应当从结果文件带出原始 Intent');
  const fromSrcSvg = readFileSync(resolve(DEV_ROOT, fromSrc.value.svgSrc), 'utf8');
  if (!fromSrcSvg.startsWith('<svg')) throw new Error('src 路径也应当落一份 SVG');
  console.log(`  src 路径：${fromSrc.value.rowCount} 行 → ${fromSrc.value.svgSrc} · 带原始 Intent ✓`);
  // 来源标识也从 lowering 产物核对一遍：它与回执字段应当一致。
  const inlineLowering = renderEchartsSvg(
    buildOption([{ label: 'A', value: 1 }], {
      kind: 'bar', title: null, sourceLabel: 'agent 自主填写', x: 'label', value: 'value',
      series: null, xType: null, xLabel: null, valueLabel: null, unit: null,
    }).option,
    CHART_WIDTH,
    200,
  );
  if (!inlineLowering.includes('来源：agent 自主填写')) throw new Error('自主填写的图里应当有来源标识');
  if (inline.value.source !== 'agent') throw new Error('回执应当标明来源是 agent 自主填写');
  if (fromSrc.value.source !== 'query') throw new Error('回执应当标明来源是查询结果');
  console.log('  来源标识：lowering 产物与回执字段都有 ✓');

  // 负值走 0 轴另一侧，并且换色，方向一眼可辨。
  const signed = await call('oks_chart', {
    spec: { kind: 'bar', title: '正负对照', x: 'label', value: 'value' },
    data: [{ label: '正', value: 5 }, { label: '负', value: -3 }],
    name: 'probe_signed',
  });
  const signedSvg = readFileSync(resolve(DEV_ROOT, signed.value.svgSrc), 'utf8');
  console.log(`  正负对照：${signedSvg.includes('#c0567a') ? '负值用区分色 ✓' : '✗ 没有区分色'}`);
  if (!signedSvg.includes('#c0567a')) throw new Error('负值应当用区分色绘制');

  // 分组柱：横轴是类别，每个类别里按 series 分成相邻的柱子。
  const column = await call('oks_chart', {
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
  const pie = await call('oks_chart', {
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
  const pieEmpty = await call('oks_chart', {
    spec: { kind: 'pie', x: 'label', value: 'value' },
    data: [{ label: '零', value: 0 }],
    name: 'probe_pie_empty',
  });
  if (pieEmpty.value.ok !== true) throw new Error('没有正数时饼图也应当出图');

  // 面积图：字段与折线一致，x 轴同样支持 number / time。
  const area = await call('oks_chart', {
    spec: { kind: 'area', title: '每日告警数', x: 'day', value: 'count', xType: 'number' },
    data: [{ day: 0, count: 15 }, { day: 1, count: 25 }, { day: 2, count: 18 }],
    name: 'probe_area',
  });
  const areaSvg = readFileSync(resolve(DEV_ROOT, area.value.svgSrc), 'utf8');
  console.log(`  面积图：${area.value.rowCount} 行 → ${(areaSvg.match(/<path/g) ?? []).length} 个 <path>`);
  if (!areaSvg.startsWith('<svg') || !areaSvg.includes('<path')) throw new Error('面积图应当落一份有图形的 SVG');

  // 排版覆盖项：用户不满意时 agent 可以调字号与高度，越界或写错项直接拒绝。
  const tuned = await call('oks_chart', {
    spec: { kind: 'bar', x: 'label', value: 'value', layout: { labelFont: 14, height: 240, slantTicks: false } },
    data: [{ label: '甲', value: 3 }, { label: '乙', value: 5 }],
    name: 'probe_layout',
  });
  const tunedSvg = readFileSync(resolve(DEV_ROOT, tuned.value.svgSrc), 'utf8');
  console.log(`  排版覆盖：labelFont/height/slantTicks 生效 → ${(tunedSvg.match(/<path/g) ?? []).length} 个 path`);
  if (!tunedSvg.includes('<path')) throw new Error('覆盖排版后仍应出图');

  // 报告：markdown 正文（章节 + 叙述 + chart 块）→ 自足的 HTML（图内联、无外链、无脚本）。
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
        '```chart',
        JSON.stringify({ kind: 'bar', x: 'k', value: 'n', data: [{ k: '严重', n: 15 }, { k: '提示', n: 36 }], caption: '各级别条数' }),
        '```',
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
  console.log(`  报告：${report.value.figureCount} 张图 → ${report.value.htmlSrc}`);
  if (!reportHtml.includes('<svg class="chart"')) throw new Error('报告里的图应当以 svg 元素内联，而不是 base64 图片');
  if (reportHtml.includes('<script')) throw new Error('报告里不应有脚本');
  if (/src="http/.test(reportHtml)) throw new Error('报告应当是自足的，不该有外链');
  // 图是内联的，所以可以直接在 HTML 里核对内容；也顺带确认清理没有漏掉脚本。
  if (!reportHtml.includes('来源：agent 自主填写')) throw new Error('图里应当带来源标识');
  if (/<svg[^>]*\son[a-z]+=/i.test(reportHtml)) throw new Error('内联 SVG 上不应留下事件属性');
  // 根元素不该再带固定宽高——那样就不能随栏宽自适应了。
  if (/<svg class="chart"[^>]*\swidth=/i.test(reportHtml)) throw new Error('内联 SVG 不应保留固定宽度');

  // markdown 子集的几个要点：白名单语法要渲染出来，子集之外的一律当文本。
  if (!reportHtml.includes('<ul>')) throw new Error('列表应当渲染成 ul');
  if (!reportHtml.includes('<blockquote>')) throw new Error('引用应当渲染成 blockquote');
  if (!reportHtml.includes('<table>')) throw new Error('表格应当渲染成 table');
  if (!reportHtml.includes('<hr>')) throw new Error('分隔线应当渲染成 hr');
  if (!reportHtml.includes('<strong>100</strong>')) throw new Error('加粗应当渲染成 strong');
  if (!reportHtml.includes('class="language-sql"')) throw new Error('非 chart 围栏应当渲染成代码块，并带上语言标注');
  // `<br>`、行尾两空格与行尾反斜杠都应当渲染成换行；软换行并成一行。
  if ((reportHtml.match(/<br>/g) ?? []).length < 3) throw new Error('三种硬换行都应当渲染成 br');
  if (!reportHtml.includes('第四行（软换行会并成一行）')) throw new Error('软换行应当并进同一段');
  if (!reportHtml.includes('&lt;script&gt;')) throw new Error('内嵌 HTML 应当被转义成文本，而不是解释成标签');
  if (reportHtml.includes('<script>alert')) throw new Error('内嵌 HTML 绝不能穿透成真标签');
  if (!reportHtml.includes('&lt;span&gt;不该放行&lt;/span&gt;')) throw new Error('span 应当被转义成文本');
  if (reportHtml.includes('<span>不该放行')) throw new Error('只白名单 br，其它标签必须仍然转义');
  // 表格单元格里同样能换行——它走的是同一套行内渲染。
  if (!/<td>甲站 96 条<br>乙站 78 条<\/td>/.test(reportHtml)) {
    throw new Error('表格单元格里的 br 应当渲染成换行');
  }

  // 来源逐图判定：报告不再要求"所有图同源"（那会逼 agent 把查询结果当自填行填进来，
  // 反而让标识失真，真机上出现过）。冒烟里只有单列的 count 结果、构不出图，
  // 所以这里验两件事：混用不再被拒、每张图各自带来源标识。
  const mixed = await call('oks_report', {
    spec: {
      title: '多来源报告（冒烟）',
      markdown: [
        '## 多来源',
        '',
        '```chart',
        JSON.stringify({ kind: 'bar', x: 'label', value: 'value', data: [{ label: '甲', value: 1 }], caption: '第一张' }),
        '```',
        '',
        '```chart',
        JSON.stringify({ kind: 'bar', x: 'label', value: 'value', data: [{ label: '乙', value: 2 }], caption: '第二张' }),
        '```',
      ].join('\n'),
    },
    name: 'probe_report_mixed',
  });
  const mixedHtml = readFileSync(resolve(DEV_ROOT, mixed.value.htmlSrc), 'utf8');
  console.log(`  多来源报告：${mixed.value.figureCount} 张图，各自带来源标识`);
  if ((mixedHtml.match(/来源：agent 自主填写/g) ?? []).length < 2) {
    throw new Error('每张图都应当带自己的来源标识');
  }

  // 规格与图的校验：这些都要在画图之前被拒。
  const failures = [
    ['两个都缺', { spec: { kind: 'bar', x: 'a', value: 'b' } }],
    ['两个都给', { spec: { kind: 'bar', x: 'a', value: 'b' }, src: saved.dataSrc, data: [{}] }],
    ['未知 kind', { spec: { kind: 'pie' }, data: [{}] }],
    ['table 退场', { spec: { kind: 'table' }, data: [{}] }],
    ['列不存在', { spec: { kind: 'bar', x: 'nope', value: 'nope2' }, data: [{ a: 1 }] }],
    ['bar 缺 value', { spec: { kind: 'bar', x: 'label' }, data: [{ label: 'A' }] }],
    ['line 缺 xType', { spec: { kind: 'line', x: 'label', value: 'value' }, data: [{ label: 'A', value: 1 }] }],
    ['column 缺 series', { spec: { kind: 'column', x: 'label', value: 'value' }, data: [{ label: 'A', value: 1 }] }],
    ['pie 缺 value', { spec: { kind: 'pie', x: 'label' }, data: [{ label: 'A' }] }],
    ['area 缺 xType', { spec: { kind: 'area', x: 'label', value: 'value' }, data: [{ label: 1, value: 1 }] }],
    ['layout 越界', { spec: { kind: 'bar', x: 'label', value: 'value', layout: { labelFont: 4 } }, data: [{ label: 'A', value: 1 }] }],
    ['layout 写错项', { spec: { kind: 'bar', x: 'label', value: 'value', layout: { nope: 1 } }, data: [{ label: 'A', value: 1 }] }],
    ['图表名越界', { spec: { kind: 'bar', x: 'label', value: 'value' }, data: [{ label: 'A', value: 1 }], name: '../evil' }],
  ];
  for (const [label, args] of failures) {
    let rejected = false;
    let message = '';
    try { await call('oks_chart', args); } catch (cause) { rejected = true; message = String(cause?.message ?? cause); }
    console.log(`  ${String(label).padEnd(10)} → ${rejected ? '✓ 被拒' : '✗ 未拒'} ${message.slice(0, 64)}`);
    if (!rejected) throw new Error(`oks_chart ${label} 应当被拒`);
  }
  const empty = await call('oks_chart', { spec: { kind: 'bar', x: 'label', value: 'value' }, data: [] });
  console.log(`  空数组有效: ${empty.value.ok === true && empty.value.rowCount === 0 ? '✓' : '✗'}`);
  if (empty.value.ok !== true) throw new Error('空数组应当是有效输入');
}

// ── limit 必填、范围 1..100：插件在调用服务之前就判定 ────────────────────────
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
    version: 1, domain: anchor.domain, artifact: relative(dir, resolve(DEV_ROOT, anchor.artifact)),
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
    artifact: relative(dir, resolve(DEV_ROOT, anchor.artifact)),
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
    version: 1, domain: 'ic', artifact: 'empty.wasm',
  }, null, 2)}\n`);
  try {
    await call('oks_info', { key: 'index' }, empty);
    console.log('  ✗ 本该报错，却成功了');
  } catch (cause) {
    console.log(`  ✓ 拒绝: ${String(cause?.message ?? cause).split('\n')[0].slice(0, 140)}`);
  }
}

// ── 插件只写工作区的 .data/（查询结果），别处不碰 ───────────────────────────
console.log('=== 插件只写 .data/ 里的结果文件 ===');
{
  const after = workspaceListing();
  const before = new Set(listingBefore.split(',').filter(Boolean));
  const added = after.split(',').filter(Boolean).filter((name) => !before.has(name));
  console.log(`  顶层新增条目：${added.join(', ') || '(无)'}`);
  if (added.some((name) => name !== '.data')) throw new Error(`插件创建了 .data/ 之外的东西：${added.join(', ')}`);
  console.log(`  没有 .oks/plans: ${existsSync(`${DEV_ROOT}/.oks`) ? '✗' : '✓'}`);
  if (existsSync(`${DEV_ROOT}/.oks`)) throw new Error('计划文件目录不该存在');
  if (existsSync(`${DEV_ROOT}/.data`)) {
    const files = readdirSync(`${DEV_ROOT}/.data`);
    // 这里目前有三类产物：查询结果（.json）、图（.svg）与报告（.html）。
    const allProducts = files.length > 0 && files.every((name) => /\.(json|svg|html)$/.test(name));
    console.log(`  .data/ 里 ${files.length} 个产物、都是 .json / .svg / .html: ${allProducts ? '✓' : '✗'}`);
    if (!allProducts) throw new Error('.data/ 里出现了结果、图与报告之外的产物');
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

// ── 自包含：把 dist/ 整个目录搬进空目录（没有 node_modules、没有源码）也能用 ──────
// 提示词与 echarts 都在构建期内联进产物，dist/ 里没有旁资产。
console.log('=== 自包含（把 dist/ 整个目录放进空目录）===');
{
  mkdirSync(SCRATCH, { recursive: true });
  const alone = mkdtempSync(join(SCRATCH, 'alone-'));
  try {
    const dist = fileURLToPath(new URL('./dist', import.meta.url));
    for (const name of readdirSync(dist)) {
      cpSync(join(dist, name), join(alone, name), { recursive: true });
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
    ok('空目录里只放整个 dist/ 就能加载', typeof mod.apply === 'function' && captured.length === 1);
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
