import { discoverPoints, readPoints } from './point-knowledge.ts';
import { semanticKnowledge } from './semantic-knowledge.ts';
import { isRecord, type ToolDefinition, type ToolExec } from './host.ts';
import type { Knowledge } from './knowledge.ts';
import { readTextLines } from './results.ts';
import { helpFiles, helpEntries } from './help-files.ts';
import { presentationManuals } from './presentation-guide.ts';

/** Agent surface: fixed knowledge queries; typed relation expressions stay in data analysis drafts. */
export function guidedTools(definitions: ToolDefinition[], knowledge: Knowledge): ToolDefinition[] {
  const project = definitions.find(t => t.name === 'oks_project')!;
  const files = { ...helpFiles };
  delete files['oks://help/project.md'];
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
      output: project.output,
      async execute(raw, exec) {
        const args = check(raw, ['query','type','dataset','skip','take']);
        if (typeof args.query !== 'string' || !args.query.trim()) throw new Error('query must be nonempty domain vocabulary');
        return method('search', args, exec);
      },
    },
    {
      name: 'oks_cap', description: 'Discover knowledge jointly using anchors:[{id,terms?}] assembled from the KA natural-language reading list. Returns verified term matches, classified point IDs and bounded shortest connection candidates. Copy needed IDs to oks_info. A connection is not proof that aggregation across it is safe; read Relation cardinality and Measure constraints, then check the query.',
      parameters: {type:'object', properties:{anchors:{type:'array',minItems:1,maxItems:12,items:{type:'object',properties:{id:{type:'string'},terms:{type:'array',maxItems:20,items:{type:'string'}}},required:['id'],additionalProperties:false}},max_depth:{type:'integer',minimum:0,maximum:3}},required:['anchors'],additionalProperties:false},
      output: project.output,
      async execute(raw, exec) { return method('cap', check(raw, ['anchors','max_depth']), exec); },
    },
    {
      name: 'oks_info', description: 'Read exact knowledge points from cap.index or cap term matches. ids is a batch of 1..64 complete node IDs; each item contains only its own definition, no recursive navigation or inline child graph. Empty descriptions are omitted. Types, enums, formulas, predicates, identity parts and query constraints are retained. Unknown IDs are reported individually. Query names stay short as defined by each point ID and its facts.',
      parameters:{type:'object',properties:{ids:{type:'array',minItems:1,maxItems:64,items:{type:'string'}}},required:['ids'],additionalProperties:false},
      output:project.output,
      async execute(raw,exec){return method('info',check(raw,['ids']),exec);},
    },

  ];
  return [...definitions.filter(t => !['oks_card','oks_project','oks_run_answer','oks_result','renew_context'].includes(t.name)).map(t => {
    if (['oks_read','oks_list','oks_write','oks_edit','oks_delete'].includes(t.name)) return {
      ...t,
      description: t.name === 'oks_read' ? 'Read method manuals at oks://help/*.md or analysis source at oks://work/<file>. Use ka_ask with the original user question for domain knowledge navigation. offset/limit select line windows. List manuals with oks_list({path:"oks://help/"}).'
        : t.name === 'oks_list' ? 'List oks://help/ method manuals or oks://work/ analysis files.' : 'Manage analysis source files under oks://work/. Use one DARI draft per business question.',
      parameters: { ...t.parameters, properties: { ...(t.parameters.properties as object), ...(t.name === 'oks_read' ? {offset:{type:'number',description:'Optional first line, 1-based'},limit:{type:'number',description:'Optional line count for a partial read.'}} : {}), path: {type:'string',description:'oks://work/<file> or, for reading/listing, oks://help/ manuals'} } },
      async execute(raw: never, exec: ToolExec) {
        const args = raw as Record<string,unknown>;
        const path = args.path;
        if (t.name === 'oks_list' && (path === undefined || path === 'oks://help/')) return {ok:true,files:helpEntries(files),count:Object.keys(files).length};
        if (typeof path !== 'string' || !(path.startsWith('oks://work/') || (t.name === 'oks_read' && Object.hasOwn(files,path)))) throw new Error('Use oks://work/ files or oks://help/ manuals; use ka_ask for domain knowledge navigation');
        if (t.name === 'oks_read' && Object.hasOwn(files,path)) return readTextLines(files[path],path,args.offset,args.limit,'oks_read');
        return t.execute(raw, exec);
      },
    };
    return {...t, description:t.description.replace('Verify returned expressions with oks_project and read the corresponding knowledge declarations.', 'Read precise definitions with oks_info and discover connections with oks_cap.').replaceAll('oks_project','oks_result')};
  }), ...fixed];
}
