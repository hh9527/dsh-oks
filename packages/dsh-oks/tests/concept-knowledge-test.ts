import {readPoints} from '../src/point-knowledge.ts';
import assert from 'node:assert/strict';
import {discoverConcepts,renderConcepts} from '../src/concept-knowledge.ts';
import type {SemanticGraph} from '../src/knowledge-graph.ts';

const property=(name:string,dimension:string[],measure:string[]=[],counter:string[]=[],types:string[]=[])=>({name,field:'datasets/device#fields/'+name,dimensions:dimension.map(x=>'datasets/device#dimensions/'+x),measures:measure.map(x=>'datasets/device#measures/'+x),counters:counter.map(x=>'datasets/device#measures/'+x),types});
const graph:SemanticGraph={
 entities:{Device:{},Ssid:{}},
 datasets:{device:{subjects:[{entity:'entities/Device',field:'datasets/device#fields/id'}],props:[property('cpu',['cpu_raw'],['cpu_mean']),property('severity',['severity'],[],[],['types/AlarmSeverity']),property('count',[],[],['device_count'])],fields:{id:{},cpu:{},severity:{},count:{}},dimensions:{cpu_raw:{type:'Float'},severity:{type:'types/AlarmSeverity'}},measures:{cpu_mean:{aggregate:'Avg'},device_count:{aggregate:'Count'}}},
 ssid:{subjects:[{entity:'entities/Ssid',field:'datasets/ssid#fields/id'}],props:[{name:'cpu',field:'datasets/ssid#fields/cpu',dimensions:[],measures:['datasets/ssid#measures/cpu_mean'],counters:[],types:[]}],fields:{id:{},cpu:{}},measures:{cpu_mean:{aggregate:'Avg'}}}},
 types:{AlarmSeverity:{values:{Critical:{names:['Critical','紧急'],wires:[{Int:1}]}}}},relations:{},tools:{},
 items:[{key:'entities/Device',names:['设备'],doc:''},{key:'types/AlarmSeverity#values/Critical',names:['Critical','紧急'],doc:''}]
};
const root=readPoints(graph,{ids:['datasets/device']}).items[0];
assert.equal(root.facts.props,undefined,'Dataset exact read must not dump the discovery index');
assert.equal(root.facts.subjects[0].field,'datasets/device/fields/id');
const discoverOne=(graph:SemanticGraph,args:Record<string,unknown>)=>discoverConcepts(graph,{queries:[args]}).queries[0];
const omitted=discoverOne(graph,{entity:'devcie',props:['cpu']});
assert.equal(omitted.results.length,1);
assert.equal(omitted.results[0].entity,'entities/Device');
assert.deepEqual(omitted.results[0].measures,['datasets/device/measures/cpu_mean']);
assert.deepEqual(omitted.results,discoverOne(graph,{entity:'devcie',props:['cpu'],values:[]}).results);
const combined=discoverOne(graph,{entity:'设备',props:['cpu'],values:['紧急']});
assert.deepEqual(combined.results.map(p=>p.name),['cpu','severity']);
assert.equal(combined.results[1].matched.values[0].id,'types/AlarmSeverity/values/Critical');
assert.deepEqual(combined.results[1].matched.values[0].facts.wires,[{Int:1}]);
assert.deepEqual(discoverOne(graph,{entity:'Device',props:[],values:['Critical']}).results.map(p=>p.name),['severity']);
assert.deepEqual(discoverOne(graph,{entity:'Device',props:['count']}).results[0].counters,['datasets/device/measures/device_count']);
assert.equal(discoverOne(graph,{entity:'Ssid',props:[],values:['Critical']}).results.length,0);
assert.deepEqual(discoverOne(graph,{entity:'missing',props:['cpu']}).unmatched.entity,['missing']);
assert.throws(()=>discoverOne(graph,{entity:[],props:['cpu']}),/entity/);
assert.throws(()=>discoverOne(graph,{entity:'Device',props:[],values:[]}),/provide/);
assert.throws(()=>discoverOne(graph,{entity:'Device',props:['cpu'],scope:['datasets']}),/accepts/);
assert.throws(()=>discoverOne(graph,{entity:'Device',props:['cpu'],values:null}),/values/);
assert.match(renderConcepts({}, {data:{queries:[combined]}})[0].text,/- measures\/cpu_mean: /);
const many=structuredClone(graph);
for(let i=0;i<15;i++){
 (many.datasets.device.fields as any)['cpu'+i]={};
 (many.datasets.device.dimensions as any)['cpu'+i]={};
 (many.datasets.device.props as any[]).push(property('cpu'+i,['cpu'+i]));
}
const capped=discoverOne(many,{entity:'Device',props:['cpu']});
assert.equal(capped.results.length,16);
assert.doesNotMatch(renderConcepts({}, {data:{queries:[capped]}})[0].text,/截断/);
console.log('concept discovery: fuzzy entities/properties/values, optional values, counters, Type filtering, complementary matches, scope isolation and bounds passed');
