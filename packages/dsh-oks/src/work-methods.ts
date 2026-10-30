import workflow from './help/workflow.md';
import type { PluginContext } from './host.ts';

/** The mandatory prompt and its readable manual share one source. */
export function installWorkMethods(ctx: PluginContext): void {
  ctx.systemPrompt?.section({name:'oks:work-methods',order:100,text:workflow,interpolate:false});
}
