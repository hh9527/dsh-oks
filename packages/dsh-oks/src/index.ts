// Workspace-scoped ontology tools. oks.json declares the model and readonly data file.
// oks_* edits DARI drafts; oks_run_answer evaluates them; oks_project reads retained outputs.
// oks_project reads facts and declared capabilities from oks://knowledge; va_ask normalizes vocabulary.
// Reports archive evidence and code in durable host attachments.

export { createProjector } from './project.ts';
export type { JsonValue, ProjectRule, Projector } from './project.ts';
export { buildOption, CHART_WIDTH, plotHeight } from './chart/option.ts';
export { artifactName, NAME_MAX, resultStamp } from './results.ts';
export { embedArtifactMeta, readArtifactMeta } from './results.ts';
export { renderEchartsSvg } from './chart/echarts.ts';
export { renderMarkdown } from './chart/markdown.ts';

import { createKnowledge } from './knowledge.ts';
import { disposeJaqEngine } from './jaq.ts';
import { createTimeContext } from './time-context.ts';
import { createTools } from './tools.ts';
import { withOutputLimit } from './payload.ts';
import { createVaRuntime } from './va.ts';
import { installVocabularyHelper } from './va-helper.ts';
import type { LogFn, PluginContext } from './host.ts';
import type { PluginConfig } from './config.ts';

export const inject = ['tools', 'systemPrompt'];

export function apply(ctx: PluginContext, config: PluginConfig = {}): void {
  const log: LogFn = (message) => {
    try {
      const logger = ctx.logger;
      if (logger?.info) logger.info(message);
      else console.error(message);
    } catch {
      console.error(message);
    }
  };

  const knowledge = createKnowledge({ ctx, log, config });
  ctx.effect(() => knowledge.dispose);
  if (config.vocabularyHelper === true) {
    installVocabularyHelper({ ctx, knowledge, log });
    return;
  }

  const timeContext = createTimeContext({ ctx, log });
  timeContext.install();

  const va = createVaRuntime({ ctx, log, config });

  const definitions = createTools({ knowledge, va, timeContext, log, config, attachments:()=>ctx.get('attachments') });
  ctx.effect(() => definitions.dispose);
  for (const definition of definitions) {
    const dispose = ctx.tools.register(withOutputLimit(definition));
    if (typeof dispose === 'function') ctx.effect(() => dispose);
  }

  // 求值器是一个常驻 worker（第一次用 jq 时拉起）：卸载时收掉，别让它拖着事件循环。
  ctx.effect(() => disposeJaqEngine);
}
