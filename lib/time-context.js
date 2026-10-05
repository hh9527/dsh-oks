import { deriveContextTimeZone } from './time.js';

export function createTimeContext({ ctx, log }) {
  // 上下文时区：按插件规范，浏览器时区挂在**当轮用户消息**的 source.clientTimeZone 上
  // （与 dsh-time-context 同一套字段与 resolved / mixed / missing 三态）。这里在 agent/pre-step
  // 时读一次并按会话记下，供两个时间工具取用；取不到就报错，让 agent 去问用户。
  const zones = new Map(); // session -> 规范推导结果
  const install = () => {
    try {
      ctx.on('agent/pre-step', async (payload, next) => {
        const decision = await next();
        if (decision?.kind !== 'reject' && payload?.agent?.session !== undefined) {
          const derived = deriveContextTimeZone(payload.messages);
          const carriesMessages = Array.isArray(payload.messages) && payload.messages.length > 0;
          // 同一回合从第 2 步起 payload.messages 是空的（用户消息只在"进入"那一步），
          // 此时不能把已知时区覆盖成 missing；只有这一步确实带了用户消息才更新。
          if (derived.kind !== 'missing' || carriesMessages) zones.set(payload.agent.session, derived);
        }
        return decision;
      });
    } catch (cause) {
      log('[oks] cannot observe agent/pre-step: ' + String(cause?.message ?? cause));
    }
  };

  return { zones, install };
}
