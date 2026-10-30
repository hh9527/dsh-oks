import { queryKnowledge } from './knowledge-methods.ts';
import { isRecord, type ToolDefinition, type ToolExec } from './host.ts';
import { DOMAIN_SUMMARY_URI, readDomainSummary } from './domain-summary.ts';
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
    return {ok:true,model:entry.modelHash,data:queryKnowledge(index.knowledge,name,args)};
  };
  const properties = {
    skip: { type: 'integer', minimum: 0 }, take: { type: 'integer', minimum: 1, maximum: 50 },
  };
  const fixed: ToolDefinition[] = [
    {
      name: 'oks_search', description: 'Find domain knowledge points by vocabulary, ID, name or documentation. Returns semantic keys for oks_card; optional type and dataset restrict matches. Does not query business data.',
      parameters: {type:'object',properties:{query:{type:'string'},type:{type:'string'},dataset:{type:'string'},...properties},required:['query'],additionalProperties:false},
      output: project.output,
      async execute(raw, exec) {
        const args = check(raw, ['query','type','dataset','skip','take']);
        if (typeof args.query !== 'string' || !args.query.trim()) throw new Error('query must be nonempty domain vocabulary');
        return method('search', args, exec);
      },
    },
    {
      name: 'oks_cap', description: 'Return structured JSON describing query capabilities and joins for a dataset or entity. Returns constraints, receipts and a candidate query intent; transform still validates it. cq has target:{dataset:ID} or {entity:ID}, optional node, select:[{dimension:ID}], measures:[{measure:ID}], window:{dimension,start,end}, rank:{measure,direction,take}. Pages joins using skip/take; join_depth is 0..2.',
      parameters: {type:'object', properties:{cq:{type:'object'},join_depth:{type:'integer',minimum:0,maximum:2},...properties},required:['cq'],additionalProperties:false},
      output: project.output,
      async execute(raw, exec) { const args = check(raw, ['cq','join_depth','skip','take']); return method('cap', args, exec); },
    },
    {
      name: 'oks_card', description: 'Read a predefined knowledge card as structured JSON with facts and documentation. For a dataset use id and optional section (all, shape, fields, roles, bindings, dimensions, measures, time_roles, relations, business_links), skip/take. For an entity, type, group, relation or member use key (e.g. entities/device_entity or datasets/device#dimensions/id); returns the exact fact and its documentation. Dataset cards include field_roles (Appellation, Reference, Classification, Metric) and complete dataset-scoped references; roles section contains entity identity mappings. Read complete reference groups before object grouping or deduplication. Choose id or key.',
      parameters: {type:'object',properties:{id:{type:'string'},key:{type:'string'},section:{type:'string',enum:['all','shape','fields','roles','bindings','dimensions','measures','time_roles','relations','business_links']},...properties},additionalProperties:false},
      output: project.output,
      async execute(raw, exec) {
        const args = check(raw, ['id','key','section','skip','take']);
        if ((typeof args.id === 'string') === (typeof args.key === 'string')) throw new Error('Provide exactly one dataset id or semantic key');
        if (args.key !== undefined) {
          if (Object.keys(args).some(k => k !== 'key')) throw new Error('A key card accepts only key');
          if (typeof args.key !== 'string' || !/^(entities|datasets|types|dimension_groups|measure_groups|relations)\//.test(args.key)) throw new Error('Use a domain semantic key');
          return method('read', {key:args.key}, exec);
        }
        return method('card', {...args,docs:true}, exec);
      },
    },

  ];
  return [...definitions.filter(t => !['oks_project','oks_run_answer','oks_result','oks_show','renew_context'].includes(t.name)).map(t => {
    if (['oks_read','oks_list','oks_write','oks_edit','oks_delete'].includes(t.name)) return {
      ...t,
      description: t.name === 'oks_read' ? 'Read the global domain summary at oks://domain/summary.md, method manuals at oks://help/*.md, or analysis source at oks://work/<file>. The domain summary is read in full by default; offset/limit optionally page lines. Other texts use line windows. List manuals with oks_list({path:"oks://help/"}).'
        : t.name === 'oks_list' ? 'List oks://domain/ summary, oks://help/ method manuals or oks://work/ analysis files.' : 'Manage analysis source files under oks://work/. Use one DARI draft per business question.',
      parameters: { ...t.parameters, properties: { ...(t.parameters.properties as object), ...(t.name === 'oks_read' ? {offset:{type:'number',description:'Optional first line, 1-based'},limit:{type:'number',description:'Optional line count for a partial read. Omit offset/limit to read the complete domain summary; other texts use normal line windows.'}} : {}), path: {type:'string',description:'oks://work/<file> or, for reading/listing, oks://help/ manuals and oks://domain/summary.md (directory: oks://domain/)'} } },
      async execute(raw: never, exec: ToolExec) {
        const args = raw as Record<string,unknown>;
        const path = args.path;
        if (t.name === 'oks_read' && path === DOMAIN_SUMMARY_URI) {
          const text = await readDomainSummary(knowledge, exec);
          if (args.offset !== undefined || args.limit !== undefined) return readTextLines(text, DOMAIN_SUMMARY_URI, args.offset, args.limit, 'oks_read');
          const lines = text.split('\n');
          if (lines.at(-1) === '') lines.pop();
          return {path:DOMAIN_SUMMARY_URI,offset:1,totalLines:lines.length,lines:lines.map((text,index)=>({number:index+1,text}))};
        }
        if (t.name === 'oks_list' && path === 'oks://domain/') {
          const text = await readDomainSummary(knowledge, exec);
          return {ok:true,files:[{name:DOMAIN_SUMMARY_URI,bytes:Buffer.byteLength(text),modifiedAt:''}],count:1};
        }
        if (t.name === 'oks_list' && (path === undefined || path === 'oks://help/')) return {ok:true,files:helpEntries(files),count:Object.keys(files).length};
        if (typeof path !== 'string' || !(path.startsWith('oks://work/') || (t.name === 'oks_read' && Object.hasOwn(files,path)))) throw new Error('Use oks://work/ files, oks://help/ manuals or oks://domain/summary.md');
        if (t.name === 'oks_read' && Object.hasOwn(files,path)) return readTextLines(files[path],path,args.offset,args.limit,'oks_read');
        return t.execute(raw, exec);
      },
    };
    return {...t, description:t.description.replace('Verify returned expressions with oks_project and read the corresponding knowledge declarations.', 'Verify returned expressions with oks_card and oks_cap.').replaceAll('oks_project','oks_result')};
  }), ...fixed];
}
