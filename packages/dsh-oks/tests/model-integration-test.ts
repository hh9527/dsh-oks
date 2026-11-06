import assert from 'node:assert/strict';
import {parseDesign} from '../src/draft/design.ts';
import {testAttachments} from './test-attachments.ts';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,cpSync,readdirSync} from 'node:fs';
import {homedir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {readBuildInformation} from '../src/service-metadata.ts';
import {collectProgrammedKnowledge} from '../src/programmed-knowledge.ts';
import {derivePublishedKnowledge} from '../src/published-knowledge.ts';
const [domain,model,database,example]=process.argv.slice(2);
assert(domain&&model&&database&&example,'Usage: model-integration-test.ts <domain> <model.wasm> <data.sqlite> <source.dari>');
const root=mkdtempSync(join(process.env.TMPDIR||join(homedir(),'.cache','tmp'),'oks-js-model-'));
const bundle=join(root,'plugin.mjs');cpSync(new URL('../../dist/dsh-oks/lib/index.mjs',import.meta.url),bundle);
assert.deepEqual(readdirSync(root),['plugin.mjs'],'single-file plugin has no evaluator sidecar');
const {apply}=await import(pathToFileURL(bundle).href);
const metadata=readBuildInformation(readFileSync(model))!;
const collected=await collectProgrammedKnowledge(metadata['ontology.knowledge']);
const graph=derivePublishedKnowledge((collected as any).graph,undefined,(collected as any).vocabulary).knowledge;
const dataset=Object.keys(graph.datasets).find(k=>!k.startsWith('source_'))!;
const source=readFileSync(example,'utf8');
const doc=parseDesign(source,example);
assert(doc.assets.get('@report/answer')?.format==='markdown','Integration source must define Answer');
async function scenario(run:boolean){
 const cwd=join(root,run?'run':'check');
 const {mkdirSync}=await import('node:fs');mkdirSync(cwd);writeFileSync(join(cwd,'oks.json'),'{}');
 let approvalRequests=0;
 const tools=new Map<string,any>(),hooks=new Map<string,any>(),disposers:(()=>void)[]=[];
 apply({logger:{info(){}},get(name:string){return name==='attachments'?testAttachments(cwd):name==='approval'?{async request(){approvalRequests++;return 'allowed-once';}}:undefined;},tools:{register(t:any){tools.set(t.name,t);return()=>{};}},effect(fn:()=>any){const dispose=fn();if(dispose)disposers.push(dispose);},on(name:string,fn:any){hooks.set(name,fn);return()=>{};}},{domain,model:resolve(model),dataFile:run?resolve(database):join(cwd,'missing.sqlite')});
 const exec={agent:{session:{id:'model-integration',header:{cwd}}}},src='.work/answer.dari';
 const call=(name:string,args:unknown)=>tools.get(name).execute(args,exec);
 try{
  const messages=[{source:{kind:'user',rpcId:'model-integration',clientTimeZone:'Asia/Shanghai'},content:[]}];
  await hooks.get('agent/pre-step')({agent:exec.agent,messages},async()=>({kind:'continue',messages}));
  const id='datasets/'+encodeURIComponent(dataset);
  let started=performance.now();const routes=await call('oks_routes',{from:id,to:id});const routesMs=performance.now()-started;
  assert.equal(routes.data.paths[0].nodes[0],id);
  started=performance.now();const info=await call('oks_info',{ids:[id]});const infoMs=performance.now()-started;
  assert.equal(info.data.items[0].dataset,dataset);
  const found=await call('oks_search',{q:[dataset],scope:["datasets"]});
  for(const item of found.data.results[0].items) assert.equal((await call('oks_info',{ids:[item.id]})).data.items[0].id,item.id);
  mkdirSync(join(cwd,'.work'),{recursive:true});
  writeFileSync(join(cwd,src),source);
  started=performance.now();const checked=await call('dari_check',{src});const checkMs=performance.now()-started;assert.equal(checked.ok,true,JSON.stringify(checked));
  if(!run)return {domain,mode:'check without database',routesMs:Math.round(routesMs),infoMs:Math.round(infoMs),checkMs:Math.round(checkMs),bindings:checked.queries.length};
  started=performance.now();const result=await call('dari_resolve',{src});const runMs=performance.now()-started;assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.approval,'not-required');assert.equal(approvalRequests,0);
  assert.equal(typeof result.answer.embedded,'string');assert(!('data' in result));
  started=performance.now();const cached=await call('dari_resolve',{src});const cachedRunMs=performance.now()-started;assert.equal(cached.ok,true);assert.equal(cached.counts.executed,0);
  return {domain,mode:'run',checkMs:Math.round(checkMs),runMs:Math.round(runMs),cachedRunMs:Math.round(cachedRunMs),counts:result.counts};
 }finally{disposers.reverse().forEach(fn=>fn());}
}
try{console.log(JSON.stringify(await scenario(false)));console.log(JSON.stringify(await scenario(true)));}
finally{rmSync(root,{recursive:true,force:true});}
