import assert from 'node:assert/strict';
import {queryKnowledge} from './src/knowledge-methods.ts';
const graph:any={items:[
 {key:'datasets/alarms#dimensions/MECATEGORY',names:['告警分类'],doc:'Alarm category'},
 {key:'datasets/alarms#dimensions/alarm_severity',names:['告警级别'],doc:'Severity'},
 {key:'datasets/alarms#dimensions/tenant_name',names:['Tenant name'],doc:'租户'},
 {key:'datasets/alarms#measures/alarm_count',names:['告警数量'],doc:'Alarm count'},
 {key:'datasets/other#dimensions/category',names:['告警分类'],doc:'Category'},
 {key:'datasets/alarms#dimensions/device_cpu_usage',names:['CPU usage'],doc:'CPUUsage ratio'},
]};
const original=JSON.stringify(graph);
const search=(args:any)=>queryKnowledge(graph,'search',{take:50,...args}) as any;
const multiple=search({query:'MECATEGORY 告警分类',dataset:'alarms'});
assert.equal(multiple.items[0].id,'MECATEGORY');
assert.deepEqual(multiple.items[0].matched_terms,['mecategory','告警分类']);
const alternatives=search({query:'category type domain 分类 类别',type:'dimension',dataset:'alarms'});
assert.equal(alternatives.items[0].id,'MECATEGORY');
assert(alternatives.items.every((i:any)=>i.type==='Dimension'&&i.dataset==='alarms'));
for(const type of ['Dimension','dimension','DIMENSION','dimensions'])assert.deepEqual(search({query:'告警',type}),search({query:'告警',type:'Dimension'}));
assert.throws(()=>search({query:'告警',type:'dimensoin'}),/Unknown knowledge type/);
assert.equal(search({query:'severty',dataset:'alarms'}).items[0].id,'alarm_severity');
assert.equal(search({query:'sevreity',dataset:'alarms'}).items[0].id,'alarm_severity');
assert.equal(search({query:'SeVeRiTy',dataset:'alarms'}).items[0].id,'alarm_severity');
assert.equal(search({query:'ＣＰＵ',dataset:'alarms'}).items[0].id,'device_cpu_usage');
assert.equal(search({query:'datasets/alarms/dimensions/MECATEGORY'}).items[0].id,'MECATEGORY');
assert.equal(search({query:'cpu ratio'}).items[0].id,'device_cpu_usage');
assert.equal(search({query:'notfoundxyz'}).total,0);
assert.throws(()=>search({query:'!!!'}),/searchable words/);
const all=search({query:'告警 category',dataset:'alarms'});
assert.deepEqual(search({query:'告警 category',dataset:'alarms',skip:1,take:1}).items,all.items.slice(1,2));
assert.deepEqual(search({query:'告警 category',dataset:'alarms'}),all);
assert.equal(JSON.stringify(graph),original);
console.log('Knowledge search: multiple alternatives, coverage ranking, Chinese, partial words, typos, Unicode, categories, paging and immutable graph passed');
