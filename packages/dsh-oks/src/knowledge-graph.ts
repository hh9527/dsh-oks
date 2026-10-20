import { isRecord } from './host.ts';
import type { KnowledgeNode } from './host.ts';

export interface KnowledgeItem { key: string; names: string[]; doc: string }
export interface SemanticGraph {
  datasets: Record<string, Record<string, unknown>>;
  types: Record<string, Record<string, unknown>>;
  relations: Record<string, Record<string, unknown>>;
  tools: Record<string, Record<string, unknown>>;
  items: KnowledgeItem[];
}
export const kindRoles: Record<string,string> = {Dataset:'datasets',Field:'fields',Dimension:'dimensions',Measure:'measures',Ty:'types',Value:'values',Relation:'relations',TimeRole:'time_roles',BusinessLink:'business_links'};
export const encodePart = (s:string):string => encodeURIComponent(s).replace(/[!'()*]/g,c=>`%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** 独立节点 # 节点内成员；字典键始终使用原始 ID。 */
export function refPath(ref:string):string[] {
  const halves=ref.split('#');
  if (halves.length>2 || halves.some(p=>p==='')) throw new Error(`Invalid knowledge address: ${ref}`);
  const root=halves[0].split('/');
  const member=halves[1]?.split('/') ?? [];
  if (root.length!==2 || !['datasets','types','relations','tools'].includes(root[0]) || (member.length!==0 && (member.length!==2 || ![...Object.values(kindRoles),'kinds','topics'].includes(member[0])))) throw new Error(`Invalid knowledge address: ${ref}`);
  return [...root,...member].map((s,i)=>{
    if (i%2===0) return s;
    const value=decodeURIComponent(s);
    if (!value || encodePart(value)!==s) throw new Error(`Noncanonical knowledge address: ${ref}`);
    return value;
  });
}
export function resolveFact(graph:SemanticGraph,ref:string):Record<string,unknown> {
  let value:unknown=graph;
  for(const p of refPath(ref)) value=isRecord(value)&&Object.hasOwn(value,p)?value[p]:undefined;
  if(!isRecord(value)) throw new Error(`Unknown knowledge key: ${ref}`);
  return value;
}
const own=(o:Record<string,unknown>,key:string,value:unknown) => Object.defineProperty(o,key,{value,writable:true,enumerable:true,configurable:true});
const unique=(texts:unknown[])=>[...new Set(texts.filter((s):s is string=>typeof s==='string'&&s!==''))];

export function buildSemanticGraph(nodes:KnowledgeNode[]):{graph:SemanticGraph;addresses:Map<string,string>} {
  const graph:SemanticGraph={datasets:{},types:{},relations:{},tools:{},items:[]};
  const addresses=new Map<string,string>();const facts=new Map<string,Record<string,unknown>>();const used=new Set<string>();
  for(const n of nodes) {
    if(n.type==='Index') continue;
    if(!n.type||!kindRoles[n.type]||!isRecord(n.address)||typeof n.address.node!=='string'||!(n.address.member===null||typeof n.address.member==='string')) throw new Error(`Missing model knowledge address: ${n.key}`);
    const ref=n.address.node+(n.address.member===null?'':`#${n.address.member}`);
    const path=refPath(ref);const role=kindRoles[n.type];
    if(path[path.length-2]!==role || (path.length===4 && path[0]!== (n.type==='Value'?'types':'datasets'))) throw new Error(`Knowledge address kind mismatch: ${n.key}`);
    if(used.has(ref)) throw new Error(`Duplicate knowledge address: ${ref}`);used.add(ref);addresses.set(n.key,ref);
    const fact:Record<string,unknown>={...structuredClone(n.detail??{})};
    for(const k of ['id','label','summary','aliases','localized']) delete fact[k];
    if(path.length===4) delete fact[path[0]==='types'?'ty':n.type==='BusinessLink'?'hub':'dataset'];
    if(n.type==='Dataset') delete fact.time_roles;
    if(n.type==='Ty'||n.type==='Dimension') delete fact.values;
    if(n.type==='Dimension'&&typeof fact.ty==='string') {fact.type=fact.ty;delete fact.ty;}
    facts.set(ref,fact);
    const d=n.description??{};
    const names=unique([d.label,...d.aliases??[],...(d.localized??[]).map(t=>t.label),...(d.terms??[]).map(t=>t.term)]);
    const doc=unique([d.summary,...(d.localized??[]).map(t=>t.summary),...(d.terms??[]).map(t=>t.description)]).join('\n');
    graph.items.push({key:ref,names,doc});
  }
  // 独立节点先就位，成员再填入父节点；不创建没有模型事实的虚假父节点。
  for(const [ref,fact] of facts) {const p=refPath(ref);if(p.length===2) own(graph[p[0] as 'datasets'|'types'|'relations'],p[1],fact);}
  for(const [ref,fact] of facts) {
    const p=refPath(ref);if(p.length!==4) continue;
    const parent=resolveFact(graph,`${p[0]}/${encodePart(p[1])}`);
    if(!Object.hasOwn(parent,p[2])) own(parent,p[2],{});
    if(!isRecord(parent[p[2]])) throw new Error(`Knowledge member category conflicts with fact: ${ref}`);
    own(parent[p[2]] as Record<string,unknown>,p[3],fact);
  }
  // 空成员目录也是可投影的稳定分支。
  for(const d of Object.values(graph.datasets)) for(const k of ['fields','dimensions','measures','time_roles','business_links']) if(!Object.hasOwn(d,k)) own(d,k,{});
  for(const t of Object.values(graph.types)) if(!Object.hasOwn(t,'values')) own(t,'values',{});
  const add=(fact:Record<string,unknown>,category:string,ref:string,nested?:string)=>{
    let into=fact;
    if(nested) {if(!Object.hasOwn(into,nested))own(into,nested,{});if(!isRecord(into[nested]))throw new Error('Navigation category conflict');into=into[nested] as Record<string,unknown>;}
    if(isRecord(into[category])) return; // 已内嵌的自有成员不再重复列引用。
    if(!Object.hasOwn(into,category))own(into,category,[]);
    const list=into[category];if(!Array.isArray(list)||list.some(x=>typeof x!=='string'))throw new Error(`Navigation conflicts with fact: ${category}`);
    if(!list.includes(ref))list.push(ref);
  };
  for(const n of nodes) {
    const from=addresses.get(n.key);if(!from)continue;
    for(const edge of n.links) {
      const to=addresses.get(edge.key);if(!to) {if(edge.key==='index')continue;throw new Error(`Unknown knowledge reference: ${edge.key}`);}
      const target=facts.get(to)!;const source=facts.get(from)!;
      const targetRole=refPath(to).at(-2)!;const sourceRole=kindRoles[n.type!];
      if(edge.role!==targetRole)throw new Error(`Model link role mismatch: ${n.key} → ${edge.key}`);
      if(edge.type==='Member') {add(source,targetRole,to);add(target,sourceRole,from);}
      else {add(source,targetRole,to,edge.type==='Related'?'related':'traversable');add(target,sourceRole,from,'referenced_by');}
    }
    const fact=facts.get(from)!;
    if(isRecord(fact.selection))for(const k of ['clock','grain'])if(Array.isArray(fact.selection[k]))fact.selection[k]=(fact.selection[k] as string[]).map(key=>{const ref=addresses.get(key);if(!ref)throw new Error(`Unknown selection reference: ${key}`);return ref;});
  }
  // 某类型的字段使用点也可通过声明了该类型的维度找到；不推断字段的物理类型。
  for(const d of Object.values(graph.datasets))for(const dim of Object.values(d.dimensions as Record<string,Record<string,unknown>>)) {
    if(typeof dim.type!=='string')continue;
    const ty=Object.hasOwn(graph.types,dim.type)?graph.types[dim.type]:undefined;if(!ty)throw new Error(`Unknown dimension value type: ${dim.type}`);
    for(const fieldRef of Array.isArray(dim.fields)?dim.fields:[])if(typeof fieldRef==='string'){add(ty,'fields',fieldRef);add(resolveFact(graph,fieldRef),'types',`types/${encodePart(dim.type)}`);}
  }
  // 集合引用稳定排序；事实数组的顺序（例如 canonical_order）保持模型原意。
  for(const fact of facts.values())for(const [key,value]of Object.entries(fact)) {
    if(Object.values(kindRoles).includes(key)&&Array.isArray(value)) value.sort();
    if(['related','traversable','referenced_by'].includes(key)&&isRecord(value))for(const refs of Object.values(value))if(Array.isArray(refs))refs.sort();
  }
  graph.items.sort((a,b)=>a.key.localeCompare(b.key,'en'));
  return {graph,addresses};
}
