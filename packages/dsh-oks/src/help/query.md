# 查询意图

## 工具查询契约

{{intentContract}}；分析稿中的 query(Intent) 校验并生成带 columns 的计划，不访问数据库；exec_query(plan) 执行计划。每个 Intent 的 limit 为 1..500，业务能力与 ID 来自知识图。语法变更需同步检查解析器与帮助。

## 比较操作

Eq 和 Ne 比较兼容的逻辑值；Gt、Ge、Lt、Le 还适用于整数、浮点数及时间类型。Text 的字典序比较由模型声明，不代表数值或时间顺序。Bool 与 Ipv4 不支持有序比较。类型的 detail.operations 描述支持的操作，每个字段的权限还要查看维度的 filterable 与 ops。值必须符合逻辑格式和规范值契约。NULL 比较与普通值比较不同，Ne 不包含缺失值。

## 文本匹配操作

Contains、NotContains、StartsWith、EndsWith 只用于已授权的 Text 维度。输入是字面文本，不接受调用方提供的 SQL 或正则模式。当前匹配忽略大小写。操作被拒绝时，不能擅自改用另一操作，因为它们选取的总体不同。文本存储本身不授予逻辑地址或时间的文本匹配能力。

## UTC 时间分桶

声明的 UTC 分桶维度投影小时、天或日历月起点。与声明的度量一起选择，按桶聚合；Intent 不接受 granularity 参数。DateTimeUtc 输出规范 UTC 格式 YYYY-MM-DDTHH:MM:SSZ；Date 输出 YYYY-MM-DD，仅支持天/月；EpochMillis 输出整数 Unix 毫秒。输入输出逻辑类型一致，NULL 保持 NULL。公共日历范围为 0001..9999 年，越界 epoch 返回 NULL。负 epoch 向较早的桶取整；月是日历操作，不是固定时长。PostgreSQL 会话时区不改变桶边界。先对原始时间维度应用显式半开窗口，再按桶分组；只有用户要求该总体时才用桶筛选替代原窗口。时区、时钟、本地日历解释和类型转换均须显式确定。

## 时间窗口操作

Graph 的 time_windows 项为 {node,dimension,start,end}，可位于根或 exists 中。维度必须声明时间角色，授权 end 所需的 Lt；提供 start 时还需授权 Ge。区间为 [start,end)，包含 start、不包含 end。end 必填、非 null 且为具体值；start 可为 null 或省略，表示 end 之前的全部历史。规划时固定 end，使意图包含明确截止点。边界使用该维度的同一逻辑格式，start 必须早于 end。SQL 对原始列使用绑定值：>= start AND < end，省略 start 时仅 < end。时钟、数据库 now()、时区和列侧时间转换都不隐式引入。昨天、最近七天、日历月等相对时期须先用应用参考时间和时区计算，再提交具体边界。日历日不一定为 24 小时，日历月不是固定天数。例如 DateTimeUtc 的 UTC 2024 年 2 月为 start=2024-02-01T00:00:00Z、end=2024-03-01T00:00:00Z。本区间契约与 dimension.half_open 无关，后者表示部分枚举的业务值域。类型关联到此操作不代表字段获得授权。

## 受限 IPv4 子网操作

InSubnet 和 NotInSubnet 只适用于 ops 声明该操作的 Ipv4 维度。value 为规范 IPv4 CIDR 字符串，不提供 kind，例如 10.4.16.0/20。支持整数掩码 /0..32；主机位必须为零，不会静默归一化。输入和存储地址均使用无前导零的规范点分十进制。整字节前缀保留末尾点，10.4.0.0/16 不匹配 10.40.0.1。编译先用绑定的二进制文本半开区间预筛选，再对部分字节使用绑定的生成正则。/32 使用地址相等；/0 匹配所有非 NULL 地址。NotInSubnet 对非 NULL 地址取完整成员谓词的补集，不包含缺失值。CIDR 是网络操作参数，不是 Eq 或 any_of 的地址值；类型化调用方使用 Ipv4Subnet，不隐含 Text、IPv6 或原生 inet 转换。PostgreSQL 使用 COLLATE C 和原生正则；SQLite 使用 COLLATE BINARY，执行器须注册 regexp(pattern,value)，NULL 输入返回 NULL，其余返回布尔成员关系。生成模式仅使用锚点、十进制分支、括号、[.] 和 [0-9]{1,3}。可用范围索引必须具有匹配的排序规则，支持语义不保证使用索引。准备阶段检查比较、二进制排序、合取、正则与否定能力。

## 逻辑类型与字段能力

物理存储类型与逻辑值域分别声明。即使存储为 String 或 Int，时间字段也区分 DateTimeUtc、Date、DateTime 与 EpochMillis。Date 表示不含时区的日历日期；DateTime 表示不含时区的日期时间，不依赖运行环境的本地时区；与绝对时刻互转需要显式时区或偏移量。显式 logical_type(Ipv4) 使用四段 0..255、无前导零的规范点分十进制 String 存储，其逻辑类型不是 Text。支持地址 Eq/Ne 与 IPv4 CIDR 的 InSubnet/NotInSubnet，详见子网契约；不支持字典序、Contains、IPv6 或隐式 Text 转换。非规范存储地址违反存储契约，准备阶段不扫描数据。字段发布的 ops 可缩小类型能力，不能赋予类型未定义的操作。索引可用性与成本属于字段和物理能力考量，不改变地址语义。字段名不用于推断类型，格式未知的原始来源列在表示方式明确前保留为 Text。逻辑类型本身不授予筛选或投影权限。

## 字段角色与对象引用

Dataset 的 detail.references 包含具名 {id,fields} 集合。每个完整的非 NULL 元组是该数据集内可信的唯一地址；集合内字段共同组成地址，不同集合是替代地址。Field 的 detail.nullable 从 Option(T) 派生，任一成员缺失时整个引用不可用，NULL 不是地址值。可空引用不能确立全量键或粒度；复合引用的单个成员不是完整引用。Dataset 的 detail.field_roles 包含 {field,roles}，Field 的 detail 包含 roles 与 reference_ids。Appellation 参与身份显示，不要求唯一；Reference 参与显式声明的唯一地址；Classification 描述分类；Metric 描述定量用途。角色可重叠，正式度量声明也派生 Metric。角色不授予查询能力、不改变粒度或键，也不隐含默认显示、URL、单位或聚合。只发布完整可见的引用，查询与报告使用者须遵守独立声明的能力。

## 查询意图语法

每个顶层 Intent 的 op 为 Graph、GraphPair 或 GraphUnion。在 DARI pipeline 中用 plan <- query(Intent); 校验并查看 plan.columns，不执行 SQL；再用 result <- exec_query(plan); 取得行。oks_run_answer 执行整稿；refresh:true 或 renew_context({src}) 为 exec_query/context 新建采集批次，保留有效的已编译计划。每个顶层 Intent 必须提供 1..500 的整数 limit。多个 Intent 是独立计划。limit 限制所有业务操作完成后的最终输出行数，编译为 SQL 与绑定参数，独立于业务 take/Top-N；嵌套操作数无需 limit。模型定义 limit 语义和有效范围，外部插件可声明更严格的调用要求，或在转发前注入、覆盖 limit；通过插件调用时遵守插件契约。模型服务按给定 limit 返回，不另算总量或 hasMore；工具执行侧返回 truncated。筛选值按维度或度量的声明解释，不提供输入 kind。

## Graph 意图

必填 op=Graph、root 节点 ID、nodes、edges、select。可选字段为顶层 limit、row_grain=Root|Association、distinct、constraints、measures、measure_having、filters、time_windows、any_of、exists、count、count_value、count_having、count_groups、include_empty、group_by_identity、top_per、top_by_measure、order_by、take。图必须投影维度或度量，或显式指定计数对象。实体、维度、度量与关系 ID 来自领域知识。

## 图节点

节点为 {id,entity}；id 为本次请求内的节点名，entity 为已声明的数据集 ID；root 指定一个节点 id。

## 图边

边或约束为 {relation,from,to}。relation 为已声明的关系 ID，from 与 to 指向节点。只能遍历已声明且方向合法的关系。

## 图投影

select 项为 {node,dimension}，measures 项为 {node,measure}。count 为节点 ID，count_value 为 {node,dimension}，group_by_identity 为节点 ID 数组。使用已声明的 ID，不使用字段名或 SQL 列名。

## 图筛选

filters 项为 {node,dimension,op,value}，any_of 项为 {node,dimension,values}。操作为 Eq、Ne、Gt、Ge、Lt、Le、Contains、NotContains、StartsWith、EndsWith、InSubnet、NotInSubnet。子网操作接收受限规范 IPv4 CIDR，详见子网契约。维度声明允许的操作、逻辑输入类型和值域。不提供 kind；使用与维度兼容的 JSON 字符串、数字或布尔值。half_open 维度中，已知概念使用列出的业务 ID；{"unknown":"原始值"} 匹配一个未识别的底层值，{"unknowns":true} 匹配所有未识别的非 NULL 底层值。Ne 在非 NULL 总体中取补集。带标记的结果列见 dimension.value_contract。知识中的类型化度量谓词输入与规范底层值描述模型事实，不代表 Intent 的值形状。相对时间须先解析为具体值。

## 图聚合

measure_having 和存在性 having 项为 {node,measure,op,value}，value 遵循度量输出类型。度量 ID 使用模型声明的聚合方式，不做隐式覆盖；其含义不符合问题时，应发现其他度量或说明能力缺失。外层 measure_having 要求其度量出现在 measures 中，且满足以下之一：一是 group_by_identity=[root]，只选择根节点维度；二是上下文样本结构 context -> owner 与 sample -> owner，两条边的 owner 端均为 One 或 Optional，上下文/owner/sample 身份完整，group_by_identity=[root,owner]，仅选择 context/owner 维度。第二种允许一条可选 owner -> ancestor 边，ancestor 端至多为一，并可选择 ancestor 维度；节点恰好三个，带 ancestor 时四个，不能添加额外边、行计数、业务链接边或 include_empty。这使每个上下文身份下各 owner 的样本总体独立，避免同名合并或观测倍增。存在性 having 在自己的总体中校验，不受外层 measure_having 结构约束。count_having 为 {op,value}，value 为整数；count_groups 与 include_empty 为布尔值。若身份分组会改变用户要求的业务分组，不能仅为绕过拒绝而添加。

## 声明的筛选能力

语法列出的操作并不适用于每个维度，应读取维度的 filterable、ops、input_kinds 与 values。仅支持 Eq 是模型能力边界。Contains 被拒绝时不能静默改成 StartsWith 或 Eq，因为总体不同。应寻找已发现的等价计划、必要时澄清业务含义，或说明能力不可用。文本模式操作当前忽略大小写，不代表标识符具有区分大小写的精确匹配语义。模型 scope 与筛选度量谓词遵守同样的能力声明。

## 排序与聚合含义

原始 order_by 加 take 返回一个全局有序总体中的前若干行，不是逐组 Min/Max。原始 take 追加完整粒度身份列作为并列裁决，保证确定性，不代表同值行之间的业务偏好。SQLite 的 ASC 将 NULL 排在最前、DESC 排在最后；PostgreSQL 等价执行须显式保留该契约，不能使用相反默认值。因此 ASC take=1 可能取得缺失值，而 Min 忽略 NULL。聚合 top_by_measure 按度量声明的聚合排名：最高平均值不等于最高样本峰值。若问题需要样本统计，应发现对应声明；能力缺失时需说明，不能以原始 Top-N 偷换。

## 图存在性

用 EXISTS 限定外层行，保持外层粒度。完整示例：{"op":"Graph","limit":100,"root":"outer","nodes":[{"id":"outer","entity":"<外层实体>"}],"edges":[],"select":[{"node":"outer","dimension":"<外层维度>"}],"exists":[{"anchor":"outer","nodes":[{"id":"related","entity":"<关联实体>"}],"edges":[{"relation":"<声明的关系>","from":"related","to":"outer"}],"filters":[{"node":"related","dimension":"<关联维度>","op":"Eq","value":"<值>"}]}]}。用领域知识替换占位符，关系方向须与声明一致，也可能从 outer 指向 related。anchor 指外层节点，内层节点只属于 EXISTS。其他可选字段为 constraints、time_windows、any_of、having、negated（布尔值）。若只要求存在，移除示例 filters。粒度有效时可用外层 count 或度量替代 select。

## 图排序与时间

原始全局 Top-N 示例：{"op":"Graph","limit":100,"root":"row","nodes":[{"id":"row","entity":"<实体>"}],"edges":[],"select":[{"node":"row","dimension":"<维度>"}],"order_by":[{"node":"row","dimension":"<排序维度>","direction":"Desc"}],"take":3}。原始 take 要求有序原始行，且从根出发的关联保持粒度安全；倍增路径用 EXISTS 限定（见 graph/existence）。聚合 Top-N 示例：{"op":"Graph","limit":100,"root":"row","nodes":[{"id":"row","entity":"<实体>"}],"edges":[],"select":[{"node":"row","dimension":"<分组维度>"}],"measures":[{"node":"row","measure":"<度量>"}],"top_by_measure":{"node":"row","measure":"<度量>","direction":"Desc","take":3}}。只有隐藏身份键不拆分可见组且度量来源粒度安全时，才按可见维度组排名。逐 owner 样本 Top-N 示例：{"op":"Graph","limit":100,"root":"owner","nodes":[{"id":"owner","entity":"<所属实体>"},{"id":"sample","entity":"<样本实体>"}],"edges":[{"relation":"<样本到所属实体的关系>","from":"sample","to":"owner"}],"select":[{"node":"owner","dimension":"<所属实体维度>"},{"node":"sample","dimension":"<样本维度>"}],"top_per":{"owner":"owner","sample":"sample","rank":"<样本排序维度>","take":3}}。要求恰好一条声明的 sample -> owner 边，owner 端为 One 或 Optional，样本有粒度，rank 为有序样本维度。占位符均用领域知识替换。order_by 项为 {node,dimension,direction}，direction 为 Asc|Desc；take 为有上限的正整数。time_windows 项为 {node,dimension,start,end}，end 必填、非 null 且具体；start 可为 null 或省略，表示 end 之前全部历史。时间值使用维度声明的逻辑格式。

## 最新样本度量

Latest 是模型声明的数值度量，通过 measures:[{node,measure}] 选择。在每个实际分组总体中，合格行先按数据集权威 UTC 时刻降序、NULLS LAST，再按剩余完整样本粒度升序、NULLS FIRST 排序。返回所选行的原始值与单位，保留该行的 NULL，不以更旧的非 NULL 值替代。同一样本节点的度量共用所选行。时间为 NULL 的行不能提供 Latest，但仍进入普通 Avg/Count 总体。数据集 scope、关联、筛选、显式半开窗口和 EXISTS 在选行前限定样本，measure_having 在选行后比较。没有隐式 now 截止，缺少窗口上界时未来样本也可能匹配；工具查询须按时间窗口契约显式提供 end。逐 owner 问题使用完整 owner 身份分组。Latest 可与同来源普通度量并用，参与 top_by_measure，也可作为 GraphPair 各窗口的度量；周期比较对齐 owner 身份。每个分组操作数仅支持一个 Latest 样本来源/顺序，字段必须为数值；不支持 DISTINCT、聚合局部 FILTER、外部依赖、原始 top_per、派生 union 来源或嵌套 EXISTS 聚合谓词。缺失 owner 遵循内关联总体语义，Latest 不扩展 include_empty。选择时钟与并列字段见度量 TimeRole 和数据集粒度引用。获取完整行仍使用原始 top_per。

## 图对齐比较

形状为 {op:GraphPair,limit?:<正整数>,left:<Graph>,right:<Graph>,align_by:[{left:{node:<左节点>},right:{node:<右节点>}}],select:[{side:Left|Right,node:<该侧节点>,dimension:<维度>}],count_groups?:boolean,rank_by?:<排名>}。align_by 必须非空，配对同一实体的节点并展开模型声明的完整身份（含复合粒度）；节点名可不同，节点不能重复。每侧恰好一个度量，select 为空或省略，group_by_identity 与该侧对齐节点顺序完全一致且从 root 开始。外层 select 必填但可为空，每列指定一侧，只能引用对齐节点中由身份决定的属性；它派生两侧投影，展示维度不作为对齐键。输出先按 select 顺序，再输出两侧度量；别名为 left_<节点>_<维度或度量> / right_<节点>_<维度或度量>，半开值域维度紧邻附加 __kind。两侧展示值可不同，不改变匹配。身份包含时间时对齐的是单个样本点，不是周期；同一对齐身份时间字段的互斥窗口会被拒绝，因为无法匹配。周期比较应对齐 owner 实体，相同或重叠窗口仍合法。各侧独立聚合后按身份内关联，filters、time_windows、exists、measure_having 在各侧总体内应用。操作数不支持 count、distinct、include_empty、order_by、take、top_by_measure、top_per。排名示例：{op:Subtract,minuend:Right,subtrahend:Left,direction:Desc,take:5}；{op:Ratio,numerator:Right,denominator:Left,direction:Desc,take:5}；{op:GrowthRate,current:Right,baseline:Left,direction:Desc,take:5}。侧参数为 Left|Right，必须引用不同侧。公式分别为 minuend-subtrahend、numerator/denominator、(current-baseline)/baseline；增长率为小数，0.2 表示 20%。direction 为 Asc|Desc，take 为 1..1000 的整数。两侧度量须为数值，不同度量 ID 要求声明了相同的非 null 单位。排除 NULL 度量、Ratio 的零分母、GrowthRate 的非正基线；当前值可为负。两侧转为近似双精度，在身份关联后排名，并列按完整对齐身份升序、NULLS FIRST。排名结果在两侧度量后添加数值 comparison_value 并按其排序；Subtract 保留单位，百分数相减为百分点；Ratio 为无量纲倍数；GrowthRate 为无量纲比例。无排名时没有比较列。执行配置需授权 Order、Limit、Scalar、Filter、IsNotNull，Subtract 另需 Sub，Ratio 另需 Div/Ne，GrowthRate 另需 Sub/Div/Gt。排名不能与 count_groups:true 并用；无排名的 count_groups 统计所有对齐身份。

## 图并集

形状为 {op:GraphUnion,limit?:<正整数>,branches:[{result_node,graph},...]}。至少两个 Graph 分支返回相同实体，按相同顺序选择相同维度。各分支以无序原始行投影完整结果身份，并集去重。
