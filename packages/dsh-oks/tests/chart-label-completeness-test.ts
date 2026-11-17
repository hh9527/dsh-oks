import assert from 'node:assert/strict';
import {buildOption,CHART_WIDTH} from '@hh9527/dari-model';
import {renderEchartsSvg} from '@hh9527/dari-model';
const names=['江州市瑞禾保险代理有限公司 · 打印机','江州市安澄综合门诊部 · 交换机','望舒云计算有限公司 · 无线控制器','清源护理院 · 交换机','清源护理院 · 路由器'];
const text=(svg:string)=>[...svg.matchAll(/<text\b[^>]*>(.*?)<\/text>/gs)].map(m=>m[1]).join('');
for(const kind of ['column','bar','grouped_column','grouped_bar','line','area','heatmap'] as const){
 const rows=names.map((name,i)=>({name,n:89-i,series:'CPU 平均使用率的完整业务序列名称'}));
 const built=buildOption(rows,{kind,title:null,x:'name',value:'n',series:kind==='heatmap'||kind.startsWith('grouped')?'series':null,x_type:kind==='line'||kind==='area'?'String':null,xLabel:null,valueLabel:null,unit:null});
 const option=built.option as any;
 const category=kind.endsWith('bar')?option.yAxis:option.xAxis;
 assert.equal(category.axisLabel.interval,0,kind);assert.equal(category.axisLabel.hideOverlap,false,kind);
 const svg=renderEchartsSvg(built.option,CHART_WIDTH,built.height);
 for(const name of names)assert(text(svg).includes(name),`${kind}: missing full category ${name}`);
 assert(!svg.includes('...'),`${kind}: labels must not be truncated`);
 if(option.legend)assert(text(svg).includes(rows[0].series),`${kind}: full legend must be visible`);
}
console.log('Chart labels: all five T6 categories and full legends survive SVG rendering across categorical charts');
