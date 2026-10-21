import assert from 'node:assert/strict';
import {DraftRuntime} from './src/draft/runtime.ts';
import type {DraftBackend} from './src/draft/runtime.ts';
import {parsePipeline,DraftSyntaxError} from './src/draft/pipeline.ts';
const wrap=(pipeline:string)=>`<Dari><Pipeline>${pipeline}</Pipeline></Dari>`;
for(const source of ['let a = 1;','debug(1);','a <- 1; a <- 2;','a <- b; b <- 1;','a <- a;','a <- 1; {a} b <- 2;','{} {}','output <- 1;'])assert.throws(()=>parsePipeline(source),DraftSyntaxError);
const ast=parsePipeline('a <- 1; b <- {a}; {result:b}');
assert.deepEqual(ast.map(node=>node.bindings),[[],['a'],['b']]);assert.equal(ast[2].statement.kind,'output');
assert.equal(parsePipeline('{};')[0].statement.kind,'output');
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};};
const preflight=deferred(),started=deferred(),release=deferred(),child=deferred();
const calls:unknown[]=[];
const backend:DraftBackend={
 async preflight(){started.resolve();await preflight.promise;},
 environment(){return 'test';},
 async execute(ctx){
  const input=ctx.args[0]?.data;calls.push(input);
  if(input==='slow')await release.promise;
  if(input&&typeof input==='object'&&'value' in input)child.resolve();
  return {data:input};
 },
 assemble(_ctx,value){return {data:value.data,sources:[]};},
};
const runtime=new DraftRuntime(backend);
const source=wrap('slow <- data("slow"); fast <- data("fast"); child <- data({value:fast}); {child}');
const runPromise=runtime.run(source);
await started.promise;assert.equal(calls.length,0,'no node executes before preflight completes');
preflight.resolve();
await Promise.race([child.promise,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(new Error('independent downstream waited for slow source order')),2000);timer.unref();})]);
assert.equal(calls.includes('slow'),true);assert.equal(calls.includes('fast'),true);
release.resolve();const run=await runPromise;
assert.deepEqual([...run.outputs.keys()],['slow','fast','child','output']);
assert.deepEqual(runtime.read('output',source).value.data,{child:{value:'fast'}});
runtime.dispose();
// '_' invalidates pure calculation reuse, while same-run references and acquisitions stay shared.
const counts={data:0,context:0};
const cacheBackend:DraftBackend={async preflight(){},environment(){return 'test';},
 async execute(ctx){if(ctx.operator==='context'){counts.context++;return {data:{n:counts.context}};}counts.data++;return {data:ctx.args[0].data};},
 assemble(_ctx,result){return {data:result.data,sources:[]};},
};
const cached=new DraftRuntime(cacheBackend);
const text=wrap('stable <- data(7); _temp <- data(8); _ctx <- context(); other <- context(); left <- _temp; right <- _temp; {stable,left,right}');
await cached.run(text);assert.deepEqual(counts,{data:2,context:1});
await cached.run(text);assert.deepEqual(counts,{data:3,context:1});
await cached.run(text,{refresh:true});assert.deepEqual(counts,{data:4,context:2});
assert.equal(cached.read('_temp',text).value.data,8);
cached.dispose();
// A failure blocks only dependent branches; an independent final output still succeeds.
const failing=new DraftRuntime({...cacheBackend,async execute(ctx){if(ctx.args[0]?.data==='fail')throw new Error('branch failed');return {data:ctx.args[0]?.data};}});
const failureSource=wrap('bad <- data("fail"); blocked <- data(bad); good <- data(3); {good}');
const failed=await failing.run(failureSource);assert.equal(failed.outputs.get('bad')?.status,'failed');assert.equal(failed.outputs.get('blocked')?.status,'blocked');assert.deepEqual(failing.read('output',failureSource).value.data,{good:3});
failing.dispose();
console.log('pipeline DAG: immutable arrows, final output, full preflight barrier, dependency scheduling, independent failures, ephemeral calculations and shared acquisitions passed');
