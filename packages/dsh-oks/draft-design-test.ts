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

const cascaded=await check(`data a := query({limit:5});
data broken := select({from:{a},fields:(r)=>({n:r.a.missing})});
data downstream := select({from:{b:broken},fields:(r)=>({n:r.b.n})});
data independent := select({from:{a},fields:(r)=>({n:r.a.other_missing})});`);
assert.equal(cascaded.ok,false);
assert.equal(cascaded.status,'invalid');
assert(cascaded.diagnostics.some(d=>d.message.includes('Unknown field missing')));
assert(cascaded.diagnostics.some(d=>d.message.includes('Unknown field other_missing')));
assert(!cascaded.diagnostics.some(d=>d.message==='Upstream type is unavailable'));
assert.equal(reads,1,'diagnostic filtering never executes business queries');
console.log('Design diagnostics: root and independent errors retained, upstream cascades hidden, invalid status preserved');

const badBracket='// 中文定位\n\tdata total := select_one({from:{f:[]},fields:(g,rows)=>({n:1}));';
const syntax=await check(badBracket);
assert.equal(syntax.ok,false);
const diagnostic=syntax.diagnostics[0];
assert.equal(diagnostic.stage,'syntax');
assert.equal(diagnostic.expected,'}');assert.equal(diagnostic.found,')');
assert.equal(diagnostic.excerpt?.line,2);
assert(diagnostic.excerpt?.text.includes('data total'));
assert(diagnostic.excerpt?.marker.endsWith('^'));
assert.equal(diagnostic.related?.[0].message,'Opening { requires }');
assert.equal(diagnostic.related?.[0].span.start.offset,badBracket.indexOf('{from'));
const missingClose=await check('data a := {x:1');
assert.equal(missingClose.diagnostics[0].expected,'}');
assert.equal(missingClose.diagnostics[0].found,'end of input');
const missingSemicolon=await check('data a := 1');
assert.equal(missingSemicolon.diagnostics[0].expected,';');
assert.equal(missingSemicolon.diagnostics[0].found,'end of input');
assert.equal(reads,1,'syntax diagnostics never execute business queries');
console.log('Syntax diagnostics: original line, caret, expected delimiter and opening location, EOF and missing semicolon passed');

// Shared source has separate semantic and executable lowering.
{
 const {ANALYSIS_CONTEXT_TIME}=await import('./src/draft/backend.ts');
 const {parseAnalysisDesign}=await import('./src/draft/design.ts');
 let clockReads=0,businessReads=0;const intents:any[]=[];const analyzed:string[]=[];
 let now=Date.parse('2030-06-20T08:09:10.123Z');
 const model={modelHash:'phase-test',settings:{domain:'test',queryMaxRows:100},runner:{async send(_method:string,{intents:items}:any){
  const intent=items[0];intents.push(intent);if(intent.day===2&&intent.reject)throw new Error('second window rejected');
  return {ok:{accepted:true,queries:[{sql:'SELECT n LIMIT ?',bindings:[intent.limit],limit_slot:0,columns}]}};
 }}} as unknown as WorkspaceEntry;
 const real=createDraftBackend({entry:model,file:'phase.dari',contextZone:()=>({kind:'resolved',timeZone:'UTC'}),contextNow:()=>{clockReads++;return now;},knowledge:{executorFor(){businessReads++;return {manifest:null,executor:{async send(){return {rows:[{n:7}],columns:['n'],truncated:false};}}} as any;}}});
 const analysis={...real,async execute(){throw new Error('Analysis invoked execution');},async analyze(ctx:Parameters<NonNullable<typeof real.analyze>>[0]){analyzed.push(ctx.operator);return real.analyze!(ctx);}};
 const text=`data ctx := context();
 data days := time_windows(ctx,{unit:"day",count:3,mode:"complete"});
 data parts := map(days,(day,index)=>select({from:{q:query({limit:5,day:index,start:day.start.epochMillis})},fields:(r)=>({n:r.q.n})}));
 data facts := union_all(parts);
 data summary := select_one({from:{f:facts},group_by:(r)=>({}),fields:(g,rows)=>({n:sum(rows.f.n)})});`;
 const semantic=parseAnalysisDesign(text,'phase.dari'),executable=parseExecutableDesign(text,'phase.dari');
 assert.equal((semantic.nodes[2].statement.value as any).operator,'analysis_map');assert.equal(executable.nodes[2].statement.value.kind,'array');
 assert.deepEqual(semantic.nodes[2].statement.span,executable.nodes[2].statement.span);
 const checked=await checkDesign(text,'phase.dari',analysis);assert.equal(checked.ok,true,JSON.stringify(checked));
 assert.equal(clockReads,0);assert.equal(businessReads,0);assert.equal(intents.length,3);
 assert.equal(analyzed.filter(op=>op==='relational').length,1,'map checks its select body once');
 assert.equal(checked.queries.filter(q=>q.binding==='parts').length,2,'one query schema and one select schema per semantic body');
 assert.match(checked.types.parts,/Array\(Table\(/);assert.match(checked.types.summary,/Option/);
 assert(intents.every(i=>i.start<ANALYSIS_CONTEXT_TIME));
 now+=86400000;assert.deepEqual(await checkDesign(text,'phase.dari',analysis),checked);
 assert.equal(intents.length,3,'repeated transform checks reuse deterministic cache');
 const rejected=await checkDesign('data parts := map([1,2,3],(day)=>query({limit:5,day:day,reject:true}));','phase.dari',analysis);
 assert.equal(rejected.ok,false);assert(rejected.diagnostics.some(d=>/second window rejected/.test(d.message)));
 const typo=await checkDesign(text.replace('n:r.q.n','n:r.q.missing'),'phase.dari',analysis);
 assert.equal(typo.ok,false);assert(typo.diagnostics.some(d=>/Unknown field missing/.test(d.message)));
 const business=await checkDesign(text+'data next := query({limit:5,n:summary?.n});','phase.dari',analysis);
 assert.equal(business.ok,false);assert(business.diagnostics.some(d=>/query parameters must be known/.test(d.message)));
 const pure=await checkDesign('data offsets := map([1,2],(n)=>n+1);data parts := map(offsets,(day)=>query({limit:5,day:day}));','phase.dari',analysis);
 assert.equal(pure.ok,true,JSON.stringify(pure));
 const given=await checkDesign('data parts := map([1,2],(n)=>table([{n:n}]));data all := union_all(parts);','phase.dari',analysis);
 assert.equal(given.ok,true,JSON.stringify(given));assert.match(given.types.all,/n:Int/);
 const nested=await checkDesign('data parts := map([1,2],(a)=>union_all(map([3,4],(b)=>query({limit:5,a:a,b:b}))));','phase.dari',analysis);
 assert.equal(nested.ok,true,JSON.stringify(nested));assert.equal(intents.filter(i=>'a' in i&&'b' in i).length,4);
 const before=analyzed.filter(op=>op==='relational').length;
 const tables=await checkDesign('data a := query({limit:5});data b := query({limit:5});data parts := map([a,b],(t)=>select({from:{t},fields:(r)=>({n:r.t.n})}));data all := union_all(parts);','phase.dari',analysis);
 assert.equal(tables.ok,true,JSON.stringify(tables));assert.equal(analyzed.filter(op=>op==='relational').length-before,1);
 assert.equal(businessReads,0);assert.equal(clockReads,0);
 const rt=new DraftRuntime(real,{parse:parseExecutableDesign});
 try{
  const run=await rt.run(text);for(const [name,state]of run.outputs)assert(!['failed','blocked'].includes(state.status),name+':'+state.error);
  assert.equal((rt.read('ctx',text).value.data as any).utc.epochMillis,now);
  assert.equal((rt.read('summary',text).value.data as any).n,21);assert.equal(clockReads,1);assert.equal(businessReads,3);
 }finally{rt.dispose();}
 console.log('Analysis/execution: fixed check clock, single map body, concrete transform validation, pure parameter maps, no business acquisition and real runtime clock passed');
}

// Figure specifications are checked before acquiring any business rows.
{
 const {parseChartSpec,parseTableSpec}=await import('./src/chart/spec.ts');
 const before=reads;
 const base={x:'n',value:'n'};
 const invalid:[Record<string,unknown>,RegExp][]=[
  [{...base,height:200},/spec\.height.*spec\.layout\.height/],
  [{...base,rowHeight:16},/spec\.rowHeight.*spec\.layout\.rowHeight/],
  [{...base,labels:true},/spec\.labels.*spec\.style\.labels/],
  [{...base,sort:'desc'},/spec\.sort.*spec\.style\.sort/],
  [{...base,unknown:true},/spec\.unknown.*allowed fields/],
  [{...base,title:12},/spec\.title.*string/],
  [{...base,x:[]},/spec\.x.*string/],
  [{...base,series:42},/spec\.series.*string/],
  [{...base,valueLabel:false},/spec\.valueLabel.*string/],
  [{...base,unit:42},/spec\.unit.*string/],
  [{...base,size:4},/spec\.size.*string/],
  [{...base,xType:'category'},/spec\.xType.*number or time/],
  [{...base,xType:'time'},/spec\.xType.*line \/ area/],
  [{...base,layout:null},/spec\.layout.*对象/],
  [{...base,layout:[]},/spec\.layout.*对象/],
  [{...base,layout:{sort:'desc'}},/spec\.layout\.sort.*spec\.style\.sort/],
  [{...base,layout:{stack:'total'}},/spec\.layout\.stack.*spec\.stack/],
  [{...base,layout:{height:'200'}},/spec\.layout\.height/],
  [{...base,layout:{tickCount:3.5}},/tickCount.*integer/],
  [{...base,layout:{slantTicks:'yes'}},/slantTicks/],
  [{...base,style:null},/spec\.style.*对象/],
  [{...base,style:{height:200}},/spec\.style\.height.*spec\.layout\.height/],
  [{...base,style:{stack:'total'}},/spec\.style\.stack.*spec\.stack/],
  [{...base,style:{labels:1}},/spec\.style\.labels/],
  [{...base,style:{colors:['#12345']}},/spec\.style\.colors/],
  [{...base,second:{value:'n',label:3}},/spec\.second\.label.*string/],
  [{...base,second:{value:'n',unit:3}},/spec\.second\.unit.*string/],
  [{...base,second:{value:'n',typo:true}},/spec\.second.*typo/],
  [{...base,marks:[{value:3,label:9}]},/spec\.marks\.label.*string/],
  [{...base,marks:[{value:3,typo:true}]},/spec\.marks.*typo/],
 ];
 for(const [spec,pattern] of invalid){
  const parsed=parseChartSpec({kind:'bar',...spec});assert('error' in parsed,JSON.stringify(spec));assert.match(parsed.error,pattern);
  const source=`data rows := query({limit:5});\ndata spec := ${JSON.stringify(spec)};\nfigure chart := BarChart(spec=spec,data=rows);`;
  const checked=await check(source);assert.equal(checked.ok,false,JSON.stringify(spec));
  const diagnostic=checked.diagnostics.find(d=>pattern.test(d.message));assert(diagnostic,JSON.stringify(checked.diagnostics));assert.equal(diagnostic.file,'test.dari');
  assert(diagnostic.span.start.line>=2&&diagnostic.span.start.line<=3);
  const rt=new DraftRuntime(backend,{file:'test.dari',parse:parseExecutableDesign});
  try{const run=await rt.run(source);assert.equal(run.status,'invalid',JSON.stringify(spec));assert.match(run.error!,pattern);}finally{rt.dispose();}
 }
 assert.equal(reads,before,'invalid figure specs never acquire business rows in checking or execution');
 const good={...base,layout:{height:300,rowHeight:20,tickCount:5},style:{labels:true,sort:'desc',colors:['#123','#1234','#123456','#12345678']}};
 const checked=await check(`data rows := query({limit:5});data spec := ${JSON.stringify(good)};figure chart := BarChart(spec=spec,data=rows);`);
 assert.equal(checked.ok,true,JSON.stringify(checked));assert.equal(reads,before);
 assert('spec' in parseChartSpec({kind:'line',x:'n',value:'n',xType:'time'}));
 const nonfinite=parseChartSpec({kind:'bar',...base,marks:[{value:Infinity}]});assert('error' in nonfinite);assert.match(nonfinite.error,/finite/);
 assert.throws(()=>parseTableSpec({columns:['n'],height:200}),/Unknown table spec fields/);
 assert.throws(()=>parseTableSpec({columns:['n'],title:42}),/title must be a string/);
 console.log(`Strict figure specs: ${invalid.length} invalid shapes rejected by shared parsing, semantic checking and runtime preflight without SQL; valid nested options accepted`);
}
