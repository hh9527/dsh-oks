import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {createDraftBackend} from '../../packages/dsh-oks/src/draft/backend.ts';
import {checkDesign} from '../../packages/dsh-oks/src/draft/design.ts';
const [domain,artifact,runner]=process.argv.slice(2);
assert(['ic','ns'].includes(domain)&&artifact&&runner,'Usage: check-model.ts ic|ns model.wasm telora-run');
const example=domain==='ic'?'cpu':'ns';
{
 const child=spawn(runner,[artifact,'--serve','stdio+jsonl://','--request-fuel','10000','--with-memory-limit','256']);
 let stderr='';child.stderr.on('data',d=>stderr+=d);const closed=new Promise(resolve=>child.once('close',resolve));
 const timer=setTimeout(()=>child.kill(),60000),lines=createInterface({input:child.stdout}),reader=lines[Symbol.asyncIterator]();let calls=0;
 const backend=createDraftBackend({entry:{modelHash:domain,settings:{domain,queryMaxRows:500},runner:{async send(method:string,input:unknown){calls++;child.stdin.write(JSON.stringify({method,input})+'\n');const next=await reader.next();assert(!next.done,stderr);return JSON.parse(next.value);}}} as any,file:example+'.dari',contextZone:()=>({kind:'resolved',timeZone:'Asia/Shanghai'}),contextNow:()=>{throw new Error('Analysis read runtime clock');},knowledge:{executorFor(){throw new Error('Analysis acquired business data');}}});
 const source=readFileSync(new URL(`../../packages/dsh-oks/examples/${example}-typed-pipeline.dari`,import.meta.url),'utf8');
 try{const started=performance.now();const checked=await checkDesign(source,example+'.dari',{...backend,async execute(){throw new Error('Analysis called execution');}});assert(checked.ok,JSON.stringify(checked));console.log(JSON.stringify({domain,ok:checked.ok,transformCalls:calls,semanticQueries:checked.queries.length,types:Object.keys(checked.types).length,bytes:Buffer.byteLength(JSON.stringify(checked)),ms:Math.round(performance.now()-started)}));}
 finally{backend.dispose?.();clearTimeout(timer);lines.close();child.stdin.end();await closed;}
}
