import assert from 'node:assert/strict';
import {queryKnowledge,knowledgeArgs} from './src/knowledge-methods.ts';
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

const run=(name:string,args:Record<string,unknown>)=>queryKnowledge(graph,name,args) as any;

const frozen=JSON.stringify(graph);
const card=run('card',{id,docs:true});assert.equal(card.dimensions[0].authorized,false);assert.equal(card.dimensions[0].half_open,false);assert.equal(card.measures[0].unit,'count');assert.equal(card.roles[0].facts.entity,'entities/Identity');
assert.equal(run('read',{key:dimension}).facts.projectable,false);
assert.equal(run('search',{query:'告警'}).items[0].key,dataset);
const cq={target:{dataset:id},select:[{dimension:'level'}],measures:[{measure:'n'}]};
const cap=run('cap',{cq,join_depth:2,take:50});assert.equal(cap.joins.total,4);assert.equal(cap.joins.items.filter((j:any)=>j.steps.length===2).length,2);assert.equal(cap.select[0].facts.authorized,false);assert.equal(cap.discovery.requires_transform,true);assert.deepEqual(cap.candidate_intent.nodes,[{id:'d',entity:id}]);
assert.equal(run('cap',{cq:{target:{entity:'Shared'}}}).unresolved[0].reason,'multiple_datasets');
assert.equal(run('cap',{cq:{target:{entity:'Identity'}}}).target.dataset,id);
assert.equal(run('cap',{cq:{target:{dataset:id},select:[{dimension:'missing'}]}}).candidate_intent,null);
assert.equal(run('cap',{cq,join_depth:2,take:1}).joins.next,1);
assert.equal(run('card',{id,skip:1,take:1}).dimensions.length,0);
assert.equal(run('card',{id,section:'shape'}).dimensions,undefined);
assert.throws(()=>run('read',{key:'datasets/nope'}),/Unknown/);
assert.throws(()=>run('read',{key:'datasets/__proto__'}),/Unknown/);
assert.throws(()=>run('card',{id:'constructor'}),/Unknown/);
for(const args of [{cq,join_depth:3},{cq,take:51},{cq:{target:{dataset:id},select:[{}]}}])assert.throws(()=>knowledgeArgs('cap',args));
assert.throws(()=>knowledgeArgs('read',{key:'datasets/d',source:'arbitrary'}));
assert.equal(JSON.stringify(graph),frozen,'host methods do not mutate model knowledge');
console.log('JS knowledge: cards, encoded IDs, false facts, joins, ambiguity, paging, validation, own-key lookup and immutable graph passed');
