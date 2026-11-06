# DARI 手册

## 文件与声明

用宿主文件工具读写 `.dari`。src 是工作区内的相对路径或绝对路径。`remove_file({path})` 只删一个文件；`move_entry({src,sink})` 的两个参数都是最终名称。`oks_read` 只读取内置手册。

```dari
data ctx = context();
data weeks = time_windows(ctx,{unit:"week",count:2,mode:"complete"});
data prev = weeks[0];
data last = weeks[1];
data facts = query({
    op:"Graph",root:"d",nodes:[{id:"d",entity:"<数据集短名称>"}],edges:[],
    select:[],count:"d",limit:100
});
data summary = select_one({from:{s:facts},group_by:(r)=>({}),
    fields:(g,rows)=>({returned_groups:count(rows)})});
answer tree! { Answer [
    h1 ["对象概览"],
    p ["返回分组数：",Value(data=summary?.returned_groups)],
] };
```

示例中的模型名称是占位符，以知识定义替换。扩展组件使用 PascalCase（如 Value、Lit、UseFigure），普通标签使用小写（如 p、strong）。`data` 定义不可变计算，`figure` 定义图表，`report` 定义报告；`answer tree! { Answer [...] }` 是唯一回答出口。figure/report/answer 的节点树必须用 `tree! { ... }` 包围，内部仍用 `tag(...) [...]`；figure 的根节点为图表组件或 Table。`=` 仅声明不可变绑定，不支持重新赋值。True/False/None 是 DARI 字面量，工具参数与返回 JSON 仍用 true/false/null。所有绑定共用命名空间，先定义后引用，每条声明以 `;` 结束；支持 `//` 和 `/* ... */` 注释。

表达式使用字符串、数字、Bool（True/False）、None、对象、数组、函数和绑定引用。分析稿自行定义的绑定、对象键和表列使用 ASCII 名称；中文用于报告正文、图表和表格标签等展示内容。读取外部模型中已有的特殊键时使用双引号及方括号，例如 `row["设备分类"]`；可空对象使用 `map_opt(obj,r=>r["设备分类"])`。

## 检查与解析

`dari_check({src:"analysis.dari"})` 检查全稿，不执行 SQL、不读取业务行。query 在检查期调用模型的 transform 得到 columns，建立 Table(T)，参与后续类型推导；context/time_windows 等已知计算在检查期执行，context 使用固定示例时刻。运行期取得实际值并校验值域、完整性和资源限制。

检查回执是文本：成功 Succeed，失败 CheckFailed，后接分割线。`diagnostics` 在有诊断时首先列出原稿行列及原因，最多 20 条，超过报告省略数，不重复上游连锁错误。`unresolved-node-types` 列出类型未就绪的公开声明；`inspect-node-types` 列出首次出现、从未就绪恢复或类型形状变化的数据和图表，以及显式 inspect 的类型。与同一会话、同一稿件上一次 check 或 resolve 相比未变化的类型省略。不可恢复的语法错误可能无法列声明。

```js
dari_check({src:"analysis.dari",inspect:{data:["facts","summary"],figures:["counts"]}})
```

`inspect?: {data?: string[], figures?: string[]}` 是可选参数，仅在忘记已报告的类型时使用，例如上下文压缩后。它使用源码绑定名，每类最多 32 项，强制重报数据和图表输入的类型形状，不重述源码定义。类型比较包含类型、字段、可空性、表列顺序，不含值、源码、数组长度或运行缓存。普通对象字段按名排序；类型状态与数据执行缓存独立。稿件状态回收或插件重启后，下一次检查重新报告类型。

```js
dari_resolve({src:"analysis.dari"})
dari_renew_context({src:"analysis.dari"})
```

resolve 先检查全稿，再执行唯一 Answer 及其依赖，把 Answer 作为带来源标记的消息交付到会话，工具回执只给出消息 id、run 和计数。答案已自动交付，不要重复；回执说明交付失败时才转发原文。只接收 src，不提供 data/figures/reports/answer 选择参数。UseFigure/UseReport 在选中分支中发布图表与报告；Table 直接成为 Markdown 表格。检查失败 CheckFailed，执行失败 ResolveFailed，均表现为失败工具调用。

同稿共享计算与缓存，改后处理不重新取数。采集上下文按会话及稿件真实路径冻结；renew_context 创建新上下文，下一次 resolve 重新取数，不接收 refresh。执行使用临时 SQLite 文件，最后一次运行结束后空闲 15 分钟关闭删除；检查使用独立内存库，不延长执行缓存。

默认直接解析；requireRunApproval=true 时宿主申请批准，绑定源码、模型、数据配置及冻结上下文。等待期间源码或配置变化会拒绝继续。

## 时间

`context()` 提供 `ctx.utc.epochMillis`、`ctx.utc.rfc3339`、`ctx.tz.client.id`（IANA 时区）、该时刻的 offset/offsetMinutes。`time_windows(ctx,{unit,count,mode})` 使用其中的客户端时区：unit=year|quarter|month|week|day，count=1..50。

- complete：最近 N 个已完成日历周期。
- current：包含当前周期，最后结束于下一日历边界，可能在未来。
- rolling：以冻结时刻为终点，边界从该时刻平移；月末收缩到可用日期，保留毫秒。

窗口从早到晚，周一为周起点，区间 `[start,end)`。自然日可以是 23/25 小时；IANA 日历运算不等于固定偏移或固定毫秒相减。每项有 label、zone、start/end；边界字段如下：

| 字段 | 类型和用途 |
| --- | --- |
| epochMillis | EpochMillis，UTC 整数毫秒 |
| dateTimeUtc | DateTimeUtc，YYYY-MM-DDTHH:MM:SS.SSSZ |
| rfc3339 | String，含本地偏移的展示文本 |

按知识中的时间维度逻辑类型选择 epochMillis 或 dateTimeUtc；rfc3339 和 zone 用于展示。query.time_windows.dimension 使用实际维度短名称，不是时间角色 ID。日期标签不能替代边界。

```dari
data ctx = context();
data days = time_windows(ctx,{unit:"day",count:7,mode:"complete"});
data facts = query({
    op:"Graph",root:"a",nodes:[{id:"a",entity:"current_alarm"}],edges:[],
    select:[{node:"a",dimension:"alarm_tenant_id"}],
    measures:[{node:"a",measure:"alarm_count"}],
    time_windows:[{node:"a",dimension:"alarm_occur_utc_raw",
        start:days[0].start.epochMillis,end:days[6].end.epochMillis}],limit:500
});
```

该时间示例采用 IC 的 EpochMillis 维度；其他模型依实际定义替换，DateTimeUtc 维度使用 dateTimeUtc 边界。

## 有类型后处理

query 返回 Table(T)，列名和可空性由模型 columns 决定。行结构是 `r.<from别名>.<完整列名>`：若列叫 a_alarm_severity，访问 `r.s.a_alarm_severity`，不是 `r.s.a.alarm_severity`。使用检查返回的列名。

```dari
data comparison = select({
    from:{b:base},
    joins:[{kind:"inner",source:{c:current},on:r=>r.b.server_id==r.c.server_id}],
    where:r=>is_some(r.b.cpu)&&is_some(r.c.cpu),
    fields:r=>({id:r.b.server_id,delta:r.c.cpu-r.b.cpu}),
    order_by:out=>[desc(out.delta),asc(out.id)],limit:3
});
data winner = select_one({from:{s:comparison},fields:r=>({id:r.s.id,delta:r.s.delta}),
    order_by:out=>[desc(out.delta),asc(out.id)],limit:1});
```

from 恰好一个别名和表，joins 顺序引入 inner/left 连接。on/where 返回 Bool；left join 的右行是 Option(记录)，用 `r.c?.name ?? "未关联"`。当前 join.on 可访问尚未补空的当前右行；后续表达式处理可空性。类型检查不证明连接键唯一，粒度依据领域知识。

fields 返回标量记录，决定列名；order_by 读取投影后的 out，asc/desc 默认空值排最后，可加 `{nulls:"first"}`。select_one 返回 Option(记录)：零行 None，一行对象，多行 CardinalityViolation；第一名用显式排序和 limit:1。

```dari
data groups = select({from:{s:samples},group_by:r=>({tenant:r.s.tenant_id}),
    fields:(g,rows)=>({tenant:g.tenant,n:count(rows),valid:count(rows.s.cpu),cpu:avg(rows.s.cpu)}),
    having:out=>out.valid>0,order_by:out=>[desc(out.cpu),asc(out.tenant)]});
```

分组 fields 接收 `(g,rows)`；g 是键，rows 的列只用于聚合。count(rows) 计行，count(列) 计非空，返回 Int；sum/avg/min/max 忽略缺失。sum/min/max 返回 Option(原类型)，avg 返回 Option(Float)。`group_by:r=>({})` 是全局聚合，空表也有一组，count=0，其余为 None。

| 表达式 | 语义 |
| --- | --- |
| is_some(x) / is_none(x) | Option → Bool；`x==None` 等价 is_none(x) |
| x?.field / x ?? fallback | 可选投影展平 Option；显式缺失行为 |
| map_opt(x,v=>expr) | 处理可选普通对象或标量 |
| round(x,digits) | 保留数值类型/可空性，digits 已知 0..15 |
| concat(a,b,...) | 拼接字符串，保留缺失 |
| case_when(test,a,b) | test 为 Bool，两分支类型兼容 |
| lookup(x,[{value,label},...]) | 精确静态查表，返回 Option(LabelType) |

Int/Float 可提升，String 与数字不隐式转换；Option 算术仍是 Option，不补零。除法返回 Option(Float)，零除为 None；可空比较返回 Option(Bool)，谓词显式用 `(r.s.cpu>0) ?? False`。

lookup 的映射是检查期已知非空数组，每项恰好 value/label。value 同类型非空标量且匹配输入类型，重复报错；label 为兼容标量，可含 null。输入 null 或未命中返回 null，用 `??` 给默认值；映射可复用。

`table([{name:"示例",count:3}],{kind:"example"})` 创建静态演示表；空数组/全 null 列无类型依据会报错。`map(days,(day,index)=>query({...}))` 对已知有界数组展开，最多 50 项、全稿最多 128 个查询；业务结果不能决定新 query 参数或数量。`union_all(parts)` 合并同 schema 表数组，保留重复行，列名和顺序一致，Int/Float 可提升；无 schema 的空数组不能合并，合并后排序用 select。

## 模型查询：{{intentContract}}

Intent 顶层 op 为 Graph、GraphPair 或 GraphUnion，顶层 limit 必填 1..500，限制业务操作完成后的输出行数；业务 take/Top-N 另行表达，嵌套操作数无需 limit。query 检查得到 schema，解析时取数并报告截断。

### Graph

```js
{op:"Graph",root:"d",nodes:[{id:"d",entity:"<数据集短名称>"}],edges:[],
 select:[{node:"d",dimension:"<维度短名称>"}],
 measures:[{node:"d",measure:"<指标短名称>"}],limit:500}
```

| 键 | 形状/含义 |
| --- | --- |
| nodes | `{id,entity}` 数组；entity 是数据集短名称，id 是查询内别名 |
| edges / constraints | `{relation,from,to}` 数组；relation 是关系短名称，端点是别名，方向依声明 |
| select / measures | `{node,dimension}` / `{node,measure}` 数组 |
| filters | `{node,dimension,op,value}` 数组，按维度授权筛选 |
| any_of | `{node,dimension,values}` 数组，匹配备选值 |
| time_windows | `{node,dimension,start,end}` 数组，显式 `[start,end)`；end 必填非 null，start 可省略/null 表示此前全部历史 |
| group_by_identity | 节点别名数组，按声明的完整身份分组 |
| count / count_value | 节点别名 / `{node,dimension}`；行数/非空值计数 |
| count_having | `{op,value}`，整数计数筛选；count_groups/include_empty 为 Bool |
| measure_having | `{node,measure,op,value}` 数组，value 按度量输出类型 |
| order_by / take | `[{node,dimension,direction}]` / 正整数，direction=Asc|Desc，原始全局 Top-N |
| top_by_measure | `{node,measure,direction,take}`，按声明的聚合值排名 |
| top_per | `{owner,sample,rank,take}`，逐 owner 的原始样本 Top-N |
| row_grain / distinct | Root 或 Association / Bool，遵循模型粒度约束 |

必填 Graph、root、nodes、edges、select；投影维度/指标或显式指定计数对象。隐藏身份键不可拆分用户可见分组。原始 order_by+take 与聚合 Min/Max 不同，最高平均值与最高样本峰值不同；原始 take 使用完整粒度身份并列裁决。原始 ASC 空值在前，DESC 空值在后；Min 忽略空值。top_per 要求恰好一条 sample→owner 边，owner 端 One/Optional，样本有粒度，rank 为有序样本维度。

measure_having 的度量要在 measures 中。常见合法结构是 group_by_identity=[root] 且只选根维度；另一种为 context→owner、sample→owner，两条 owner 端 One/Optional，身份完整，group_by_identity=[root,owner]，只选 context/owner 维度，可附加一条至多为一的 owner→ancestor 边并选 ancestor 维度。后者恰好三或四节点，不附加计数、业务连接或 include_empty；具体合法性由模型检查。exists.having 按自身总体校验。

### 筛选和值域

- Eq/Ne 比较兼容逻辑值；Gt/Ge/Lt/Le 用于授权的数值/时间等有序类型。Bool/Ipv4 不支持有序比较，Text 字典序不代表数字或时间顺序。Ne 不包含 NULL。
- Contains/NotContains/StartsWith/EndsWith 仅用于授权的 Text 维度，字面文本、当前忽略大小写，不接收 SQL/正则。
- InSubnet/NotInSubnet 仅用于授权 Ipv4 维度，value 是规范 CIDR，如 10.4.16.0/20；掩码 0..32，主机位零、无前导零，不包含 NULL，不支持 IPv6/隐式 Text 转换。
- 半开放枚举已知概念用列出的业务 ID；`{unknown:"原始值"}` 匹配一个未知底层值，`{unknowns:True}` 匹配所有未知非空值。结果标记列见维度 value_contract。筛选输入不提供 kind。
- 逻辑类型与物理存储分开。字段为 String/Int 不代表获得字符串或数值操作；ops、filterable、projectable、input_kinds 和规范值依知识声明，类型能力本身不授予权限。
- DateTimeUtc 是规范三位毫秒 UTC 文本，EpochMillis 是整数毫秒；Date 不含时区，DateTime 是无时区日历日期时间，转换成绝对时刻需要明确时区。
- 使用声明的 UTC 分桶维度按小时/天/月聚合，无 granularity 参数；先对原始时间加窗口。UTC 桶不是客户端自然日，月底按日历计算。

### EXISTS 与 Latest

exists 为数组，各项 `{anchor,nodes,edges,filters?,constraints?,time_windows?,any_of?,having?,negated?}`。anchor 是外层别名，内层节点仅在 EXISTS 内存在，edges 可引用锚点；having 项 `{node,measure,op,value}`。只要求关联记录存在时使用 EXISTS 限定外层总体，避免连接倍增，不需要 filters 可省略。

Latest 是模型声明的数值指标，仍用 measures 选择；按权威 UTC 时刻降序、空时刻最后，再按完整剩余样本粒度升序裁决。返回该行原值，保留 NULL，不回退更旧非空值。同一样本节点共用所选行；筛选、关联、时间窗及 EXISTS 在选行前，measure_having 在其后。缺失 owner 采用内关联，不扩展 include_empty。逐 owner 使用完整身份，可用于 top_by_measure/GraphPair；同组只有一个 Latest 样本源/顺序，不支持 distinct、聚合局部 filter、外部依赖、top_per、派生 union 或嵌套 EXISTS 聚合谓词。

### GraphPair

比较同一实体两组总体的一项数值指标；比较多个指标时分别查询，再用后处理统一量纲与排序。

```js
{op:"GraphPair",limit:500,left:<Graph>,right:<Graph>,
 align_by:[{left:{node:"a"},right:{node:"b"}}],
 select:[{side:"Left",node:"a",dimension:"<展示维度>"}],
 rank_by:{op:"GrowthRate",current:"Right",baseline:"Left",direction:"Desc",take:10}}
```

align_by 非空，配对相同实体的完整身份，节点不重复；每侧恰好一个度量，select 为空/省略，group_by_identity 从 root 开始且与对齐节点顺序一致。外层 select 必填（可空），只能选对齐身份决定的属性。两侧按身份内关联；周期比较对齐 owner，包含时间的样本身份不代表周期，互斥时间窗下对齐同一样本会拒绝。

输出为按 select 顺序的展示列及两侧指标，前缀 left_/right_，半开放值域紧邻 __kind。展示值变化不影响对齐。操作数不支持 count/distinct/include_empty/order_by/take/top_by_measure/top_per。

| rank_by.op | 其余键 | 公式 |
| --- | --- | --- |
| Subtract | minuend,subtrahend,direction,take | 被减侧−减侧 |
| Ratio | numerator,denominator,direction,take | 分子侧/分母侧 |
| GrowthRate | current,baseline,direction,take | (当前侧−基线侧)/基线侧 |

侧名 Left/Right 且互异，direction=Asc|Desc，take=1..1000。两指标数值且单位兼容，不同指标 ID 要相同非 null 单位。NULL 排除；Ratio 排除零分母，GrowthRate 排除非正基线。追加 comparison_value，按该值排名，身份并列升序；Subtract 保留单位（百分数相减为百分点），Ratio/GrowthRate 无量纲，0.2 增长率表示 20%。rank_by 与 count_groups:True 不能并用；无排名时 count_groups 计所有对齐身份，无 comparison_value。

GraphUnion 为 `{op:"GraphUnion",limit:500,branches:[{result_node,graph},...]}`：至少两个 Graph 返回相同实体、按相同顺序选相同维度，分支是无序原始行，按完整结果身份并集去重。

## 图表与排版

`tag(attr=expression,...) [children]`；属性或子节点为空可省略，children 为字符串或节点，以逗号分隔，允许尾逗号。中文、&、< 直接写，渲染器负责转义。figure 的 data 是 Table(T)，不加 `.rows`，组件标签决定图表类型，spec 不写 kind。

```dari
figure counts = tree! { ColumnChart(spec={x:"name",value:"count"},data=grouped) };
report full = tree! { Report [
    h1 ["对象统计"],
    p ["总数：",Value(data=summary?.total)],
    UseFigure(ref=counts,caption="类别分布"),
] };
answer tree! { Answer [
    p ["分析结果如下"],
    UseFigure(ref=counts,caption="类别分布"),
    UseReport(ref=full),
] };
```

{{figureIndex}}

索引已载入；只在选定图表且需要详细映射/开关时读取对应分册。通用完整规格按需读 oks://help/figure-options.md。先在 query/select 中聚合，图表不汇总重复单元。字段映射使用检查列名。Table.columns 是字符串列名数组，`labels:{level:"告警级别"}` 为列设置展示表头，未映射的列使用列名；只有 NetworkGraph 接受独立 nodes 表。

BarChart/ColumnChart 单组，不接受 series，颜色按 x 类别使用 style.colors，一个颜色可统一；GroupedBarChart/GroupedColumnChart 必填 series，颜色按序列且与图例一致，单序列仍保留图例；分组柱支持 stack=total|percent。

LineChart/AreaChart 的 xType 必填 Int|Float|String|Rfc3339|EpochMillis，不推断编码。Int/Float 数值轴，String 类别轴；Rfc3339 接受带时区 RFC3339 文本，EpochMillis 接受整数毫秒。检查列类型、运行校验实际值；数值/时间 x 在各序列内非递减。

排版用 `layout:{labelFont:12,titleFont:16}`，行高、条厚、间距和画布高度依字号与类别/序列数推导，不设置 height/rowHeight。排序/标签用 `style:{sort:"desc",labels:True}`。未知键及层级放错在检查中报错；颜色、标题、轴名和单位等专用键见所选分册。

## Report 与 Answer

Report 支持 section、h1/h2/h3、p、div/span、ul/ol/li、blockquote、pre/code、strong/em、a、br/hr、Value/value、Lit、UseFigure、FigureRef；静态排版属性使用字符串，如 `p(class="lead")`。不直接写 table/tr/td/th 或 figure/figurecaption，表格和图表均通过 UseFigure。`FigureRef(ref=counts)` 在报告中显示图/表编号，caption 是可选静态说明。

Report 的动态数值用 `Value(data=round(summary?.cpu,2))`，普通记录先由 select_one 得到标量；`Lit ["1.2"]` 明确表示静态文本，只接受字符串子节点。

唯一 Answer 使用同样节点风格：h1/h2/h3→Markdown 标题，strong/em→强调，p、列表、引用、代码、链接转为对应 Markdown。动态值写 `Value(data=summary?.total)`，null 显示破折号；文字和值转义 Markdown。Answer 不接受 class/id 等不能转成 Markdown 的属性。

Report/Answer 子节点支持条件分支，分支内仍以逗号分隔同级节点：

```dari
answer tree! { Answer [
    if (summary?.total > 0 ?? False) [p ["有数据"]] else [p ["没有数据"]],
    if let Some(i) = summary [p ["总数：",Value(data=i.total)]] else [],
] };
```

条件必须为 Bool，Option(Bool) 显式用 `?? False` 等处理；else 可省略或接 else if。if let 要求 Option(T)，Some 绑定仅在第一个分支内有效，类型为 T；含下标的待解包表达式用括号包围，如 `if let Some(i) = (items[0]) [...]`。所有分支都检查类型、节点和溯源；运行只展示选中分支，未选中的 UseFigure/UseReport 不发布附件。条件不改变 query 取数计划。

UseFigure 在 Answer 中发布图形并嵌入图片，Table 直接嵌入 Markdown 表格；在 Report 中嵌入图形/表格并自动编号。UseReport 仅用于 Answer，发布已声明 Report 的可点击链接，无需另调 present；同一次解析同一产物仅发布一次。

报告归档保留两个不执行的 script：dari-source 保存源码，dari-context 保存实际上下文、执行时间及模型标识等元数据；不再重复保存 dari-values。所有 SVG 在非显示 metadata 节点内携带最终图表输入 CSV（dari-data；网络图另有 dari-nodes）与紧凑 JSON spec（dari-spec），便于读图；不附源码、上下文或溯源信息。表格与正文引用值直接从 HTML 读取；报告仍保留源码与执行元数据。

`report_extract_dari({src:"report.html",sink:"restored.dari"})` 将归档源码写入新的指定文件，附加历史上下文、执行时间和模型标识等注释；目录已存在且不覆盖文件。不执行查询，重新运行会取得新上下文，不保证重现旧结果。提取后用宿主文件工具编辑。
