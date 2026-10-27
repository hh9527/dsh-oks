import assert from 'node:assert/strict';
import {createJaqEngine} from './src/jaq.ts';
import {createKtools} from './src/ktools.ts';
import {builtinCode} from './src/knowledge-programs.ts';
const id='alarm/a#中文', dataset='datasets/'+encodeURIComponent(id), type='types/Level';
const field=dataset+'#fields/id', dimension=dataset+'#dimensions/level', measure=dataset+'#measures/n';
const graph:any={entities:{Identity:{roles:[dataset+'#roles/owner']},Shared:{roles:[dataset+'#roles/owner','datasets/other#roles/owner']}},
 datasets:{[id]:{grain:['id'],kind:'Entity',source:'alarm',scope:[{op:'Eq'}],
 fields:{id:{types:[type]}},roles:{owner:{entity:'entities/Identity'}},bindings:{level:{group:'dimension_groups/level'}},business_links:{},
 dimensions:{level:{type,field,fields:[field],ops:['Eq'],filterable:false,authorized:false,projectable:false,computed:false,half_open:false,canonical_order:['major'],canonical_values:[{id:'major',wires:[{Int:1}]}],group:'dimension_groups/level'}},
 measures:{n:{aggregate:'Count',anchor_field:field,statistic:'Count',sampling:{unit:'count',role:'Primary'}}},
 time_roles:{clock:{field,encoding:'EpochMillis',semantics:'Utc',authoritative:false}},relations:['relations/join1','relations/join2']},
 other:{grain:['a','b'],dimensions:{},measures:{}},third:{grain:['id'],dimensions:{},measures:{}}},
 dimension_groups:{level:{name:'level'}},measure_groups:{},
 types:{Level:{reverse_references:true,values:{major:{wires:[{Int:1}]}},referenced_by:{fields:[field],dimensions:[dimension]}},Hidden:{reverse_references:false}},
 relations:{join1:{from_dataset:dataset,to_dataset:'datasets/other',cardinality:{from:'Many',to:'Optional'},key:{from:field,to:'datasets/other#fields/a'},guard:{op:'Eq'}},
 join2:{from_dataset:dataset,to_dataset:'datasets/other',cardinality:{from:'Many',to:'One'},key:{from:field,to:'datasets/other#fields/b'},guard:null},
 next:{from_dataset:'datasets/other',to_dataset:'datasets/third',cardinality:{from:'Many',to:'One'},key:{from:'datasets/other#fields/a',to:'datasets/third#fields/id'},guard:null}},tools:{render_figure:{kinds:{table:{component:'table',required:[],series:{},switches:[]}}}},items:[]};
for(const root of ['entities','datasets','dimension_groups','types','relations'])for(const [id,value]of Object.entries(graph[root]) as any){
 const key=root+'/'+encodeURIComponent(id);graph.items.push({key,names:[id==='alarm/a#中文'?'告警':id],doc:'fixture'});
 for(const kind of ['fields','roles','bindings','dimensions','measures','time_roles','values'])if(value[kind]&&!Array.isArray(value[kind]))for(const member of Object.keys(value[kind]))graph.items.push({key:key+'#'+kind+'/'+encodeURIComponent(member),names:[member],doc:'member'});
}
const engine=createJaqEngine(process.argv[2]??'lib/oks-wti.wasm');
const library=createKtools(engine.checkLibrary,engine.run);
async function run(name:string,args:Record<string,unknown>={}){
 const code=await library.program('','oks://builtin/tools/ktools.lib.jq#'+name,args);
 const out=await engine.runDocument(code.text,graph,{input:null,timeoutMs:5000,maxBytes:1e6});assert(out.ok);return out.data as any;
}
try{
 const overview=await run('overview',{take:1});assert.equal(overview.total,3);assert.equal(overview.next,1);assert.equal(overview.datasets[0].label,'告警');
 const card=await run('card',{id,docs:true});assert.equal(card.measures[0].anchor_field,field);assert.equal(card.measures[0].unit,'count');assert.equal(card.dimensions[0].authorized,false);assert.equal(card.dimensions[0].computed,false);assert.equal(card.dimensions[0].half_open,false);assert.equal(card.dimensions[0].projectable,false);assert.equal(card.dimensions[0].canonical_values[0].id,'major');assert.equal(card.roles[0].facts.entity,'entities/Identity');assert.equal(card.bindings[0].facts.group,'dimension_groups/level');assert.equal(card.counts.bindings,1);assert.equal(card.values,undefined);
 const members=await run('members',{key:dataset,take:50});assert(members.items.length>0);assert(members.items.every((m:any)=>m.type&&m.key!== 'id'));assert(!members.items.some((m:any)=>m.link==='scope'||m.link==='grain'));
 const refs=await run('references',{key:type,type:'Dimension'});assert.equal(refs.items[0].key,dimension);assert.equal(refs.coverage,'referenced_by');
 assert.equal((await run('references',{key:'types/Hidden'})).coverage,'reverse_references_false');
 assert.equal((await run('read',{key:dimension})).facts.projectable,false);
 const nodes=await run('nodes',{keys:[dimension,'types/missing'],mode:'both'});assert.equal(nodes[1].error,'unknown node');
 assert.equal((await run('search',{type:'Entity'})).total,2);
 const cq={target:{dataset:id},select:[{dimension:'level'}],measures:[{measure:'n'}]};
 const cap=await run('cap',{cq,join_depth:2,take:50});assert.equal(cap.discovery.requires_transform,true);assert.equal(cap.ok,undefined);assert.equal(cap.select[0].facts.authorized,false);assert.deepEqual(cap.candidate_intent.nodes,[{id:'d',entity:id}]);assert.equal(cap.joins.total,4);
 assert.equal(cap.joins.items.filter((j:any)=>j.steps.length===1).length,2);assert.equal(cap.joins.items.filter((j:any)=>j.steps.length===2).length,2);
 assert(cap.joins.items.every((j:any)=>!Object.hasOwn(j,'grain_safe')&&!Object.hasOwn(j,'grain_proof')));assert(cap.joins.items.some((j:any)=>j.steps[0].guard?.op==='Eq'));
 const paged=await run('cap',{cq,join_depth:2,take:1});assert.equal(paged.joins.items.length,1);assert.equal(paged.joins.next,1);
 const missing=await run('cap',{cq:{target:{dataset:id},select:[{dimension:'missing'}]}});assert.equal(missing.candidate_intent,null);assert.equal(missing.unresolved[0].id,'missing');
 const byEntity=await run('cap',{cq:{target:{entity:'Identity'}},join_depth:0});assert.equal(byEntity.target.dataset,id);
 const ambiguous=await run('cap',{cq:{target:{entity:'Shared'}}});assert.equal(ambiguous.target.candidates.length,2);assert.equal(ambiguous.target.dataset,null);assert.equal(ambiguous.candidate_intent,null);
 const discoveryOnly=await run('cap',{cq:{...cq,window:{dimension:'level',start:'bad-time',end:'bad-time'},rank:{measure:'n',direction:'Wrong',take:0}},join_depth:0});assert.equal(discoveryOnly.candidate_intent.top_by_measure.take,0);assert.equal(discoveryOnly.candidate_intent.time_windows[0].end,'bad-time');assert.equal(discoveryOnly.discovery.requires_transform,true);
 const unknownRank=await run('cap',{cq:{...cq,rank:{measure:'missing'}}});assert.equal(unknownRank.candidate_intent,null);
 assert((await run('shape_audit')).roots.includes('entities'));assert.equal((await run('shape_audit')).coverage,'observed_graph');
 assert.equal((await run('metric_map',{pattern:'n'})).total,1);assert.equal((await run('figure_kinds'))[0].component,'table');
 for(const [name,args]of [['routes',{}],['card',{id,section:'values'}],['card',{id,value_skip:1}],['metric_map',{}],['cap',{}],['cap',{cq:{target:{dataset:id,entity:'Identity'}}}],['cap',{cq,join_depth:3}],['cap',{cq,take:51}],['cap',{cq:{target:{dataset:id},select:[{}]}}]] as const)assert.throws(()=>builtinCode(`builtin://knowledge/${name}.jq`,args));
 console.log('Capability discovery: current cards, encoded IDs, false facts, precise navigation, reverse policy, entity ambiguity, alternative relation paths, paging, raw request forwarding, observations and parameter validation passed');
}finally{engine.dispose();}
