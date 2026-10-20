import { COMPONENT_KINDS } from './draft/components.ts';
/** 工具初始化时挂载的呈现知识；领域模型只负责业务事实。 */
import { CHART_KINDS, EXPRESSION_SUPPORT } from './chart/shared.ts';
import type { ChartKind } from './chart/shared.ts';
import { AUTHOR_ATTRIBUTES, AUTHOR_ELEMENTS } from './report/xhtml.ts';
import { resolveFact } from './knowledge-graph.ts';
import type { SemanticGraph } from './knowledge-graph.ts';

const kindDetails: Record<ChartKind, {names:string[];doc:string;required:string[];series:string;example:{spec:Record<string,unknown>;rows:Record<string,unknown>[];nodes?:Record<string,unknown>[]}}> = {
  bar:{names:['横条图','bar'],doc:'横向比较类别数值；series 可选，表示分组。',required:['x','value'],series:'group',example:{spec:{kind:'bar',x:'label',value:'count'},rows:[{label:'甲',count:3},{label:'乙',count:5}]}},
  column:{names:['柱状图','分组柱图','堆叠柱图','column'],doc:'纵向比较类别；series 为分组列，省略 stack 时并列，stack=total 堆叠，percent 按类别归一为百分比。',required:['x','value'],series:'group',example:{spec:{kind:'column',x:'label',value:'count',series:'group',stack:'total'},rows:[{label:'甲',group:'A',count:3},{label:'甲',group:'B',count:5}]}},
  line:{names:['折线图','时间趋势','line'],doc:'沿 x 展示趋势；series 分线。时间 xType=time，使用 RFC3339 或 epoch 毫秒；数值/时间 x 在每个序列内须非递减。null 留缺口，connectNulls 控制连接。',required:['x','value'],series:'group',example:{spec:{kind:'line',x:'at',value:'count',xType:'time'},rows:[{at:'2026-01-01T00:00:00Z',count:3},{at:'2026-02-01T00:00:00Z',count:5}]}},
  area:{names:['面积图','堆叠面积图','area'],doc:'趋势面积；x 与 line 相同，series 分组；stack=total/percent 控制堆叠。缺失组合留空，不推定为零。',required:['x','value'],series:'group',example:{spec:{kind:'area',x:'at',value:'count',series:'group',stack:'percent'},rows:[{at:1,group:'A',count:3},{at:1,group:'B',count:5},{at:2,group:'A',count:4},{at:2,group:'B',count:6}]}},
  pie:{names:['饼图','环形图','pie'],doc:'单序列类别占比，仅绘制正数。用 x 指类别，donut=true 为环形；省略 series，先在 jq 中筛选/汇总成单序列。',required:['x','value'],series:'unused',example:{spec:{kind:'pie',x:'label',value:'count',donut:true},rows:[{label:'甲',count:3},{label:'乙',count:5}]}},
  scatter:{names:['散点图','气泡图','scatter'],doc:'x/value 为两个数值列；size 可映射第三数值列为点大小。series 不用于分组。',required:['x','value'],series:'unused',example:{spec:{kind:'scatter',x:'a',value:'b',size:'size'},rows:[{a:1,b:4,size:2},{a:2,b:3,size:5}]}},
  histogram:{names:['直方图','分布','histogram'],doc:'value 为逐条原始观测值，自动分箱计数；bins=1..200 可指定箱数。无需 x 或 series。',required:['value'],series:'unused',example:{spec:{kind:'histogram',value:'n',bins:3},rows:[{n:1},{n:2},{n:2},{n:4}]}},
  box:{names:['箱线图','box'],doc:'x 为类别，value 为逐条观测值；工具计算四分位数和离群点。series 不用于分组；先用 jq 构造类别列。',required:['x','value'],series:'unused',example:{spec:{kind:'box',x:'label',value:'n'},rows:[{label:'甲',n:1},{label:'甲',n:2},{label:'甲',n:3},{label:'甲',n:8}]}},
  heatmap:{names:['热力图','矩阵','heatmap'],doc:'x 为横轴类别，series 为纵轴类别，value 为格子数值。缺失格子留空。',required:['x','series','value'],series:'y-category',example:{spec:{kind:'heatmap',x:'day',series:'group',value:'n'},rows:[{day:'周一',group:'A',n:3},{day:'周二',group:'A',n:5}]}},
  radar:{names:['雷达图','radar'],doc:'x 为指标，series 为比较对象，value 为数值；至少三个指标，每个对象×指标均需有限数值，缺失不补零。先明确不同指标的单位与可比性。',required:['x','series','value'],series:'entity',example:{spec:{kind:'radar',x:'metric',series:'group',value:'n'},rows:[{metric:'A',group:'甲',n:3},{metric:'B',group:'甲',n:4},{metric:'C',group:'甲',n:5}]}},
  sankey:{names:['桑基图','流向','sankey'],doc:'每行是一条边：x 起点、series 终点；value 可选权重列，缺省每条边计 1。',required:['x','series'],series:'target',example:{spec:{kind:'sankey',x:'source',series:'target',value:'weight'},rows:[{source:'甲',target:'乙',weight:3},{source:'乙',target:'丙',weight:2}]}},
  graph:{names:['关系图','网络图','graph'],doc:'每行是一条边：x 起点、series 终点；value 可选权重。输入 nodes 必须提供节点表，节点字段见 nodes 主题。',required:['x','series'],series:'target',example:{spec:{kind:'graph',x:'source',series:'target',value:'weight'},rows:[{source:'甲',target:'乙',weight:3},{source:'乙',target:'丙',weight:2}],nodes:[{id:'甲',depth:0},{id:'乙',depth:1},{id:'丙',depth:2}]}},
  gauge:{names:['仪表盘','仪表图','gauge'],doc:'x 为仪表名称，value 为 0..100 的比率值；0..1 的比率须先乘 100，计数须先换算比例。series 不用于分组。',required:['x','value'],series:'unused',example:{spec:{kind:'gauge',x:'label',value:'percent'},rows:[{label:'完成率',percent:75}]}},
};

export const tableHeaderExample = {
  input:{rows:[{level:'major',count:3}]},
  jq:'.facts.rows | map({"告警级别":.level,"数量":.count})',
  spec:{columns:['告警级别','数量']},
};
export const presentationExample = [
 '<Dari title="呈现示例">',
 '<Pipeline>',
 'let facts = data({rows:[{level:"major",count:3}]},{kind:"example"});',
 'let rows = jq("headers.jq",{facts});',
 'let chartSpec = data({x:"告警级别",value:"数量"});',
 'let tableSpec = data({columns:["告警级别","数量"]});',
 'let summary = jq("summary.jq",{facts});',
 '</Pipeline>',
 '<Asset language="jq" name="headers.jq">',tableHeaderExample.jq,'</Asset>',
 '<Asset language="jq" name="summary.jq">','{total:(.facts.rows | map(.count) | add),rows:.facts.rows}','</Asset>',
 '<Template name="answer">',
 '<article><h1>示例结果</h1><p>数量：<Value data={summary.total} /></p><p>首项：<Value data={summary.rows[0].level} /></p><figure><ColumnChart spec={chartSpec} data={rows} /><figcaption>类别比较</figcaption></figure><figure><Table spec={tableSpec} data={rows} /><figcaption>明细</figcaption></figure></article>',
 '</Template></Dari>',
].join('\n');

/** 挂载一次；items 只放名称与说明，事实与示例留在可独立投影的分支。 */
export function mountPresentationKnowledge(graph:SemanticGraph):void {
  const add=(key:string,names:string[],doc:string)=>graph.items.push({key,names,doc});
  const topic=(owner:string,id:string,names:string[],doc:string,facts:Record<string,unknown>)=>{
    const key=`tools/${owner}#topics/${id}`;
    (graph.tools[owner].topics as Record<string,unknown>)[id]={...facts,tools:[`tools/${owner}`]};
    add(key,names,doc);
  };
  graph.tools={
    render_figure:{signature:'<figure><Component spec={spec} data={rows} /><figcaption>说明</figcaption></figure>',pipelineSignature:'render_figure({kind,...spec},{data:rows,nodes?:rows})',input:'data accepts rows[] or {rows:[...]}; nodes is only used by graph',kinds:{},topics:{},related:{tools:['tools/render_html']}},
    render_html:{signature:'<Template name="answer"><article>...</article></Template>',pipelineSignature:'render_html("answer.xhtml",{binding:value,...})',topics:{},related:{tools:['tools/render_figure']}},
  };
  add('tools/render_figure',['图表','图形','表格','呈现','render_figure'],'生成图表或表格。kinds 提供逐图元的必填映射、series 语义、专属开关及最小示例；topics 提供规格、表头与完整分析稿。');
  add('tools/render_html',['答案模板','XHTML','报告','render_html'],'使用严格 XHTML 绑定标量和图表，生成答案。topics 提供引用、路径、数值声明、交付和完整示例。');
  for(const kind of CHART_KINDS){
    const d=kindDetails[kind];
    const component=Object.entries(COMPONENT_KINDS).find(([,value])=>value===kind)![0];
    const {kind:_,...spec}=d.example.spec;
    (graph.tools.render_figure.kinds as Record<string,unknown>)[kind]={required:d.required,series:d.series,switches:Object.keys(EXPRESSION_SUPPORT).filter(feature=>(EXPRESSION_SUPPORT[feature as keyof typeof EXPRESSION_SUPPORT] as readonly string[]).includes(kind)),component,example:{...d.example,spec},tools:['tools/render_figure']};
    add(`tools/render_figure#kinds/${kind}`,[...d.names,component],d.doc);
  }
  (graph.tools.render_figure.kinds as Record<string,unknown>).table={component:'Table',required:[],columns:'string[]: existing column names in display order; default is data keys',example:{spec:{columns:['label','count']},rows:[{label:'甲',count:3}]},tools:['tools/render_figure']};
  add('tools/render_figure#kinds/table',['表格','列顺序','table'],'columns 为字符串列名数组，决定选列和顺序；表头就是数据键名。中文表头先用 jq 重命名数据键，详见 table_headers 主题。');
  topic('render_figure','switches',['图表能力矩阵','stack','series','专属开关'],'专属开关的支持矩阵由渲染器生成；series 的含义见各个 kinds 节点。开关放在 spec 顶层。',{
    support:EXPRESSION_SUPPORT,values:{stack:['total','percent'],size:'column name',bins:'integer 1..200',second:{value:'column name',kind:'line',label:'optional',unit:'optional'},marks:'1..12 entries: {value:number|string,axis?:x|y,label?:string}',donut:'Bool',connectNulls:'Bool',entityColor:'Bool'},
  });
  topic('render_figure','spec',['图表规格','坐标轴','排版','style','layout'],'x/value/series 指向数据列名；标题、轴名、单位与排版可覆盖。类别顺序默认沿用输入。查询/汇总与展示分开完成。',{
    fields:{title:'String',x:'column name',value:'column name',series:'column name; see kind semantics',xType:'line/area: number|time; omitted inferred from x',xLabel:'axis label',valueLabel:'measure label',unit:'display unit'},
    style:{sort:['none','desc','asc'],labels:'Bool',colors:'1..12 hex color strings'},layout:{labelFont:[8,18],titleFont:[8,32],height:[200,2000],rowHeight:[16,80],tickCount:[3,12],slantTicks:'Bool'},
    aggregation:'Prepare unique (x,series) rows for grouped categorical charts in query/jq; repeated cells keep the last valid numeric value, they are not aggregated. Missing combinations remain absent.',
  });
  topic('render_figure','table_headers',['表头','中文列名','columns','label'],'表格 columns 只接受字符串列名数组；表头取数据键名。用 jq 重命名后再选列；{key,label} 会报错。',{example:tableHeaderExample});
  topic('render_figure','nodes',['关系图节点表','nodes'],'graph 的输入 nodes 必填；边的起终点使用节点 id。每个节点应提供 depth，或同时提供 x/y 固定坐标。',{fields:{id:'node ID',label:'optional display name',depth:'numeric layer',x:'optional coordinate with y',y:'optional coordinate with x',category:'optional color category',status:'focus emphasizes node or edge'},call:'<figure><NetworkGraph spec={spec} data={edges} nodes={nodes} /></figure>'});
  topic('render_figure','draft',['图表完整示例','分析稿','pipeline'],'可运行 DARI：示例数据、jq 表头转换、柱图、表格与 XHTML 答案。',{dari:presentationExample});
  topic('render_html','references',['引用','绑定','data-oks-ref','data-oks-pick','路径','DARI','Value','figure','图序号'],'DARI 模板只引用 pipeline 绑定及静态投影。Value 显示标量；具体图元如 ColumnChart 放在原生 figure 中，figcaption 自动获得图/表编号。',{
    scalar:'<Value data={summary.total} />',
    arrayScalar:'<Value data={summary.rows[0].level} />',
    pick:'Static projections: binding.field[0]["中文键"]. Template braces accept only references; construct objects in pipeline and compute in jq.',
    figure:'<figure><ColumnChart spec={chartSpec} data={rows} /><figcaption>说明</figcaption></figure>',
    bindings:'<Template name="answer"><article>...</article></Template>',
    components:COMPONENT_KINDS,
    spec:'Component spec omits kind. Tag determines type; only NetworkGraph accepts nodes. Components are self-closing.',
    structure:'figure contains one component then an optional figcaption. Keep id/class/title/lang on figure; figures and tables number separately per answer, in document order. Captions follow the chart/table.',
    lowLevel:'Explicit Asset language="xhtml" resources may use render_html and data-oks-ref/data-oks-pick; the primary draft format is .dari.',
  });
  topic('render_html','xhtml',['XHTML 语法','元素','属性','data-oks-lit','data-oks-shrink'],'正文根为 article；XML 良构、属性加引号、空元素显式闭合；转义 & 与 <。业务数字通过引用进入正文。',{
    elements:AUTHOR_ELEMENTS,attributes:AUTHOR_ATTRIBUTES,numbers:'Literal numbers in prose require <span data-oks-lit="">…</span>; observed business numbers come from bindings.',
    dariMarkers:'In DARI Template, data-oks-shrink and data-oks-lit may omit =""; they compile to empty string attributes. Other attributes require explicit values. XHTML assets use quoted values.',
    shrink:'data-oks-shrink="" marks interpretation/evaluation text for a shortened preview when reading report structure; attribute presence enables it.',
  });
  topic('render_html','delivery',['交付','reply','artifact'],'template 的 name 是答案名；只有一个时自动选择，多个时 oks_run_answer 使用 answer 指定名字。显式 render_html 绑定也可交付。',{
    reply:'oks_run_answer({src:"oks://work/draft.dari",delivery:"reply"}) returns native Markdown; default mode',
    artifact:'oks_run_answer({src:"oks://work/draft.dari",delivery:"artifact"}) delivers a standalone report path',
  });
  topic('render_html','draft',['XHTML 完整示例','答案示例'],'可运行 DARI：精确绑定标量、数组元素、图表与表格。',{dari:presentationExample});
  // 图元到具体用法的分类引用；反向引用由工具生成。
  for(const kind of [...CHART_KINDS,'table']) {
    const fact=resolveFact(graph,`tools/render_figure#kinds/${kind}`);
    const topics=kind==='table'?['table_headers']:kind==='graph'?['spec','nodes']:['spec','switches'];
    fact.related={topics:topics.map(topic=>`tools/render_figure#topics/${topic}`)};
    for(const topic of topics){
      const target=resolveFact(graph,`tools/render_figure#topics/${topic}`);
      const reverse=(target.referenced_by ??= {kinds:[]}) as {kinds:string[]};
      reverse.kinds.push(`tools/render_figure#kinds/${kind}`);
    }
  }
  graph.items.sort((a,b)=>a.key.localeCompare(b.key,'en'));
}

export const presentationHelp={
  roots:['tools/render_figure','tools/render_html'],
  discover:{input:'oks://knowledge',method:'oks://builtin/tools/ktools.lib.jq#search',args:{query:'图表',take:5}},
  kinds:{project:{tools:{render_figure:{kinds:['Map',{component:'Value',required:'Value',series:'Value',switches:'Value'}]}}}},
  read:{input:'oks://knowledge',method:'oks://builtin/tools/ktools.lib.jq#read',args:{key:'tools/render_figure#kinds/column'}},
  topics:['tools/render_figure#topics/switches','tools/render_figure#topics/spec','tools/render_figure#topics/table_headers','tools/render_figure#topics/nodes','tools/render_figure#topics/draft','tools/render_html#topics/references','tools/render_html#topics/xhtml','tools/render_html#topics/delivery'],
};
