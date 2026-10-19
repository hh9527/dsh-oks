/** Intent 顶层 limit 的产品范围：必填，1..500。上限由插件来管，服务只负责执行。 */
const INTENT_LIMIT_MIN = 1;
const INTENT_LIMIT_MAX = 500;

/** 校验一个 Intent 的顶层 limit；返回 null 表示合格。 */
export const limitProblem = (intent: unknown): string | null => {
  if (intent === null || typeof intent !== 'object' || Array.isArray(intent)) {
    return 'Intent 必须是一个对象，并在顶层声明 limit';
  }
  const limit = (intent as Record<string, unknown>).limit;
  if (limit === undefined || limit === null) {
    return `Intent 必须在顶层显式声明 limit（${INTENT_LIMIT_MIN} 到 ${INTENT_LIMIT_MAX} 的整数），它决定这次查询取多少行`;
  }
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < INTENT_LIMIT_MIN || limit > INTENT_LIMIT_MAX) {
    return `limit 必须是 ${INTENT_LIMIT_MIN} 到 ${INTENT_LIMIT_MAX} 的整数，收到 ${JSON.stringify(limit)}`;
  }
  return null;
};
