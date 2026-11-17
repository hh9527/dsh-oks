// Run explicitly: node tests/model-located-integration.ts /path/to/ic-dari.wasm
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {analyze,check,canonicalIntent,ModelCheckFailure,SourceOffsets,MODEL_ABI_VERSION} from '@hh9527/dari-core';
import {openModel} from '@hh9527/dari-model';
import {TeloraWasm} from '../src/telora-wasm.mjs';
import {encodeLocatedInput} from '../src/located-input.mjs';
const artifact=process.argv[2];assert(artifact,'pass an IC DARI model artifact');
const host=await openModel(artifact);
try{
 assert.equal(host.contract.abi_version,MODEL_ABI_VERSION);assert.equal(host.contract.datasets.length,50);
 const source=(expr:string,comment='# 中文😀\r\n')=>comment+'data rows=query_remote! {\r\n from(ic::device_kpi).as!(device)\r\n |> project({cpu:'+expr+'}).as!(result)\r\n |> order_by(desc(result.cpu)) |> take(2)\r\n};answer tree! {Answer []};';
 const bad=source('device.cpu_usage * 2'),issues=analyze(bad,host.model).diagnostics;
 assert.equal(issues.length,1);assert.equal(issues[0].at,bad.indexOf('device.cpu_usage * 2'));assert.equal(issues[0].end,issues[0].at+'device.cpu_usage * 2'.length);
 assert(issues[0].related?.some(l=>l.source==='ontology/typed_query_protocol'));assert(issues[0].related?.some(l=>l.source==='<input>'));assert(issues[0].suggestion);
 const good=source('device.cpu_usage');const program=check(good,host.model);assert(program.bindings.has('rows'));
 let recorded:any;
 check(good,{...host.model,check_type(intent,encoded){recorded=encoded;return host.model.check_type(intent,encoded);}});
 assert.equal(host.checkWire(recorded.json).receipt.inputDigest,recorded.digest);
 assert.equal(host.checkWire(JSON.stringify(recorded.wire,null,2)).receipt.inputDigest,recorded.digest);
 const original=recorded.wire.steps.find((s:any)=>s.kind==='project').body.fields[0].value;
 const wire=structuredClone(recorded.wire),index=wire.steps.findIndex((s:any)=>s.kind==='project');wire.steps[index].body.fields[0].value.member='not_published';
 assert.throws(()=>host.checkWire(canonicalIntent(wire)),(e:unknown)=>e instanceof ModelCheckFailure&&e.diagnostics.some(d=>/unknown published model member/.test(d.message)));
 const time='# 😀\r\ndata q=query_remote! {let a=from(ic::current_alarm);let r=a |> filter(a.alarm_occur_utc_raw >= "2026-11-01T00:00:00Z") |> project({total:a.alarm_count});r |> order_by(desc(r.total)) |> take(1)};answer tree! {Answer []};';
 const d=analyze(time,host.model).diagnostics[0];assert.equal(d.at,time.indexOf('"2026-'));assert.equal(d.end,d.at+'"2026-11-01T00:00:00Z"'.length);assert.match(d.message,/expects EpochMillis/);
 check(good,host.model);assert.equal(original.member,'cpu_usage');
 // Exercise the actual Guest import/codec path, independent key/value spans and recovery.
 const runtime=new TeloraWasm(readFileSync(artifact)),input={method:'ontology/model',input:{method:'transform',input:{intent:recorded.wire}}};
 const malformed=structuredClone(input);malformed.input.input.intent.steps[index].body.fields[0].value.member=42;
 const path=['input','input','intent','steps',index,'body','fields',0,'value','member'];
 const offsets=new SourceOffsets(good),span=offsets.toBytes(good.indexOf('device.cpu_usage'),good.indexOf('device.cpu_usage')+'device.cpu_usage'.length)!;
 const reply=runtime.request(encodeLocatedInput(malformed,[{path,span},{path,span:{start:0,end:1},key:true}]));assert(reply.error);assert(reply.diagnostics.some((d:any)=>d.locs?.some((l:any)=>l.source==='<input>'&&l.start.offset===span.start&&l.end.offset===span.end)));
 assert(runtime.request(Buffer.from('bad')).error);assert.equal(runtime.request(encodeLocatedInput(input)).error,false);
 assert.equal(runtime.request(encodeLocatedInput({method:'ontology/model',input:{method:'check_type',input:{op:'Unknown'}}})).error,true);
 console.log('Native Wasm model: source ranges, proof digests, model codec errors, malformed requests and recovery passed');
}finally{await host.close();}
