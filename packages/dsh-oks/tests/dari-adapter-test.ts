import {guidedTools} from '../src/guided-tools.ts';
import {renderInfo} from '../src/info-receipt.ts';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {createDariTools} from '../src/dari-tools.ts';
const [service,model,runner,dataFile]=process.argv.slice(2).map(p=>resolve(p));
const root=mkdtempSync(join(tmpdir(),'dari-adapter-'));
const saved=new Map<string,string>(),messages:any[]=[];
const session={id:'dari-adapter'};
const options:any={config:{service,model,runner,hostModule:fileURLToPath(new URL('../src/dari-host.ts',import.meta.url))},knowledge:{ensureWorkspace:()=>({root,settings:{dataFile,requireRunApproval:false}}),ensureIndex:async()=>({knowledge:{datasets:{device_kpi:{dimensions:{device_kpi_res_id:{}},measures:{cpu_usage:{}},subjects:[{entity:'entities/device',field:'datasets/device_kpi#fields/id'}]}},entities:{device:{}},types:{},relations:{frame_belongs_to_device:{}},tools:{},items:[]}})},timeContext:{zones:new Map([[session,{kind:'resolved',timeZone:'Asia/Shanghai'}]])},attachments:()=>({async saveFile({data,name}:any){saved.set(name,Buffer.from(data).toString());return {name,attachmentId:name,bytes:data.length};},fileHostPath:({name}:any)=>'/attachments/'+name})};
const runtime=createDariTools(options),tools=guidedTools(runtime.tools,options.knowledge,runtime.infoContracts),exec:any={agent:{session,inject:(message:any)=>messages.push(message)}};
const call=(name:string,args:any)=>tools.find(t=>t.name===name)!.execute(args as never,exec);
try{
 assert(!tools.some(t=>t.name==='dari_symbols'));
 assert(!tools.some(t=>t.name==='dari_'+'resolve'));
 assert(tools.some(t=>t.name==='dari_submit'));
 const info:any=await call('oks_info',{ids:['datasets/device_kpi','datasets/device_kpi/measures/cpu_usage','entities/device','relations/frame_belongs_to_device','datasets/missing']});
 const text=renderInfo({},info)[0].text!;
 assert.match(text,/ic::device_kpi/);assert.match(text,/symbol:.*cpu_usage/);assert.match(text,/Percent|CpuUtilization/);assert.match(text,/ic::relations::frame_belongs_to_device/);assert.match(text,/读取失败/);
 assert.equal(info.data.items.find((i:any)=>i.id==='datasets/device_kpi/measures/cpu_usage').dari.dataset,'ic::device_kpi');
 assert.equal(info.data.items.find((i:any)=>i.id==='entities/device').dari.datasets[0].symbol,'ic::device_kpi');
 writeFileSync(join(root,'test.dari'),`data ctx = context! { epoch_millis: Context::Now, time_zone: Context::ClientTz };
 data rows = query_remote! {let a = from(ic::device_kpi);let output = a |> group_by_identity(a)
 |> project({device:a.device_kpi_res_id,cpu:a.cpu_usage}); output |> order_by(desc(output.cpu)) |> take(5)};

 report report = tree! {Report [h1 ["CPU"],Table(data = rows),BarChart(data = rows, spec = {category:$.device,value:$.cpu})]};
 answer tree! {Answer [UseValue(ref = ctx.time_zone),Table(data = rows),UseReport(ref = report),BarChart(data = rows, spec = {category:$.device,value:$.cpu})]};`);
 const checked:any=await call('dari_check',{src:'test.dari'});assert.match(checked.text,/Succeed/);
 const receipt:any=await call('dari_submit',{src:'test.dari'});assert.match(receipt.text,/answer message/);assert.equal(messages.length,1);
 assert.equal(messages[0].source.kind,'push-to-user');assert(messages[0].source.href.startsWith('file:///'));assert.match(messages[0].source.href,/-answer.md$/);assert(!messages[0].content[0].text.includes('Asia/Shanghai'));assert.match(receipt.text,/reports\/report\/figures\/1/);const answer=saved.get(messages[0].source.href.split('/').at(-1))!;assert.match(answer,/Asia\/Shanghai/);assert.match(answer,/\| device \| cpu \|/);assert.match(answer,/\/attachments\/chart_1.svg/);assert.match(answer,/\/attachments\/report.html/);
 assert(saved.get('report.html')!.includes('<svg'));
 assert(saved.get('chart_1.svg')!.includes('dari-data'));
 writeFileSync(join(root,'invalid.dari'),'answer tree! { Answer [UseValue(data: nope)] };');
 await assert.rejects(()=>call('dari_check',{src:'invalid.dari'}),/L1:.*Node attributes use/);
 writeFileSync(join(root,'invalid.dari'),'data bad = missing;\ndata dependent = bad;\nanswer tree! {Answer [UseValue(ref = absent),UseValue(data: nope)]};');
 const beforeFiles=saved.size,beforeMessages=messages.length;
 for(const tool of ['dari_check','dari_submit'])await assert.rejects(()=>call(tool,{src:'invalid.dari'}),(error:Error)=>{
  assert.match(error.message,/CheckFailed\n-----------/);assert.match(error.message,/Unknown binding missing/);assert.match(error.message,/Unknown binding absent/);assert.match(error.message,/Node attributes use/);assert.match(error.message,/修复建议/);assert(!error.message.includes('Unknown binding bad'));return true;
 });
 assert.equal(saved.size,beforeFiles);assert.equal(messages.length,beforeMessages);
 writeFileSync(join(root,'empty.dari'),'data rows:Table(Schema({label:String,n:Int}))=table([]);answer tree! {Answer [BarChart(data = rows,spec = {category:$.label,value:$.n})]};');
 await call('dari_check',{src:'empty.dari'});
 await assert.rejects(()=>call('dari_submit',{src:'empty.dari'}),/SubmitFailed\n------------/);
 assert.equal(saved.size,beforeFiles);assert.equal(messages.length,beforeMessages);
 await assert.rejects(()=>call('dari_check',{src:'../escape.dari'}));
 console.log('DARI adapter: symbols, real database, type proof, attachments, answer delivery and diagnostics passed');
}finally{runtime.dispose();rmSync(root,{recursive:true,force:true});}
