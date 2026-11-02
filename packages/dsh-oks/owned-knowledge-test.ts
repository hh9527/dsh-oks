import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {derivePublishedKnowledge} from './src/published-knowledge.ts';
import {collectProgrammedKnowledge} from './src/programmed-knowledge.ts';
import {discoverPoints,readPoints} from './src/point-knowledge.ts';
import {semanticKnowledge} from './src/semantic-knowledge.ts';
import {renderDomainSummary} from './src/domain-summary.ts';
const root=(key:string,value:any,reference_sites:any[]=[])=>({key,value,reference_sites,references:[...new Set(reference_sites.map(s=>s.target).filter(t=>t!==key))]});
const input:any={knowledge_contract:'ontology-knowledge-v5',intent_contract:'ontology-intent-v1',addressing:'node-member-uri-v1',revision:'owned',items:[],facts:[
 root('types/AlarmSeverity',{name:'AlarmSeverity',reverse_references:true,values:{critical:{label:'严重',wires:[{Int:1}]}}}),
 root('types/Percent',{name:'Percent',reverse_references:false}),
 root('entities/device',{identity:'{id: String}'}),
 root('datasets/current_alarm',{fields:{severity:{type:'Int'},cpu:{type:'types/Percent'}},dimensions:{alarm_severity:{type:'types/AlarmSeverity',field:'datasets/current_alarm#fields/severity',filters:['Eq']}},roles:{device:{entity:'entities/device'}}},[
  {path:['dimensions','alarm_severity'],target:'types/AlarmSeverity'},
  {path:['fields','cpu'],target:'types/Percent'},
  {path:['roles','device'],target:'entities/device'},
 ]),
 root('datasets/device',{fields:{id:{type:'String'}}}),
 root('relations/alarm_device',{from_dataset:'datasets/current_alarm',to_dataset:'datasets/device',cardinality:{from:'Many0',to:'Optional'}},[{path:[],target:'datasets/current_alarm'},{path:[],target:'datasets/device'}]),
]};
input.relations=input.facts.filter((f:any)=>f.key.startsWith('relations/'));
input.facts=input.facts.filter((f:any)=>!f.key.startsWith('relations/'));
const before=JSON.stringify(input),index=derivePublishedKnowledge(input),graph=index.knowledge;
assert.equal(JSON.stringify(input),before);
assert.deepEqual(index.meta.roots,['datasets','entities','types']);
assert(!Object.keys(graph).some(k=>['dimension_groups','measure_groups'].includes(k)));
assert(!Object.keys(graph).includes('relations'));
assert(Object.keys(graph.relations).includes('alarm_device'));
assert.equal(graph.datasets.current_alarm.peers['datasets/device'].by[0].id,'relations/alarm_device');
assert.deepEqual(index.meta.discovery_roots,['entities','datasets','relations']);
assert(!index.meta.discovery_roots.includes('types'));
assert.deepEqual(readPoints(graph,{ids:['relations/alarm_device']}).items[0].facts.cardinality,{from:'Many0',to:'Optional'});
assert(index.links.every(e=>!e.source.includes('#')&&!e.target.includes('#')));
assert.deepEqual({...graph.types.AlarmSeverity.referenced_by},{datasets:['datasets/current_alarm']});
assert.equal(graph.types.Percent.referenced_by,undefined);
const cap=discoverPoints(graph,{anchors:[{id:'types/AlarmSeverity',terms:['critical']}]});
assert(cap.index.Dataset.includes('datasets/current_alarm'));
assert(cap.index.Dimension.includes('datasets/current_alarm/dimensions/alarm_severity'));
assert(cap.anchors[0].matches[0].ids.includes('types/AlarmSeverity/values/critical'));
assert.deepEqual(cap.locations!['datasets/current_alarm/dimensions/alarm_severity'],{node:'datasets/current_alarm',path:['dimensions','alarm_severity']});
const info=readPoints(graph,{ids:['datasets/current_alarm/dimensions/alarm_severity','types/AlarmSeverity']});
assert.equal(info.items[0].node,'datasets/current_alarm');assert.equal(info.items[0].dimension,'alarm_severity');
assert.equal(info.items[1].facts.reference_locations,undefined);
const paths=discoverPoints(graph,{anchors:[{id:'datasets/current_alarm'},{id:'datasets/device'}]});
assert.equal(paths.connections[0].status,'connected');assert(paths.connections[0].paths[0].relations[0].startsWith('relations/'));
assert(renderDomainSummary(graph,'fixture').includes('current_alarm'));
const search=semanticKnowledge(graph,'search',{query:'critical',take:20}) as any;
assert(search.items.some((v:any)=>v.node==='types/AlarmSeverity'&&v.path.join('/')==='values/critical'));
const bad=structuredClone(input);bad.facts[0].references=['datasets/device'];assert.throws(()=>derivePublishedKnowledge(bad),/do not match/);
for(const path of process.argv.slice(2)){
 const {graph:published,vocabulary}=await collectProgrammedKnowledge(JSON.parse(readFileSync(path,'utf8')));
 assert.equal(published.knowledge_contract,'ontology-knowledge-v5');
 assert((published.facts as any[]).every(f=>/^(datasets|entities|types)\/[^#]+$/.test(f.key)));
 const actual=derivePublishedKnowledge(published,undefined,vocabulary);
 assert.equal(Object.keys(actual.knowledge.dimension_groups??{}).length,0);assert.equal(Object.keys(actual.knowledge.measure_groups??{}).length,0);
 const types=Object.values(actual.knowledge.types);assert(!types.some((t:any)=>t.field_types?.length));
 for(const dataset of Object.values(actual.knowledge.datasets)){
  assert.equal(dataset.row,undefined);assert.equal(dataset.bindings,undefined);
  for(const section of ['dimensions','measures'])for(const member of Object.values(dataset[section] as any??{}) as any[]){assert.equal(member.group,undefined);assert.equal(member.binding,undefined);assert.equal(member.local,undefined);}
 }
 assert(actual.links.every(e=>!e.source.includes('#')&&!e.target.includes('#')));
 if(actual.knowledge.datasets.current_alarm){
  const key=Object.entries(actual.knowledge.types).find(([,t])=>t.name==='icloud_model/typed/current_alarm::AlarmSeverity')![0];
  const discovery=discoverPoints(actual.knowledge,{anchors:[{id:'types/'+key,terms:['critical']}]});
  assert(discovery.index.Dataset.includes('datasets/current_alarm'));
  const measure=readPoints(actual.knowledge,{ids:['datasets/device_kpi/measures/cpu_usage']}).items[0];assert.equal(measure.facts.unit,'%');assert.equal(measure.facts.statistic,'Mean');
 }
 console.log(path+': '+published.facts.length+' independent nodes; content, policies and navigation passed');
}
console.log('Owned knowledge: root identities, searchable locations, exact reads, reverse policy and independent relation paths passed');
