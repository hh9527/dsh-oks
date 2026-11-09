import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {createDraftBackend} from '../../packages/dsh-oks/src/draft/backend.ts';
import {checkDesign} from '../../packages/dsh-oks/src/draft/design.ts';
import {checkReceipt} from '../../packages/dsh-oks/src/draft/check-receipt.ts';
const [domain,artifact,runner,mode]=process.argv.slice(2);
assert(['ic','ns'].includes(domain)&&artifact&&runner&&(!mode||mode==='diagnostics'&&domain==='ic'),'Usage: check-model.ts ic|ns model.wasm telora-run [diagnostics]');
const example=domain==='ic'?'cpu':'ns';
{
 const child=spawn(runner,[artifact,'--serve','stdio+jsonl://','--request-fuel','10000','--with-memory-limit','256']);
 child.stdin.on('error',()=>{});
 let stderr='';child.stderr.on('data',d=>stderr+=d);const closed=new Promise(resolve=>child.once('close',resolve));
 const timer=setTimeout(()=>child.kill(),60000),lines=createInterface({input:child.stdout}),reader=lines[Symbol.asyncIterator]();let calls=0;
 const backend=createDraftBackend({entry:{modelHash:domain,settings:{domain,queryMaxRows:500},runner:{async send(method:string,input:unknown){calls++;child.stdin.write(JSON.stringify({method,input})+'\n');const next=await reader.next();if(next.done){const code=await closed;throw new Error(`Model runner exited (${code}): ${stderr.trim()||'no error output'}`);}return JSON.parse(next.value);}}} as any,file:example+'.dari',contextZone:()=>({kind:'resolved',timeZone:'Asia/Shanghai'}),contextNow:()=>{throw new Error('Analysis read runtime clock');},knowledge:{executorFor(){throw new Error('Analysis acquired business data');}}});
 let source=readFileSync(new URL(`../../packages/dsh-oks/examples/${example}-typed-pipeline.dari`,import.meta.url),'utf8');
 if(mode==='diagnostics')source=source.replace('name:r.r.left_ls_server_name,','name:r.r.missing_server_name,').replace('base:r.r.left_lk_server_cpu_usage,','base:r.r.missing_cpu_usage,');
 try{
  const started=performance.now();const checked=await checkDesign(source,example+'.dari',{...backend,async execute(){throw new Error('Analysis called execution');}});
  if(mode==='diagnostics'){
   assert(!checked.ok,JSON.stringify(checked));
   for(const name of ['missing_server_name','missing_cpu_usage'])assert(checked.diagnostics.some(d=>d.message.includes(name)),JSON.stringify(checked.diagnostics));
   for(const name of ['topSum','tableRows'])assert(checked.checkedBindings.some(b=>b.name===name&&!b.checked),name);
  }else assert(checked.ok,JSON.stringify(checked));
  console.log(JSON.stringify({domain,mode:mode??'success',ok:checked.ok,transformCalls:calls,semanticQueries:checked.queries.length,types:Object.keys(checked.types).length,diagnostics:checked.diagnostics.length,receiptBytes:Buffer.byteLength(checkReceipt(checked).text),ms:Math.round(performance.now()-started)}));
 }
 finally{backend.dispose?.();clearTimeout(timer);lines.close();child.stdin.end();await closed;}
}
