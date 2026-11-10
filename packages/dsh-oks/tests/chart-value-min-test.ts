import assert from 'node:assert/strict';
import {parseChartSpec,shapeProblem} from '../src/chart/spec.ts';
import {buildOption,CHART_WIDTH} from '../src/chart/option.ts';
import {renderEchartsSvg} from '../src/chart/echarts.ts';
for(const kind of ['bar','column','grouped_bar','grouped_column']){
 const rows=[{name:'A',n:99.56,group:'one'},{name:'B',n:99.79,group:'one'}];
 const raw={kind,x:'name',value:'n',unit:'%',style:{labels:true},...(kind.startsWith('grouped')?{series:'group'}:{})};
 const parsed=parseChartSpec({...raw,valueMin:99});assert('spec' in parsed,JSON.stringify(parsed));
 assert.equal(shapeProblem(rows,parsed.spec),null);
 assert(shapeProblem([{name:'C',n:98}],parsed.spec));
 const built=buildOption(rows,parsed.spec),option=built.option as any;
 assert.equal((kind.endsWith('bar')?option.xAxis:option.yAxis).min,99);
 const svg=renderEchartsSvg(built.option,CHART_WIDTH,built.height);
 assert.match(svg,/99\.56/);assert.match(svg,/99\.79/);assert.match(svg,/轴起点 99%/);
 const normal=parseChartSpec(raw);assert('spec' in normal);
 assert.equal((buildOption(rows,normal.spec).option as any)[kind.endsWith('bar')?'xAxis':'yAxis'].min,undefined);
}
for(const extra of [{valueMin:'99'},{valueMin:null},{valueMin:Infinity},{valueMin:99,stack:'total'}])assert('error' in parseChartSpec({kind:'column',x:'name',value:'n',...extra}));
assert('error' in parseChartSpec({kind:'pie',x:'name',value:'n',valueMin:99}));
console.log('Bar/column axis minimum: original SVG labels, visible baseline and validation passed');
