import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {readBuildInformation} from '../../packages/dsh-oks/src/service-metadata.ts';
import {collectProgrammedKnowledge} from '../../packages/dsh-oks/src/programmed-knowledge.ts';
import {derivePublishedKnowledge} from '../../packages/dsh-oks/src/published-knowledge.ts';
import {semanticKnowledge} from '../../packages/dsh-oks/src/semantic-knowledge.ts';
import {discoverPoints,readPoints} from '../../packages/dsh-oks/src/point-knowledge.ts';
const [domain,artifact,runner]=process.argv.slice(2);
assert(['ic','ns'].includes(domain)&&artifact&&runner,'Usage: check-model.mjs ic|ns model.wasm telora-run');
const publication=readBuildInformation(readFileSync(artifact))['ontology.knowledge'];
const built=await collectProgrammedKnowledge(publication);
const graph=derivePublishedKnowledge(built.graph,undefined,built.vocabulary).knowledge;
const datasets=domain==='ic'?['current_alarm','device_kpi','tenant']:['alarm-record','kpi-server-device','physical-server'];
const words=domain==='ic'?[['alarm_severity','critical_alarm_count','alarm_occur_utc_raw'],['cpu_usage','memory_usage','device_kpi_ts_raw'],['tenant_name']]
 :[['ar_severity','ar_count','ar_occur_ms'],['sede_cpu_usage','sede_mem_usage','sede_sample_time'],['ps_name']];
const anchors=datasets.map((name,i)=>({id:'datasets/'+name,terms:words[i]}));
const bytes=x=>Buffer.byteLength(JSON.stringify(x));
const baseline=datasets.map(id=>semanticKnowledge(graph,'card',{id:'datasets/'+id,section:'all'}));
const started=performance.now(),cap=discoverPoints(graph,{anchors}),capMs=performance.now()-started;
assert(cap.anchors.every(a=>!a.unresolved_terms.length),JSON.stringify(cap.anchors));
let disconnected;
if(domain==='ns'){
 const negative=discoverPoints(graph,{anchors:[{id:'datasets/alarm-record'},{id:'datasets/dev-info'}]});
 assert.equal(negative.connections[0].status,'not_found_within_depth');
 disconnected=negative.connections[0];
}
const selected=[];
for(const anchor of cap.anchors)for(const match of anchor.matches){
 const exact=match.ids.filter(id=>decodeURIComponent(id.split('/').at(-1))===match.term);
 assert(exact.length,'No exact point for '+match.term);
 selected.push(...exact);
}
const paths=[];
for(const source of datasets.slice(0,2)){
 const pair=cap.connections.find(c=>[c.from,c.to].includes('datasets/'+source)&&[c.from,c.to].includes('datasets/'+datasets[2]));
 assert(pair?.paths.length,'No path between '+source+' and '+datasets[2]);
 paths.push(pair.paths[0]);selected.push(...pair.paths[0].relations);
}
const infoStart=performance.now(),info=readPoints(graph,{ids:selected}),infoMs=performance.now()-infoStart;
assert(!info.errors,JSON.stringify(info.errors));
for(const ids of Object.values(cap.index))for(let i=0;i<ids.length;i+=64)assert(!readPoints(graph,{ids:ids.slice(i,i+64)}).errors,'Every indexed point is readable');
const facts=new Map(info.items.map(p=>[p.id,p.facts]));
const intents=paths.map((path,i)=>{
 const aliases=new Map(path.nodes.map((id,j)=>[id,'n'+j]));
 const root='datasets/'+datasets[i],target='datasets/'+datasets[2];
 const nodes=path.nodes.map(id=>({id:aliases.get(id),entity:decodeURIComponent(id.split('/')[1])}));
 const edges=path.relations.map(id=>{const r=facts.get(id);assert(r);return {relation:decodeURIComponent(id.split('/')[1]),from:aliases.get(r.from_dataset),to:aliases.get(r.to_dataset)};});
 const dimension=words[2][0],measure=words[i][i===0?1:0],time=words[i][2],type=facts.get(root+'/dimensions/'+time).input_kinds;
 const epoch=type?.includes('EpochMillis'),start='2026-10-28T00:00:00.000Z',end='2026-10-31T00:00:00.000Z';
 return {op:'Graph',root:aliases.get(root),nodes,edges,select:[{node:aliases.get(target),dimension}],measures:[{node:aliases.get(root),measure}],time_windows:domain==='ns'&&i===0?[]:[{node:aliases.get(root),dimension:time,start:epoch?Date.parse(start):start,end:epoch?Date.parse(end):end}],limit:100};
});
const child=spawn(runner,[artifact,'--serve','stdio+jsonl://','--request-fuel','10000','--with-memory-limit','256']);
let stderr='';child.stderr.on('data',d=>{stderr+=d});const closed=new Promise(resolve=>child.once('close',resolve));
const timer=setTimeout(()=>child.kill(),30000),lines=createInterface({input:child.stdout});
try{
 child.stdin.write(JSON.stringify({method:domain+'/transform',input:{intents}})+'\n');
 const first=await lines[Symbol.asyncIterator]().next();assert(!first.done,stderr);const response=JSON.parse(first.value);
 assert.equal(response.error,false,JSON.stringify(response));assert.equal(response.ok.accepted,true,JSON.stringify(response.ok.diagnostics));assert.equal(response.ok.queries.length,2);
 const selectedInfoBytes=bytes(info),capBytes=bytes(cap),baselineBytes=bytes(baseline);
 console.log(JSON.stringify({domain,anchors,disconnected,baselineBytes,capBytes,selectedInfoBytes,totalBytes:capBytes+selectedInfoBytes,reductionPercent:Math.round((1-(capBytes+selectedInfoBytes)/baselineBytes)*100),indexedPoints:Object.values(cap.index).reduce((n,ids)=>n+ids.length,0),readPoints:info.items.length,capMs:Math.round(capMs*100)/100,infoMs:Math.round(infoMs*100)/100,paths:cap.connections.map(c=>({from:c.from,to:c.to,candidates:c.paths.length,truncated:c.truncated})),transformAccepted:true,columns:response.ok.queries.map(q=>q.columns)},null,2));
}finally{clearTimeout(timer);lines.close();child.stdin.end();await closed;}
