import { COMPONENT_KINDS } from './src/draft/components.ts';
import { parseDraft } from './src/draft/document.ts';
import { parseMarkdownFixture } from './test-markdown.ts';
import assert from 'node:assert/strict';
import { createJaqEngine } from './src/jaq.ts';
import { DraftRuntime } from './src/draft/runtime.ts';
class FixtureRuntime extends DraftRuntime { constructor(backend:ConstructorParameters<typeof DraftRuntime>[0], options:ConstructorParameters<typeof DraftRuntime>[1]={}) { super(backend,{...options,parse:(source,file)=>source.trimStart().startsWith('<Dari')?parseDraft(source,file):parseMarkdownFixture(source)}); } }
import { createDraftBackend } from './src/draft/backend.ts';
import { buildSemanticGraph, resolveFact } from './src/knowledge-graph.ts';
import { mountPresentationKnowledge, presentationExample } from './src/presentation-knowledge.ts';
import { CHART_KINDS, EXPRESSION_SUPPORT } from './src/chart/shared.ts';
import { parseChartSpec, parseTableSpec } from './src/chart/spec.ts';
import { createProjector } from './src/project.ts';
import type { JsonValue } from './src/project.ts';
import { presentationHelp } from './src/presentation-knowledge.ts';
import { toolResource, builtinCode } from './src/knowledge-programs.ts';
import type { WorkspaceEntry } from './src/knowledge.ts';
const engine=createJaqEngine(process.argv[2] ?? './lib/oks-wti.wasm');
const graph=buildSemanticGraph([]).graph;
mountPresentationKnowledge(graph);
const backend=createDraftBackend({knowledge:{executorFor(){throw new Error('Presentation examples must not execute SQL');}},entry:{} as WorkspaceEntry,file:'.work/presentation.md',contextZone:()=>({kind:'resolved',timeZone:'Asia/Shanghai'}),jq:engine});
try {
 const run=async(name:string,args:Record<string,unknown>)=>{
  const code=builtinCode(`builtin://knowledge/${name}.jq`,args);
  const result=await engine.run(code.text,{input:{knowledge:graph},timeoutMs:5000,maxBytes:16384});
  assert.equal(result.ok,true);return (result as any).data;
 };
 const overview=createProjector(presentationHelp.kinds.project as any)(graph as unknown as JsonValue) as any;
 assert.equal(Object.keys(overview.tools.render_figure.kinds).length,14);
 assert.equal(overview.tools.render_figure.kinds.column.example,undefined);
 for(const alias of ['render','figure','answer','draft'])assert.deepEqual(toolResource(`oks://help/${alias}`),presentationHelp);
 for(const item of graph.items)assert.ok(resolveFact(graph,item.key),item.key);
 for(const word of ['图表','表头','XHTML','stack','series','data-oks-pick'])assert.ok((await run('search',{query:word})).total>0,word);
 const members=await run('members',{key:'tools/render_figure',link:'kinds',take:10});
 assert.equal(members.total,14);assert.equal(members.next,10);
 assert.equal((await run('members',{key:'tools/render_figure',link:'kinds',skip:10})).items.length,4);
 assert.ok(members.items.every((item:any)=>item.type==='FigureKind'));
 assert.equal((await run('search',{type:'Tool'})).total,2);
 assert.ok((await run('references',{key:'tools/render_figure#kinds/column'})).items.some((item:any)=>item.key==='tools/render_figure'&&item.link==='kinds'));
 assert.equal((await run('members',{key:'tools/render_figure#kinds/column',link:'tools'})).items[0].key,'tools/render_figure');
 const read=await run('read',{key:'tools/render_figure#kinds/column'});
 assert.ok((await run('members',{key:'tools/render_figure#kinds/column',link:'related.topics'})).items.some((item:any)=>item.key==='tools/render_figure#topics/switches'));
 assert.ok((await run('members',{key:'tools/render_figure#topics/table_headers',link:'referenced_by.kinds'})).items.some((item:any)=>item.key==='tools/render_figure#kinds/table'));
 assert.equal(read.items.length,1);assert.equal(read.facts.topics,undefined);
 assert.ok(Buffer.byteLength(JSON.stringify(read))<2048);
 const values={stack:'total',size:'size',bins:3,second:{value:'other'},marks:[{value:1}],donut:true,connectNulls:true,entityColor:true};
 const kinds=graph.tools.render_figure.kinds as Record<string,any>;
 assert.deepEqual(Object.keys(kinds),[...CHART_KINDS,'table']);
 for(const [kind,fact]of Object.entries(kinds)){
  const example=fact.example;
  if(kind!=='table'){
   for(const [feature,value]of Object.entries(values)){
    const spec={kind,...example.spec};for(const key of Object.keys(values))delete spec[key];spec[feature]=value;
    assert.equal('spec' in parseChartSpec(spec),(EXPRESSION_SUPPORT[feature as keyof typeof EXPRESSION_SUPPORT] as readonly string[]).includes(kind),`${kind}.${feature}`);
   }
   for(const required of fact.required){const spec={kind,...example.spec};delete spec[required];assert.ok('error' in parseChartSpec(spec),`${kind} requires ${required}`);}
  }
  const source=`<Dari><Pipeline>
let rows=data(${JSON.stringify(example.rows)},{kind:"example"});
${example.nodes?`let nodes=data(${JSON.stringify(example.nodes)},{kind:"example"});`:''}
let spec=${JSON.stringify(Object.fromEntries(Object.entries(example.spec).filter(([key])=>key!=="kind")))};
</Pipeline><Template name="answer"><article><figure><${Object.entries(COMPONENT_KINDS).find(([,value])=>value===kind)![0]} spec={spec} data={rows}${example.nodes?' nodes={nodes}':''} /></figure></article></Template></Dari>`;
  const runtime=new FixtureRuntime(backend);const result=await runtime.run(source);
  assert.equal(result.status,'complete',`${kind}: ${result.error}`);
  for(const [name,output]of result.outputs)assert.ok(output.value,`${kind}/${name}: ${output.error}`);
  assert.match(runtime.read('answer',source).value.sources[0].delivery!.html,kind==='table'?/<table>/ : /<svg/);
 }
 const runtime=new FixtureRuntime(backend);const result=await runtime.run(presentationExample);
 assert.equal(result.status,'complete',result.error);
 const html=runtime.read('reports.answer',presentationExample).value.sources[0].delivery!.html;
 assert.match(html,/>3<\/span>/);assert.match(html,/>major<\/span>/);
 assert.match(html,/>告警级别<\/th>/);assert.match(html,/>数量<\/th>/);
 const invalid=presentationExample.replace('columns:["告警级别","数量"]','columns:[{key:"level",label:"告警级别"}]');
 const failed=await new FixtureRuntime(backend).run(invalid);
 assert.equal(failed.status,'invalid');assert.match(failed.error!,/rename data keys in jq/);
 for(const columns of [[{key:'level',label:'告警级别'}],[],['n','n'],[''],42])assert.throws(()=>parseTableSpec({kind:'table',columns}),/columns/);
 console.log('presentation knowledge: paged discovery/navigation, exact slices, 14 executable figure examples, renderer matrix, table headers and XHTML bindings passed');
}finally{engine.dispose();}
