import { parseDraft } from './src/draft/document.ts';
import { parseMarkdownFixture } from './test-markdown.ts';
import assert from 'node:assert/strict';
import { createDraftBackend } from './src/draft/backend.ts';
import { DraftRuntime } from './src/draft/runtime.ts';
class FixtureRuntime extends DraftRuntime { constructor(backend:ConstructorParameters<typeof DraftRuntime>[0], options:ConstructorParameters<typeof DraftRuntime>[1]={}) { super(backend,{...options,parse:(source,file)=>source.trimStart().startsWith('<Dari')?parseDraft(source,file):parseMarkdownFixture(source)}); } }
import type { WorkspaceEntry } from './src/knowledge.ts';

let population=0, limit=3, executions=0;
let slot:unknown=1, overflow=false;
let original:unknown[]=[];
const originals=new Map<number,unknown[]>();
const entry={modelHash:'limit-slot',settings:{domain:'test',queryMaxRows:100},runner:{async send(_method:string,{intents}: {intents:{limit:number}[]}){
  // A filter and the output cap deliberately have equal values.
  original=[intents[0].limit,intents[0].limit]; originals.set(intents[0].limit,original);
  return {ok:{accepted:true,queries:[{sql:'select n where n > ?1 limit ?2',bindings:original,limit_slot:slot,
    columns:[{name:'n',type:'Int',nullable:false}]}]}};
}}} as unknown as WorkspaceEntry;
const runtime=new FixtureRuntime(createDraftBackend({entry,file:'.work/limit.md',contextZone:()=>({kind:'resolved',timeZone:'UTC'}),
  knowledge:{executorFor:()=>({manifest:null,executor:{async send(_sql:string,bindings:unknown[],_signal?:AbortSignal,maxRows?:number){
    executions++;
    assert.deepEqual(bindings,[limit,limit+1],'only the indexed cap is adjusted');
    assert.notEqual(bindings,originals.get(limit));
    assert.equal(maxRows,limit+1,'executor permits the sentinel row');
    assert.deepEqual(originals.get(limit),[limit,limit],'cached model bindings stay unchanged');
    return {rows:Array.from({length:Math.min(population,Number(bindings[1]))},(_,n)=>({n})),columns:['n'],truncated:overflow};
  },dispose(){}}})}}));
const source=()=>`## pipeline\n\x60\x60\x60js\nlet facts=exec_query(query({limit:${limit}})); debug(facts.truncated);\n\x60\x60\x60`;
try {
  for(const cap of [1,3,500]) {
    limit=cap;
    for(population of [0,Math.max(0,limit-1),limit,limit+1,limit+10]) {
      const text=source();
      const run=await runtime.run(text,{refresh:true});
      assert.equal(run.outputs.get('facts')?.status,'executed',run.outputs.get('facts')?.error);
      const facts=runtime.read('facts',text).value.data as {rows:{n:number}[];columns:unknown;truncated:boolean};
      assert.equal(facts.rows.length,Math.min(population,limit));
      assert.equal(facts.truncated,population>limit);
      assert.equal(runtime.read('debug/1',text).value.data,population>limit);
      assert.deepEqual(Object.keys(facts).sort(),['columns','rows','truncated']);
      const before=executions;
      await runtime.run(text);
      assert.equal(executions,before,'read and cached runs do not probe again');
      assert.deepEqual(runtime.read('facts',text).value.data,facts);
    }
  }
  limit=3;population=3;overflow=true;
  await runtime.run(source(),{refresh:true});
  assert.equal((runtime.read('facts',source()).value.data as any).truncated,true);
  overflow=false;
  for(const badSlot of [undefined,null,-1,2,1.5,'1']) {
    slot=badSlot;entry.modelHash='invalid-'+String(badSlot);
    const before=executions;
    const run=await runtime.run(source(),{refresh:true});
    assert.equal(run.status,'invalid');assert.match(run.error!,/limit_slot/);
    assert.equal(executions,before,'invalid slot prevents execution');
  }
  console.log('query truncation: empty/below/exact/over limit, 500+1, duplicate binding values, cache and invalid slots passed');
} finally {runtime.dispose();}
