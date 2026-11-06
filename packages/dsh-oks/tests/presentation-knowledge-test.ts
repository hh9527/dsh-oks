import {dariLiteral} from './test-dari.ts';
import { COMPONENT_KINDS } from '../src/draft/components.ts';
import { parseDraft } from '../src/draft/document.ts';
import assert from 'node:assert/strict';
import { DraftRuntime } from '../src/draft/runtime.ts';
class FixtureRuntime extends DraftRuntime { constructor(backend:ConstructorParameters<typeof DraftRuntime>[0], options:ConstructorParameters<typeof DraftRuntime>[1]={}) { super(backend,{...options,parse:(source,file)=>parseDraft(source,file)}); } }
import { createDraftBackend } from '../src/draft/backend.ts';
import { checkDesign } from '../src/draft/design.ts';
import { buildSemanticGraph, resolveFact } from '../src/knowledge-graph.ts';
import { mountPresentationKnowledge, presentationExample } from '../src/presentation-knowledge.ts';
import { buildOption, CHART_WIDTH } from '../src/chart/option.ts';
import { renderEchartsSvg } from '../src/chart/echarts.ts';
import { CHART_KINDS, EXPRESSION_SUPPORT } from '../src/chart/shared.ts';
import { parseChartSpec, parseTableSpec } from '../src/chart/spec.ts';
import { tableMarkdown } from '../src/view/table.ts';
import { createSelector } from '../src/select.ts';
import type { JsonValue } from '../src/project.ts';
import type { WorkspaceEntry } from '../src/knowledge.ts';
const graph=buildSemanticGraph([]).graph;
mountPresentationKnowledge(graph);
const backend=createDraftBackend({knowledge:{executorFor(){throw new Error('Presentation examples must not execute SQL');}},entry:{} as WorkspaceEntry,file:'.work/presentation.md',contextZone:()=>({kind:'resolved',timeZone:'Asia/Shanghai'})});
try {
 const overview=createSelector('tools.render_figure.kinds:keys')(graph as unknown as JsonValue) as any;
 assert.equal(overview.tools.render_figure['kinds:keys'].length,16);
 assert.ok(overview.tools.render_figure['kinds:keys'].includes('column'));

 for(const item of graph.items)assert.ok(resolveFact(graph,item.key),item.key);
 const values={stack:'total',size:'size',bins:3,second:{value:'other'},marks:[{value:1}],donut:true,connectNulls:true,entityColor:true};
 const kinds=graph.tools.render_figure.kinds as Record<string,any>;
 assert.deepEqual(Object.keys(kinds),[...CHART_KINDS,'table']);
 for(const [kind,fact]of Object.entries(kinds)){
  const example=fact.example;
  if(kind!=='table'){
   const sizes=[8,12,18].map(labelFont=>{
    const parsed=parseChartSpec({kind,...example.spec,layout:{labelFont}});
    assert('spec' in parsed,kind);
    const built=buildOption(example.rows,parsed.spec,example.nodes);
    assert(Number.isFinite(built.height)&&built.height>0,kind);
    assert.match(renderEchartsSvg(built.option,CHART_WIDTH,built.height),/<svg/);
    return built.height;
   });
   assert(sizes[0]<sizes[1]&&sizes[1]<sizes[2],`${kind}: font-driven heights ${sizes}`);
   for(const [feature,value]of Object.entries(values)){
    const spec={kind,...example.spec};for(const key of Object.keys(values))delete spec[key];spec[feature]=value;
    assert.equal('spec' in parseChartSpec(spec),(EXPRESSION_SUPPORT[feature as keyof typeof EXPRESSION_SUPPORT] as readonly string[]).includes(kind),`${kind}.${feature}`);
   }
   for(const required of fact.required){const spec={kind,...example.spec};delete spec[required];assert.ok('error' in parseChartSpec(spec),`${kind} requires ${required}`);}
  }
  const source=`data rows = table(${dariLiteral(example.rows)},{kind:"example"});
${example.nodes?`data nodes = table(${dariLiteral(example.nodes)},{kind:"example"});`:''}
data spec = ${dariLiteral(Object.fromEntries(Object.entries(example.spec).filter(([key])=>key!=="kind")))};
figure chart = tree! { ${Object.entries(COMPONENT_KINDS).find(([,value])=>value===kind)![0]}(spec = spec, data = rows${example.nodes?', nodes = nodes':''}) };
report answer = tree! { Report [ UseFigure(ref = chart), ] };`;
  const runtime=new FixtureRuntime(backend);const result=await runtime.run(source);
  assert.equal(result.status,'complete',`${kind}: ${result.error}`);
  for(const [name,output]of result.outputs)assert.ok(output.value,`${kind}/${name}: ${output.error}`);
  assert.match(runtime.read('answer',source).value.sources[0].delivery!.html!,kind==='table'?/<table>/ : /<svg/);
 }
 const runtime=new FixtureRuntime(backend);const result=await runtime.run(presentationExample);
 assert.equal(result.status,'complete',result.error ?? '');
 const html=runtime.read('full',presentationExample).value.sources[0].delivery!.html!;
 assert.match(html,/>3<\/span>/);assert.match(html,/>major<\/span>/);
 assert.match(html,/>告警级别<\/th>/);assert.match(html,/>数量<\/th>/);
 const invalid=presentationExample.replace('columns:["level","count"]','columns:[{key:"level",label:"告警级别"}]');
 const failed=await new FixtureRuntime(backend).run(invalid);
 assert.equal(failed.status,'invalid');assert.match(failed.error!,/table columns/);
 const badLabel=presentationExample.replace('labels:{level:"告警级别",count:"数量"}','labels:{missing:"告警级别"}');
 const labelCheck=await checkDesign(badLabel,'table.dari',backend);assert.equal(labelCheck.ok,false);assert(labelCheck.diagnostics.some(d=>/Missing figure columns: missing/.test(d.message)));
 const labelResult=await new FixtureRuntime(backend).run(badLabel);
 assert.equal(labelResult.status,'complete');assert.match(labelResult.outputs.get('details')!.error!,/missing/);
 for(const labels of [[],null,{level:42},{level:''}])assert.throws(()=>parseTableSpec({kind:'table',labels}),/labels/);
 const rendered=tableMarkdown([{level:'major',count:3}],{columns:['level','count'],labels:{level:'告警|级别'}});
 assert('embedded' in rendered);assert.match(rendered.embedded,/\| 告警\\\|级别 \| count \|/);
 const inherited=tableMarkdown([{constructor:1}],{});assert('embedded' in inherited);assert.match(inherited.embedded,/constructor/);
 for(const columns of [[{key:'level',label:'告警级别'}],[],['n','n'],[''],42])assert.throws(()=>parseTableSpec({kind:'table',columns}),/columns/);
 console.log('presentation knowledge: 16 executable figure examples, renderer matrix, table headers and DARI bindings passed');
}finally{}
