import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {parseDraft} from './src/draft/document.ts';
import {checkDesign,parseExecutableDesign} from './src/draft/design.ts';
import {createDraftBackend} from './src/draft/backend.ts';
import {DraftRuntime} from './src/draft/runtime.ts';
import {createDraftTools} from './src/draft/tools.ts';
import {testAttachments} from './test-attachments.ts';
import type {WorkspaceEntry,Knowledge} from './src/knowledge.ts';
import type {ToolExec} from './src/host.ts';
import type {TimeContext} from './src/time-context.ts';

const root=mkdtempSync('/opt/userhome/h00629578/.cache/tmp/oks-dom-');mkdirSync(join(root,'.work'));
let reads=0,approvals=0;
const columns=[{name:'name',type:'String',nullable:false},{name:'cpu',type:'Float',nullable:true}];
const entry={root,modelHash:'dom-test',settings:{domain:'test',queryMaxRows:100,requireRunApproval:true,dataFile:'fixture.sqlite'},runner:{async send(){return {ok:{accepted:true,queries:[{sql:'select name,cpu limit ?1',bindings:[10],limit_slot:0,columns}]}};}}} as unknown as WorkspaceEntry;
const knowledge={ensureWorkspace:()=>entry,executorFor(){reads++;return {manifest:null,executor:{async send(){return {columns:['name','cpu'],truncated:false,rows:[{name:'A&B <x>',cpu:30},{name:'B',cpu:null}]};},dispose(){}}};}} as unknown as Knowledge;
const backend=createDraftBackend({entry,file:'dom.dari',contextZone:()=>({kind:'resolved',timeZone:'UTC'}),knowledge});
const source=`// Immutable data, shared by independently declared figures and reports.
data facts := query({limit:10});
data winner := select_one({from:{f:facts},fields:(r)=>({name:r.f.name,cpu:r.f.cpu}),order_by:(o)=>[desc(o.cpu),asc(o.name)],limit:1});
figure cpu := BarChart(spec = {x:"name",value:"cpu"}, data = facts);
report answer := Report(title = "CPU & memory") [
 h1 [ "CPU & <memory>" ],
 p [ "首项：", Value(data = winner?.name), "; CPU：", Value(data = round(winner?.cpu, 1)), ],
 p [ "文本里的 ; } ] , // /* 不参与语法" ],
 p [ "<!--普通文本-->" ],
 p [ "版本：", Lit ["1.2"], ],
 p [ "参考 ", FigureRef(ref = cpu), ],
 figure [ Figure(ref = cpu), figcaption [ "窗口平均值" ], ],
];`;
try{
 const {presentationManuals}=await import('./src/presentation-guide.ts');
 const manual=presentationManuals()['oks://help/report.md'];assert(manual.includes('Lit'));assert(!manual.includes('data-oks-lit'));
 const doc=parseDraft(source,'dom.dari');assert.equal(doc.syntax,'dom');assert.deepEqual(doc.answers,['answer']);
 assert(doc.nodes.some(n=>n.statement.kind==='binding'&&n.statement.name==='cpu'));
 assert(!doc.assets.get('@report/answer')!.program!.NumWithoutSource.some(item=>item.snippet==='1.2'));
 assert.equal(doc.authoring!.source,source);assert.equal(doc.authoring!.figures.cpu.binding,'cpu');
 let checked=await checkDesign(source,'dom.dari',backend);assert.equal(checked.ok,true,JSON.stringify(checked));assert.equal(reads,0);
 assert.equal(checked.answer,'answer');assert.match(checked.types.winner,/Option\(/);
 assert.deepEqual(JSON.parse(JSON.stringify(checked)),checked);
 const rt=new DraftRuntime(backend,{file:'dom.dari',parse:parseExecutableDesign});
 try{
  const run=await rt.run(source);assert.equal(run.status,'complete',run.error);
  for(const [name,state]of run.outputs)assert(!['failed','blocked'].includes(state.status),name+':'+state.error);
  const report=rt.read('answer',source).value;assert.equal(report.reportValues!['winner?.name'],'A&B <x>');
  assert.equal(report.reportValues!['round(winner?.cpu, 1)'],30);
  const html=report.sources[0].delivery!.html;
  assert(html.includes('>1.2</span>'));assert(html.includes('CPU &amp; &lt;memory&gt;'));assert(html.includes('&lt;!--普通文本--&gt;'));
  assert(run.archive);assert.equal(run.archive!.dari.source,source);assert.equal(run.archive!.dari.figures.cpu.status,'executed');
  const before=reads;await rt.run('\n'+source);assert.equal(reads,before);
 }finally{rt.dispose();}
 const bad=await checkDesign(source.replace('value:"cpu"','value:"name"'),'dom.dari',backend);
 assert.equal(bad.ok,false);assert(bad.diagnostics.some(d=>/numeric|数值/.test(d.message)),JSON.stringify(bad));
 const typo=source.replace('r.f.cpu','r.f.cpux');checked=await checkDesign(typo,'dom.dari',backend);
 const error=checked.diagnostics.find(d=>d.message.includes('cpux'));assert(error,JSON.stringify(checked));assert.equal(error.span.start.line,3);
 assert.equal(typo.slice(error.span.start.offset,error.span.end.offset),'r.f.cpux');
 for(const [text,pattern]of [
  ['',/Expected data, figure or report/],
  ['export answer;',/Expected data, figure or report/],
  ['report r := Report [Lit [p ["1.2"]]];',/Lit accepts only literal text/],
  ['report r := Report [Lit(class="x") ["1.2"]];',/Unknown attribute/],
  ['report r := Report {p {"old"};};',/Node children use/],
  ['report r := Report [p ["a";"b"]];',/Expected , between child/],
  ['report r := Report [,p ["a"]];',/Expected.*name/],
  ['report r := Report [p ["a"],,];',/Expected.*name/],
  ['report r := Report [p ["a"],',/Missing \]/],
  ['data x := 1,',/Unexpected content|Expected/],
  ['data x := y;',/Undefined or forward/],
  ['data x := 1; data x := 2;',/Duplicate binding/],
  ['data x := 1; figure x := BarChart(spec={},data=x);',/Duplicate binding/],
  ['data x := 1; report x := Report [];',/Duplicate binding/],
  ['data query := 1;',/Reserved binding/],
  ['data __dom0 := 1;',/Reserved binding/],
  ['data x := 1',/Expected ";"/],
  ['data x := {a:1];',/Unmatched/],
  ['data x := 1; report r := Report [p [x],];',/Unsupported report element/],
  ['report r := Report [p ["a" "b"],];',/between child/],
  ['report r := Report [p(class="x",class="y") ["x"],];',/Duplicate attribute/],
  ['figure f := Report [];',/requires a chart/],
  ['report r := BarChart();',/requires Report/],
  ['report r := Report [figure [Figure(ref=f),],];figure f := BarChart();',/Undefined or forward figure/],
  ['data x := 1; report r := Report [figure [Figure(ref=x),],];',/figure binding/],
  ['figure f := BarChart(spec={},data=missing);',/Undefined or forward/],
  ['report r := Report [Script ["bad"],];',/Unknown DARI component/],
  ['report r := Report [p(onclick="bad") ["x"],];',/Unsupported report attribute/],
  ['report r := Report [a(href="javascript:bad") ["x"],];',/Unsupported link/],
 ] as const)assert.throws(()=>parseDraft(text,'bad.dari'),pattern,text);
 // Omitted and empty node bodies have the same leaf semantics; strings are JSON strings.
 assert.equal(parseDraft('report r := Report [h1 ["标题"],br [],p ["x",],];').answers[0],'r');
 assert.equal(parseDraft('report r := Report(title = "title" /* comment */) [p(class = "x" // comment\n) ["ok"],];').title,'title');
 assert.equal(parseDraft('/*hi*/ data x := {s:";}",a:[1,2]}; // trailing').nodes.length,1);
 const many='data items := [1,2];data qs := map(items,(x)=>query({limit:10,x:x}));';
 assert.equal((await checkDesign(many,'dom.dari',backend)).ok,true);
 const src='oks://work/test.dari',path=join(root,'.work/test.dari');writeFileSync(path,source);
 const drafts=createDraftTools({knowledge,attachments:()=>testAttachments(root),timeContext:{zones:new Map()} as TimeContext,approval:()=>({async request(){approvals++;return 'allowed-once';}})});
 const caller={callId:'dom-run',agent:{session:{id:'dom'}}} as ToolExec;
 const call=async(name:string,args:object)=>drafts.tools.find(t=>t.name===name)!.execute(args as never,caller) as Promise<any>;
 try{
  const before=reads;assert.equal((await call('oks_check',{src})).ok,true);assert.equal(reads,before);assert.equal(approvals,0);
  let result=await call('oks_resolve',{src,data:['winner'],figures:['cpu'],reports:['answer']});assert.equal(result.ok,true,JSON.stringify(result));assert.equal(approvals,1);
  assert.match(result.figures.cpu.embedded,/^!\[/);
  const artifact=(embedded:string)=>decodeURI(embedded.slice(embedded.indexOf('](')+2,-1));
  assert(readFileSync(artifact(result.reports.answer.embedded),'utf8').includes('CPU &amp;'));
  assert.deepEqual(result.data.winner,{name:'A&B <x>',cpu:30});
  assert.deepEqual(Object.keys(result.figures),['cpu']);assert.deepEqual(Object.keys(result.figures.cpu),['embedded']);assert(!JSON.stringify(result).includes('__dom'));
  writeFileSync(path,source+'\nreport other := Report(title = "其他报告") [p ["另一份"],];');
  result=await call('oks_resolve',{src,reports:['answer','other']});assert.equal(result.ok,true,JSON.stringify(result));assert.deepEqual(Object.keys(result.reports),['answer','other']);
  assert.equal(result.data,undefined);
 }finally{drafts.dispose();}
 console.log('DOM DARI: grammar, original spans, types, Option, inline attributes, escaping, scopes, charts, report archives, one-shot approval and selected report facts passed');
}finally{rmSync(root,{recursive:true,force:true});}
