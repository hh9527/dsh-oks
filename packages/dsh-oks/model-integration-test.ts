import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,cpSync,readdirSync} from 'node:fs';
import {homedir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {readBuildInformation} from './src/service-metadata.ts';
import {collectProgrammedKnowledge} from './src/programmed-knowledge.ts';
import {derivePublishedKnowledge} from './src/published-knowledge.ts';
const [domain,model,database,example]=process.argv.slice(2);
assert(domain&&model&&database&&example,'Usage: model-integration-test.ts <domain> <model.wasm> <data.sqlite> <source.dari>');
const root=mkdtempSync(join(process.env.TMPDIR||join(homedir(),'.cache','tmp'),'oks-js-model-'));
const bundle=join(root,'plugin.mjs');cpSync(new URL('./lib/index.mjs',import.meta.url),bundle);
assert.deepEqual(readdirSync(root),['plugin.mjs'],'single-file plugin has no evaluator sidecar');
const {apply}=await import(pathToFileURL(bundle).href);
const metadata=readBuildInformation(readFileSync(model))!;
const collected=await collectProgrammedKnowledge(metadata['ontology.knowledge']);
const graph=derivePublishedKnowledge((collected as any).graph,undefined,(collected as any).vocabulary).knowledge;
const dataset=Object.keys(graph.datasets).find(k=>!k.startsWith('source_'))!;
const source=readFileSync(example,'utf8');
async function scenario(run:boolean){
 const cwd=join(root,run?'run':'check');
 const {mkdirSync}=await import('node:fs');mkdirSync(cwd);writeFileSync(join(cwd,'oks.json'),'{}');
 let approvalRequests=0;
 const tools=new Map<string,any>(),hooks=new Map<string,any>(),disposers:(()=>void)[]=[];
 apply({logger:{info(){}},get(name:string){return name==='approval'?{async request(){approvalRequests++;return 'allowed-once';}}:undefined;},tools:{register(t:any){tools.set(t.name,t);return()=>{};}},effect(fn:()=>any){const dispose=fn();if(dispose)disposers.push(dispose);},on(name:string,fn:any){hooks.set(name,fn);return()=>{};}},{domain,model:resolve(model),dataFile:run?resolve(database):join(cwd,'missing.sqlite')});
 const exec={agent:{session:{id:'model-integration',header:{cwd}}}},src='oks://work/answer.dari';
 const call=(name:string,args:unknown)=>tools.get(name).execute(args,exec);
 try{
  const messages=[{source:{kind:'user',rpcId:'model-integration',clientTimeZone:'Asia/Shanghai'},content:[]}];
  await hooks.get('agent/pre-step')({agent:exec.agent,messages},async()=>({kind:'continue',messages}));
  let started=performance.now();const cap=await call('oks_cap',{cq:{target:{dataset}}});const capMs=performance.now()-started;
  assert.equal(cap.data.target.dataset,dataset);assert.equal(cap.data.discovery.requires_transform,true);
  started=performance.now();const card=await call('oks_card',{id:dataset});const cardMs=performance.now()-started;assert.equal(card.data.id,dataset);
  assert.equal((await call('oks_card',{key:'datasets/'+encodeURIComponent(dataset)})).data.key,'datasets/'+encodeURIComponent(dataset));
  await call('oks_write',{path:src,content:source});
  started=performance.now();const checked=await call('oks_check',{src});const checkMs=performance.now()-started;assert.equal(checked.ok,true,JSON.stringify(checked));
  if(!run)return {domain,mode:'check without database',capMs:Math.round(capMs),cardMs:Math.round(cardMs),checkMs:Math.round(checkMs),bindings:checked.queries.length};
  started=performance.now();const result=await call('oks_run',{src});const runMs=performance.now()-started;assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.approval,'not-required');assert.equal(approvalRequests,0);
  assert(Object.hasOwn(result.result,'values'));assert(Object.hasOwn(result.result,'figures'));
  started=performance.now();const cached=await call('oks_run',{src});const cachedRunMs=performance.now()-started;assert.equal(cached.ok,true);assert.equal(cached.counts.executed,0);
  return {domain,mode:'run',checkMs:Math.round(checkMs),runMs:Math.round(runMs),cachedRunMs:Math.round(cachedRunMs),figures:Object.keys(result.result.figures).length,counts:result.counts};
 }finally{disposers.reverse().forEach(fn=>fn());}
}
try{console.log(JSON.stringify(await scenario(false)));console.log(JSON.stringify(await scenario(true)));}
finally{rmSync(root,{recursive:true,force:true});}
