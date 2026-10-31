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

const render = (terms: any[]) => renderWholeVocabulary({terms} as any);
const term = (key: string, name: string, kind = 'Field', aliases: string[] = [], doc = '') =>
  ({...vocabulary[0],key,name,kind,aliases,doc});
assert.equal(render([term('datasets/device','设备','Dataset',['终端','NE'],'设备清单')]),
  '[datasets/device]\n- 设备,终端,NE;设备清单');
const dictionary = render([
  term('datasets/a#fields/x','CPU'), term('datasets/a#dimensions/x','CPU'),
  term('datasets/b#fields/x','CPU'),
  term('datasets/a#bindings/%7Bsecret%7D','{"value":"x"}','Binding'),
  term('datasets/a#bindings/generated','["sample"]','Binding',['业务别名']),
  term('datasets/a#roles/role_63','role_63','Role'),
  term('types/level#values/0','0','Value'),
  term('types/level#values/major','major','Value',[],'重要'),
  term('dimension_groups/'+'a'.repeat(64),'a'.repeat(64),'DimensionGroup',['ns/dimension/0']),
  term('measure_groups/'+'b'.repeat(64),'b'.repeat(64),'MeasureGroup',['流量']),
]);
assert.equal(dictionary.match(/- CPU;/g)?.length,2); // 同上下文去重，跨上下文保留。
assert.match(dictionary,/- 业务别名;/);
assert.match(dictionary,/- 0;/);
assert.match(dictionary,/- major;重要/);
assert.match(dictionary,/\[分组 流量\]/);
assert.doesNotMatch(dictionary,/secret|sample|role_63|ns\/dimension|[ab]{64}|#fields/);
assert.equal(render([term('types/a:b','a,b;c','Ty',['"quoted"','x\\y','line\nnext'],'first\r\nsecond;detail:literal,comma')]),
  '[types/a:b]\n- a b c,"quoted",x y,line next;first second detail literal comma');
assert.match(render([term('types/checksum#values/hex','c'.repeat(64),'Value')]), /c{64}/);
assert.equal(render([]),'');
console.log('VA dictionary: context deduplication, business aliases, enum values and generated-identity filtering passed');
