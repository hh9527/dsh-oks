import {encodePart,refPath} from './knowledge-graph.ts';
import {isRecord} from './host.ts';

/** One model publication owns one deterministic, collision-free type address space. */
export function assignTypeIds(keys:Iterable<string>){
 const roots=[...keys].filter(key=>{const p=refPath(key);return p[0]==='types'&&p.length===2;}).sort();
 const short=(canonical:string)=>{
  // Instantiated named types carry [canonical name, type arguments] as their source ID.
  let name=canonical;
  try{const parsed=JSON.parse(canonical);if(Array.isArray(parsed)&&typeof parsed[0]==='string')name=parsed[0];}catch{}
  return name.split('::').at(-1)!||name;
 };
 const bases=new Map(roots.map(key=>[key,short(refPath(key)[1])]));
 const reserved=new Set(bases.values()),used=new Set<string>(),ids=new Map<string,string>();
 const canonical=new Map<string,string>(),names=new Map<string,string>();
 for(const key of roots){
  const base=bases.get(key)!;let id=base,n=1;
  if(used.has(id))do{id=base+'-'+n++;}while(used.has(id)||reserved.has(id));
  used.add(id);const target='types/'+encodePart(id);ids.set(key,target);
  canonical.set(target,refPath(key)[1]);names.set(target,base);
 }
 const address=(ref:string)=>{const at=ref.indexOf('#'),root=at<0?ref:ref.slice(0,at);return (ids.get(root)??root)+(at<0?'':ref.slice(at));};
 const owner=(value:string)=>{const target=ids.get('types/'+encodePart(value));return target?refPath(target)[1]:value;};
 const expression=(text:string)=>text.replace(/types\/[A-Za-z0-9_.~%\-]+/g,address);
 const references=new Set(['type','ty','types','identity','logical_type','wire','representation','arguments','payload','raw','row','entity','field','fields','anchor_field','binding','group','from_dataset','to_dataset','from_role','to_role','relations','datasets','entities','dimensions','measures','roles','bindings','time_roles','business_links','dimension_groups','measure_groups','requires']);
 const literals=new Set(['value','values','wires','canonical_values','canonical_order','canonical_aliases','doc','summary','description','names','name','aliases','label','source']);
 const rewrite=(value:unknown,reference=false):unknown=>{
  if(typeof value==='string')return reference?expression(value):value;
  if(Array.isArray(value))return value.map(v=>rewrite(v,reference));
  if(!isRecord(value))return value;
  return Object.fromEntries(Object.entries(value).map(([key,v])=>[key,literals.has(key)?v:rewrite(v,references.has(key))]));
 };
 return {address,owner,rewrite,canonical,names};
}
