import assert from 'node:assert/strict';
import {buildOption,CHART_WIDTH,type OptionInput} from '@hh9527/dari-model';
import {renderEchartsSvg} from '@hh9527/dari-model';
import {dariHost} from '@hh9527/dari-model';
const spec=(kind:OptionInput['kind'],extra:Partial<OptionInput>={}):OptionInput=>({kind,title:null,x:'name',value:'n',series:null,x_type:null,xLabel:null,valueLabel:null,unit:null,...extra});
const rows=[{name:'GigabitEthernet0/0/3',n:2.95},{name:'GigabitEthernet0/0/1',n:2.91},{name:'GigabitEthernet0/0/3',n:2.90},{name:'GigabitEthernet0/0/4',n:2.89},{name:'GigabitEthernet0/0/3',n:2.86}];
const values=(data:any[])=>data.map(v=>typeof v==='object'&&v!==null&&'value'in v?v.value:v);
for(const kind of ['bar','column','line','area','pie'] as const){
 const built=buildOption(rows,spec(kind,{...(kind==='line'||kind==='area'?{x_type:'String'}:{}),style:{labels:true}}));
 const option=built.option as any;
 assert.deepEqual(values(option.series[0].data),rows.map(r=>r.n),kind);
 if(kind==='pie')assert.deepEqual(option.series[0].data.map((p:any)=>p.name),rows.map(r=>r.name));
 else assert.deepEqual((kind==='bar'?option.yAxis:option.xAxis).data,rows.map(r=>r.name));
 const svg=renderEchartsSvg(built.option,CHART_WIDTH,built.height);
 if(kind!=='pie')for(const value of rows.map(r=>String(r.n)))assert(svg.includes(value),`${kind}: lost ${value}`);
 assert(!svg.includes('row:'),`${kind}: internal row identity leaked`);
 if(kind==='bar'||kind==='column'){const text=[...svg.matchAll(/<text\b[^>]*>(.*?)<\/text>/gs)].map(m=>m[1]).join('');assert.equal(text.split('GigabitEthernet0/0/3').length-1,3,kind);}
}
const secondaryRows=rows.map((r,i)=>({...r,other:10+i}));
const secondary=buildOption(secondaryRows,spec('column',{second:{value:'other'},style:{sort:'asc'}})).option as any;
assert.deepEqual(secondary.series[1].data,[14,13,12,11,10]);
const repeated=[{name:'A',series:'S',n:1},{name:'A',series:'S',n:2}];
for(const kind of ['grouped_bar','grouped_column','line','area','heatmap','radar'] as const){
 const input=spec(kind,{series:'series',...(kind==='line'||kind==='area'?{x_type:'String'}:{})});
 assert.throws(()=>buildOption(repeated,input),/第 1、2 行.*同一坐标/,kind);
 assert.throws(()=>buildOption([{...repeated[0],n:null},repeated[1]],input),/同一坐标/,kind);
}
const continuous=buildOption([{name:1,n:2},{name:1,n:3}],spec('line',{x_type:'Int'})).option as any;
assert.deepEqual(continuous.series[0].data,[[1,2],[1,3]]);
const scatter=buildOption([{name:1,n:2},{name:1,n:3},{name:1,n:2}],spec('scatter')).option as any;
assert.equal(scatter.series[0].data.length,3);
assert.equal((buildOption([{name:'A',n:10},{name:'A',n:20}],spec('gauge')).option as any).series.length,2);
const sankey=buildOption(repeated,spec('sankey',{series:'series'}));
assert.deepEqual((sankey.option as any).series[0].links.map((edge:any)=>edge.value),[1,2]);
renderEchartsSvg(sankey.option,CHART_WIDTH,sankey.height);
const nodes=[{id:'A',label:'same',depth:0},{id:'S',label:'same',depth:1}];
const graph=buildOption(repeated,spec('graph',{series:'series'}),nodes);
assert.equal((graph.option as any).series[0].links.length,2);
assert.equal((graph.option as any).series[0].data.length,2);
renderEchartsSvg(graph.option,CHART_WIDTH,graph.height);
assert.throws(()=>buildOption(repeated,spec('graph',{series:'series'}),[...nodes,nodes[0]]),/id 重复/);
assert.throws(()=>buildOption([{name:'A',series:'missing',n:1}],spec('graph',{series:'series'}),nodes),/没有对应节点/);
const wideRows=[{name:'same',cpu:10,mem:20},{name:'same',cpu:30,mem:40}];
const fields:any={name:{kind:'scalar',name:'String'},cpu:{kind:'scalar',name:'Float'},mem:{kind:'scalar',name:'Float'}};
const wide=dariHost.renderFigure('MultiBarChart',{category:'name',metrics:[{value:'cpu',label:'CPU',unit:''},{value:'mem',label:'Memory',unit:''}],style:{labels:true}},wideRows,fields);
for(const n of [10,20,30,40])assert(wide.content.includes('>'+n+'</text>'),`wide: lost ${n}`);
assert(!wide.content.includes('row:'));
const box=buildOption([{name:'A',n:1},{name:'A',n:3},{name:'A',n:5}],spec('box')).option as any;
assert.equal(box.series[0].data[0][2],3);
const histogram=buildOption([{name:'A',n:1},{name:'A',n:1},{name:'A',n:2}],spec('histogram')).option as any;
assert.equal(histogram.series[0].data.reduce((a:number,b:number)=>a+b,0),3);
console.log('Chart families preserve row identity and repeated labels, reject ambiguous alignment, and never implicitly sum or deduplicate');
