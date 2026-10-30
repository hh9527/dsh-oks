import { renderDomainSummary } from './domain-summary.ts';
import { randomUUID } from 'node:crypto';
import { renderWholeVocabulary } from './retrieval.ts';
import type { Knowledge } from './knowledge.ts';
import type { LogFn, PluginContext, SessionLike } from './host.ts';
import { createKaRuntime, renderAsk } from './ka.ts';
import type { PluginConfig } from './config.ts';
import VA_PROMPT_TEXT from './va-prompt-tpl.md';
import KA_PROMPT_TEXT from './ka-prompt-tpl.md';

const MARKER = '<!-- 词表 -->';
const DOMAIN_MARKER = '<!-- 领域摘要 -->';
const COLLAPSED = '（上文问答已收起）';
const collapsedMessage = () => ({
  id: randomUUID(), role: 'user',
  content: [{ type: 'text', text: COLLAPSED }], source: { kind: 'user' },
});
const PERSONA = '你是领域知识助手：根据关系地图和词汇助手提供的锚点，为当前问题推荐最少的相关知识入口，每项只给准确地址和一句用途说明。'
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
export function installKnowledgeHelper({ ctx, knowledge, log, config }: {
  ctx: PluginContext;
  knowledge: Knowledge;
  log: LogFn;
  config?: PluginConfig;
}): void {
  if (!ctx.systemPrompt) throw new Error('知识助手需要 systemPrompt 服务。');
  const vocabulary = config?.vocabularyHelper === true;
  const template = (vocabulary ? VA_PROMPT_TEXT : KA_PROMPT_TEXT).trim();
  const waiting = new WeakSet<object>();
  const consultations = new Map<string, object>();
  ctx.on('subagent/end', ({ id }) => {
    const session = consultations.get(id);
    if (session) waiting.delete(session);
    consultations.delete(id);
  });
  ctx.tools.restrict({ allow: vocabulary ? [] : ['va_ask'] });
  if (!vocabulary) {
    const va = createKaRuntime({ ctx, log, config, vocabulary: true });
    const dispose = ctx.tools.register({
      name: 'va_ask',
      description: '将原始问题交给词汇助手，获取领域词汇、别名、规范值与所属知识地址。返回投递确认，等待子助手回答后沿关系地图选择阅读入口。',
      parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false },
      output: { schema: { type: 'object' }, render: renderAsk },
      async execute(args: { query: string }, exec) {
        if (!exec.agent || !args.query?.trim()) throw new Error('va_ask 需要调用方及非空问题');
        const session = exec.agent.session;
        waiting.add(session);
        try {
          const accepted = await va.ask(exec.agent, session.id!, args.query.trim(), exec.signal);
          consultations.set(accepted.helper, session);
          return accepted;
        } catch (error) { waiting.delete(session); throw error; }
      },
    });
    if (typeof dispose === 'function') ctx.effect(() => dispose);
  }
  const active = new WeakSet<object>();
  // pre-step 同样覆盖重启后恢复、上轮异常中断以及浏览器直接续问的情况。
  ctx.on('agent/pre-step', async (payload, next) => {
    const session = payload.agent?.session;
    if (session && !active.has(session)) { resetKnowledgeContext(session); active.add(session); }
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
    if (status === 'idle' && !waiting.has(agent.session)) { resetKnowledgeContext(agent.session); active.delete(agent.session); }
  });
  ctx.systemPrompt.section({ name: 'deployment:persona-prefix', order: 0, text: vocabulary ? '你是领域词汇助手，负责词汇对齐与归属定位。' : PERSONA });
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
    const feed = template.replace(DOMAIN_MARKER, () => vocabulary ? '' : renderDomainSummary(index.knowledge, entry.settings.domain))
      .replace(MARKER, () => vocabulary ? renderWholeVocabulary(index) : '');
    const assembled = await next();
    log(vocabulary ? `[oks] vocabulary system prompt · ${index.terms.length} 条` : '[oks] knowledge relationship map');
    return { ...assembled, sections: [
      ...assembled.sections.filter(section => section.name !== 'oks:knowledge-assistant'),
      { name: 'oks:knowledge-assistant', text: feed, interpolate: false },
    ] };
  });
  ctx.effect(() => dispose);
}
