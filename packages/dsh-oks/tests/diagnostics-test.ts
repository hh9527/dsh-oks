import assert from 'node:assert/strict';
import {DiagnosticCollector} from '../src/draft/diagnostics.ts';
import {box,common,optional,UpstreamTypeUnavailable,type Ty} from '../src/draft/typed-types.ts';
import {checkDesign,parseAnalysisDesign} from '../src/draft/design.ts';
import {createDraftBackend} from '../src/draft/backend.ts';
import {runTyped} from '../src/draft/typed-runtime.ts';
import {DraftSyntaxError} from '../src/draft/pipeline.ts';
import {TypedCompiler} from '../src/draft/typed-compiler.ts';

const span={start:{offset:0,line:1,column:1},end:{offset:1,line:1,column:2}};
const diagnostics=new DiagnosticCollector();
const checkpoint=diagnostics.checkpoint();
diagnostics.report({stage:'type',severity:'warning',message:'warning',span});
assert(!diagnostics.hasErrors(checkpoint));
diagnostics.report({stage:'type',message:'first',span});
diagnostics.reportAll([{stage:'type',message:'second',span}]);
assert(diagnostics.hasErrors(checkpoint));
assert.equal(diagnostics.list().length,3);
diagnostics.list().pop();assert.equal(diagnostics.list().length,3);
const ordered=new DiagnosticCollector();
ordered.report({stage:'type',message:'later',span:{start:{offset:9,line:2,column:1},end:{offset:10,line:2,column:2}}});
ordered.report({stage:'type',message:'earlier',span});
assert.deepEqual(ordered.list().map(d=>d.message),['earlier','later']);
const sameLocation=(reverse:boolean)=>{const c=new DiagnosticCollector();const entries=[{stage:'type',message:'same',span,asset:'a'},{stage:'type',message:'same',span,asset:'b'},{stage:'type',severity:'error' as const,message:'same',span,asset:'a'}];c.reportAll(reverse?entries.reverse():entries);return c.list();};
assert.deepEqual(sameLocation(false),sameLocation(true));assert.equal(sameLocation(false).length,2);
const error:Ty={kind:'error'};
assert.deepEqual(common(error,{kind:'scalar',name:'Int',nullable:false}),error);
assert.deepEqual(optional(error),error);
const compiler=new TypedCompiler({}, {}, true);
const condition=compiler.compile({k:'template_scope',s:span,op:'condition',a:[{k:'ref',s:span,name:'opt'},{k:'lambda',s:span,params:['x'],body:{k:'ref',s:span,name:'missing'}}]},{opt:{type:{kind:'scalar',name:'Int',nullable:true},known:false}});
assert.equal(condition.type.kind,'error');
assert.deepEqual(compiler.diagnostics.list().map(d=>d.message),['Unknown binding missing']);
for(const kind of ['map_opt','template_scope']){
 const c=new TypedCompiler({}, {}, true);
 const input={k:'ref',s:span,name:'missing_input'},body={k:'object',s:span,entries:[{key:'dependent',value:{k:'get',s:span,input:{k:'ref',s:span,name:'x'},key:'field'}},{key:'independent',value:{k:'ref',s:span,name:'missing_body'}}]};
 const lambda={k:'lambda',s:span,params:['x'],body};
 const value=c.compile(kind==='map_opt'?{k:'call',s:span,name:kind,a:[input,lambda]}:{k:kind,s:span,a:[input,lambda]},{});
 assert.equal(value.type.kind,'error');assert.deepEqual(c.diagnostics.list().map(d=>d.message),['Unknown binding missing_body','Unknown binding missing_input']);
}
const cases=new TypedCompiler({}, {}, true);
cases.compile({k:'call',s:span,name:'case_when',a:[{k:'ref',s:span,name:'missing_condition'},{k:'lit',s:span,v:1},{k:'lit',s:span,v:'bad'}]},{});
assert.deepEqual(cases.diagnostics.list().map(d=>d.message),['Incompatible types Int and String','Unknown binding missing_condition']);
const badCondition=new TypedCompiler({}, {}, true);
badCondition.compile({k:'call',s:span,name:'case_when',a:[{k:'lit',s:span,v:1},{k:'ref',s:span,name:'missing_branch'},{k:'lit',s:span,v:2}]},{});
assert.deepEqual(badCondition.diagnostics.list().map(d=>d.message),['case_when requires Bool','Unknown binding missing_branch']);
const arrayCompiler=new TypedCompiler({}, {}, true);
const array=arrayCompiler.compile({k:'array',s:span,a:[{k:'ref',s:span,name:'missing'},{k:'lit',s:span,v:1},{k:'lit',s:span,v:'bad'},{k:'lit',s:span,v:true}]},{});
assert.equal(array.type.kind,'array');if(array.type.kind==='array')assert.equal(array.type.element.kind,'error');
assert.equal(arrayCompiler.diagnostics.list().length,3);
assert.equal(arrayCompiler.diagnostics.list().filter(d=>d.message.startsWith('Incompatible types')).length,2);
const source='data facts = table([{n:1}],{kind:"example"}); data result = select({from:{s:facts},fields:r=>({a:r.s.missing_a,b:r.s.missing_b})});';
const statement=parseAnalysisDesign(source,'fixture.dari').nodes.at(-1)!.statement;
assert.equal(statement.value.kind,'call');
if(statement.value.kind!=='call')throw new Error('Expected relational call');
const ast=statement.value.args[0];assert.equal(ast.kind,'literal');
if(ast.kind!=='literal')throw new Error('Expected AST literal');
let prepares=0;
await assert.rejects(runTyped({operator:'relational',args:[{data:ast.value},{data:{__source0:{columns:[{name:'n',type:'Int',nullable:false}],rows:[],truncated:false}}}],statement,span:statement.span,run:'check'} as any,{async execute(){prepares++;throw new Error('Unexpected SQL prepare');}} as any,true),error=>{
 assert(error instanceof DraftSyntaxError);assert.equal(error.diagnostics.length,2);return true;
});
assert.equal(prepares,0);
const blockedSource='data facts = table([{n:1}],{kind:"example"}); data bad = 1; data x = select({from:{s:facts},fields:r=>({v:bad + 1})});';
const blockedStatement=parseAnalysisDesign(blockedSource,'fixture.dari').nodes.at(-1)!.statement;
if(blockedStatement.value.kind!=='call'||blockedStatement.value.args[0].kind!=='literal')throw new Error('Expected relational AST');
await assert.rejects(runTyped({operator:'relational',args:[{data:blockedStatement.value.args[0].value},{data:{__source0:{columns:[{name:'n',type:'Int',nullable:false}],rows:[],truncated:false},bad:box({kind:'error'})}}],statement:blockedStatement,span:blockedStatement.span,run:'check'} as any,{async execute(){prepares++;throw new Error('Unexpected SQL prepare');}} as any,true),UpstreamTypeUnavailable);
assert.equal(prepares,0);
const backend=createDraftBackend({entry:{settings:{},modelHash:'fixture'} as any,file:'fixture.dari',contextZone:()=>({kind:'resolved',timeZone:'UTC'}),knowledge:{executorFor(){throw new Error('Unexpected business read');}}});
try{
 const mixed=await checkDesign('data x = [1,"x"];','fixture.dari',backend);
 assert.equal(mixed.ok,false);assert(mixed.diagnostics.some(d=>/Incompatible types/.test(d.message)),JSON.stringify(mixed));
 assert(mixed.checkedBindings.some(b=>b.name==='x'&&!b.checked));
 const warningBackend={...backend,checkCall(ctx:any){return [{stage:'type',severity:'warning' as const,message:'advisory',span:ctx.span}];}};
 const warned=await checkDesign('data x = data(1);','fixture.dari',warningBackend);
 assert.equal(warned.ok,true,JSON.stringify(warned));assert.equal(warned.warnings[0]?.message,'advisory');assert(warned.checkedBindings[0].checked);
 const internalError=new Error('internal failure');
 await assert.rejects(checkDesign('data x = 1 + 2;','fixture.dari',{...backend,async analyze(){throw internalError;}}),e=>e===internalError);
 await assert.rejects(checkDesign('data x = 1;','fixture.dari',{...backend,async preflight(){throw internalError;}}),e=>e===internalError);
 const cancellation=new AbortController(),cancelReason=new Error('cancelled during analysis');
 const cancelledBackend={...backend,async preflight(){},async analyze(){cancellation.abort(cancelReason);return {data:{columns:[{name:'n',type:'Int',nullable:false}]}};}};
 await assert.rejects(checkDesign('data x = query({limit:5});','fixture.dari',cancelledBackend,cancellation.signal),e=>e===cancelReason);
 await assert.rejects(checkDesign('','fixture.dari',backend,cancellation.signal),e=>e===cancelReason);
 const slowCancellation=new AbortController(),slowReason=new Error('cancelled while waiting');
 const slowBackend={...backend,async preflight(){},async analyze(){setTimeout(()=>slowCancellation.abort(slowReason),5);return await new Promise<never>(()=>{});}};
 await assert.rejects(Promise.race([checkDesign('data x = query({limit:5});','fixture.dari',slowBackend,slowCancellation.signal),new Promise((_,reject)=>setTimeout(()=>reject(new Error('cancellation did not finish')),500))]),e=>e===slowReason);
 for(const reverse of [false,true]){
  const concurrent={...backend,async preflight(){},async analyze(ctx:any){
   if(ctx.operator!=='query')throw new Error('Unexpected analysis '+ctx.operator);
   const name=ctx.args[0].data.bad;await new Promise(resolve=>setTimeout(resolve,(name==='first')===reverse?10:0));throw new DraftSyntaxError('rejected '+name,ctx.span);
  }};
  const siblings=await checkDesign('data x = union_all([query({limit:5,bad:"first"}),query({limit:5,bad:"second"})]);','fixture.dari',concurrent);
  assert.deepEqual(siblings.diagnostics.map(d=>d.message),['rejected first','rejected second']);
  assert(siblings.diagnostics[0].span.start.offset<siblings.diagnostics[1].span.start.offset);
 }
 const intents:unknown[]=[];
 const modelFailure=new Error('model transport failed');
 const failedModel=createDraftBackend({entry:{settings:{},modelHash:'failed',runner:{async send(){throw modelFailure;}}} as any,file:'fixture.dari',contextZone:()=>({kind:'resolved',timeZone:'UTC'}),knowledge:{executorFor(){throw new Error('Unexpected business read');}}});
 try{await assert.rejects(checkDesign('data x = query({limit:5});','fixture.dari',failedModel),e=>e===modelFailure);}finally{failedModel.dispose?.();}
 const tracked=createDraftBackend({entry:{settings:{},modelHash:'dag',runner:{async send(_method:string,{intents:items}:any){intents.push(...items);return {ok:{accepted:true,queries:[{sql:'SELECT 1 LIMIT ?',bindings:[items[0].limit],limit_slot:0,columns:[{name:'n',type:'Int',nullable:false}]}]}};}}} as any,file:'fixture.dari',contextZone:()=>({kind:'resolved',timeZone:'UTC'}),knowledge:{executorFor(){throw new Error('Unexpected business read');}}});
 try{
  const dag=await checkDesign('data bad = [1,"x"]; data blocked = query({limit:5,value:bad}); data independent = query({limit:5,kind:"independent"});','fixture.dari',tracked);
  assert.equal(dag.ok,false);assert(dag.diagnostics.some(d=>d.message.includes('Incompatible types')));
  assert(dag.checkedBindings.some(b=>b.name==='blocked'&&!b.checked));assert(dag.checkedBindings.some(b=>b.name==='independent'&&b.checked));
  assert.equal(dag.types.blocked,undefined);assert.equal(dag.checkedBindings.find(b=>b.name==='blocked')?.shape,undefined);
  assert.deepEqual(intents,[{limit:5,kind:'independent'}]);
 }finally{tracked.dispose?.();}
}finally{backend.dispose?.();}
console.log('Diagnostic collector: checkpoints, explicit reports and error type propagation passed');
