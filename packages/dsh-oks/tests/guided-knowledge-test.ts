import { presentationOverview } from '../src/presentation-guide.ts';
import assert from 'node:assert/strict';
import { domainSummary, renderDomainSummary, DOMAIN_SUMMARY_URI } from '../src/domain-summary.ts';
import { guidedTools } from '../src/guided-tools.ts';
import type { Knowledge, WorkspaceEntry } from '../src/knowledge.ts';
import type { ToolDefinition } from '../src/host.ts';

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
const tools=guidedTools(['report_extract_dari','move_entry','remove_file','va_ask','dari_check','dari_resolve','dari_renew_context'].map(stub),knowledge);
const call=async(name:string,args:object)=>tools.find(t=>t.name===name)!.execute(args as never,{});
assert.deepEqual(tools.map(t=>t.name).sort(),['report_extract_dari','move_entry','remove_file','oks_read','va_ask','dari_check','dari_resolve','dari_renew_context','oks_discover','oks_routes','oks_info'].sort());
await call('oks_routes',{from:'datasets/d',to:'datasets/d'});
const info=await call('oks_info',{ids:['datasets/d']}) as any;
assert.equal(info.data.items[0].dataset,'d');assert(!('dimensions' in info.data.items[0].facts));
await assert.rejects(call('oks_routes',{dataset:'d'}));
assert.equal((await call('oks_info',{ids:['datasets/d/dimensions/id']}) as any).data.items[0].dimension,'id');
const {apply}=await import('../src/index.ts');
const registered:ToolDefinition[]=[];const disposers:(()=>void)[]=[];
apply({get(){},logger:{info(){}},tools:{register(t:ToolDefinition){registered.push(t);}},effect(fn:()=>unknown){const d=fn();if(typeof d==='function')disposers.push(d as ()=>void);},on(){return ()=>{};}} as never,{});
try {
 assert.deepEqual(registered.map(t=>t.name).sort(),tools.map(t=>t.name).sort());
 const infoTool=registered.find(t=>t.name==='oks_info')!;
 const infoValue=await call('oks_info',{ids:['datasets/d/dimensions/id']});
 const infoText=infoTool.output.render({} as never,infoValue as never).map(b=>b.text??'').join('');
 assert.match(infoText,/## datasets\/d\/dimensions\/id/);assert.match(infoText,/dimension="id"/);
 const check=registered.find(t=>t.name==='dari_check')!;
 const receipt={ok:true,text:'## unresolved-node-types\n\n## inspect-node-types\n- data.facts: Table({n:Int})'};
 assert.equal(check.output.render({} as never,receipt as never).map(b=>b.text??'').join(''),receipt.text);
} finally {disposers.reverse().forEach(d=>d());}
console.log('Public knowledge tools: exact surface, domain boundaries, search/routes/info and full result rendering passed');

// Public tools throw failed receipts; internal definitions keep structured results.
for (const name of ['dari_check','dari_resolve']) {
  const failure = {ok:false,status:'invalid',diagnostics:[{file:'.work/test.dari',stage:'type',message:'Expected number',span:{start:{line:3,column:4,offset:20},end:{line:3,column:5,offset:21}}}]};
  let result: unknown = failure;
  const internal = {...stub(name),async execute(){return result;}};
  const surface = guidedTools([internal],knowledge).find(t=>t.name===name)!;
  assert.equal(await internal.execute(),failure);
  await assert.rejects(surface.execute({} as never,{}),(error:unknown)=>{
    assert(error instanceof Error);
    if(name==='dari_resolve'){
      assert.match(error.message,/^ResolveFailed\n-------------/);assert.match(error.message,/L3:4: Expected number/);
      assert(!error.message.includes('"diagnostics"'));
    }else{
      assert(error.message.startsWith(`${name} failed:\n`));
      assert.deepEqual(JSON.parse(error.message.slice(error.message.indexOf('\n')+1)),failure);
    }
    return true;
  });
  result = {ok:true,columns:[{name:'n',type:'Int'}]};
  assert.equal(await surface.execute({} as never,{}),result,'Success receipts pass through unchanged');
  const existing = new Error('aborted');
  const throwing = guidedTools([{...internal,async execute(){throw existing;}}],knowledge).find(t=>t.name===name)!;
  await assert.rejects(throwing.execute({} as never,{}),error=>error===existing,'Existing exceptions pass through unchanged');
}
console.log('Public DARI failures throw complete receipts; internal results and successes are unchanged');
