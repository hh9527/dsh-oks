import {testAttachments} from './test-attachments.ts';
import { asDari } from './test-markdown.ts';
// Public readonly/work boundary plus the real draft backend and self-contained archive codec.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createKtools } from './src/ktools.ts';
import { createJaqEngine } from './src/jaq.ts';
import { readReportPage } from './src/report/page.ts';
import { withOutputLimit } from './src/payload.ts';
import { createDraftTools } from './src/draft/tools.ts';
import { createDraftBackend } from './src/draft/backend.ts';
import type { Knowledge, WorkspaceEntry } from './src/knowledge.ts';
import type { ToolExec } from './src/host.ts';

const textImports = registerHooks({load(url, context, nextLoad) {
  return url.endsWith('.md') ? {format:'module',source:`export default ${JSON.stringify(readFileSync(new URL(url),'utf8'))}`,shortCircuit:true} : nextLoad(url,context);
}});
const {createTools} = await import('./src/tools.ts');
textImports.deregister();
const root = mkdtempSync(join(tmpdir(),'oks-data-test-'));
const engine = createJaqEngine(process.argv[2] ?? fileURLToPath(new URL('./lib/oks-wti.wasm',import.meta.url)));
const document = {datasets:{example:{fields:{name:{type:'Text'}}}},types:{},relations:{},items:[]};
const entry = {root, settings:{workspaceRoot:root,domain:'test',queryTimeoutMs:5000,
  retention:{auto:{materials:60,artifacts:60,work:null}}},modelHash:'fixture'} as WorkspaceEntry;
let loads=0;
const knowledge = {ensureWorkspace:()=>entry,ensureIndex:async()=>{loads++;return {knowledge:document};},
  queryKnowledge:(_entry,program,options)=>engine.runDocument(program,document,options)} as Knowledge;
const timeContext={zones:new Map(),install(){}};
const definitions=createTools({ktools:createKtools(engine.checkLibrary,engine.run),knowledge,log:()=>{},config:undefined,va:{ask:async()=>{throw new Error('unused');}},timeContext});
const tools=definitions.map(withOutputLimit);
const exec={agent:{session:{id:'data-test'}}} as ToolExec;
const call=(name:string,args:unknown)=>tools.find(tool=>tool.name===name)!.execute(args as never,exec) as Promise<any>;
const render=(name:string,args:unknown,value:unknown)=>tools.find(tool=>tool.name===name)!.output.render(args as never,value as never).map(block=>(block as {text:string}).text).join('');
const drafts=createDraftTools({knowledge,timeContext,
  backend:(entry,file,contextZone)=>createDraftBackend({knowledge,entry,file,contextZone,jq:engine}),
  attachments:()=>testAttachments(root),
});
const draftCall=(name:string,args:unknown)=>drafts.tools.find(tool=>tool.name===name)!.execute(args as never,exec) as Promise<any>;
const file='.work/report.dari';
const write=(content:string)=>call('oks_write',{path:file,content:asDari(content)});
const payload={rowCount:1,rows:[{name:'A',count:7}]};
const source=(binding:string,body:string,extra='')=>`<Dari title="负荷视图"><Pipeline>
fact <-data(${JSON.stringify(payload)}); ${binding} ${extra}
</Pipeline><Template name="answer">${body}</Template></Dari>`;
try {
  mkdirSync(join(root,'.work'));
  assert.deepEqual(tools.map(tool=>tool.name).sort(),['oks_project','oks_run_answer','oks_show','renew_context','va_ask','oks_delete','oks_edit','oks_list','oks_read','oks_write'].sort());
  await assert.rejects(call('oks_project',{load:{knowledge:'knowledge://'}}),/Expected only/);
  await assert.rejects(call('oks_project',{input:'.work/report.md#fact',save:{name:'escape'}}),/Expected only/);
  await assert.rejects(call('oks_project',{input:'oks://knowledge',transform:{lib:'.work/missing.jq',name:'read',args:{}}}),/library|method must/);
  await assert.rejects(call('oks_project',{input:'oks://knowledge',transform:{lib:'../outside.jq',name:'read',args:{}}}),/library|method must/);
  assert.equal(loads,0,'非法程序路径不加载知识');
  assert.deepEqual((await call('oks_project',{input:'oks://knowledge',select:'datasets'})).data,{datasets:document.datasets});
  await call('oks_write',{path:'oks://memory/tools/ktools.lib.jq',content:'def nil($args): null; def names($args): keys; def large($args): [range(100000)];'});
  assert.equal((await call('oks_project',{input:'oks://knowledge',transform:{lib:'oks://memory/tools/ktools.lib.jq',name:'nil',args:{}}})).data,null,'合法 null 保持为完整值');
  assert.deepEqual((await call('oks_project',{input:'oks://knowledge',transform:{lib:'oks://memory/tools/ktools.lib.jq',name:'names',args:{}}})).data,['datasets','items','relations','types']);
  const tooLarge=await call('oks_project',{input:'oks://knowledge',transform:{lib:'oks://memory/tools/ktools.lib.jq',name:'large',args:{}}});
  assert.equal(tooLarge.data.length,100000);
  const narrowed=await call('oks_project',{input:'oks://knowledge',transform:{lib:'oks://memory/tools/ktools.lib.jq',name:'large'},select:'[0:3]'});assert.deepEqual(narrowed.data,[0,1,2]);
  assert.equal(readdirSync(root).includes('.oks'),false,'只读知识与失败不创建材料');

  await write('<Dari><Pipeline>payload <-data('+JSON.stringify(payload)+');business <-data({meta:"业务元数据",origin:"业务来源",data:9});</Pipeline></Dari>');
  await draftCall('oks_run_answer',{src:file});
  assert.deepEqual((await draftCall('oks_project',{input:file+'#payload'})).data,payload);
  assert.equal((await draftCall('oks_project',{input:file+'#payload',select:'rows[0:1]'})).data['rows[0:1]'][0].count,7);
  assert.equal((await draftCall('oks_project',{input:file+'#business',select:"'data'"})).data.data,9);
  assert.ok((await draftCall('oks_project',{input:file+'#meta.payload'})).data.sources.length>0);
  for(const input of ['.oks/data/old.def.json','.oks/figures/old.pie.svg','artifacts/old.report.html'])await assert.rejects(call('oks_project',{input}),/Unknown structured resource/);
  const largeRows=Array.from({length:200},(_,i)=>({i,label:'x'.repeat(150)}));
  await write('<Dari><Pipeline>large <-data('+JSON.stringify(largeRows)+');</Pipeline></Dari>');await draftCall('oks_run_answer',{src:file});
  const args={input:file+'#large'};
  const full=await draftCall('oks_project',args);assert.deepEqual(full.data,largeRows);
  const rendered=render('oks_project',args,full);assert.ok(Buffer.byteLength(rendered)<=16384);assert.match(rendered,/payload_too_large/);
  const page=await draftCall('oks_project',{...args,select:'[2:5]'});assert.deepEqual(page.data,largeRows.slice(2,5));

  for(const [binding,expected,pick] of [
    ['selected <-fact;',payload,'.rowCount'],
    ['selected <-fact.rows;',payload.rows,'.0.count'],
    ['selected <-fact.rows[0].count;',7,''],
  ] as const){
    const body=`<article><p>数量 <Value data={selected${pick==='.0.count'?'[0].count':pick}} /></p></article>`;
    await write(source(binding,body));
    const result=await draftCall('oks_run_answer',{src:file});
    assert.equal(result.delivery.status,'ready',JSON.stringify(result));
    const html=readFileSync((await draftCall('oks_show',{input:file+'#answer'})).path,'utf8');
    const report=readReportPage(html);assert.ok(!('error' in report));
    assert.deepEqual(report.dari.values['selected'+(pick==='.0.count'?'[0].count':pick)],pick==='.rowCount'?1:7);
    const visible={data:report};
    assert.deepEqual(visible.data.dari.values['selected'+(pick==='.0.count'?'[0].count':pick)],pick==='.rowCount'?1:7,'持久化读视图与报告归档负荷一致');
    assert.equal(report.origin,undefined);
  }
  const conclusion='这是完整保留在最终报告中的结论内容，用于确认读取视图仅保留摘要而页面完整展示。';
  await write(source('selected <-jq("select.jq",{fact});',`<article><p><Value data={selected} /></p><div data-oks-shrink=""><p>${conclusion}</p><p>下一条结论。</p></div></article>`)
    .replace('</Dari>','<Asset name="select.jq" language="jq">.fact.rows[0].count</Asset></Dari>'));
  const result=await draftCall('oks_run_answer',{src:file});
  assert.equal(result.delivery.status,'ready');
  const html=readFileSync((await draftCall('oks_show',{input:file+'#answer'})).path,'utf8');assert.ok(html.includes(conclusion));
  const view=readReportPage(html);
  assert.equal(view.dari.values.selected,7);assert.equal(Object.hasOwn(view,'structure'),false);
  const report=readReportPage(html);assert.ok(!('error' in report));
  assert.ok(Object.values(report.dari.assets).some(code=>code.trim()==='.fact.rows[0].count'));
  assert.ok(report.dari.pipeline.includes('select.jq'));
  await call('oks_delete',{path:file});
  assert.equal(readReportPage(html).dari.values.selected,7,'源码删除后自足报告仍可读取');
  console.log('data boundary: readonly knowledge/data, budgets, pagination, projected report payloads and archived jq provenance passed');
} finally {definitions.dispose();drafts.dispose();engine.dispose();rmSync(root,{recursive:true,force:true});}
