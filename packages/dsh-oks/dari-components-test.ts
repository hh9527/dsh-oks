import assert from 'node:assert/strict';
import {createDraftBackend} from './src/draft/backend.ts';
import {DraftRuntime} from './src/draft/runtime.ts';
import {parseDraft} from './src/draft/document.ts';
import {COMPONENT_KINDS} from './src/draft/components.ts';
import {CHART_KINDS} from './src/chart/shared.ts';
import type {WorkspaceEntry} from './src/knowledge.ts';
const file='.work/components.dari';
let queries=0,renders=0;
const backend=createDraftBackend({entry:{} as WorkspaceEntry,file,contextZone:()=>({kind:'resolved',timeZone:'UTC'}),knowledge:{executorFor(){queries++;throw new Error('No SQL allowed');}}});
const runtime=new DraftRuntime({...backend,execute(ctx){if(ctx.operator==='render_figure')renders++;return backend.execute(ctx);}},{file});
const source=`data rows = table([{x:"A",n:2},{x:"B",n:3}],{kind:"example"});
figure one = tree! { ColumnChart(spec={x:"x",value:"n"},data=rows) };
figure details = tree! { Table(spec={columns:["x","n"]},data=rows) };
figure two = tree! { LineChart(spec={xType:"String",x:"x",value:"n"},data=rows) };
report answer = tree! { Report [
 p ["参见 ",FigureRef(ref=one)],
 UseFigure(ref=one,caption="类别比较"),
 UseFigure(ref=details,caption="统计明细"),
 UseFigure(ref=two,caption="趋势"),
 UseFigure(ref=one,caption="再次比较"),
] };`;
try{
 assert.deepEqual(Object.values(COMPONENT_KINDS).sort(),[...CHART_KINDS,'table'].sort());
 const run=await runtime.run(source);assert.equal(run.status,'complete',run.error);
 assert.equal(renders,3);
 const html=runtime.read('answer',source).value.sources[0].delivery!.html;
 assert.match(html,/<figure[^>]*><svg/);
 assert.match(html,/<figcaption><span class="item-no">图 1：<\/span>类别比较/);
 assert.match(html,/<figcaption><span class="item-no">表 1：<\/span>统计明细/);
 assert.match(html,/<figcaption><span class="item-no">图 2：<\/span>趋势/);
 assert.match(html,/<figcaption><span class="item-no">图 1：<\/span>再次比较/);
 assert.equal((html.match(/<figure\b/g)??[]).length,4);
 assert(html.indexOf('<svg')<html.indexOf('<figcaption>'));
 const changed=source.replace('类别比较','业务比较');await runtime.run(changed);
 assert.equal(renders,3,'caption edits reuse charts');
 assert.match(runtime.read('answer',changed).value.sources[0].delivery!.html,/业务比较/);
 const multi=source+'\nreport second = tree! { Report [UseFigure(ref=two,caption="第二答案")] };';
 assert.deepEqual((await runtime.run(multi)).answers,['answer','second']);
 assert.match(runtime.read('second',multi).value.sources[0].delivery!.html,/图 1：<\/span>第二答案/);
 const noCaption=source.replace('ref=one,caption="类别比较"','ref=one');
 assert.equal((await runtime.run(noCaption)).status,'complete');
 const escaped=source.replace('类别比较','<b>&说明');await runtime.run(escaped);
 assert.match(runtime.read('answer',escaped).value.sources[0].delivery!.html,/&lt;b&gt;&amp;说明/);
 for(const body of ['table []','tr []','td ["x"]','th ["x"]','thead []','tbody []','tfoot []','caption []','figure []','figurecaption ["x"]','figcaption ["x"]','Figure(ref=one)'])
  assert.throws(()=>parseDraft(source+`\nreport bad = tree! { Report [${body}] };`,file),/Unsupported report element/);
 for(const [body,expected]of [
  ['UseFigure(ref=one,caption=rows)',/static strings/],
  ['UseFigure(ref=one,other="x")',/Unknown attribute/],
  ['UseFigure(ref=one) ["child"]',/self-closing/],
  ['UseFigure()',/Missing ref/],
  ['UseFigure(ref=missing)',/Undefined or forward figure/],
  ['UseFigure(ref=rows)',/figure binding/],
  ['FigureRef(ref=two)',/requires a UseFigure/],
 ] as const){
  const prefix=body.startsWith('FigureRef')?source.replace('UseFigure(ref=two,caption="趋势"),',''):source;
  assert.throws(()=>parseDraft(prefix+`\nreport bad = tree! { Report [${body}] };`,file),expected);
 }
 assert.equal(queries,0);
 console.log('UseFigure: figures/tables, captions, escaping, numbering, cache reuse, multiple reports and rejected old nodes passed');
}finally{runtime.dispose();}
