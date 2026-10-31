import { randomUUID } from 'node:crypto';
import { singleFlight } from './single-flight.ts';
import type { AgentLike, ContentBlock, LogFn, PluginContext, RenderBlock, SubagentActivation } from './host.ts';
import type { PluginConfig } from './config.ts';

export const KA_HELPER_PREFIX = 'session-ka-';
export const KA_PRESET = 'oks-knowledge';
export const CONSULT_TIMEOUT_MS = 120_000;
export interface AskResult { helper: string; messageId: string; answer: string; readingList?: string; vocabulary?: string }
export interface KaRuntime {
  ask(caller: AgentLike, key: string, query: string, signal?: AbortSignal): Promise<AskResult>;
}
export function renderAsk(_args: unknown, value: AskResult | null | undefined): RenderBlock[] {
  return [{ type: 'text', text: value?.answer ?? '' }];
}
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    if (signal.aborted) abort();
  });
}
type Outcome = { output: ContentBlock[]; stopReason: string; diagnostic?: string };

/** 子助手异步运行，工具等待答案。每个父 Agent 复用一个子会话，咨询串行执行。 */
export function createKaRuntime({ ctx, log, config, vocabulary = false }: {
  ctx: PluginContext; log: LogFn; config: PluginConfig | undefined; vocabulary?: boolean;
}): KaRuntime {
  const preset = vocabulary ? (config?.vaPreset?.trim() || 'oks-vocabulary') : (config?.kaPreset?.trim() || KA_PRESET);
  const prefix = vocabulary ? 'session-va-' : KA_HELPER_PREFIX;
  const label = vocabulary ? '词汇助手' : '知识助手';
  const lifetime = new AbortController();
  const states = new WeakMap<AgentLike, { childId?: string; discovered?: boolean; tail: Promise<void>; flights: Map<string, Promise<AskResult>> }>();
  const pending = new Map<string, (result: Outcome) => void>();
  const notices = new WeakMap<object, Set<string>>();
  ctx.on('subagent/end', ({ id, stopReason, lastAssistantMessage }) => {
    pending.get(id)?.({ stopReason, output: lastAssistantMessage ?? [] });
    pending.delete(id);
  });
  // 冷恢复续问由宿主投递完成通知；答案已作为工具结果返回，只消费这一条重复通知。
  ctx.on('agent/pre-step', async (payload, next) => {
    const ids = payload.agent && notices.get(payload.agent);
    const repeated = (message: { source?: { kind?: string; senderSessionId?: string } | null }) =>
      message.source?.kind === 'subagent-settled' && !!message.source.senderSessionId && !!ids?.has(message.source.senderSessionId);
    const decision = await next();
    if (!ids || decision?.kind !== 'enter') return decision;
    const messages = decision.messages?.filter(message => !repeated(message));
    if (payload.step === 1 && payload.messages?.length && payload.messages.every(repeated)) return { kind: 'reject' };
    return { ...decision, messages };
  });
  ctx.effect(() => () => { lifetime.abort(new Error('知识助手插件已卸载')); });
  return {
    ask(caller, _key, query, signal) {
      let state = states.get(caller);
      if (!state) { state = { tail: Promise.resolve(), flights: new Map() }; states.set(caller, state); }
      const owned = state;
      return singleFlight(owned.flights, query, () => {
        const run = owned.tail.then(async (): Promise<AskResult> => {
          const timeout = new AbortController();
          const timer = setTimeout(() => timeout.abort(new Error(`${label}咨询超时`)), CONSULT_TIMEOUT_MS);
          const requestSignal = AbortSignal.any([lifetime.signal, timeout.signal, ...(signal ? [signal] : [])]);
          let activation: SubagentActivation | undefined;
          let childId: string | undefined;
          let submitted = false;
          try {
            requestSignal.throwIfAborted();
            const cwd = caller.session?.header?.cwd;
            if (!cwd) throw new Error('dsh-oks: 调用方会话没有 cwd。');
            const service = ctx.get('subagents');
            if (!service?.startActivation || !service.sendMessage || !service.listChildren) throw new Error('dsh-oks: 知识助手需要宿主 subagents 服务。');
            if (!owned.discovered) {
              const children = await service.listChildren(caller.session.id!, requestSignal);
              owned.childId = children.findLast(child => child.mode === 'continuable' && child.label === label && child.id.startsWith(prefix))?.id;
              owned.discovered = true;
            }
            requestSignal.throwIfAborted();
            const existing = owned.childId;
            childId = existing ?? `${prefix}${randomUUID()}`;
            const prompt = [{ type: 'text', text: query }];
            let messageId: string;
            let completion: Promise<Outcome>;
            if (existing) {
              const ids = notices.get(caller) ?? new Set<string>(); ids.add(childId); notices.set(caller, ids);
              completion = new Promise(resolve => pending.set(childId!, resolve));
              submitted = true;
              messageId = await service.sendMessage(caller, childId, prompt, { signal: requestSignal });
            } else {
              const route = caller.session.requestHeader?.()?.config ?? caller.options;
              const effort = config?.kaReasoningEffort?.trim() || (/^deepseek(?:[-_/]|$)/i.test(route?.model ?? '') ? 'off' : 'inherit');
              activation = await service.startActivation({ provider: 'spawn', label, childId, delivery: 'caller', signal: requestSignal,
                request: { parent: caller, cwd, agentPreset: preset, prompt,
                  ...(effort === 'inherit' ? {} : { agentOptions: { reasoningEffort: effort } }) } });
              submitted = true;
              messageId = activation.messageId;
              completion = activation.result;
            }
            owned.childId = childId;
            const result = await abortable(completion, requestSignal);
            if (result.stopReason !== 'completed') throw new Error(`${label}未完成：${result.stopReason}${result.diagnostic ? ' · ' + result.diagnostic : ''}`);
            const answer = result.output.filter(block => block.type === 'text').map(block => block.text ?? '').join('\n').trim();
            if (!answer) throw new Error(`${label}没有返回答案`);
            log(`[oks] ${label} completed · ${childId}`);
            return { helper: childId, messageId, answer };
          } catch (error) {
            if (submitted && requestSignal.aborted) {
              if (activation) await activation.dispose();
              else if (childId) await ctx.get('subagents')?.drainChildren(caller, [childId]);
            }
            throw error;
          } finally { clearTimeout(timer); if (childId) pending.delete(childId); }
        });
        owned.tail = run.then(() => {}, () => {});
        return run;
      });
    },
  };
}

/** 工具固定编排词汇对齐与关系导航，两个助手不互相调用。 */
export function createKnowledgeConsultation(ka: KaRuntime, va: KaRuntime): KaRuntime {
  const flights = new WeakMap<AgentLike, Map<string, Promise<AskResult>>>();
  return {
    ask(caller, key, query, signal) {
      let pending = flights.get(caller);
      if (!pending) { pending = new Map(); flights.set(caller, pending); }
      return singleFlight(pending, query, async () => {
        const vocabulary = await va.ask(caller, key, query, signal);
        signal?.throwIfAborted();
        const navigation = await ka.ask(caller, key,
          JSON.stringify({ question: query, vocabulary: vocabulary.answer }), signal);
        return { ...navigation, readingList: navigation.answer, vocabulary: vocabulary.answer,
          answer: `## 阅读清单\n\n${navigation.answer}\n\n## 词汇对照\n\n${vocabulary.answer}` };
      });
    },
  };
}
