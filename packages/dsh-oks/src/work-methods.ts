import {manualPrompt} from './help-files.ts';
import type {PluginContext} from './host.ts';

/** The mandatory prompt and readable manuals share one source. */
export function installWorkMethods(ctx:PluginContext):void {
 ctx.systemPrompt?.section({name:'oks:work-methods',order:100,text:manualPrompt,interpolate:false});
}
