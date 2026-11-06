import assert from 'node:assert/strict';
import {checkDesign,parseExecutableDesign} from '../src/draft/design.ts';
import {createDraftBackend} from '../src/draft/backend.ts';
import {DraftRuntime} from '../src/draft/runtime.ts';
import type {WorkspaceEntry} from '../src/knowledge.ts';
let reads=0;
const columns=[{name:'server_id',type:'String',nullable:false},{name:'cpu',type:'Float',nullable:true}];
const entry={modelHash:'typed-test',settings:{domain:'test',queryMaxRows:100},runner:{async send(_m:string,{intents}:any){return {ok:{accepted:true,queries:[{sql:JSON.stringify(intents[0]),bindings:[10],limit_slot:0,columns}]}};}}} as unknown as WorkspaceEntry;
const backend=createDraftBackend({entry,file:'typed.dari',contextZone:()=>({kind:'resolved',timeZone:'UTC'}),knowledge:{executorFor(){reads++;return {manifest:null,executor:{async send(sql:string){const i=JSON.parse(sql);return {columns:['server_id','cpu'],truncated:false,rows:i.period==='base'?[{server_id:'a',cpu:30},{server_id:'b',cpu:null},{server_id:'c',cpu:50}]:[{server_id:'a',cpu:35},{server_id:'b',cpu:80},{server_id:'c',cpu:48}]};}}} as any;}}});
const source=`
data base = query({period:"base",limit:10});
data current = query({period:"current",limit:10});
data comparison = select({
 from:{b:base},joins:[{kind:"inner",source:{c:current},on:(r)=>r.b.server_id == r.c.server_id}],
 where:(r)=>is_some(r.b.cpu) && is_some(r.c.cpu),
 fields:(r)=>({server_id:r.b.server_id,base_cpu:r.b.cpu,current_cpu:r.c.cpu,delta:r.c.cpu-r.b.cpu}),
 order_by:(out)=>[desc(out.delta),asc(out.server_id)],limit:3
});
data winner = select_one({from:{s:comparison},fields:(r)=>({server_id:r.s.server_id,delta:r.s.delta}),order_by:(out)=>[desc(out.delta),asc(out.server_id)],limit:1});
data summary = select_one({from:{s:comparison},group_by:(r)=>({}),fields:(g,rows)=>({n:count(rows),mean:avg(rows.s.delta)})});
data spec = {columns:["server_id","delta"]};
figure comparison_chart = tree! { Table(spec=spec,data=comparison) };
report answer = tree! { Report [p ["首名 ",Value(data=winner?.server_id)],UseFigure(ref=comparison_chart)] };`;
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
 const run=await runtime.run(source);assert.equal(run.status,'complete',run.error ?? '');for(const [name,x]of run.outputs)assert(!['failed','blocked'].includes(x.status),name+':'+x.error);
 assert.deepEqual((runtime.read('comparison',source).value.data as any).rows,[{server_id:'a',base_cpu:30,current_cpu:35,delta:5},{server_id:'c',base_cpu:50,current_cpu:48,delta:-2}]);
 assert.deepEqual(runtime.read('winner',source).value.data,{server_id:'a',delta:5});
 assert.deepEqual(runtime.read('summary',source).value.data,{n:2,mean:1.5});
 const count=reads;await runtime.run(source);assert.equal(reads,count);
 const edited=source.replace('delta:r.c.cpu-r.b.cpu','delta:(r.c.cpu-r.b.cpu)*2');await runtime.run(edited);assert.equal(reads,count);assert.equal((runtime.read('winner',edited).value.data as any).delta,10);
}finally{runtime.dispose();}
console.log('Typed Pipeline: query schemas, typed joins/projections/Option, aggregation, select_one, report, cache and zero-data diagnostics passed');

const small=(body:string)=>`data a = query({period:"base",limit:10});data b = query({period:"current",limit:10});${body}`;
{
 const before=reads;
 const text=small(`data broken = select({from:{s:a},fields:r=>({
  first:r.s.missing_first,
  second:r.s.missing_second,
  invalid:r.s.server_id + 1,
  nested:r.s.missing_nested + 1
 })}); data blocked = select({from:{s:broken},fields:r=>({id:r.s.first})});`);
 const result=await checkDesign(text,'typed.dari',backend);
 assert.equal(result.ok,false);assert.equal(reads,before);
 for(const expected of ['missing_first','missing_second','Arithmetic requires numbers','missing_nested'])assert(result.diagnostics.some(d=>d.message.includes(expected)),JSON.stringify(result.diagnostics));
 assert.equal(result.diagnostics.filter(d=>d.message.includes('Arithmetic requires numbers')).length,1,JSON.stringify(result.diagnostics));
 assert(result.checkedBindings.some(b=>b.name==='broken'&&!b.checked));assert(result.checkedBindings.some(b=>b.name==='blocked'&&!b.checked));
 const partial=await checkDesign(small(`data broken = select({from:{s:a},fields:r=>({bad:r.s.missing_root})});
 data downstream = select({from:{s:a},fields:r=>({dependent:broken.missing,independent:r.s.missing_independent})});`),'typed.dari',backend);
 assert(partial.diagnostics.some(d=>d.message.includes('missing_root')),JSON.stringify(partial.diagnostics));
 assert(partial.diagnostics.some(d=>d.message.includes('missing_independent')),JSON.stringify(partial.diagnostics));
 assert(!partial.diagnostics.some(d=>/missing on broken|Expected Table, got Error|Upstream type/.test(d.message)),JSON.stringify(partial.diagnostics));
 assert(partial.checkedBindings.some(b=>b.name==='downstream'&&!b.checked));assert.equal(reads,before);
 assert.equal(partial.types.downstream,undefined);assert.equal(partial.checkedBindings.find(b=>b.name==='downstream')?.shape,undefined);
 const siblings=await checkDesign(small(`data sample = select({from:{s:a},fields:r=>({
  first:case_when(True,r.s.missing_left,r.s.missing_right),
  second:r.s.missing_a+r.s.missing_b
 })});`),'typed.dari',backend);
 for(const name of ['missing_left','missing_right','missing_a','missing_b'])assert(siblings.diagnostics.some(d=>d.message.includes(name)),JSON.stringify(siblings.diagnostics));
 assert(!siblings.diagnostics.some(d=>/Arithmetic requires numbers|case_when requires/.test(d.message)));
 const ordering=await checkDesign(small('data sample = select({from:{s:a},fields:r=>({id:r.s.server_id}),order_by:o=>[asc(o.missing_one),desc(o.missing_two)]});'),'typed.dari',backend);
 for(const name of ['missing_one','missing_two'])assert(ordering.diagnostics.some(d=>d.message.includes(name)),JSON.stringify(ordering.diagnostics));
 assert(!ordering.diagnostics.some(d=>/Ordering requires a scalar/.test(d.message)));
 const grouped=await checkDesign(small(`data sample = select({from:{s:a},
  where:r=>r.s.missing_predicate,
  group_by:r=>({bad:r.s.missing_group}),
  fields:(g,rows)=>({valid:count(rows),bad:sum(rows.s.missing_value)})});`),'typed.dari',backend);
 for(const name of ['missing_predicate','missing_group','missing_value'])assert(grouped.diagnostics.some(d=>d.message.includes(name)),JSON.stringify(grouped.diagnostics));
 assert(!grouped.diagnostics.some(d=>/Predicate must return Bool|Group keys must be scalar|sum requires/.test(d.message)));
 const multiGroupSource=small('data sample = select({from:{s:a},group_by:r=>({first:r.s,second:r.s}),fields:(g,rows)=>({one:rows.s.cpu,two:rows.s.cpu})});');
 const multiGroup=await checkDesign(multiGroupSource,'typed.dari',backend);
 for(const [message,source] of [['Group key first','first:r.s'],['Group key second','second:r.s'],['aggregated: one','one:rows.s.cpu'],['aggregated: two','two:rows.s.cpu']]){
  const diagnostic=multiGroup.diagnostics.find(d=>d.message.includes(message));assert(diagnostic,JSON.stringify(multiGroup.diagnostics));
  assert.equal(diagnostic.span.start.offset,multiGroupSource.indexOf(source)+source.indexOf(':')+1);
 }
 const groupCascade=await checkDesign(small('data sample = select({from:{s:a},group_by:r=>({bad:r.s}),fields:(g,rows)=>({x:g.bad.missing,n:count(rows)})});'),'typed.dari',backend);
 assert(groupCascade.diagnostics.some(d=>d.message.includes('Group key bad')),JSON.stringify(groupCascade.diagnostics));
 assert(!groupCascade.diagnostics.some(d=>d.message.includes('missing')),JSON.stringify(groupCascade.diagnostics));
 const later=await checkDesign(small('data sample = select({from:{s:a},where:r=>r.s.missing_where,fields:r=>({bad:r.s.missing_field,id:r.s.server_id}),order_by:o=>[asc(o.bad),desc(o.missing_order)],limit:-1});'),'typed.dari',backend);
 for(const name of ['missing_where','missing_field','missing_order','limit requires a known nonnegative Int'])assert(later.diagnostics.some(d=>d.message.includes(name)),JSON.stringify(later.diagnostics));
 assert(!later.diagnostics.some(d=>/Ordering requires a scalar|Unknown field bad/.test(d.message)));
 const malformedOptions=await checkDesign(small('data sample = select({from:{s:a},fields:r=>({id:r.s.server_id}),having:o=>o.id=="x",order_by:42,limit:-1});'),'typed.dari',backend);
 for(const expected of ['having requires group_by','order_by requires','limit requires a known nonnegative Int'])assert(malformedOptions.diagnostics.some(d=>d.message.includes(expected)),JSON.stringify(malformedOptions.diagnostics));
 const malformedWhere=await checkDesign(small('data sample = select({from:{s:a},where:42,fields:r=>({id:r.s.missing_field})});'),'typed.dari',backend);
 for(const expected of ['Expected a row function','missing_field'])assert(malformedWhere.diagnostics.some(d=>d.message.includes(expected)),JSON.stringify(malformedWhere.diagnostics));
 assert(!malformedWhere.diagnostics.some(d=>d.message.includes('Predicate must return Bool')),JSON.stringify(malformedWhere.diagnostics));
 const joined=await checkDesign(small(`data sample = select({from:{s:a},joins:[{kind:"inner",source:{t:b},on:r=>1}],fields:r=>({bad:r.s.missing_field})});`),'typed.dari',backend);
 assert(joined.diagnostics.some(d=>/Predicate must return Bool/.test(d.message)),JSON.stringify(joined.diagnostics));
 assert(joined.diagnostics.some(d=>/missing_field/.test(d.message)),JSON.stringify(joined.diagnostics));
 const halted=await checkDesign(small('data sample = select({from:{s:a},where:r=>r.s.missing_predicate,fields:42});'),'typed.dari',backend);
 assert(halted.diagnostics.some(d=>/missing_predicate/.test(d.message)),JSON.stringify(halted.diagnostics));
 assert(halted.diagnostics.some(d=>/Expected a row function/.test(d.message)),JSON.stringify(halted.diagnostics));
 assert.equal(reads,before);
}
async function checkedRun(body:string){const text=small(body);const checked=await checkDesign(text,'typed.dari',backend);assert.equal(checked.ok,true,JSON.stringify(checked));const rt=new DraftRuntime(backend,{parse:parseExecutableDesign});const run=await rt.run(text);return {rt,run,text};}
{
 const {rt,run,text}=await checkedRun(`data part = select({from:{x:b},where:(r)=>r.x.server_id == "a",fields:(r)=>({server_id:r.x.server_id,cpu:r.x.cpu})});
 data left = select({from:{x:a},joins:[{kind:"left",source:{y:part},on:(r)=>r.x.server_id == r.y.server_id}],fields:(r)=>({id:r.x.server_id,cpu:r.y?.cpu ?? 0,matched:is_some(r.y)}),order_by:(o)=>[asc(o.id)]});`);
 try{assert.deepEqual((rt.read('left',text).value.data as any).rows,[{id:'a',cpu:35,matched:true},{id:'b',cpu:0,matched:false},{id:'c',cpu:0,matched:false}]);}finally{rt.dispose();}
}
{
 const {rt,run,text}=await checkedRun(`data empty = select({from:{x:a},where:(r)=>False,fields:(r)=>({cpu:r.x.cpu})});
 data one = select_one({from:{x:empty},fields:(r)=>({cpu:r.x.cpu})});
 data aggregate = select_one({from:{x:empty},group_by:(r)=>({}),fields:(g,rows)=>({n:count(rows),total:sum(rows.x.cpu),mean:avg(rows.x.cpu)})});
 data label = one?.cpu ?? -1;`);
 try{assert.equal(rt.read('one',text).value.data,null);assert.deepEqual(rt.read('aggregate',text).value.data,{n:0,total:null,mean:null});assert.equal(rt.read('label',text).value.data,-1);}finally{rt.dispose();}
}
{
 const {rt,run}=await checkedRun('data one = select_one({from:{x:a},fields:(r)=>({id:r.x.server_id})});');
 try{assert.equal(run.outputs.get('one')?.status,'failed');assert.match(run.outputs.get('one')?.error??'',/CardinalityViolation/);}finally{rt.dispose();}
}
{
 const {rt,text}=await checkedRun('data both = union_all([a,b]); data group = select({from:{x:both},group_by:(r)=>({id:r.x.server_id}),fields:(g,rows)=>({id:g.id,n:count(rows.x.cpu),mean:avg(rows.x.cpu)}),having:(o)=>o.n > 0,order_by:(o)=>[asc(o.id)]});');
 try{assert.deepEqual((rt.read('group',text).value.data as any).rows,[{id:'a',n:2,mean:32.5},{id:'b',n:1,mean:80},{id:'c',n:2,mean:49}]);}finally{rt.dispose();}
}
{
 const {rt,text}=await checkedRun('data parts = map([1,2],(day)=>query({period:"base",limit:10,day:day})); data both = union_all(parts);');
 try{assert.equal((rt.read('both',text).value.data as any).rows.length,6);}finally{rt.dispose();}
}
for(const [body,pattern]of [
 ['data x = select({from:{s:a},where:(r)=>r.s.cpu > 0,fields:(r)=>({id:r.s.server_id})});',/Predicate must return Bool/],
 ['data x = select({from:{s:a},fields:(r)=>({id:r.s.server_id}),order_by:(o)=>[asc(o.missing)]});',/Unknown field missing/],
 ['data x = select({from:{s:a},fields:(r)=>({id:r.s.server_id}),limit:1});',/limit requires order_by/],
 ['data x = select({from:{s:a},joins:[{kind:"left",source:{t:b},on:(r)=>r.s.server_id==r.t.server_id}],fields:(r)=>({cpu:r.t.cpu})});',/Use \?\./],
 ['data x = select_one({from:{s:a},fields:(r)=>({cpu:r.s.cpu}),order_by:(o)=>[asc(o.cpu)],limit:1}); data next = query({limit:10,cpu:x?.cpu});',/query parameters must be known/],
 ['data x = select({from:{s:a},fields:(r)=>({cpu:avg(r.s.cpu)})});',/requires a grouped Column/],
 ['data x = select({from:{s:a},fields:(r)=>({name:r.s.server_id})}); data both = union_all([a,x]);',/column names\/order differ/],
] as const){const before: number=reads;const c=await checkDesign(small(body),'typed.dari',backend);assert.equal(c.ok,false,body);assert(c.diagnostics.some(d=>pattern.test(d.message)),JSON.stringify(c));assert.equal(reads,before);}
console.log('Typed boundaries: left join Option/presence, empty tables/groups, cardinality, union/map, nullable predicates and business-dependent query rejection passed');

// Renderer manuals must themselves be executable without assets or a business database.
{
 const {presentationFacts}=await import('../src/presentation-facts.ts');
 const example=presentationFacts.examples.report;
 const before=reads;const checked=await checkDesign(example,'typed.dari',backend);assert.equal(checked.ok,true,JSON.stringify(checked));
 const rt=new DraftRuntime(backend,{parse:parseExecutableDesign});
 try{const run=await rt.run(example);for(const [name,state]of run.outputs)assert(!['failed','blocked'].includes(state.status),name+':'+state.error);assert.equal(reads,before);assert(rt.read('full',example).value.sources[0].delivery);}finally{rt.dispose();}
}
{
 const {rt,text}=await checkedRun(`data first = select_one({from:{x:a},fields:(r)=>({cpu:r.x.cpu}),order_by:(o)=>[asc(o.cpu)],limit:1});
 data capture = select({from:{x:b},fields:(r)=>({id:r.x.server_id,diff:r.x.cpu-first?.cpu}),order_by:(o)=>[asc(o.id)]});
 data name = map_opt(first,(x)=>({value:x.cpu}));`);
 try{assert.equal((rt.read('capture',text).value.data as any).rows[0].diff,5);assert.deepEqual(rt.read('name',text).value.data,{value:30});}finally{rt.dispose();}
}
{
 const before=reads;(entry as any).modelHash='changed-schema';columns[1].type='String';
 const checked=await checkDesign(source,'typed.dari',backend);assert.equal(checked.ok,false);assert(checked.diagnostics.some(d=>/Arithmetic requires numbers/.test(d.message)));assert.equal(reads,before);
 columns[1].type='Float';(entry as any).modelHash='restored-schema';
}
{
 const text=small('data x = select({from:{s:a},fields:(r)=>({id:r.s.server_id})});');
 const rt=new DraftRuntime(backend,{parse:parseExecutableDesign});
 try{await rt.run(text);const before=reads;const run=await rt.run('\n'+text);assert.equal(reads,before,'Source positions do not invalidate query caches');assert.equal(run.outputs.get('x')?.status,'cached','Source positions do not invalidate typed relation caches');}finally{rt.dispose();}
}
console.log('Typed integration: generated no-asset manuals, runtime scalar captures, optional objects, schema changes and location-independent caches passed');
