# DARI 分析稿

## start

### title

分析稿的结构与最小示例

### text

使用 oks_write/oks_edit 编辑 oks://work/<问题>.dari，使用 oks_run_answer({src:"oks://work/<问题>.dari"}) 检查并执行。DARI 是 JSX 风格容器，Pipeline 与 jq 源码原样书写；Notes 保存业务口径。Report 可省略，分析结果也可以直接用于对话回答。

### dari

```source
<Dari title="本次查询概览">
<Notes>说明查询对象和统计口径。</Notes>
<Pipeline>
plan <- query({
  op: "Graph", root: "d",
  nodes: [{id: "d", entity: "<实际数据集ID>"}],
  edges: [], select: [], count: "d", limit: 100
});
facts <- exec_query(plan);
summary <- jq("summary.jq", {facts});
{summary}
</Pipeline>
<Asset language="jq" name="summary.jq">
{rowsReturned: (.facts.rows | length)}
</Asset>
<Report name="answer">
<article><h1>本次查询</h1><p>返回行数：<Value data={summary.rowsReturned} /></p></article>
</Report>
</Dari>
```

## pipeline

### title

绑定、投影与算子

### text

pipeline 用 `name <- expression;` 声明不可变绑定，禁止重复名称与 shadow。名字先定义后引用；可选的末尾对象声明展示输出，例如 `{facts, columns: plan.columns}`，末尾对象可带分号。支持 JSON 字面量/数组/对象、静态字段或下标，以及固定算子 query/exec_query/context/data/time_windows/jq/render_figure/render_html。筛选、遍历、运算和聚合写在 jq。

所有 assets、Pipeline、Figures 和 Report 先编译校验，汇总诊断，通过后才开始执行。节点按引用组成 DAG，依赖就绪即可执行，独立分支逻辑并行；源码顺序只约束引用，不串行化执行。失败只阻塞其下游。

名字以 `_` 开头的节点不跨运行保留计算缓存，本次运行内多个引用共享结果。context()/exec_query() 的采集批次规则独立保留：输入不变时复用，refresh 或 renew_context 重置。

算子输入直接是绑定的 `.data` 负荷：`jq("a.jq", {facts})` 看到 `{facts:负荷}`；`facts.rows[0]` 选择数据，来源和路径自动携带。字段缺失或越界明确失败。

`data(value,{kind:"given"|"parameter"|"assumption"|"example"})` 记录给定材料的性质；第二参数默认 given。参数或假设要写清楚来源性质。

紧邻绑定或末尾输出对象前的独立 `//` 注释作为本步业务说明。源码、程序、实际输入和来源链由运行器保存。

## query

### title

先检查计划，再执行查询

### text

`query(Intent)` 只做模型校验和计划生成，不访问数据库，返回计划可见负荷 `{columns}`。先只写计划并用 `{columns:plan.columns}` 核对列名和类型，再增加 `facts <-exec_query(plan);` 取得数据。exec_query 只接受 query 产生的完整计划绑定；手工对象、columns 投影和 jq 重构结果不能执行。顶层 limit 必填，范围 1..500。优先在 Intent 中完成总体聚合和排名。查询结果为 `{rows,columns,truncated}`；truncated 为 true 表示还有未返回的行，当前 rows 只是一部分；columns 是模型声明的 `{name,type,nullable}`，空结果也保留类型。回执预览列声明；完整读取用 `oks_project({input:"oks://work/draft.dari#facts",select:"columns"})`，稿内可用 `{columns:facts.columns}`。limit 是最终输出行数上限，不是总体规模或业务 Top-N。

### syntax

#### input

oks://help/query.md

## jq

### title

jq 输入、输出与语法

### text

`jq("a.jq",{...})` 引用当前文档的具名 jq，恰好输出一个 JSON 值。进入 map 后用 `$in` 保留具名输入：`. as $in | ...`。空结果用 [] 或 null。

jq 对象键统一用双引号，尤其是中文、纯数字和含标点的键：`{"告警级别": .level, "2026": .count, "占比(%)": .ratio}`。读取这些键用 `.["告警级别"]` 或 `.["2026"]`；动态键用 `{($key): value}`。

## output

### title

查看中间结果与诊断

### text

Pipeline 最后用对象声明展示输出，例如 `{summary, columns:plan.columns}`。小值进入运行回执的 output 项，大值保留只读地址；用 `oks_project({input:"oks://work/draft.dari#output"})` 读取完整对象，或用 select 精确投影。`output` 是末尾对象的保留名称，不能用于绑定。末尾对象可省略，Figures 和 Report 可直接引用所有绑定。

已有具名中间值也可以直接读取，例如 `oks_project({input:"oks://work/draft.dari#summary"})`。读取不会执行 SQL、重新计算或刷新时间上下文。修改稿件后，已有结果标记 stale，重新运行后得到新结果。

完整编译诊断通过 `#diagnostics` 读取，失败节点通过 `#failures` 读取；可用 select 根切片分批查看。

需要新的筛选、摘要或计算时，在稿内增加绑定或调整末尾对象，再执行整稿。正常工具回执限 16 KiB，失败信息优先保留；查询和加工也有内部预算，适当收窄。

## acquisition

### title

采集复用、刷新与时间上下文

### text

`exec_query(plan)` 与 `context()` 在同一采集批次复用首次成功结果；输入计划变化时只重新执行该查询及重算下游。context 没有输入，时间和时区在同一批次保持不变；修改 jq/模板不触发重查。`oks_run_answer({src:"oks://work/draft.dari",refresh:true})` 新建采集批次并运行；`renew_context({src:"oks://work/draft.dari"})` 只重置当前会话中该稿的批次，下次运行再采集，旧输出暂不可读。计划编译仍可复用。一个批次可以包含不同采集时刻，不代表数据库事务快照。回执 acquisitions 给出实际采集时间、原运行/批次和复用或重采原因。

### time

#### input

oks://help/time.md

## figures

### title

独立图表与报告引用

### text

图表规格在 Pipeline 定义：`spec <- {x:"level",value:"count"};`；图表独立定义为 `<Figures><ColumnChart name="severity" spec={spec} data={facts.rows} /></Figures>`。报告引用 `<figure><Figure ref="severity"/><figcaption>说明</figcaption></figure>`；文字交叉引用用 `<FigureRef ref="severity"/>`，目标必须在本 Report 出现。每份 Report 按首次展示顺序分别编图号、表号，重复引用复用编号。id/class/title/lang 写在 figure。

标量写 `<Value data={summary.total} />`；普通正文元素和属性静态书写。正文遵守 XHTML 元素/属性白名单，文本中的 & 与 < 使用实体；pipeline 与 jq 无需 XML 转义。

业务数字从引用和计算进入正文；文字中的数字用 `<span data-oks-lit="">…</span>` 声明。结论和评价用 data-oks-shrink 标记。

输出地址：`#binding` 读取 pipeline 数据，`#figures.severity` 读取具名图表，`#reports.answer` 读取报告；均用 oks_project，返回负荷为 .data。单个 Report 自动选中；多个时用 answer:"reports.answer" 选择。

### discover

#### input

oks://help/figures.md

## delivery

### title

检查结果并交付图表或报告

### text

运行后用 `oks_show({input:"oks://work/分析.dari#figures.severity"})` 将已有图表保存为宿主持久附件；将返回的 markdown 原样嵌入回答，SVG 在对话中展示。`#reports.answer` 与 Table 导出 HTML 附件；收到 `present` 字段后，立即以该对象为参数调用宿主 `present` 工具，显示文件卡片。此调用读取已运行的结果；回执的 stale 标明源码是否已编辑。附件按内容寻址，工作区清理不影响已导出内容。独立图表用标题，不添加报告编号。

运行返回选中的报告地址 `delivery.input`；用 `oks_show({input:"oks://work/分析.dari#reports.answer"})` 导出 `.report.html` 附件，随后调用 `present(返回值.present)`，将报告作为文件卡片交付。最终回答说明结论即可。报告自带展示数据、来源及 jq/XHTML。

计算状态和交付状态分别检查；独立分支失败不代表答案依赖失败。回复超过预算或呈现形式不受支持时，改稿或选择报告交付。

导出前用 `oks_project({input:"oks://work/分析.dari#reports.answer"})` 读取报告数据（assets/items/structure）。`oks_read/write/edit/list/delete` 管理 `oks://work/` 临时源码与 `oks://memory/tools/ktools.lib.jq` 持久方法库；`oks_read` 也支持只读的内置源码。
