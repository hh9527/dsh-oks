import {manualPrompt} from './help-files.ts';
import type {PluginContext} from '@hh9527/dari-model';

/** The mandatory prompt and readable manuals share one source. */
export function installWorkMethods(ctx:PluginContext):void {
 ctx.systemPrompt?.section({name:'data-seer:work-methods',order:100,text:manualPrompt,interpolate:false});
}
