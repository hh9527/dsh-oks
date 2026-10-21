import assert from 'node:assert/strict';
import {createJaqEngine} from './src/jaq.ts';
import {createKtools} from './src/ktools.ts';
import {builtinCode,builtinKtoolsSource} from './src/knowledge-programs.ts';
const enc=encodeURIComponent;
const id='alarm/a#中文',ty='级别/a',dim='level/#',relation='join/a#';
const dataset='datasets/'+enc(id),type='types/'+enc(ty),field=dataset+'#fields/'+enc(dim),dimension=dataset+'#dimensions/'+enc(dim),rel='relations/'+enc(relation);
const values=['wire_1','major/a'].map(v=>type+'#values/'+enc(v));
const graph={datasets:{[id]:{grain:['id'],fields:{[dim]:{types:[type],datasets:[dataset]}},dimensions:{[dim]:{field:dim,fields:[field],type:ty,types:[type],ops:['Eq'],values,filterable:true}},measures:{n:{aggregate:'Sum',field:'n'}},time_roles:{clock:{encoding:'EpochMillis'}},relations:[rel]},other:{grain:['other']},source_mirror:{grain:['id']}},
 types:{[ty]:{canonical_order:['major/a','wire_1'],values:{wire_1:{wires:[{Int:1}]},'major/a':{wires:[{Int:2}]}},fields:[field],dimensions:[dimension],related:{datasets:[dataset]}}},
 relations:{[relation]:{from_dataset:id,to_dataset:'other',cardinality:{from:'Many',to:'One'},datasets:[dataset,'datasets/other']}},tools:{},
 items:[{key:dataset,names:['告警'],doc:'Dataset meaning'},{key:field,names:['存储级别'],doc:'Field meaning'},{key:dimension,names:['业务级别'],doc:'Dimension meaning'},{key:type,names:['告警级别'],doc:'Type meaning'},{key:values[0],names:['有业务名的 wire 值'],doc:'Do not hide named values'},{key:values[1],names:['严重'],doc:'Major'},{key:rel,names:['归属'],doc:'Relation meaning'},{key:'datasets/other',names:['其他'],doc:''},{key:'datasets/source_mirror',names:['镜像'],doc:''}]};
const engine=createJaqEngine(process.argv[2]??'lib/oks-wti.wasm');
const library=createKtools(engine.checkLibrary,engine.run);
const run=async(name:string,args:Record<string,unknown>={},input:unknown=graph)=>{
 const code=await library.program('','oks://builtin/tools/ktools.lib.jq#'+name,args);
 const out=await engine.runDocument(code.text,input,{input:null,timeoutMs:5000,maxBytes:8*1024*1024,programFile:code.file});
 assert.ok(out.ok);return out.data as any;
};
try {
 assert.match(builtinKtoolsSource,/def overview\(\$args\)/);
 const overview=await run('overview');assert.equal(overview.total,3);assert.equal(overview.datasets.find((d:any)=>d.id===id).label,'告警');
 assert.equal(overview.datasets.find((d:any)=>d.id===id).key,dataset);
 assert.equal((await run('overview',{include_source:false})).total,2);
 const page=await run('overview',{take:1});assert.equal(page.datasets.length,1);assert.equal(page.next,1);assert.equal(page.truncated,true);
 assert.equal((await run('overview',{skip:3})).datasets.length,0);
 const card=await run('card',{id,docs:true});assert.equal(card.label,'告警');assert.deepEqual(card.grain,['id']);
 assert.equal(card.dimensions[0].key,dimension);assert.equal(card.dimensions[0].label,'业务级别');assert.equal(card.dimensions[0].doc,'Dimension meaning');assert.deepEqual(card.dimensions[0].ops,['Eq']);
 assert.equal(card.relations[0].id,relation);assert.deepEqual(card.relations[0].cardinality,{from:'Many',to:'One'});
 assert.equal(card.time_roles[0].encoding,'EpochMillis');assert.equal(card.counts.values,2);
 assert.equal(card.values[0].values[0].label,'有业务名的 wire 值');assert.deepEqual(card.values[0].canonical_order,['major/a','wire_1']);
 const first=await run('card',{id,section:'values',take:1});assert.equal(first.dimensions,undefined);assert.equal(first.values[0].total,2);assert.equal(first.values[0].next,1);assert.equal(first.values[0].truncated,true);
 assert.equal((await run('card',{id,section:'values',take:1,value_skip:1})).values[0].values[0].id,'major/a');
 const shape=await run('card',{id,section:'shape'});assert.equal(shape.dimensions,undefined);assert.equal(shape.counts.dimensions,1);
 const docs=await run('nodes',{keys:[dimension]});assert.equal(docs[0].label,'业务级别');assert.equal(docs[0].facts,undefined);assert.ok(docs[0].outline.some((x:any)=>x.fact==='ops'));
 const facts=await run('nodes',{keys:[type,values[1],'types/missing'],mode:'both',take:1,expand:['canonical_order']});
 assert.equal(facts[0].facts.find((f:any)=>f.fact==='values').truncated,true);assert.equal(facts[0].facts.find((f:any)=>f.fact==='values').total,2);
 assert.deepEqual(facts[0].facts.find((f:any)=>f.fact==='canonical_order').value,['major/a','wire_1']);assert.equal(facts[1].label,'严重');assert.equal(facts[2].error,'unknown node');
 const routes=await run('routes',{nodes:[dataset,type],max_depth:2});assert.ok(routes.path_count>=2);assert.equal(routes.truncated,false);
 assert.ok(routes.paths.some((p:any)=>p.nodes.includes(field)));assert.ok(routes.paths.some((p:any)=>p.nodes.includes(dimension)));
 const via=await run('routes',{nodes:[dataset,type],via:['fields','types']});assert.equal(via.path_count,1);assert.deepEqual(via.paths[0].nodes,[dataset,field,type]);
 assert.deepEqual((await run('routes',{nodes:[type,dataset],via:['related.datasets']})).paths[0].via,['related.datasets']);
 const avoid=await run('routes',{nodes:[dataset,type],avoid:['#dimensions/']});assert.ok(avoid.paths.every((p:any)=>!p.nodes.includes(dimension)));
 const one=await run('routes',{nodes:[dataset,type],max_paths:1});assert.equal(one.path_count,1);assert.equal(one.truncated,true);
 const capped=await run('routes',{nodes:[dataset,type],budget:1});assert.ok(capped.search.candidates<=1);assert.equal(capped.truncated,true);
 const depth=await run('routes',{nodes:[dataset,type],max_depth:1});assert.equal(depth.path_count,0);assert.equal(depth.depth_capped,true);
 assert.equal((await run('routes',{nodes:[dataset,values[1]],max_depth:4})).path_count>0,true,'known leaf endpoint needs no outgoing edges');
 assert.equal((await run('routes',{nodes:[values[1],values[1]]})).paths[0].hops,0);
 assert.equal((await run('routes',{nodes:[values[1],dataset]})).path_count,0);
 await assert.rejects(run('routes',{nodes:[dataset,'types/missing']}),/Unknown route endpoint/);
 await assert.rejects(run('card',{id:'missing'}),/Unknown dataset/);
 for(const [name,args]of [
  ['overview',{take:0}],['overview',{skip:-1}],['overview',{include_source:'yes'}],['overview',{unknown:1}],
  ['card',{}],['card',{id,section:'oops'}],['card',{id,docs:1}],['card',{id,value_skip:-1}],
  ['nodes',{}],['nodes',{keys:'x'}],['nodes',{keys:Array(51).fill(type)}],['nodes',{keys:[type],mode:'oops'}],['nodes',{keys:[type],expand:[1]}],
  ['routes',{nodes:[dataset]}],['routes',{nodes:[dataset,type],budget:0}],['routes',{nodes:[dataset,type],budget:20001}],
  ['routes',{nodes:[dataset,type],max_depth:9}],['routes',{nodes:[dataset,type],max_paths:51}],['routes',{nodes:[dataset,type],via:'fields'}],
 ] as const)assert.throws(()=>builtinCode(`builtin://knowledge/${name}.jq`,args));
 await assert.rejects(library.program('','oks://builtin/tools/ktools.lib.jq#__kindex',{}));
 console.log('harvested builtin methods: encoded IDs, descriptions, values, pagination, categorized paths, cycles, leaf endpoints, hard search caps and argument validation passed');
}finally{engine.dispose();}
