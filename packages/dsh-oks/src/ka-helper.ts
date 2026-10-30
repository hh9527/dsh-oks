import { renderDomainSummary } from './domain-summary.ts';
import { randomUUID } from 'node:crypto';
import { renderWholeVocabulary } from './retrieval.ts';
import type { Knowledge } from './knowledge.ts';
import type { LogFn, PluginContext, SessionLike } from './host.ts';
import KA_PROMPT_TEXT from './ka-prompt-tpl.md';

const MARKER = '<!-- 词表 -->';
const DOMAIN_MARKER = '<!-- 领域摘要 -->';
const COLLAPSED = '（上文问答已收起）';
const collapsedMessage = () => ({
  id: randomUUID(), role: 'user',
  content: [{ type: 'text', text: COLLAPSED }], source: { kind: 'user' },
});
const PERSONA = '你是领域知识助手：根据系统上下文中的完整领域摘要和词汇表，为当前问题推荐最少的相关知识入口，每项只给准确地址和一句用途说明，必要时补充检索词或关键业务歧义。'
  + '主 agent 自主使用 search/cap/card 获取详细知识并设计查询。你只提供知识导航，不执行查询、不读取文件。';

/** 沿用固定边界收起：保留系统前缀，旧标记与全部问答一起替换，原始日志保留。 */
export function resetKnowledgeContext(session: SessionLike): void {
  const nodes = session.surface?.nodes;
  if (!nodes || !session.eventAt) throw new Error('知识助手需要宿主的会话表面接口。');
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

/** 专用预设的提示词与权限。装配以当前子会话定位领域摘要与词表，诊断装配不访问工作区。 */
export function installKnowledgeHelper({ ctx, knowledge, log }: {
  ctx: PluginContext;
  knowledge: Knowledge;
  log: LogFn;
}): void {
  if (!ctx.systemPrompt) throw new Error('知识助手需要 systemPrompt 服务。');
  const template = KA_PROMPT_TEXT.trim();
  if (!template.includes(MARKER) || !template.includes(DOMAIN_MARKER)) throw new Error('知识助手提示词缺少领域摘要或词表占位符。');
  ctx.tools.restrict({ allow: [] });
  // pre-step 同样覆盖重启后恢复、上轮异常中断以及浏览器直接续问的情况。
  ctx.on('agent/pre-step', async (payload, next) => {
    const session = payload.agent?.session;
    if (session) resetKnowledgeContext(session);
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
    if (status === 'idle') resetKnowledgeContext(agent.session);
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
    const feed = template.replace(DOMAIN_MARKER, () => renderDomainSummary(index.knowledge, entry.settings.domain))
      .replace(MARKER, () => renderWholeVocabulary(index));
    const assembled = await next();
    log(`[oks] vocabulary system prompt · ${index.terms.length} 条`);
    return { ...assembled, sections: [
      ...assembled.sections.filter(section => section.name !== 'oks:knowledge-assistant'),
      { name: 'oks:knowledge-assistant', text: feed, interpolate: false },
    ] };
  });
  ctx.effect(() => dispose);
}
