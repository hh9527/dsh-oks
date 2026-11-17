import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync,mkdirSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {resolveSettings} from '@hh9527/dari-model';
import {createTools} from '../src/tools.ts';
const root=mkdtempSync(join(process.env.TMPDIR||join(homedir(),'.cache/tmp'),'oks-optional-config-'));
try {
 const profile={domain:'fixture',model:join(root,'default.wasm'),dataFile:join(root,'default.sqlite')};
 assert.equal(resolveSettings(root,profile).model,profile.model);
 assert.throws(()=>resolveSettings(root,undefined),/未配置必要声明: domain, model/);
 writeFileSync(join(root,'dari.json'),'{bad');
 assert.throws(()=>resolveSettings(root,profile),/无法读取工作区配置/);
 writeFileSync(join(root,'dari.json'),JSON.stringify({model:'local.wasm',dataFile:'local.sqlite'}));
 const overridden=resolveSettings(root,profile);
 assert.equal(overridden.domain,'fixture');assert.equal(overridden.model,join(root,'local.wasm'));assert.equal(overridden.dataFile,join(root,'local.sqlite'));
 rmSync(join(root,'dari.json'));
 const other=join(root,'other');mkdirSync(other);
 writeFileSync(join(other,'dari.json'),JSON.stringify({model:'other.wasm'}));
 const service=join(root,'service.mjs');
 writeFileSync(service,`import {createInterface} from 'node:readline';
 const args=process.argv; const model=JSON.parse(args[args.indexOf('--options')+1]).model;
 for await(const line of createInterface({input:process.stdin})) {const q=JSON.parse(line);console.log(JSON.stringify({id:q.id,result:{model,types:[],input:q.input}}));}`);
 let asked=0, failIndex=false;
 const knowledge={ensureWorkspace(exec:any){const cwd=exec.agent.session.header.cwd;return{root:cwd,settings:resolveSettings(cwd,profile)}},async ensureIndex(){if(failIndex)throw Error('model initialization failed');return{};}} as any;
 const tools=createTools({knowledge,va:{async ask(){asked++;return{helper:'va',messageId:'1',answer:'alarm'}}},timeContext:{zones:new WeakMap()} as any,log(){},config:{...profile,dari:{service}}});
 const exec=(cwd:string)=>({agent:{session:{id:'test',header:{cwd}}}} as any);
 try{
  const va:any=tools.find(t=>t.name==='dari_vocab')!;
  assert.equal((await va.execute({query:'alarm'},exec(root)) as any).answer,'alarm');assert.equal(asked,1);
  failIndex=true;await assert.rejects(async()=>va.execute({query:'alarm'},exec(root)),/model initialization failed/);assert.equal(asked,1);failIndex=false;
  assert.equal((await tools.infoContracts!([],exec(root)) as any).model,profile.model);
  assert.equal((await tools.infoContracts!([],exec(other)) as any).model,join(other,'other.wasm'));
  writeFileSync(join(root,'dari.json'),JSON.stringify({model:'updated.wasm'}));
  assert.equal((await tools.infoContracts!([],exec(root)) as any).model,join(root,'updated.wasm'));
  writeFileSync(join(root,'analysis.dari'),'answer tree! {Answer []};');
  assert.match((await (tools.find(t=>t.name==='dari_check')! as any).execute({src:'analysis.dari'},exec(root)) as any).text,/Succeed/);
 }finally{tools.dispose();}
 console.log('Optional workspace configuration: profile fallback, overrides, errors, VA preflight and shared DARI model passed');
}finally{rmSync(root,{recursive:true,force:true});}
