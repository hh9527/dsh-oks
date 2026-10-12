// 自带技能：注册进 skills 服务（可选依赖）的 runtime 层，对所有工作区可见。
// 正文是**本模块的**提示词源码 `src/skill.md`，构建期内联进产物，运行时不读文件。
import SKILL_CONTENT from './skill.md';
import { errorText } from './host.ts';
import type { LogFn, PluginContext, SkillsService } from './host.ts';

/** rank 250：工作区自己的 skill(100/200) 能覆盖它，用户级(400/500) 不能。 */
export const SKILL = {
  name: 'oks-query',
  description: 'Use when a business question must be answered from domain data: discover the domain model with oks_info, validate structured intents with oks_check_intent, and get actual rows with oks_query. Resolve relative time into absolute boundaries first — time_now and time_calc do that without knowing any domain format.',
  source: 'runtime',
};

/**
 * 注册动作（幂等）。技能服务是**可选依赖**：加载时它可能还没起来，所以调用方在第一次工具调用
 * 时再补一次；已注册则空操作。
 */
export function createSkillRegistration(ctx: PluginContext, log: LogFn): () => boolean {
  let registered = false;
  return (): boolean => {
    if (registered) return true;
    let found: SkillsService | null = null;
    try {
      found = ctx.get?.('skills') ?? null;
    } catch {
      found = null;
    }
    const skills = found;
    if (skills === null || typeof skills.register !== 'function') return false;
    try {
      ctx.effect(() => skills.register({ ...SKILL, content: SKILL_CONTENT }));
      registered = true;
      log(`[oks] skill "${SKILL.name}" registered (runtime) · ${Buffer.byteLength(SKILL_CONTENT, 'utf8')} bytes`);
    } catch (cause) {
      log(`[oks] cannot register skill "${SKILL.name}": ${errorText(cause)}`);
      registered = true;
    }
    return registered;
  };
}
