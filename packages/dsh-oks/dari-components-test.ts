import assert from 'node:assert/strict';
import { createDraftBackend } from './src/draft/backend.ts';
import { DraftRuntime } from './src/draft/runtime.ts';
import { parseDraft } from './src/draft/document.ts';
import { COMPONENT_KINDS } from './src/draft/components.ts';
import { CHART_KINDS } from './src/chart/shared.ts';
import type { WorkspaceEntry } from './src/knowledge.ts';
const file='.work/components.dari';
let queries=0,renders=0;
const backend=createDraftBackend({entry:{} as WorkspaceEntry,file,contextZone:()=>({kind:'resolved',timeZone:'UTC'}),knowledge:{executorFor(){queries++;throw new Error('No SQL allowed');}}});
const runtime=new DraftRuntime({...backend,execute(ctx){if(ctx.operator==='render_figure')renders++;return backend.execute(ctx);}},{file});
const figure=(component:string,id:string,caption:string)=>`<figure id="${id}" class="authored"><${component} spec={${component==='Table'?'tableSpec':'spec'}} data={rows} /><figcaption>${caption}</figcaption></figure>`;
const source=(body:string,code='')=>`<Dari><Notes>类型和编号测试</Notes><Pipeline>
rows <-data([{x:"A",n:2},{x:"B",n:3}],{kind:"example"});
spec <-{x:"x",value:"n"};tableSpec <-{columns:["x","n"]};${code}
</Pipeline><Template name="answer"><article>${body}</article></Template></Dari>`;
try{
 assert.deepEqual(Object.values(COMPONENT_KINDS).sort(),[...CHART_KINDS,'table'].sort());
 const body=figure('ColumnChart','one','类别比较')+figure('Table','table','统计明细')+figure('LineChart','two','趋势')+figure('ColumnChart','three','再次比较');
 const text=source(body);
 let run=await runtime.run(text);assert.equal(run.status,'complete',run.error);
 assert.ok([...run.outputs.values()].every(output=>output.value));
 assert.equal(renders,3,'different tags must not share a cached chart; identical tags may reuse it');
 const html=runtime.read('answer',text).value.sources[0].delivery!.html;
 const article=html.slice(html.indexOf('<article'),html.lastIndexOf('</article>')+10);
 assert.match(article,/<figure id="one" class="authored"[^>]*><svg/);
 assert.match(article,/<figcaption><span class="item-no">图 1：<\/span>类别比较/);
 assert.match(article,/<figcaption><span class="item-no">表 1：<\/span>统计明细/);
 assert.match(article,/<figcaption><span class="item-no">图 2：<\/span>趋势/);
 assert.match(article,/<figcaption><span class="item-no">图 3：<\/span>再次比较/);
 assert.match(article,/<figure id="table" class="authored table-block"/);
 assert.equal((article.match(/<figure\b/g)??[]).length,4,'no extra nested figure wrapper');
 assert.ok(article.indexOf('<svg')<article.indexOf('<figcaption>'));
 const next=text.replace('类别比较','业务比较');run=await runtime.run(next);assert.equal(renders,3,'caption edits reuse charts');
 assert.match(runtime.read('answer',next).value.sources[0].delivery!.html,/图 1：<\/span>业务比较/);
 const multi=text.replace('</Dari>','<Template name="second"><article>'+figure('ColumnChart','four','第二答案')+'</article></Template></Dari>');
 run=await runtime.run(multi);assert.deepEqual(run.answers,['answer','second']);assert.match(runtime.read('second',multi).value.sources[0].delivery!.html,/图 1：<\/span>第二答案/);
 const one=source(figure('ColumnChart','one','类别比较'));
 for(const [from,to,expected]of [
  ['<Dari>','<Report>','Dari root'],
  ['<ColumnChart','<UnknownChart','exactly one'],
  ['<ColumnChart spec={spec} data={rows} />','<ColumnChart spec={spec} data={rows}></ColumnChart>','self-closing'],
  ['<ColumnChart spec={spec} data={rows} />','<ColumnChart spec={spec} data={rows} /><Table spec={tableSpec} data={rows} />','exactly one'],
  ['<ColumnChart spec={spec} data={rows} />','<ColumnChart spec={spec} data={rows} nodes={rows} />','Unknown attribute nodes'],
  ['<figcaption>类别比较</figcaption>','<figurecaption>类别比较</figurecaption>','figcaption'],
  ['spec <-{x:', 'spec <-{kind:"column",x:','omit kind'],
  ['spec <-{x:', 'spec <-{stack:"total",x:',null],
  ['<figure id="one" class="authored">','<figure id="one" class="authored" title={spec}>','static strings'],
 ]as const){
  const result=await runtime.run(one.replace(from,to));
  if(expected===null){assert.equal(result.outputs.get('answer')?.status,'executed');continue;}
  assert.equal(result.status,'invalid',`${to}: ${result.error}`);assert.ok(result.error?.includes(expected),result.error);assert.equal(result.diagnostics?.[0].file,file);
 }
 const unsupported=await runtime.run(one.replace('ColumnChart','PieChart').replace('spec <-{x:','spec <-{stack:"total",x:'));
 assert.equal(unsupported.status,'invalid');assert.match(unsupported.error!,/stack/);
 assert.equal(queries,0);
 const stray=source('<ColumnChart spec={spec} data={rows} />');assert.throws(()=>parseDraft(stray,file),/direct child/);
 console.log('DARI components: tag kinds, caption numbering/order, IDs/classes, reply/artifact, cache identity, multiple answers and invalid specs passed');
}finally{runtime.dispose();}
