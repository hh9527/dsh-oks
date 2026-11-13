import {temporal,timeSemantic,formatTime,embeddedTimeZone,validateTimeFormat,type TimeFormat} from './time-display.ts';
import {formatValue,precision,type Type} from './display-values.ts';
import {COMPONENT_KINDS,componentSpec} from './chart/components.ts';
import {parseChartSpec,parseTableSpec,missingColumns,shapeProblem} from './chart/spec.ts';
import {buildOption,CHART_WIDTH} from './chart/option.ts';
import {renderEchartsSvg} from './chart/echarts.ts';
import {embedFigureCsv,csv} from './chart/svg-data.ts';
import {tableMarkdown} from './view/table.ts';
import {renderMarkdown} from './chart/markdown.ts';
import {cleanChartSvg,REPORT_STYLE} from './chart/report.ts';
import {Temporal} from '@js-temporal/polyfill';
import {timeWindows,timeWindowOptions} from './time-windows.ts';
// Structural ABI: the language package owns its types; the presentation host only reads them.
const scalar=(name:string):Type=>({kind:'scalar',name});
const schema=(fields:Record<string,Type>):Type=>({kind:'schema',fields});
const storage=(type:Type):string=>type.kind==='option'||type.kind==='nominal'?storage(type.inner!):type.name!;
const presentation=(type:Type):{multiplier:number;suffix:string;precision?:number}|undefined=>type.presentation??(type.inner?presentation(type.inner):undefined);
const boundary=schema({epoch_millis:scalar('EpochMillis'),date_time_utc:scalar('DateTimeUtc'),rfc3339:scalar('String')});
function closedEnum(name:string,variants:string[]){const parse=(value:unknown)=>{if(typeof value!=='string'||!variants.includes(value))throw Error('Invalid '+name+' variant');return value;};return {kind:'nominal',name,inner:scalar('String'),codec:{variants,parse,encode:parse,decode:parse}};}
const stackVariants=['None','Total','Percent'];
const stackType=closedEnum('Stack',stackVariants);
const barNames=new Set(['BarChart','GroupedBarChart','MultiBarChart','StackedBarChart']);
const orientations=['Horizontal','Vertical'];
const stackModes=['Absolute','Percent'];
const timeUnits=['Minute','Hour','Day','Week','Month','Quarter','Year'];
const windowModes=['Complete','Current','Rolling'];
function enumOption(value:any,name:string,variants:string[],checking:boolean):string{
 const member=checking?value?.variant:value;
 if(checking&&(value?.[Symbol.for('dari.enum')]!==true||value.enum!==name)||!variants.includes(member))throw Error('Use '+name+'::'+variants.join(' / '+name+'::'));
 return member.toLowerCase();
}
function windowOptions(value:any,checking:boolean){
 if(!value||typeof value!=='object')throw Error('time_windows requires {unit,count,mode}');
 return timeWindowOptions({...value,unit:enumOption(value.unit,'TimeUnit',timeUnits,checking),mode:enumOption(value.mode,'WindowMode',windowModes,checking)});
}
function bucketOptions(value:any,checking:boolean){
 if(!value||Object.keys(value).some(k=>!['unit','time_zone'].includes(k))||typeof value.time_zone!=='string'||/^[+-]/.test(value.time_zone))throw Error('time_bucket requires static {unit:TimeUnit,time_zone:IANA String}');
 const unit=enumOption(value.unit,'TimeUnit',timeUnits,checking);new Intl.DateTimeFormat('en',{timeZone:value.time_zone});return {unit,timeZone:value.time_zone};
}

// Public DARI names are independent of the chart renderer's JS vocabulary.
const chartNames:Record<string,string>={allow_no_data:'allowNoData',value_min:'valueMin',connect_nulls:'connectNulls',entity_color:'entityColor',x_label:'xLabel',value_label:'valueLabel'};
const layoutNames:Record<string,string>={label_font:'labelFont',title_font:'titleFont',slant_ticks:'slantTicks',tick_count:'tickCount'};
function chartInput(raw:Record<string,unknown>,names=chartNames):Record<string,unknown>{
 const result:Record<string,unknown>={};
 for(const [key,value]of Object.entries(raw)){
  if(Object.values(names).includes(key))throw Error('Use '+Object.keys(names).find(k=>names[k]===key)+' instead of '+key);
  result[names[key]??key]=key==='layout'&&value&&typeof value==='object'?chartInput(value as Record<string,unknown>,layoutNames):value;
 }
 return result;
}
function presentationSpec(raw:Record<string,unknown>,name:string,fields:Record<string,Type>):Record<string,unknown>{
 raw={...raw};
 const formats=(raw.formats??{}) as Record<string,TimeFormat>;
 if(!formats||typeof formats!=='object'||Array.isArray(formats))throw Error('formats requires field names mapped to time formats');
 for(const [key,format]of Object.entries(formats)){if(!fields[key])throw Error('Unknown format field '+key);validateTimeFormat(fields[key],format);}
 delete raw.formats;
 let axisType:unknown;
 if(name==='LineChart'||name==='AreaChart'){
  const type=fields[String(raw.x)],role=timeSemantic(type),numeric=['Int','Float'].includes(storage(type??scalar('String')));
  const mode=raw.x_axis===undefined?(['EpochMillis','DateTimeUtc','DateTimeTz'].includes(role??'')?'time':numeric?'value':'category'):enumOption(raw.x_axis,'Axis',['Time','Category','Value'],true);
  if(mode==='time'&&!['EpochMillis','DateTimeUtc','DateTimeTz'].includes(role??''))throw Error('Axis::Time requires EpochMillis, DateTimeUtc or DateTimeTz; a String encoding is not a time type');
  if(mode==='value'&&!numeric)throw Error('Axis::Value requires a numeric x field');
  axisType=mode==='time'?(role==='DateTimeUtc'?'Rfc3339':role):mode==='value'?storage(type!):'String';
  delete raw.x_axis;
 }else if(raw.x_axis!==undefined)throw Error('x_axis belongs to LineChart or AreaChart');
 if(!barNames.has(name)&&(raw.orientation!==undefined||raw.category!==undefined||raw.mode!==undefined||raw.metrics!==undefined))throw Error('orientation/category/mode/metrics belong to bar chart contracts; use the component mappings in oks://help/dari-figures.md');
 if(barNames.has(name)){
  if(raw.x!==undefined)throw Error(name+' uses category: $.field');
  if(raw.stack!==undefined)throw Error('StackedBarChart uses mode: StackMode::Absolute or StackMode::Percent; other bar charts are parallel');
  if(raw.category===undefined)throw Error(name+' requires category: $.field');
  raw.x=raw.category;delete raw.category;
  raw.orientation=raw.orientation===undefined?'vertical':enumOption(raw.orientation,'Orientation',orientations,true);
  if(name==='MultiBarChart'){
   if(!Array.isArray(raw.metrics)||raw.series!==undefined||raw.value!==undefined)throw Error('MultiBarChart requires metrics: [{value: $.field, label: "...", unit: "..."}]; each column keeps its business type');
   raw.series=raw.metrics;delete raw.metrics;
  }else if(Array.isArray(raw.series)||raw.metrics!==undefined)throw Error(name+' requires long-table series: $.group and value: $.metric; independent columns use MultiBarChart');
  if(name==='StackedBarChart'){
   const mode=raw.mode===undefined?'absolute':enumOption(raw.mode,'StackMode',stackModes,true);
   raw.stack=mode==='absolute'?'total':'percent';delete raw.mode;
  }else if(raw.mode!==undefined)throw Error('Only StackedBarChart accepts mode');
 }
 const axis=axisType;precision(raw.precision);const spec=chartInput(raw);if(axis!==undefined)spec.xType=axis;delete spec.precision;
 if(raw.stack!==undefined&&!barNames.has(name)){const value=raw.stack as any;if(!value||value[Symbol.for('dari.enum')]!==true||value.enum!=='Stack'||!stackVariants.includes(value.variant))throw Error('stack requires Stack::None, Stack::Total or Stack::Percent');if(value.variant==='None')delete spec.stack;else spec.stack=value.variant==='Total'?'total':'percent';}
 return spec;
}
function stacking(raw:Record<string,unknown>,fields:Record<string,Type>){
 if(raw.stack&&fields[String(raw.value)]){
  let t=fields[String(raw.value)];while(t.kind==='option')t=t.inner!;
  const operations=(t as any).codec?.operations as string[]|undefined;
  if(operations&&!operations.includes('Sum'))throw Error('Stacking requires an additive metric; this business type does not allow Sum');
 }
}
function formatChart(option:any,fields:Record<string,Type>,spec:any,digits?:number){
 const base=fields[spec.value],policy=presentation(base??scalar('Float'));
 const count=spec.kind==='histogram';
 const fmt=(v:unknown,type:Type|undefined=base,suffix=policy?.suffix??spec.unit??'')=>typeof v==='number'?String(formatValue({...type,kind:type?.kind??'scalar',presentation:{multiplier:1,suffix,precision:presentation(type??scalar('Float'))?.precision}},v,digits)):String(v??'');
 const axes=(a:any)=>Array.isArray(a)?a:a?[a]:[];
 for(const axis of [...axes(option.xAxis),...axes(option.yAxis)])if(axis.type==='value'){
  const isValue=spec.kind==='bar'||spec.kind==='grouped_bar'?axes(option.xAxis).includes(axis):axes(option.yAxis).includes(axis);
  const secondary=axes(option.yAxis).indexOf(axis)===1;const type=secondary?fields[spec.second?.value]:isValue?base:fields[spec.x],suffix=count?'':secondary?(presentation(type??scalar('Float'))?.suffix??spec.second?.unit??''):spec.stack==='percent'&&isValue?'%':isValue?(policy?.suffix??spec.unit??''):(presentation(type??scalar('Float'))?.suffix??'');
  axis.axisLabel={...axis.axisLabel,formatter:(v:number)=>fmt(v,count?scalar('Int'):type,suffix)};
 }
 option.tooltip={...option.tooltip,valueFormatter:(v:unknown)=>Array.isArray(v)?v.map(x=>fmt(x)).join(', '):fmt(v)};
 for(const series of axes(option.series)){
  const type=series.yAxisIndex===1?fields[spec.second?.value]:count?scalar('Int'):base;
  const suffix=spec.stack==='percent'?'%':series.yAxisIndex===1?(presentation(type??scalar('Float'))?.suffix??spec.second?.unit??''):(policy?.suffix??spec.unit??'');
  const display=(v:any)=>Array.isArray(v)?(spec.kind==='line'||spec.kind==='area')&&spec.xType!=='String'?fmt(v[1],type,suffix):spec.kind==='heatmap'?fmt(v[2],type,suffix):v.map((x:unknown,i:number)=>fmt(x,spec.kind==='scatter'&&i===0?fields[spec.x]:type,spec.kind==='scatter'&&i===0?presentation(fields[spec.x])?.suffix??'':suffix)).join(', '):fmt(v,type,suffix);
  if(!series.label?.formatter)series.label={...series.label,formatter:(p:any)=>(series.type==='pie'?p.name+': ':'')+display(p.value)};
  if(series.type==='gauge')series.detail={...series.detail,formatter:(v:number)=>fmt(v,type,suffix)};
  series.tooltip={...series.tooltip,valueFormatter:display};
 }
}
// Keep continuous coordinates as instants; only labels and tooltips use local time.
export function formatTimeChart(option:any,fields:Record<string,Type>,spec:any,rows:Record<string,unknown>[],formats:Record<string,TimeFormat>){
 const type=fields[spec.x];if(!temporal(type))return;
 const continuous=(spec.kind==='line'||spec.kind==='area')&&['Rfc3339','DateTimeTz','EpochMillis'].includes(spec.xType);
 if(!continuous)return;
 const supplied=formats[spec.x]??{},zones=new Set(rows.map(row=>embeddedTimeZone(row[spec.x])).filter(Boolean));
 if(!supplied.time_zone&&zones.size>1)throw Error('Mixed DateTimeTz axis zones require an explicit formats.'+spec.x+'.time_zone');
 const format:TimeFormat={...supplied,time_zone:supplied.time_zone??[...zones][0]??'UTC'};
 const show=(v:unknown)=>String(formatTime(scalar('EpochMillis'),v,format)??'');
 option.useUTC=true;
 const axes=Array.isArray(option.xAxis)?option.xAxis:[option.xAxis];
 for(const axis of axes)if(axis?.type==='time'){axis.axisLabel={...axis.axisLabel,formatter:show};axis.axisPointer={...axis.axisPointer,label:{...axis.axisPointer?.label,formatter:(p:any)=>show(p.value)}};}
 const escape=(v:unknown)=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
 const series=Array.isArray(option.series)?option.series:[option.series];
 option.tooltip={...option.tooltip,trigger:'axis',formatter:(input:any)=>{
  const points=Array.isArray(input)?input:[input];if(!points.length)return '';
  const header=show(points[0].axisValue??points[0].value?.[0]);
  return [escape(header),...points.map((point:any)=>{
   const item=series[point.seriesIndex],value=Array.isArray(point.value)?point.value[1]:point.value;
   const shown=item?.tooltip?.valueFormatter?.(value)??value;
   return escape(point.seriesName)+': '+escape(shown);
  })].join('<br/>');
 }};
}

// Wide series are a presentation projection: source columns keep their nominal types.
function wideSeries(name:string,raw:Record<string,unknown>,fields:Record<string,Type>,rows:Record<string,unknown>[]=[]):{spec:Record<string,unknown>;fields:Record<string,Type>;rows:Record<string,unknown>[]}{
 if(!Array.isArray(raw.series))return {spec:raw,fields,rows};
 if(!['MultiBarChart','LineChart'].includes(name))throw Error('Wide series require MultiBarChart or LineChart');
 if(raw.second!==undefined)throw Error('Wide series use a shared value axis; omit second');
 if(!raw.series.length)throw Error('Wide series must contain at least one column');
 if(raw.value!==undefined)throw Error('Wide series specify value per series; remove spec.value');
 if(raw.stack || (raw.style as any)?.sort && (raw.style as any).sort!=='none')throw Error('宽表独立指标只并列展示，并在输入计划中排序；同一指标按类别堆叠使用 StackedBarChart 的 category/series/value 长表契约');
 if(typeof raw.x!=='string'||!fields[raw.x])throw Error('Wide series require an existing x column');
 const labels=new Set<string>(),columns=new Set<string>(),units=new Set<string>();
 const series=raw.series.map((entry:any)=>{
  if(!entry||typeof entry.value!=='string'||!fields[entry.value])throw Error('Wide series value must reference an existing column');
  if(!['Int','Float'].includes(storage(fields[entry.value])))throw Error('Wide series numeric mapping '+entry.value+' must have Int/Float representation');
  if(typeof entry.label!=='string'||!entry.label.trim())throw Error('Wide series require a nonempty label');
  if(typeof entry.unit!=='string')throw Error('Wide series require an explicit unit');
  const policy=presentation(fields[entry.value]);if(policy&&entry.unit!==policy.suffix)throw Error('Wide series unit conflicts with the value type presentation');
  if(labels.has(entry.label)||columns.has(entry.value))throw Error('Wide series labels and columns must be unique');
  labels.add(entry.label);columns.add(entry.value);units.add(entry.unit);return entry;
 });
 if(units.size!==1||raw.unit!==undefined&&raw.unit!==series[0].unit)throw Error('Wide series units must agree with the shared value axis');
 const x=raw.x;
 return {spec:{...raw,x:'__x',series:'__series',value:'__value',unit:series[0].unit},fields:{__x:fields[x],__series:scalar('String'),__value:scalar('Float')},rows:rows.flatMap(row=>series.map(entry=>({__x:row[x],__series:entry.label,__value:typeof row[entry.value]==='number'?Number((Number(row[entry.value])*(presentation(fields[entry.value])?.multiplier??1)).toPrecision(12)):row[entry.value]})))};
}
function validate(name:string,raw:Record<string,unknown>,fields:Record<string,Type>){
 let kind=COMPONENT_KINDS[name as keyof typeof COMPONENT_KINDS];if(barNames.has(name)){kind=(name==='BarChart'?(raw.orientation==='horizontal'?'bar':'column'):(raw.orientation==='horizontal'?'grouped_bar':'grouped_column')) as typeof kind;}if(!kind)throw Error('Unknown figure component '+name);
 const {orientation,...settings}=raw;
 if(barNames.has(name)){
  if(name==='BarChart'&&raw.series!==undefined)throw Error('BarChart accepts category/value; grouped data uses GroupedBarChart or StackedBarChart, independent columns use MultiBarChart');
  if(name!=='BarChart'&&(typeof raw.series!=='string'||typeof raw.value!=='string'))throw Error(name+' requires category/series/value field projections');
 }
 const spec=componentSpec(settings,kind) as Record<string,unknown>,columns=Object.keys(fields);
 if(kind==='table'){const t=parseTableSpec(spec);const missing=[...(t.columns??[]),...Object.keys(t.labels)].filter(k=>!columns.includes(k));if(missing.length)throw Error('Unknown table columns: '+missing.join(', '));return spec;}
 const p=parseChartSpec(spec);if('error'in p)throw Error(p.error);
 const policy=fields[p.spec.value]?presentation(fields[p.spec.value]):undefined;if(policy&&p.spec.unit&&p.spec.unit!==policy.suffix)throw Error('Figure unit conflicts with the value type presentation');
 if(p.spec.second){const secondary=fields[p.spec.second.value]?presentation(fields[p.spec.second.value]):undefined;if(secondary&&p.spec.second.unit&&p.spec.second.unit!==secondary.suffix)throw Error('Figure second unit conflicts with the value type presentation');}
 const missing=missingColumns(p.spec,columns,1);if(missing.length)throw Error('Unknown figure columns: '+missing.join(', '));
 for(const key of [p.spec.value,p.spec.size,p.spec.second?.value,...(p.spec.kind==='scatter'?[p.spec.x]:[])])if(key&&fields[key]&&!['Int','Float'].includes(storage(fields[key])))throw Error('Figure numeric mapping '+key+' must have Int/Float representation');

 return spec;
}
const host={
 contractId:'dari-host/v7',types:{Orientation:closedEnum('Orientation',orientations),StackMode:closedEnum('StackMode',stackModes),Stack:stackType,Axis:closedEnum('Axis',['Time','Category','Value']),TimeUnit:closedEnum('TimeUnit',timeUnits),WindowMode:closedEnum('WindowMode',windowModes)},formatValue,components:Object.keys(COMPONENT_KINDS),reportStyle:REPORT_STYLE,
 reportHtml(text:string,artifacts:Record<string,string>){return renderMarkdown(text,()=>{throw Error('Unexpected report fence');},(alt,href)=>{const svg=artifacts[href];if(!svg)throw Error('Missing report figure '+href);return '<figure>'+cleanChartSvg(svg)+'</figure>';});},
 checkFigure(name:string,spec:Record<string,unknown>,fields:Record<string,Type>,nodes?:Record<string,Type>){const normalized=presentationSpec(spec,name,fields);stacking(normalized,fields);const wide=wideSeries(name,normalized,fields);validate(name,wide.spec,wide.fields);if(name==='NetworkGraph'&&(!nodes?.id||!nodes.depth&&!(nodes.x&&nodes.y)))throw Error('NetworkGraph requires a nodes table with id and depth or x/y');if(name!=='NetworkGraph'&&nodes)throw Error('Only NetworkGraph accepts nodes');},
 renderFigure(name:string,raw:Record<string,unknown>,rows:Record<string,unknown>[],fields:Record<string,Type>,nodes?:Record<string,unknown>[]){
  const normalized=presentationSpec(raw,name,fields);stacking(normalized,fields);const wide=wideSeries(name,normalized,fields,rows);
  const spec=validate(name,wide.spec,wide.fields);
  if(spec.kind==='table'){
   const shown=rows.map(row=>Object.fromEntries(Object.entries(row).map(([key,value])=>[key,fields[key]?formatValue(fields[key],value,precision(raw.precision),(raw.formats as any)?.[key]):value])));
   const t=parseTableSpec(spec),content=tableMarkdown(shown,{allowNoData:t.allowNoData,columns:t.columns??Object.keys(fields),labels:t.labels,...(t.title?{title:t.title}:{})});
   if('error'in content)throw Error(content.error);
   return {kind:'table' as const,content:content.embedded,html:renderMarkdown(content.embedded,()=>{throw Error('Unexpected table fence');}),title:t.title??'Table'};
  }
  const parsed=parseChartSpec(spec);if('error'in parsed)throw Error(parsed.error);
  const renderRows=wide.rows.map(row=>{const copy:Record<string,unknown>={...row};if(temporal(wide.fields[parsed.spec.x])&&!['Rfc3339','DateTimeTz','EpochMillis'].includes(parsed.spec.xType??''))copy[parsed.spec.x]=formatValue(wide.fields[parsed.spec.x],copy[parsed.spec.x],undefined,(raw.formats as any)?.[parsed.spec.x]);if(parsed.spec.xType==='String'&&copy[parsed.spec.x]!=null)copy[parsed.spec.x]=String(copy[parsed.spec.x]);for(const key of new Set([parsed.spec.value,parsed.spec.second?.value,...(parsed.spec.kind==='scatter'?[parsed.spec.x]:[])])){if(!key||!wide.fields[key])continue;const policy=presentation(wide.fields[key]);if(policy&&typeof copy[key]==='number')copy[key]=Number((Number(copy[key])*policy.multiplier).toPrecision(12));}return copy;});
  const policy=wide.fields[parsed.spec.value]?presentation(wide.fields[parsed.spec.value]):undefined;
  if(policy){if(parsed.spec.unit&&parsed.spec.unit!==policy.suffix)throw Error('Figure unit conflicts with the value type presentation');parsed.spec.unit=policy.suffix;}
  if(parsed.spec.second){const secondary=wide.fields[parsed.spec.second.value]?presentation(wide.fields[parsed.spec.second.value]):undefined;if(secondary)parsed.spec.second.unit=secondary.suffix;}
  if(temporal(wide.fields[parsed.spec.x])&&!['Rfc3339','DateTimeTz','EpochMillis'].includes(parsed.spec.xType??'')){
   const labels=new Map<unknown,unknown>();
   renderRows.forEach((row,i)=>{const label=row[parsed.spec.x],raw=wide.rows[i][parsed.spec.x],instant=timeSemantic(wide.fields[parsed.spec.x])==='LocalDate'?raw:typeof raw==='number'?raw:raw==null?raw:Date.parse(String(raw).replace(/\[[^\]]+\]$/,''));
    if(labels.has(label)&&labels.get(label)!==instant)throw Error('Time category labels collapse distinct instants; use Axis::Time or a more precise date_style');labels.set(label,instant);
   });
  }
  const problem=shapeProblem(renderRows,parsed.spec);if(problem)throw Error(problem);
  const {option,height}=buildOption(renderRows,parsed.spec,nodes);
  formatChart(option,wide.fields,parsed.spec,precision(raw.precision));
  formatTimeChart(option,wide.fields,parsed.spec,wide.rows,(raw.formats??{}) as Record<string,TimeFormat>);
  if((option as any).visualMap){const values=renderRows.map(row=>row[parsed.spec.value]).filter((v):v is number=>typeof v==='number');if(values.length)(option as any).visualMap.text=[Math.max(...values),Math.min(...values)].map(v=>String(formatValue({kind:'scalar',name:'Float',presentation:{multiplier:1,suffix:policy?.suffix??parsed.spec.unit??'',precision:policy?.precision}},v,precision(raw.precision))));}
  const used=new Set<string>();
  const collect=(v:unknown):void=>{if(typeof v==='string'&&Object.hasOwn(fields,v))used.add(v);else if(Array.isArray(v))v.forEach(collect);else if(v&&typeof v==='object')Object.values(v).forEach(collect);};
  for(const key of ['x','y','category','series','value','size','source','target','metrics','second','open','close','low','high'])collect(raw[key]);
  const shown=rows.map(row=>Object.fromEntries([...used].map(key=>{const policy=presentation(fields[key]);const v=row[key];return [key+(policy?.suffix?' ('+policy.suffix+')':''),temporal(fields[key])?formatValue(fields[key],v,undefined,(raw.formats as any)?.[key]):policy&&typeof v==='number'?Number((v*policy.multiplier).toPrecision(12)):v];})));
  const fence='\x60'.repeat(3);
  const dataText=fence+'csv\n'+csv(shown,[...used].map(key=>key+(presentation(fields[key])?.suffix?' ('+presentation(fields[key])!.suffix+')':'')))+'\n'+fence+(nodes?'\n\n### nodes\n\n'+fence+'csv\n'+csv(nodes)+'\n'+fence:'');
  return {kind:'chart' as const,dataText,content:embedFigureCsv(renderEchartsSvg(option,CHART_WIDTH,height),{rows,spec:{component:name,...raw,precision:precision(raw.precision),default_precision:2,presentation:Object.fromEntries(Object.entries(fields).flatMap(([key,type])=>{const policy=presentation(type);return policy?[[key,policy]]:[];}))},...(nodes?{nodeRows:nodes}:{})}),title:parsed.spec.title??name};
 },
 functions:{
  time_bucket:{
   sql:{jsonArgs:[1]},
   check(args:Type[],constants:unknown[]):Type{
    let t=args[0];const nullable=t?.kind==='option';let role:string|undefined;
    while(t){role??=t.semantic??(['EpochMillis','DateTimeUtc','DateTimeTz'].includes(t.name??'')?t.name:undefined);t=t.inner!;}
    role??=args[0]?.name;
    if(args.length!==2||!['EpochMillis','DateTimeUtc','DateTimeTz'].includes(role??''))throw Error('time_bucket requires an instant and static {unit,time_zone}');
    bucketOptions(constants[1],true);
    const result={...scalar('DateTimeUtc'),semantic:'DateTimeUtc'};return nullable?{kind:'option',inner:result}:result;
   },
   run(args:unknown[]){
    if(args[0]===null)return null;
    const o=bucketOptions(args[1],false);
    const instant=typeof args[0]==='number'?Temporal.Instant.fromEpochMilliseconds(args[0]):Temporal.Instant.from(String(args[0]).split('[')[0]);
    let z=instant.toZonedDateTimeISO(o.timeZone);
    if(o.unit==='minute')z=z.with({second:0,millisecond:0,microsecond:0,nanosecond:0});
    else if(o.unit==='hour')z=z.with({minute:0,second:0,millisecond:0,microsecond:0,nanosecond:0});
    else {
     let d=z.toPlainDate();
     if(o.unit==='week')d=d.subtract({days:d.dayOfWeek-1});
     if(o.unit==='month')d=d.with({day:1});
     if(o.unit==='quarter')d=d.with({month:Math.floor((d.month-1)/3)*3+1,day:1});
     if(o.unit==='year')d=d.with({month:1,day:1});
     z=d.toZonedDateTime(o.timeZone);
    }
    return z.toInstant().toString({fractionalSecondDigits:3});
   }
  },
  time_windows:{
   check(args:Type[],constants:unknown[]):Type{
    if(args.length!==2||args[0].kind!=='schema'||args[0].fields?.epoch_millis?.name!=='EpochMillis'||args[0].fields?.time_zone?.name!=='TimeZone')throw Error('time_windows requires {epoch_millis: EpochMillis, time_zone: TimeZone} and static {unit,count,mode}');
    windowOptions(constants[1],true);
    return {kind:'array',inner:schema({label:scalar('String'),zone:scalar('String'),start:boundary,end:boundary})};
   },
   run(args:unknown[]){const ctx=args[0] as {epoch_millis:number;time_zone:string|null};if(!ctx.time_zone)throw Error('time_windows requires context.time_zone; clarify the calendar timezone');return timeWindows({utc:{epochMillis:ctx.epoch_millis},tz:{client:{id:ctx.time_zone}}},windowOptions(args[1],false)).map(w=>({...w,start:{epoch_millis:w.start.epochMillis,date_time_utc:w.start.dateTimeUtc,rfc3339:w.start.rfc3339},end:{epoch_millis:w.end.epochMillis,date_time_utc:w.end.dateTimeUtc,rfc3339:w.end.rfc3339}}));}
  }
 }
};

function publicFigureCall<T>(call:()=>T):T{try{return call();}catch(error){if(!(error instanceof Error)||error.message.startsWith("Use "))throw error;let message=error.message;for(const [publicName,internalName]of Object.entries({...chartNames,...layoutNames}))message=message.replaceAll(internalName,publicName);throw new Error(message,{cause:error});}}
export const dariHost={...host,checkFigure(...args:Parameters<typeof host.checkFigure>){return publicFigureCall(()=>host.checkFigure(...args));},renderFigure(...args:Parameters<typeof host.renderFigure>){return publicFigureCall(()=>host.renderFigure(...args));}};
