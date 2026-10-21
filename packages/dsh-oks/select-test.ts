import assert from 'node:assert/strict';
import {createSelector} from './src/select.ts';
const select=(rule:string,input:any)=>createSelector(rule)(input);
assert.deepEqual(select('a.b',{a:{b:1,c:2}}),{a:{b:1}});
assert.deepEqual(select("a.'hello world'",{a:{'hello world':3}}),{a:{'hello world':3}});
assert.deepEqual(select('a[1..3]',{a:[0,1,2,3]}),{'a[1..3]':[1,2]});
assert.deepEqual(select('a:len',{a:[1,2]}),{'a:len':2});
assert.deepEqual(select('a.{b:keys}',{a:{b:{z:1,a:2}}}),{a:{'b:keys':['a','z']}});
assert.deepEqual(select('a.{b,c.{x,y}}',{a:{b:1,c:{x:2,y:3,z:4}}}),{a:{b:1,c:{x:2,y:3}}});
assert.deepEqual(select('a.b,a.c',{a:{b:1,c:2}}),select('a.{b,c}',{a:{b:1,c:2}}));
assert.deepEqual(select('a.{b:keys:len,b:keys[0..1]:len}',{a:{b:{z:1,a:2}}}),{a:{'b:keys:len':2,'b:keys[0..1]:len':1}});
for(const value of [null,true,1,'abc']){
 assert.deepEqual(select('a:len',{a:value}),{'a:len':null});
}
assert.deepEqual(select('[1..3]',[0,1,2,3]),[1,2]);
assert.deepEqual(select(':keys',{z:1,a:2}),['a','z']);
assert.deepEqual(select("'a:b','a.b','a[0..1]'",{'a:b':1,'a.b':2,'a[0..1]':3}),{'a:b':1,'a.b':2,'a[0..1]':3});
assert.deepEqual(select("'quote\\'key'",{"quote'key":1}),{"quote'key":1});
const proto=select("'__proto__'",JSON.parse('{"__proto__":7}'));assert.equal(Object.getPrototypeOf(proto),Object.prototype);assert.equal(Object.hasOwn(proto,'__proto__'),true);
assert.deepEqual(select('a',{a:null}),{a:null});
assert.throws(()=>select('a.b',{a:{}}),/missing field/);
assert.throws(()=>select('a[0..1]',{a:{}}),/requires array or string/);
assert.throws(()=>select('a,a.b',{a:{b:1}}),/conflict/);
for(const rule of ['', 'a.', 'a..b', 'a.{b,}', 'a:unknown', 'a:shape', ':shape', "a.'broken", 'a[0..x]', 'a[0..1', 'a;process.exit()', 'a.{b'])assert.throws(()=>createSelector(rule),/select/);
const input={a:{b:1}};const before=JSON.stringify(input);select('a.b',input);assert.equal(JSON.stringify(input),before);
console.log('select: nested projections, groups, chain order, sorted keys, scalar semantics, slices, conflicts, literal keys passed');
