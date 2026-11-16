// Run explicitly with plain and snapshot builds of fixtures/native-wasm-service.telora.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {TeloraWasm} from '../src/telora-wasm.mjs';
import {encodeLocatedInput} from '../src/located-input.mjs';
assert.equal(process.argv.length,4,'pass a plain artifact and a snapshot artifact');
for(const path of process.argv.slice(2)){
 const runtime=new TeloraWasm(readFileSync(path)),divide=(n:number)=>runtime.request(encodeLocatedInput({method:'test',input:{method:'divide',input:n}}));
 assert.equal(divide(4).ok,25);
 assert.equal(divide(0).error,true);
 assert.throws(()=>runtime.request(encodeLocatedInput({method:'test',input:{method:'trap',input:0}})),(e:unknown)=>e instanceof Error&&e.name==='RuntimeError'||e instanceof RangeError&&/Maximum call stack/.test(e.message));
 assert.equal(divide(5).ok,20);
 for(let i=0;i<30;i++)assert.equal(divide(10).ok,10);
 const response=runtime.request(encodeLocatedInput({method:'test',input:{method:'divide',input:'bad'}},[{path:['input','input'],span:{start:3,end:12}}]));
 assert(response.error);assert(response.diagnostics.some(d=>d.locs?.some(l=>l.source==='<input>'&&l.start.offset===3&&l.end.offset===12)));
 assert.equal(divide(2).ok,50);
}
console.log('Native Wasm: plain initialization, baked snapshots, repeated resets, actual trap recovery and codec source spans passed');
