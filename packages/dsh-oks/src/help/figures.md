# 图表与报告

## 发现图表能力

知识图的 tools.render_figure.kinds 按图表类型保存必填映射、series 含义、专属开关与可运行示例。tools.render_html.topics 保存报告引用、XHTML 和附件交付规则。

用 oks_project 查看类型目录：

```json
{"input":"oks://knowledge","select":"tools.render_figure.kinds:keys"}
```

读取柱状图的结构化能力与说明：

```json
{"input":"oks://knowledge","transform":{"lib":"oks://builtin/tools/ktools.lib.jq","name":"read","args":{"key":"tools/render_figure#kinds/column"}}}
```

支持的组件包括 BarChart、ColumnChart、LineChart、AreaChart、PieChart、ScatterChart、Histogram、BoxPlot、Heatmap、RadarChart、Sankey、NetworkGraph、Gauge 和 Table。组件标签确定类型，spec 省略 kind。

## 映射、规格与数据

x/value/series 指向数据列名，series 的含义由各图表类型决定。标题、轴名、单位、颜色与排版可覆盖，类别顺序默认沿用输入。图表类型的 required、series、switches 和 example 以结构化知识为准。

分组类别图先在 query/jq 中准备唯一的 (x,series) 行；重复单元保留最后一个有效数值，不会自动聚合。缺失组合保持缺失。

时间轴 xType=time 使用 RFC3339 或 epoch 毫秒；数值与时间 x 在每个序列内须非递减。饼图先整理为单序列正数；仪表图使用 0..100 的比例。原始数据的单位和尺度须先核实。

NetworkGraph 独立提供 nodes 表，边的起终点引用节点 id；节点提供 depth，或成对的 x/y 坐标。其他图表组件不接受 nodes。

规格、开关和节点字段的完整约束分别见：

- tools/render_figure#topics/spec
- tools/render_figure#topics/switches
- tools/render_figure#topics/nodes

## 表头与列顺序

Table 的 columns 只接受字符串列名数组，决定选列和顺序；表头就是数据键名。中文表头先在 jq 中重命名数据键，再选列；{key,label} 会报错。

```jq
.facts.rows | map({"告警级别":.level,"数量":.count})
```

对应 spec 为 {columns:["告警级别","数量"]}。完整示例见 tools/render_figure#topics/table_headers。

## 报告引用与编号

Figures 独立定义具名图表；Report 用 <Figure ref="comparison" /> 引用。报告花括号只引用 pipeline 绑定及静态投影，例如 summary.rows[0]["中文键"]；对象在 pipeline 中构造，计算在 jq 中完成。

<figure> 内先放 Figure，再放可选 figcaption。每份 Report 按首次展示顺序分别编图号、表号，重复引用复用编号。FigureRef 输出当前报告的文字编号，目标必须在同一 Report 中展示。id/class/title/lang 写在 figure 上。独立展示的图表用标题，不加报告编号。

标量用 <Value data={summary.total} />。Report 正文根为 article，元素和属性遵守白名单；文本中的 & 与 < 使用实体。pipeline 与 jq 原样书写，无需 XML 转义。

业务数字从绑定取值，正文中的字面数字用 <span data-oks-lit="">…</span> 声明。data-oks-shrink 标记解读或评价文字，读取结构时可缩短预览。DARI 中这两个标记属性可省略 =""；显式 XHTML 资产的属性值仍使用引号。

引用与正文规则见 tools/render_html#topics/references、tools/render_html#topics/xhtml。

## 完整分析稿示例

```dari
<Dari title="呈现示例">
<Pipeline>
facts <- data({rows:[{level:"major",count:3}]},{kind:"example"});
rows <- jq("headers.jq",{facts});
chartSpec <- data({x:"告警级别",value:"数量"});
tableSpec <- data({columns:["告警级别","数量"]});
summary <- jq("summary.jq",{facts});
</Pipeline>
<Asset language="jq" name="headers.jq">
.facts.rows | map({"告警级别":.level,"数量":.count})
</Asset>
<Asset language="jq" name="summary.jq">
{total:(.facts.rows | map(.count) | add),rows:.facts.rows}
</Asset>
<Figures><ColumnChart name="comparison" spec={chartSpec} data={rows} /><Table name="details" spec={tableSpec} data={rows} /></Figures>
<Report name="answer">
<article><h1>示例结果</h1><p>数量：<Value data={summary.total} /></p><p>首项：<Value data={summary.rows[0].level} /></p><figure><Figure ref="comparison" /><figcaption>类别比较</figcaption></figure><figure><Figure ref="details" /><figcaption>明细</figcaption></figure></article>
</Report></Dari>
```

## 交付

Figures 可以独立于 Report 运行。已有图表数据位于 #figures.<name>，报告位于 #reports.<name>；使用 oks_project 读取，不会重新运行。单个 Report 自动选择，多个时用 answer 指定 reports.<name>。

运行后调用 oks_show({input:"oks://work/分析.dari#figures.comparison"}) 发布宿主持久附件。SVG 将返回的 markdown 原样放入回答即可内嵌展示。

报告或 Table 导出 HTML 附件；收到 present 字段后，用该对象调用宿主 present 工具，展示原生文件卡片。报告 .report.html 自带数据、来源和分析源码。附件按内容寻址，工作区清理不影响已导出内容；stale 表示已有输出对应的源码已修改。

更多交付信息见 tools/render_html#topics/delivery。

## 报告归档与复用

report.html 使用固定的 `<script type="json" id="oks-metadata">` 存放非执行 JSON 元数据 `{version:1,context,dari}`；回读只定位这段并解析 JSON，直接使用归档的作者结构与数据。用 oks_project 读取已运行报告的这些分支，例如：

```json
{"input":"oks://work/分析.dari#reports.answer","select":"context.{model,captures},dari.figures"}
```

context 保存本次 run、采集 batch、源码哈希、运行开始时间、模型标识，以及实际 context() 值的 captures 和采集记录 acquisitions。导出不会重新获取时间；复用采集时保留原始值与采集来源。一稿中未调用 context() 时 captures 为空，不生成替代时钟。

dari 保存 title、notes、assets 源码、pipeline 原文、各 reports 的正文源码及 figures。每个图表记录 code、binding、status，成功时包含此次实际输入 data（spec、rows，以及关系图的 nodeRows）；失败时记录原因。未被当前报告引用的资产、图表和其他报告也保留。dari.values 以规范化投影 code 为键保存正文实际引用的值，例如 `{"summary.total":42,"rows[0].count":7}`；空格和等价下标写法规整为同一键，相同投影跨报告只保存一次；仅保存实际展示的标量，不保存全部中间绑定。完整原文在 dari.source，恢复时可将它另存为 .dari 再检查执行。恢复后的执行遵循普通采集规则；需要沿用旧时间上下文时，将 captures 中的原值作为显式输入，避免调用 context() 取得新时刻。

这些字段按需投影，整份归档不会自动进入对话上下文。修改源码后读到的仍是旧运行快照，并标记 stale；重新运行后才更新。归档占用运行保留预算，超限时明确报告失败。
