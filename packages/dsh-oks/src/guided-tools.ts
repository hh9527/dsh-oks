import {renderInfo} from './info-receipt.ts';
import {renderCap} from './cap-receipt.ts';
import {renderResolveReceipt} from './draft/resolve-receipt.ts';
import { discoverPoints, readPoints } from './point-knowledge.ts';
import { semanticKnowledge } from './semantic-knowledge.ts';
import { isRecord, type ToolDefinition, type ToolExec } from './host.ts';
import type { Knowledge } from './knowledge.ts';
import { readTextLines } from './results.ts';
import { helpFiles, helpEntries } from './help-files.ts';
import { presentationManuals } from './presentation-guide.ts';
import { OBJECT_OUTPUT, renderValue, renderWorkRead } from './response.ts';

/** Agent surface: fixed knowledge queries; typed relation expressions stay in data analysis drafts. */
export function guidedTools(definitions: ToolDefinition[], knowledge: Knowledge): ToolDefinition[] {
  const output = { schema: OBJECT_OUTPUT, render: renderValue };
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
    return {ok:true,model:entry.modelHash,data:name==='info'?readPoints(index.knowledge,args):name==='cap'?discoverPoints(index.knowledge,args):semanticKnowledge(index.knowledge,name,args)};
  };
  const properties = {
    skip: { type: 'integer', minimum: 0 }, take: { type: 'integer', minimum: 1, maximum: 50 },
  };
  const fixed: ToolDefinition[] = [
    {
      name: 'oks_search', description: 'Fuzzy lexical search over knowledge IDs, names and documentation. Multiple words match alternatives; results matching more words rank first. Supports partial words and small English spelling errors. Returns knowledge node IDs for oks_info; optional type (case-insensitive, e.g. Dimension) and short dataset name restrict matches. Does not query business data.',
      parameters: {type:'object',properties:{query:{type:'string'},type:{type:'string'},dataset:{type:'string'},...properties},required:['query'],additionalProperties:false},
      output,
      async execute(raw, exec) {
        const args = check(raw, ['query','type','dataset','skip','take']);
        if (typeof args.query !== 'string' || !args.query.trim()) throw new Error('query must be nonempty domain vocabulary');
        return method('search', args, exec);
      },
    },
    {
      name: 'oks_cap', description: 'Discover knowledge jointly using anchors:[{id,terms?}] using Entity/Dataset IDs from ka_ask’s 阅读清单 section and domain terms copied verbatim from the name position of each 词汇参考 line (- `name` in `ctx`: user wording). ctx supplies context; text after the colon is user wording, not a retrieval term. Discovers paths before pruning the response: all anchor and path nodes/relations remain intact; exterior point IDs are limited to term matches and their type dependencies. Missing or unmatched terms do not expand all members. Returns Markdown sections for anchors, complete connection paths, vocabulary matches, unresolved terms and necessary exact IDs. Copy needed IDs to oks_info. A connection is not proof that aggregation across it is safe; read Relation cardinality and Measure constraints, then check the query.',
      parameters: {type:'object', properties:{anchors:{type:'array',minItems:1,maxItems:12,items:{type:'object',properties:{id:{type:'string'},terms:{type:'array',maxItems:20,items:{type:'string'}}},required:['id'],additionalProperties:false}},max_depth:{type:'integer',minimum:0,maximum:3}},required:['anchors'],additionalProperties:false},
      output: {schema:OBJECT_OUTPUT,render:renderCap},
      async execute(raw, exec) { return method('cap', check(raw, ['anchors','max_depth']), exec); },
    },
    {
      name: 'oks_info', description: 'Read exact knowledge points from cap text paths and vocabulary matches. Returns Markdown sections headed by exact IDs, explicit short query names and complete definitions; complex expressions remain JSON blocks. ids is a batch of 1..64 complete node IDs; each item contains only its own definition, no recursive navigation or inline child graph. Empty descriptions are omitted. Types, enums, formulas, predicates, identity parts and query constraints are retained. Unknown IDs are reported individually. Query names stay short as defined by each point ID and its facts.',
      parameters:{type:'object',properties:{ids:{type:'array',minItems:1,maxItems:64,items:{type:'string'}}},required:['ids'],additionalProperties:false},
      output: {schema:OBJECT_OUTPUT,render:renderInfo},
      async execute(raw,exec){return method('info',check(raw,['ids']),exec);},
    },

  ];
  const builtinRead: ToolDefinition = {
    name: 'oks_read',
    description: 'Read built-in method manuals only. path="oks://help/" lists manuals; path="oks://help/<name>.md" reads one. offset/limit select line windows. Use the host file tools for local files and DARI source.',
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
