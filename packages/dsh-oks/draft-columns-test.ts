import assert from 'node:assert/strict';
import { createDraftBackend } from './src/draft/backend.ts';
import { DraftRuntime } from './src/draft/runtime.ts';
import { rowsOf } from './src/results.ts';
import type { WorkspaceEntry } from './src/knowledge.ts';

// SQL storage cannot reveal that an integer is EpochMillis, or whether a
// non-NULL sample came from a nullable projection. Preserve the model contract.
const declared = [{name:'clock',type:'EpochMillis',nullable:true},{name:'value',type:'Float',nullable:true}];
let columns: unknown = declared;
let rows: Record<string,unknown>[] = [{clock:1792454400000,value:3}];
let sqlColumns = ['clock','value'];
let executions = 0;
const entry={modelHash:'columns',settings:{domain:'test',queryMaxRows:100},runner:{async send(_method:string,{intents}: {intents:{limit:number}[]}){
  return {ok:{accepted:true,queries:[{sql:'select clock,value',bindings:[intents[0].limit],limit_slot:0,...(columns===undefined?{}:{columns})}]}};
}}} as unknown as WorkspaceEntry;
const runtime=new DraftRuntime(createDraftBackend({entry,file:'.work/columns.md',contextZone:()=>({kind:'resolved',timeZone:'UTC'}),
  knowledge:{executorFor:()=>({manifest:null,executor:{async send(){executions++;return {rows,columns:sqlColumns,truncated:false};},dispose(){}}})}}));
const source='## pipeline\n```js\nlet facts=query({limit:5}); debug(facts.columns); let table=render_figure({kind:"table"},{data:facts});\n```';
try {
  for(const population of [[{clock:1792454400000,value:3}],[],[{clock:null,value:null}]]) {
    rows=population;
    const run=await runtime.run(source,{refresh:true});
    assert.equal(run.status,'complete',run.error);
    assert.equal(run.outputs.get('facts')?.status,'executed',run.outputs.get('facts')?.error);
    const facts=runtime.read('facts',source).value.data as {rows:unknown[];columns:unknown};
    assert.deepEqual(facts.columns,declared);
    assert.deepEqual(facts.rows,rows);
    assert.deepEqual(runtime.read('debug/1',source).value.data,declared);
    assert.deepEqual(rowsOf(facts,'fixture'),rows);
    // Empty tables are a presentation concern; the query schema stays usable.
    if(rows.length) assert.ok(run.outputs.get('table')?.value,run.outputs.get('table')?.error);
    await runtime.run(source);
    assert.deepEqual((runtime.read('facts',source).value.data as any).columns,declared);
  }
  const before=executions;
  columns=[{name:'clock',type:'Number',nullable:false}];
  // Change the model identity to force re-validation of the new declaration.
  entry.modelHash='invalid-columns';
  let run=await runtime.run(source,{refresh:true});
  assert.equal(run.status,'invalid');assert.match(run.error!,/Invalid model result columns/);
  assert.equal(executions,before,'invalid static metadata must block SQL');
  columns=[declared[0],declared[0]];entry.modelHash='duplicate-columns';
  run=await runtime.run(source,{refresh:true});assert.equal(run.status,'invalid');assert.equal(executions,before);
  columns=declared;entry.modelHash='mismatched-columns';sqlColumns=['value','clock'];
  run=await runtime.run(source,{refresh:true});
  assert.equal(run.outputs.get('facts')?.status,'failed');
  assert.match(run.outputs.get('facts')!.error!,/column order/);
  columns=undefined;entry.modelHash='legacy-model';sqlColumns=['clock','value'];rows=[{clock:1,value:2}];
  run=await runtime.run(source,{refresh:true});
  assert.ok(run.outputs.get('facts')?.value);
  assert.deepEqual((runtime.read('facts',source).value.data as any).columns,[
    {name:'clock',types:['number'],nullable:false},{name:'value',types:['number'],nullable:false},
  ]);
  console.log('draft columns: model types, empty/all-NULL/populated results, debug, cache, renderer, validation and legacy models passed');
} finally {runtime.dispose();}
