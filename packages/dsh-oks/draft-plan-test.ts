import assert from 'node:assert/strict';
import { createDraftBackend } from './src/draft/backend.ts';
import { DraftRuntime } from './src/draft/runtime.ts';
import type { WorkspaceEntry } from './src/knowledge.ts';
import type { ContextTimeZone } from './src/time.ts';

let compiles=0, executions=0;
let zone:ContextTimeZone={kind:'resolved',timeZone:'UTC'};
const columns=[{name:'n',type:'Int',nullable:false}];
const entry={modelHash:'model-1',settings:{domain:'test',queryMaxRows:100},runner:{async send(_method:string,{intents}:any){
  compiles++;return {ok:{accepted:true,queries:[{sql:'select n where n=?1 limit ?2',bindings:[intents[0].value??1,intents[0].limit],limit_slot:1,columns}]}};
}}} as unknown as WorkspaceEntry;
const backend=createDraftBackend({entry,file:'.work/plan.dari',contextZone:()=>zone,
  knowledge:{executorFor(){return {manifest:null,executor:{async send(_sql:string,bindings:unknown[]){executions++;return {rows:[{n:Number(bindings[0])}],columns:['n'],truncated:false};},dispose(){}}};}}});
const runtime=new DraftRuntime(backend);
const wrap=(code:string)=>`<Dari><Pipeline>${code}</Pipeline></Dari>`;
const planOnly=wrap('plan <-query({limit:5,value:1}); peek <- plan.columns;');
const source=wrap('ctx <-context(); plan <-query({limit:5,value:1}); alias <-plan; facts <-exec_query(alias);');
try {
  let run=await runtime.run(planOnly);
  assert.equal(run.status,'complete',run.error);
  assert.equal(executions,0);assert.equal(compiles,1);assert.equal(run.acquisitions.length,0);
  assert.deepEqual(runtime.read('plan',planOnly).value.data,{columns});
  assert.deepEqual(runtime.read('peek',planOnly).value.data,columns);
  assert.ok(!JSON.stringify(runtime.read('plan',planOnly).value.sources).includes('select n'));
  run=await runtime.run(source);
  assert.equal(executions,1);assert.equal(compiles,1);
  assert.deepEqual(run.acquisitions.map(a=>a.operator),['context','exec_query']);
  const firstBatch=run.batch,context=runtime.read('ctx',source).value.data;
  zone={kind:'resolved',timeZone:'Asia/Shanghai'};
  run=await runtime.run(source+'\n');
  assert.equal(run.batch,firstBatch);assert.equal(executions,1);
  assert.deepEqual(runtime.read('ctx',source).value.data,context,'context has no changing inputs within the capture batch');
  const changed=source.replace('value:1','value:2');
  run=await runtime.run(changed);
  assert.equal(executions,2);assert.equal(compiles,2);assert.equal(run.batch,firstBatch);
  assert.deepEqual(runtime.read('ctx',changed).value.data,context);
  assert.deepEqual(runtime.read('facts',changed).value.data,{rows:[{n:2}],columns,truncated:false},'equal columns do not identify a query');
  const renewal=runtime.renew();assert.notEqual(renewal,firstBatch);
  assert.equal(executions,2);assert.equal(compiles,2,'renew does not execute or compile');
  assert.throws(()=>runtime.read('facts',changed),/No retained/);
  run=await runtime.run(changed);assert.equal(run.batch,renewal);assert.equal(executions,3);assert.equal(compiles,2);
  assert.equal((runtime.read('ctx',changed).value.data as any).tz.client.id,'Asia/Shanghai');
  run=await runtime.run(changed,{refresh:true});
  assert.notEqual(run.batch,renewal);assert.equal(executions,4);assert.equal(compiles,2);
  entry.modelHash='model-2';
  run=await runtime.run(changed);assert.equal(executions,5);assert.equal(compiles,3);
  for(const input of ['{columns:plan.columns}','plan.columns','data(plan)']){
    const invalid=wrap(`plan <-query({limit:5,value:2}); invalid <-exec_query(${input});`);
    run=await runtime.run(invalid);
    assert.equal(run.outputs.get('invalid')!.status,'failed');
    assert.match(run.outputs.get('invalid')!.error!,/complete plan/);assert.equal(executions,5);
  }
  const invalidDynamic=wrap('ctx <-context(); plan <-query({limit:ctx.utc.epochMillis}); facts <-exec_query(plan);');
  run=await runtime.run(invalidDynamic);
  assert.equal(run.outputs.get('plan')!.status,'failed');assert.equal(run.outputs.get('facts')!.status,'blocked');assert.equal(executions,5);
  const pinned=new DraftRuntime(backend,{maxCacheEntries:2});
  try{
    const crowded=source.replace('</Pipeline>',Array.from({length:12},(_,i)=>`a${i} <-data(${i});`).join('')+'</Pipeline>');
    await pinned.run(crowded);const before=executions;
    const again=await pinned.run(crowded);
    assert.equal(again.outputs.get('facts')!.status,'cached');
    assert.equal(executions,before,'pure computations never evict retained acquisitions');
  }finally{pinned.dispose();}
  console.log('query plans: zero-SQL validation, columns, internal identity, input changes, context stability, refresh and renew passed');
} finally {runtime.dispose();}
