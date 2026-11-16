// Explicit integration: node tests/dari-remote-boundary-integration.ts <service.js> <ic-dari.wasm> <icloud.sqlite> [integration.mjs]
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {existsSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const [service,model,database]=process.argv.slice(2).map(p=>resolve(p));
assert(service&&model&&database,'Pass service, model and database paths');
const integration=process.argv[5]?resolve(process.argv[5]):fileURLToPath(new URL('../src/dari-integration.ts',import.meta.url));
const root=mkdtempSync(join(tmpdir(),'remote-boundary-'));
const source=`data remote=query_remote! {
 from(ic::device_kpi).as!(a)
 |> project({day:calendar_bucket(a.device_kpi_ts_raw,CalendarUnit::Day,TimeZone("America/New_York")),cpu:a.cpu_usage}).as!(r)
 |> order_by(desc(r.day)) |> take(2)
};
data local=query! {from(remote).as!(a) |> project({day:a.day,cpu:a.cpu}).as!(r) |> take(2)};
answer tree! {Answer [Table(data=remote),Table(data=local)]};`;
function call(method:string,path:string){
 const now=Date.now();
 const input=JSON.stringify({id:1,method,source,context:{now:new Date(now).toISOString(),epochMillis:now,timeZone:'America/New_York'},contextContractId:'dari-context/v2'})+'\n';
 const result=spawnSync(process.execPath,[service,'--integration',integration,'--options',JSON.stringify({model}),'--database',path],{input,encoding:'utf8',timeout:30000});
 assert.equal(result.status,0,result.stderr||String(result.error));return JSON.parse(result.stdout);
}
try{
 const missing=join(root,'missing.sqlite');
 const checked=call('check',missing);assert(!checked.error,checked.error);assert(!existsSync(missing));
 const reply=call('resolve',database);assert(!reply.error,reply.error);
 const parts=reply.result.dataDocument.split(/## answer\/tables\/\d+\n\n/).slice(1);assert.equal(parts.length,2);assert.equal(parts[0].trim(),parts[1].trim());assert.match(parts[0],/2026-/);
 assert.equal(reply.result.queries,2); // one backend acquisition, one local query
 assert(!reply.result.dataDocument.includes('_dari_remote_order'));
 console.log('IC remote boundary: check without database, read-only backend region bucket, independent SQLite postprocessing, preserved order and identical display data passed');
}finally{rmSync(root,{recursive:true,force:true});}
