import {readReportPage} from './src/report/page.ts';
import {testAttachments} from './test-attachments.ts';
import { asDari } from './test-markdown.ts';
// Run against a standalone bundle + colocated Wasm, not the source module graph.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
const [bundle, model, database] = process.argv.slice(2);
assert.ok(bundle && model && database, '需要 bundle、模型和只读 SQLite 路径');
const root = mkdtempSync(join(tmpdir(), 'oks-draft-plugin-'));
writeFileSync(join(root,'oks.json'),JSON.stringify({version:1,domain:'ic',model,dataFile:database}));
const attachmentModule=process.env.OKS_ATTACHMENTS_MODULE;
const attachments=attachmentModule?Object.assign(Object.create((await import(pathToFileURL(attachmentModule).href)).LocalAttachmentStore.prototype),{root:join(root,'attachments','v1')}):testAttachments(root);
const { apply } = await import(pathToFileURL(bundle).href);
const registered = new Map<string, any>();
const dispose: (()=>void)[] = [];
const listeners: any[] = [];
const logs: string[] = [];
const skills: any[] = [];
apply({logger:{info:(message:string)=>logs.push(message)},get:(name:string)=>name==='attachments'?attachments:name==='skills'?{register:(skill:unknown)=>{skills.push(skill);return ()=>{};}}:undefined,
  tools:{register:(tool:any)=>{registered.set(tool.name,tool);return ()=>registered.delete(tool.name);}},
  effect:(fn:()=>unknown)=>{const result=fn();if(typeof result==='function')dispose.push(result as ()=>void);},
  on:(_name:string,listener:unknown)=>{listeners.push(listener);return ()=>{};},
});
const expected=['oks_read','oks_write','oks_edit','oks_list','oks_delete','va_ask','oks_run_answer','oks_show','renew_context','oks_project'];
assert.deepEqual([...registered.keys()].sort(),expected.sort());
const session={id:'draft-plugin-test',header:{cwd:root}};
const exec={agent:{session}};
for(const listener of listeners)await listener({agent:exec.agent,messages:[{source:{kind:'user',rpcId:'test',clientTimeZone:'Asia/Shanghai'}}]},async()=>undefined);
const snapshot=process.env.OKS_VALUES_MODULE?(await import(pathToFileURL(process.env.OKS_VALUES_MODULE).href)).snapshotJsonValue:undefined;
const call=async(name:string,args:unknown)=>{
  const tool=registered.get(name);const value=await tool.execute(args,exec);
  assert.deepEqual(value,JSON.parse(JSON.stringify(value)),`${name} output must survive JSON unchanged`);
  if(snapshot)assert.notEqual(snapshot(value),undefined,`${name} must pass the running host lossless JSON validator`);
  const text=tool.output.render(args,value).map((block:any)=>block.text??'').join('');if(name==='oks_read')assert.ok(Buffer.byteLength(value.lines.map((line:any)=>line.text).join('\n'))<=50*1024,'read selected text limit');else assert.ok(Buffer.byteLength(text)<=16384,`${name} payload limit`);return {value,text};
};
const source=`<Dari title="告警概览">
<Pipeline>
ctx <-context();
months <-time_windows(ctx,{unit:"month",count:2,mode:"complete"});
facts <-exec_query(query({op:"Graph",root:"a",nodes:[{id:"a",entity:"current_alarm"}],edges:[],select:[],count:"a",limit:5}));
total <-jq("total.jq",{facts});
{total}
</Pipeline>
<Asset language="jq" name="total.jq">.facts.rows[0] | to_entries[0].value</Asset>
<Template name="answer"><article><p>当前告警数：<Value data={total} /></p></article></Template>
</Dari>`;
try {
  assert.equal(skills.length,1);
  await call('oks_write',{path:'oks://work/plan.dari',content:'<Dari><Pipeline>plan <-query({op:"Graph",root:"a",nodes:[{id:"a",entity:"current_alarm"}],edges:[],select:[],count:"a",limit:5}); {columns:plan.columns}</Pipeline></Dari>'});
  const planned=await call('oks_run_answer',{src:'oks://work/plan.dari'});
  assert.equal(planned.value.ok,true,planned.text);
  assert.equal(planned.value.acquisitions.length,0);
  assert.deepEqual((await call('oks_project',{input:'oks://work/plan.dari#plan'})).value.data,{columns:[{name:'a_count',type:'Int',nullable:false}]});
  await call('oks_write',{path:'oks://work/draft.dari',content:asDari(source)});
  let result=await call('oks_run_answer',{src:'oks://work/draft.dari'});
  assert.equal(result.value.delivery.status,'ready',result.text);
  assert.equal(result.value.delivery.mode,'retained');
  assert.equal(result.value.outputs.find((item:any)=>item.name==='facts').truncated,false);
  assert.deepEqual(result.value.outputs.find((item:any)=>item.name==='facts').columns,[{name:'a_count',type:'Int',nullable:false}]);
  assert.deepEqual((await call('oks_project',{input:'oks://work/draft.dari#facts',select:"'columns'"})).value.data.columns,[{name:'a_count',type:'Int',nullable:false}]);
  const firstBatch=result.value.batch;
  const count=(await call('oks_project',{input:'oks://work/draft.dari#total'})).value.data;
  assert.ok(typeof count==='number' && count>0);
  assert.deepEqual((await call('oks_project',{input:'oks://work/draft.dari#output'})).value.data,{total:count});
  result=await call('oks_run_answer',{src:'oks://work/draft.dari'});
  assert.equal(result.value.batch,firstBatch);
  assert.equal(result.value.counts.executed,0);
  assert.equal(result.value.delivery.status,'ready',result.text);
  const shownReport=await call('oks_show',{input:'oks://work/draft.dari#answer'});
  assert.match(shownReport.value.path,/\.report\.html$/);
  assert.match(readFileSync(shownReport.value.path,'utf8'),new RegExp(String(count)));
  const archive=readReportPage(readFileSync(shownReport.value.path,'utf8'));
  assert.ok(!('error' in archive));assert.equal(archive.version,1);assert.equal(archive.dari!.source,asDari(source));
  assert.equal(archive.context!.batch,firstBatch);assert.equal(typeof archive.context!.model!.domain,'string');
  assert.ok(archive.context!.captures.length>0);
  assert.equal((await call('oks_project',{input:'oks://work/draft.dari#answer',select:'{dari.source,context.batch}'})).value.data.dari.source,asDari(source));
  result=await call('oks_project',{input:'oks://knowledge',transform:{lib:'oks://builtin/tools/ktools.lib.jq',name:'search',args:{query:'current_alarm',take:2}}});
  assert.ok(result.value.data.total>0);
  const explore=async(name:string,args:unknown)=>(await call('oks_project',{input:'oks://knowledge',transform:{lib:'oks://builtin/tools/ktools.lib.jq',name,args}})).value.data;
  const overview=await explore('overview',{take:2});
  assert.ok(overview.total>0&&overview.datasets.length>0);
  const card=await explore('card',{id:'current_alarm',section:'dimensions',take:2,docs:true});
  assert.ok(card.dimensions.length>0&&card.counts.dimensions>=card.dimensions.length);
  const nodes=await explore('nodes',{keys:['datasets/current_alarm'],mode:'both',take:2});
  assert.equal(nodes[0].key,'datasets/current_alarm');
  assert.ok(nodes[0].outline.length>0&&nodes[0].facts.length>0);
  const discovery=await explore('cap',{cq:{target:{dataset:'current_alarm'},select:[{dimension:card.dimensions[0].id}]},join_depth:0});
  assert.equal(discovery.discovery.requires_transform,true);
  assert.equal(discovery.candidate_intent.nodes[0].entity,'current_alarm');
  const sourceLibrary=(await call('oks_read',{path:'oks://builtin/tools/ktools.lib.jq'})).value;
  assert.ok(sourceLibrary.lines.some((line:any)=>line.text.includes('def search($args)')));
  await call('oks_write',{path:'oks://memory/tools/ktools.lib.jq',content:'def schema_counts($args): . | {datasets:(.datasets|length),types:(.types|length)};'});
  const counts=(await call('oks_project',{input:'oks://knowledge',transform:{lib:'oks://memory/tools/ktools.lib.jq',name:'schema_counts',args:{}}})).value.data;
  assert.ok(counts.datasets>0&&counts.types>0);
  await assert.rejects(call('oks_edit',{path:'oks://memory/tools/ktools.lib.jq',old_string:'. |',new_string:'missing_function'}),/missing_function/);
  assert.deepEqual((await call('oks_project',{input:'oks://knowledge',transform:{lib:'oks://memory/tools/ktools.lib.jq',name:'schema_counts',args:{}}})).value.data,counts);
  assert.ok((await call('oks_list',{})).value.files.some((file:any)=>file.name==='oks://memory/tools/ktools.lib.jq'));
  result=await call('oks_project',{input:'oks://knowledge',select:'datasets.current_alarm.fields:keys'});
  assert.ok(Array.isArray(result.value.data.datasets.current_alarm['fields:keys']));
  const months=(await call('oks_project',{input:'oks://work/draft.dari#months'})).value.data;
  assert.equal(months.length,2);
  assert.match(months[1].end.rfc3339,/T00:00:00\+08:00$/);
  const help=(await call('oks_read',{path:'oks://help/query.md',limit:2000})).value;
  assert.match(help.lines.map((line:any)=>line.text).join('\n'),/ontology-intent-v1/);
  await assert.rejects(call('oks_project',{input:'oks://help/query.md'}),/Unknown structured resource/);
  await call('oks_edit',{path:'oks://work/draft.dari',old_string:'当前告警数：',new_string:'当前告警总数：'});
  result=await call('oks_project',{input:'oks://work/draft.dari#total'});
  assert.equal(result.value.stale,true);
  result=await call('oks_run_answer',{src:'oks://work/draft.dari'});
  assert.equal(result.value.delivery.status,'ready',result.text);
  assert.equal(result.value.counts.executed,1,'仅模板修改重新渲染 Report');
  result=await call('oks_run_answer',{src:'oks://work/draft.dari',refresh:true});
  assert.notEqual(result.value.batch,firstBatch);
  assert.equal(result.value.delivery.status,'ready',result.text);
  const renewed=(await call('renew_context',{src:'oks://work/draft.dari'})).value;
  result=await call('oks_run_answer',{src:'oks://work/draft.dari'});
  assert.equal(result.value.batch,renewed.batch);
  assert.equal(result.value.delivery.status,'ready',result.text);
  const example=readFileSync(new URL('./examples/answer.dari',import.meta.url),'utf8');
  await call('oks_write',{path:'oks://work/example.dari',content:asDari(example)});
  result=await call('oks_run_answer',{src:'oks://work/example.dari'});
  assert.equal(result.value.delivery.status,'ready',result.text);
  assert.equal(result.value.delivery.input,'oks://work/example.dari#reports.conclusion');
  if(attachments){
    const shown=await call('oks_show',{input:'oks://work/example.dari#figures.comparison'});
    assert.match(shown.value.attachment.attachmentId,/^sha256:/);assert.match(shown.value.path,/attachments\/v1\//);
    assert.match(shown.value.markdown,/^!\[/);assert.match(readFileSync(shown.value.path,'utf8'),/<svg/);
    const blocks=registered.get('oks_show').output.render({},shown.value);
    assert.equal(blocks[1].type,'file');assert.deepEqual(blocks[1].attachment,shown.value.attachment);
    assert.ok(!shown.text.includes('<svg'));assert.ok(Buffer.byteLength(shown.text)<2000);
    assert.deepEqual((await call('oks_show',{input:'oks://work/example.dari#figures.comparison'})).value.attachment,shown.value.attachment);
    const report=await call('oks_show',{input:'oks://work/example.dari#reports.conclusion'});
    assert.match(readFileSync(report.value.path,'utf8'),/合计/);assert.equal(report.value.markdown,undefined);assert.deepEqual(report.value.present,{files:[{path:report.value.path,description:report.value.title}]});
    await call('oks_delete',{path:'oks://work/example.dari'});
    assert.match(readFileSync(shown.value.path,'utf8'),/<svg/,'attachment survives source deletion');
    await call('oks_write',{path:'oks://work/example.dari',content:example});
  }
  result=await call('oks_run_answer',{src:'oks://work/example.dari'});
  assert.equal(result.value.delivery.status,'ready',result.text);
  const exampleReport=(await call('oks_project',{input:'oks://work/example.dari#reports.conclusion'})).value.data;
  assert.equal(exampleReport.dari.values["summary.rows"],2);assert.equal(exampleReport.dari.values["summary.total"],5);
  const columnSource=['## pipeline','```js',
    'epoch <-exec_query(query({op:"Graph",root:"x",nodes:[{id:"x",entity:"device"}],edges:[],select:[{node:"x",dimension:"device_create_ms"}],limit:1}));',
    'utc <-exec_query(query({op:"Graph",root:"x",nodes:[{id:"x",entity:"device_kpi"}],edges:[],select:[{node:"x",dimension:"device_kpi_ts_raw"}],limit:1}));',
    'cpu <-exec_query(query({op:"Graph",root:"x",nodes:[{id:"x",entity:"device_kpi"}],edges:[],select:[],measures:[{node:"x",measure:"cpu_usage"}],limit:1}));',
    '{columns:epoch.columns}','```'].join('\n');
  await call('oks_write',{path:'oks://work/columns.dari',content:asDari(columnSource)});
  const typed=await call('oks_run_answer',{src:'oks://work/columns.dari'});
  assert.equal(typed.value.ok,true,typed.text);
  for(const [binding,type] of [['epoch','EpochMillis'],['utc','DateTimeUtc'],['cpu','Float']]) {
    const columns=(await call('oks_project',{input:'oks://work/columns.dari#'+binding,select:"'columns'"})).value.data.columns;
    assert.equal(columns[0].type,type);
    const data=(await call('oks_project',{input:'oks://work/columns.dari#'+binding})).value.data;
    assert.equal(data.truncated,binding!=='cpu');
    assert.equal(data.rows.length,1);
    assert.equal(typed.value.outputs.find((item:any)=>item.name===binding).truncated,binding!=='cpu');
    assert.equal(typed.value.outputs.find((item:any)=>item.name===binding).columns[0].type,type);
  }
  assert.equal((await call('oks_project',{input:'oks://work/columns.dari#output'})).value.data.columns[0].type,'EpochMillis');
  await call('oks_project',{input:'oks://work/columns.dari#output'});
  await call('oks_project',{input:'oks://work/columns.dari#meta.epoch'});
  await call('oks_write',{path:'oks://work/validation.dari',content:'<Dari><Pipeline>rows <-missing;</Pipeline><Asset language="jq" name="one.jq">missing_one</Asset><Asset language="jq" name="two.jq">missing_two</Asset><Figures><ColumnChart name="bad" data={rows}/></Figures><Report name="bad"><article onclick="bad"><p>invalid</p></article></Report></Dari>'});
  const invalid=await call('oks_run_answer',{src:'oks://work/validation.dari'});assert.equal(invalid.value.status,'invalid');assert.equal(invalid.value.counts.executed,0);
  const validationDiagnostics=(await call('oks_project',{input:invalid.value.diagnosticsInput,select:'[0:100]'})).value;
  assert.ok(validationDiagnostics.data.some((d:any)=>d.stage==='pipeline'));
  for(const asset of ['one.jq','two.jq','figures.bad','reports.bad'])assert.ok(validationDiagnostics.data.some((d:any)=>d.asset===asset),asset);
  assert.equal(existsSync(join(root,'.oks')),false,'query/render/export must not create internal disk storage');
  console.log(JSON.stringify({ok:true,tools:[...registered.keys()],businessCount:count,standaloneBundle:true,sourceDatabaseReadOnly:true}));
} finally {for(const fn of dispose.reverse())fn();rmSync(root,{recursive:true,force:true});}
