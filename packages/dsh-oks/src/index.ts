// Workspace-scoped ontology: domain summary, fixed knowledge cards and DARI analysis.
// Vocabulary assistance and standalone help manuals complement model facts.

export { createProjector } from './project.ts';
export type { JsonValue, ProjectRule, Projector } from './project.ts';
export { buildOption, CHART_WIDTH, plotHeight } from './chart/option.ts';
export { artifactName, NAME_MAX, resultStamp } from './results.ts';
export { embedArtifactMeta, readArtifactMeta } from './results.ts';
export { renderEchartsSvg } from './chart/echarts.ts';
export { renderMarkdown } from './chart/markdown.ts';

import { createKnowledge } from './knowledge.ts';
import { installWorkMethods } from './work-methods.ts';
import { installKnowledgeNavigation } from './knowledge-navigation.ts';
import { createTimeContext } from './time-context.ts';
import { guidedTools } from './guided-tools.ts';
import { createTools } from './tools.ts';
import { createKaRuntime } from './ka.ts';
import { installKnowledgeHelper } from './ka-helper.ts';
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
  if (config.knowledgeHelper === true || config.vocabularyHelper === true) {
    installKnowledgeHelper({ ctx, knowledge, log, config });
    return;
  }

  installWorkMethods(ctx);
  installKnowledgeNavigation({ ctx, knowledge, log });

  const timeContext = createTimeContext({ ctx, log });
  timeContext.install();

  const ka = createKaRuntime({ ctx, log, config });

  const definitions = createTools({ knowledge, ka, timeContext, log, config, attachments:()=>ctx.get('attachments'), approval:()=>ctx.get('approval') });
  ctx.effect(() => definitions.dispose);
  for (const definition of guidedTools(definitions, knowledge)) {
    const dispose = ctx.tools.register(definition);
    if (typeof dispose === 'function') ctx.effect(() => dispose);
  }

}
