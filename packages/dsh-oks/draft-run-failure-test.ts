import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {testAttachments} from './test-attachments.ts';
import {createDraftTools} from './src/draft/tools.ts';
import type {Knowledge,WorkspaceEntry} from './src/knowledge.ts';
import type {ToolExec} from './src/host.ts';
import type {TimeContext} from './src/time-context.ts';

async function scenario(source:string,rows:{n:number}[],truncated:boolean,verify:(result:any,read:(name:string)=>Promise<any>)=>Promise<void>|void){
 const root=mkdtempSync(join(process.env.TMPDIR||join(homedir(),'.cache','tmp'),'dari-run-failure-'));
 mkdirSync(join(root,'.work'));writeFileSync(join(root,'.work/test.dari'),source);
 let executions=0;
 const entry={root,modelHash:'test',settings:{workspaceRoot:root,domain:'test',queryMaxRows:200},runner:{
  async send(){return{ok:{accepted:true,queries:[{sql:'select 1',bindings:[3],limit_slot:0,columns:[{name:'n',type:'Int',nullable:false}]}]}}}
 }} as unknown as WorkspaceEntry;
 const knowledge={ensureWorkspace:()=>entry,executorFor:()=>({manifest:null,executor:{async send(){executions++;return{rows,columns:['n'],truncated}},dispose(){}}})} as unknown as Knowledge;
 const drafts=createDraftTools({knowledge,attachments:()=>testAttachments(root),timeContext:{zones:new Map(),install(){}} as TimeContext});
 const exec={agent:{session:{id:'test'}}} as unknown as ToolExec;
 const call=async(name:string,args:unknown)=>await drafts.tools.find(t=>t.name===name)!.execute(args as never,exec) as any;
 try{
  const checked=await call('oks_check',{src:'oks://work/test.dari'});assert.equal(checked.ok,true,JSON.stringify(checked.diagnostics));
  assert.equal(executions,0,'checking does not execute business queries');
  const result=await call('oks_resolve',{src:'oks://work/test.dari',reports:['answer']});
  assert.equal(executions,1);assert.deepEqual(result,JSON.parse(JSON.stringify(result)));
  await verify(result,async(name)=>call('oks_project',{input:'oks://work/test.dari#'+name}));
 }finally{drafts.dispose();rmSync(root,{recursive:true,force:true})}
}

test('truncated query preserves root failure through multi-hop blocked report',async()=>{
 await scenario(`data facts := query({limit:3});
data devMap := select({from:{f:facts},fields:r=>({n:r.f.n})});
data mapped := select({from:{d:devMap},fields:r=>({n:r.d.n})});
data top1 := select_one({from:{m:mapped},fields:r=>({n:r.m.n}),order_by:o=>[asc(o.n)],limit:1});
report answer := Report [p [Value(data=top1?.n)]];`,[{n:1}],true,async(result,read)=>{
  assert.equal(result.ok,false);assert.equal(result.computation,'partial');assert.equal(result.status,'complete');
  assert.equal(result.approval,'not-required');
  assert.equal(result.reports,undefined);assert.equal(result.counts.failed,1);assert(result.counts.blocked>=3);
  const root=result.failures[0];assert.equal(root.name,'devMap');assert.equal(root.status,'failed');
  assert.equal(root.at.line,2);assert.match(root.error,/SQL input source0 is truncated/);
  assert(result.failures.some((f:any)=>f.name==='top1'&&f.status==='blocked'));
  assert.match((await read('failures')).data.find((f:any)=>f.name==='devMap').error,/truncated/);
 });
});

test('select_one cardinality failure returns a receipt instead of a report-read exception',async()=>{
 await scenario(`data facts := query({limit:3});
data top1 := select_one({from:{f:facts},fields:r=>({n:r.f.n})});
report answer := Report [p [Value(data=top1?.n)]];`,[{n:1},{n:2}],false,result=>{
  assert.equal(result.ok,false);
  assert.equal(result.failures[0].name,'top1');assert.equal(result.failures[0].at.line,2);
  assert.match(result.failures[0].error,/CardinalityViolation/);assert.equal(result.reports,undefined);
 });
});

test('empty select_one remains a successful optional result',async()=>{
 await scenario(`data facts := query({limit:3});
data top1 := select_one({from:{f:facts},fields:r=>({n:r.f.n}),order_by:o=>[asc(o.n)],limit:1});
report answer := Report [p [Value(data=top1?.n)]];`,[],false,result=>{
  assert.equal(result.ok,true);assert.equal(result.counts.failed,0);assert.equal(result.counts.blocked,0);
  assert.match(result.reports.answer.embedded,/^\[/);
 });
});

test('unrequested failing binding is not executed',async()=>{
 await scenario(`data facts := query({limit:3});
data bad := select_one({from:{f:facts},fields:r=>({n:r.f.n})});
data summary := select_one({from:{f:facts},group_by:r=>({}),fields:(g,rows)=>({n:count(rows)})});
report answer := Report [p [Value(data=summary?.n)]];`,[{n:1},{n:2}],false,result=>{
  assert.equal(result.ok,true);assert.equal(result.counts.failed,0);assert.equal(result.counts.blocked,0);
  assert.match(result.reports.answer.embedded,/^\[/);
 });
});
