import assert from 'node:assert/strict';
import {checkDesign,parseExecutableDesign} from './src/draft/design.ts';
import {createDraftBackend} from './src/draft/backend.ts';
import {DraftRuntime} from './src/draft/runtime.ts';
import type {WorkspaceEntry} from './src/knowledge.ts';
let reads=0;
const columns=[{name:'server_id',type:'String',nullable:false},{name:'cpu',type:'Float',nullable:true}];
const entry={modelHash:'typed-test',settings:{domain:'test',queryMaxRows:100},runner:{async send(_m:string,{intents}:any){return {ok:{accepted:true,queries:[{sql:JSON.stringify(intents[0]),bindings:[10],limit_slot:0,columns}]}};}}} as unknown as WorkspaceEntry;
const backend=createDraftBackend({entry,file:'typed.dari',contextZone:()=>({kind:'resolved',timeZone:'UTC'}),knowledge:{executorFor(){reads++;return {manifest:null,executor:{async send(sql:string){const i=JSON.parse(sql);return {columns:['server_id','cpu'],truncated:false,rows:i.period==='base'?[{server_id:'a',cpu:30},{server_id:'b',cpu:null},{server_id:'c',cpu:50}]:[{server_id:'a',cpu:35},{server_id:'b',cpu:80},{server_id:'c',cpu:48}]};}}} as any;}}});
const source=`<Dari><Pipeline>
base <- query({period:"base",limit:10});
current <- query({period:"current",limit:10});
comparison <- select({
 from:{b:base},joins:[{kind:"inner",source:{c:current},on:(r)=>r.b.server_id == r.c.server_id}],
 where:(r)=>is_some(r.b.cpu) && is_some(r.c.cpu),
 fields:(r)=>({server_id:r.b.server_id,base_cpu:r.b.cpu,current_cpu:r.c.cpu,delta:r.c.cpu-r.b.cpu}),
 order_by:(out)=>[desc(out.delta),asc(out.server_id)],limit:3
});
winner <- select_one({from:{s:comparison},fields:(r)=>({server_id:r.s.server_id,delta:r.s.delta}),order_by:(out)=>[desc(out.delta),asc(out.server_id)],limit:1});
summary <- select_one({from:{s:comparison},group_by:(r)=>({}),fields:(g,rows)=>({n:count(rows),mean:avg(rows.s.delta)})});
spec <- {columns:["server_id","delta"]};
{comparison,winner,summary}
</Pipeline><Figures><Table name="comparison" spec={spec} data={comparison}/></Figures>
<Report name="answer"><article><p>首名 <Value data={winner?.server_id}/></p><figure><Figure ref="comparison"/></figure></article></Report></Dari>`;
let checked=await checkDesign(source,'typed.dari',backend);
assert.equal(checked.ok,true,JSON.stringify(checked));assert.equal(reads,0);
assert.deepEqual(JSON.parse(JSON.stringify(checked)),checked);
assert.match(checked.queries.find(q=>q.binding==='comparison')!.type!,/delta:Option\(Float\)/);
assert.match(checked.queries.find(q=>q.binding==='winner')!.type!,/^Option\(/);
let bad=await checkDesign(source.replace('r.c.cpu-r.b.cpu','r.c.cpu_typo-r.b.cpu'),'typed.dari',backend);
assert.equal(bad.ok,false);assert(bad.diagnostics.some(d=>/cpu_typo.*available fields/.test(d.message)),JSON.stringify(bad));assert.equal(reads,0);
bad=await checkDesign(source.replace('r.c.cpu-r.b.cpu','r.c.server_id-r.b.cpu'),'typed.dari',backend);assert(bad.diagnostics.some(d=>/Arithmetic requires numbers/.test(d.message)),JSON.stringify(bad));
const runtime=new DraftRuntime(backend,{parse:parseExecutableDesign});
try{
 const run=await runtime.run(source);assert.equal(run.status,'complete',run.error);for(const [name,x]of run.outputs)assert(!['failed','blocked'].includes(x.status),name+':'+x.error);
 assert.deepEqual((runtime.read('comparison',source).value.data as any).rows,[{server_id:'a',base_cpu:30,current_cpu:35,delta:5},{server_id:'c',base_cpu:50,current_cpu:48,delta:-2}]);
 assert.deepEqual(runtime.read('winner',source).value.data,{server_id:'a',delta:5});
 assert.deepEqual(runtime.read('summary',source).value.data,{n:2,mean:1.5});
 const count=reads;await runtime.run(source);assert.equal(reads,count);
 const edited=source.replace('delta:r.c.cpu-r.b.cpu','delta:(r.c.cpu-r.b.cpu)*2');await runtime.run(edited);assert.equal(reads,count);assert.equal((runtime.read('winner',edited).value.data as any).delta,10);
}finally{runtime.dispose();}
console.log('Typed Pipeline: query schemas, typed joins/projections/Option, aggregation, select_one, report, cache and zero-data diagnostics passed');

const small=(body:string,extra='')=>`<Dari><Pipeline>a <-query({period:"base",limit:10});b <-query({period:"current",limit:10});${body}</Pipeline>${extra}</Dari>`;
async function checkedRun(body:string){const text=small(body);const checked=await checkDesign(text,'typed.dari',backend);assert.equal(checked.ok,true,JSON.stringify(checked));const rt=new DraftRuntime(backend,{parse:parseExecutableDesign});const run=await rt.run(text);return {rt,run,text};}
{
 const {rt,run,text}=await checkedRun(`part <-select({from:{x:b},where:(r)=>r.x.server_id == "a",fields:(r)=>({server_id:r.x.server_id,cpu:r.x.cpu})});
 left <-select({from:{x:a},joins:[{kind:"left",source:{y:part},on:(r)=>r.x.server_id == r.y.server_id}],fields:(r)=>({id:r.x.server_id,cpu:r.y?.cpu ?? 0,matched:is_some(r.y)}),order_by:(o)=>[asc(o.id)]});`);
 try{assert.deepEqual((rt.read('left',text).value.data as any).rows,[{id:'a',cpu:35,matched:true},{id:'b',cpu:0,matched:false},{id:'c',cpu:0,matched:false}]);}finally{rt.dispose();}
}
{
 const {rt,run,text}=await checkedRun(`empty <-select({from:{x:a},where:(r)=>false,fields:(r)=>({cpu:r.x.cpu})});
 one <-select_one({from:{x:empty},fields:(r)=>({cpu:r.x.cpu})});
 aggregate <-select_one({from:{x:empty},group_by:(r)=>({}),fields:(g,rows)=>({n:count(rows),total:sum(rows.x.cpu),mean:avg(rows.x.cpu)})});
 label <-one?.cpu ?? -1;`);
 try{assert.equal(rt.read('one',text).value.data,null);assert.deepEqual(rt.read('aggregate',text).value.data,{n:0,total:null,mean:null});assert.equal(rt.read('label',text).value.data,-1);}finally{rt.dispose();}
}
{
 const {rt,run}=await checkedRun('one <-select_one({from:{x:a},fields:(r)=>({id:r.x.server_id})});');
 try{assert.equal(run.outputs.get('one')?.status,'failed');assert.match(run.outputs.get('one')?.error??'',/CardinalityViolation/);}finally{rt.dispose();}
}
{
 const {rt,text}=await checkedRun('both <-union_all([a,b]); group <-select({from:{x:both},group_by:(r)=>({id:r.x.server_id}),fields:(g,rows)=>({id:g.id,n:count(rows.x.cpu),mean:avg(rows.x.cpu)}),having:(o)=>o.n > 0,order_by:(o)=>[asc(o.id)]});');
 try{assert.deepEqual((rt.read('group',text).value.data as any).rows,[{id:'a',n:2,mean:32.5},{id:'b',n:1,mean:80},{id:'c',n:2,mean:49}]);}finally{rt.dispose();}
}
{
 const {rt,text}=await checkedRun('parts <-map([1,2],(day)=>query({period:"base",limit:10,day:day})); both <-union_all(parts);');
 try{assert.equal((rt.read('both',text).value.data as any).rows.length,6);}finally{rt.dispose();}
}
for(const [body,pattern]of [
 ['x <-select({from:{s:a},where:(r)=>r.s.cpu > 0,fields:(r)=>({id:r.s.server_id})});',/Predicate must return Bool/],
 ['x <-select({from:{s:a},fields:(r)=>({id:r.s.server_id}),order_by:(o)=>[asc(o.missing)]});',/Unknown field missing/],
 ['x <-select({from:{s:a},fields:(r)=>({id:r.s.server_id}),limit:1});',/limit requires order_by/],
 ['x <-select({from:{s:a},joins:[{kind:"left",source:{t:b},on:(r)=>r.s.server_id==r.t.server_id}],fields:(r)=>({cpu:r.t.cpu})});',/Use \?\./],
 ['x <-select_one({from:{s:a},fields:(r)=>({cpu:r.s.cpu}),order_by:(o)=>[asc(o.cpu)],limit:1}); next <-query({limit:10,cpu:x?.cpu});',/query parameters must be known/],
 ['x <-select({from:{s:a},fields:(r)=>({cpu:avg(r.s.cpu)})});',/requires a grouped Column/],
 ['x <-select({from:{s:a},fields:(r)=>({name:r.s.server_id})}); both <-union_all([a,x]);',/column names\/order differ/],
] as const){const before=reads;const c=await checkDesign(small(body),'typed.dari',backend);assert.equal(c.ok,false,body);assert(c.diagnostics.some(d=>pattern.test(d.message)),JSON.stringify(c));assert.equal(reads,before);}
console.log('Typed boundaries: left join Option/presence, empty tables/groups, cardinality, union/map, nullable predicates and business-dependent query rejection passed');

// Renderer manuals must themselves be executable without assets or a business database.
{
 const {presentationFacts}=await import('./src/presentation-facts.ts');
 const example=presentationFacts.examples.report;
 assert(!example.includes('<Asset'));
 const before=reads;const checked=await checkDesign(example,'typed.dari',backend);assert.equal(checked.ok,true,JSON.stringify(checked));
 const rt=new DraftRuntime(backend,{parse:parseExecutableDesign});
 try{const run=await rt.run(example);for(const [name,state]of run.outputs)assert(!['failed','blocked'].includes(state.status),name+':'+state.error);assert.equal(reads,before);assert(rt.read('answer',example).value.sources[0].delivery);}finally{rt.dispose();}
}
{
 const {rt,text}=await checkedRun(`first <-select_one({from:{x:a},fields:(r)=>({cpu:r.x.cpu}),order_by:(o)=>[asc(o.cpu)],limit:1});
 capture <-select({from:{x:b},fields:(r)=>({id:r.x.server_id,diff:r.x.cpu-first?.cpu}),order_by:(o)=>[asc(o.id)]});
 name <-map_opt(first,(x)=>({value:x.cpu}));`);
 try{assert.equal((rt.read('capture',text).value.data as any).rows[0].diff,5);assert.deepEqual(rt.read('name',text).value.data,{value:30});}finally{rt.dispose();}
}
{
 const before=reads;(entry as any).modelHash='changed-schema';columns[1].type='String';
 const checked=await checkDesign(source,'typed.dari',backend);assert.equal(checked.ok,false);assert(checked.diagnostics.some(d=>/Arithmetic requires numbers/.test(d.message)));assert.equal(reads,before);
 columns[1].type='Float';(entry as any).modelHash='restored-schema';
}
{
 const text=small('x <-select({from:{s:a},fields:(r)=>({id:r.s.server_id})});');
 const rt=new DraftRuntime(backend,{parse:parseExecutableDesign});
 try{await rt.run(text);const before=reads;const run=await rt.run('\n'+text);assert.equal(reads,before,'Source positions do not invalidate query caches');assert.equal(run.outputs.get('x')?.status,'cached','Source positions do not invalidate typed relation caches');}finally{rt.dispose();}
}
console.log('Typed integration: generated no-asset manuals, runtime scalar captures, optional objects, schema changes and location-independent caches passed');
