import {tmpdir} from 'node:os';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {createDraftTools} from '../src/draft/tools.ts';
import {createDraftBackend} from '../src/draft/backend.ts';
import {readReportPage} from '../src/report/page.ts';
import type {Knowledge,WorkspaceEntry} from '../src/knowledge.ts';
import type {TimeContext} from '../src/time-context.ts';
const root=mkdtempSync(join(tmpdir(),'oks-figures-'));
const file='analysis.dari',physical=join(root,file);
let queries=0,renders=0,failSave=false,saves=0;
const attachments={async saveFile({data,name}:{data:Uint8Array;name:string}){
 if(failSave)throw new Error('attachment store failed');saves++;
 const digest=createHash('sha256').update(data).digest('hex'),dir=join(root,'attachments',digest);mkdirSync(dir,{recursive:true});writeFileSync(join(dir,name),data);return {attachmentId:'sha256:'+digest,name,bytes:data.byteLength};
},fileHostPath(ref:{attachmentId:string;name:string}){return join(root,'attachments',ref.attachmentId.slice(7),ref.name);}};
const entry={root,settings:{workspaceRoot:root}} as WorkspaceEntry;
const knowledge={ensureWorkspace:()=>entry,executorFor(){queries++;throw new Error('No SQL allowed');}} as unknown as Knowledge;
const drafts=createDraftTools({knowledge,attachments:()=>attachments,timeContext:{zones:new Map()} as TimeContext,backend:(entry,file,contextZone)=>{
 const backend=createDraftBackend({knowledge,entry,file,contextZone});return {...backend,execute(ctx){if(ctx.operator==='render_figure')renders++;return backend.execute(ctx);}};
}});
const caller={agent:{session:{id:'figures'}}};
const resolve=async(exec=caller)=>drafts.tools.find(t=>t.name==='dari_resolve')!.execute({src:file} as never,exec as any) as Promise<any>;
const write=(s:string)=>writeFileSync(physical,s);
const base=`data rows = table([{level:"major",n:3},{level:"minor",n:2}],{kind:"example"});
figure severity = tree! { PieChart(spec={x:"level",value:"n",title:"级别分布"},data=rows) };
figure details = tree! { Table(spec={columns:["level","n"]},data=rows) };
`;
const links=(text:string)=>[...text.matchAll(/\]\(([^)]+)\)/g)].map(m=>decodeURI(m[1]));
try{
 write(base+'answer tree! { Answer [UseFigure(ref=severity)] };');
 const first=await resolve();assert.equal(first.ok,true,JSON.stringify(first));
 assert.equal(first.data,undefined);assert.equal(first.figures,undefined);assert.equal(first.reports,undefined);
 const image=first.answer.embedded;assert.match(image,/^!\[级别分布\]\(/);
 const imagePath=links(image)[0],original=readFileSync(imagePath,'utf8');
 assert.match(original,/<metadata id="dari-data" data-format="csv">/);assert.match(original,/<metadata id="dari-spec" data-format="json">/);assert.equal(renders,1,'unused table is not rendered');
 assert.equal((await resolve()).answer.embedded,image);assert.equal(renders,1);
 failSave=true;await assert.rejects(resolve(),/attachment store failed/);failSave=false;
 const source=base+`report overview = tree! { Report [p ["见 ",FigureRef(ref=severity)],UseFigure(ref=severity),UseFigure(ref=details),UseFigure(ref=severity)] };
report tables = tree! { Report [UseFigure(ref=details),UseFigure(ref=severity)] };
answer tree! { Answer [UseFigure(ref=severity),UseFigure(ref=severity),UseFigure(ref=details),UseReport(ref=overview),UseReport(ref=tables)] };`;
 write(source);const before=saves,result=await resolve();assert.equal(result.ok,true,JSON.stringify(result));assert.equal(renders,2);assert.equal(saves-before,3,'one chart plus two reports, published once each');
 assert(result.answer.embedded.includes('| level | n |\n'));assert.equal(result.data,undefined);
 const reportPath=links(result.answer.embedded).find(p=>p.endsWith('overview.report.html'))!;
 const archived=readFileSync(reportPath,'utf8');
 assert.match(archived,/图 1<\/span>/);assert.equal((archived.match(/图 1：/g)??[]).length,2);assert.match(archived,/表 1：/);assert.doesNotMatch(archived,/图 2：/);
 const reportData=readReportPage(archived);assert(!('error' in reportData));assert(!('values' in reportData));assert(!archived.includes('id="dari-values"'));assert(archived.includes('id="dari-data"'));
 write(base.replace('["level","n"]','["missing"]')+'answer tree! { Answer [UseFigure(ref=details)] };');
 const bad=await resolve();assert.equal(bad.ok,false);assert.equal(bad.execution,'not performed');
 write(base+`data bad = select_one({from:{r:rows},fields:r=>({n:r.r.n})});
data summary = select_one({from:{r:rows},group_by:r=>({}),fields:(g,rows)=>({n:sum(rows.r.n)})});
answer tree! { Answer [p [Value(data=summary?.n)]] };`);
 const modern=await resolve();assert.equal(modern.ok,true,JSON.stringify(modern));assert.equal(modern.answer.embedded,'5');assert.equal(modern.counts.failed,0,'unused cardinality guard is not executed');
 write('data big = '+JSON.stringify('x'.repeat(20000))+';answer tree! { Answer [p [Value(data=big)]] };');
 const large=await resolve();assert.equal(large.answer.embedded,'x'.repeat(20000));
 const tool=drafts.tools.find(t=>t.name==='dari_resolve')!;{const receipt=(tool.output.render as Function)({},large)[0].text;assert.match(receipt,/^Succeed/);assert(!receipt.includes('large.svg'),"the answer body lives in the delivered message");}
 write('data value = 42;answer tree! { Answer [p [Value(data=value)]] };');
 assert.equal((await resolve({agent:{session:{id:'other'}}})).answer.embedded,'42');
 const emptyBase='data seed = table([{label:"A",n:1}],{kind:"example"});\ndata empty = select({from:{r:seed},where:r=>r.r.n<0,fields:r=>({label:r.r.label,n:r.r.n})});\n';
 for(const component of ['BarChart','Table']){
  const spec=component==='Table'?'labels:{label:"名称"}':'x:"label",value:"n"';
  write(emptyBase+'figure f = tree! { '+component+'(spec={'+spec+'},data=empty) };answer tree! { Answer [UseFigure(ref=f)] };');
  assert.equal((await resolve()).ok,false,'empty figures reject by default');
  write(emptyBase+'figure f = tree! { '+component+'(spec={'+spec+',allowNoData:True},data=empty) };report r = tree! { Report [UseFigure(ref=f)] };answer tree! { Answer [UseFigure(ref=f),UseReport(ref=r)] };');
  const accepted=await resolve();assert.equal(accepted.ok,true,JSON.stringify(accepted));
  const embedded=accepted.answer.embedded;
  if(component==='Table'){assert.match(embedded,/名称/);assert.match(embedded,/无数据/);}else assert.match(readFileSync(links(embedded)[0],'utf8'),/无数据/);
  assert.match(readFileSync(links(embedded).find(p=>p.endsWith('.report.html'))!,'utf8'),/无数据/);
 }
 rmSync(physical);assert.equal(readFileSync(imagePath,'utf8'),original);assert.equal(readFileSync(reportPath,'utf8'),archived);
 assert.equal(queries,0);assert.equal(existsSync(join(root,'artifacts')),false);assert.equal(existsSync(join(root,'.oks')),false);
 console.log('DARI Answer delivery: shared chart dependencies, embedded data, inline tables, report links, cached computations, durable artifacts and no data selectors passed');
}finally{drafts.dispose();rmSync(root,{recursive:true,force:true});}
