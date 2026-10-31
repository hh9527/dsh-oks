import { encodePart } from './knowledge-graph.ts';
type Obj=Record<string,any>;
const allowed:Record<string,string[]>={search:['query','type','dataset','skip','take'],read:['key'],card:['id','section','skip','take','docs'],cap:['cq','join_depth','skip','take']};
const methodDefaults=(name:string):Obj=>({search:{skip:0,take:10},read:{},card:{section:'all',skip:0,take:20,docs:false},cap:{join_depth:1,skip:0,take:20}}[name]??{});
export function knowledgeArgs(name:string,rawArgs:unknown):Obj {
 if(!Object.hasOwn(allowed,name))throw new Error('Unknown knowledge method: '+name);
  if(rawArgs!==undefined&&(rawArgs===null||typeof rawArgs!=='object'||Array.isArray(rawArgs)))throw new Error('Knowledge arguments must be an object');
  const args:Record<string,unknown>={...methodDefaults(name),...rawArgs as Record<string,unknown>};
  for(const key of Object.keys(args))if(!allowed[name].includes(key))throw new Error(`Unknown knowledge argument: ${key}`);
  if((allowed[name].includes('skip')&&(!Number.isSafeInteger(args.skip)||Number(args.skip)<0))||(allowed[name].includes('take')&&(!Number.isSafeInteger(args.take)||Number(args.take)<1||Number(args.take)>50)))throw new Error('knowledge skip must be nonnegative; take must be 1..50');
  for(const key of ['key','query','type','dataset','id','section'])if(args[key]!==undefined&&(typeof args[key]!=='string'||(key!=='query'&&args[key]==='')))throw new Error(`knowledge ${key} must be a string`);
  if(name==='read'&&typeof args.key!=='string')throw new Error('read requires key');
  if(typeof args.key==='string' && !/^(entities|datasets|dimension_groups|measure_groups|types|relations|tools)\/[^/#]+(?:#[^#]+)?$/.test(args.key))throw new Error(`Unknown knowledge key: ${args.key}`);
  for(const key of ['docs'])if(args[key]!==undefined&&typeof args[key]!=='boolean')throw new Error(`knowledge ${key} must be boolean`);
  if(name==='card') {
    if(typeof args.id!=='string')throw new Error('card requires dataset id');
    if(!['all','shape','fields','roles','bindings','dimensions','measures','time_roles','relations','business_links'].includes(args.section as string))throw new Error('Unknown card section');
  }
  if(name==='cap') {
    if(!Number.isSafeInteger(args.join_depth)||Number(args.join_depth)<0||Number(args.join_depth)>2)throw new Error('cap join_depth must be 0..2');
    const record=(value:unknown):value is Record<string,unknown> => value!==null && typeof value==='object' && !Array.isArray(value);
    const cq=args.cq;
    if(!record(cq)||!record(cq.target))throw new Error('cap requires cq.target');
    for(const key of Object.keys(cq))if(!['target','node','select','measures','window','rank'].includes(key))throw new Error(`Unknown cq field: ${key}`);
    const targets=Object.keys(cq.target);
    if(targets.length!==1||!['dataset','entity'].includes(targets[0])||typeof cq.target[targets[0]]!=='string'||!cq.target[targets[0]])throw new Error('cq.target requires exactly one dataset or entity ID');
    if(cq.node!==undefined&&(typeof cq.node!=='string'||!cq.node))throw new Error('cq.node must be a nonempty string');
    for(const [field,member] of [['select','dimension'],['measures','measure']] as const) {
      const entries=cq[field];
      if(entries!==undefined&&(!Array.isArray(entries)||entries.length>50||entries.some(item=>!record(item)||Object.keys(item).length!==1||typeof item[member]!=='string'||!item[member])))throw new Error(`cq.${field} requires at most 50 {${member}: ID} entries`);
    }
    for(const [field,member,allowed] of [['window','dimension',['dimension','start','end']],['rank','measure',['measure','direction','take']]] as const){
      const value=cq[field];
      if(value!==undefined&&value!==null&&(!record(value)||typeof value[member]!=='string'||!value[member]||Object.keys(value).some(k=>!(allowed as readonly string[]).includes(k))))throw new Error(`cq.${field} requires ${member} and declared request fields`);
    }
  }

 return args;
}
const own=(o:any,k:string):any=>o!==null&&typeof o==='object'&&Object.hasOwn(o,k)?o[k]:null;
const entries=(o:any):[string,any][]=>Object.entries(o??{});
const values=(o:any):any[]=>Object.values(o??{});
const unique=(xs:any[])=>[...new Set(xs)].sort();
const pathOf=(key:string)=>key.split('#').flatMap(p=>p.split('/').map(decodeURIComponent));
const fact=(g:Obj,key:string)=>pathOf(key).reduce((o,k)=>own(o,k),g);
const kinds:Obj={entities:'Entity',datasets:'Dataset',types:'Ty',dimension_groups:'DimensionGroup',measure_groups:'MeasureGroup',relations:'Relation',fields:'Field',roles:'Role',bindings:'Binding',dimensions:'Dimension',measures:'Measure',values:'Value',time_roles:'TimeRole',business_links:'BusinessLink'};
const identity=(key:string)=>{const p=pathOf(key);return {key,type:kinds[p.at(-2)!]??null,id:p.at(-1)!,dataset:p[0]==='datasets'?p[1]:null};};
const page=(items:any[],skip:number,take:number)=>({total:items.length,start:skip,items:items.slice(skip,skip+take),next:skip+take<items.length?skip+take:null});
const windowPage=(items:any[],skip:number,take:number)=>({total:items.length,skip,take,truncated:skip>0||skip+take<items.length,next:skip+take<items.length?skip+take:null});
const asciiLower=(s:string)=>s.replace(/[A-Z]/g,c=>c.toLowerCase());
/** Fixed host methods over the already-built knowledge graph; no source evaluation or graph mutation. */
export function queryKnowledge(g:Obj,name:string,rawArgs:unknown):unknown {
 const a=knowledgeArgs(name,rawArgs);
 const items:any[]=g.items??[];
 if(name==='search'){
  if(typeof a.query!=='string'||!a.query.trim())throw new Error('search requires nonempty query');
  const query=asciiLower(a.query??'');
  const matches=items.flatMap(item=>{
   const id=identity(item.key);
   if(a.type!=null&&a.type!==id.type||a.dataset!=null&&a.dataset!==id.dataset)return [];
   const hits=[{field:'id',text:id.id,weight:4},...(item.names??[]).map((text:string)=>({field:'name',text,weight:3})),{field:'doc',text:item.doc??'',weight:1}].filter(x=>asciiLower(x.text).includes(query));
   return hits.length?[{...id,label:item.names?.[0]??id.id,summary:[...(item.doc??'')].slice(0,160).join(''),matched:unique(hits.map(h=>h.field)),score:Math.max(...hits.map(h=>h.weight))}]:[];
  }).sort((x,y)=>y.score-x.score||(x.key<y.key?-1:x.key>y.key?1:0));
  return page(matches,a.skip,a.take);
 }
 if(name==='read'){
  const facts=fact(g,a.key);if(facts==null)throw new Error('Unknown knowledge key: '+a.key);
  const prefix=a.key+(a.key.includes('#')?'/':'#');
  return {key:a.key,facts,items:items.filter(x=>x.key===a.key||x.key.startsWith(prefix))};
 }
 const ix=new Map(items.map(x=>[x.key,x]));
 const label=(key:string,fallback:string)=>ix.get(key)?.names?.[0]||fallback;
 const doc=(key:string)=>ix.get(key)?.doc??'';
 if(name==='card'){
  const d=own(g.datasets,a.id);if(d==null)throw new Error('Unknown dataset id: '+a.id);
  const key='datasets/'+encodePart(a.id);
  const section=(cat:string,fn:(v:Obj)=>Obj)=>entries(d[cat]).map(([id,v])=>{
   const ref=key+'#'+cat+'/'+encodePart(id);
   return {id,key:ref,label:label(ref,id),...fn(v),...(a.docs?{doc:doc(ref)}:{})};
  });
  const pick=(v:Obj,keys:string[],defaults:Obj={})=>Object.fromEntries(keys.map(k=>[k,v[k]??defaults[k]??null]));
  const dimensions=section('dimensions',v=>({...pick(v,['field','fields','type','ops','filterable','input_kinds','output_type','authorized','projectable','computed','canonical_order','canonical_values','binding','group'],{canonical_order:[],canonical_values:[]}),...(v.half_open!=null?{half_open:v.half_open}:{}),...(v.utc_bucket!=null?{utc_bucket:v.utc_bucket}:{})}));
  const measures=section('measures',v=>({...pick(v,['type','anchor_field','statistic','input','requires','binding','group','computed','predicate'],{requires:[]}),agg:v.aggregate??null,unit:v.sampling?.unit??null,sampling_role:v.sampling?.role??null}));
  const time_roles=section('time_roles',v=>pick(v,['field','encoding','semantics','authoritative']));
  const relations=(d.relations??[]).map((ref:string)=>{const r=fact(g,ref)??{},id=pathOf(ref).at(-1)!;return {id,key:ref,label:label(ref,id),from:r.from_dataset??null,to:r.to_dataset??null,cardinality:r.cardinality??null,key_fields:r.key??null,guard:r.guard??null,from_role:r.from_role??null,to_role:r.to_role??null,directions:['forward','reverse'],...(a.docs?{doc:doc(ref)}:{})};});
  const raw=(cat:string)=>entries(d[cat]).map(([id,facts])=>({id,key:key+'#'+cat+'/'+encodePart(id),facts}));
  const sections:Obj={fields:raw('fields'),dimensions,measures,time_roles,relations,roles:raw('roles'),bindings:raw('bindings'),business_links:raw('business_links')};
  const aggregates=unique(values(d.measures).map(v=>v.aggregate??null));
  const result:Obj={id:a.id,key,label:label(key,a.id),doc:doc(key),grain:d.grain??[],kind:d.kind??null,source:d.source??null,clock:d.clock??null,scope:d.scope??[],references:d.references??[],field_roles:entries(d.fields).filter(([,v])=>v.roles?.length).map(([field,v])=>({field,roles:v.roles})),row:d.row??null,business_links:sections.business_links.length,aggregates,sum_available:aggregates.includes('Sum'),has_time:time_roles.length>0,time_encoding:unique(values(d.time_roles).map(v=>v.encoding??null)),buckets:unique(values(d.dimensions).filter(v=>v.utc_bucket!=null).map(v=>v.utc_bucket.unit)),units:unique(values(d.measures).map(v=>v.sampling?.unit).filter(v=>v!=null)),counts:Object.fromEntries(entries(sections).map(([k,v])=>[k,v.length])),page:{skip:a.skip,take:a.take}};
  for(const [cat,rows]of entries(sections))if(a.section==='all'||a.section===cat){result[cat]=rows.slice(a.skip,a.skip+a.take);(result.pages??={})[cat]=windowPage(rows,a.skip,a.take);}
  return result;
 }
 const cq=a.cq,node=cq.node??'d';
 const candidates:string[]=cq.target.dataset!=null?(own(g.datasets,cq.target.dataset)!=null?[cq.target.dataset]:[]):own(g.entities,cq.target.entity)!=null?unique((g.entities[cq.target.entity].roles??[]).flatMap((r:string)=>{const p=pathOf(r.split('#')[0]);return p[0]==='datasets'&&own(g.datasets,p[1])!=null?[p[1]]:[];})):[];
 const ds=candidates.length===1?candidates[0]:null,d=ds!==null?g.datasets[ds]:null,address=ds!==null?'datasets/'+encodePart(ds):null;
 const capabilities=(requested:any[],cat:string,field:string)=>requested.map(r=>({id:r[field],address:address?address+'#'+cat+'/'+encodePart(r[field]):null,facts:d?own(d[cat],r[field]):null}));
 const select=capabilities(cq.select??[],'dimensions','dimension'),measures=capabilities(cq.measures??[],'measures','measure');
 const dimension=d?own(d.dimensions,cq.window?.dimension):null;
 const time=cq.window==null?null:{requested:cq.window,dimension,roles:entries(d?.time_roles).filter(([,v])=>v.field!=null&&v.field===dimension?.field).map(([id,facts])=>({address:address+'#time_roles/'+encodePart(id),facts}))};
 const unresolved:any[]=[...(ds===null?[{field:'target',reason:candidates.length>1?'multiple_datasets':'not_found'}]:[]),...select.filter(v=>v.facts==null).map(v=>({field:'select',id:v.id,reason:'not_found'})),...measures.filter(v=>v.facts==null).map(v=>({field:'measures',id:v.id,reason:'not_found'})),...(cq.window!=null&&time?.dimension==null?[{field:'window.dimension',id:cq.window.dimension,reason:'not_found'}]:[]),...(cq.rank!=null&&own(d?.measures,cq.rank.measure)==null?[{field:'rank.measure',id:cq.rank.measure,reason:'not_found'}]:[])];
 const step=(id:string,r:Obj,direction:string)=>({relation:id,address:'relations/'+encodePart(id),direction,from:direction==='forward'?r.from_dataset:r.to_dataset,to:direction==='forward'?r.to_dataset:r.from_dataset,from_role:r.from_role??null,to_role:r.to_role??null,cardinality:r.cardinality??null,key:r.key??null,guard:r.guard??null});
 const outgoing=(from:string)=>entries(g.relations).flatMap(([id,r])=>[...(r.from_dataset===from?[step(id,r,'forward')]:[]),...(r.to_dataset===from?[step(id,r,'reverse')]:[])]);
 const one=ds===null||a.join_depth===0?[]:outgoing(address!).map(s=>({path:[address,s.to],steps:[s]}));
 const two=a.join_depth<2?[]:one.flatMap(p=>outgoing(p.path.at(-1)!).filter(s=>!p.path.includes(s.to)).map(s=>({path:[...p.path,s.to],steps:[...p.steps,s]})));
 const joins=[...new Map([...one,...two].map(p=>[JSON.stringify([p.path,p.steps.map(s=>[s.relation,s.direction])]),p])).values()].sort((x,y)=>x.steps.length-y.steps.length||JSON.stringify([x.path,x.steps.map(s=>s.relation)]).localeCompare(JSON.stringify([y.path,y.steps.map(s=>s.relation)]),'en'));
 return {target:{requested:cq.target,candidates,dataset:ds,address},dataset:d?{grain:d.grain??null,kind:d.kind??null,scope:d.scope??null,clock:d.clock??null,counts:{roles:entries(d.roles).length,bindings:entries(d.bindings).length},available:Object.fromEntries(['dimensions','measures','time_roles'].map(cat=>[cat,page(Object.keys(d[cat]??{}).sort(),a.skip,a.take)]))}:null,select,measures,time,unresolved,joins:page(joins,a.skip,a.take),discovery:{join_depth:a.join_depth,path_scope:'direct_relations',requires_transform:true},candidate_intent:unresolved.length?null:{op:'Graph',root:node,nodes:[{id:node,entity:ds}],edges:[],select:(cq.select??[]).map((r:any)=>({node,dimension:r.dimension})),...(measures.length?{measures:(cq.measures??[]).map((r:any)=>({node,measure:r.measure}))}:{}),...(cq.window!=null?{time_windows:[{node,...cq.window}]}:{}),...(cq.rank!=null?{top_by_measure:{...cq.rank,node}}:{})},receipts:[...(address?[{address,fact:'dataset'}]:[]),...[...select,...measures].filter(v=>v.facts!=null).map(v=>({address:v.address,fact:'capability'})),...(time?.roles??[]).map(v=>({address:v.address,fact:'time_role'}))]};
}
