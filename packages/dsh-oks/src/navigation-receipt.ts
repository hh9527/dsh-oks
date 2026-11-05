import type {RenderBlock} from './host.ts';
import type {searchPoints,routePoints} from './point-navigation.ts';
import {semanticId} from './semantic-id.ts';
const line=(s:string)=>s.replace(/[\r\n]+/g,' ');
export function renderSearch(_args:unknown,value:{data:ReturnType<typeof searchPoints>}):RenderBlock[]{
  const sections=value.data.results.map(result=>{
    const lines=[`# ${line(result.q)}`,''];
    const groups=new Map<string,typeof result.items>();
    for(const item of result.items){const parent=item.id.slice(0,item.id.lastIndexOf('/'));const group=groups.get(parent)??[];group.push(item);groups.set(parent,group);}
    for(const [parent,items] of groups){
      lines.push(`## ${parent}`,'');
      for(const item of items){const name=item.id.slice(item.id.lastIndexOf('/')+1),root=['datasets','entities','types'].includes(parent);
        lines.push(`- ${name}${root?(item.doc?': '+item.doc:''):': '+(item.type??'未声明类型')+(item.doc?' — '+item.doc:'')}`);
      }
      lines.push('');
    }
    if(!result.items.length)lines.push('✗ 无命中');
    if(result.truncated)lines.push('结果已截断；请缩小范围或细化 q');
    return lines.join('\n').trim();
  });
  return [{type:'text',text:sections.join('\n\n')}];
}
const ref=(v:unknown):string=>{
  if(typeof v==='string'){try{return semanticId(v);}catch{return JSON.stringify(v);}}
  return JSON.stringify(v);
};
function keyText(value:any):string{
  if(value?.op==='eq'&&Object.hasOwn(value,'from')&&Object.hasOwn(value,'to'))return `${ref(value.from)} = ${ref(value.to)}`;
  return JSON.stringify(value);
}
export function renderRoutes(_args:unknown,value:{data:ReturnType<typeof routePoints>}):RenderBlock[]{
  const r=value.data,lines=[`## ${r.from} → ${r.to}`,''];
  for(let i=0;i<r.paths.length;i++){
    const p=r.paths[i];if(r.paths.length>1)lines.push(`### 路径 ${i+1}`,'');
    if(r.from!==p.nodes[0])lines.push(`起点承载：${r.from} in ${p.nodes[0]}`,'');
    if(!p.edges.length)lines.push(`- 同一数据集：${p.nodes[0]}（无需跨表连接）`);
    p.edges.forEach((edge,j)=>{
      const forward=edge.from===p.nodes[j],card=edge.cardinality;
      const cardinality=card?`${card[forward?'from':'to']}→${card[forward?'to':'from']}`:'未声明';
      lines.push(`- ${p.nodes[j]} ${forward?'--[':'<--['}${edge.relation}${forward?']-->':']--'} ${p.nodes[j+1]} · ${cardinality} · key: ${keyText(edge.key)}`);
      if(edge.guard!==null)lines.push(`  guard: ${JSON.stringify(edge.guard)}`);
      if(edge.from_role||edge.to_role)lines.push(`  roles: ${edge.from_role??'未声明'} → ${edge.to_role??'未声明'}`);
    });
    if(r.to!==p.nodes.at(-1))lines.push('',`终点承载：${r.to} in ${p.nodes.at(-1)}`);
    lines.push('');
  }
  if(!r.paths.length)lines.push(r.truncated?'搜索已截断，尚未找到路径':`✗ 最大深度 ${r.max_depth} 内未找到路径`);
  else if(r.truncated)lines.push('候选路径已截断');
  return [{type:'text',text:lines.join('\n').trim()}];
}
