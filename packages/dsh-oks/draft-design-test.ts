import assert from 'node:assert/strict';
import {checkDesign,parseExecutableDesign} from './src/draft/design.ts';
import {createDraftBackend} from './src/draft/backend.ts';
import {DraftRuntime} from './src/draft/runtime.ts';
import {helpFiles} from './src/help-files.ts';
import type {WorkspaceEntry} from './src/knowledge.ts';
let reads=0;
const columns=[{name:'n',type:'Int',nullable:false}];
const entry={modelHash:'test',settings:{domain:'test',queryMaxRows:100},runner:{async send(_m:string,{intents}:any){if(intents[0].bad)throw new Error('Invalid model intent');return {ok:{accepted:true,queries:[{sql:'SELECT n LIMIT ?',bindings:[intents[0].limit],limit_slot:0,columns}]}};}}} as unknown as WorkspaceEntry;
const backend=createDraftBackend({entry,file:'test.dari',contextZone:()=>({kind:'resolved',timeZone:'UTC'}),contextNow:()=>Date.parse('2026-10-19T00:00:00Z'),knowledge:{executorFor(){reads++;return {manifest:null,executor:{async send(){return {rows:[{n:7}],columns:['n'],truncated:false};},dispose(){}}};}}});
const check=async(source:string)=>{const r=await checkDesign(source,'test.dari',backend);assert.deepEqual(r,JSON.parse(JSON.stringify(r)));return r;};
const source=`data ctx := context(); data days := time_windows(ctx,{unit:"day",count:7,mode:"complete"}); data range := {start:days[0].start.epochMillis,end:days[6].end.epochMillis}; data a := query({limit:5,start:range.start}); data after := select({from:{a},fields:(r)=>({n:r.a.n})});`;
let r=await check(source);assert.equal(r.ok,true,JSON.stringify(r));assert(r.types.days.includes('DateTimeUtc'));assert(r.types.days.includes('EpochMillis'));assert.equal(reads,0);
for(const invalid of ['data a := query({limit:5,bad:true});','data a := exec_query(query({limit:5}));','data a := query({limit:5}); data b := query({limit:5,value:a.rows[0]});','data a := jq("a.jq",{});','data a := context(); data w := time_windows(a,{unit:"day",count:0,mode:"current"});'])assert.equal((await check(invalid)).ok,false,invalid);
assert.equal(reads,0);
const runtime=new DraftRuntime(backend,{parse:parseExecutableDesign});
try{assert.equal((await runtime.run(source)).status,'complete');assert.deepEqual(runtime.read('after',source).value.data.rows,[{n:7}]);await runtime.run(source);assert.equal(reads,1);}finally{runtime.dispose();}
const sample=[...helpFiles['oks://help/time.md'].matchAll(/```dari\n([\s\S]*?)```/g)].map(m=>m[1]).find(s=>s.includes('query('));assert(sample);assert.equal((await check(sample)).ok,true);
console.log('Design: typed JS time boundaries, remote schema checks, no business reads, invalid DSL and cache passed');
