import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderDomainSummary, readDomainSummary, DOMAIN_SUMMARY_URI } from './src/domain-summary.ts';
import { guidedTools } from './src/guided-tools.ts';
import { installKnowledgeNavigation } from './src/knowledge-navigation.ts';
import { installWorkMethods } from './src/work-methods.ts';
import type { Knowledge, WorkspaceEntry } from './src/knowledge.ts';
import type { PluginContext, ToolDefinition, ToolExec, PromptAssembly, AgentLike } from './src/host.ts';

const largeGraph = {entities:{identity:{referenced_by:{datasets:['forbidden reverse']}}},datasets:Object.fromEntries(Array.from({length:90},(_,i)=>['dataset-'+i,{grain:['id'],roles:{subject:{entity:'entities/identity'}},dimensions:Object.fromEntries(Array.from({length:30},(_,j)=>['dimension-'+i+'-'+j,{}])),measures:{count:{type:'Int'}},time_roles:{clock:{}}}])),relations:{edge:{from_dataset:'datasets/dataset-0',to_dataset:'datasets/dataset-1',cardinality:{from:'Many0',to:'Optional'},key:{secret:'local-only'}}},types:{Secret:{values:{'vocabulary-only':{}}}},items:[]};
const otherGraph = {entities:{other:{}},datasets:{different:{}},relations:{},items:[]};
const knowledge = {
  ensureWorkspace(exec:ToolExec) {
    const domain=exec.agent?.session?.header?.cwd;
    if(domain!=='large' && domain!=='other')throw Error('no model');
    return {settings:{domain}} as WorkspaceEntry;
  },
  async ensureIndex(entry:WorkspaceEntry){return {knowledge:entry.settings.domain==='large'?largeGraph:otherGraph};},
} as unknown as Knowledge;
const exec=(domain:string)=>({agent:{session:{header:{cwd:domain}}}} as ToolExec);
let assemble: ((assembly:PromptAssembly,context:{agent?:AgentLike;signal?:AbortSignal},next:()=>Promise<PromptAssembly>)=>Promise<PromptAssembly>)|undefined;
const sections:{name:string;order:number;text:string;interpolate?:boolean}[]=[];
const ctx={systemPrompt:{section(s:typeof sections[number]){sections.push(s);}},on(name:string,fn:typeof assemble){assert.equal(name,'system-prompt/assemble');assemble=fn;return ()=>{};},effect(fn:()=>()=>void){fn();}} as unknown as PluginContext;
installWorkMethods(ctx);
const workflow=readFileSync(new URL('./src/help/workflow.md',import.meta.url),'utf8');
assert.equal(sections[0].text,workflow,'Mandatory prompt and method manual share one source');
assert.match(workflow,/建立一份/);
assert.equal(sections[0].interpolate,false);
installKnowledgeNavigation({ctx,knowledge,log(){}});
assert.equal(sections[1].name,'oks:presentation');
assert(sections[1].text.includes('ColumnChart'));
assert(!sections[1].text.includes('dataset-89'));
const summary=await readDomainSummary(knowledge,exec('large'));
assert(summary.startsWith('# 全局领域摘要'));
assert(Buffer.byteLength(summary)<35*1024);
assert(summary.includes('dataset-89'));
assert(!summary.includes('dimension-89-29'));
assert(!summary.includes('ColumnChart'));
assert(summary.includes('identity'));
for(const forbidden of ['forbidden reverse','vocabulary-only','local-only','referenced_by'])assert(!summary.includes(forbidden));
assert.equal(await readDomainSummary(knowledge,exec('large')),summary);
const project:ToolDefinition={name:'oks_project',description:'internal',parameters:{},output:{schema:{},render(){return [];}},async execute(){throw Error('not used');}};
const stubs=['oks_read','oks_list','oks_write','oks_edit','oks_delete'].map(name=>({...project,name}));
const tools=guidedTools([project,...stubs],knowledge);
const call=(name:string,args:object,domain='large')=>tools.find(t=>t.name===name)!.execute(args as never,exec(domain));
for(const domain of ['large','other']) {
 await assert.rejects(call('oks_read',{path:DOMAIN_SUMMARY_URI},domain),/ka_ask/);
 await assert.rejects(call('oks_list',{path:'oks://domain/'},domain),/ka_ask/);
}
for(const tool of tools)assert(!JSON.stringify({description:tool.description,parameters:tool.parameters}).includes('oks://domain/'));
const other=await readDomainSummary(knowledge,exec('other'));
assert(other.includes('different') && !other.includes('dataset-89'));
const abort=new AbortController();abort.abort();
await assert.rejects(readDomainSummary(knowledge,{...exec('large'),signal:abort.signal}),/abort/i);
await assert.rejects(readDomainSummary(knowledge,exec('absent')),/no model/);
const oddId='odd`id|[x]';
const odd=renderDomainSummary({datasets:{[oddId]:{dimensions:{[oddId]:{}}}},items:[{key:'datasets/'+encodeURIComponent(oddId),names:['**label**'],doc:'line1\n# line2'}]},'odd');
assert(odd.includes('` datasets/'+encodeURIComponent(oddId)+' `'));
assert(!odd.includes('\n# line2'));
console.log('Three knowledge layers: same-source prompt/manual, full Markdown summary, resource paging, isolation and cancellation passed');
