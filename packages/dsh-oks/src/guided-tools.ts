import {renderInfo} from './info-receipt.ts';
import {renderSearch,renderRoutes} from './navigation-receipt.ts';
import {searchPoints,routePoints} from './point-navigation.ts';
import {renderResolveReceipt} from './draft/resolve-receipt.ts';
import { readPoints } from './point-knowledge.ts';
import { isRecord, type ToolDefinition, type ToolExec } from './host.ts';
import type { Knowledge } from './knowledge.ts';
import { readTextLines } from './results.ts';
import { helpFiles, helpEntries } from './help-files.ts';
import { presentationManuals } from './presentation-guide.ts';
import { OBJECT_OUTPUT, renderWorkRead } from './response.ts';

/** Agent surface: fixed knowledge queries; typed relation expressions stay in data analysis drafts. */
export function guidedTools(definitions: ToolDefinition[], knowledge: Knowledge): ToolDefinition[] {
  const files = { ...helpFiles };
  Object.assign(files,presentationManuals());
  const check = (args: unknown, allowed: string[]): Record<string, unknown> => {
    if (!isRecord(args) || Object.keys(args).some(k => !allowed.includes(k))) throw new Error('Use only the declared tool parameters: ' + allowed.join(', '));
    return args;
  };
  const method = async (name:string,args:object,exec:ToolExec) => {
    exec.signal?.throwIfAborted();
    const entry=knowledge.ensureWorkspace(exec);
    const index=await knowledge.ensureIndex(entry);
    exec.signal?.throwIfAborted();
    return {ok:true,model:entry.modelHash,data:name==='info'?readPoints(index.knowledge,args):name==='routes'?routePoints(index.knowledge,args):searchPoints(index.knowledge,args)};
  };
  const fixed: ToolDefinition[] = [
    {
      name:'oks_search',
      description:'Lexical knowledge search: {q:[...],scope:[...]}. Both arrays are required and nonempty; all q terms share the same scope. Category scopes datasets/entities/types find roots; exact root IDs search their members. Content directories restrict search to a section; types/ID/references searches enabled direct reference sites. Multiple scopes form a union. Valid empty scopes return no matches; unknown scopes are errors. Partial words and small English typos are supported. Returns at most 10 matches per term, grouped by parent ID; append the displayed relative name to that exact parent to obtain an oks_info ID. Use va_ask for unfamiliar vocabulary, then search its terms to discover actual IDs. Use oks_routes for relationships. No business data reads.',
      parameters:{type:'object',properties:{q:{type:'array',minItems:1,maxItems:12,items:{type:'string',minLength:1,maxLength:200}},scope:{type:'array',minItems:1,maxItems:12,items:{type:'string'}}},required:['q','scope'],additionalProperties:false},
      output:{schema:OBJECT_OUTPUT,render:renderSearch},
      async execute(raw,exec){return method('search',check(raw,['q','scope']),exec);},
    },
    {
      name:'oks_routes',
      description:'Find the shortest cycle-free relationship paths satisfying {from,to,via?}, using exact Dataset/Entity root IDs. via is an optional ordered list of required nodes; omit it for unconstrained shortest paths. Entity nodes resolve through datasets carrying their identity. No fixed hop limit. Returns at most 20 paths from the first matching depth in stable order, with full node/relation IDs, declared edge direction, traversal cardinality, complete join keys, role IDs and guards. Explicit no-path/return-truncation status. These declarations do not prove aggregation safety: read the relevant measure constraints with oks_info and validate the query with dari_check.',
      parameters:{type:'object',properties:{from:{type:'string'},to:{type:'string'},via:{type:'array',items:{type:'string'}}},required:['from','to'],additionalProperties:false},
      output:{schema:OBJECT_OUTPUT,render:renderRoutes},
      async execute(raw,exec){return method('routes',check(raw,['from','to','via']),exec);},
    },
    {
      name: 'oks_info', description: 'Read exact knowledge points from scoped search results or routes. Returns Markdown sections headed by exact IDs, explicit short query names and complete definitions; complex expressions remain JSON blocks. ids is a batch of 1..64 complete node IDs; each item contains only its own definition, no recursive navigation or inline child graph. Empty descriptions are omitted. Types, enums, formulas, predicates, identity parts and query constraints are retained. Unknown IDs are reported individually. Query names stay short as defined by each point ID and its facts.',
      parameters:{type:'object',properties:{ids:{type:'array',minItems:1,maxItems:64,items:{type:'string'}}},required:['ids'],additionalProperties:false},
      output: {schema:OBJECT_OUTPUT,render:renderInfo},
      async execute(raw,exec){return method('info',check(raw,['ids']),exec);},
    },

  ];
  const builtinRead: ToolDefinition = {
    name: 'oks_read',
    description: 'Read built-in method manuals only. workflow.md, dari.md and rules.md are already fully loaded in the system context: do not read them to start a task; reread only for exact quotation or after context compression. Figure-specific manuals remain on demand. path="oks://help/" lists manuals; path="oks://help/<name>.md" reads one. offset/limit select line windows. Use the host file tools for local files and DARI source.',
    parameters: {type:'object',properties:{path:{type:'string'},offset:{type:'integer',minimum:1},limit:{type:'integer',minimum:1,maximum:2000}},required:['path'],additionalProperties:false},
    output: {schema:OBJECT_OUTPUT,render:renderWorkRead},
    async execute(raw) {
      const args=check(raw,['path','offset','limit']);
      if(args.path==='oks://help/') {
        const catalog=helpEntries(files).map(entry=>entry.name).join('\n');
        return readTextLines(catalog,'oks://help/',args.offset,args.limit,'oks_read');
      }
      if(typeof args.path!=='string'||!Object.hasOwn(files,args.path)) throw new Error('Use oks://help/ to list built-in manuals; read local files with the host file tools');
      return readTextLines(files[args.path],args.path,args.offset,args.limit,'oks_read');
    },
  };
  return [builtinRead, ...definitions.map(t => {
    if (['dari_check','dari_resolve'].includes(t.name)) return {
      ...t,
      async execute(raw: never, exec: ToolExec) {
        const result = await t.execute(raw, exec);
        // Only the public tool boundary turns domain failures into host tool errors.
        // DSH exposes Error.message to the agent; format compact diagnostics at this boundary.
        if (isRecord(result) && result.ok === false) throw new Error(typeof result.text==='string'?result.text:t.name==='dari_resolve'?renderResolveReceipt(result):`${t.name} failed:\n${JSON.stringify(result, null, 2)}`);
        return result;
      },
    };
    return t;
  }), ...fixed];
}
