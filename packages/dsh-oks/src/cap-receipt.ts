import type {RenderBlock} from './host.ts';
import type {discoverPoints} from './point-knowledge.ts';

type Discovery=ReturnType<typeof discoverPoints>;
/** Public navigation text; discovery retains its structured internal representation. */
export function renderCap(_args:unknown,value:{data:Discovery}):RenderBlock[]{
  const d=value.data,sections:string[]=[],shown=new Set<string>();
  const section=(title:string,lines:string[])=>{if(lines.length)sections.push(`## ${title}\n\n${lines.join('\n')}`);};
  section('锚点',d.anchors.map((a:any)=>{shown.add(a.id);return `- ${a.id}`;}));
  const paths:string[]=[];
  for(const c of d.connections){
    if(!c.paths.length)paths.push(`- ${c.from} — ${c.to}：${c.status==='incomplete'?'搜索已截断':'深度范围内未找到路径'}`);
    for(const p of c.paths){
      p.nodes.forEach((id:string)=>shown.add(id));p.relations.forEach((id:string)=>shown.add(id));
      paths.push('- '+p.nodes.map((id:string,i:number)=>i?` --(${p.relations[i-1]})-- ${id}`:id).join(''));
    }
    if(c.truncated&&c.paths.length)paths.push(`- ${c.from} — ${c.to}：候选路径已截断`);
  }
  section(`关系路径（最大深度 ${d.max_depth}）`,paths);
  section('承载数据集',d.carriers.map((c:any)=>`- ${c.entity}：${c.datasets.join(', ')||'无'}`));
  const matches:string[]=[],unresolved:string[]=[];
  for(const a of d.anchors){
    const hits=a.matches.filter((m:any)=>m.ids.length);
    if(hits.length){matches.push(`### ${a.id}\n`);for(const m of hits){m.ids.forEach((id:string)=>shown.add(id));matches.push(`- ${m.term} → ${m.ids.join(', ')}`);}matches.push('');}
    if(a.unresolved_terms.length)unresolved.push(`### ${a.id}\n`,...a.unresolved_terms.map((term:string)=>`- ${term}`),'');
  }
  section('词汇命中',matches);section('未命中',unresolved);
  for(const [kind,ids] of Object.entries(d.index))section(kind==='Type'?'类型依赖':`其他精确节点（${kind}）`,ids.filter(id=>!shown.has(id)).map(id=>`- ${id}`));
  return [{type:'text',text:sections.join('\n\n').trim()}];
}
