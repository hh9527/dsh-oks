import assert from 'node:assert/strict';
import { parseDraft } from './src/draft/document.ts';
import { DraftRuntime } from './src/draft/runtime.ts';
import { createDraftBackend } from './src/draft/backend.ts';
import { readReportPage } from './src/report/page.ts';
import { SourceFile } from './src/draft/source.ts';
import type { WorkspaceEntry } from './src/knowledge.ts';
const file='中文😀.dari';
let queries=0;
const runtime=new DraftRuntime(createDraftBackend({entry:{} as WorkspaceEntry,file,contextZone:()=>({kind:'resolved',timeZone:'UTC'}),knowledge:{executorFor(){queries++;throw new Error('No SQL expected');}}}),{file});
const draft=(body:string)=>`<Dari title="分析 &amp; 复核"><Pipeline>value <-data("&lt;script&gt; &amp; \\\"quoted\\\"");</Pipeline><Report name="answer"><article>${body}</article></Report></Dari>`;
try {
  for(const [body,expected] of [
    ['<script>alert(1)</script>',/Unsupported report element/],
    ['<p onclick="x">内容</p>',/Unsupported report attribute/],
    ['<a href="javascript:alert(1)">打开</a>',/Unsupported link/],
    ['<div id="same"/><p id="same"/>',/unique/],
    ['<table><tr><td colspan="0">内容</td></tr></table>',/positive integer/],
    ['<table><tr><th scope="bad">内容</th></tr></table>',/Invalid scope/],
    ['<p>&nbsp;</p>',/Invalid entity/],
    ['<p>&#0;</p>',/Invalid entity/],
    ['<p>\u0001</p>',/Invalid character/],
    ['<br>',/Expected|Missing/],
    ['<br></br>',/self-closing/],
    ['<!-- bad--comment -->',/Invalid report comment/],
  ] as const)assert.throws(()=>parseDraft(draft(body),file),expected);
  for(const code of ['answer <-render_html("a.xhtml",{});','answer <-render_report("a",{});']){
    assert.throws(()=>parseDraft(`<Dari><Pipeline>${code}</Pipeline></Dari>`,file),/Unknown operator/);
  }
  assert.throws(()=>parseDraft('<Dari><Pipeline></Pipeline><Asset name="a.xhtml" language="xhtml"><article/></Asset></Dari>',file),/sql/);
  const body='<!-- 保留意图 --><h2>概览 &amp; 趋势</h2><p title="&quot;安全&quot; &amp;">&lt;字面量&gt; &#x1f600; &#123;文本} <Value data={value}/></p><p data-oks-shrink>完整结论</p><a href="https://example.com/?a=1&amp;b=2">链接</a><br/>';
  const source=draft(body);
  const run=await runtime.run(source);assert.equal(run.status,'complete',run.error);
  const html=runtime.read('reports.answer',source).value.sources[0].delivery!.html;
  assert.match(html,/<title>分析 &amp; 复核<\/title>/);
  assert.match(html,/<h2 id="section-1">概览 &amp; 趋势<\/h2>/);
  assert.match(html,/href="#section-1"/);
  assert.match(html,/title="&quot;安全&quot; &amp;"/);
  assert.match(html,/&lt;字面量&gt; 😀 \{文本}/);
  assert.match(html,/&amp;lt;script&amp;gt; &amp;amp;/,'pipeline data is literal text, not markup or entities');
  assert.match(html,/<!-- 保留意图 -->/);assert.match(html,/data-oks-shrink="">完整结论/);
  const archive=readReportPage(html);assert.ok(!('error' in archive));
  assert.equal(archive.dari.title,'分析 & 复核');assert.equal(archive.dari.values.value,'&lt;script&gt; &amp; "quoted"');
  for(const raw of ['坏 &nbsp;','坏 \u0001']){
    const source=draft(`<p>中文😀\r\n${raw}</p>`);
    const result=await runtime.run(source);assert.equal(result.status,'invalid');
    const offset=source.indexOf(raw)+(raw.indexOf('&')>=0?raw.indexOf('&'):raw.indexOf('\u0001'));
    assert.deepEqual(result.diagnostics![0].span.start,new SourceFile(file,source).position(offset));
  }
  const badAttr=draft('<p title="中文😀 &bogus;">正文</p>');
  const attrRun=await runtime.run(badAttr);assert.equal(attrRun.status,'invalid');
  assert.equal(attrRun.diagnostics![0].span.start.offset,badAttr.indexOf('&bogus;'));
  const badQuery=draft('<a href="file:///bad">bad</a>').replace('value <-data','facts <-exec_query(query({limit:1})); value <-data');
  assert.equal((await runtime.run(badQuery)).status,'invalid');assert.equal(queries,0,'report compilation gates all execution');
  console.log('DARI native reports: sole entry, structural validation, escaping, metadata, original source spans and execution gating passed');
} finally {runtime.dispose();}
