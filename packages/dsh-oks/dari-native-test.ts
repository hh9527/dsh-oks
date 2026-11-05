import assert from 'node:assert/strict';
import {parseDraft} from './src/draft/document.ts';
import {DraftRuntime} from './src/draft/runtime.ts';
import {createDraftBackend} from './src/draft/backend.ts';
import {readReportPage} from './src/report/page.ts';
import type {WorkspaceEntry} from './src/knowledge.ts';
const file='中文😀.dari';
let queries=0;
const runtime=new DraftRuntime(createDraftBackend({entry:{} as WorkspaceEntry,file,contextZone:()=>({kind:'resolved',timeZone:'UTC'}),knowledge:{executorFor(){queries++;throw new Error('No SQL expected');}}}),{file});
const draft=(body:string)=>`data text = ${JSON.stringify('<script> & "quoted"')}; report full = tree! { Report(title="分析 & 复核") [${body}] };`;
try {
  for(const [body,expected] of [
    ['script ["alert"]',/Unsupported report element/],
    ['p(onclick="x") ["内容"]',/Unsupported report attribute/],
    ['a(href="javascript:alert(1)") ["打开"]',/Unsupported link/],
    ['div(id="same"),p(id="same")',/unique/],
    ['table [tr [td ["内容"]]]',/Unsupported report element/],
    ['p ["\\u0001"]',/Invalid character/],
    ['br ["not empty"]',/must be empty/],
  ] as const)assert.throws(()=>parseDraft(draft(body),file),expected);
  const body=`// 保留意图
    h2 ["概览 & 趋势"],
    p(title=${JSON.stringify('"安全" &')}) ["<字面量> 😀 {文本} ",Value(data=text)],
    p ["&nbsp;"],
    p(data-oks-shrink=True) ["完整结论"],
    a(href="https://example.com/?a=1&b=2") ["链接"],br`;
  const source=draft(body);
  const run=await runtime.run(source);assert.equal(run.status,'complete',run.error);
  const html=runtime.read('full',source).value.sources[0].delivery!.html;
  assert.match(html,/<title>分析 &amp; 复核<\/title>/);
  assert.match(html,/<h2 id="section-1">概览 &amp; 趋势<\/h2>/);
  assert.match(html,/href="#section-1"/);
  assert.match(html,/title="&quot;安全&quot; &amp;"/);
  assert.match(html,/&lt;字面量&gt; 😀 \{文本}/);
  assert.match(html,/&lt;script&gt; &amp; &quot;quoted&quot;|&lt;script&gt; &amp; "quoted"/);
  assert.match(html,/&amp;nbsp;/,'source text is literal, not entity-decoded');
  assert.match(html,/data-oks-shrink="">完整结论/);
  const archive=readReportPage(html);assert.ok(!('error' in archive));
  assert.equal(archive.source,source);assert(!('values' in archive));assert(!html.includes('id="dari-values"'));
  const badQuery=draft('a(href="file:///bad") ["bad"]').replace('data text =','data facts = query({limit:1}); data text =');
  assert.equal((await runtime.run(badQuery)).status,'invalid');assert.equal(queries,0,'report compilation gates all execution');
  console.log('DARI reports: structural validation, literal text, escaping, source archive and execution gating passed');
} finally {runtime.dispose();}
