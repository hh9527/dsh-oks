import { randomUUID } from 'node:crypto';
import { singleFlight } from './single-flight.ts';
import type { AgentLike, LogFn, PluginContext, RenderBlock } from './host.ts';
import type { PluginConfig } from './config.ts';

export const KA_HELPER_PREFIX = 'session-ka-';
export const KA_PRESET = 'oks-knowledge';

export interface AskResult {
  helper: string;
  messageId: string;
  accepted: true;
}

export interface KaRuntime {
  ask(caller: AgentLike, key: string, query: string, signal?: AbortSignal): Promise<AskResult>;
}

export function renderAsk(_args: unknown, value: AskResult | null | undefined): RenderBlock[] {
  return [{ type: 'text', text: `Knowledge consultation accepted by subagent ${value?.helper ?? ''}. The answer will arrive as a subagent message.\n` }];
}

/** 每个父会话复用一个原生子会话；工具返回投递确认，回答由宿主投递给父会话。 */
export function createKaRuntime({ ctx, log, config, vocabulary = false }: {
  ctx: PluginContext;
  log: LogFn;
  config: PluginConfig | undefined;
  vocabulary?: boolean;
}): KaRuntime {
  const preset = vocabulary ? (config?.vaPreset?.trim() || 'oks-vocabulary') : (config?.kaPreset?.trim() || KA_PRESET);
  const prefix = vocabulary ? 'session-va-' : KA_HELPER_PREFIX;
  const label = vocabulary ? '词汇助手' : '知识助手';
  const states = new WeakMap<AgentLike, {
    childId?: string;
    discovered?: boolean;
    tail: Promise<void>;
    flights: Map<string, Promise<AskResult>>;
  }>();
  // 只用宿主的结束事件串行安排咨询，执行、结果投递与释放全部由宿主管理。
  const pending = new Map<string, () => void>();
  let disposed = false;
  ctx.on('subagent/end', ({ id }) => {
    pending.get(id)?.();
    pending.delete(id);
  });
  ctx.effect(() => () => {
    disposed = true;
    for (const resolve of pending.values()) resolve();
    pending.clear();
  });

  return {
    ask(caller, _key, query, signal) {
      let state = states.get(caller);
      if (!state) {
        state = { tail: Promise.resolve(), flights: new Map() };
        states.set(caller, state);
      }
      const owned = state;
      return singleFlight(owned.flights, query, () => {
        let finished: Promise<void> = Promise.resolve();
        const admitted = owned.tail.then(async (): Promise<AskResult> => {
          if (disposed) throw new Error('知识助手插件已卸载');
          const requestSignal = signal ?? new AbortController().signal;
          requestSignal.throwIfAborted();
          const cwd = caller.session?.header?.cwd;
          if (typeof cwd !== 'string' || cwd.length === 0) throw new Error('dsh-oks: 调用方会话没有 cwd。');
          const service = ctx.get('subagents');
          if (!service?.startActivation || !service.sendMessage || !service.listChildren) {
            throw new Error('dsh-oks: 知识助手需要宿主 subagents 服务。');
          }
          if (!owned.discovered) {
            const children = await service.listChildren(caller.session.id!, requestSignal);
            owned.childId = children.findLast(child => child.mode === 'continuable'
              && child.label === label && child.id.startsWith(prefix))?.id;
            owned.discovered = true;
          }
          requestSignal.throwIfAborted();
          const existing = owned.childId;
          const childId = existing ?? `${prefix}${randomUUID()}`;
          finished = new Promise(resolve => { pending.set(childId, resolve); });
          try {
            const prompt = [{ type: 'text', text: query }];
            let messageId: string;
            if (existing) {
              messageId = await service.sendMessage(caller, childId, prompt, { signal: requestSignal });
            } else {
              // Match the host's delegation route: the latest request wins over creation options.
              const route = caller.session.requestHeader?.()?.config ?? caller.options;
              const effort = config?.kaReasoningEffort?.trim()
                || (/^deepseek(?:[-_/]|$)/i.test(route?.model ?? '') ? 'off' : 'inherit');
              const activation = await service.startActivation({
                provider: 'spawn', label, childId, delivery: 'parent', signal: requestSignal,
                request: { parent: caller, cwd, agentPreset: preset, prompt,
                  ...(effort === 'inherit' ? {} : { agentOptions: { reasoningEffort: effort } }),
                },
              });
              messageId = activation.messageId;
              void activation.result.catch(error => log(`[oks] knowledge subagent: ${String(error)}`));
            }
            owned.childId = childId;
            log(`[oks] knowledge subagent · ${childId}`);
            return { helper: childId, messageId, accepted: true };
          } catch (error) {
            pending.get(childId)?.();
            pending.delete(childId);
            throw error;
          }
        });
        owned.tail = admitted.then(() => finished, () => {});
        return admitted;
      });
    },
  };
}
