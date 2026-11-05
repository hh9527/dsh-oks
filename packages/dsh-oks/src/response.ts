import {formatRead,type ReadResult} from './read.ts';
import type {RenderBlock} from './host.ts';

export const OBJECT_OUTPUT = {type:'object',additionalProperties:true};

/** Model-facing text envelope and continuation behavior match the host read tool. */
export function renderWorkRead(args:{limit?:unknown},value:ReadResult):RenderBlock[] {
  return [{type:'text',text:formatRead(value,args.limit)}];
}
