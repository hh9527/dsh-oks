import assert from 'node:assert/strict';
import { collectProgrammedKnowledge, programmedKnowledgeContract } from './src/programmed-knowledge.ts';
import { derivePublishedKnowledge } from './src/published-knowledge.ts';
import { renderWholeVocabulary, buildRetrievalIndex } from './src/retrieval.ts';
const graph = {knowledge_contract:'ontology-knowledge-v4',intent_contract:'ontology-intent-v1',addressing:'node-member-uri-v1',revision:'fixture',
  facts:[{key:'datasets/device',value:{},references:[]},{key:'types/detached',value:{},references:[]}],items:[]};
const vocabulary = [{key:'datasets/device',kind:'Dataset',name:'device',doc:'设备清单',aliases:['设备'],owner:null,ownerValue:null}];
const localSecret='not a program input';
const program = `if (arguments.length !== 1 || typeof localSecret !== 'undefined') throw new Error('Unexpected program scope');
return {graph:data.graph,vocabulary:data.vocabulary};`;
const publication = JSON.parse(JSON.stringify({knowledge_contract:programmedKnowledgeContract,program,data:{graph,vocabulary}}));
const before=structuredClone(publication);
for (let i=0;i<2;i++) {
  const built = await collectProgrammedKnowledge(publication);
  assert.deepEqual(built,{graph,vocabulary});
  const index = derivePublishedKnowledge(built.graph,undefined,built.vocabulary);
  assert.equal(index.terms.length,1);
  assert.match(renderWholeVocabulary(index),/设备/);
  const enriched = derivePublishedKnowledge(built.graph,{version:1,items:[{key:'datasets/device',names:['终端'],doc:'补充说明'}]},built.vocabulary);
  assert.equal(enriched.terms[0].doc,'补充说明');
  assert.ok(enriched.terms[0].aliases.includes('终端'));
}
assert.deepEqual(publication,before);
assert.equal(localSecret,'not a program input');
let runtimeCalls=0;
const workspace={publishedKnowledge:publication,settings:{domain:'test'} as any,runner:{send:async()=>{runtimeCalls++;throw new Error('must not call runtime');}} as any};
assert.ok((await buildRetrievalIndex(workspace,'fixture',()=>{})).keys.has('types/detached'));
assert.equal(runtimeCalls,0);
for (const knowledge_contract of ['ontology-knowledge-discovery-v1','ontology-knowledge-v4']) {
  await assert.rejects(collectProgrammedKnowledge({...publication,knowledge_contract}),/Invalid JavaScript knowledge publication/);
}
for (const invalid of [null,{}, {...publication,data:null},{...publication,program:''}]) await assert.rejects(collectProgrammedKnowledge(invalid),/Invalid JavaScript knowledge publication/);
for (const bad of ['return null;', 'return {};', 'return {graph:[],vocabulary:[]};', 'return Promise.resolve({graph:{},vocabulary:[]});']) {
  await assert.rejects(collectProgrammedKnowledge({...publication,program:bad}),/Invalid built knowledge/);
}
await assert.rejects(collectProgrammedKnowledge({...publication,program:'return ('}),SyntaxError);
await assert.rejects(collectProgrammedKnowledge({...publication,program:'throw new Error("model failure");'}),/model failure/);
// A failed execution cannot prevent a subsequent valid load.
assert.deepEqual(await collectProgrammedKnowledge(publication),{graph,vocabulary});
assert.throws(()=>derivePublishedKnowledge(graph,undefined,[...vocabulary,...vocabulary]),/Invalid model vocabulary term/);
assert.throws(()=>derivePublishedKnowledge(graph,undefined,[{...vocabulary[0],key:'types/missing'}]),/Invalid model vocabulary term/);
console.log('static JavaScript knowledge: parsed data, new Function scope, reuse, vocabulary, presentation, errors and no runtime fallback passed');
