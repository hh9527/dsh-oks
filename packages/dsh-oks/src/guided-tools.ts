import {semanticId} from './semantic-id.ts';
import {ENABLE_OKS_SEARCH} from './features.ts';
import {discoverConcepts,renderConcepts} from './concept-knowledge.ts';
import {renderInfo} from './info-receipt.ts';
import {renderSearch,renderRoutes} from './navigation-receipt.ts';
import {searchPoints,routePoints} from './point-navigation.ts';
import { readPoints } from './point-knowledge.ts';
import { isRecord, type ToolDefinition, type ToolExec } from './host.ts';
import type { Knowledge } from './knowledge.ts';
import {readWindow} from './read.ts';
const readTextLines=(text:string,rel:string,offset:unknown,limit:unknown,_tool:string)=>readWindow([text],rel,offset,limit);
import { helpFiles, helpEntries } from './help-files.ts';
import { OBJECT_OUTPUT, renderWorkRead } from './response.ts';

/** Agent surface: fixed knowledge queries; typed relation expressions stay in data analysis drafts. */
export function guidedTools(definitions: ToolDefinition[], knowledge: Knowledge, infoContracts?: (points:any[],exec:ToolExec)=>Promise<Record<string,unknown>>): ToolDefinition[] {
  const files = { ...helpFiles };
  const check = (args: unknown, allowed: string[]): Record<string, unknown> => {
    if (!isRecord(args) || Object.keys(args).some(k => !allowed.includes(k))) throw new Error('Use only the declared tool parameters: ' + allowed.join(', '));
    return args;
  };
  const method = async (name:string,args:Record<string,unknown>,exec:ToolExec) => {
    exec.signal?.throwIfAborted();
    const entry=knowledge.ensureWorkspace(exec);
    const index=await knowledge.ensureIndex(entry);
    exec.signal?.throwIfAborted();
    if(name==='info'){
      const data=readPoints(index.knowledge,args);
      if(infoContracts&&data.items.length){
        const points=data.items.map(item=>{
          const point:any={id:item.id,kind:item.kind};
          for(const key of ['dataset','dimension','measure','relation'])if(item[key]!==undefined)point[key]=item[key];
          if(item.kind==='Entity')point.datasets=Object.entries(index.knowledge.datasets).filter(([,d])=>Array.isArray(d.subjects)&&d.subjects.some((s:any)=>semanticId(s.entity)===item.id)).map(([id])=>id);
          if(item.kind==='Type')point.type=decodeURIComponent(item.id.slice('types/'.length));
          if(item.kind==='Value'&&item.id.startsWith('types/')){const parts=item.id.split('/');point.type=decodeURIComponent(parts[1]);point.variant=decodeURIComponent(parts[3]);}
          if(item.kind==='Field'&&item.dataset){
            const d=index.knowledge.datasets[item.dataset];point.members=[];
            for(const [section,kind] of [['dimensions','dimension'],['measures','measure']])for(const [id,m] of Object.entries((d?.[section]??{}) as Record<string,any>))if(typeof m.field==='string'&&semanticId(m.field)===item.id)point.members.push({id,kind});
          }
          return point;
        });
        const contracts=await infoContracts(points,exec);
        for(const item of data.items)item.dari=contracts[item.id];
      }
      return {ok:true,model:entry.modelHash,data};
    }
    return {ok:true,model:entry.modelHash,data:name==='discover'?discoverConcepts(index.knowledge,args):name==='routes'?routePoints(index.knowledge,args):searchPoints(index.knowledge,args)};
  };
  const fixed: ToolDefinition[] = [
    {
      name: 'oks_discover',
      description: 'Find conceptual properties and their Dataset query mappings in one call: {queries:[{entity:"term",props:[...],values?:[...]}]}. Prerequisite: call va_ask. entity, props and values must contain only verbatim ASCII English vocabulary entries returned by va_ask, preserving spelling and case. Never use Chinese, raw user wording, translations, rewrites, abbreviations or concatenated terms. If no suitable entry was returned, ask va_ask again. Fuzzy matching is internal; do not manufacture fuzzy query variants. Use entity and property terms; properties include dimensions, measures and counters. Optional values match named enum values/aliases, then find properties of their owning Type. Property terms and value-derived properties are complementary, not a requirement that a measure use the enum type. Returns a compact Markdown list grouped first by matched Entity (# entities/ID), then Dataset (## datasets/ID), with relative dimension/measure paths and each member’s type; append the relative path to the Dataset ID for an oks_info ID. Named value details can be read with oks_info. does not choose joins, infer aggregate safety or read business data. Use oks_routes/oks_info for relationships and complete constraints, for complete definitions. Returns all matches, deduplicated by Entity, Dataset and member; no per-term result cap.'+(ENABLE_OKS_SEARCH?' Use oks_search for scoped lexical searches.':''),
      parameters:{type:'object',properties:{queries:{type:'array',minItems:1,maxItems:12,items:{type:'object',properties:{entity:{type:'string',minLength:1,maxLength:200},props:{type:'array',maxItems:12,items:{type:'string',minLength:1,maxLength:200}},values:{type:'array',maxItems:12,items:{type:'string',minLength:1,maxLength:200}}},required:['entity','props'],additionalProperties:false}}},required:['queries'],additionalProperties:false},
      output:{schema:OBJECT_OUTPUT,render:renderConcepts},
      async execute(raw,exec){return method('discover',check(raw,['queries']),exec);},
    },
    {
      name:'oks_search',
      description:'Lexical knowledge search: {q:[...],scope:[...]}. Prerequisite: call va_ask. Every q item must be a verbatim ASCII English vocabulary entry returned by va_ask, preserving spelling and case; never use Chinese, raw user wording, translations, rewrites, abbreviations or concatenated terms. Ask va_ask again if needed. scope uses actual knowledge IDs or declared categories, not vocabulary terms. Both arrays are required and nonempty; all q terms share the same scope. Category scopes datasets/entities/types find roots; exact root IDs search their members. Content directories restrict search to a section; types/ID/references searches enabled direct reference sites. Multiple scopes form a union. Valid empty scopes return no matches; unknown scopes are errors. Partial words and small English typos are supported. Returns at most 10 matches per term, grouped by parent ID; append the displayed relative name to that exact parent to obtain an oks_info ID. Use va_ask for unfamiliar vocabulary, then search its terms to discover actual IDs. Use oks_routes for relationships. No business data reads.',
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
      name: 'oks_info', description: 'Read exact knowledge points from scoped search results or routes. Returns Markdown sections headed by exact IDs, explicit short query names and complete definitions; complex expressions remain JSON blocks. ids is a batch of 1..64 complete node IDs; each item contains only its own definition, no recursive navigation or inline child graph. Empty descriptions are omitted. Types, enums, formulas, predicates, identity parts and query constraints are retained. Unknown IDs are reported individually. Query names stay short as defined by each point ID and its facts.'+' Includes model-published .dari source contracts: Dataset and member symbols, logical types, enum variants and Relation endpoints/cardinalities. Use these exact symbols in source. Entity definitions include carrier Dataset symbols. Read Dataset info for its full source contract.',
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
  return [builtinRead, ...definitions, ...fixed.filter(tool=>ENABLE_OKS_SEARCH||tool.name!=='oks_search')];
}
