import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

// ── 词汇助手（va）的工作台 ────────────────────────────────────────────────────
// 准备阶段三步：① 角色 + 怎么读 → 它回"读完了"；② 回答方法 → 它回"准备好了"；
// ③ 握手问题 → 它的回答（只为确认读完了、能答一轮）。**标记就是第 ③ 步那个问题**，记住它的 seq。
//
// 此后每次咨询：插件把说法发过去、等到"我们那条消息"之后的回合结束、取回回答，然后把标记之后
// 的表面节点收进一个标记节点（rewind）。所以助手每轮看到的都是「词汇 + 方法 + 标记 + 这个问题」。
// 收起由插件主动做：拿到回答时助手是 idle，就顺手收；收不了（有回合在飞）就留到下一次提问之前补。
//
// 标记节点是一条**固定文本的用户消息**（与压缩用的形状相同）。这里不用空的 `system/message`：
// 那种形状会让这个子会话在冷恢复时续不上（同一个位置、同样一次收起，用户消息能续、空系统消息不能）。
//
// 会话日志保持 append-only：被收起的问答与标记节点都留在日志里，标记节点用 `sourceEventSeqs`
// 记录自己遮蔽了哪些表面节点——审计与回放都不受影响，也没有任何前缀被复制。

const VA_MARKER_TEXT = '（上文问答已收起）';
/** 助手会话的日志级标题前缀：归档列表里认得出、将来也按它找回。 */
const VA_TITLE_PREFIX = '词汇助手（内部）';

/** 准备阶段第 ③ 步的握手问题：答完就收起，只用来确认"助手真的读完了词表、能答一轮"。
 *  问的是它刚读到的条数——每页页首就写着 `共 N 条`，属于记忆召回，所以成本是一轮一句话，
 *  不会像开放式说法那样引它去翻检索。不含任何领域词，也可由 config 的 `vaWarmup` 覆盖。 */
const VA_WARMUP_DEFAULT = '握手：你刚读进来的词表一共有多少条？只回数字，不要检索。';

/** 助手的专属人设：否则它会继承调用方 preset 的人设——编码 agent 与业务问答 agent 都不对。 */
const VA_PERSONA = '你是这个词表的词汇助手：提问者给一个说法（一个词、一个短语或一句话，中英不限），'
  + '你回答这份词表里有哪些等价或相近的表达、各差在哪一维。词表由你读进来，只读不改；'
  + '你不回答业务问题，也不碰文件。';

/** 词汇助手自己的两条提示词。装配时由插件直接发出去——不经过人，也不经过主 agent。 */
function readVaPrompt(name) {
  try {
    return readFileSync(new URL(`../va/${name}`, import.meta.url), 'utf8').trim();
  } catch (cause) {
    throw new Error(`dsh-oks: 读不到词汇助手的提示词 va/${name}：${cause?.message ?? cause}`);
  }
}

/** 收起之后替它们出面的标记节点。文本固定，所以它出现在哪一轮都不影响冻结前缀的缓存。 */
const vaMarker = () => ({
  id: randomUUID(),
  role: 'user',
  content: [{ type: 'text', text: VA_MARKER_TEXT }],
  source: { kind: 'user' },
});

/** `va_ask` 的模型可见渲染：把助手的回答原样交出。 */
export function renderAsk(_args, value) {
  const lines = [];
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

export function createVaRuntime({ ctx, log, config }) {
  const vaPreset = typeof config?.vaPreset === 'string' && config.vaPreset.length > 0 ? config.vaPreset : 'oks';
  const vaBudgetMs = Number.isFinite(config?.vaAskTimeoutMs) && config.vaAskTimeoutMs > 0
    ? config.vaAskTimeoutMs
    : 600000;
  const vaWarmup = typeof config?.vaWarmup === 'string' && config.vaWarmup.trim().length > 0
    ? config.vaWarmup.trim()
    : VA_WARMUP_DEFAULT;
  const vaHelpers = new Map(); // 调用方 session id -> { sessionId, agent }
  // 模型可能在一个 step 里并行发两个 va_ask，所以三处都要合并：
  //  1) 装配按调用方 single flight——并发调用共享同一次在飞的装配，不会建出两个助手；
  //  2) 同一个说法的并发咨询也合并成一次，两边拿同一个回答；
  //  3) 不同说法才排队——一个助手会话一次只能答一个问题，混在一起会把 turn/end 认错。
  const vaFlights = new Map(); // 调用方 session id -> 正在装配的 promise
  const vaAskFlights = new Map(); // `${调用方}\0${说法}` -> 正在咨询的 promise
  const vaHelperChain = new Map(); // 助手 session id -> 咨询队列的尾（已吞掉拒绝）

  /** 把一次咨询挂到某个键的队尾；前一条失败不影响后一条。 */
  const vaSerialOn = (map, key, task) => {
    const previous = map.get(key) ?? Promise.resolve();
    const run = previous.then(task, task);
    const tail = run.then(() => {}, () => {});
    map.set(key, tail);
    void tail.then(() => { if (map.get(key) === tail) map.delete(key); });
    return run;
  };

  /** 一次在飞的操作：后来者共享同一个 promise；落地后从表里撤掉。 */
  const vaSingleFlight = (map, key, start) => {
    const inflight = map.get(key);
    if (inflight !== undefined) return inflight;
    const flight = start();
    map.set(key, flight);
    void flight.then(() => {}, () => {}).then(() => { if (map.get(key) === flight) map.delete(key); });
    return flight;
  };

  /** 插件自己写给助手的一条用户消息。 */
  const vaMessage = (text) => ({
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  });

  /** 边界不明的失败（取消 / 超时 / 回合没结束）：助手可能停在一个还在飞的回合上，
   *  用这个标记把它记下来，调用处据此把它丢掉、下次重建——否则后续咨询会排在那个回合后面一直等。 */
  const vaUnknownBoundary = (message) => {
    const error = new Error(message);
    error.vaDirty = true;
    return error;
  };

  /** 等**我们那条消息**真正落到助手的会话表面上，返回它的 seq。
   *  助手在忙时消息要排到下一个回合，所以不能拿"发之前"的位置当边界。 */
  const vaWaitMessage = async (session, messageId, signal, budgetMs, what) => {
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
  const vaWaitTurnEndAfter = async (session, afterSeq, signal, budgetMs, what) => {
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
  const vaRequireCompleted = (reason, what) => {
    if (reason?.kind !== undefined && reason.kind !== 'completed') {
      throw new Error(`dsh-oks: ${what}没有正常结束（${reason.kind}）。`);
    }
  };

  /** 发一条消息给助手并等它把那一轮跑完；返回我们这条消息落在哪个 seq。
   *  每发一条 `helper.pending += 1`，**观察到回合结束**才减回去——这是"没有未回应发送"的唯一依据：
   *  公开的 `agent.status` 在有投递排队时可能仍是 `idle`，拿它当依据会把还在等回答的问题收掉。 */
  const vaSendAndWait = async (helper, message, signal, budgetMs, what) => {
    const session = helper.agent.session;
    helper.pending += 1;
    helper.agent.followup(message);
    const sentSeq = await vaWaitMessage(session, message.id, signal, budgetMs, what);
    const reason = await vaWaitTurnEndAfter(session, sentSeq, signal, budgetMs, what);
    helper.pending -= 1;
    return { sentSeq, reason };
  };

  /** 从会话日志里取 sinceSeq 之后最后一条助手文本。 */
  const vaAnswerSince = (session, sinceSeq) => {
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

  /** 把 upToSeq 之后的表面节点收进一个标记节点——这就是 rewind。
   *  有内容的系统消息留在原地（折叠只走连续的非系统节点段），别把宿主的提示词收掉。 */
  const vaCollapse = (session, upToSeq) => {
    const nodes = session.surface?.nodes ?? [];
    const start = nodes.findIndex((seq) => seq > upToSeq);
    if (start === -1) return null;
    const after = nodes.slice(start);
    if (after.some((seq) => seq <= upToSeq)) return null;
    const isLiveSystem = (seq) => {
      const event = typeof session.eventAt === 'function' ? session.eventAt(seq) : undefined;
      if (event?.type !== 'system/message') return false;
      const content = event.data?.message?.content;
      return Array.isArray(content)
        && content.some((block) => block?.type === 'text' && String(block.text ?? '').length > 0);
    };
    const runs = [];
    let run = [];
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
  const vaTryRewind = (helper) => {
    try {
      if (helper?.pending !== 0) {
        // 只有 vaSendAndWait 会发消息、也只会在这里减回去；这个日志让计数漂移可见（漂移会静默停掉收起）。
        log(`[oks] rewind skipped · 还有 ${helper.pending} 条没被回答的发送`);
        return false;
      }
      if (helper?.agent?.status !== 'idle') return false;
      const done = vaCollapse(helper.agent.session, helper.markerSeq);
      if (done !== null) {
        // 标记往后挪到刚插入的那个节点：下一次没有新问答时，收起就是空操作，不会白插一轮标记。
        helper.markerSeq = done.markerSeq;
        log(`[oks] rewind · 收起 ${done.shadowed} 个表面节点（${done.runs} 段，seq ${done.startSeq}-${done.endSeq} → 标记 ${done.markerSeq}）`);
      }
      return true;
    } catch (cause) {
      log('[oks] rewind failed: ' + String(cause?.message ?? cause));
      return false;
    }
  };

  const vaArchive = async (sessionId) => {
    const registry = ctx.get('workspaceRegistry');
    if (typeof registry?.archiveSession !== 'function') return;
    try {
      await registry.archiveSession(sessionId, { stopActivity: true });
    } catch (cause) {
      log('[oks] cannot archive the vocabulary helper: ' + String(cause?.message ?? cause));
    }
  };

  const vaUnarchive = async (sessionId) => {
    const registry = ctx.get('workspaceRegistry');
    if (typeof registry?.unarchiveSession !== 'function') return;
    try {
      await registry.unarchiveSession(sessionId);
    } catch (cause) {
      log('[oks] cannot unarchive the vocabulary helper: ' + String(cause?.message ?? cause));
    }
  };

  /** 调用方的助手：没有就建一个顶层 agent，装配好（读词表 → 收方法 → 落边界）。
   *  并发调用共享这一次装配（single flight），不会各建一个。 */
  const vaEnsureHelper = (caller, key, signal) => vaSingleFlight(vaFlights, key, async () => {
    const existing = vaHelpers.get(key);
    if (existing !== undefined) return existing;
    const agents = ctx.get('agents');
    if (typeof agents?.create !== 'function') {
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
    const handle = await agents.create({
      sessionId,
      meta: {
        cwd,
        agentPreset: typeof composed === 'string' && composed.length > 0 ? composed : vaPreset,
      },
      agentOptions: {
        ...(typeof options.provider === 'string' ? { provider: options.provider } : {}),
        ...(typeof options.model === 'string' ? { model: options.model } : {}),
      },
      setup(agentCtx, agent) {
        const service = agentCtx.get?.('agentPresets');
        if (typeof service?.composeFrom !== 'function') {
          throw new Error('dsh-oks: 这个组合里没有 agentPresets 服务，没法把 preset 拼进词汇助手，它会是个空 agent。');
        }
        service.composeFrom(agentCtx, caller.ctx);
        const prompt = agentCtx.systemPrompt;
        if (typeof prompt?.section !== 'function') {
          throw new Error('dsh-oks: 这个组合里没有 systemPrompt 服务，换不上词汇助手自己的人设。');
        }
        prompt.section({
          name: 'deployment:persona-prefix',
          order: typeof prompt.getSectionOrder === 'function' ? prompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX') : 0,
          text: VA_PERSONA,
        });
        // 助手的权限由插件显式钉住，不跟着部署默认走：它只读词表，不该写工作区、也不该弹审批。
        // `source: 'delegation'` 表示"这是创建时播下的覆盖"，而不是用户后来手动切的。
        agent.session.append('sandbox/mode', { mode: 'read-only', source: 'delegation' });
        agent.session.append('approval/policy', { policy: 'never', source: 'delegation' });
      },
      signal,
    });
    const helper = { sessionId, agent: handle.agent, pending: 0 };
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
    try {
      const read = await vaSendAndWait(helper, vaMessage(readVaPrompt('1-read.md')), signal, vaBudgetMs, '词汇助手读词表');
      vaRequireCompleted(read.reason, '词汇助手读词表');
      const method = await vaSendAndWait(helper, vaMessage(readVaPrompt('2-method.md')), signal, vaBudgetMs, '词汇助手收工作方法');
      vaRequireCompleted(method.reason, '词汇助手收工作方法');
      // ③ 握手问题：它的回答只用来确认装配成功，答完立刻收起——**标记就是这个问题**，
      // 之后每次真实提问的问答都在拿到回答后收回到这里。
      const warmup = await vaSendAndWait(helper, vaMessage(vaWarmup), signal, vaBudgetMs, '词汇助手预热');
      vaRequireCompleted(warmup.reason, '词汇助手预热');
      helper.markerSeq = warmup.sentSeq;
      vaTryRewind(helper);
      await vaArchive(sessionId); // 装配完就归档：从"就绪"到"第一次被咨询"之间不该出现在活跃列表里
    } catch (cause) {
      vaHelpers.delete(key);
      void vaArchive(sessionId);
      throw new Error(`dsh-oks: 词汇助手没有装配起来：${cause?.message ?? cause}`);
    }
    log(`[oks] vocabulary helper ready · ${sessionId} · 标记 seq ${helper.markerSeq}`);
    return helper;
  });

  /** 一次咨询：归档状态先恢复 → 把说法交给它 → 等它静止 → 取它这一轮的回答。 */
  const vaConsult = async (helper, query, signal) => {
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

  const ask = async (caller, key, query, signal) => {
    const helper = await vaEnsureHelper(caller, key, signal);
    try {
      return await vaSingleFlight(vaAskFlights, `${key}\u0000${query}`, () =>
        vaSerialOn(vaHelperChain, helper.sessionId, async () => {
          const result = await vaConsult(helper, query, signal);
          log(`[oks] va_ask ${JSON.stringify(query)} → ${result.answer.length} 字符`);
          return result;
        }));
    } catch (error) {
      if (error?.vaDirty === true) {
        vaHelpers.delete(key);
        void vaArchive(helper.sessionId);
        log('[oks] vocabulary helper dropped (boundary unknown): ' + String(error?.message ?? error));
      }
      throw error;
    }
  };

  return { ask };
}
