import { randomUUID } from 'node:crypto';
import { renderWholeVocabulary } from './retrieval.ts';
import type { Knowledge } from './knowledge.ts';
import type { LogFn, PluginContext, SessionLike } from './host.ts';
import VA_PROMPT_TEXT from './va-prompt-tpl.md';

const MARKER = '<!-- 词表 -->';
const COLLAPSED = '（上文问答已收起）';
const collapsedMessage = () => ({
  id: randomUUID(), role: 'user',
  content: [{ type: 'text', text: COLLAPSED }], source: { kind: 'user' },
});
const PERSONA = '你是这份词表的词汇助手：提问者给一个说法（一个词、一个短语或一句话，中英不限），'
  + '你回答词表里有哪些等价或相近的说法（逐字原文）。词表就在你的系统提示词里，只读不改；'
  + '你不回答业务问题，也不碰文件。';

/** 沿用固定边界收起：保留系统前缀，旧标记与全部问答一起替换，原始日志保留。 */
export function resetVocabularyContext(session: SessionLike): void {
  const nodes = session.surface?.nodes;
  if (!nodes || !session.eventAt) throw new Error('词汇助手需要宿主的会话表面接口。');
  const ranges: number[][] = [];
  let range: number[] = [];
  for (const seq of nodes) {
    const event = session.eventAt(seq);
    const keep = event?.type === 'system/message'
      && event.data?.message?.content?.some(block => block.type === 'text' && !!block.text);
    if (keep) {
      if (range.length) ranges.push(range);
      range = [];
    } else range.push(seq);
  }
  if (range.length) ranges.push(range);
  for (const entries of ranges) {
    const first = session.eventAt(entries[0]);
    if (entries.length === 1 && first?.type === 'user/message'
      && first.data?.content?.length === 1 && first.data.content[0]?.text === COLLAPSED) continue;
    session.append('user/message', collapsedMessage(), {
      surfaceOp: { op: 'replace', startSeq: entries[0], endSeq: entries[entries.length - 1] },
      sourceEventSeqs: entries,
    });
  }
}

/** 专用预设的提示词与权限。装配以当前子会话定位词表，诊断装配不访问工作区。 */
export function installVocabularyHelper({ ctx, knowledge, log }: {
  ctx: PluginContext;
  knowledge: Knowledge;
  log: LogFn;
}): void {
  if (!ctx.systemPrompt) throw new Error('词汇助手需要 systemPrompt 服务。');
  const template = VA_PROMPT_TEXT.trim();
  if (!template.includes(MARKER)) throw new Error('词汇助手提示词缺少词表占位符。');
  ctx.tools.restrict({ allow: [] });
  // pre-step 同样覆盖重启后恢复、上轮异常中断以及浏览器直接续问的情况。
  ctx.on('agent/pre-step', async (payload, next) => {
    const session = payload.agent?.session;
    if (session) resetVocabularyContext(session);
    const decision = await next();
    // 首轮也使用同一个固定标记；由宿主在系统前缀之后提交，保持所有轮次的输入形状一致。
    const hasMarker = session?.surface?.nodes?.some(seq => {
      const event = session.eventAt?.(seq);
      return event?.type === 'user/message' && event.data?.content?.[0]?.text === COLLAPSED;
    });
    if (session && decision?.kind === 'enter' && !hasMarker) {
      return { ...decision, messages: [collapsedMessage(), ...(decision.messages ?? [])] };
    }
    return decision;
  });
  ctx.on('agent/status', ({ agent, status }) => {
    if (status === 'idle') resetVocabularyContext(agent.session);
  });
  ctx.systemPrompt.section({ name: 'deployment:persona-prefix', order: 0, text: PERSONA });
  const initialized = new WeakSet<object>();
  const dispose = ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const agent = context.agent;
    if (!agent) return next();
    context.signal?.throwIfAborted();
    if (!initialized.has(agent.session)) {
      agent.session.append('sandbox/mode', { mode: 'read-only', source: 'delegation' });
      agent.session.append('approval/policy', { policy: 'never', source: 'delegation' });
      initialized.add(agent.session);
    }
    const entry = knowledge.ensureWorkspace({ agent });
    const index = await knowledge.ensureIndex(entry);
    context.signal?.throwIfAborted();
    const feed = template.replace(MARKER, () => renderWholeVocabulary(index));
    const assembled = await next();
    log(`[oks] vocabulary system prompt · ${index.terms.length} 条`);
    return { ...assembled, sections: [
      ...assembled.sections,
      { name: 'oks:vocabulary', text: feed, interpolate: false },
    ] };
  });
  ctx.effect(() => dispose);
}
