import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {testAttachments} from './test-attachments.ts';
import {createDraftTools} from './src/draft/tools.ts';
import type {ApprovalService,ToolExec} from './src/host.ts';
import type {Knowledge,WorkspaceEntry} from './src/knowledge.ts';
import type {TimeContext} from './src/time-context.ts';

const root=mkdtempSync('/opt/userhome/h00629578/.cache/tmp/oks-approval-');mkdirSync(join(root,'.work'));
const path=join(root,'.work/test.dari'),src='oks://work/test.dari';
const source='<Dari><Pipeline>facts <-query({limit:5});{facts}</Pipeline></Dari>';
let executions=0,requests=0;
const columns=[{name:'n',type:'Int',nullable:false}];
const entry={root,modelHash:'test',settings:{domain:'test',queryMaxRows:100,requireRunApproval:true,dataFile:'fixture.sqlite'},runner:{async send(){return {ok:{accepted:true,queries:[{sql:'select n limit ?1',bindings:[5],limit_slot:0,columns}]}};}}} as unknown as WorkspaceEntry;
const knowledge={ensureWorkspace:()=>entry,executorFor(){executions++;return {manifest:null,executor:{async send(){return {rows:[{n:7}],columns:['n'],truncated:false};},dispose(){}}};}} as unknown as Knowledge;
let decide:ApprovalService['request']=async()=> 'rejected';
let available=true;
const approval:ApprovalService={async request(req){requests++;assert.equal(req.toolName,'oks_resolve');assert.equal(req.callId,'call-1');assert.match(req.reason,/^(刷新并)?解析分析稿 test\.dari$/);assert(req.reason.length<60);return decide(req);}};
const drafts=createDraftTools({attachments:()=>testAttachments(root),knowledge,timeContext:{zones:new Map()} as TimeContext,approval:()=>available?approval:undefined});
const caller={callId:'call-1',agent:{session:{id:'test'}}} as ToolExec;
const call=(args:object={src,data:['facts']},exec=caller)=>drafts.tools.find(t=>t.name==='oks_resolve')!.execute(args as never,exec) as Promise<any>;
try{
 writeFileSync(path,source);
 const checked=await drafts.tools.find(t=>t.name==='oks_check')!.execute({src} as never,caller) as any;
 assert.equal(checked.ok,true);assert.deepEqual(JSON.parse(JSON.stringify(checked)),checked);assert.equal(requests,0);assert.equal(executions,0);
 for(const outcome of ['rejected','cancelled','unavailable','rogue'] as const){
  decide=async()=>outcome as any;
  const r=await call();assert.equal(r.ok,false);assert.equal(r.execution,'not performed');assert.equal(executions,0);
 }
 available=false;const before=requests;
 assert.equal((await call()).status,'approval-unavailable');assert.equal(requests,before);assert.equal(executions,0);available=true;
 decide=async()=>{writeFileSync(path,source+' ');return 'allowed-once';};
 assert.equal((await call()).status,'source-changed');assert.equal(executions,0);writeFileSync(path,source);
 decide=async()=>{entry.settings.dataFile='other.sqlite';return 'allowed-once';};
 assert.equal((await call()).status,'environment-changed');assert.equal(executions,0);entry.settings.dataFile='fixture.sqlite';
 decide=async()=> 'allowed-once';
 let r=await call();assert.equal(r.ok,true,JSON.stringify(r));assert.equal(r.approval,'allowed-once');assert.equal(executions,1);
 assert.deepEqual(r.data,{facts:{rows:[{n:7}],columns,truncated:false}});
 const beforeCached=requests;r=await call();assert.equal(r.ok,true);assert.equal(requests,beforeCached+1);assert.equal(executions,1);
 await call({src,data:['facts'],refresh:true});assert.equal(executions,2);
 decide=async()=> 'rejected';r=await call();assert.equal(r.execution,'not performed');assert.equal(executions,2,'Prior approval cannot authorize a cached result read');
 const invalid=source.replace('limit:5','limit:0');writeFileSync(path,invalid);const beforeInvalid=requests;
 r=await call();assert.equal(r.status,'invalid');assert.equal(requests,beforeInvalid);assert.equal(executions,2);writeFileSync(path,source);
 writeFileSync(path,'<Dari><Pipeline>facts <-query({limit:5});</Pipeline><Report name="r"><article><p data-oks-lit>Total 42</p></article></Report></Dari>');
 const beforeProvenance=requests;r=await call();assert.equal(r.ok,false);assert(r.diagnostics.some((d:any)=>d.stage==='provenance'));assert.equal(requests,beforeProvenance);assert.equal(executions,2);writeFileSync(path,source);
 const controller=new AbortController();
 decide=async()=>{controller.abort();return 'allowed-once';};
 await assert.rejects(call({src,data:['facts']},{...caller,signal:controller.signal}));assert.equal(executions,2);
 let release!:(value:'allowed-once')=>void;
 let entered!:()=>void;const waiting=new Promise<void>(resolve=>{entered=resolve;});
 decide=async()=>{entered();return new Promise(resolve=>{release=resolve;});};
 const pending=call();await waiting;
 await assert.rejects(call(),/already awaiting approval/);
 release('allowed-once');assert.equal((await pending).ok,true);assert.equal(executions,2);
 await assert.rejects(call({src,data:['facts'],approved:true}),/Expected only/);
 decide=async()=> 'allowed-once';
 const reportSource='<Dari><Pipeline>facts <-query({limit:5});one <-select_one({from:{f:facts},fields:(r)=>({n:r.f.n}),order_by:(o)=>[asc(o.n)],limit:1});{facts}</Pipeline><Report name="answer"><article><p>Value: <Value data={one?.n} /></p></article></Report></Dari>';
 writeFileSync(path,reportSource);
 r=await call({src,reports:['reports.answer']});assert.equal(r.ok,true,JSON.stringify(r));assert.match(r.reports['reports.answer'].embedded,/^\[/);
 const beforeSelector=requests;
 r=await call({src,reports:['missing']});assert.equal(r.ok,false);assert.equal(requests,beforeSelector);
 r=await call({src,reports:['facts']});assert.equal(r.ok,false);assert.equal(requests,beforeSelector);
 writeFileSync(path,reportSource.replace('</Dari>','<Report name="other"><article><p>Other</p></article></Report></Dari>'));
 r=await call({src,reports:['reports.answer','reports.other']});assert.equal(r.ok,true,JSON.stringify(r));assert.deepEqual(Object.keys(r.reports),['reports.answer','reports.other']);

 // Default execution does not inspect or request the approval service.
 const beforeDefaultRequests=requests,beforeDefaultExecutions=executions;
 delete (entry.settings as any).requireRunApproval;
 writeFileSync(path,source);
 const direct=createDraftTools({knowledge,timeContext:{zones:new Map()} as TimeContext,approval:()=>{throw new Error('Approval service must not be consulted by default');}});
 try{
  const execute=direct.tools.find(t=>t.name==='oks_resolve')!;
  let value=await execute.execute({src,data:['facts']} as never,caller) as any;
  assert.equal(value.ok,true,JSON.stringify(value));assert.equal(value.approval,'not-required');assert.equal(requests,beforeDefaultRequests);assert.equal(executions,beforeDefaultExecutions+1);
  value=await execute.execute({src,data:['facts']} as never,caller) as any;assert.equal(value.ok,true);assert.equal(executions,beforeDefaultExecutions+1);
  writeFileSync(path,source.replace('limit:5','limit:0'));
  value=await execute.execute({src,data:['facts']} as never,caller) as any;assert.equal(value.ok,false);assert.equal(executions,beforeDefaultExecutions+1);
 }finally{direct.dispose();}
 const withoutService=createDraftTools({knowledge,timeContext:{zones:new Map()} as TimeContext});
 try{
  writeFileSync(path,source);
  const value=await withoutService.tools.find(t=>t.name==='oks_resolve')!.execute({src,data:['facts']} as never,caller) as any;
  assert.equal(value.ok,true,JSON.stringify(value));assert.equal(value.approval,'not-required');
 }finally{withoutService.dispose();entry.settings.requireRunApproval=true;}
 console.log('Native approval: no SQL before grant, reject/cancel/unavailable, source/model changes, one-shot cached reruns, refresh, concurrency and cancellation passed');
}finally{drafts.dispose();rmSync(root,{recursive:true,force:true});}
