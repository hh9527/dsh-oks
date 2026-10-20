import {resolveSettings} from './src/config.ts';
import {testAttachments} from './test-attachments.ts';
// 集成冒烟：真实插件、动态领域发现与只读数据源；在隔离工作区执行。
import { apply, artifactName, buildOption, CHART_WIDTH, embedArtifactMeta, NAME_MAX, readArtifactMeta,
  renderEchartsSvg, resultStamp } from './lib/index.mjs';
import { checkAuthorXhtml, extractStructure, shrinkStructure, stripChartMetadata } from './src/report/xhtml.ts';
import { checkWellFormed, escapeText } from './src/report/xhtml.ts';
import { assetKey, buildReportPage, extractAssets, readReportPage, renderStructure, restoreAssets,
  REPORT_METADATA_ID } from './src/report/page.ts';
import { assembleReport } from './src/report/assemble.ts';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { singleFlight } from './src/single-flight.ts';
import { intentKey } from './src/key.ts';
import { CHART_KINDS, SERIES_COLORS, supports } from './src/chart/shared.ts';
import { tableMarkdown } from './src/view/table.ts';
// 来源链的读取与易读视图：冒烟直接调这一层，验证编码与边界（不经工具）。
import { canonicalJson, chainLines, readChartInput, recordId, rowsOf } from './src/results.ts';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync,
  symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DEV_ROOT = process.env.OKS_WORKSPACE ?? process.cwd();
const SCRATCH = `${DEV_ROOT}/oks-smoke`;
// 临时测试资源在专用子目录中创建。
const workspaceListing = () => readdirSync(DEV_ROOT).filter((name) => name !== 'oks-smoke').sort().join(',');
const listingBefore = workspaceListing();
// 目录里可能已经躺着上次跑剩下的文件，所以只看"这次新增的"。
const dataListingBefore = new Set(existsSync(`${DEV_ROOT}/artifacts`) ? readdirSync(`${DEV_ROOT}/artifacts`) : []);

const registered = new Map();
/** 插件在启动时注册的页面端点路径：漏注册一条（路由表里没有）时，界面上表现为"点了没反应"。 */
const webPaths = [];
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
  get: (name) => (name === 'attachments' ? testAttachments(SCRATCH) : name === 'skills'
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
  // 宿主没有 web 服务时插件照常工作，所以真机上这段是可选的；这里给一个桩，
  // 让"启动时注册了哪几条端点"进入测试视野。
  inject: (deps, callback) => {
    if (!Array.isArray(deps) || !deps.includes('webServer')) return;
    const services = {
      webServer: { register: (handler) => { webPaths.push(handler.path); return () => {}; } },
      sessions: { get: () => undefined },
      sessionQuery: { readSession: () => undefined },
    };
    callback({
      get: (name) => services[name],
      effect: (fn) => {
        const dispose = fn();
        if (typeof dispose === 'function') disposers.push(dispose);
      },
    });
  },
  // 插件按规范监听 agent/pre-step 以取得上下文时区；桩把监听器全部记下来，测试里手动触发。
  on: (name, listener) => listen(events, name, listener),
};

apply(ctx, {});
const toolNames = [...registered.keys()];
console.error(`registered tools: ${toolNames.join(', ')}\n`);
const EXPECTED_TOOLS = ['oks_read', 'oks_write', 'oks_edit', 'oks_list', 'oks_delete', 'oks_run_answer', 'oks_show', 'renew_context', 'oks_data',   'va_ask'];
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
  console.log(`  每个工具都有非空描述: ${described ? '✓' : '✗'}`);{
  if (webPaths.length) throw new Error('插件不应注册制品端点');
}

  if (!described) throw new Error('有工具的描述为空');
}
// exec 模拟 harness 传进来的 ToolRunContext：工作区从会话头里取，不由调用方给。
const sessions = new Map();
const sessionFor = (cwd) => {
  if (!sessions.has(cwd)) sessions.set(cwd, { id: `smoke-${sessions.size}`, header: { cwd } });
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

const builtin = (name, args = {}) => call('oks_data',{input:'oks://knowledge',
  method: `oks://builtin/tools/ktools.lib.jq#${name}`, args,
});

// 程序夹具：工具现在**只认文件**（参数是 `jq.src`），所以测试也把 jq 程序写进 `.work/` 再引用。
const progDir = resolve(DEV_ROOT, '.work');
let progSeq = 0;
const prog = (program) => {
  mkdirSync(progDir, { recursive: true });
  const name = `smoke_p${++progSeq}.jq`;
  writeFileSync(resolve(progDir, name), program);
  return `.work/${name}`;
};
const readKnowledge = async (key) => (await builtin('read',{key})).value.data;
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
// 知识与查询工具需要工作区；时间工具不需要。
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
let passed = 0;
const ok = (label, condition) => {
  if (!condition) throw new Error('✗ ' + label);
  passed += 1;
  console.log(`  ✓ ${label}`);
};

const refusalOf = async (run) => {
  try { await run(); return null; } catch (cause) { return String(cause?.message ?? cause); }
};
console.log('=== 检索层：并发的首次检索只派生一次索引 ===');
{
  const [left, right] = await Promise.all([
    builtin('search', { query: 'packet' }),
    builtin('search', { query: 'loss' }),
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

console.log('=== 知识发现与文档运行 ===');
const member=(await builtin('search',{type:'Dataset'})).value.data.items[0];
if(!member)throw new Error('没有发现数据集');
const countIntent={op:'Graph',root:'x',nodes:[{id:'x',entity:member.id}],edges:[],select:[],count:'x',limit:5};
const draftFile='.work/smoke_answer.dari';
const draftSource=`<Dari title="集成冒烟">
<Pipeline>
let ctx=context();
let months=time_windows(ctx,{unit:"month",count:2,mode:"complete"});
let plan=query(${JSON.stringify(countIntent)});
let facts=exec_query(plan);
let total=jq("total.jq",{facts});
debug(total);
</Pipeline>
<Asset language="jq" name="total.jq">.facts.rows[0] | to_entries[0].value</Asset>
<Template name="answer"><article><p>总数 <Value data={total} /></p></article></Template>
</Dari>`;
await call('oks_write',{path:draftFile,content:draftSource});
const firstRun=await call('oks_run_answer',{src:draftFile});
ok('真实查询与 jq 形成对话答案',firstRun.value.delivery.status==='ready' && firstRun.value.delivery.mode==='retained');
const total=(await call('oks_data',{input:draftFile+'#total'})).value.data;
ok('真实计数为非负数',typeof total==='number' && total>=0);
const secondRun=await call('oks_run_answer',{src:draftFile});
ok('重复运行复用全部计算',secondRun.value.counts.executed===0);
const shownReport=await call('oks_show',{input:draftFile+'#answer'});
ok('报告附件落盘',existsSync(shownReport.value.path));
const reportView=readReportPage(readFileSync(shownReport.value.path,'utf8'));
ok('报告携带实际数据和 jq 代码',reportView.items.value_1===total && Object.values(reportView.assets).some(code=>String(code).includes('to_entries')));
await call('oks_edit',{path:draftFile,old_string:'总数 ',new_string:'查询总数 '});
ok('改稿读取标记旧运行', (await call('oks_data',{input:draftFile+'#total'})).value.stale===true);
const edited=await call('oks_run_answer',{src:draftFile});
ok('仅模板变更复用查询',edited.value.counts.executed===1 && edited.value.batch===firstRun.value.batch);
const refreshed=await call('oks_run_answer',{src:draftFile,refresh:true});
ok('刷新建立新采集批次',refreshed.value.batch!==firstRun.value.batch);
for(const limit of [undefined,0,501,1.5]){
 const intent={...countIntent,limit};
 await call('oks_write',{path:draftFile,content:draftSource.replace(JSON.stringify(countIntent),JSON.stringify(intent))});
 const invalid=await call('oks_run_answer',{src:draftFile});
 ok('非法 limit 在业务执行前拒绝',invalid.value.status==='invalid');
}
await call('oks_write',{path:draftFile,content:draftSource});
await call('oks_run_answer',{src:draftFile});
// Workspace configuration and executor failures must surface through the current tools.
const settings=resolveSettings(DEV_ROOT,undefined);
const baseConfig=JSON.parse(readFileSync(join(DEV_ROOT,'oks.json'),'utf8'));
for(const [name,patch] of [
 ['missing-data',{dataFile:undefined}],
 ['bad-data',{dataFile:join(SCRATCH,'not-sqlite')}],
]){
 const dir=join(SCRATCH,name);mkdirSync(join(dir,'.work'),{recursive:true});
 writeFileSync(join(SCRATCH,'not-sqlite'),'not a database');
 writeFileSync(join(dir,'oks.json'),JSON.stringify({...baseConfig,model:settings.model,...patch}));
 writeFileSync(join(dir,draftFile),draftSource);
 const result=await call('oks_run_answer',{src:draftFile},dir);
 ok('不可用数据源不形成成功查询',result.value.delivery.status==='unavailable' && result.value.counts.failed>0);
}
const nested=join(SCRATCH,'nested');mkdirSync(join(nested,'.work'),{recursive:true});
writeFileSync(join(nested,'oks.json'),JSON.stringify({...baseConfig,model:relative(nested,settings.model),dataFile:relative(nested,settings.dataFile)}));
writeFileSync(join(nested,draftFile),draftSource);
ok('模型与数据源相对 oks.json 解析',(await call('oks_run_answer',{src:draftFile},nested)).value.delivery.status==='ready');
const bare=join(SCRATCH,'bare');mkdirSync(bare,{recursive:true});
ok('缺工作区配置明确拒绝',!!await refusalOf(()=>call('oks_data',{input:'oks://knowledge',project:'Shape'},bare)));
const badModel=join(SCRATCH,'bad-model');mkdirSync(badModel,{recursive:true});
writeFileSync(join(badModel,'empty.wasm'),Buffer.from([0,97,115,109,1,0,0,0]));
writeFileSync(join(badModel,'oks.json'),JSON.stringify({...baseConfig,model:'empty.wasm',dataFile:settings.dataFile}));
ok('缺快照模型明确拒绝',!!await refusalOf(()=>call('oks_data',{input:'oks://knowledge',project:'Shape'},badModel)));
const help=(await call('oks_data',{input:'oks://help/query'})).value.data;
ok('帮助使用主题索引',help.topics.includes('graph/filter'));
for(const args of [{load:{}},{input:draftFile+'#total',save:{}},{input:draftFile+'#total',jq:{src:'.work/nope.jq'}}])
 ok('只读入口拒绝加工与写入参数',!!await refusalOf(()=>call('oks_data',args)));
if(process.env.OKS_TOOLS_MODULE){
 const host=await import(pathToFileURL(resolve(process.env.OKS_TOOLS_MODULE)).href);
 for(const name of ['oks_run_answer','oks_data']){
  host.assertSupportedJsonSchema(registered.get(name).parameters);
  ok(`${name} schema 属于宿主支持的子集`,true);
 }
}
console.log('=== 产物命名 ===');
{
  const sha = (text) => createHash('sha256').update(text).digest('hex');
  const svg = '<svg/>';
  // 图的名字里写的是图元本身（`<名>.bar.svg`）；artifactName 收到的 kind 是**文件类别**。
  const named = artifactName({ at: '20261010T115343Z', name: 'alarm_by_level', kind: 'bar', extension: '.svg', content: svg });
  ok('名字里那段就是内容哈希（前缀 8 位）',
    named === `20261010T115343Z-alarm_by_level-${sha(svg).slice(0, 8)}.bar.svg`);
  ok('时间戳到秒', /^\d{8}T\d{6}Z$/.test(resultStamp()));
  // 内容不是一次拿到时那一段可以省掉（现在没有调用方这么做，但格式留了这个位置）。
  ok('没有内容就没有哈希段',
    artifactName({ at: '20261010T115343Z', name: 'x', kind: 'qres', extension: '.json' }) === '20261010T115343Z-x.qres.json');

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

  console.log(`  自述：${back?.title} · at=${back?.at}`);
}
console.log('=== oks_delete：代码区删除 ===');
{
  await call('oks_write', { path: '.work/doomed.jq', content: '. | length\n' });
  await call('oks_write', { path: '.work/kept.jq', content: '.\n' });
  const removed = await call('oks_delete', { path: '.work/doomed.jq' });
  ok('删掉一份程序：回执给删了哪个、还剩几个',
    removed.value.ok === true && /doomed\.jq$/.test(String(removed.value.file))
    && typeof removed.value.remaining === 'number');
  ok('文件确实没了，另一份还在',
    !existsSync(join(DEV_ROOT, '.work', 'doomed.jq')) && existsSync(join(DEV_ROOT, '.work', 'kept.jq')));
  const fails = async (args: unknown): Promise<string> => {
    try { await call('oks_delete', args); return ''; } catch (cause) { return String((cause as Error).message); }
  };
  mkdirSync(join(DEV_ROOT, '.work', 'subdir'), { recursive: true });
  const missing = await fails({ path: '.work/nope.jq' });
  const isDir = await fails({ path: '.work/subdir' });
  const escape = await fails({ path: '../evil.jq' });
  console.log(`  oks_delete 的三种拒绝 → ${missing.slice(0, 60)} / ${isDir.slice(0, 40)} / ${escape.slice(0, 40)}`);
  ok('删除不存在的文件时只说找不到，不倒清单', /找不到/.test(missing) && !/kept\.jq/.test(missing));
  ok('目标是目录时明确拒绝', /只能删文件/.test(isDir));
  ok('越界被拒', /完整文件路径/.test(escape));
  rmSync(join(DEV_ROOT, '.work', 'subdir'), { recursive: true, force: true });
  await call('oks_delete', { path: '.work/kept.jq' });
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
      get: (name) => (name === 'attachments' ? testAttachments(SCRATCH) : name === 'skills'
        ? { register: (skill) => { captured.push(skill); return () => {}; } }
        : undefined),
      tools: { register: () => () => {} },
      // effect 的回调必须真的执行：技能注册就在里面（收 dispose 即可）。
      effect: (fn) => { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {}; },
      on: () => () => {},
    }, {});
    ok('空目录里只放整个 lib/ 就能加载', typeof mod.apply === 'function' && captured.length === 1);
    ok('技能正文来自内联（与 asset/skill.md 逐字一致）',
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
    ok('空目录里也能出图（echarts 已打进产物）',
      svg.startsWith('<svg') && svg.includes('<path'));
    // 唯一的旁资产：求值器的 .wasm。它必须与 index.mjs 同目录跟着 lib/ 走，而且**真的能算**——
    // 「能加载」不等于「是那个引擎」。越界能力（now / env / include…）由 crates/oks-wti/check.mjs 逐条断言。
    const engine = new WebAssembly.Module(readFileSync(join(alone, 'oks-wti.wasm')));
    ok('旁资产：oks-wti.wasm 与 index.mjs 同目录，且零 host imports',
      WebAssembly.Module.imports(engine).length === 0);
    const wasm = new WebAssembly.Instance(engine, {}).exports as {
      alloc: (n: number) => number; dealloc: (p: number, n: number) => void;
      run: (
        pp: number, pl: number, np: number, nl: number, ip: number, il: number, maxBytes: number,
      ) => number;
      memory: WebAssembly.Memory;
    };
    const put = (text: string): { ptr: number; len: number } => {
      const bytes = new TextEncoder().encode(text);
      const ptr = wasm.alloc(bytes.length);
      new Uint8Array(wasm.memory.buffer, ptr, bytes.length).set(bytes);
      return { ptr, len: bytes.length };
    };
    const program = put('[1,2,3] | map(. + 1)');
    // 第二个参数是程序名：只用于报错排版（空串按 <inline>）。
    const programName = put('');
    const input = put('null');
    const outPtr = wasm.run(
      program.ptr, program.len, programName.ptr, programName.len, input.ptr, input.len, 0);
    const view = new DataView(wasm.memory.buffer);
    const outLen = view.getUint32(outPtr + 1, true);
    const outText = new TextDecoder().decode(new Uint8Array(wasm.memory.buffer, outPtr + 5, outLen)).trim();
    wasm.dealloc(outPtr, outLen + 5);
    wasm.dealloc(program.ptr, program.len);
    wasm.dealloc(programName.ptr, programName.len);
    wasm.dealloc(input.ptr, input.len);
    // ABI：成功时 payload 就是程序产出的单个 JSON 值。
    ok('旁资产：wasm 引擎在里面算得出结果', outText === '[2,3,4]', outText);
    // 求值器不再是子进程：产物里没有 child_process（引擎是 worker 里的 wasm 实例）。
    ok('产物里没有 child_process（求值不再起进程）', !text.includes('child_process'));
  } finally {
    rmSync(alone, { recursive: true, force: true });
  }
}

// 结构区 XHTML（RFC 0008 的地基）：校验、缩水与读回都只走 asset/report/xhtml.ts 这一层。
// 这里守的是三处输入各自的严格度：作者正文最严，我们自己的 .svg 与页面按词法进出。
{
  const good = '<article id="a"><!-- 先看趋势。 --><h2>趋势</h2>'
    + '<p>同比 <span data-oks-ref="summary" data-oks-pick=".growth">12%</span>。</p>'
    + '<figure data-oks-ref="trend"><figcaption>趋势</figcaption></figure>'
    + '<p data-oks-shrink="">三月最高。</p><br /></article>';
  const checked = checkAuthorXhtml(good);
  ok('作者结构区：合规正文零错误', checked.errors.length === 0);
  ok('作者结构区：引用被收集（含结论里的单值引用）',
    checked.refs.includes('summary') && checked.refs.includes('trend'));
  ok('作者结构区：意图注释被读到', checked.comments.some((text) => text.includes('先看趋势')));

  const voidBad = checkAuthorXhtml('<article><p>换行<br>没写斜杠</p></article>');
  ok('作者结构区：<br> 必须写 <br />（空元素靠标签名当闭合是错）',
    voidBad.errors.some((error) => error.code === 'author-void'));

  const entityBad = checkAuthorXhtml('<article><p>空&nbsp;格</p></article>');
  ok('作者结构区：&nbsp; 报错（XML 只认五个预定义实体）',
    entityBad.errors.some((error) => error.code === 'xhtml-not-well-formed'));
  ok('作者结构区：报错带行列', entityBad.errors.every((error) => error.line >= 1 && error.column >= 1));

  const prefixed = checkAuthorXhtml('<article><p><svg:path d="M0 0" /></p></article>');
  ok('作者结构区：带前缀的名字按名字比对，不在白名单里就拒',
    prefixed.errors.some((error) => error.code === 'author-element'));

  ok('作者结构区：figure 必须带引用',
    checkAuthorXhtml('<article><figure><figcaption>x</figcaption></figure></article>')
      .errors.some((error) => error.code === 'author-figure-ref'));
  ok('作者结构区：pick 只写在带引用的 span 上',
    checkAuthorXhtml('<article><p data-oks-pick=".x">y</p></article>')
      .errors.some((error) => error.code === 'author-pick-element')
    && checkAuthorXhtml('<article><span data-oks-pick=".x">y</span></article>')
      .errors.some((error) => error.code === 'author-pick-ref'));
  ok('作者结构区：摘取路径只支持字段名与下标',
    checkAuthorXhtml('<article><span data-oks-ref="s" data-oks-pick=".a[0]">y</span></article>')
      .errors.some((error) => error.code === 'author-pick'));

  const before = '<article><!-- 意图 --><p>同比 '
    + '<span data-oks-ref="summary" data-oks-pick=".growth">12%</span>。</p>'
    + '<figure data-oks-ref="trend"><figcaption>趋势</figcaption><div>图</div></figure>'
    + '<p data-oks-shrink="">三月最高。</p></article>';
  const shrunk = shrinkStructure(before).xml;
  ok('缩水：span 里以注释保留实际值，元素与属性保留',
    shrunk.includes('<span data-oks-ref="summary" data-oks-pick=".growth"><!-- 12% --></span>'));
  ok('缩水：figure 的子节点换成省略标记（图注也随范围清掉）',
    shrunk.includes('<figure data-oks-ref="trend"><!-- omitted --></figure>'));
  ok('缩水：shrink 元素为文本摘要注释、属性保留', shrunk.includes('<p data-oks-shrink=""><!-- 三月最高。 --></p>'));
  ok('缩水：范围外的注释原样保留', shrunk.includes('<!-- 意图 -->'));
  ok('缩水：重复缩水结果相同', shrinkStructure(shrunk).xml === shrunk);
  ok('缩水：嵌套按最外层决定',
    shrinkStructure('<article><div data-oks-shrink=""><span data-oks-ref="x">1</span></div></article>').xml
    === '<article><div data-oks-shrink=""><!-- 1 --></div></article>');

  const page = '<html><head><script type="application/json" id="oks-metadata">{}</script></head>'
    + '<body><header>外壳</header><article id="a"><p>正文</p></article><footer>页脚</footer></body></html>';
  ok('读回：只取 article，外壳与页脚不进结构',
    extractStructure(page, false).xml === '<article id="a"><p>正文</p></article>');
  ok('读回：同一次重写里完成缩水',
    extractStructure('<html><body><article><figure data-oks-ref="f"><div>图</div></figure></article></body></html>', true).xml
    === '<article><figure data-oks-ref="f"><!-- omitted --></figure></article>');

  const svg = '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 1 1">'
    + '<metadata id="dsh-oks-artifact">{"name":"x"}</metadata>'
    + '<style>.a{fill:red}</style><path d="M0 0"></path>'
    + '<metadata id="dsh-oks-chart-input">{}</metadata></svg>';
  const stripped = stripChartMetadata(svg).xml;
  ok('内联 SVG：两段 metadata 整段剥掉', !stripped.includes('metadata'));
  ok('内联 SVG：xmlns 与 xmlns:xlink 原样透传（命名空间不解释）',
    stripped.includes('xmlns="http://www.w3.org/2000/svg"') && stripped.includes('xmlns:xlink='));
  ok('内联 SVG：样式与路径保留',
    stripped.includes('<style>.a{fill:red}</style>') && stripped.includes('<path d="M0 0"></path>'));
}
// 报告页面（RFC 0008 §3）：元数据区 + 结构区，写出来与读回来都走 asset/report/page.ts。
{
  const origin = {
    root: 'r1',
    nodes: {
      r1: { kind: 'report', inputs: { summary: 't1' } },
      t1: { kind: 'transform', snip: 'map(.n)', snipFile: '.work/count.jq', motivation: '数一数', inputs: { src: 'q1' } },
      q1: { kind: 'query', intent: { domain: 'd', note: '<x>' } },
    },
  };
  const archived = extractAssets(origin);
  const key = Object.keys(archived.assets)[0];
  ok('资源归档：key 是「文件名主干-源码哈希前 16 位」', /^count-[0-9a-f]{16}$/.test(key ?? ''));
  ok('资源归档：节点改成 src:// 引用，正文只存在于 assets',
    archived.origin.nodes.t1?.byFile === `src://${key}` && archived.origin.nodes.t1?.snip === undefined);
  ok('资源归档：还原后与提取前逐字段一致',
    JSON.stringify(restoreAssets(archived.origin, archived.assets)) === JSON.stringify(origin));
  ok('资源归档：没有程序的节点原样保留',
    archived.origin.nodes.q1?.kind === 'query' && archived.origin.nodes.q1?.byFile === undefined);
  const shared = extractAssets({ root: 'a', nodes: {
    a: { kind: 'transform', snip: 'x', snipFile: 'p.jq' },
    b: { kind: 'transform', snip: 'x', snipFile: 'p.jq' },
  } });
  ok('资源归档：同主干同源码只存一份', Object.keys(shared.assets).length === 1);
  ok('资源归档：不同源码得到不同 key', assetKey('p.jq', 'x') !== assetKey('p.jq', 'y'));

  const rendered = renderStructure({
    xhtml: '<article><h2>趋势</h2><p>同比 <span data-oks-ref="summary" data-oks-pick=".growth"></span>。</p>'
      + '<figure data-oks-ref="trend"><figcaption>趋势</figcaption></figure></article>',
    outline: [{ level: 2, text: '趋势', id: 'section-1' }],
    valueOf: (ref, pick) => `${ref}${pick ?? ''}`,
    inlineOf: (ref) => (ref === 'trend' ? { html: '<div class="inline">图</div>', label: '图 1' } : undefined),
  });
  ok('渲染：span 填入绑定值，并带上引用键 + 路径的悬停提示',
    rendered.article.includes('<span data-oks-ref="summary" data-oks-pick=".growth" title="summary.growth">'
      + 'summary.growth</span>'));
  ok('渲染：图内联进 figure、图注戴编号',
    rendered.article.includes('<figcaption><span class="item-no">图 1</span>趋势</figcaption>')
    && rendered.article.includes('<div class="inline">图</div></figure>'));

  const page = buildReportPage({
    meta: { kind: 'report', name: 'demo', at: '20260101T000000Z', title: '演示' },
    subtitle: '当月',
    generatedAt: '2026-01-01T00:00:00Z',
    article: rendered.article,
    origin: archived.origin,
    assets: archived.assets,
    items: { summary: { growth: '12%' }, note: 'a < b & c' },
    outline: [{ level: 2, text: '趋势', id: 'section-1' }],
  });
  ok('页面：元数据区在页面里，JSON 里的 < 与 & 已转义',
    page.includes(`<script type="application/json" id="${REPORT_METADATA_ID}">`)
    && page.includes('\\u003c') && page.includes('\\u0026'));
  ok('页面：写入自校验为良构 XML（含样式表、目录与中文）', checkWellFormed(page).length === 0);
  ok('页面：有来源的数字带浅绿背景样式，并带引用键的悬停提示',
    page.includes('span[data-oks-ref]') && page.includes('title="summary.growth"'));

  const back = readReportPage(page);
  ok('读回：拿到 origin/assets/items 与缩水后的结构区',
    !('error' in back) && Object.keys(back.assets).length === 1
    && back.structure.includes('<!-- summary.growth --></span>') && back.items.summary.growth === '12%'
    && back.structure.includes('<figure data-oks-ref="trend"><!-- omitted --></figure>'));
  ok('读回：外壳、目录与页脚都不进结构区',
    !('error' in back) && !back.structure.includes('<header>')
    && !back.structure.includes('<nav>') && !back.structure.includes('<footer>'));
  ok('读回：范围外的正文与目录锚点都保留',
    !('error' in back) && back.structure.includes('<h2 id="section-1">趋势</h2>'));
  // 组装（纯函数）：校验 → 绑定过滤 → 编号 → 渲染 → 归档 → 页面。
  const makeBinding = (value, display) => ({
    src: 'oks://work/analysis.dari#x',
    root: '.data',
    value,
    origin: { root: 'n1', nodes: { n1: { kind: 'transform', snip: 'x', snipFile: 'p.jq' } } },
    ...(display === undefined ? {} : { display }),
  });
  const assembleBase = {
    name: 'r', title: '标题', subtitle: null, category: '即时分析', at: '20260101T000000Z',
  };
  const assembled = assembleReport({
    ...assembleBase,
    xhtml: '<article><h2>趋势</h2><p>同比 <span data-oks-ref="summary" data-oks-pick=".growth"></span>。</p>'
      + '<figure data-oks-ref="trend"><figcaption>趋势</figcaption></figure></article>',
    bindings: {
      summary: makeBinding({ growth: '12%' }),
      trend: makeBinding({ rows: [] }, {
        kind: 'chart',
        content: '<svg xmlns="http://www.w3.org/2000/svg">'
          + '<metadata id="dsh-oks-chart-input">{}</metadata><path d="M0 0"></path></svg>',
      }),
    },
    valueOf: (ref, pick) => (pick === '.growth' ? { value: '12%' } : { error: `缺值 ${ref}${pick ?? ''}` }),
  });
  ok('组装：产出页面、来源与资源（源码以 src:// 引用）',
    !('error' in assembled) && assembled.page.includes(`id="${REPORT_METADATA_ID}"`)
    && assembled.page.includes('src://') && Object.keys(assembled.assets).length === 1);
  ok('组装：图按出现顺序编号并戴上 chip',
    !('error' in assembled) && assembled.page.includes('图 1</span>趋势'));
  ok('组装：内联的图剥掉了它自己的材料块',
    !('error' in assembled) && !assembled.page.includes('dsh-oks-chart-input'));
  ok('组装：目录锚点补进标题、导航指向它',
    !('error' in assembled) && assembled.page.includes('<h2 id="section-1">趋势</h2>')
    && assembled.page.includes('href="#section-1"'));
  ok('组装：来源链记下每个绑定的选取路径与根节点',
    !('error' in assembled) && assembled.origin.nodes[assembled.origin.root].inputPaths.summary === '.data');
  const unbound = assembleReport({
    ...assembleBase,
    xhtml: '<article><p><span data-oks-ref="nope" data-oks-pick="."></span></p></article>',
    bindings: {}, valueOf: () => ({ value: 'x' }),
  });
  ok('组装：正文引用了没绑定的项就报错', 'error' in unbound && unbound.error.includes('nope'));
  const spare = assembleReport({
    ...assembleBase,
    xhtml: '<article><p>纯文字</p></article>',
    bindings: { spare: makeBinding(1) }, valueOf: () => ({ value: 'x' }),
  });
  ok('组装：绑定没被正文引用也报错', 'error' in spare && spare.error.includes('spare'));
  const badValue = assembleReport({
    ...assembleBase,
    xhtml: '<article><p><span data-oks-ref="x" data-oks-pick="."></span></p></article>',
    bindings: { x: makeBinding({ rows: [] }) }, valueOf: () => ({ error: '这个值不是标量' }),
  });
  ok('组装：取值失败时把原因带出来', 'error' in badValue && badValue.error.includes('不是标量'));
  const badBody = assembleReport({
    ...assembleBase,
    xhtml: '<article><br></article>', bindings: {}, valueOf: () => ({ value: 'x' }),
  });
  ok('组装：正文不合规时连行列一起报出来',
    'error' in badBody && badBody.error.includes('第 1 行') && badBody.error.includes('要改'));

  const metaRaw = new RegExp(`<script type="application/json" id="${REPORT_METADATA_ID}">([\\s\\S]*?)</script>`)
    .exec(page)?.[1] ?? '';
  ok('元数据区只序列化 { origin, assets, items }，不夹带正文',
    JSON.stringify(Object.keys(JSON.parse(metaRaw)).sort()) === JSON.stringify(['assets', 'items', 'origin'])
    && !metaRaw.includes('<article'));

  const chartBinding = () => makeBinding({ rows: [] }, {
    kind: 'chart',
    content: '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"></path></svg>',
  });
  const singleQuoted = assembleReport({
    ...assembleBase,
    xhtml: "<article><figure data-oks-ref='trend'><figcaption>趋势</figcaption></figure></article>",
    bindings: { trend: chartBinding() }, valueOf: () => ({ value: 'x' }),
  });
  ok('单引号写的 data-oks-ref 一样编号并内联',
    !('error' in singleQuoted) && singleQuoted.page.includes('图 1</span>趋势')
    && singleQuoted.page.includes('<path d="M0 0"></path>'));

  const selfClosed = assembleReport({
    ...assembleBase,
    xhtml: '<article><figure data-oks-ref="trend" /></article>',
    bindings: { trend: chartBinding() }, valueOf: () => ({ value: 'x' }),
  });
  ok('自闭合 figure 的内联图落在容器里面',
    !('error' in selfClosed)
    && /<figure data-oks-ref="trend">[\s\S]*<path d="M0 0"><\/path>[\s\S]*<\/figure>/.test(selfClosed.page));

  const notDisplay = assembleReport({
    ...assembleBase,
    xhtml: '<article><figure data-oks-ref="d"></figure></article>',
    bindings: { d: makeBinding({ rowCount: 1 }) }, valueOf: () => ({ value: 'x' }),
  });
  ok('figure 绑到非展示件时报错', 'error' in notDisplay && notDisplay.error.includes('不是图或表展示件'));

  const sliced = assembleReport({
    ...assembleBase,
    xhtml: '<article><figure data-oks-ref="trend"></figure></article>',
    bindings: { trend: { ...chartBinding(), root: '.data.rows' } }, valueOf: () => ({ value: 'x' }),
  });
  ok('figure 绑定不接受自选 root（要整件展示）',
    'error' in sliced && sliced.error.includes('只能整件展示'));

}
  const gaugeMarked = (buildOption(
    [{ name: 'A', v: 88 }],
    { kind: 'gauge', title: null, x: 'name', value: 'v', series: null, marks: [{ value: 80 }] } as never,
  ).option as { series: Array<{ axisLine: { lineStyle: { color?: unknown } } }> }).series[0]!;
  ok('gauge：marks 画成阈值刻度（80 之前正常色、之后警戒色）',
    JSON.stringify(gaugeMarked.axisLine.lineStyle.color ?? '').includes('0.8'));

  const gaugeSeries = (buildOption(
    [{ name: 'A', v: 60 }, { name: 'B', v: 75 }],
    { kind: 'gauge', title: null, x: 'name', value: 'v', series: null } as never,
  ).option as { series: Array<{ min: number; max: number; data: Array<{ name: string; value: number }> }> }).series;
  ok('gauge：每行一张小仪表，值按 0–100 读',
    gaugeSeries.length === 2
    && gaugeSeries.every((one) => one.min === 0 && one.max === 100)
    && gaugeSeries[0]!.data[0]!.name === 'A' && gaugeSeries[0]!.data[0]!.value === 60);
  let gaugeOverflow = '';
  try {
    buildOption([{ name: 'A', v: 120 }],
      { kind: 'gauge', title: null, x: 'name', value: 'v', series: null } as never);
  } catch (cause) {
    gaugeOverflow = String((cause as Error)?.message ?? cause);
  }
  ok('gauge：超出 0–100 明确报错并给出两条出路',
    gaugeOverflow.includes('0–100') && gaugeOverflow.includes('bar'));

  const piePlain = buildOption([{ k: 'A', w: 3 }, { k: 'B', w: 2 }],
    { kind: 'pie', title: null, x: 'k', value: 'w', series: null } as never).option as {
      series: Array<{ radius: [string, string] }> };
  const pieDonut = buildOption([{ k: 'A', w: 3 }, { k: 'B', w: 2 }],
    { kind: 'pie', title: null, x: 'k', value: 'w', series: null, donut: true } as never).option as {
      series: Array<{ radius: [string, string] }> };
  ok('pie：donut 打开就是环形（中心留白），关掉仍是实心',
    piePlain.series[0]!.radius[0] === '0%' && pieDonut.series[0]!.radius[0] === '45%');

  // 断点：缺失点处断开（SVG 里是两段 path），打开 connectNulls 才连起来。
  // 缺口是"这段没有数据"，连起来会被读成"这段数据是平的"——两种读法在图上必须分得开。
  // 「工具收下了」不等于「画出来了」，所以这里数的是渲染出来的那条线有几个起点。
  const gapRows = [
    { d: '2026-01-01', s: '甲', w: 3 }, { d: '2026-01-02', s: '甲', w: 4 },
    { d: '2026-01-03', s: '甲', w: 5 }, { d: '2026-01-04', s: '甲', w: 6 },
    { d: '2026-01-01', s: '乙', w: 6 }, { d: '2026-01-03', s: '乙', w: 4 }, { d: '2026-01-04', s: '乙', w: 5 },
  ];
  const gapSpec = (extra: Record<string, unknown>) => ({
    kind: 'line', title: null, x: 'd', value: 'w', series: 's',
    xType: null, xLabel: null, valueLabel: null, unit: null, ...extra,
  });
  const gapSegments = (spec: Record<string, unknown>): number[] => {
    const built = buildOption(gapRows, spec as never);
    const svg = renderEchartsSvg(built.option, CHART_WIDTH, built.height);
    return [...svg.matchAll(/<path d="([^"]*)"[^>]*stroke-linejoin="bevel"/g)]
      .map(([, d]) => ((d ?? '').match(/M/g) ?? []).length)
      .sort((a, b) => a - b);
  };
  ok('断点：缺失点处断开（有缺口的那条线画成两段）',
    JSON.stringify(gapSegments(gapSpec({}))) === '[1,2]');
  ok('断点：打开 connectNulls 才连成一条（不写就是断开）',
    JSON.stringify(gapSegments(gapSpec({ connectNulls: true }))) === '[1,1]');
  // 时间轴走另一条数据装配路（[时间, 值]）：过去这里把缺的那一行整个删掉，缺口就消失了。
  ok('断点：时间轴上的缺失点同样断开，不连过去',
    JSON.stringify(gapSegments(gapSpec({ xType: 'time' }))) === '[1,2]'
    && JSON.stringify(gapSegments(gapSpec({ xType: 'time', connectNulls: true }))) === '[1,1]');

  // 颜色跟实体：颜色由名字决定，同一个机房在饼图与折线图里同色，颜色能跨图对照；
  // 不打开则照旧按序列序号取色（既有图的样子不变）。
  const entityPie = [{ k: '机房甲', w: 5 }, { k: '机房乙', w: 3 }, { k: '机房丙', w: 2 }];
  const entityLine = [
    { d: 'D1', s: '机房丙', w: 2 }, { d: 'D1', s: '机房甲', w: 5 },
    { d: 'D2', s: '机房乙', w: 3 }, { d: 'D2', s: '机房甲', w: 4 },
  ];
  const pieColorOf = (entityColor: boolean | null): Record<string, string> => Object.fromEntries(
    (buildOption(entityPie, {
      kind: 'pie', title: null, x: 'k', value: 'w', series: null, entityColor,
    } as never)
      .option as { series: Array<{ data: Array<{ name: string; itemStyle: { color: string } }> }> })
      .series[0]!.data.map((slice) => [slice.name, slice.itemStyle.color]));
  const lineColorOf = (rows: readonly Record<string, unknown>[], entityColor: boolean | null): Record<string, string> =>
    Object.fromEntries(
      (buildOption(rows, {
        kind: 'line', title: null, x: 'd', value: 'w', series: 's',
        xType: null, xLabel: null, valueLabel: null, unit: null, entityColor,
      } as never)
        .option as { series: Array<{ name: string; itemStyle: { color: (params: { value: number }) => string } }> })
        .series.map((one) => [one.name, one.itemStyle.color({ value: 1 })]));
  const namedPie = pieColorOf(true);
  const namedLine = lineColorOf(entityLine, true);
  ok('颜色跟实体：同一个实体在饼图与折线图里同色',
    Object.keys(namedPie).every((name) => namedPie[name] === namedLine[name]));
  ok('颜色跟实体：同一张图里不同实体不同色',
    new Set(Object.values(namedPie)).size === 3 && new Set(Object.values(namedLine)).size === 3);
  const reversedLine = lineColorOf([...entityLine].reverse(), true);
  ok('颜色跟实体：行序变了颜色不变（颜色跟名字，不跟行序）',
    Object.keys(namedLine).every((name) => namedLine[name] === reversedLine[name]));
  ok('颜色跟实体：不打开时照旧按序号取色（默认图的样子不变）',
    pieColorOf(null)['机房甲'] === SERIES_COLORS[0] && pieColorOf(null)['机房乙'] === SERIES_COLORS[1]);

  const graphRows = [
    { id: 'core', label: '核心', depth: 0 },
    { id: 'agg', label: '汇聚', depth: 1 },
    { id: 'acc1', label: '接入 1', depth: 2 },
    { id: 'acc2', label: '接入 2', depth: 2 },
  ];
  const graphEdges = [
    { from: 'core', to: 'agg' }, { from: 'agg', to: 'acc1' },
    { from: 'agg', to: 'acc2' }, { from: 'agg', to: 'acc1' },   // 重复边 → 合并
    { from: 'ghost', to: 'agg' },                                // 端点不在节点表 → 不进图
  ];
  const graphSpec = { kind: 'graph', title: null, x: 'from', series: 'to', value: '' };
  const graphOf = (rows, spec, nodes) => (buildOption(rows, spec as never, nodes as never).option as {
    series: Array<{ data: Array<{ name: string; x: number; y: number }>; links: unknown[] }>;
  }).series[0]!;
  const graphOne = graphOf(graphEdges, graphSpec, graphRows);
  const graphTwo = graphOf(graphEdges, graphSpec, graphRows);
  const at = new Map(graphOne.data.map((node) => [node.name, node]));
  ok('graph：按 depth 分层（同层同列、层间递进）',
    at.get('core')!.x < at.get('agg')!.x && at.get('agg')!.x < at.get('acc1')!.x
    && at.get('acc1')!.x === at.get('acc2')!.x && at.get('acc1')!.y !== at.get('acc2')!.y);
  ok('graph：两次渲染坐标一致（分层是确定的，不靠力引导）',
    JSON.stringify(graphOne.data) === JSON.stringify(graphTwo.data));
  ok('graph：重复边合并、端点不在节点表里的边不进图', graphOne.links.length === 3);
  const parallel = graphOf(
    [{ from: 'core', to: 'agg', label: '经 site_id' }, { from: 'core', to: 'agg', label: '经 region' },
      { from: 'core', to: 'agg', label: '经 site_id' }],
    graphSpec,
    graphRows,
  );
  ok('graph：平行边按关系名区分（不同关系名各留一条，三样都相同才合并）',
    parallel.links.length === 2
    && (parallel.links as Array<{ label: string }>).map((link) => link.label).sort().join(',')
      === '经 region,经 site_id');
  const colored = graphOf([{ from: 'a', to: 'b' }], graphSpec, [
    { id: 'a', category: '机房', depth: 0 }, { id: 'b', category: '机房', depth: 1 },
    { id: 'c', category: '链路', depth: 2 },
  ]);
  ok('graph：category 决定颜色（同类同色、异类异色）',
    (colored.data as Array<{ name: string; itemStyle?: { color?: string } }>)[0]!.itemStyle?.color
      === (colored.data as Array<{ name: string; itemStyle?: { color?: string } }>)[1]!.itemStyle?.color
    && (colored.data as Array<{ name: string; itemStyle?: { color?: string } }>)[0]!.itemStyle?.color
      !== (colored.data as Array<{ name: string; itemStyle?: { color?: string } }>)[2]!.itemStyle?.color);

  const focused = graphOf([{ from: 'a', to: 'b' }], graphSpec, [
    { id: 'a', status: 'focus', depth: 0 }, { id: 'b', depth: 1 },
  ]);
  const focusNodes = focused.data as unknown as Array<{
    name: string; symbolSize: number; itemStyle?: { color?: string };
  }>;
  ok('graph：status=focus 的节点强调、其余退为灰',
    focusNodes[0]!.symbolSize > focusNodes[1]!.symbolSize
    && focusNodes[1]!.itemStyle?.color === '#c8d2dc'
    && focusNodes[0]!.itemStyle?.color !== '#c8d2dc');

  let graphDepth = '';
  try {
    graphOf([{ from: 'a', to: 'b' }], graphSpec, [{ id: 'a' }, { id: 'b' }]);
  } catch (cause) { graphDepth = String((cause as Error)?.message ?? cause); }
  ok('graph：节点缺 depth 又没给坐标时明确报错', graphDepth.includes('depth'));

  const sankeySeries = (buildOption([
    { from: 'D1', to: 'kpi', w: 2 },
    { from: 'D1', to: 'kpi', w: 3 },
    { from: 'kpi', to: 'r1', w: 4 },
  ], { kind: 'sankey', title: null, x: 'from', value: 'w', series: 'to' } as never).option as {
    series: Array<{ data: Array<{ name: string }>; links: Array<{ source: string; target: string; value: number }> }>;
  }).series[0]!;
  ok('sankey：行是边，同一对起终点累加合并',
    sankeySeries.links.length === 2
    && sankeySeries.links.some((link) => link.source === 'D1' && link.target === 'kpi' && link.value === 5));
  ok('sankey：节点按首次出现定序并去重',
    sankeySeries.data.map((node) => node.name).join(',') === 'D1,kpi,r1');
  const sankeyDefault = buildOption(
    [{ from: 'A', to: 'B' }, { from: 'B', to: 'C' }],
    { kind: 'sankey', title: null, x: 'from', value: '', series: 'to' } as never,
  ).option as { series: Array<{ links: Array<{ value: number }> }> };
  ok('sankey：不给 value 时每条边计 1',
    sankeyDefault.series[0]!.links.every((link) => link.value === 1));

console.log('=== 文件路径与符号链接边界 ===');
for(const path of ['short.jq','.work/../bad.jq','.work/./bad.jq','.work//bad.jq','.work\\bad.jq',' .work/bad.jq','.work/bad.jq ','/tmp/bad.jq'])
 ok('完整路径严格校验',!!await refusalOf(()=>call('oks_write',{path,content:'.'})));
const outside=mkdtempSync(join(tmpdir(),'oks-boundary-'));
writeFileSync(join(outside,'protected.jq'),'original');
symlinkSync(outside,resolve(DEV_ROOT,'.work/escape-test'),'dir');
try{
 for(const [name,args] of [
  ['oks_read',{path:'.work/escape-test/protected.jq'}],
  ['oks_edit',{path:'.work/escape-test/protected.jq',old_string:'original',new_string:'changed'}],
  ['oks_delete',{path:'.work/escape-test/protected.jq'}],
  ['oks_write',{path:'.work/escape-test/new-dir/new.jq',content:'.'}],
  ['oks_data',{input:'oks://knowledge',jq:{src:'.work/escape-test/protected.jq'}}],
  ['oks_run_answer',{src:'.work/escape-test/protected.jq'}],
 ])ok('文件与执行入口拒绝符号链接逃逸',!!await refusalOf(()=>call(name,args)));
 ok('拒绝后外部文件不变',readFileSync(join(outside,'protected.jq'),'utf8')==='original' && !existsSync(join(outside,'new-dir')));
}finally{rmSync(resolve(DEV_ROOT,'.work/escape-test'));rmSync(outside,{recursive:true,force:true});}
for(const dispose of disposers.reverse())dispose();
rmSync(SCRATCH,{recursive:true,force:true});
console.log(`\n✓ ${passed} / ✗ 0`);
