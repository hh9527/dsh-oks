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
const { apply } = await import(pathToFileURL(bundle).href);
const registered = new Map<string, any>();
const dispose: (()=>void)[] = [];
const listeners: any[] = [];
const logs: string[] = [];
const skills: any[] = [];
apply({logger:{info:(message:string)=>logs.push(message)},get:(name:string)=>name==='skills'?{register:(skill:unknown)=>{skills.push(skill);return ()=>{};}}:undefined,
  tools:{register:(tool:any)=>{registered.set(tool.name,tool);return ()=>registered.delete(tool.name);}},
  effect:(fn:()=>unknown)=>{const result=fn();if(typeof result==='function')dispose.push(result as ()=>void);},
  on:(_name:string,listener:unknown)=>{listeners.push(listener);return ()=>{};},
});
const expected=['work_read','work_write','work_edit','work_list','work_delete','va_ask','oks_artifacts','oks_run_answer','renew_context','oks_data','oks_knowledge'];
assert.deepEqual([...registered.keys()].sort(),expected.sort());
const session={id:'draft-plugin-test',header:{cwd:root}};
const exec={agent:{session}};
for(const listener of listeners)await listener({agent:exec.agent,messages:[{source:{kind:'user',rpcId:'test',clientTimeZone:'Asia/Shanghai'}}]},async()=>undefined);
const snapshot=process.env.OKS_VALUES_MODULE?(await import(pathToFileURL(process.env.OKS_VALUES_MODULE).href)).snapshotJsonValue:undefined;
const call=async(name:string,args:unknown)=>{
  const tool=registered.get(name);const value=await tool.execute(args,exec);
  assert.deepEqual(value,JSON.parse(JSON.stringify(value)),`${name} output must survive JSON unchanged`);
  if(snapshot)assert.notEqual(snapshot(value),undefined,`${name} must pass the running host lossless JSON validator`);
  const text=tool.output.render(args,value).map((block:any)=>block.text??'').join('');assert.ok(Buffer.byteLength(text)<=16384,`${name} payload limit`);return {value,text};
};
const source=`<Dari title="告警概览">
<Pipeline>
let ctx=context();
let months=time_windows(ctx,{unit:"month",count:2,mode:"complete"});
let facts=exec_query(query({op:"Graph",root:"a",nodes:[{id:"a",entity:"current_alarm"}],edges:[],select:[],count:"a",limit:5}));
let total=jq("total.jq",{facts});
debug(total);
</Pipeline>
<Asset language="jq" name="total.jq">.facts.rows[0] | to_entries[0].value</Asset>
<Template name="answer"><article><p>当前告警数：<Value data={total} /></p></article></Template>
</Dari>`;
try {
  assert.equal(skills.length,1);
  await call('work_write',{file_path:'.work/plan.dari',content:'<Dari><Pipeline>let plan=query({op:"Graph",root:"a",nodes:[{id:"a",entity:"current_alarm"}],edges:[],select:[],count:"a",limit:5}); debug(plan.columns);</Pipeline></Dari>'});
  const planned=await call('oks_run_answer',{src:'.work/plan.dari'});
  assert.equal(planned.value.ok,true,planned.text);
  assert.equal(planned.value.acquisitions.length,0);
  assert.deepEqual((await call('oks_data',{input:'.work/plan.dari#plan'})).value.data,{columns:[{name:'a_count',type:'Int',nullable:false}]});
  await call('work_write',{file_path:'.work/draft.dari',content:asDari(source)});
  let result=await call('oks_run_answer',{src:'.work/draft.dari'});
  assert.equal(result.value.delivery.status,'ready',result.text);
  assert.equal(result.value.delivery.mode,'reply');
  assert.match(result.text,/当前告警数/);
  assert.equal(result.value.outputs.find((item:any)=>item.name==='facts').truncated,false);
  assert.deepEqual(result.value.outputs.find((item:any)=>item.name==='facts').columns,[{name:'a_count',type:'Int',nullable:false}]);
  assert.deepEqual((await call('oks_data',{input:'.work/draft.dari#facts',pointer:'/columns'})).value.data,[{name:'a_count',type:'Int',nullable:false}]);
  const firstBatch=result.value.batch;
  const count=(await call('oks_data',{input:'.work/draft.dari#total'})).value.data;
  assert.ok(typeof count==='number' && count>0);
  result=await call('oks_run_answer',{src:'.work/draft.dari',delivery:'artifact'});
  assert.equal(result.value.batch,firstBatch);
  assert.equal(result.value.counts.executed,0);
  assert.equal(result.value.delivery.status,'ready',result.text);
  assert.ok(existsSync(join(root,result.value.delivery.asset)));
  const asset=result.value.delivery.asset;
  result=await call('oks_data',{input:asset});
  assert.equal(result.value.data.items.value_1,count);
  result=await call('oks_knowledge',{jq:{src:'builtin://knowledge/search.jq',args:{query:'current_alarm',take:2}}});
  assert.ok(result.value.data.total>0);
  result=await call('oks_knowledge',{project:{datasets:{current_alarm:{fields:'Shape'}}}});
  assert.equal(result.value.data.datasets.current_alarm.fields.type,'object');
  const months=(await call('oks_data',{input:'.work/draft.dari#months'})).value.data;
  assert.equal(months.length,2);
  assert.match(months[1].end.rfc3339,/T00:00:00\+08:00$/);
  const topics=(await call('oks_knowledge',{help:'oks://help/query'})).value.data.topics;
  assert.ok(topics.includes('graph/filter'));
  assert.equal(typeof (await call('oks_knowledge',{help:'oks://help/query',topic:'graph/filter'})).value.data.text,'string');
  const artifacts=await call('oks_artifacts',{});
  assert.match(artifacts.text,/告警概览/);
  await call('work_edit',{file_path:'.work/draft.dari',old_string:'当前告警数：',new_string:'当前告警总数：'});
  result=await call('oks_data',{input:'.work/draft.dari#total'});
  assert.equal(result.value.stale,true);
  result=await call('oks_run_answer',{src:'.work/draft.dari'});
  assert.equal(result.value.delivery.status,'ready',result.text);
  assert.equal(result.value.counts.executed,1,'仅模板修改重新处理 render_html');
  result=await call('oks_run_answer',{src:'.work/draft.dari',refresh:true});
  assert.notEqual(result.value.batch,firstBatch);
  assert.equal(result.value.delivery.status,'ready',result.text);
  const renewed=(await call('renew_context',{src:'.work/draft.dari'})).value;
  result=await call('oks_run_answer',{src:'.work/draft.dari'});
  assert.equal(result.value.batch,renewed.batch);
  assert.equal(result.value.delivery.status,'ready',result.text);
  const example=readFileSync(new URL('./examples/answer.dari',import.meta.url),'utf8');
  await call('work_write',{file_path:'.work/example.dari',content:asDari(example)});
  result=await call('oks_run_answer',{src:'.work/example.dari'});
  assert.equal(result.value.delivery.status,'ready',result.text);
  assert.match(result.value.reply,/合计 5/);
  assert.match(result.value.reply,/!\[/,'checked-in example delivers an SVG in reply');
  result=await call('oks_run_answer',{src:'.work/example.dari',delivery:'artifact'});
  assert.equal(result.value.delivery.status,'ready',result.text);
  const exampleReport=(await call('oks_data',{input:result.value.delivery.asset})).value.data;
  assert.equal(exampleReport.items.value_1,2);assert.equal(exampleReport.items.value_2,5);
  const columnSource=['## pipeline','```js',
    'let epoch=exec_query(query({op:"Graph",root:"x",nodes:[{id:"x",entity:"device"}],edges:[],select:[{node:"x",dimension:"device_create_ms"}],limit:1}));',
    'let utc=exec_query(query({op:"Graph",root:"x",nodes:[{id:"x",entity:"device_kpi"}],edges:[],select:[{node:"x",dimension:"device_kpi_ts_raw"}],limit:1}));',
    'let cpu=exec_query(query({op:"Graph",root:"x",nodes:[{id:"x",entity:"device_kpi"}],edges:[],select:[],measures:[{node:"x",measure:"cpu_usage"}],limit:1}));',
    'debug(epoch.columns);','```'].join('\n');
  await call('work_write',{file_path:'.work/columns.dari',content:asDari(columnSource)});
  const typed=await call('oks_run_answer',{src:'.work/columns.dari'});
  assert.equal(typed.value.ok,true,typed.text);
  for(const [binding,type] of [['epoch','EpochMillis'],['utc','DatetimeUtc'],['cpu','Float']]) {
    const columns=(await call('oks_data',{input:'.work/columns.dari#'+binding,pointer:'/columns'})).value.data;
    assert.equal(columns[0].type,type);
    const data=(await call('oks_data',{input:'.work/columns.dari#'+binding})).value.data;
    assert.equal(data.truncated,binding!=='cpu');
    assert.equal(data.rows.length,1);
    assert.equal(typed.value.outputs.find((item:any)=>item.name===binding).truncated,binding!=='cpu');
    assert.equal(typed.value.outputs.find((item:any)=>item.name===binding).columns[0].type,type);
  }
  assert.equal((await call('oks_data',{input:'.work/columns.dari#debug/1'})).value.data[0].type,'EpochMillis');
  await call('oks_data',{input:'.work/columns.dari#debug'});
  await call('oks_data',{input:'.work/columns.dari#epoch',meta:true});
  console.log(JSON.stringify({ok:true,tools:[...registered.keys()],businessCount:count,standaloneBundle:true,sourceDatabaseReadOnly:true}));
} finally {for(const fn of dispose.reverse())fn();rmSync(root,{recursive:true,force:true});}
