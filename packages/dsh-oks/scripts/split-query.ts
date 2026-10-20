/** Explicit migration for drafts whose query(intent) calls meant immediate execution. */
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseDraft } from '../src/draft/document.ts';
import type { Expr } from '../src/draft/pipeline.ts';
export function splitQueryCalls(source:string):string {
  const document=parseDraft(source);
  const edits:{offset:number;text:string}[]=[];
  const visit=(expr:Expr,inExecution=false):void=>{
    if(expr.kind==='call'){
      if(expr.operator==='query'&&!inExecution){
        edits.push({offset:expr.span.start.offset,text:'exec_query('},{offset:expr.span.end.offset,text:')'});
      }
      for(const arg of expr.args)visit(arg,expr.operator==='exec_query');
    }else if(expr.kind==='object')for(const entry of expr.entries)visit(entry.value);
    else if(expr.kind==='array')for(const value of expr.values)visit(value);
    else if(expr.kind==='project')visit(expr.input);
  };
  for(const node of document.nodes)visit(node.statement.value);
  for(const edit of edits.sort((a,b)=>b.offset-a.offset))source=source.slice(0,edit.offset)+edit.text+source.slice(edit.offset);
  parseDraft(source);
  return source;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const [src,dst]=process.argv.slice(2);
  if(!src?.endsWith('.dari')||!dst?.endsWith('.dari'))throw new Error('Usage: node scripts/split-query.ts old.dari new.dari (all old query calls become executions)');
  const migrated=splitQueryCalls(readFileSync(src,'utf8'));
  writeFileSync(dst,migrated,{flag:'wx'});
  console.log(`Created ${dst}; original preserved`);
}
