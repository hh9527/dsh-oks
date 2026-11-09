import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdtempSync,openSync,closeSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {derivePublishedKnowledge} from '../src/published-knowledge.ts';
import {discoverConcepts} from '../src/concept-knowledge.ts';
import {readPoints} from '../src/point-knowledge.ts';

const [artifact,runner]=process.argv.slice(2);
assert(artifact&&runner,'Usage: concept-model-acceptance.mjs model.wasm telora-run');
const module=new WebAssembly.Module(readFileSync(artifact));
const info=JSON.parse(new TextDecoder().decode(WebAssembly.Module.customSections(module,'telora.build.information')[0]));
const publication=info.entries['ontology.knowledge'];
const built=new Function('data',publication.program)(publication.data);
const {knowledge}=derivePublishedKnowledge(built.graph,undefined,built.vocabulary);
const read=id=>readPoints(knowledge,{ids:[id]}).items[0];
const discover=args=>discoverConcepts(knowledge,{queries:[args]}).queries[0].results;
const cpu=discover({entity:'Device',props:['cpu']}).find(p=>p.name==='cpu_usage');
assert(cpu);
const cpuMean=read(cpu.measures.find(id=>id.endsWith('/cpu_usage')));
const severity=discover({entity:'Alarm',props:['count'],values:['Critical']});
const count=read(severity.find(p=>p.name==='alarm_count').counters[0]);
const classification=read(severity.find(p=>p.name==='severity').dimensions[0]);
const ssid=discover({entity:'Ssid',props:['connected']}).find(p=>p.name==='connected_terminals');
assert(ssid&&ssid.entity==='entities/Ssid');
const connected=read(ssid.measures.find(id=>id.endsWith('/ap_ssid_connected_terminals')));
const intents=[
 {op:'Graph',root:'k',nodes:[{id:'k',entity:cpuMean.dataset}],edges:[],select:[],measures:[{node:'k',measure:cpuMean.measure}],limit:500},
 {op:'Graph',root:'a',nodes:[{id:'a',entity:count.dataset}],edges:[],select:[],filters:[{node:'a',dimension:classification.dimension,op:'Eq',value:'Critical'}],measures:[{node:'a',measure:count.measure}],limit:500},
 {op:'Graph',root:'s',nodes:[{id:'s',entity:connected.dataset}],edges:[],select:[],measures:[{node:'s',measure:connected.measure}],limit:500}
];
function transform(intents){
 const dir=mkdtempSync(join(tmpdir(),'ic-concept-request-'));
 const input=join(dir,'input.json');writeFileSync(input,JSON.stringify({method:'ic/transform',input:{intents}}));
 const fd=openSync(input,'r');
 try {
  const run=spawnSync(runner,[artifact],{stdio:[fd,'pipe','pipe'],encoding:'utf8',timeout:15000,maxBuffer:8*1024*1024});
  assert.ifError(run.error);assert.equal(run.status,0,run.stderr);return JSON.parse(run.stdout);
 } finally {closeSync(fd);rmSync(dir,{recursive:true,force:true});}
}
const result=transform(intents);
assert.equal(result.accepted,true,JSON.stringify(result));
assert.equal(result.queries.length,3);
assert.ok(result.queries.every(query=>query.columns.length===1));
const invalid=transform([{...intents[0],measures:[{node:'k',measure:'not_a_declared_measure'}]}]);
assert.equal(invalid.accepted,false);
console.log('Passed: built IC knowledge → conceptual discovery → exact query names → actual transform (CPU, enum-filtered count, SSID), plus invalid measure rejection');
