import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {derivePublishedKnowledge} from './src/published-knowledge.ts';
import {resolveFact} from './src/knowledge-graph.ts';
import {createJaqEngine} from './src/jaq.ts';
import {builtinCode} from './src/knowledge-programs.ts';
const fact=(key:string,value:Record<string,unknown>={},references:string[]=[])=>({key,value,references});
const publication=(facts:unknown[])=>({knowledge_contract:'ontology-knowledge-v4',intent_contract:'ontology-intent-v1',addressing:'node-member-uri-v1',revision:'reference-policy',facts,items:[]});
const names=['Date','DateTime','DateTimeUtc','EpochMillis'];
const disabled=[...names,'Business'];
const facts=[...names.map(name=>fact(`types/${name}`,{reverse_references:false})),fact('types/Business'),fact('types/Explicit',{reverse_references:true}),fact('datasets/sample')];
for(const name of [...names,'Business','Explicit'])facts.push(fact(`datasets/sample#fields/${name}`,{type:`types/${name}`},[`types/${name}`]));
const index=derivePublishedKnowledge(publication(facts));
for(const name of disabled){
 const key=`types/${name}`,source=`datasets/sample#fields/${name}`;
 const target=resolveFact(index.knowledge,key) as any;
 assert.equal(target.referenced_by,undefined);assert.equal(target.fields,undefined);
 assert.equal(index.links.some(edge=>edge.target===key),false);
 assert.deepEqual((resolveFact(index.knowledge,source) as any).related.types,[key]);
 assert.equal(index.keys.has(key),true);
}
for(const name of ['Explicit'])assert.deepEqual((resolveFact(index.knowledge,`types/${name}`) as any).referenced_by.fields,[`datasets/sample#fields/${name}`]);
assert.throws(()=>derivePublishedKnowledge(publication([fact('types/Bad',{reverse_references:'false'})])),/Invalid reverse reference policy/);
assert.throws(()=>derivePublishedKnowledge(publication([fact('datasets/bad',{reverse_references:false})])),/Invalid reverse reference policy/);
const engine=createJaqEngine(fileURLToPath(new URL('./lib/oks-wti.wasm',import.meta.url)));
try{
 for(const name of [...names,'Business','Explicit']){
  const code=builtinCode('builtin://knowledge/references.jq',{key:`types/${name}`});
  const result=await engine.run(code.text,{input:{knowledge:index.knowledge},timeoutMs:5000,maxBytes:65536,programFile:code.file});
  assert.equal(result.ok,true,JSON.stringify(result));
  assert.equal((result as any).data.total,name==='Explicit'?2:0);
 }
}finally{await engine.dispose();}
console.log('Type policy: nodes/forward navigation retained; reverse navigation/index/query suppressed; default opt-out and explicit opt-in verified');
