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
const source=(binding:string,body:string,extra='')=>[
  '# 负荷视图','## pipeline','```js',
  `let fact=data(${JSON.stringify(payload)});`,binding,extra,
  'let answer=render_html("answer.xhtml",{selected});','```','## assets',
  '```xhtml name="answer.xhtml"',body,'```',
].join('\n');
try {
  mkdirSync(join(root,'.work'));
  assert.deepEqual(tools.map(tool=>tool.name).sort(),['oks_data','oks_run_answer','oks_show','renew_context','va_ask','oks_delete','oks_edit','oks_list','oks_read','oks_write'].sort());
  await assert.rejects(call('oks_data',{load:{knowledge:'knowledge://'}}),/Expected only/);
  await assert.rejects(call('oks_data',{input:'.work/report.md#fact',save:{name:'escape'}}),/Expected only/);
  await assert.rejects(call('oks_data',{input:'oks://knowledge',method:'.work/missing.jq#read'}),/library|method must/);
  await assert.rejects(call('oks_data',{input:'oks://knowledge',method:'../outside.jq#read'}),/library|method must/);
  assert.equal(loads,0,'非法程序路径不加载知识');
  assert.deepEqual((await call('oks_data',{input:'oks://knowledge',project:{datasets:'Value'}})).data,{datasets:document.datasets});
  await call('oks_write',{path:'oks://memory/tools/ktools.lib.jq',content:'def nil($args): null; def names($args): keys; def large($args): [range(100000)];'});
  assert.equal((await call('oks_data',{input:'oks://knowledge',method:'oks://memory/tools/ktools.lib.jq#nil'})).data,null,'合法 null 保持为完整值');
  assert.deepEqual((await call('oks_data',{input:'oks://knowledge',method:'oks://memory/tools/ktools.lib.jq#names'})).data,['datasets','items','relations','types']);
  const tooLarge=await call('oks_data',{input:'oks://knowledge',method:'oks://memory/tools/ktools.lib.jq#large'});
  assert.equal(tooLarge.ok,false);assert.deepEqual(tooLarge.shape,{type:'array',size:100000});
  assert.equal(readdirSync(root).includes('.oks'),false,'只读知识与失败不创建材料');

  await write('<Dari><Pipeline>let payload=data('+JSON.stringify(payload)+');let business=data({meta:"业务元数据",origin:"业务来源",data:9});</Pipeline></Dari>');
  await draftCall('oks_run_answer',{src:file});
  assert.deepEqual((await draftCall('oks_data',{input:file+'#payload'})).data,payload);
  assert.equal((await draftCall('oks_data',{input:file+'#payload',pointer:'/rows/0/count'})).data,7);
  assert.equal((await draftCall('oks_data',{input:file+'#business',pointer:'/data'})).data,9);
  assert.ok((await draftCall('oks_data',{input:file+'#payload',meta:true})).data.sources.length>0);
  for(const input of ['.oks/data/old.def.json','.oks/figures/old.pie.svg','artifacts/old.report.html'])await assert.rejects(call('oks_data',{input}),/Unknown structured resource/);
  const largeRows=Array.from({length:200},(_,i)=>({i,label:'x'.repeat(150)}));
  await write('<Dari><Pipeline>let large=data('+JSON.stringify(largeRows)+');</Pipeline></Dari>');await draftCall('oks_run_answer',{src:file});
  const args={input:file+'#large'};
  const full=await draftCall('oks_data',args);assert.deepEqual(full.data,largeRows);
  const rendered=render('oks_data',args,full);assert.ok(Buffer.byteLength(rendered)<=16384);assert.match(rendered,/payload_too_large/);
  const page=await draftCall('oks_data',{...args,offset:2,limit:3});assert.deepEqual(page.data,largeRows.slice(2,5));assert.equal(page.range.next,5);

  for(const [binding,expected,pick] of [
    ['let selected=fact;',payload,'.rowCount'],
    ['let selected=fact.rows;',payload.rows,'.0.count'],
    ['let selected=fact.rows[0].count;',7,''],
  ] as const){
    const body=`<article><p>数量 <span data-oks-ref="selected"${pick?` data-oks-pick="${pick}"`:''} /></p></article>`;
    await write(source(binding,body));
    const result=await draftCall('oks_run_answer',{src:file});
    assert.equal(result.delivery.status,'ready',JSON.stringify(result));
    const html=readFileSync((await draftCall('oks_show',{input:file+'#answer'})).path,'utf8');
    const report=readReportPage(html);assert.ok(!('error' in report));
    assert.deepEqual(report.items.selected,expected);
    const visible={data:report};
    assert.deepEqual(visible.data.items.selected,expected,'持久化读视图与报告归档负荷一致');
    assert.ok(Object.values(report.origin.nodes).some(node=>node.kind==='input' && node.nature==='given'));
  }
  const conclusion='这是完整保留在最终报告中的结论内容，用于确认读取视图仅保留摘要而页面完整展示。';
  await write(source('let selected=jq("select.jq",{fact});',`<article><p><span data-oks-ref="selected" /></p><div data-oks-shrink=""><p>${conclusion}</p><p>下一条结论。</p></div></article>`)
    +'\n```jq name="select.jq"\n.fact.rows[0].count\n```');
  const result=await draftCall('oks_run_answer',{src:file});
  assert.equal(result.delivery.status,'ready');
  const html=readFileSync((await draftCall('oks_show',{input:file+'#answer'})).path,'utf8');assert.ok(html.includes(conclusion));
  const view=readReportPage(html);
  assert.equal(view.items.selected,7);assert.ok(!view.structure.includes('下一条结论。'));
  const report=readReportPage(html);assert.ok(!('error' in report));
  assert.ok(Object.values(report.assets).some(code=>code.trim()==='.fact.rows[0].count'));
  assert.ok(Object.values(report.origin.nodes).some(node=>node.snipFile===file+'#select.jq'));
  await call('oks_delete',{path:file});
  assert.equal(readReportPage(html).items.selected,7,'源码删除后自足报告仍可读取');
  console.log('data boundary: readonly knowledge/data, budgets, pagination, projected report payloads and archived jq provenance passed');
} finally {definitions.dispose();drafts.dispose();engine.dispose();rmSync(root,{recursive:true,force:true});}
