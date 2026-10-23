import { deriveContextTimeZone } from './time.ts';
import type { ContextTimeZone } from './time.ts';
import { errorText } from './host.ts';
import type { ContextMessageLike, LogFn, PluginContext, SessionLike } from './host.ts';

function isRequestMessage(message: ContextMessageLike): boolean {
  return message?.source?.kind === 'user' && typeof message.source.rpcId === 'string';
}

/** 恢复最近一轮带用户 RPC 的消息；轮次边界避免混合历次请求的时区。 */
function lastRequestMessages(session: SessionLike): ContextMessageLike[] {
  const messages: ContextMessageLike[] = [];
  if (!Number.isSafeInteger(session.seq) || !session.eventAt) return messages;
  for (let seq = session.seq! - 1; seq >= 0; seq--) {
    const event = session.eventAt(seq);
    if (event?.type === 'turn/start' && messages.length > 0) break;
    if (event?.type === 'user/message' && event.data && isRequestMessage(event.data)) {
      messages.push(event.data);
    }
  }
  return messages.reverse();
}

export interface TimeContext {
  /** 会话 → 规范推导结果（resolved / mixed / missing / invalid）。 */
  zones: Map<SessionLike, ContextTimeZone>;
  install: () => void;
}

export function createTimeContext({ ctx, log }: { ctx: PluginContext; log: LogFn }): TimeContext {
  // 用户 RPC 更新浏览器时区；内部续跑沿用该请求的结果。恢复会话时从日志重建。
  const zones = new Map<SessionLike, ContextTimeZone>(); // session -> 规范推导结果
  const install = (): void => {
    try {
      ctx.on('agent/pre-step', async (payload, next) => {
        const decision = await next();
        const session = payload?.agent?.session;
        if (decision?.kind !== 'reject' && !payload.signal?.aborted && session !== undefined) {
          const messages = decision?.messages ?? payload.messages ?? [];
          if (messages.some(isRequestMessage)) {
            zones.set(session, deriveContextTimeZone(messages));
          } else if (!zones.has(session)) {
            zones.set(session, deriveContextTimeZone(lastRequestMessages(session)));
          }
        }
        return decision;
      });
    } catch (cause) {
      log('[oks] cannot observe agent/pre-step: ' + errorText(cause));
    }
  };

  return { zones, install };
}
