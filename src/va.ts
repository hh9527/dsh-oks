import { randomUUID } from 'node:crypto';
import { singleFlight } from './single-flight.ts';
import { renderWholeVocabulary } from './retrieval.ts';
import { errorText, isRecord } from './host.ts';
import type { AgentLike, LogFn, PluginContext, RenderBlock, SessionLike, SessionMessage } from './host.ts';
import type { PluginConfig } from './config.ts';
import type { Knowledge } from './knowledge.ts';
import VA_PROMPT_TEXT from './va-prompt-tpl.md';

// ── 词汇助手（va）的工作台 ────────────────────────────────────────────────────
// 装配不产生任何回合：词表（`src/va-prompt-tpl.md` 的模板 + 整份词条）作为**系统提示词的一个
// section** 注入助手的上下文，助手一个工具都没有——模型不搬运、不翻页、不检索，也没有"读完了吗"
// 这个问题要回答。
//
// 每个**说法**才是一次回合：插件把说法发过去、等到"我们那条消息"之后的回合结束、取回回答，
// 然后把表面上的节点全部收进一个标记节点（rewind）。所以助手每次咨询看到的只有
// 「系统提示词里的词表 + 一个标记 + 当前这个说法」——表面恒定，重放也确定。
// 收起由插件主动做：拿到回答时助手是 idle，就顺手收；收不了（有回合在飞）就留到下一次提问之前补。
//
// 标记节点是一条**固定文本的用户消息**（与压缩用的形状相同）。这里不用空的 `system/message`：
// 那种形状会让这个子会话在冷恢复时续不上（同一个位置、同样一次收起，用户消息能续、空系统消息不能）。
//
// 会话日志保持 append-only：被收起的问答与标记节点都留在日志里，标记节点用 `sourceEventSeqs`
// 记录自己遮蔽了哪些表面节点——审计与回放都不受影响，也没有任何前缀被复制。

const VA_MARKER_TEXT = '（上文问答已收起）';
/** 词表在助手**系统提示词**里的 section：名字与位置（人设 0 之后、平台策略 500 之前）。
 *  `interpolate: false`——词表是逐字原文，不许被变量插值动过。 */
const VA_VOCABULARY_SECTION = 'oks:vocabulary';
const VA_VOCABULARY_SECTION_ORDER = 200;
/** 表面起点：收起永远从 0 号节点之前开始算，所以"收掉全部、只留一个标记"是确定的。 */
const VA_SURFACE_START = -1;
/** `src/va-prompt-tpl.md` 里放词表的位置：插件在这行插入整份词汇。 */
const VA_VOCABULARY_MARKER = '<!-- 词表 -->';

/** 助手会话的日志级标题前缀：归档列表里认得出、将来也按它找回。 */
const VA_TITLE_PREFIX = '词汇助手（内部）';


/** 助手的专属人设：否则它会继承调用方 preset 的人设——编码 agent 与业务问答 agent 都不对。 */
const VA_PERSONA = '你是这份词表的词汇助手：提问者给一个说法（一个词、一个短语或一句话，中英不限），'
  + '你回答词表里有哪些等价或相近的说法（逐字原文）。词表就在你的系统提示词里，只读不改；'
  + '你不回答业务问题，也不碰文件。';

/** 助手的推理档位取值：模型适配器定义档位 id，插件只透传（'inherit' 表示跟着默认走）。 */
type VaReasoningEffort = string | undefined;

/** 一次咨询的结果：`va_ask` 渲染读到的值。 */
export interface AskResult {
  helper: string;
  answer: string;
  interrupted: boolean;
}

/** 一次在飞的助手装配。markerSeq 在装配落地时写入；取用前一定已经写过。 */
interface VaHelper {
  sessionId: string;
  agent: AgentLike;
  pending: number;
  /** **不动的锚点**：表面起点之前（`VA_SURFACE_START`）。收起永远从它之后收，也就是"收掉全部"，
   *  所以表面上恒定只剩一个标记。它一旦跟着新标记往后挪，旧标记就再也收不掉——会一行行堆起来。 */
  anchorSeq: number;
  /** 当前那个标记节点的 seq：只用来判断"除了它没有别的新节点"，不参与收起范围的计算。 */
  markerSeq: number;
}

/** 边界不明的失败（取消 / 超时 / 回合没结束）用的错误：带一个"助手可能不干净"的标记。 */
interface VaDirtyError extends Error {
  vaDirty?: boolean;
}

export interface VaRuntime {
  ask(caller: AgentLike, key: string, query: string, signal?: AbortSignal): Promise<AskResult>;
}

/** 词汇助手自己的提示词：源码 `src/va-prompt-tpl.md`，构建期内联；装配时由插件直接发出去，
 *  不经过人，也不经过主 agent。 */
const VA_PROMPT = VA_PROMPT_TEXT.trim();

/** 收起之后替它们出面的标记节点。文本固定，所以它出现在哪一轮都不影响冻结前缀的缓存。 */
const vaMarker = (): SessionMessage => ({
  id: randomUUID(),
  role: 'user',
  content: [{ type: 'text', text: VA_MARKER_TEXT }],
  source: { kind: 'user' },
});

/** `va_ask` 的模型可见渲染：把助手的回答原样交出。 */
export function renderAsk(_args: unknown, value: AskResult | null | undefined): RenderBlock[] {
  const lines: string[] = [];
  if (typeof value?.answer === 'string' && value.answer.length > 0) lines.push(value.answer);
  else lines.push('（词汇助手这一轮没有给出文本回答。）');
  if (value?.interrupted === true) lines.push('', '注意：这一轮被中断过，上面的回答可能不完整。');
  return [{ type: 'text', text: `${lines.join('\n')}\n` }];
}

// ── va：词汇助手（顶层 agent，插件自己建、自己喂、自己收） ────────────────────
// 助手不是子会话：它是 preset `oks` 下的一个**顶层 agent**，由插件持有句柄。这样回答只有
// 一条通道（`va_ask` 的工具结果），没有父子投递，也就不会多出一份；它的会话平时处于
// **归档**状态（分组界面不列、模型步被归档门挡住），只在被咨询时 unarchive。
export const VA_HELPER_PREFIX = 'session-va-';

export function createVaRuntime({ ctx, log, config, knowledge }: {
  ctx: PluginContext;
  log: LogFn;
  config: PluginConfig | undefined;
  knowledge: Knowledge;
}): VaRuntime {
  const vaPreset = typeof config?.vaPreset === 'string' && config.vaPreset.length > 0 ? config.vaPreset : 'oks';
  const askedBudget = config?.vaAskTimeoutMs;
  const vaBudgetMs = typeof askedBudget === 'number' && Number.isFinite(askedBudget) && askedBudget > 0
    ? askedBudget
    : 600000;
  // 助手的推理档位：**默认 'off'**（deepseek 这套的取值是 off / low / high / max，off 即关掉思考）。
  // 它的活儿是"从封闭集合里挑字符串"——格式已经锁死，判断也只剩取舍；而实测一次咨询
  // 的时间 ≈ 输出 token × 3.9 ms，其中一半以上是看不见的思考。想跟着部署/模型默认走就写
  // `vaReasoningEffort: inherit`；想留一点思考就写 `low`。档位 id 由模型适配器定义，插件只透传。
  const vaReasoningEffort: VaReasoningEffort = (() => {
    const asked = config?.vaReasoningEffort;
    if (typeof asked === 'string' && asked.trim() === 'inherit') return undefined;
    if (typeof asked === 'string' && asked.trim().length > 0) return asked.trim();
    return 'off';
  })();
  const vaHelpers = new Map<string, VaHelper>(); // 调用方 session id -> { sessionId, agent }
  // 模型可能在一个 step 里并行发两个 va_ask，所以三处都要合并：
  //  1) 装配按调用方 single flight——并发调用共享同一次在飞的装配，不会建出两个助手；
  //  2) 同一个说法的并发咨询也合并成一次，两边拿同一个回答；
  //  3) 不同说法才排队——一个助手会话一次只能答一个问题，混在一起会把 turn/end 认错。
  const vaFlights = new Map<string, Promise<VaHelper>>(); // 调用方 session id -> 正在装配的 promise
  const vaAskFlights = new Map<string, Promise<AskResult>>(); // `${调用方}\0${说法}` -> 正在咨询的 promise
  const vaHelperChain = new Map<string, Promise<void>>(); // 助手 session id -> 咨询队列的尾（已吞掉拒绝）

  /** 把一次咨询挂到某个键的队尾；前一条失败不影响后一条。 */
  const vaSerialOn = <T>(map: Map<string, Promise<void>>, key: string, task: () => Promise<T>): Promise<T> => {
    const previous = map.get(key) ?? Promise.resolve();
    const run = previous.then(task, task);
    const tail = run.then(() => {}, () => {});
    map.set(key, tail);
    void tail.then(() => { if (map.get(key) === tail) map.delete(key); });
    return run;
  };

  /** 一次在飞的操作：后来者共享同一个 promise；落地后从表里撤掉。 */
  /** 插件自己写给助手的一条用户消息。 */
  const vaMessage = (text: string): SessionMessage => ({
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  });

  /** 边界不明的失败（取消 / 超时 / 回合没结束）：助手可能停在一个还在飞的回合上，
   *  用这个标记把它记下来，调用处据此把它丢掉、下次重建——否则后续咨询会排在那个回合后面一直等。 */
  const vaUnknownBoundary = (message: string): VaDirtyError => {
    const error: VaDirtyError = new Error(message);
    error.vaDirty = true;
    return error;
  };

  /** 等**我们那条消息**真正落到助手的会话表面上，返回它的 seq。
   *  助手在忙时消息要排到下一个回合，所以不能拿"发之前"的位置当边界。 */
  const vaWaitMessage = async (
    session: SessionLike,
    messageId: string,
    signal: AbortSignal | undefined,
    budgetMs: number,
    what: string,
  ): Promise<number> => {
    const deadline = Date.now() + budgetMs;
    for (;;) {
      if (signal?.aborted === true) throw vaUnknownBoundary('va_ask 被取消');
      const events = session.snapshotEvents();
      for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        if (event.type === 'user/message' && event.data?.id === messageId) return event.seq;
      }
      if (Date.now() > deadline) throw vaUnknownBoundary(`${what} 在 ${budgetMs} ms 内没有落到助手的会话里`);
      await new Promise((resolve) => { setTimeout(resolve, 150); });
    }
  };

  /** 等 afterSeq 之后的第一个回合结束。不用 `whenIdle()`——刚 followup 时驱动还没起来，它会立刻返回。 */
  const vaWaitTurnEndAfter = async (
    session: SessionLike,
    afterSeq: number,
    signal: AbortSignal | undefined,
    budgetMs: number,
    what: string,
  ): Promise<{ kind?: string }> => {
    const deadline = Date.now() + budgetMs;
    for (;;) {
      if (signal?.aborted === true) throw vaUnknownBoundary('va_ask 被取消');
      const events = session.snapshotEvents();
      for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        if (event.seq <= afterSeq) break;
        if (event.type === 'turn/end') return event.data?.reason ?? { kind: 'completed' };
      }
      if (Date.now() > deadline) throw vaUnknownBoundary(`${what} 在 ${budgetMs} ms 内没有结束`);
      await new Promise((resolve) => { setTimeout(resolve, 150); });
    }
  };

  /** 回合必须以 completed 收场——否则读词表读到一半、或回答是残的，都不能当成功。 */
  const vaRequireCompleted = (reason: { kind?: string } | null | undefined, what: string): void => {
    if (reason?.kind !== undefined && reason.kind !== 'completed') {
      throw new Error(`dsh-oks: ${what}没有正常结束（${reason.kind}）。`);
    }
  };

  /** 发一条消息给助手并等它把那一轮跑完；返回我们这条消息落在哪个 seq。
   *  每发一条 `helper.pending += 1`，**观察到回合结束**才减回去——这是"没有未回应发送"的唯一依据：
   *  公开的 `agent.status` 在有投递排队时可能仍是 `idle`，拿它当依据会把还在等回答的问题收掉。 */
  const vaSendAndWait = async (
    helper: VaHelper,
    message: SessionMessage,
    signal: AbortSignal | undefined,
    budgetMs: number,
    what: string,
  ): Promise<{ sentSeq: number; reason: { kind?: string } }> => {
    const session = helper.agent.session;
    helper.pending += 1;
    helper.agent.followup(message);
    const sentSeq = await vaWaitMessage(session, message.id, signal, budgetMs, what);
    const reason = await vaWaitTurnEndAfter(session, sentSeq, signal, budgetMs, what);
    helper.pending -= 1;
    return { sentSeq, reason };
  };

  /** 从会话日志里取 sinceSeq 之后最后一条助手文本。 */
  const vaAnswerSince = (session: SessionLike, sinceSeq: number): { text: string; interrupted: boolean } => {
    const events = session.snapshotEvents();
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (event.seq < sinceSeq) break;
      if (event.type !== 'assistant/message') continue;
      const content = event.data?.message?.content ?? [];
      const text = content
        .filter((block) => block?.type === 'text')
        .map((block) => String(block.text ?? ''))
        .join('')
        .trim();
      if (text.length === 0) continue;
      return { text, interrupted: event.data?.interrupted === true };
    }
    return { text: '', interrupted: false };
  };

  /** 把 anchorSeq 之后的表面节点收进一个标记节点——这就是 rewind。
   *  有内容的系统消息留在原地（折叠只走连续的非系统节点段），别把宿主的提示词收掉；
   *  系统提示词里的词表本来就不在表面上，天然不受影响。
   *  `currentMarkerSeq` 是上一次收起留下的那个标记：只有它一个节点时说明没有新问答，直接跳过
   *  （不白插一轮标记）；有新的东西时它跟新问答一起被收掉，所以表面上始终只有一个标记。 */
  const vaCollapse = (session: SessionLike, anchorSeq: number, currentMarkerSeq: number): {
    shadowed: number;
    runs: number;
    startSeq: number;
    endSeq: number;
    markerSeq: number;
  } | null => {
    const nodes = session.surface?.nodes ?? [];
    const after = nodes.filter((seq) => seq > anchorSeq);
    if (after.length === 0) return null;
    const isLiveSystem = (seq: number): boolean => {
      const event = typeof session.eventAt === 'function' ? session.eventAt(seq) : undefined;
      if (event?.type !== 'system/message') return false;
      const content = event.data?.message?.content;
      return Array.isArray(content)
        && content.some((block) => block?.type === 'text' && String(block.text ?? '').length > 0);
    };
    // 只数**可收**的节点：系统提示词自己也是一条 surface 节点（平台给它的 surfaceOp 是 append），
    // 它永远留在原地。所以"锚点之后只剩当前那个标记"要在排除它之后判断——否则每次提问前都会
    // 把标记重写一遍（状态没错，但多一条收起事件、标记 seq 每次都变）。
    const collapsible = after.filter((seq) => !isLiveSystem(seq));
    if (collapsible.length === 0) return null;
    if (collapsible.length === 1 && collapsible[0] === currentMarkerSeq) return null;
    const runs: number[][] = [];
    let run: number[] = [];
    for (const seq of after) {
      if (isLiveSystem(seq)) {
        if (run.length > 0) runs.push(run);
        run = [];
        continue;
      }
      run.push(seq);
    }
    if (run.length > 0) runs.push(run);
    if (runs.length === 0) return null;
    let shadowed = 0;
    let startSeq = 0;
    let endSeq = 0;
    let markerSeq = 0;
    for (const range of runs) {
      startSeq = range[0];
      endSeq = range[range.length - 1];
      const marker = session.append('user/message', vaMarker(), {
        surfaceOp: { op: 'replace', startSeq, endSeq },
        sourceEventSeqs: range,
      });
      markerSeq = marker.seq;
      shadowed += range.length;
    }
    return { shadowed, runs: runs.length, startSeq, endSeq, markerSeq };
  };

  /** 助手手里没有未回应的发送（`pending === 0`）、也没有在飞的回合时，收起一次；
   *  条件不满足就等下一次（提问之前还会再试一次）。 */
  const vaTryRewind = (helper: VaHelper): boolean => {
    try {
      if (helper?.pending !== 0) {
        // 只有 vaSendAndWait 会发消息、也只会在这里减回去；这个日志让计数漂移可见（漂移会静默停掉收起）。
        log(`[oks] rewind skipped · 还有 ${helper.pending} 条没被回答的发送`);
        return false;
      }
      if (helper?.agent?.status !== 'idle') return false;
      const done = vaCollapse(helper.agent.session, helper.anchorSeq, helper.markerSeq);
      if (done !== null) {
        // 只记下"当前标记是哪一个"，锚点不动——下次收起时它会被新问答一起收掉。
        helper.markerSeq = done.markerSeq;
        log(`[oks] rewind · 收起 ${done.shadowed} 个表面节点（${done.runs} 段，seq ${done.startSeq}-${done.endSeq} → 标记 ${done.markerSeq}）`);
      }
      return true;
    } catch (cause) {
      log('[oks] rewind failed: ' + errorText(cause));
      return false;
    }
  };

  const vaArchive = async (sessionId: string): Promise<void> => {
    const registry = ctx.get('workspaceRegistry');
    if (typeof registry?.archiveSession !== 'function') return;
    try {
      await registry.archiveSession(sessionId, { stopActivity: true });
    } catch (cause) {
      log('[oks] cannot archive the vocabulary helper: ' + errorText(cause));
    }
  };

  const vaUnarchive = async (sessionId: string): Promise<void> => {
    const registry = ctx.get('workspaceRegistry');
    if (typeof registry?.unarchiveSession !== 'function') return;
    try {
      await registry.unarchiveSession(sessionId);
    } catch (cause) {
      log('[oks] cannot unarchive the vocabulary helper: ' + errorText(cause));
    }
  };

  /** 调用方的助手：没有就建一个顶层 agent，装配好（读词表 → 收方法 → 落边界）。
   *  并发调用共享这一次装配（single flight），不会各建一个。 */
  const vaEnsureHelper = (caller: AgentLike, key: string, signal: AbortSignal | undefined): Promise<VaHelper> =>
    singleFlight(vaFlights, key, async () => {
    const existing = vaHelpers.get(key);
    if (existing !== undefined) return existing;
    const agents = ctx.get('agents');
    if (agents === undefined || typeof agents.create !== 'function') {
      throw new Error('dsh-oks: 这个组合里没有 agent 注册表（ctx.agents），va_ask 起不了词汇助手。');
    }
    const sessionId = `${VA_HELPER_PREFIX}${randomUUID()}`;
    const cwd = caller.session?.header?.cwd;
    if (typeof cwd !== 'string' || cwd.length === 0) {
      throw new Error('dsh-oks: 调用方会话没有 cwd，词汇助手不知道去哪个工作区读词表。');
    }
    const options = caller.options ?? {};
    // 助手要拿到和调用方一样的工具（oks_* 与 va_ask）：preset 必须**在它的作用域里拼起来**，
    // 光在会话头里写 agentPreset 不会装配它。子会话也是这么 join 父 preset 的。
    const presets = caller.ctx?.get?.('agentPresets');
    const composed = typeof presets?.composedPreset === 'function' ? presets.composedPreset(caller.ctx) : undefined;
    log(`[oks] vocabulary helper preset · ${typeof composed === 'string' && composed.length > 0 ? composed : `${vaPreset} (fallback)`}`);
    let helper: VaHelper | undefined;
    try {
    // 词表在**建助手之前**就渲染好：它是助手的系统提示词内容，不是一次对话——所以没有
    // "喂词表"那个回合，也没有"它读完了吗"这个问题。模型不搬运任何东西。
    const entry = knowledge.ensureWorkspace({ agent: { session: caller.session } });
    const index = await knowledge.ensureIndex(entry);
    const vocabulary = renderWholeVocabulary(index);
    const template = VA_PROMPT;
    if (!template.includes(VA_VOCABULARY_MARKER)) {
      throw new Error(`dsh-oks: src/va-prompt-tpl.md 里没有 ${VA_VOCABULARY_MARKER} 占位符，词表无处可插。`);
    }
    const feed = template.replace(VA_VOCABULARY_MARKER, vocabulary);
    log(`[oks] vocabulary → helper system prompt · ${index.terms.length} 条 · ${Buffer.byteLength(feed, 'utf8')} 字节`);
    const handle = await agents.create({
      sessionId,
      meta: {
        cwd,
        agentPreset: typeof composed === 'string' && composed.length > 0 ? composed : vaPreset,
      },
      agentOptions: {
        ...(typeof options.provider === 'string' ? { provider: options.provider } : {}),
        ...(typeof options.model === 'string' ? { model: options.model } : {}),
        ...(vaReasoningEffort === undefined ? {} : { reasoningEffort: vaReasoningEffort }),
      },
      setup(agentCtx, agent) {
        const service = agentCtx.get?.('agentPresets');
        if (service === undefined || typeof service.composeFrom !== 'function') {
          throw new Error('dsh-oks: 这个组合里没有 agentPresets 服务，没法把 preset 拼进词汇助手，它会是个空 agent。');
        }
        service.composeFrom(agentCtx, caller.ctx);
        const prompt = agentCtx.systemPrompt;
        if (!prompt || typeof prompt.section !== 'function') {
          throw new Error('dsh-oks: 这个组合里没有 systemPrompt 服务，放不进词汇助手的词表与人设。');
        }
        prompt.section({
          name: 'deployment:persona-prefix',
          order: typeof prompt.getSectionOrder === 'function' ? prompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX') : 0,
          text: VA_PERSONA,
        });
        // 词表本身也进系统提示词：它是**内容**，不是一轮对话。`interpolate: false` 是因为词表
        // 必须逐字送到模型面前，不许被任何变量插值动过。
        prompt.section({
          name: VA_VOCABULARY_SECTION,
          order: VA_VOCABULARY_SECTION_ORDER,
          text: feed,
          interpolate: false,
        });
        // 助手要做的事只有一件：拿着系统提示词里的整份词表做法说对照。词表是插件渲染好**直接
        // 写进它的系统提示词**的，所以它一个工具都不需要——全都收掉（免得它去"核实"：实测它一旦能检索，
        // 一次咨询就从 9 秒涨到 26 秒；而让它自己用工具读整份词表，还会按条数算术翻页漏读）。
        const tools = agentCtx.tools;
        if (typeof tools?.restrict !== 'function') {
          throw new Error('dsh-oks: 这个组合里没有 tools 服务，收不掉词汇助手的工具面。');
        }
        tools.restrict({ allow: [] });
        // 助手的权限由插件显式钉住，不跟着部署默认走：它只读词表，不该写工作区、也不该弹审批。
        // `source: 'delegation'` 表示"这是创建时播下的覆盖"，而不是用户后来手动切的。
        agent.session.append('sandbox/mode', { mode: 'read-only', source: 'delegation' });
        agent.session.append('approval/policy', { policy: 'never', source: 'delegation' });
      },
      signal,
    });
    // 表面上还没有任何节点：锚点与"当前标记"都落在起点之前，所以第一次收起就是
    // "收掉全部、留下一个标记"，此后每次咨询都回到同一个形状。
    helper = {
      sessionId,
      agent: handle.agent,
      pending: 0,
      anchorSeq: VA_SURFACE_START,
      markerSeq: VA_SURFACE_START,
    };
    vaHelpers.set(key, helper);
    const session = helper.agent.session;
    // 给助手会话写一个**日志级**标题（`session/title` 只进日志，不进模型表面）：归档列表里一眼
    // 认得出这是内部会话，也是将来"重启后按标题找回助手"的抓手。
    const titles = ctx.get?.('sessionTitle');
    if (typeof titles?.rename === 'function') {
      const callerTitle = titles.get?.(caller.session)?.title;
      const suffix = typeof callerTitle === 'string' && callerTitle.length > 0 ? ` · 供「${callerTitle}」咨询` : '';
      titles.rename(session, `${VA_TITLE_PREFIX}${suffix}`);
    } else {
      log('[oks] no sessionTitle service; the vocabulary helper stays untitled');
    }
    await vaArchive(sessionId); // 装配完就归档：从"就绪"到"第一次被咨询"之间不该出现在活跃列表里
    } catch (cause) {
      if (helper !== undefined) vaHelpers.delete(key);
      void vaArchive(sessionId);
      throw new Error(`dsh-oks: 词汇助手没有装配起来：${errorText(cause)}`);
    }
    log(`[oks] vocabulary helper ready · ${sessionId} · 词表在系统提示词里`);
    return helper;
  });

  /** 一次咨询：归档状态先恢复 → 把说法交给它 → 等它静止 → 取它这一轮的回答。 */
  const vaConsult = async (helper: VaHelper, query: string, signal: AbortSignal | undefined): Promise<AskResult> => {
    await vaUnarchive(helper.sessionId);
    vaTryRewind(helper); // 上一次没来得及收的，提问之前补上
    const session = helper.agent.session;
    const { sentSeq, reason } = await vaSendAndWait(helper, vaMessage(query), signal, vaBudgetMs, '词汇助手回答');
    vaRequireCompleted(reason, '词汇助手这一轮');
    const answer = vaAnswerSince(session, sentSeq);
    if (answer.text.length === 0) {
      throw new Error('dsh-oks: 词汇助手这一轮没有给出文本回答（可能出错或被中断）。');
    }
    vaTryRewind(helper); // 拿到回答就收回去（助手此刻应该是 idle）
    await vaArchive(helper.sessionId);
    return { helper: helper.sessionId, answer: answer.text, interrupted: answer.interrupted };
  };

  // 插件卸载时把还活着的助手归档，别让它留在活跃列表里。
  ctx.effect(() => () => {
    for (const helper of vaHelpers.values()) void vaArchive(helper.sessionId);
  });

  const ask = async (
    caller: AgentLike,
    key: string,
    query: string,
    signal: AbortSignal | undefined,
  ): Promise<AskResult> => {
    const helper = await vaEnsureHelper(caller, key, signal);
    try {
      return await singleFlight(vaAskFlights, `${key}\u0000${query}`, () =>
        vaSerialOn(vaHelperChain, helper.sessionId, async () => {
          const result = await vaConsult(helper, query, signal);
          log(`[oks] va_ask ${JSON.stringify(query)} → ${result.answer.length} 字符`);
          return result;
        }));
    } catch (error) {
      if (isRecord(error) && error.vaDirty === true) {
        vaHelpers.delete(key);
        void vaArchive(helper.sessionId);
        log('[oks] vocabulary helper dropped (boundary unknown): ' + errorText(error));
      }
      throw error;
    }
  };

  return { ask };
}
