import assert from 'node:assert/strict';
import {parseChartSpec,axisValue,shapeProblem} from './src/chart/spec.ts';
import {buildOption,CHART_WIDTH} from './src/chart/option.ts';
import {renderEchartsSvg} from './src/chart/echarts.ts';
import {checkDesign} from './src/draft/design.ts';
import {createDraftBackend} from './src/draft/backend.ts';
import type {WorkspaceEntry} from './src/knowledge.ts';

for(const kind of ['line','area']){
 for(const xType of [undefined,null,'time','number','category']){
  assert('error' in parseChartSpec({kind,x:'at',value:'n',...(xType===undefined?{}:{xType})}));
 }
}
const times=['2026-10-30T00:00:00.000Z','2026-10-31T00:00:00.000Z','2026-11-01T00:00:00.000Z'];
for(const kind of ['line','area'] as const){
 for(const xType of ['Int','Float','String','Rfc3339','EpochMillis'] as const){
  const xs=xType==='Int'?[2026,2027,2028]:xType==='Float'?[1.1,1.8,3.7]:xType==='String'?['甲','乙','丙']:xType==='Rfc3339'?times:times.map(Date.parse);
  const rows=['CPU','Memory'].flatMap((s,j)=>xs.map((at,i)=>({at,s,n:44+i+j,other:10+i})));
  const parsed=parseChartSpec({kind,x:'at',value:'n',series:'s',xType,second:{value:'other'}});
  assert('spec' in parsed);assert.equal(shapeProblem(rows,parsed.spec),null);
  const built=buildOption(rows,{...parsed.spec,sourceLabel:'axis regression'});
  const option=built.option as any;
  assert.equal(option.xAxis.type,xType==='String'?'category':xType==='Rfc3339'||xType==='EpochMillis'?'time':'value');
  if(xType!=='String')for(const s of option.series)for(const point of s.data)assert.equal(typeof point[0],'number');
  const svg=renderEchartsSvg(built.option,CHART_WIDTH,built.height);
  for(const series of option.series){
   assert([...svg.matchAll(/<path\b[^>]*>/g)].some(m=>m[0].includes(`stroke="${series.lineStyle.color}"`)&&/d="M[^\"]+L/.test(m[0])),`${kind}/${xType}/${series.name}: actual line path`);
  }
 }
}
for(const value of ['2026-02-30T00:00:00Z','2026-01-01','2026-01-01T00:00:00',1793318400000,'1793318400000'])assert.equal(axisValue(value,'Rfc3339'),null);
for(const value of [1.5,Infinity,NaN,'1793318400000',8640000000000001])assert.equal(axisValue(value,'EpochMillis'),null);
assert.equal(axisValue('2026-10-30T08:00:00+08:00','Rfc3339'),Date.parse(times[0]));
assert.equal(axisValue('3','Int'),null);assert.equal(axisValue(3,'String'),null);
let reads=0,columnType='String';
const entry={modelHash:'axis-test',settings:{domain:'test',queryMaxRows:100},runner:{async send(){return {ok:{accepted:true,queries:[{sql:'SELECT at,n LIMIT ?',bindings:[3],limit_slot:0,columns:[{name:'at',type:columnType,nullable:false},{name:'n',type:'Float',nullable:false}]}]}};}}} as unknown as WorkspaceEntry;
const newBackend=()=>createDraftBackend({entry,file:'axis.dari',contextZone:()=>({kind:'resolved',timeZone:'UTC'}),knowledge:{executorFor(){reads++;throw new Error('check must not acquire data');}}});
const source=(xType:string)=>`data rows = query({limit:3});figure f = LineChart(spec={x:"at",value:"n",xType:"${xType}"},data=rows);`;
for(const [xType,allowed]of Object.entries({Int:['Int'],Float:['Int','Float'],String:['String'],Rfc3339:['String','DateTimeUtc'],EpochMillis:['Int','EpochMillis']})){
 for(const ty of ['Int','Float','String','DateTimeUtc','EpochMillis','Bool']){
  columnType=ty;const checked=await checkDesign(source(xType),'axis.dari',newBackend());
  assert.equal(checked.ok,allowed.includes(ty),JSON.stringify({xType,ty,diagnostics:checked.diagnostics}));
 }
}
for(const [xType,at]of [['EpochMillis','123.5'],['Rfc3339','"2026-02-30T00:00:00Z"']] as const){
 const checked=await checkDesign(`data rows = data([{at:${at},n:1}]);figure f = AreaChart(spec={x:"at",value:"n",xType:"${xType}"},data=rows);`,'axis.dari',newBackend());
 assert.equal(checked.ok,false,JSON.stringify(checked));
}
assert.equal(reads,0);
console.log('Explicit axis types: required encoding, zero-query type checks, static invalid values, primary/secondary SVG paths for all types and line/area passed');
