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
    return {ok:true,model:entry.modelHash,data:semanticKnowledge(index.knowledge,name,args)};
  };
  const properties = {
    skip: { type: 'integer', minimum: 0 }, take: { type: 'integer', minimum: 1, maximum: 50 },
  };
  const fixed: ToolDefinition[] = [
    {
      name: 'oks_search', description: 'Fuzzy lexical search over knowledge IDs, names and documentation. Multiple words match alternatives; results matching more words rank first. Supports partial words and small English spelling errors. Returns knowledge node IDs for oks_card; optional type (case-insensitive, e.g. Dimension) and short dataset name restrict matches. Does not query business data.',
      parameters: {type:'object',properties:{query:{type:'string'},type:{type:'string'},dataset:{type:'string'},...properties},required:['query'],additionalProperties:false},
      output: project.output,
      async execute(raw, exec) {
        const args = check(raw, ['query','type','dataset','skip','take']);
        if (typeof args.query !== 'string' || !args.query.trim()) throw new Error('query must be nonempty domain vocabulary');
        return method('search', args, exec);
      },
    },
    {
      name: 'oks_cap', description: 'Describe query capabilities and joins. Provide exactly one short model name: dataset:"device" or entity:"device"; never a knowledge-node path. Optional node, select:[{dimension:NAME}], measures:[{measure:NAME}], window:{dimension,start,end}, rank:{measure,direction,take}. Returned knowledge_id fields can be passed to oks_card; candidate_intent uses short query names and must pass transform checks.',
      parameters: {type:'object', properties:{dataset:{type:'string'},entity:{type:'string'},node:{type:'string'},select:{type:'array',items:{type:'object'}},measures:{type:'array',items:{type:'object'}},window:{type:'object'},rank:{type:'object'},join_depth:{type:'integer',minimum:0,maximum:2},...properties},additionalProperties:false},
      output: project.output,
      async execute(raw, exec) {
        const args = check(raw, ['dataset','entity','node','select','measures','window','rank','join_depth','skip','take']);
        if ((typeof args.dataset === 'string') === (typeof args.entity === 'string')) throw new Error('Provide exactly one short dataset or entity name');
        const {dataset,entity,join_depth,skip,take,...request} = args;
        const target = dataset !== undefined ? {dataset} : {entity};
        return method('cap', {cq:{target,...request},...(join_depth !== undefined ? {join_depth} : {}),...(skip !== undefined ? {skip} : {}),...(take !== undefined ? {take} : {})}, exec);
      },
    },
    {
      name: 'oks_card', description: 'Read one domain knowledge node by its complete ID copied from search or KA: datasets/device, entities/device, datasets/device/dimensions/name. Returns facts and documentation. Dataset root cards accept section and pagination; other nodes accept only id. Dataset/dimension/measure fields provide short names for cap and query; do not pass knowledge IDs as query names.',
      parameters: {type:'object',properties:{id:{type:'string'},section:{type:'string',enum:['all','shape','fields','roles','bindings','dimensions','measures','time_roles','relations','business_links']},...properties},required:['id'],additionalProperties:false},
      output: project.output,
      async execute(raw, exec) {
        const args = check(raw, ['id','section','skip','take']);
        if (typeof args.id !== 'string') throw new Error('Provide a complete knowledge node id, e.g. datasets/device');
        return method('card', args, exec);
      },
    },

  ];
  return [...definitions.filter(t => !['oks_project','oks_run_answer','oks_result','oks_show','renew_context'].includes(t.name)).map(t => {
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
    return {...t, description:t.description.replace('Verify returned expressions with oks_project and read the corresponding knowledge declarations.', 'Verify returned expressions with oks_card and oks_cap.').replaceAll('oks_project','oks_result')};
  }), ...fixed];
}
