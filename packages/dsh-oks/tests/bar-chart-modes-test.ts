import {dariLiteral} from './test-dari.ts';
import assert from 'node:assert/strict';
import {parseChartSpec} from '../src/chart/spec.ts';
import {buildOption,CHART_WIDTH} from '../src/chart/option.ts';
import {renderEchartsSvg} from '../src/chart/echarts.ts';
import {createDraftBackend} from '../src/draft/backend.ts';
import {checkDesign} from '../src/draft/design.ts';
const colors=['#d32f2f','#f57c00','#fbc02d','#1976d2'];
const rows=[{level:'Critical',n:3},{level:'Major',n:-6},{level:'Minor',n:2},{level:'Warning',n:1}];
function build(kind:string,extra:object={},data=rows){
 const parsed=parseChartSpec({kind,x:'level',value:'n',style:{colors},...extra});
 assert('spec' in parsed,JSON.stringify(parsed));return buildOption(data,parsed.spec);
}
for(const kind of ['bar','column']){
 for(const sort of ['none','desc','asc']){
  const built=build(kind,{style:{colors,sort}}),option=built.option as any;
  assert.equal(option.legend,undefined);
  const axis=kind==='bar'?option.yAxis:option.xAxis;
  option.series[0].data.forEach((p:any,i:number)=>assert.equal(p.itemStyle.color,colors[rows.findIndex(r=>r.level===axis.data[i])]));
  const svg=renderEchartsSvg(built.option,CHART_WIDTH,built.height);
  for(const color of colors)assert(svg.includes(`fill="${color}"`),kind+' missing '+color);
 }
 assert((build(kind,{style:{colors:['#123456']}}).option as any).series[0].data.every((p:any)=>p.itemStyle.color==='#123456'));
 const groupedKind='grouped_'+kind,grouped=build(groupedKind,{series:'level'}).option as any;
 assert(grouped.legend);assert.equal(grouped.series.length,4);
 grouped.series.forEach((s:any,i:number)=>{assert.equal(s.itemStyle.color,colors[i]);assert(s.data.every((p:any)=>p===null||typeof p==='number'));});
 const one=build(groupedKind,{series:'level'},[rows[1]]).option as any;
 assert(one.legend);assert.equal(one.series[0].itemStyle.color,colors[0]);assert.equal(one.series[0].data[0],-6);
 assert.match((parseChartSpec({kind,x:'level',value:'n',series:'level'}) as any).error,/Grouped/);
 assert.match((parseChartSpec({kind:groupedKind,x:'level',value:'n'}) as any).error,/requires spec.series/);
 assert('error' in parseChartSpec({kind:groupedKind,x:'level',value:'n',series:''}));
 const many=Array.from({length:40},(_,i)=>({level:String(i),n:i}));
 assert.equal((build(kind,{entityColor:true},many).option as any).series[0].data.length,40);
}
// Horizontal charts allocate one row per category: every category must stay visible.
for(const kind of ['bar','grouped_bar']){
 const data=Array.from({length:5},(_,i)=>({level:`租户-${i+1}`,n:10-i}));
 const built=build(kind,{title:'最近3个完整自然日未清除告警数量最多的5个租户',xLabel:'租户',valueLabel:'未清除告警数',unit:'条',style:{labels:true},...(kind==='grouped_bar'?{series:'level'}:{})},data);
 const svg=renderEchartsSvg(built.option,CHART_WIDTH,built.height);
 for(const row of data)assert(svg.includes(row.level),kind+' missing category label '+row.level);
 assert.equal((built.option as any).yAxis.axisLabel.interval,0);
 assert.equal((built.option as any).yAxis.axisLabel.hideOverlap,false);
}
// Font units determine geometry, independently of the actual label text.
{
 const {fontUnits}=await import('../src/chart/shared.ts');
 for(const font of [8,12,18])for(const count of [1,2,5,20]){
  const data=Array.from({length:count},(_,i)=>({level:`租户-${i+1}`,n:10+i}));
  for(const kind of ['bar','grouped_bar']){
   const built=build(kind,{title:'按存储设备类型的设备台数分布',layout:{labelFont:font},...(kind==='grouped_bar'?{series:'level'}:{})},data);
   const option=built.option as any,grid=option.grid;
   assert.equal(built.height-grid.top-grid.bottom,
    kind==='bar'?count*fontUnits(font).row:count*count*fontUnits(font).row+(count-1)*fontUnits(font).gap);
   const svg=renderEchartsSvg(built.option,CHART_WIDTH,built.height);
   const marks=[...svg.matchAll(/<path[^>]*d="([^"]+)"[^>]*ecmeta_series_index=[^>]*ecmeta_ssr_type="chart"/g)];
   assert.equal(marks.length,count);
   for(const mark of marks){
    const thickness=Number(mark[1].match(/l0 ([\d.]+)/)?.[1]);
    assert(Math.abs(thickness-fontUnits(font).bar)<0.2,`${kind} font=${font}: ${mark[1]}`);
   }
  }
 }
 const base=build('bar',{title:'short'},[{level:'short',n:1},{level:'also short',n:2}]);
 const long=build('bar',{title:'short'},[{level:'这是很长的分类名称但不应改变字体和几何布局',n:1},{level:'another much longer label',n:2}]);
 assert.equal(base.height,long.height);assert.deepEqual((base.option as any).grid,(long.option as any).grid);
 assert.equal((long.option as any).yAxis.axisLabel.fontSize,12);
 const largeTitle=build('bar',{title:'很长的标题'.repeat(20)},[{level:'A',n:1},{level:'B',n:2}]);
 assert(largeTitle.height>base.height);
 assert.equal(largeTitle.height-(largeTitle.option as any).grid.top-(largeTitle.option as any).grid.bottom,60);
 const crowded=build('grouped_column',{series:'level'},Array.from({length:10},(_,i)=>({level:`series${i}`,n:i+1})));
 assert((crowded.option as any).grid.top>(build('grouped_column',{series:'level'},[rows[0]]).option as any).grid.top);
 for(const key of ['height','rowHeight'])assert('error' in parseChartSpec({kind:'bar',x:'level',value:'n',layout:{[key]:200}}));
 console.log('Font geometry: actual SVG bar thickness, 1/2/5/20 categories, grouped rows, title/legend space and removed pixel overrides passed');
}

const backend=createDraftBackend({entry:{} as any,file:'modes.dari',contextZone:()=>({kind:'resolved',timeZone:'UTC'}),knowledge:{executorFor(){throw Error('No SQL in chart checks');}}});
for(const [component,series,ok]of [
 ['ColumnChart','',true],['BarChart','',true],
 ['GroupedColumnChart',',series:"level"',true],['GroupedBarChart',',series:"level"',true],
 ['ColumnChart',',series:"level"',false],['BarChart',',series:"level"',false],
 ['GroupedColumnChart','',false],['GroupedBarChart','',false],
] as const){
 const source=`data rows = table(${dariLiteral(rows)},{kind:"example"});\nfigure chart = tree! { ${component}(spec={x:"level",value:"n"${series}},data=rows) };`;
 const checked=await checkDesign(source,'modes.dari',backend);assert.equal(checked.ok,ok,component+' '+JSON.stringify(checked));
}
console.log('Plain/category colors, grouped/series colors, single-group legends, sorting, negative values and DARI checks passed');
