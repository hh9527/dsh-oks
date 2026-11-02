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
const tools=guidedTools(['report_extract_dari','move_entry','remove_file','ka_ask','dari_check','dari_resolve','dari_renew_context'].map(stub),knowledge);
const call=async(name:string,args:object)=>tools.find(t=>t.name===name)!.execute(args as never,{});
assert.deepEqual(tools.map(t=>t.name).sort(),['report_extract_dari','move_entry','remove_file','oks_read','ka_ask','dari_check','dari_resolve','dari_renew_context','oks_search','oks_cap','oks_info'].sort());
await call('oks_cap',{anchors:[{id:'datasets/d'}]});
const info=await call('oks_info',{ids:['datasets/d']}) as any;
assert.equal(info.data.items[0].dataset,'d');assert(!('dimensions' in info.data.items[0].facts));
const found=await call('oks_search',{query:'Dataset',dataset:'d',take:3}) as any;
assert.equal(found.data.items[0].id,'datasets/d');
await assert.rejects(call('oks_search',{query:' '}),/nonempty/);
await assert.rejects(call('oks_cap',{dataset:'d'}));
const cap=await call('oks_cap',{anchors:[{id:'datasets/d',terms:['id']}]}) as any;
assert(cap.data.index.Dimension.includes('datasets/d/dimensions/id'));
assert.equal((await call('oks_info',{ids:cap.data.index.Dimension}) as any).data.items[0].dimension,'id');
const {apply}=await import('./src/index.ts');
const registered:ToolDefinition[]=[];const disposers:(()=>void)[]=[];
apply({get(){},logger:{info(){}},tools:{register(t:ToolDefinition){registered.push(t);}},effect(fn:()=>unknown){const d=fn();if(typeof d==='function')disposers.push(d as ()=>void);},on(){return ()=>{};}} as never,{});
try {
 assert.deepEqual(registered.map(t=>t.name).sort(),tools.map(t=>t.name).sort());
 const value={ok:true,data:{text:'x'.repeat(20000)}};
 for(const name of ['oks_cap','oks_info','dari_check']) {
  const definition=registered.find(t=>t.name===name)!;
  assert.deepEqual(JSON.parse(definition.output.render({} as never,value as never).map(b=>b.text??'').join('')),value);
 }
} finally {disposers.reverse().forEach(d=>d());}
console.log('Public knowledge tools: exact surface, domain boundaries, search/cap/info and full result rendering passed');

// Public tools throw failed receipts; internal definitions keep structured results.
for (const name of ['dari_check','dari_resolve']) {
  const failure = {ok:false,status:'invalid',diagnostics:[{file:'.work/test.dari',stage:'type',message:'Expected number',span:{start:{line:3,column:4,offset:20},end:{line:3,column:5,offset:21}}}]};
  let result: unknown = failure;
  const internal = {...stub(name),async execute(){return result;}};
  const surface = guidedTools([internal],knowledge).find(t=>t.name===name)!;
  assert.equal(await internal.execute(),failure);
  await assert.rejects(surface.execute({} as never,{}),(error:unknown)=>{
    assert(error instanceof Error);
    assert(error.message.startsWith(`${name} failed:\n`));
    assert.deepEqual(JSON.parse(error.message.slice(error.message.indexOf('\n')+1)),failure);
    return true;
  });
  result = {ok:true,columns:[{name:'n',type:'Int'}]};
  assert.equal(await surface.execute({} as never,{}),result,'Success receipts pass through unchanged');
  const existing = new Error('aborted');
  const throwing = guidedTools([{...internal,async execute(){throw existing;}}],knowledge).find(t=>t.name===name)!;
  await assert.rejects(throwing.execute({} as never,{}),error=>error===existing,'Existing exceptions pass through unchanged');
}
console.log('Public DARI failures throw complete receipts; internal results and successes are unchanged');
