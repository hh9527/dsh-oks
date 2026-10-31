import { encodePart, graphRoots, refPath, type SemanticGraph } from './knowledge-graph.ts';
import { knowledgeNode, semanticId } from './semantic-id.ts';

type Fact = Record<string, any>;
type Point = {id:string;kind:string;root:string;fact:Fact;names:string[];doc:string;words:string[]};
const kinds:Record<string,string> = {datasets:'Dataset',entities:'Entity',types:'Type',relations:'Relation',dimension_groups:'DimensionGroup',measure_groups:'MeasureGroup',fields:'Field',roles:'Role',dimensions:'Dimension',measures:'Measure',time_roles:'TimeRole',business_links:'BusinessLink',values:'Value'};
const children = ['fields','roles','dimensions','measures','time_roles','business_links','values'];
const normalize = (value:string) => value.normalize('NFKC').toLowerCase().replace(/[\\,:;\s]+/g,' ').trim();
const record = (value:unknown):value is Fact => value !== null && typeof value === 'object' && !Array.isArray(value);
const unique = (values:string[]) => [...new Set(values)].sort();
const cached = new WeakMap<object,Map<string,Point>>();
function points(graph:SemanticGraph):Map<string,Point> {
  let index=cached.get(graph);if(index)return index;
  index=new Map();
  const docs=new Map((graph.items??[]).map(item=>[item.key,item]));
  const add=(ref:string,fact:Fact)=>{
    const path=refPath(ref),item=docs.get(ref),names=item?.names??[];
    const canonical=(Array.isArray(fact.canonical_values)?fact.canonical_values:[]).flatMap((v:any)=>typeof v==='string'?[v]:[v.id,v.label].filter((s:any)=>typeof s==='string'));
    const id=semanticId(ref),root=id.split('/').slice(0,2).join('/');
    index!.set(id,{id,root,kind:kinds[path.at(-2)!],fact,names,doc:item?.doc??'',words:[path.at(-1)!,...names,item?.doc??'',...canonical].map(normalize).filter(Boolean)});
  };
  for(const category of graphRoots){
    if(category==='tools')continue;
    for(const [name,fact] of Object.entries((graph as any)[category]??{})){
      if(!record(fact))continue;
      const root=category+'/'+encodePart(name);add(root,fact);
      for(const child of children)if(record(fact[child]))for(const [member,value] of Object.entries(fact[child]))if(record(value))add(root+'#'+child+'/'+encodePart(member),value);
    }
  }
  cached.set(graph,index);return index;
}
function getPoint(graph:SemanticGraph,id:string):Point {
  knowledgeNode(graph,id);
  const point=points(graph).get(id);
  if(!point)throw new Error('Not a public knowledge point: '+id);
  return point;
}
function references(value:unknown,index:Map<string,Point>,into:Set<string>):void {
  if(typeof value==='string'){
    try{const id=semanticId(value);if(index.has(id))into.add(id);}catch{}
  }else if(Array.isArray(value))for(const v of value)references(v,index,into);
  else if(record(value))for(const key of ['type','types','identity','logical_type','raw','item','element','key','value','fields','variants','args'])if(Object.hasOwn(value,key))references(value[key],index,into);
}
const typeKeys=['type','types','identity','logical_type','field_types','arguments','variants','parts'];
function typeDependencies(point:Point,index:Map<string,Point>):string[] {
  const refs=new Set<string>();
  for(const key of typeKeys)references(point.fact[key],index,refs);
  return [...refs].filter(id=>id.startsWith('types/'));
}

export interface KnowledgeAnchor {id:string;terms?:string[]}
/** Resolve lexical anchors and index points without serializing their definitions. */
export function discoverPoints(graph:SemanticGraph,args:Record<string,any>) {
  if(Object.keys(args).some(key=>!['anchors','max_depth'].includes(key)))throw new Error('Point discovery accepts anchors and max_depth');
  if(!Array.isArray(args.anchors)||!args.anchors.length||args.anchors.length>12)throw new Error('anchors requires 1..12 {id,terms?} entries');
  const maxDepth=args.max_depth??2;
  if(!Number.isInteger(maxDepth)||maxDepth<0||maxDepth>3)throw new Error('max_depth must be 0..3');
  const index=points(graph),selected=new Set<string>(),datasets=new Set<string>();
  const anchors=args.anchors.map((a:any)=>{
    if(!record(a)||Object.keys(a).some(k=>!['id','terms'].includes(k))||typeof a.id!=='string'||(a.terms!==undefined&&(!Array.isArray(a.terms)||a.terms.length>20||a.terms.some((t:any)=>typeof t!=='string'||!normalize(t)||t.length>200))))throw new Error('Each anchor needs id and at most 20 nonempty terms');
    const point=getPoint(graph,a.id);
    const scope=[...index.values()].filter(p=>p.id===point.id||(point.id===point.root&&p.root===point.root));
    for(const p of scope)selected.add(p.id);
    if(point.root.startsWith('datasets/'))datasets.add(point.root);
    const matches=(a.terms??[]).map((term:string)=>({term,ids:scope.filter(p=>p.words.some(word=>word.includes(normalize(term)))).map(p=>p.id).sort()}));
    return {id:point.id,kind:point.kind,matches,unresolved_terms:matches.filter((m:any)=>!m.ids.length).map((m:any)=>m.term)};
  });
  // Entity anchors retain candidate carriers; only explicitly selected datasets
  // participate in paths, so a popular Entity cannot fan out into the whole graph.
  const carriers=anchors.filter((a:any)=>a.kind==='Entity').map((a:any)=>({entity:a.id,datasets:unique([...index.values()].filter(p=>p.kind==='Role'&&p.fact.entity===a.id).map(p=>p.root))}));
  const adjacency=new Map<string,{to:string;relation:string}[]>();
  for(const point of index.values())if(point.kind==='Relation'){
    const {from_dataset:from,to_dataset:to}=point.fact;
    if(typeof from!=='string'||typeof to!=='string'||!index.has(from)||!index.has(to))continue;
    for(const [a,b] of [[from,to],[to,from]]){const list=adjacency.get(a)??[];list.push({to:b,relation:point.id});adjacency.set(a,list);}
  }
  for(const list of adjacency.values())list.sort((a,b)=>a.relation.localeCompare(b.relation,'en')||a.to.localeCompare(b.to,'en'));
  const targets=unique([...datasets]),connections:any[]=[];
  for(let i=0;i<targets.length;i++)for(let j=i+1;j<targets.length;j++){
    const from=targets[i],to=targets[j];let frontier=[{nodes:[from],relations:[] as string[]}],paths:typeof frontier=[];let truncated=false,expanded=0;
    for(let depth=0;depth<maxDepth&&!paths.length;depth++){
      const next:typeof frontier=[];
      search:for(const path of frontier)for(const edge of adjacency.get(path.nodes.at(-1)!)??[]){
        if(++expanded>10000){truncated=true;break search;}
        if(path.nodes.includes(edge.to))continue;
        const p={nodes:[...path.nodes,edge.to],relations:[...path.relations,edge.relation]};
        if(edge.to===to){if(paths.length<8)paths.push(p);else truncated=true;}else next.push(p);
      }
      frontier=next;if(truncated)break;
    }
    for(const path of paths){for(const id of path.nodes)selected.add(id);for(const id of path.relations)selected.add(id);}
    connections.push({from,to,paths,truncated,status:paths.length?'connected':truncated?'incomplete':'not_found_within_depth'});
  }
  // Publish named type dependencies as IDs; their values remain individually readable.
  const queue=[...selected];
  for(let i=0;i<queue.length;i++)for(const id of typeDependencies(index.get(queue[i])!,index))if(!selected.has(id)){
    selected.add(id);queue.push(id);
    for(const p of index.values())if(p.root===id&&!selected.has(p.id)){selected.add(p.id);queue.push(p.id);}
  }
  const grouped:Record<string,string[]>={};
  for(const id of [...selected].sort()){const kind=index.get(id)!.kind;(grouped[kind]??=[]).push(id);}
  return {anchors,index:grouped,connections,carriers,max_depth:maxDepth};
}

const navigation=new Set(['referenced_by','related','traversable','bindings','binding','group','dimension_groups','measure_groups','types','datasets','entities','dimensions','measures','time_roles','business_links','relations','fields','roles']);
function publicRef(value:any):any {
  if(typeof value!=='string')return value;
  try{return semanticId(value);}catch{return value;}
}
function definition(point:Point):Fact {
  const out:Fact={};
  for(const [key,value] of Object.entries(point.fact)){
    if((navigation.has(key)&&!(point.kind==='Field'&&key==='roles'))||(point.kind==='Type'&&key==='values')||key==='local')continue;
    if((key==='doc'||key==='description')&&(value===null||value===''))continue;
    out[key]=value;
  }
  for(const key of ['field','anchor_field','row','entity','identity','type','from_dataset','to_dataset','from_role','to_role'])if(Object.hasOwn(out,key))out[key]=publicRef(out[key]);
  if(Array.isArray(out.requires))out.requires=out.requires.map(publicRef);
  if(point.kind==='Relation'&&record(out.key)){
    const keyRefs=(key:Fact):Fact=>Object.fromEntries(Object.entries(key).map(([k,v])=>[k,['from','to'].includes(k)?publicRef(v):Array.isArray(v)?v.map(x=>record(x)?keyRefs(x):x):v]));
    out.key=keyRefs(out.key);
  }
  return structuredClone(out);
}
/** A batch transports independent exact reads; definitions never recursively expand neighbors. */
export function readPoints(graph:SemanticGraph,args:Record<string,any>) {
  if(Object.keys(args).some(k=>k!=='ids')||!Array.isArray(args.ids)||!args.ids.length||args.ids.length>64||args.ids.some((id:any)=>typeof id!=='string'))throw new Error('info accepts ids: 1..64 exact knowledge point IDs');
  const items:any[]=[],errors:any[]=[];
  for(const id of [...new Set<string>(args.ids)]){
    try{
      const p=getPoint(graph,id);
      const {path}=knowledgeNode(graph,id);const query:Fact={};
      if(path[0]==='datasets'){query.dataset=path[1];if(path.length===4){const member:Record<string,string>={fields:'field',dimensions:'dimension',measures:'measure',roles:'role'};if(member[path[2]])query[member[path[2]]]=path[3];}}
      else if(path[0]==='entities')query.entity=path[1];else if(path[0]==='relations')query.relation=path[1];
      items.push({id,kind:p.kind,...query,...(p.names.length?{names:p.names}:{}),...(p.doc.trim()?{doc:p.doc}:{}),facts:definition(p)});
    }catch(error){errors.push({id,error:(error as Error).message});}
  }
  return {items,...(errors.length?{errors}:{})};
}
