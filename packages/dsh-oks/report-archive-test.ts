import assert from 'node:assert/strict';
import {createDraftBackend} from './src/draft/backend.ts';
import {DraftRuntime} from './src/draft/runtime.ts';
import {parseDraft} from './src/draft/document.ts';
import {readReportPage,withReportArchive,REPORT_METADATA_OPEN,REPORT_SOURCE_OPEN,REPORT_VALUES_OPEN} from './src/report/page.ts';
import {createSelector} from './src/select.ts';
import type {Knowledge,WorkspaceEntry} from './src/knowledge.ts';
let contexts=0,queries=0;
const entry={modelHash:'fixture-model',settings:{domain:'fixture'}} as WorkspaceEntry;
const knowledge={executorFor(){queries++;throw new Error('No SQL allowed');}} as unknown as Knowledge;
const backend=createDraftBackend({knowledge,entry,file:'analysis.dari',contextZone:()=>({kind:'resolved',timeZone:'Asia/Shanghai'})});
const execute=backend.execute;backend.execute=ctx=>{if(ctx.operator==='context')contexts++;return execute(ctx);};
const runtime=new DraftRuntime(backend,{file:'analysis.dari'});
const source=`<Dari title="归档测试">
<Notes>保留原始口径与注释</Notes>
<Pipeline>
// 同一问题的探索与呈现
ctx <- context();
rows <- data([{label:"甲",n:3}]);
spec <- {x:"label",value:"n"};
badSpec <- {columns:["missing"]};
</Pipeline>
<Asset language="sql" name="unused.sql">SELECT '</script>&]]>中文🙂' AS text</Asset>
<Figures>
<ColumnChart name="used" spec={spec} data={rows} />
<ColumnChart name="unused" spec={spec} data={rows} />
<Table name="bad" spec={badSpec} data={rows} />
</Figures>
<Report name="answer"><article><h1>报告</h1><p><Value data={rows[0].n}/></p><UseFigure ref="used" caption="说明"/></article></Report>
<Report name="other"><article><p>独立报告</p><Value data={ rows [ 0 ] ["n"] }/></article></Report>
</Dari>`;
const read=(current=source)=>runtime.read('reports.answer',current);
try{
 const first=await runtime.run(source);assert.equal(first.status,'complete');assert.equal(first.outputs.get('figures.bad')?.status,'failed');
 const before=contexts,retained=read(),data=retained.value.data as any;
 assert.deepEqual(Object.keys(data).sort(),['context','dari','version']);
 assert.deepEqual(data.dari.values,{'rows[0].n':3});
 assert.equal(data.context.bindings,undefined);
 assert.equal(data.version,1);assert.equal(data.context.model.hash,'fixture-model');
 assert.equal(data.context.run,first.id);assert.equal(data.context.batch,first.batch);assert.equal(data.context.sourceHash,first.sourceHash);
 assert.equal(data.context.captures.length,1);assert.deepEqual(data.context.captures[0].value,first.outputs.get('ctx')!.value!.data);
 assert.equal(data.dari.source,source);assert.equal(data.dari.notes,'保留原始口径与注释');assert.ok(data.dari.pipeline.includes('// 同一问题'));
 assert.ok(data.dari.assets['unused.sql'].includes('</script>&]]>中文🙂'));assert.equal(Object.keys(data.dari.assets).length,1);
 assert.ok(data.dari.reports.other.includes('独立报告'));
 assert.equal(data.dari.figures.unused.code,'<ColumnChart name="unused" spec={spec} data={rows} />');
 assert.deepEqual(data.dari.figures.unused.data.rows,[{label:'甲',n:3}]);
 assert.equal(data.dari.figures.bad.status,'failed');assert.match(data.dari.figures.bad.error,/missing/);assert.equal(data.dari.figures.bad.data,undefined);
 const page=retained.value.sources[0].delivery!.html,parsed=readReportPage(page);assert.ok(!('error' in parsed));
 assert.equal(parsed.source,data.dari.source);assert.deepEqual(parsed.context,data.context);
 assert.equal(Object.keys(parsed.values).length,2,'only the scalar and figure used by this report');assert.equal(parsed.values['rows[0].n'],3);
 assert(!Object.keys(parsed.values).some(k=>k.includes('unused')||k.includes('bad')));
 assert.equal((page.match(/id="dari-source"/g)||[]).length,1);assert.equal((page.match(/id="dari-context"/g)||[]).length,1);assert.equal((page.match(/id="dari-values"/g)||[]).length,1);
 assert.deepEqual(parseDraft(parsed.source).authoring,parseDraft(source).authoring);
 assert.equal(queries,0);assert.equal(contexts,before);assert.equal(read().value.sources[0].delivery!.html,page);
 assert.equal((runtime.read('reports.other',source).value.data as any).context.run,first.id);
 const projection=createSelector('{context.{batch,captures},dari.figures.unused.data.rows}')(data) as any;
 assert.deepEqual(projection.dari.figures.unused.data.rows,[{label:'甲',n:3}]);
 const changed=source.replace('保留原始口径与注释','新的口径');assert.equal(read(changed).stale,true);assert.equal((read(changed).value.data as any).dari.source,source);
 const second=await runtime.run(changed),reused=read(changed).value.data as any;assert.equal(contexts,before);
 assert.equal(reused.dari.source,changed);assert.equal(reused.context.run,second.id);assert.equal(reused.context.batch,first.batch);
 assert.deepEqual(reused.context.captures[0].value,data.context.captures[0].value);
 assert.ok(reused.context.acquisitions.some((a:any)=>a.operator==='context'&&a.status==='cached'&&a.fromRun===first.id));
 const third=await runtime.run(changed,{refresh:true});assert.notEqual(third.batch,first.batch);assert.equal(contexts,before+1);
 assert.equal((read(changed).value.data as any).context.batch,third.batch);
 const noClock=source.replace('ctx <- context();','');await runtime.run(noClock);assert.deepEqual((read(noClock).value.data as any).context.captures,[]);
 assert.ok(page.includes(REPORT_METADATA_OPEN));
 assert.equal(parsed.source,first.archive!.dari.source);assert(!page.includes('oks-metadata'));assert(page.includes(REPORT_SOURCE_OPEN));assert(page.includes(REPORT_VALUES_OPEN));assert(!JSON.stringify(parsed.values).includes('unused.sql'));
 const malformedBody=page.slice(0,page.indexOf('</head>'))+'</head><body><not-xml> & 未闭合';
 assert.deepEqual(readReportPage(malformedBody),parsed,'回读不解析 HTML 正文');
 assert.deepEqual(readReportPage(withReportArchive(malformedBody,first.archive!,parsed.values)),parsed);
 assert.match((readReportPage('<html/>') as {error:string}).error,/元数据/);
 assert.match((readReportPage(REPORT_METADATA_OPEN+'{}') as {error:string}).error,/完整/);
 assert.match((readReportPage(page.replace(/(<script type="application\/json" id="dari-context">)[\s\S]*?<\/script>/,'$1invalid</script>')) as {error:string}).error,/JSON/);
 assert.match((readReportPage(page.replace(/(<script type="application\/json" id="dari-context">)[\s\S]*?<\/script>/,'$1null</script>')) as {error:string}).error,/对象/);
 assert.throws(()=>withReportArchive('<html/>',first.archive!),/元数据/);
 const invalidPage=withReportArchive(page,{...first.archive!,version:2} as any);
 assert.match((readReportPage(invalidPage) as {error:string}).error,/版本/);
 const failedReference=source.replace('<p>独立报告</p><Value data={ rows [ 0 ] ["n"] }/>','<UseFigure ref="bad"/>');
 const failedRun=await runtime.run(failedReference);assert.equal(failedRun.status,'complete',failedRun.error);
 assert.equal(failedRun.outputs.get('reports.other')?.status,'blocked');
 assert.equal((runtime.read('reports.answer',failedReference).value.data as any).dari.figures.bad.status,'failed');
 const huge=source.replace('保留原始口径与注释','长'.repeat(40000)),limited=new DraftRuntime(backend,{maxOutputBytes:120000});
 const over=await limited.run(huge);assert.equal(over.archive,undefined);assert.match(over.outputs.get('reports.other')!.error!,/budget/);
 assert.throws(()=>limited.read('reports.other',huge),/budget/);limited.dispose();
 console.log('报告归档：整稿恢复、全部资产和图表、失败分支、上下文缓存与刷新、固定标记回读、安全转义、投影及预算通过');
}finally{runtime.dispose();}
