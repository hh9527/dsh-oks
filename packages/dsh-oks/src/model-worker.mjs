import {parentPort,workerData} from 'node:worker_threads';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
const state=new Int32Array(workerData.buffer,0,2);
const bytes=new Uint8Array(workerData.buffer,8);
let active=false,closing=false,stderr='',dead='';
function finish(response){
    let data=new TextEncoder().encode(JSON.stringify(response));
    if(data.length>bytes.length)data=new TextEncoder().encode(JSON.stringify({error:'Model ABI response exceeds shared buffer'}));
    bytes.set(data);Atomics.store(state,1,data.length);Atomics.store(state,0,1);Atomics.notify(state,0);active=false;
}
const child=spawn(workerData.runner,[workerData.artifact,'--serve','stdio+jsonl://','--request-fuel','100000','--with-memory-limit','2048'],{stdio:['pipe','pipe','pipe']});
child.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-12000);});
child.on('error',e=>{dead=e.message;finish({error:dead});});
child.on('close',code=>{dead='Model runner exited '+code+': '+stderr;if(active)finish({error:'Model runner exited '+code+': '+stderr});if(closing)parentPort.close();});
const lines=createInterface({input:child.stdout});
lines.on('line',line=>{
    if(!active)return;
    try{const response=JSON.parse(line);finish(response.error?{error:response.diagnostics??response}:{value:response.ok});}
    catch(e){finish({error:e.message});}
});
parentPort.on('message',message=>{
    if(message.close){closing=true;child.stdin.end();return;}
    if(dead){finish({error:dead});return;}
    active=true;child.stdin.write(JSON.stringify({method:message.method,input:message.input})+'\n');
});
