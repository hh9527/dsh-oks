import { presentationOverview } from './presentation-guide.ts';
import type { PluginContext, LogFn } from './host.ts';
import type { Knowledge } from './knowledge.ts';

/** Main agent receives presentation capabilities; domain knowledge lives in KA. */
export function installKnowledgeNavigation({ ctx }: { ctx: PluginContext; knowledge: Knowledge; log: LogFn }): void {
  ctx.systemPrompt?.section({name:'oks:presentation',order:110,text:presentationOverview().join('\n'),interpolate:false});
}
