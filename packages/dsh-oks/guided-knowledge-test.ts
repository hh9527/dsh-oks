import { presentationOverview } from './src/presentation-guide.ts';
import assert from 'node:assert/strict';
import { domainSummary, renderDomainSummary, DOMAIN_SUMMARY_URI } from './src/domain-summary.ts';
import { guidedTools } from './src/guided-tools.ts';
import type { Knowledge, WorkspaceEntry } from './src/knowledge.ts';
import type { ToolDefinition } from './src/host.ts';

const graph = {entities:{e:{identity:'types/Id',referenced_by:{datasets:['datasets/d']}}},datasets:{d:{grain:['id'],clock:'ts',dimensions:{id:{type:'Int',referenced_by:['x']}},measures:{n:{unit:'count'}},referenced_by:['x']}},relations:{r:{from_dataset:'datasets/d',to_dataset:'datasets/d',cardinality:{from:'Many',to:'One'},key:{from:'id',to:'id'},guard:null,referenced_by:['x']}},types:{Id:{values:{secret:{}}}},items:[{key:'datasets/d',doc:'Data',names:['Dataset label','vocabulary-secret']}],tools:{pluginSecret:{}}};
const original = JSON.stringify(graph);
const summary = domainSummary(graph,'demo');
assert.equal(summary.datasets.length,1);
assert.deepEqual(summary.datasets[0].dimensions,['id']);
assert.equal(summary.datasets[0].doc,'Data');
assert.deepEqual(summary.relations[0].cardinality,{from:'Many',to:'One'});
assert(!JSON.stringify(summary).includes('secret'));
assert(!JSON.stringify(summary).includes('referenced_by'));
assert.equal(JSON.stringify(graph),original);
assert.deepEqual(domainSummary(graph,'demo'),summary);
const calls: unknown[] = [];
const stub = (name:string):ToolDefinition => ({name,description:'stub',parameters:{type:'object'},output:{schema:{},render(){return [];}},async execute(args){calls.push(args);return args;}});
const knowledge = {ensureWorkspace(){return {settings:{domain:'demo'}} as WorkspaceEntry;},async ensureIndex(){return {knowledge:graph};}} as unknown as Knowledge;
const tools=guidedTools(['oks_project','oks_read','oks_list','oks_write','oks_edit','oks_delete','ka_ask','oks_check','oks_run_answer','oks_resolve','renew_context'].map(stub),knowledge);
const call=(name:string,args:object)=>tools.find(t=>t.name===name)!.execute(args as never,{});
assert(!tools.some(t=>t.name==='oks_project'));
assert(tools.some(t=>t.name==='ka_ask'));
await call('oks_cap',{anchors:[{id:'datasets/d'}]});
assert(!tools.some(t=>t.name==='oks_card'));
for(const [name,args] of [
 ['oks_cap',{cq:{},select:':keys'}],['oks_info',{ids:['datasets/d'],key:'entities/e'}],['oks_info',{key:'tools/pluginSecret'}],
 ['oks_read',{path:'oks://builtin/tools/ktools.lib.jq'}],['oks_write',{path:'oks://memory/tools/ktools.lib.jq'}],
] as const) await assert.rejects(call(name,args));
const help=await call('oks_list',{path:'oks://help/'}) as {files:{name:string}[]};
assert(help.files.some(f=>f.name==='oks://help/figures.md'));
assert(help.files.some(f=>f.name==='oks://help/workflow.md'));
const {COMPONENT_KINDS}=await import('./src/draft/components.ts');
for(const [component,kind] of Object.entries(COMPONENT_KINDS)){
 const uri=`oks://help/figure-${kind}.md`;
 assert(help.files.some(f=>f.name===uri));
 assert(presentationOverview().join('\n').includes(uri));
 assert(!renderDomainSummary(graph,'demo').includes(uri));
 const manual=await call('oks_read',{path:uri,limit:500}) as {lines:{text:string}[]};
 const text=manual.lines.map(l=>l.text).join('\n');
 assert(text.startsWith('# '+component));assert(text.includes('example'));
 assert(Buffer.byteLength(text)<6000,'Focused chart guides stay small');
}
const common=await call('oks_read',{path:'oks://help/figures.md',limit:500}) as {lines:{text:string}[]};
assert(Buffer.byteLength(common.lines.map(l=>l.text).join('\n'))<3000);
assert(help.files.some(f=>f.name==='oks://help/report.md'));

assert(!help.files.some(f=>f.name.startsWith('oks://domain/')));
await assert.rejects(call('oks_list',{path:'oks://domain/'}),/ka_ask/);
await assert.rejects(call('oks_read',{path:DOMAIN_SUMMARY_URI}),/ka_ask/);
await assert.rejects(call('oks_write',{path:DOMAIN_SUMMARY_URI,content:'edit'}));
await assert.rejects(call('oks_delete',{path:DOMAIN_SUMMARY_URI}));
await assert.rejects(call('oks_read',{path:'oks://domain/other.md'}));
assert(!help.files.some(f=>f.name.endsWith('/project.md')));
for(const name of ['oks_project','oks_result','oks_run_answer','oks_show','renew_context']) assert(!tools.some(t=>t.name===name));
assert(tools.some(t=>t.name==='oks_check'));
assert(tools.some(t=>t.name==='oks_resolve'));

console.log('Guided knowledge: summary, constraints, immutable graph, fixed tools and resource boundaries passed');

const { apply } = await import('./src/index.ts');
const registered: ToolDefinition[] = [];
const disposers: (() => void)[] = [];
apply({get(){return undefined;},logger:{info(){}},tools:{register(t){registered.push(t);}},effect(fn){const d=fn();if(d)disposers.push(d);},on(){return ()=>{};}} as never,{});
try {
  assert(registered.some(t=>t.name==='oks_resolve'));
  assert(!registered.some(t=>['oks_run','oks_show'].includes(t.name)));
  const value = {ok:true,data:{text:'x'.repeat(20000)}};
  for (const name of ['oks_cap','oks_info','oks_check']) {
    const definition = registered.find(t=>t.name===name)!;
    const rendered = definition.output.render({} as never,value as never).map(b=>b.text??'').join('');
    assert.deepEqual(JSON.parse(rendered),value,'Public tools return complete data beyond the design budget');
  }
} finally { disposers.reverse().forEach(d=>d()); }
console.log('Public tool results preserve full data beyond 16 KiB');

const info=await call('oks_info',{ids:['datasets/d']}) as any;
assert.equal(info.data.items[0].dataset,'d');assert(!('dimensions' in info.data.items[0].facts));
const found=await call('oks_search',{query:'Dataset',dataset:'d',take:3}) as any;
assert.equal(found.data.items[0].id,'datasets/d');
await assert.rejects(call('oks_search',{query:' '}),/nonempty/);
await assert.rejects(call('oks_search',{query:'device',select:':keys'}));

const cap=await call('oks_cap',{anchors:[{id:'datasets/d',terms:['id']}]}) as any;
assert(cap.data.index.Dimension.includes('datasets/d/dimensions/id'));
assert.equal((await call('oks_info',{ids:cap.data.index.Dimension}) as any).data.items[0].dimension,'id');
await assert.rejects(call('oks_cap',{dataset:'d'}));
await assert.rejects(call('oks_cap',{}));
assert.equal((await call('oks_info',{ids:['entities/e']}) as any).data.items[0].entity,'e');
