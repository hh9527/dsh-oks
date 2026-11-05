import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {parseDraft} from './src/draft/document.ts';
import {createDraftTools} from './src/draft/tools.ts';
import {testAttachments} from './test-attachments.ts';
const root=mkdtempSync('/opt/userhome/h00629578/.cache/tmp/dari-if-');
let executions=0,empty=false,flag:boolean|null=true;
const saved:{name:string;content:string}[]=[];
const columns=[{name:'n',type:'Int',nullable:false},{name:'flag',type:'Bool',nullable:true},{name:'label',type:'String',nullable:false}];
const entry={root,modelHash:'if-test',settings:{workspaceRoot:root,domain:'test',queryMaxRows:200},runner:{async send(){return {ok:{accepted:true,queries:[{sql:'select n,flag,label',bindings:[5],limit_slot:0,columns}]}};}}};
const knowledge={ensureWorkspace:()=>entry,executorFor:()=>({executor:{async send(){executions++;return {rows:empty?[]:[{n:42,flag,label:'cpu'}],columns:['n','flag','label'],truncated:false};},dispose(){}}})};
const exec={agent:{session:{id:'if'}}} as any;
const timeContext={zones:new Map([[exec.agent.session,{kind:'resolved',timeZone:'UTC'}]])};
const attachments=testAttachments(root);
const drafts=createDraftTools({knowledge:knowledge as any,timeContext:timeContext as any,attachments:()=>({...attachments,saveFile:async args=>{saved.push({name:args.name!,content:Buffer.from(args.data).toString()});return attachments.saveFile(args);}})});
const plain=createDraftTools({knowledge:knowledge as any,timeContext:timeContext as any});
const call=async(name:string,args:object,tools=drafts)=>tools.tools.find(t=>t.name===name)!.execute(args as never,exec) as Promise<any>;
const prefix=`data facts := query({limit:5});
data summary := select_one({from:{f:facts},fields:r=>({n:r.f.n,flag:r.f.flag}),order_by:o=>[desc(o.n)],limit:1});
figure chart := ColumnChart(spec={x:"label",value:"n"},data=facts);
report file := Report [p ["报告内容"]];
`;
let seq=0;
const run=async(body:string,tools=plain)=>{
 const src='if-'+seq+++'.dari';writeFileSync(join(root,src),prefix+body);
 const checked=await call('dari_check',{src},tools);assert.equal(checked.ok,true,JSON.stringify(checked));
 const result=await call('dari_resolve',{src,answer:true},tools);assert.equal(result.ok,true,JSON.stringify(result));return result.answer.embedded as string;
};
try{
 assert.equal(await run('answer := Answer [if (true) [p ["yes"],p ["siblings"]] else [p ["no"]]];'),'yes\n\nsiblings');
 assert.equal(await run('answer := Answer [if (false) [p ["no"]], if (false) [] else if (true) [p ["yes"]] else [p ["no"]]];'),'yes');
 assert.equal(await run('answer := Answer [ul [if (true) [li ["one"],li ["two"]], if (false) [li ["no"]] else [li ["three"]]]];'),'- one\n- two\n- three');
 assert.equal(await run('answer := Answer [p ["a",if (true) [strong ["b"]] else [em ["c"]]],pre [code [if (true) ["code"]]]];'),'a**b**\n\n```\ncode\n```');
 // Conditions use query schemas without fetching query rows during check.
 const before=executions;
 writeFileSync(join(root,'dynamic.dari'),prefix+'answer := Answer [if (summary?.flag ?? false) [p ["present"]] else [p ["empty"]]];');
 assert.equal((await call('dari_check',{src:'dynamic.dari'})).ok,true);assert.equal(executions,before);
 assert.equal((await call('dari_resolve',{src:'dynamic.dari',answer:true},plain)).answer.embedded,'present');
 // Neither unselected figures nor reports require or use the attachment service.
 assert.equal(await run('answer := Answer [if (false) [UseFigure(ref=chart),UseReport(ref=file)] else [p ["text"]]];'),'text');
 const text=await run('answer := Answer [if (true) [UseFigure(ref=chart)] else [UseReport(ref=file)]];',drafts);
 assert(text.includes('!['));assert.equal(saved.length,1);assert.equal(saved[0].name,'chart.svg');
 const reportText=await run('answer := Answer [if (false) [UseFigure(ref=chart)] else [UseReport(ref=file)]];',drafts);
 assert(reportText.includes('['));assert.equal(saved.length,2);assert.equal(saved[1].name,'file.report.html');
 const some='answer := Answer [if let Some(i) = summary [p [value(ref=i.n)], if (i.n > 0) [p ["positive"]], if let Some(flag) = i.flag [p [value(ref=flag)]]] else [p ["empty"]]];';
 assert.equal(await run(some),'42\n\npositive\n\ntrue');
 assert.equal(await run('answer := Answer [if let Some(i) = summary [p [value(ref=round(i.n / 2, 1))]] else []];'),'21');
 flag=false;
 assert.equal(await run('answer := Answer [if let Some(i) = summary [if let Some(f) = i.flag [p [value(ref=f)]] else [p ["none"]]]];'),'false');
 flag=null;
 assert.equal(await run('answer := Answer [if let Some(i) = summary [if let Some(f) = i.flag [p [value(ref=f)]] else [p ["none"]]]];'),'none');
 flag=true;
 empty=true;
 assert.equal(await run(some),'empty');
 // Inactive scoped expressions are typechecked but do not perform arithmetic at runtime.
 assert.equal(await run('answer := Answer [if let Some(i) = summary [p [value(ref=i.n / 0)]] else [p ["empty"]]];'),'empty');
 empty=false;
 assert.equal(await run('answer := Answer [if (false) [UseFigure(ref=chart)], if (true) [p [FigureRef(ref=chart)],UseFigure(ref=chart)]];',drafts).then(t=>t.slice(0,3)),'图 1');
 for(const [body,pattern]of [
  ['if (1) []',/requires Bool/],['if ("yes") []',/requires Bool/],['if (summary?.flag) []',/requires Bool/],
  ['if (false) [value(ref=summary?.missing)]',/Unknown field missing/],
  ['if (false) [p [h2 ["bad"]]]',/cannot be nested/],
  ['ul [if (false) ["bad"]]',/require li/],
  ['pre [if (false) [p ["bad"]]]',/pre accepts/],
  ['if let Some(i) = summary [value(ref=i.missing)]',/Unknown field missing/],
  ['if let Some(i) = summary [] else [value(ref=i.n)]',/Undefined or forward.*i/],
  ['if let Some(i) = summary [], value(ref=i.n)',/Undefined or forward.*i/],
  ['if let Some(facts) = summary []',/conflicting/],
  ['if let Some(chart) = summary []',/conflicting/],
  ['if let Some(i) = facts []',/requires Option|requires an Option/],
  ['if let Some(i) = summary [if (i.flag) []]',/requires Bool/],
 ] as const){
  writeFileSync(join(root,'bad.dari'),prefix+'answer := Answer ['+body+'];');
  const bad=await call('dari_check',{src:'bad.dari'});assert.equal(bad.ok,false,body);assert(pattern.test(bad.text),body+'\n'+JSON.stringify(bad));
 }
 // Branch partition changes invalidate cached presentation even if all sibling nodes are identical.
 const branchA=prefix+'answer := Answer [if (true) [p ["alpha"]] else [p ["beta"]]];';
 writeFileSync(join(root,'cache.dari'),branchA);
 assert.equal((await call('dari_resolve',{src:'cache.dari',answer:true},plain)).answer.embedded,'alpha');
 writeFileSync(join(root,'cache.dari'),prefix+'answer := Answer [if (true) [p ["alpha"],p ["beta"]] else []];');
 assert.equal((await call('dari_resolve',{src:'cache.dari',answer:true},plain)).answer.embedded,'alpha\n\nbeta');
 // HTML Report selects sibling branches too, including provenance checks on inactive text.
 writeFileSync(join(root,'report.dari'),prefix+'report shown := Report [if (false) [p ["hidden"],UseFigure(ref=chart)] else [h2 ["visible"],p [Value(data=summary?.n)]]];');
 assert.equal((await call('dari_check',{src:'report.dari'})).ok,true);
 const htmlResult=await call('dari_resolve',{src:'report.dari',answer:false,reports:['shown']});assert.equal(htmlResult.ok,true,JSON.stringify(htmlResult));
 const html=saved.at(-1)!.content;assert(html.includes('visible'));assert(!html.includes('>hidden<'));assert(!html.includes('<svg'));assert(html.includes('>42</span>'));
 writeFileSync(join(root,'provenance.dari'),'report r := Report [if (false) [p ["42"]]];');
 const provenance=parseDraft('report r := Report [if (false) [p ["42"]]];');
 assert.equal(provenance.assets.get('@report/r')!.program!.NumWithoutSource.length,1);
 console.log('DARI if: Bool types, all-branch diagnostics, sibling selection, scoped Some bindings, no inactive attachment publication, HTML and Markdown passed');
}finally{drafts.dispose();plain.dispose();rmSync(root,{recursive:true,force:true});}
