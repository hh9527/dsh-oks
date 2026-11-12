import {isDeepStrictEqual} from 'node:util';
import type {RenderBlock} from './host.ts';
import type {readPoints} from './point-knowledge.ts';

/** Preserve exact definitions, presenting only nonredundant public metadata. */
export function renderInfo(_args:unknown,value:{data:ReturnType<typeof readPoints>}):RenderBlock[]{
  const sections:string[]=[];
  const literal=(v:unknown)=>JSON.stringify(v);
  for(const item of value.data.items){
    const lines=[`## ${item.id}`,'',`- kind: ${item.kind}`];
    const query=['dataset','entity','relation','field','dimension','measure','role'].filter(k=>Object.hasOwn(item,k));
    if(query.length)lines.push('- query: '+query.map(k=>`${k}=${literal(item[k])}`).join(', '));
    if(item.names?.length)lines.push('- names: '+literal(item.names));
    if(item.doc?.trim())lines.push('',item.doc);
    const facts={...item.facts};
    // Suppress aliases only when the complete values agree; conflicts remain visible.
    for(const [alias,primary] of [['filters','ops'],['order','canonical_order']])
      if(Object.hasOwn(facts,alias)&&Object.hasOwn(facts,primary)&&isDeepStrictEqual(facts[alias],facts[primary]))delete facts[alias];
    for(const [key,v] of Object.entries(facts)){
      if(v===null||v===undefined||((key==='doc'||key==='description')&&v===''))continue;
      // Nested nulls, empty containers and literal values may affect expressions.
      if(typeof v==='object'&&!Array.isArray(v)||Array.isArray(v)&&v.some(x=>x!==null&&typeof x==='object')){
        const json=JSON.stringify(v),fence='`'.repeat(Math.max(3,...[...json.matchAll(/`+/g)].map(m=>m[0].length+1)));
        lines.push('',`### ${key}`,'',fence+'json',json,fence);
      }else lines.push(`- ${key}: ${literal(v)}`);
    }
    if(item.dari){
      lines.push('', '### .dari', '');
      const c=item.dari;
      if(c.available===false)lines.push('此知识点没有公开的 .dari 源码契约');
      else {
        if(c.dataset)lines.push('- dataset: `'+c.dataset+'`');
        if(c.symbol)lines.push('- symbol: `'+c.symbol+'`');
        if(c.type)lines.push('- type: `'+c.type+'`');
        if(c.variants?.length)lines.push('- variants: '+c.variants.map((v:string)=>'`'+v+'`').join(', '));
        for(const d of c.datasets??[])lines.push('- dataset: `'+d.symbol+'`');
        for(const m of c.members??[]){lines.push('- '+m.kind+' `'+m.symbol+'`: `'+m.type+'`');if(m.variants?.length)lines.push('  - variants: '+m.variants.map((v:string)=>'`'+v+'`').join(', '));}
        for(const r of c.relations??(c.kind==='relation'?[c]:[]))lines.push('- relation `'+r.symbol+'`: '+r.from+' ('+r.fromCardinality+') → '+r.to+' ('+r.toCardinality+')');
      }
    }
    sections.push(lines.join('\n'));
  }
  for(const error of value.data.errors??[])sections.push(`## ${error.id}\n\n读取失败：${error.error}`);
  return [{type:'text',text:sections.join('\n\n')}];
}
