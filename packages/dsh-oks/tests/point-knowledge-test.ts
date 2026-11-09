import assert from 'node:assert/strict';
import {readPoints} from '../src/point-knowledge.ts';
import {searchPoints,routePoints} from '../src/point-navigation.ts';
import {renderSearch,renderRoutes} from '../src/navigation-receipt.ts';
const graph:any={datasets:{a:{grain:['tenant','id'],references:[{id:'scoped',fields:['tenant','id']}],fields:{id:{type:'String',nullable:false},tenant:{type:'String'},amount:{type:'Float',roles:['Metric']}},dimensions:{name:{type:'String',filterable:false,projectable:true,ops:['Eq'],canonical_values:['datasets/literal']}},measures:{count:{aggregate:'Count',predicate:{field:'name',input:{Text:'datasets/literal'},op:'Eq'},computed:{left:'n1',op:'Add',right:'n2'},requires:[]}},roles:{owner:{entity:'entities/object',parts:[{source:'tenant',target:'tenant'},{source:'id',target:'id'}]}}},bridge:{fields:{id:{type:'String'}}},b:{dimensions:{cpu:{type:'types/Percent',filterable:true}},fields:{id:{type:'String'}}},isolated:{}},entities:{object:{identity:'types/Identity',roles:['datasets/a#roles/owner']}},types:{Percent:{representation:'Newtype(Float)',reverse_references:false},Identity:{representation:'{tenant: String, id: String}'},Level:{values:{critical:{wires:[{Int:1}],value:'datasets/literal'}}}},relations:{ab:{from_dataset:'datasets/a',to_dataset:'datasets/bridge',key:{op:'eq',from:'datasets/a#fields/id',to:'datasets/bridge#fields/id'},cardinality:{from:'Many',to:'One'}},bc:{from_dataset:'datasets/bridge',to_dataset:'datasets/b',guard:{input:{Text:'datasets/literal'}}}},items:[{key:'datasets/a#dimensions/name',names:['名称'],doc:''},{key:'datasets/b#dimensions/cpu',names:['CPU'],doc:'CPU utilization'}],tools:{secret:{}}};
const before=JSON.stringify(graph);
const ids=['datasets/a','datasets/a/dimensions/name','datasets/a/measures/count','datasets/a/roles/owner','relations/ab','types/Level/values/critical','datasets/missing','datasets/__proto__','tools/secret'];
const info=readPoints(graph,{ids:[...ids,ids[1]]});
assert.equal(info.items.length,6);assert.equal(info.errors?.length,3);
const dim=info.items.find(x=>x.id.endsWith('/dimensions/name'));
assert.equal(dim.facts.filterable,false);assert.deepEqual(dim.facts.canonical_values,['datasets/literal']);assert(!('doc' in dim));
assert(!('fields' in info.items[0].facts));assert.deepEqual(info.items[0].facts.references,[{id:'scoped',fields:['tenant','id']}]);
const measure=info.items.find(x=>x.id.endsWith('/measures/count'));
assert.deepEqual(measure.facts.predicate,graph.datasets.a.measures.count.predicate);assert.deepEqual(measure.facts.computed,graph.datasets.a.measures.count.computed);
assert.equal(info.items.find(x=>x.kind==='Role').facts.parts.length,2);
assert.equal(info.items.find(x=>x.kind==='Relation').facts.key.from,'datasets/a/fields/id');
assert.equal(info.items.find(x=>x.kind==='Value').facts.value,'datasets/literal');
measure.facts.predicate.op='changed';assert.equal(JSON.stringify(graph),before,'returned data must not expose mutable graph aliases');

const search=searchPoints(graph,{q:['名称','CPU'],scope:['datasets/a','datasets/b']});
assert.equal(search.results[0].items[0].id,'datasets/a/dimensions/name');
assert.equal(search.results[1].items[0].type,'types/Percent');
const root=searchPoints(graph,{q:['a'],scope:['datasets','entities']}).results[0];assert(root.items.every(x=>x.id.split('/').length===2));
const missing=searchPoints(graph,{q:['no_such_term'],scope:['datasets/a']});assert.equal(missing.results[0].items.length,0);assert.match(renderSearch({}, {data:missing})[0].text!,/✗ 无命中/);
const scope=searchPoints(graph,{q:['critical'],scope:['types/Level']});assert.equal(scope.results[0].items[0].id,'types/Level/values/critical');
const fields=searchPoints(graph,{q:['id'],scope:['datasets/a/fields','datasets/a']});
assert.equal(fields.results[0].items.filter(p=>p.id==='datasets/a/fields/id').length,1);
assert(searchPoints(graph,{q:['name'],scope:['datasets/a/dimensions']}).results[0].items.every(p=>p.kind==='Dimension'));
assert.equal(searchPoints(graph,{q:['id'],scope:['datasets/isolated/fields']}).results[0].items.length,0);
assert.equal(searchPoints(graph,{q:['id'],scope:['entities/object/fields']}).results[0].items.length,0);
assert.equal(searchPoints(graph,{q:['critical'],scope:['types/Level/values']}).results[0].items[0].id,'types/Level/values/critical');
for(const id of ['datasets/missing/fields','datasets/a/nope','types/Level/references/references','datasets/a/fields/id','types/Level/fields'])assert.throws(()=>searchPoints(graph,{q:['x'],scope:[id]}));
const route=routePoints(graph,{from:'datasets/a',to:'datasets/b'});assert.deepEqual(route.paths[0].nodes,['datasets/a','datasets/bridge','datasets/b']);
assert.deepEqual(route.paths[0].edges.map(e=>e.relation),['relations/ab','relations/bc']);
assert.throws(()=>routePoints(graph,{from:'datasets/a',to:'datasets/b',max_depth:1}));
assert.equal(routePoints(graph,{from:'entities/object',to:'datasets/b'}).status,'connected');
const reverse=routePoints(graph,{from:'datasets/bridge',to:'datasets/a'});assert.match(renderRoutes({}, {data:reverse})[0].text!,/<--\[relations\/ab\]--/);assert.match(renderRoutes({}, {data:reverse})[0].text!,/One→Many/);
assert(renderRoutes({}, {data:route})[0].text!.includes('datasets/a/fields/id = datasets/bridge/fields/id'));
const isolated=routePoints(graph,{from:'datasets/a',to:'datasets/isolated'});assert.match(renderRoutes({}, {data:isolated})[0].text!,/未找到.*路径/);
const dense=structuredClone(graph);for(let i=0;i<25;i++)dense.relations['direct'+i]={from_dataset:'datasets/a',to_dataset:'datasets/b'};
assert.equal(routePoints(dense,{from:'datasets/a',to:'datasets/b'}).paths.length,20);assert(routePoints(dense,{from:'datasets/a',to:'datasets/b'}).truncated);
// Search all and only shortest paths satisfying the ordered waypoints.
function routeGraph(length:number){
  const result:any={datasets:{},relations:{}};
  for(let i=0;i<=length;i++)result.datasets['n'+i]={};
  for(let i=0;i<length;i++)result.relations['r'+i]={from_dataset:'datasets/n'+i,to_dataset:'datasets/n'+(i+1)};
  return result;
}
for(const length of [3,6,9]){
  const chain=routeGraph(length),found=routePoints(chain,{from:'datasets/n0',to:'datasets/n'+length});
  assert.equal(found.paths[0].edges.length,length);
  assert(found.paths.every(p=>new Set(p.nodes).size===p.nodes.length));
}

const alternatives=routeGraph(3);
alternatives.relations.direct={from_dataset:'datasets/n0',to_dataset:'datasets/n3'};
const both=routePoints(alternatives,{from:'datasets/n0',to:'datasets/n3'});
assert.deepEqual(both.paths.map(p=>p.edges.length),[1],'direct connection suppresses longer detours');
assert.deepEqual(routePoints(alternatives,{from:'datasets/n0',to:'datasets/n3'}),both,'stable path order');
assert.equal(routePoints(graph,{from:'datasets/a',to:'datasets/a'}).paths[0].edges.length,0);
const twenty=routeGraph(2);
for(let i=0;i<20;i++)twenty.relations['direct'+i]={from_dataset:'datasets/n0',to_dataset:'datasets/n2'};
assert.equal(routePoints(twenty,{from:'datasets/n0',to:'datasets/n2'}).paths.length,20);
assert.equal(routePoints(twenty,{from:'datasets/n0',to:'datasets/n2'}).truncated,false,'longer paths are not omitted shortest candidates');
// Direct relations suppress two-hop and three-hop routes.
const enough=routeGraph(3);
enough.datasets.bridge={};
enough.relations.short1={from_dataset:'datasets/n0',to_dataset:'datasets/bridge'};
enough.relations.short2={from_dataset:'datasets/bridge',to_dataset:'datasets/n3'};
for(let i=0;i<19;i++)enough.relations['direct'+i]={from_dataset:'datasets/n0',to_dataset:'datasets/n3'};
assert.deepEqual(routePoints(enough,{from:'datasets/n0',to:'datasets/n3'}).paths.map(p=>p.edges.length),Array(19).fill(1));
// The first matching layer excludes N+1 and N+2.
for(const n of [2,3,5]){
  const g:any={datasets:{start:{},end:{}},relations:{}};
  for(const length of [n,n+1,n+2]){
    let previous='start';
    for(let i=1;i<=length;i++){
      const node=i===length?'end':'arm'+length+'_'+i;
      g.datasets[node]={};
      g.relations['edge'+length+'_'+i]={from_dataset:'datasets/'+previous,to_dataset:'datasets/'+node};
      previous=node;
    }
  }
  assert.deepEqual(routePoints(g,{from:'datasets/start',to:'datasets/end'}).paths.map(p=>p.edges.length),[n]);
}
const forced=routePoints(alternatives,{from:'datasets/n0',to:'datasets/n3',via:['datasets/n1','datasets/n2']});
assert.deepEqual(forced.paths[0].nodes,['datasets/n0','datasets/n1','datasets/n2','datasets/n3']);
assert.match(renderRoutes({}, {data:forced})[0].text!,/必经节点（依次）：datasets\/n1 → datasets\/n2/);
assert.equal(routePoints(alternatives,{from:'datasets/n0',to:'datasets/n3',via:['datasets/n2','datasets/n1']}).status,'not_connected');
assert.deepEqual(routePoints(graph,{from:'datasets/a',to:'datasets/b',via:[]}),route);
assert.equal(routePoints(graph,{from:'datasets/a',to:'datasets/b',via:['entities/object','datasets/bridge']}).paths[0].edges.length,2);
assert.equal(routePoints(graph,{from:'datasets/a',to:'datasets/b',via:['datasets/a','datasets/b']}).status,'connected');
const deadEnd=routeGraph(2);
deadEnd.datasets.leaf={};
deadEnd.relations.leaf={from_dataset:'datasets/n1',to_dataset:'datasets/leaf'};
assert.equal(routePoints(deadEnd,{from:'datasets/n0',to:'datasets/n2',via:['datasets/leaf']}).status,'not_connected','separately connected legs must not repeat a node');
const diamond=routeGraph(2);
diamond.datasets.other={};
diamond.relations.other1={from_dataset:'datasets/n0',to_dataset:'datasets/other'};
diamond.relations.other2={from_dataset:'datasets/other',to_dataset:'datasets/n2'};
assert.equal(routePoints(diamond,{from:'datasets/n0',to:'datasets/n2'}).paths.length,2,'retain all equal-length alternatives');
for(const args of [{queries:[]},{q:[],scope:['datasets']},{q:[' '],scope:['datasets']},{q:'id',scope:['datasets']},{q:['id'],scope:['datasets/no']},{q:['id'],scope:[]},{q:['id']},{scope:['datasets/a']},{q:['x'],scope:['datasets'],extra:true},[{q:['id'],scope:['datasets']}]] )assert.throws(()=>searchPoints(graph,args as any));
for(const args of [{from:'a',to:'datasets/b'},{from:'datasets/a',to:'types/Level'},{from:'datasets/a',to:'datasets/b',max_depth:4},{from:'datasets/a',to:'datasets/b',via:'datasets/bridge'},{from:'datasets/a',to:'datasets/b',via:['types/Level']},{from:'datasets/a',to:'datasets/b',via:['datasets/missing']},{from:'datasets/a',to:'datasets/b',via:[1]}])assert.throws(()=>routePoints(graph,args));
const many=structuredClone(graph);for(let i=0;i<40;i++)many.datasets.a.dimensions['metric_'+i]={type:'Float'};
const batch=searchPoints(many,{q:['metric','metric','metric','metric'],scope:['datasets/a','datasets/a']});assert.equal(batch.results.reduce((n,r)=>n+r.items.length,0),40);assert(batch.results.every(r=>r.truncated));
assert.throws(()=>searchPoints(many,{queries:[{q:'metric',scope:['datasets/a'],take:40}]}));
assert.throws(()=>searchPoints(graph,{queries:[{q:'a'}]}));
assert.throws(()=>searchPoints(graph,{q:['a'],scope:['relations']}));
assert(searchPoints(graph,{q:['Level'],scope:['types']}).results[0].items.some(x=>x.id==='types/Level'));
const full=renderSearch({}, {data:search}).map(x=>x.text).join('');assert.match(full,/## datasets\/a\/dimensions/);assert(!full.includes('score'));assert(!full.includes('matched_terms'));
assert.equal(JSON.stringify(graph),before);
console.log('Knowledge navigation: scoped batches, no total cap, types, exact reads, direct/reverse/entity paths, bounds and Markdown passed');
