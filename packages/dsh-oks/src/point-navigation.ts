import {encodePart} from './knowledge-graph.ts';
import {knowledgePoints} from './point-knowledge.ts';
import {knowledgeNode,semanticId} from './semantic-id.ts';
import {lexicalQuery,matchLexical} from './knowledge-match.ts';
import type {SemanticGraph} from './knowledge-graph.ts';

const record=(v:unknown):v is Record<string,any>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const compare=(a:string,b:string)=>a<b?-1:a>b?1:0;
const unique=(ids:string[])=>[...new Set(ids)].sort(compare);
const shortDoc=(s:string)=>[...s.replace(/\s+/g,' ').trim()].slice(0,20).join('');
const queryName=(id:string)=>decodeURIComponent(id.split('/').at(-1)!);
function logicalType(fact:Record<string,any>):string|undefined {
  if(typeof fact.type==='string')return fact.type;
  if(typeof fact.output_type==='string')return ({Integer:'Int',Number:'Float',Text:'String',Boolean:'Bool'} as Record<string,string>)[fact.output_type]??fact.output_type;
  if(fact.aggregate==='Count'||fact.aggregate==='CountDistinct')return 'Int';
  return undefined;
}
export function searchPoints(graph:SemanticGraph,args:Record<string,any>){
  if(!record(args)||Object.keys(args).some(k=>!['q','scope'].includes(k)))throw new Error('search accepts only {q:[...],scope:[...]}');
  if(!Array.isArray(args.q)||!args.q.length||args.q.length>12||args.q.some((q:any)=>typeof q!=='string'||!q.trim()||q.length>200))throw new Error('q requires 1..12 nonempty search terms (at most 200 characters each)');
  if(!Array.isArray(args.scope)||!args.scope.length||args.scope.length>12||args.scope.some((id:any)=>typeof id!=='string'))throw new Error('scope requires 1..12 categories, root IDs, content directories or type references scopes');
  const index=knowledgePoints(graph),scope=unique(args.scope);
  const members:Record<string,string[]>={datasets:['fields','roles','dimensions','measures','time_roles','business_links','relations'],entities:['fields','roles','dimensions','measures','time_roles','business_links','relations'],types:['values']};
  const selected=new Set<string>();
  for(const id of scope){
    if(['datasets','entities','types'].includes(id)){
      for(const p of index.values())if(p.id===p.root&&p.id.startsWith(id+'/'))selected.add(p.id);
      continue;
    }
    const parts=id.split('/'),root=parts.slice(0,2).join('/');
    knowledgeNode(graph,root);const owner=index.get(root);
    if(!owner||owner.id!==owner.root||!members[parts[0]])throw new Error('Unsupported search scope: '+id);
    if(parts.length===2){
      for(const p of index.values())if(p.root===root&&p.id!==root)selected.add(p.id);
    }else if(parts.length===3&&members[parts[0]].includes(parts[2])){
      for(const p of index.values())if(p.id.startsWith(id+'/'))selected.add(p.id);
    }else if(parts.length===3&&parts[0]==='types'&&parts[2]==='references'){
      if(owner.fact.reverse_references!==true)continue;
      const refs:string[]=Array.isArray(owner.fact.reference_locations)
        ?owner.fact.reference_locations.map((site:any)=>semanticId(site.node)+(site.path.length?'/'+site.path[0]+'/'+encodePart(site.path[1]):''))
        :Object.values(owner.fact.referenced_by??{}).flat().filter((v):v is string=>typeof v==='string').map(semanticId);
      for(const ref of refs)if(index.has(ref))selected.add(ref);
    }else throw new Error('Unsupported search scope: '+id);
  }
  const candidates=[...selected].map(id=>index.get(id)!);
  const clauses=args.q.map((q:string)=>({q,scope,take:10,query:lexicalQuery(q)}));
  const results=clauses.map(({q,scope,take,query})=>{
    const ranked=candidates.flatMap(p=>{
      const canonical=(p.fact.canonical_values??[]).flatMap((v:any)=>typeof v==='string'?[v]:[v.id,v.label].filter(x=>typeof x==='string'));
      const fields=[{field:'id',text:queryName(p.id),weight:4},...p.names.map(text=>({field:'name',text,weight:3})),{field:'doc',text:p.doc,weight:1},...canonical.map((text:string)=>({field:'value',text,weight:3}))];
      const {score}=matchLexical(query,fields);return score?[{point:p,score}]:[];
    }).sort((a,b)=>b.score-a.score||compare(a.point.id,b.point.id));
    const items=ranked.slice(0,take).map(({point:p})=>({id:p.id,kind:p.kind,...(logicalType(p.fact)?{type:logicalType(p.fact)}:{}),doc:shortDoc(p.doc||p.fact.description||p.names.find(n=>n!==queryName(p.id))||'')}));
    return {q,scope,items,truncated:ranked.length>items.length};
  });
  return {results};
}

type Edge={from:string;to:string;relation:string;cardinality:Record<string,unknown>|null;key:unknown;guard:unknown;from_role?:string;to_role?:string};
export function routePoints(graph:SemanticGraph,args:Record<string,any>){
  if(Object.keys(args).some(k=>!['from','to','max_depth'].includes(k))||typeof args.from!=='string'||typeof args.to!=='string')throw new Error('routes requires from and to root IDs');
  const index=knowledgePoints(graph),maxDepth=args.max_depth??2;
  if(!Number.isInteger(maxDepth)||maxDepth<1||maxDepth>3)throw new Error('routes max_depth must be 1..3');
  function endpoint(id:string){
    knowledgeNode(graph,id);const p=index.get(id);
    if(!p||p.id!==p.root||!['Dataset','Entity'].includes(p.kind))throw new Error('routes endpoints must be Dataset/Entity root IDs: '+id);
    if(p.kind==='Dataset')return [id];
    return unique([...index.values()].filter(v=>v.kind==='Role'&&typeof v.fact.entity==='string'&&semanticId(v.fact.entity)===id).map(v=>v.root));
  }
  const sources=endpoint(args.from),targets=new Set(endpoint(args.to));
  const adjacency=new Map<string,{to:string;edge:Edge}[]>();
  for(const p of index.values())if(p.kind==='Relation'&&p.id===p.root){
    const f=p.fact;if(typeof f.from_dataset!=='string'||typeof f.to_dataset!=='string')continue;
    const from=semanticId(f.from_dataset),to=semanticId(f.to_dataset);if(!index.has(from)||!index.has(to))continue;
    const edge:Edge={from,to,relation:p.id,cardinality:f.cardinality??null,key:f.key??null,guard:f.guard??null,...(f.from_role?{from_role:semanticId(f.from_role)}:{}),...(f.to_role?{to_role:semanticId(f.to_role)}:{})};
    for(const [a,b] of [[from,to],[to,from]]){const list=adjacency.get(a)??[];list.push({to:b,edge});adjacency.set(a,list);}
  }
  for(const list of adjacency.values())list.sort((a,b)=>compare(a.edge.relation,b.edge.relation)||compare(a.to,b.to));
  type Path={nodes:string[];edges:Edge[]};
  let frontier:Path[]=sources.map(id=>({nodes:[id],edges:[]})),paths:Path[]=[],expanded=0,truncated=false;
  for(let depth=0;depth<=maxDepth&&frontier.length;depth++){
    const found=frontier.filter(p=>targets.has(p.nodes.at(-1)!));
    if(found.length){paths=found.slice(0,8);truncated=found.length>8;break;}
    if(depth===maxDepth)break;
    const next:Path[]=[];
    search:for(const path of frontier)for(const step of adjacency.get(path.nodes.at(-1)!)??[]){
      if(++expanded>10000){truncated=true;break search;}
      if(path.nodes.includes(step.to))continue;
      next.push({nodes:[...path.nodes,step.to],edges:[...path.edges,step.edge]});
    }
    frontier=next;
    if(truncated){paths=frontier.filter(p=>targets.has(p.nodes.at(-1)!)).slice(0,8);break;}
  }
  return {from:args.from as string,to:args.to as string,max_depth:maxDepth,paths,truncated,status:paths.length?'connected':truncated?'incomplete':'not_found_within_depth'};
}
