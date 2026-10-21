import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createJaqEngine } from './src/jaq.ts';
import { buildRetrievalIndex } from './src/retrieval.ts';
import { buildSemanticGraph, encodePart, refPath, resolveFact } from './src/knowledge-graph.ts';
import { builtinCode, knowledgePrograms, toolResource } from './src/knowledge-programs.ts';

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
const discovery={addressing:'node-member-uri-v1',knowledge_contract:'ontology-knowledge-v3',intent_contract:'ontology-intent-v1',revision:'fixture',roots:['Dataset/test'],key_patterns:[],vocabulary:[{kind:'Dataset'},{kind:'Dimension',owner:'dataset'}]};
const runner=(contract:any=discovery,source=nodes)=>({send:async(method:string,input:any)=>({ok:method.endsWith('/discovery')?contract:{Document:{Found:source.find(n=>n.key===input.key)}}}),dispose(){}});
const entry=(contract:any=discovery,source=nodes)=>({settings:{domain:'test'},runner:runner(contract,source)}) as any;
const index=await buildRetrievalIndex(entry(),'hash',()=>{});
const graph=index.knowledge;
assert.deepEqual(Object.keys(graph),['datasets','types','relations','tools','items']);
assert.equal(graph.items.filter(item=>!item.key.startsWith('tools/')).length,nodes.length-1);
assert.equal(index.sourceNodes.length,nodes.length);
assert.equal(index.meta.format,'oks-knowledge-v2');
assert.ok(Buffer.byteLength(JSON.stringify(index.meta))<1024);
assert.equal(index.terms.length,2);
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
await assert.rejects(buildRetrievalIndex(entry({...discovery,knowledge_contract:'old'}),'',()=>{}),/契约不兼容/);
await assert.rejects(buildRetrievalIndex(entry({...discovery,addressing:'old'}),'',()=>{}),/地址契约/);
await assert.rejects(buildRetrievalIndex(entry(discovery,nodes.slice(0,-1)),'',()=>{}),/无法解析知识 key/);
const dup=structuredClone(nodes);dup[2].address=dup[3].address;assert.throws(()=>buildSemanticGraph(dup),/kind mismatch|Duplicate/);
const wrong=structuredClone(nodes);wrong[1].links[0].role='values';assert.throws(()=>buildSemanticGraph(wrong),/role mismatch/);
const engine=createJaqEngine(fileURLToPath(new URL('./lib/oks-wti.wasm',import.meta.url)));
try {
 const run=async(name:string,args:Record<string,unknown>={})=>{
   const code=builtinCode(`builtin://knowledge/${name}.jq`,args);
   const out=await engine.run(code.text,{input:{knowledge:graph,other:graph},timeoutMs:5000,maxBytes:16384,programFile:code.file});
   assert.equal(out.ok,true);return (out as any).data;
 };
 const first=await run('search',{query:'站点',take:1});assert.equal(first.total,5);assert.equal(first.next,1);
 const next=await run('search',{query:'站点',skip:1,take:1});assert.notEqual(first.items[0].key,next.items[0].key);
 assert.equal((await run('search',{query:'站点',skip:4,take:1})).next,null);
 assert.deepEqual(await run('search',{query:'unknown'}),{total:0,start:0,items:[],next:null});
 const dims=await run('search',{type:'Dimension',dataset,input:'other'});assert.equal(dims.items[0].key,ds+'#dimensions/name');assert.equal(dims.items[0].id,'name');
 const members=await run('members',{key:ds,link:'dimensions'});assert.equal(members.items.length,1);assert.equal(members.items[0].key,ds+'#dimensions/name');
 const refs=await run('references',{key:'types/Level',type:'Dimension'});assert.ok(refs.items.some((r:any)=>r.key===ds+'#dimensions/name'));
 const read=await run('read',{key:ds+'#dimensions/name'});assert.deepEqual(read.facts,resolveFact(graph,ds+'#dimensions/name'));assert.deepEqual(read.items.map((i:any)=>i.key),[ds+'#dimensions/name']);
 const category=await run('read',{key:ds+'#fields'});assert.deepEqual(Object.keys(category.facts),['name']);assert.equal(category.items.length,1);assert.equal(category.facts.dimensions,undefined);
 const typeValues=await run('read',{key:'types/Level#values'});assert.deepEqual(Object.keys(typeValues.facts),['high']);assert.equal(typeValues.facts.fields,undefined);
 const typeFields=await run('members',{key:'types/Level',link:'fields'});assert.equal(typeFields.items[0].key,ds+'#fields/name');
 await assert.rejects(run('references',{key:'datasets/missing'}),/Unknown knowledge key/);
 for(const name of Object.keys(knowledgePrograms))assert.ok(toolResource(`builtin://knowledge/${name}.jq`));
 for(const args of [{take:0},{take:51},{skip:-1},{query:1},{unknown:true}])assert.throws(()=>builtinCode('builtin://knowledge/search.jq',args));
 assert.throws(()=>builtinCode('builtin://knowledge/read.jq',{key:ds,take:1}));
 // 原型名称也是业务 ID，不会成为对象原型或丢失。
 const proto=buildSemanticGraph([n('Dataset/proto','Dataset',{id:'__proto__'},{node:'datasets/__proto__',member:null})]).graph;
 assert.ok(Object.hasOwn(proto.datasets,'__proto__'));assert.equal(Object.getPrototypeOf(proto.datasets),Object.prototype);
 console.log('semantic graph: address encoding, ownership, categorized reverse links, exact slices+docs, paging and actual Wasm examples passed');
}finally{engine.dispose();}
