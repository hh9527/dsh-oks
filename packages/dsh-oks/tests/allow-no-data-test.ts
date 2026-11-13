import assert from 'node:assert/strict';
import {parseChartSpec,parseTableSpec,missingColumns,shapeProblem} from '../src/chart/spec.ts';
import {buildOption,CHART_WIDTH} from '../src/chart/option.ts';
import {renderEchartsSvg} from '../src/chart/echarts.ts';
import {tableMarkdown} from '../src/view/table.ts';
for(const kind of ['bar','column','line','area','grouped_bar','grouped_column','pie','scatter','radar','histogram','box','heatmap','sankey','graph']){
 const base={kind,...(kind==='histogram'?{}:{x:'name'}),value:'n',...(['line','area'].includes(kind)?{x_type:'Rfc3339'}:{}),...(['grouped_bar','grouped_column','radar','heatmap','sankey','graph'].includes(kind)?{series:'group'}:{})};
 const parsed=parseChartSpec(base);assert('spec' in parsed,JSON.stringify(parsed));
 assert.throws(()=>buildOption([],parsed.spec),/allowNoData/);
 const allowed=parseChartSpec({...base,allowNoData:true});assert('spec' in allowed,JSON.stringify(allowed));
 const built=buildOption([],allowed.spec);
 assert.match(renderEchartsSvg(built.option,CHART_WIDTH,built.height),/无数据/);
 assert('error' in parseChartSpec({...base,allowNoData:'True'}));
}
for(const allowNoData of [undefined,false,true]){
 const parsed=parseChartSpec({kind:'bar',x:'name',value:'n',...(allowNoData===undefined?{}:{allowNoData})});assert('spec' in parsed);
 const built=buildOption([{name:'A',n:5}],parsed.spec);assert.match(renderEchartsSvg(built.option,CHART_WIDTH,built.height),/A/);
 assert.deepEqual(missingColumns(parsed.spec,['name'],1),['n']);
}
const invalidLine=parseChartSpec({kind:'line',x:'at',value:'n',x_type:'Rfc3339',allowNoData:true});assert('spec' in invalidLine);
assert(shapeProblem([{at:123,n:5}],invalidLine.spec));
assert('error' in tableMarkdown([],{columns:['name']}));
const tableSpec=parseTableSpec({kind:'table',columns:['name'],labels:{name:'名称'},allowNoData:true});
const empty=tableMarkdown([],{...tableSpec,columns:tableSpec.columns!,title:tableSpec.title??undefined});assert('embedded' in empty);assert.match(empty.embedded,/名称/);assert.match(empty.embedded,/无数据/);
assert.throws(()=>parseTableSpec({kind:'table',allowNoData:'True'}),/boolean/);
assert('error' in tableMarkdown([{name:'A'}],{columns:['missing'],allowNoData:true}));
console.log('allowNoData: chart SVG, tables, default rejection and validation passed');
