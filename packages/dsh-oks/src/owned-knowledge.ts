import {isRecord} from './host.ts';
import {encodePart,refPath,resolveFact,type SemanticGraph} from './knowledge-graph.ts';
import {assignTypeIds} from './knowledge-type-ids.ts';
import type {RetrievalIndex} from './retrieval.ts';
const roots=['datasets','entities','types'];
const transportRoots=[...roots,'relations'];
const discoveryRoots=['entities','datasets','relations'];
const categories=['fields','roles','dimensions','measures','values','time_roles','business_links','relations'];
const ownedGraphs=new WeakSet<object>();
export const hasOwnedNodes=(graph:object)=>ownedGraphs.has(graph);
/** Expand content locations only for the private retrieval index, never as public graph nodes. */
export function expandOwnedKnowledge(input:Record<string,any>):Record<string,any>{
 if(!Array.isArray(input.facts))throw new Error('Owned knowledge requires facts');
 if(input.relations!==undefined&&!Array.isArray(input.relations))throw new Error('Relation descriptors must be an array');
 for(const f of input.facts)if(typeof f?.key!=='string'||!roots.includes(refPath(f.key)[0]))throw new Error('Only Entity, Dataset and Type own knowledge identity');
 for(const f of input.relations??[])if(typeof f?.key!=='string'||refPath(f.key)[0]!=='relations')throw new Error('Invalid relation descriptor');
 const facts:any[]=[],known=new Set<string>();
 const transported=[...input.facts,...(Array.isArray(input.relations)?input.relations:[])];
 for(const node of transported){
  if(!isRecord(node)||typeof node.key!=='string'||!isRecord(node.value)||!Array.isArray(node.references)||!Array.isArray(node.reference_sites))throw new Error('Invalid owned knowledge node');
  const path=refPath(node.key);if(path.length!==2||!transportRoots.includes(path[0])||known.has(node.key))throw new Error('Invalid knowledge node or relation descriptor');
  known.add(node.key);const content={...node.value};
  for(const category of categories){
   if(!Object.hasOwn(content,category)||!isRecord(content[category]))continue;
   for(const [name,value] of Object.entries(content[category])){
    if(!isRecord(value))throw new Error('Invalid owned knowledge content');
    facts.push({key:node.key+'#'+category+'/'+encodePart(name),value,references:[]});
   }
   delete content[category];
  }
  if(['bindings','binding','group','dimension_groups','measure_groups'].some(k=>Object.hasOwn(content,k)))throw new Error('Implementation groups are not public knowledge');
  facts.push({key:node.key,value:content,references:[]});
 }
 const locations=new Map(facts.map(f=>[f.key,f]));
 for(const node of transported){
  const actual=new Set<string>();
  for(const site of node.reference_sites){
   if(!isRecord(site)||!Array.isArray(site.path)||![0,2].includes(site.path.length)||site.path.some(p=>typeof p!=='string')||typeof site.target!=='string'||!known.has(site.target)||
    (site.target_path!==undefined&&(!Array.isArray(site.target_path)||site.target_path.length!==2||site.target_path.some(p=>typeof p!=='string'))))throw new Error('Invalid owned reference location');
   const at=(root:string,path:string[])=>root+(path.length?'#'+path[0]+'/'+encodePart(path[1]):'');
   const source=locations.get(at(node.key,site.path)),target=at(site.target,site.target_path??[]);
   if(!source||!locations.has(target))throw new Error('Unresolved owned reference location');
   source.references.push(target);if(site.target!==node.key)actual.add(site.target);
  }
  if(node.references.some((ref:unknown)=>typeof ref!=='string'||!known.has(ref))||JSON.stringify([...new Set(node.references)].sort())!==JSON.stringify([...actual].sort()))throw new Error('Owned node references do not match their locations');
 }
 return {...input,knowledge_contract:'ontology-knowledge-v4',facts};
}
/** Graph edges connect independent nodes; retrieval locations retain exact member addresses. */
export function finishOwnedKnowledge(index:RetrievalIndex,expanded:Record<string,any>):RetrievalIndex{
 const graph=index.knowledge,ids=assignTypeIds(expanded.facts.map((f:any)=>f.key));
 const add=(value:Record<string,any>,branch:string,category:string,ref:string)=>{
  const into=value[branch]??=Object.create(null);const list=into[category]??=[];if(!list.includes(ref))list.push(ref);
 };
 for(const f of expanded.facts){
  const value=resolveFact(graph,ids.address(f.key));
  for(const key of ['related','referenced_by','traversable',...roots,'dimension_groups','measure_groups','bindings','fields','roles','dimensions','measures','values','relations','time_roles','business_links']){
   if(!Object.hasOwn(f.value,key)&&!isRecord(value[key]))delete value[key];
  }
  delete value.related;delete value.referenced_by;delete value.traversable;delete value.bindings;
 }
 const edges=new Map<string,any>(),seenSites=new Map<string,Set<string>>();
 for(const f of expanded.facts)for(const ref of f.references){
  const source=ids.address(f.key),target=ids.address(ref),from=source.split('#')[0],to=target.split('#')[0];
  if(from.startsWith('relations/')||to.startsWith('relations/'))continue;
  if(from===to)continue;
  const owner=resolveFact(graph,from),destination=resolveFact(graph,to),sourcePath=refPath(source).slice(2),targetPath=refPath(target).slice(2);
  add(owner,'related',refPath(to)[0],to);
  if(refPath(to)[0]==='types'&&destination.reverse_references!==true)continue;
  add(destination,'referenced_by',refPath(from)[0],from);
  const site={node:from,path:sourcePath,...(targetPath.length?{target_path:targetPath}:{})};
  const sites=(destination.reference_locations??=[]) as any[],seen=seenSites.get(to)??new Set<string>(),key=JSON.stringify(site);
  if(!seen.has(key)){seen.add(key);seenSites.set(to,seen);sites.push(site);}
  edges.set(from+' → '+to,{source:from,target:to,link:'Related'});
 }
 // Relationship descriptors form a private discovery table, not knowledge nodes.
 const descriptors=graph.relations;
 for(const [name,value] of Object.entries(descriptors)){
  const v=value as any;if(typeof v.from_dataset!=='string'||typeof v.to_dataset!=='string')continue;
  const by='relations/'+encodePart(name);
  for(const [source,target,direction] of [[v.from_dataset,v.to_dataset,'forward'],[v.to_dataset,v.from_dataset,'reverse']]){
   const owner=resolveFact(graph,source),peers=owner.peers??=Object.create(null),peer=peers[target]??={by:[]};
   peer.by.push({id:by,direction});
  }
 }
 Object.defineProperty(graph,'relations',{value:descriptors,writable:true,configurable:true,enumerable:false});
 // Non-domain directories remain private compatibility slots for internal algorithms.
 for(const root of ['dimension_groups','measure_groups'])Object.defineProperty(graph,root,{value:{},writable:true,configurable:true,enumerable:false});
 ownedGraphs.add(graph);
 return {...index,links:[...edges.values()],contract:{knowledge_contract:'ontology-knowledge-v5',intent_contract:'ontology-intent-v1',addressing:'node-member-uri-v1'},meta:{...index.meta,roots,discovery_roots:discoveryRoots,counts:Object.fromEntries(roots.map(root=>[root,Object.keys((graph as any)[root]??{}).length]))}};
}
