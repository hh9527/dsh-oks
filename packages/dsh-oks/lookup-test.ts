import assert from 'node:assert/strict';
import {checkDesign,parseExecutableDesign} from './src/draft/design.ts';
import {createDraftBackend} from './src/draft/backend.ts';
import {DraftRuntime} from './src/draft/runtime.ts';
import {TypedCompiler} from './src/draft/typed-compiler.ts';
import {scalar} from './src/draft/typed-types.ts';
const backend=createDraftBackend({entry:{modelHash:'lookup',settings:{domain:'test'}} as any,file:'lookup.dari',knowledge:{} as any});
const check=(source:string)=>checkDesign(source,'lookup.dari',backend);
const source=`data labels = [{value:"ne.category.switch",label:"交换机"},{value:"ne.category.router",label:"路由器"}];
data samples = table([{code:"ne.category.switch"},{code:"unknown"},{code:None}]);
data mapped = select({from:{s:samples},fields:r=>({name:lookup(r.s.code,labels),display:lookup(r.s.code,labels) ?? "其他"})});
data direct = lookup("ne.category.router",labels);
data missing = lookup(None,labels);`;
const checked=await check(source);assert.equal(checked.ok,true,JSON.stringify(checked));assert(checked.types.mapped.includes('Option(String)'));
const runtime=new DraftRuntime(backend,{parse:parseExecutableDesign});
try{
 assert.equal((await runtime.run(source)).status,'complete');
 assert.deepEqual((runtime.read('mapped',source).value.data as any).rows,[{name:'交换机',display:'交换机'},{name:null,display:'其他'},{name:null,display:'其他'}]);
 assert.equal(runtime.read('direct',source).value.data,'路由器');assert.equal(runtime.read('missing',source).value.data,null);
}finally{runtime.dispose();}
for(const [expr,pattern] of [
 ['lookup("x",[])',/nonempty/],
 ['lookup("x",[{value:"x",label:"a"},{value:"x",label:"b"}])',/duplicate/],
 ['lookup(1,[{value:"1",label:"a"}])',/key type/],
 ['lookup("x",[{value:"x",label:1},{value:"y",label:"a"}])',/Incompatible types/],
 ["lookup(\"x\",[{value:None,label:\"a\"}])",/non-null scalar/],
 ['lookup("x",[{value:"x",label:"a",extra:1}])',/exactly value and label/],
 ['lookup("x",[{value:"x",label:{a:1}}])',/scalar or null/],
] as const){const result=await check('data result = '+expr+';');assert.equal(result.ok,false,expr);assert(result.diagnostics.some(d=>pattern.test(d.message)),JSON.stringify(result));}
const s={start:{offset:0,line:1,column:1},end:{offset:1,line:1,column:2}};
const compiler=new TypedCompiler({});
const env={col:{type:scalar('String'),known:false,sql:'"code"'},mapping:{type:{kind:'array',element:{kind:'never'},nullable:false},known:false}} as any;
assert.throws(()=>compiler.compile({k:'call',name:'lookup',a:[{k:'ref',name:'col',s},{k:'ref',name:'mapping',s}],s},env),/known at check time/);
console.log('lookup: static and SQL paths, reusable mappings, null/missing fallback, type inference and invalid mappings passed');
