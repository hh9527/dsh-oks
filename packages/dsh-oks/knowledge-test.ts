import {queryKnowledge} from './src/knowledge-methods.ts';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { buildRetrievalIndex } from './src/retrieval.ts';
import { buildSemanticGraph, encodePart, refPath, resolveFact } from './src/knowledge-graph.ts';

const dataset='a/b#%中文';const encoded=encodePart(dataset);
const role:Record<string,string>={Dataset:'datasets',Field:'fields',Dimension:'dimensions',Measure:'measures',Ty:'types',Value:'values',Relation:'relations',TimeRole:'time_roles',BusinessLink:'business_links'};
const n=(key:string,type:string,detail:any,address:{node:string;member:string|null},links:any[]=[])=>({key,type,detail,address,links,description:{label:detail.id??'index',aliases:['站点'],localized:[],summary:'业务知识',terms:[]}});
const ds=`datasets/${encoded}`;
const link=(type:string,key:string,target:string)=>({type,key,role:role[target]});
const nodes=[
 n('index','Index',{revision:'fixture'},{node:'index',member:null}),
 n('Dataset/test','Dataset',{id:dataset,grain:['id'],time_roles:[]},{node:ds,member:null},[link('Member','Field/test/name','Field'),link('Member','Dimension/test/name','Dimension')]),
 n('Field/test/name','Field',{id:'name',dataset,nullable:false,logical_type:null},{node:ds,member:'fields/name'}),
 n('Dimension/test/name','Dimension',{id:'name',dataset,field:'name',ty:'Level',ops:['Eq'],values:[{id:'high',label:'高'}],label:'重复标签',summary:'重复说明'},{node:ds,member:'dimensions/name'},[link('Member','Field/test/name','Field'),link('Member','Ty/Level','Ty'),link('Member','Value/Level/high','Value')]),
 n('Ty/Level','Ty',{id:'Level',values:[{id:'high'}],storage:'Int'},{node:'types/Level',member:null},[link('Member','Value/Level/high','Value')]),
 n('Value/Level/high','Value',{id:'high',ty:'Level',wires:[{Int:1}]},{node:'types/Level',member:'values/high'}),
];
const graph=buildSemanticGraph(nodes).graph;
// Legacy graph fixture explicitly opts into the current reverse-reference policy.
graph.types.Level.reverse_references=true;
graph.types.Level.referenced_by={dimensions:[ds+'#dimensions/name'],fields:[ds+'#fields/name']};
assert.deepEqual(Object.keys(graph),['datasets','types','relations','tools','items']);
assert.equal(graph.items.filter(item=>!item.key.startsWith('tools/')).length,nodes.length-1);
assert.equal(graph.datasets[dataset].fields!==undefined,true);
assert.deepEqual(graph.types.Level.fields,[ds+'#fields/name']);
assert.deepEqual(resolveFact(graph,ds+'#fields/name').datasets,[ds]);
assert.deepEqual(resolveFact(graph,'types/Level#values/high').types,['types/Level']);
assert.equal(resolveFact(graph,ds+'#dimensions/name').type,'Level');
assert.deepEqual(resolveFact(graph,'types/Level#values/high').wires,[{Int:1}]);
assert.equal(resolveFact(graph,ds+'#dimensions/name').label,undefined);
assert.equal(resolveFact(graph,ds+'#dimensions/name').dataset,undefined);
assert.deepEqual(refPath(ds+'#fields/name'),['datasets',dataset,'fields','name']);
for(const key of ['datasets/a%2fb','datasets/%','datasets/x#fields/x#x','datasets/x#unknown/x']) assert.throws(()=>refPath(key));
let runtimeCalls=0;
for (const publishedKnowledge of [undefined, {knowledge_contract:'ontology-knowledge-v4',facts:[]}, {knowledge_contract:'ontology-knowledge-discovery-v1'}]) {
 await assert.rejects(buildRetrievalIndex({publishedKnowledge,settings:{domain:'test'} as any,runner:{send:async()=>{runtimeCalls++;throw new Error('must not run');}} as any},'',()=>{}),/requires ontology-knowledge-javascript-v1/);
}
assert.equal(runtimeCalls,0);
const dup=structuredClone(nodes);dup[2].address=dup[3].address;assert.throws(()=>buildSemanticGraph(dup),/kind mismatch|Duplicate/);
const wrong=structuredClone(nodes);wrong[1].links[0].role='values';assert.throws(()=>buildSemanticGraph(wrong),/role mismatch/);

const run=(name:string,args:Record<string,unknown>)=>queryKnowledge(graph,name,args) as any;
const first=run('search',{query:'站点',take:1});assert.equal(first.total,5);assert.equal(first.next,1);
assert.notEqual(first.items[0].key,run('search',{query:'站点',skip:1,take:1}).items[0].key);
assert.deepEqual(run('search',{query:'unknown'}),{total:0,start:0,items:[],next:null});
assert.equal(run('search',{query:'站点',type:'Dimension',dataset}).items[0].key,ds+'#dimensions/name');
assert.deepEqual(run('read',{key:ds+'#dimensions/name'}).facts,resolveFact(graph,ds+'#dimensions/name'));
assert.deepEqual(Object.keys(run('read',{key:ds+'#fields'}).facts),['name']);
console.log('Semantic graph: address encoding, ownership, reverse links, exact slices and JS knowledge navigation passed');
