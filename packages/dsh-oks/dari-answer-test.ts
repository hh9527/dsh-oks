import {embedFigureCsv} from './src/chart/svg-data.ts';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {createDraftTools} from './src/draft/tools.ts';
import {testAttachments} from './test-attachments.ts';
const root=mkdtempSync('/opt/userhome/h00629578/.cache/tmp/dari-answer-');
let executions=0,files=0;
const saved:{name:string;content:string}[]=[];
const columns=[{name:'n',type:'Int',nullable:false},{name:'label',type:'String',nullable:false}];
const entry={root,modelHash:'answer-test',settings:{workspaceRoot:root,domain:'test',queryMaxRows:200},runner:{async send(){return {ok:{accepted:true,queries:[{sql:'select n,label',bindings:[5],limit_slot:0,columns}]}};}}};
const knowledge={ensureWorkspace:()=>entry,executorFor:()=>({executor:{async send(){executions++;return {rows:[{n:42,label:'*not emphasis* [link](x) <tag>'}],columns:['n','label'],truncated:false};},dispose(){}}})};
const exec={agent:{session:{id:'answer'}}} as any;
const timeContext={zones:new Map([[exec.agent.session,{kind:'resolved',timeZone:'UTC'}]])};
const attachments=testAttachments(root);
const drafts=createDraftTools({knowledge:knowledge as any,timeContext:timeContext as any,attachments:()=>({...attachments,saveFile:async args=>{files++;saved.push({name:args.name!,content:Buffer.from(args.data).toString()});return attachments.saveFile(args);}})});
const plain=createDraftTools({knowledge:knowledge as any,timeContext:timeContext as any});
const call=async(name:string,args:object,tools=drafts)=>tools.tools.find(t=>t.name===name)!.execute(args as never,exec) as Promise<any>;
const source=`data facts := query({limit:5});
data summary := select_one({from:{f:facts},fields:r=>({n:r.f.n,label:r.f.label}),order_by:o=>[desc(o.n)],limit:1});
figure chart := ColumnChart(spec={x:"label",value:"n"},data=facts);
answer := Answer [
    h2 ["资源概况"],
    p [strong ["数值"],"：",value(ref=summary?.n),"；",em ["说明"],"：",value(ref=summary?.label)],
    ul [li ["甲"],li ["乙"]],
    blockquote [p ["客观统计"]],
    p [code ["a\u0060b"]],
    pre [code ["hello\\nworld"]],
    p [a(href="https://example.com/a(b)") ["来源"]]
];
report file := Report [p [value(ref=summary?.n)]];
`;
try{
 writeFileSync(join(root,'answer.dari'),source);
 const checked=await call('dari_check',{src:'answer.dari'});assert.equal(checked.ok,true,JSON.stringify(checked));assert.equal(executions,0);assert.match(checked.text,/- answer: checked/);assert.match(checked.text,/- report.file: checked/);
 const result=await call('dari_resolve',{src:'answer.dari',answer:true},plain);
 assert.equal(result.ok,true,JSON.stringify(result));assert.equal(files,0);
 const text=result.answer.embedded;
 assert.match(text,/^## 资源概况/);assert(text.includes('**数值**：42；*说明*'));
 assert(text.includes('\\*not emphasis\\* \\[link\\]\\(x\\) \\<tag\\>'));
 assert(text.includes('- 甲\n- 乙'));assert(text.includes('> 客观统计'));assert(text.includes('``a`b``'));
 assert(text.includes('```\nhello\nworld\n```'));assert(text.includes('https://example.com/a%28b%29'));
 writeFileSync(join(root,'table.dari'),`data rows := table([{level:"major",n:3},{level:"minor",n:2}],{kind:"example"});
figure details := Table(spec={columns:["level","n"]},data=rows);
answer := Answer [h2 ["明细"],UseFigure(ref=details,caption="统计明细")];`);
 const tabular=await call('dari_resolve',{src:'table.dari',answer:true,figures:['details']},plain);
 assert.equal(tabular.ok,true,JSON.stringify(tabular));
 const markdown='| level | n |\n| --- | ---: |\n| major | 3 |\n| minor | 2 |\n';
 assert.equal(tabular.figures.details.embedded,markdown);
 assert(tabular.answer.embedded.includes(markdown));assert(tabular.answer.embedded.includes('统计明细'));
 assert(!tabular.answer.embedded.includes('.html'));assert.equal(files,0);
 const tableOnly=await call('dari_resolve',{src:'table.dari',answer:false,figures:['details']},plain);
 assert.equal(tableOnly.figures.details.embedded,markdown);
 const cachedTable=await call('dari_resolve',{src:'table.dari',answer:true},plain);
 assert.equal(cachedTable.counts.executed,0);assert(cachedTable.answer.embedded.includes(markdown));
 const attachedTable=await call('dari_resolve',{src:'table.dari',answer:true,figures:['details']});
 assert.equal(attachedTable.figures.details.embedded,markdown);assert.equal(files,0);
 const visual=source.replace('answer := Answer [','answer := Answer [UseFigure(ref=chart,caption="分布"),UseReport(ref=file),UseReport(ref=file),');
 // Reports must be declared before they are referenced.
 const report='report file := Report [p [value(ref=summary?.n)]];';
 writeFileSync(join(root,'visual.dari'),visual.replace(report,'').replace('answer :=',report+'\nanswer :='));
 const mixed=await call('dari_resolve',{src:'visual.dari',answer:true,reports:['file'],figures:['chart']});
 assert.equal(mixed.ok,true,JSON.stringify(mixed));assert.match(mixed.reports.file.embedded,/^\[/);assert(mixed.answer.embedded.includes('!['));assert(mixed.answer.embedded.includes(mixed.reports.file.embedded));assert.equal(files,2);
 const svg=saved.find(f=>f.name==='chart.svg')!.content;
 assert(svg.includes('<metadata id="dari-data" data-format="csv">'));
 const spec=JSON.parse(/<metadata id="dari-spec" data-format="json">([^<]*)<\/metadata>/.exec(svg)![1]);
 assert.equal(spec.kind,'column');assert.equal(spec.x,'label');assert.equal(spec.value,'n');
 assert(svg.includes('n,label\n42,*not emphasis* [link](x) &lt;tag&gt;'));
 assert(!svg.includes('SELECT')&&!svg.includes('modelHash')&&!svg.includes('sourceHash'));
 const standalone=await call('dari_resolve',{src:'visual.dari',answer:false,figures:['chart']});
 assert(standalone.ok);assert(saved.at(-1)!.content.includes('id="dari-data"'));
 const cached=await call('dari_resolve',{src:'visual.dari',answer:true});assert.equal(cached.counts.executed,0);assert(cached.answer.embedded.includes('**数值**：42；*说明*'));assert(cached.answer.embedded.includes('!['));
 const debug=await call('dari_resolve',{src:'visual.dari',answer:false,data:['summary']});assert.equal(debug.ok,true);assert(!('answer' in debug));
 for(const selection of [{reports:['answer']},{data:['answer']}]){
  const bad=await call('dari_resolve',{src:'answer.dari',answer:false,...selection});assert.equal(bad.ok,false,JSON.stringify(bad));
 }
 await assert.rejects(call('dari_resolve',{src:'answer.dari'}),/explicitly/);
 await assert.rejects(call('dari_resolve',{src:'answer.dari',answer:false}),/Select at least/);
 writeFileSync(join(root,'missing.dari'),'data n := 1;');
 await assert.rejects(call('dari_resolve',{src:'missing.dari',answer:true}),/Missing answer/);
 writeFileSync(join(root,'duplicate.dari'),source+'\nanswer := Answer [p ["duplicate"]];');
 assert.equal((await call('dari_check',{src:'duplicate.dari'})).ok,false);
 for(const [node,pattern]of [
  ['value(ref=summary)',/scalar/],['value(ref=summary?.missing)',/missing/],
  ['p(class="x") ["x"]',/cannot represent attribute/],['p [h2 ["x"]]',/cannot be nested/],
  ['a ["link"]',/requires href/],['ul ["bad"]',/require li/],['UseReport(ref=chart)',/report binding/],['UseReport(ref=missing)',/report binding/],
  ['value(ref=summary?.n) ["ignored"]',/must be empty/],
 ] as const){
  writeFileSync(join(root,'invalid.dari'),source.replace('h2 ["资源概况"]',node));
  const bad=await call('dari_check',{src:'invalid.dari'});assert.equal(bad.ok,false,node);assert(pattern.test(bad.text),JSON.stringify(bad));
 }
 const encoded=embedFigureCsv('<svg><path/></svg>',{rows:[{label:'a,"b"\n</metadata>&',missing:null,empty:''}],nodeRows:[{id:'node',weight:2}]});
 assert(encoded.includes('"a,""b""\n&lt;/metadata&gt;&amp;",,""'));
 assert(encoded.includes('<metadata id="dari-nodes" data-format="csv">\nid,weight\nnode,2\n</metadata>'));
 assert(encoded.endsWith('<path/></svg>'));
 console.log('Answer: typed zero-query checks, scalar provenance, Markdown escaping, no-attachment text, chart embedding and selection passed');
}finally{drafts.dispose();plain.dispose();rmSync(root,{recursive:true,force:true});}
