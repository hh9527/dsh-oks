import assert from 'node:assert/strict';
import {createDraftBackend} from '../src/draft/backend.ts';
import {checkDesign,parseExecutableDesign} from '../src/draft/design.ts';
import {DraftRuntime} from '../src/draft/runtime.ts';
let reads=0;
let seen:unknown[]=[];
let resultRows=[{n:42}];
const sql='SELECT n FROM facts ORDER BY n DESC LIMIT 5';
const bindings=[123];
const entry={modelHash:'bound-model',settings:{domain:'test',queryMaxRows:1},runner:{async send(_method:string,{intents}:any){
  const intent=intents[0];
  if(!intent.order_by?.length||!Number.isInteger(intent.take)||intent.take<1||intent.take>500){
    return {ok:{accepted:false,diagnostics:[{message:'multirow query requires final order_by and take (1..500)'}]}};
  }
  return {ok:{accepted:true,queries:[{sql,bindings,max_rows:intent.take,columns:[{name:'n',type:'Int',nullable:false}]}]}};
}}};
const backend=createDraftBackend({entry:entry as any,file:'bounded.dari',contextZone:()=>({kind:'resolved',timeZone:'UTC'}),knowledge:{executorFor(){return {manifest:null,executor:{async send(...args:unknown[]){reads++;seen=args;return {columns:['n'],rows:resultRows,truncated:false};}}};}} as any});
const source='data facts = query({order_by:[{column:"n",direction:"Desc"}],take:5});';
const runtime=new DraftRuntime(backend,{parse:parseExecutableDesign});
try{
  for(const invalid of ['query({})','query({take:5})','query({order_by:[{column:"n",direction:"Desc"}],take:501})']){
    const check=await checkDesign(`data facts = ${invalid};`,'bounded.dari',backend);
    assert.equal(check.ok,false);assert.match(JSON.stringify(check.diagnostics),/final order_by and take/);
  }
  assert.equal(reads,0,'check must not read business rows');
  const check=await checkDesign(source,'bounded.dari',backend);
  assert.equal(check.ok,true,JSON.stringify(check));
  assert.equal((check.queries.find(q=>q.binding==='facts')!.result as any).maxRows,5,'propagate the checked bound to table typing');
  const result=await runtime.run(source);assert.equal(result.status,'complete',result.error??'');
  assert.equal(reads,1);assert.equal(seen[0],sql);assert.deepEqual(seen[1],bindings,'SQL bindings must be executed unchanged');
  assert.equal(seen[3],6,'read guard derives from the proven bound, not queryMaxRows');
  assert.deepEqual((runtime.read('facts',source).value.data as any).rows,[{n:42}]);
  resultRows=Array.from({length:6},()=>({n:42}));
  const violated=await runtime.run(source,{refresh:true});
  const failed=[...violated.outputs.values()].find(output=>output.status==='failed');
  assert(failed,'contract breach must fail, never return a sliced success');
  assert.match(failed.error??'',/checked result bound/);
  console.log('Query bound: check without reads, propagated upper bound, unchanged SQL/bindings, no truncation passed');
}finally{runtime.dispose();}
