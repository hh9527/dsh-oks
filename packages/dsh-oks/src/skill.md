# 用业务证据回答

先理解用户要比较的对象、统计口径和时间范围，再发现模型声明的能力，编写业务分析稿，检查结果后给出解读。
领域知识负责事实与能力约束；工具负责语法、计算和呈现。

## 准备知识

开始知识发现前，先用 `oks_read({path:"oks://memory/tools/ktools.lib.jq"})` 阅读已有方法，优先复用；能力不足时再补充并保存，供后续任务复用。需要理解或扩展内置方法时再读 `oks://builtin/tools/ktools.lib.jq`。

- 用 `oks_data({input:"oks://help/knowledge"})` 了解知识图。用户说法与领域词汇有差距时用 `va_ask`，随后搜索并读取事实核实。
- 知识图为 `{datasets,types,relations,tools,items}`。datasets 内有 fields/dimensions/measures/time_roles/business_links；types 内有 values 和分类引用。items 保存 `{key,names,doc}`。
- 搜索：`oks_data({input:"oks://knowledge",method:"oks://builtin/tools/ktools.lib.jq#search",args:{query:"候选词",take:10}})`。返回的二元地址原样使用，例如 `datasets/<encoded-id>#dimensions/<encoded-id>`。
- 读取：`oks_data({input:"oks://knowledge",method:"oks://builtin/tools/ktools.lib.jq#read",args:{key:"返回地址"}})`，取得配对的事实和说明。成员导航用 members 的 key/link，反向导航用 references；用 next 作为 skip 分页。
- 精确投影直接从知识图根开始，例如 `oks_data({input:"oks://knowledge",project:{types:{"原始类型ID":{values:"Value"}}}})`，只读取值域。地址中的 ID 为 URI 编码，字典键为原始 ID。
- project、method+args、pointer/offset/limit 三种读取方式互斥。project 规则：`"Value"` 保留值，`"Shape"` 查看类型/大小/键；对象规则选字面字段；`["Map",规则]` 遍历；`["TruncateThen",N,规则]` 先取前 N 项，再把规则作用于截断后的整个容器。
- 用 `oks_read({path:"oks://builtin/tools/ktools.lib.jq"})` 阅读内置方法源码。自定义方法统一写入 `oks://memory/tools/ktools.lib.jq`，只含注释和 `def name($args): ...;` 定义，输入为所选资源的值（知识图直接为 `{datasets,types,relations,tools,items}`）；调用 `oks_data({input:"oks://knowledge",method:"oks://memory/tools/ktools.lib.jq#name",args:{}})`。此文件跨会话保留，不被工作区自动清理；保存前编译，错误不会覆盖上一次合法内容。
- 查询语法：`oks_data({input:"oks://help/query"})` 列出主题，再用 `pointer:"/graph~1filter"` 等 JSON Pointer 读取单个主题（键内 / 写成 ~1）。ID、能力、值域和时间编码按实际领域声明核实。

## 用 DARI 定义分析

使用 oks_write/oks_edit 编辑 `oks://work/<问题>.dari`，`oks_run_answer({src:"oks://work/<问题>.dari"})` 执行完整源码。
DARI 是 JSX 风格容器；pipeline、jq 源码原样书写。Notes 保存业务口径。

```dari
<Dari title="本次查询概览">
<Notes>说明查询对象和统计口径。</Notes>
<Pipeline>
let plan = query({
  op: "Graph", root: "d",
  nodes: [{id: "d", entity: "<实际数据集ID>"}],
  edges: [], select: [], count: "d", limit: 100
});
let facts = exec_query(plan);
debug(facts);
let summary = jq("summary.jq", {facts});
</Pipeline>
<Asset language="jq" name="summary.jq">
{rowsReturned: (.facts.rows | length)}
</Asset>
<Report name="answer">
<article><h1>本次查询</h1><p>返回行数：<Value data={summary.rowsReturned} /></p></article>
</Report>
</Dari>
```

- Dari 包含一个 Pipeline、具名 Asset（language="jq"，name="a.jq"）、可选 Notes、Figures 和 Report。Figures 中定义具名图表，Report 可省略；没有 Report 时也可用 DARI 驱动对话回答。
- Report 以 article 为根；花括号中只写 pipeline 绑定或静态投影，例如 `{summary.rows[0]["中文键"]}`。对象在 pipeline 中构造，运算放 jq。
- 诊断携带原始 `.dari` 路径、行列和阶段；全部具名程序先校验，再执行查询。
- pipeline 支持不可变 let、debug、JSON 字面量/数组/对象、静态字段或下标，以及固定算子 query/exec_query/context/data/time_windows/jq/render_figure/render_html。变量先定义后引用，每条语句以分号结束。筛选、遍历、运算和聚合写在 jq。
- 算子输入直接是绑定的 `.data` 负荷：`jq("a.jq", {facts})` 看到 `{facts:负荷}`；`facts.rows[0]` 选择数据，来源和路径自动携带。字段缺失或越界明确失败。
- `query(Intent)` 只做模型校验和计划生成，不访问数据库，返回计划可见负荷 `{columns}`。先只写计划并用 `debug(plan.columns)` 核对列名和类型，再增加 `let facts=exec_query(plan);` 取得数据。exec_query 只接受 query 产生的完整计划绑定；手工对象、columns 投影和 jq 重构结果不能执行。顶层 limit 必填，范围 1..500。优先在 Intent 中完成总体聚合和排名。查询结果为 `{rows,columns,truncated}`；truncated 为 true 表示还有未返回的行，当前 rows 只是一部分；columns 是模型声明的 `{name,type,nullable}`，空结果也保留类型。回执预览列声明；完整读取用 `oks_data({input:"oks://work/draft.dari#facts",pointer:"/columns"})`，稿内可用 `debug(facts.columns)`。limit 是最终输出行数上限，不是总体规模或业务 Top-N。
- `data(value,{kind:"given"|"parameter"|"assumption"|"example"})` 记录给定材料的性质；第二参数默认 given。参数或假设要写清楚来源性质。
- `jq("a.jq",{...})` 引用当前文档的具名 jq，恰好输出一个 JSON 值。进入 map 后用 `$in` 保留具名输入：`. as $in | ...`。空结果用 [] 或 null。
- jq 对象键统一用双引号，尤其是中文、纯数字和含标点的键：`{"告警级别": .level, "2026": .count, "占比(%)": .ratio}`。读取这些键用 `.["告警级别"]` 或 `.["2026"]`；动态键用 `{($key): value}`。
- `debug(expr)` 查看中间值，可以嵌套 jq 或直接投影。小值进入回执，大值按返回引用只读查看。
- `exec_query(plan)` 与 `context()` 在同一采集批次复用首次成功结果；输入计划变化时只重新执行该查询及重算下游。context 没有输入，时间和时区在同一批次保持不变；修改 jq/模板不触发重查。`oks_run_answer({src:"oks://work/draft.dari",refresh:true})` 新建采集批次并运行；`renew_context({src:"oks://work/draft.dari"})` 只重置当前会话中该稿的批次，下次运行再采集，旧输出暂不可读。计划编译仍可复用。一个批次可以包含不同采集时刻，不代表数据库事务快照。回执 acquisitions 给出实际采集时间、原运行/批次和复用或重采原因。
- 紧邻 let/debug 前的独立 `//` 注释作为本步业务说明。源码、程序、实际输入和来源链由运行器保存。

## 时间

时间相关问题在稿内定义 `let ctx = context();`，以同一批次的显式时刻和用户浏览器时区为准。
`ctx.utc` 有 epochMillis、epochSeconds、rfc3339；`ctx.tz.client.id` 为时区。
用 `let months = time_windows(ctx,{unit:"month",count:3,mode:"complete"});` 生成带 label、时区及毫秒/RFC3339 起止的半开窗口。
complete 排除当前未完成期间；current 包含当前期间、末端可在未来；rolling 以捕获时刻为末端按日历回移。
用 `oks_data({input:"oks://help/time"})` 查细节。jq 时间原语使用 epoch 秒，可直接使用 epochSeconds；以 RFC3339 复核边界。
缺少或冲突的时区应向用户澄清。领域时间维度的值格式仍须按知识声明转换。

## 只读查看与改稿

- `oks_data({input:"oks://work/draft.dari#summary"})` 读取最近运行的已有输出；`#debug` 列调试输出，`#debug/1` 读其中一个。
- `pointer:"/rows"` 选择已有 JSON 子树，`offset:0,limit:5` 分页数组或对象成员。`meta:true` 查看来源和取值路径。读取不计算、不保存、不刷新。
- 编辑后的旧结果带 stale。失败、被阻塞、已移除或被回收的输出明确不可用，按反馈修改源码后重新运行。
- 需要新的筛选、摘要或计算时，在稿内增加绑定或 debug，再执行整稿。正常工具回执限 16 KiB，失败信息优先保留；查询和加工也有内部预算，适当收窄。

## 形成答案

- 呈现知识从图中读取：`tools/render_figure#kinds/<kind>` 提供图元映射与示例；`tools/render_figure#topics/table_headers` 提供表头转换；`tools/render_html#topics/references` 提供 XHTML 绑定与路径。用内置 read 方法读取；`oks_data({input:"oks://help/render"})` 查看入口。
- 图表规格在 Pipeline 定义：`let spec = {x:"level",value:"count"};`；图表独立定义为 `<Figures><ColumnChart name="severity" spec={spec} data={facts.rows} /></Figures>`。报告引用 `<figure><Figure ref="severity"/><figcaption>说明</figcaption></figure>`；文字交叉引用用 `<FigureRef ref="severity"/>`，目标必须在本 Report 出现。每份 Report 按首次展示顺序分别编图号、表号，重复引用复用编号。id/class/title/lang 写在 figure。
- 图元：BarChart/ColumnChart/LineChart/AreaChart/PieChart/ScatterChart/Histogram/BoxPlot/Heatmap/RadarChart/Sankey/NetworkGraph/Gauge/Table。标签选择类型，spec 省略 kind；仅 NetworkGraph 接受 nodes 引用。Table 的 spec 如 `{columns:["列名"]}`；中文表头在 jq 重命名。
- 标量写 `<Value data={summary.total} />`；普通正文元素和属性静态书写。正文遵守 XHTML 元素/属性白名单，文本中的 & 与 < 使用实体；pipeline 与 jq 无需 XML 转义。
- 业务数字从引用和计算进入正文；文字中的数字用 `<span data-oks-lit="">…</span>` 声明。结论和评价用 data-oks-shrink 标记。
- 输出地址：`#binding` 读取 pipeline 数据，`#figures.severity` 读取具名图表，`#reports.answer` 读取报告；均用 oks_data，返回负荷为 .data。单个 Report 自动选中；多个时用 answer:"reports.answer" 选择。
- 运行后用 `oks_show({input:"oks://work/分析.dari#figures.severity"})` 将已有图表保存为宿主持久附件；将返回的 markdown 原样嵌入回答，SVG 在对话中展示。`#reports.answer` 与 Table 导出 HTML 附件；收到 `present` 字段后，立即以该对象为参数调用宿主 `present` 工具，显示文件卡片。此调用读取已运行的结果；回执的 stale 标明源码是否已编辑。附件按内容寻址，工作区清理不影响已导出内容。独立图表用标题，不添加报告编号。
- 运行返回选中的报告地址 `delivery.input`；用 `oks_show({input:"oks://work/分析.dari#reports.answer"})` 导出 `.report.html` 附件，随后调用 `present(返回值.present)`，将报告作为文件卡片交付。最终回答说明结论即可。报告自带展示数据、来源及 jq/XHTML。
- 计算状态和交付状态分别检查；独立 debug 失败不代表答案依赖失败。回复超过预算或呈现形式不受支持时，改稿或选择报告交付。
- 导出前用 `oks_data({input:"oks://work/分析.dari#reports.answer"})` 读取报告数据（assets/items/structure）。`oks_read/write/edit/list/delete` 管理 `oks://work/` 临时源码与 `oks://memory/tools/ktools.lib.jq` 持久方法库；`oks_read` 也支持只读的内置源码。

回答中解释业务口径、证据和局限，与用户原始意图核对；能力不支持时说明缺口，避免用不同统计口径悄悄替代。

- 编译预检汇总独立的 pipeline、jq assets、figures 和 reports 错误；有错误时只检查、不执行。回执预览多个单元的诊断，`omittedDiagnostics` 标明未展示数量。用 `oks_data({input:"oks://work/分析.dari#diagnostics",offset:0,limit:10})` 分页读取完整诊断；单元失败不阻止其他可独立判断的检查。容器结构无法解析时先修复容器语法。
