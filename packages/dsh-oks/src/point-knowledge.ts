import {hasOwnedNodes} from './owned-knowledge.ts';
import { encodePart, graphRoots, refPath, type SemanticGraph } from './knowledge-graph.ts';
import { knowledgeNode, semanticId } from './semantic-id.ts';

type Fact = Record<string, any>;
type Point = {id:string;kind:string;root:string;fact:Fact;names:string[];doc:string;words:string[]};
const kinds:Record<string,string> = {datasets:'Dataset',entities:'Entity',types:'Type',relations:'Relation',dimension_groups:'DimensionGroup',measure_groups:'MeasureGroup',fields:'Field',roles:'Role',dimensions:'Dimension',measures:'Measure',time_roles:'TimeRole',business_links:'BusinessLink',values:'Value'};
const children = ['fields','roles','dimensions','measures','time_roles','business_links','values','relations'];
const normalize = (value:string) => value.normalize('NFKC').toLowerCase().replace(/[\\,:;\s]+/g,' ').trim();
const record = (value:unknown):value is Fact => value !== null && typeof value === 'object' && !Array.isArray(value);
const unique = (values:string[]) => [...new Set(values)].sort();
const cached = new WeakMap<object,Map<string,Point>>();
export function knowledgePoints(graph:SemanticGraph):Map<string,Point> {
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
  const point=knowledgePoints(graph).get(id);
  if(!point)throw new Error('Not a public knowledge point: '+id);
  return point;
}
const navigation=new Set(['props','peers','reference_locations','referenced_by','related','traversable','bindings','binding','group','dimension_groups','measure_groups','types','datasets','entities','dimensions','measures','time_roles','business_links','relations','fields','roles']);
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
  if(Array.isArray(out.subjects))out.subjects=out.subjects.map((subject:any)=>({...subject,entity:publicRef(subject.entity),field:publicRef(subject.field)}));
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
      if(path[0]==='datasets'){query.dataset=path[1];if(path.length===4){const member:Record<string,string>={fields:'field',dimensions:'dimension',measures:'measure',roles:'role'};if(member[path[2]])query[member[path[2]]]=path[3];if(path[2]==='relations')query.relation=p.fact.relation??path[3];}}
      else if(path[0]==='entities')query.entity=path[1];else if(path[0]==='relations')query.relation=path[1];
      items.push({id,kind:p.kind,...(hasOwnedNodes(graph)?{node:p.root,path:path.slice(2)}:{}),...query,...(p.names.length?{names:p.names}:{}),...(p.doc.trim()?{doc:p.doc}:{}),facts:definition(p)});
    }catch(error){errors.push({id,error:(error as Error).message});}
  }
  return {items,...(errors.length?{errors}:{})};
}
