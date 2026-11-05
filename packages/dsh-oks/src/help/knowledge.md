# 知识访问

## 检索

`oks_search({q:["告警"],scope:["datasets","entities"]})` 查找 Entity/Dataset 根节点。已知范围时，使用完整根节点 ID 搜索其成员：

```js
oks_search({q:["memory usage","CPU"],scope:["datasets/device_kpi"]})
```

q 和 scope 都是必填非空数组，所有词共用 scope；需要不同范围的词分开调用。每个词表达一个检索概念，分别匹配，不做 AND 合取；每词最多返回 10 项，整次调用没有额外总结果行数上限。q 最多 12 个词，scope 最多 12 个范围，多个范围取并集。类别范围 datasets/entities/types 分别检索该类别的独立节点；具体 Entity/Dataset/Type 根节点 ID 只检索其成员，不返回锚点自身。合法但为空的范围返回无命中；不存在或不支持的范围直接报错。

可使用以下内容分类范围，仅搜索该分类下的条目：

| 范围 | 搜索内容 |
| --- | --- |
| datasets/ID/fields | 字段 |
| datasets/ID/dimensions | 维度 |
| datasets/ID/measures | 指标 |
| datasets/ID/roles | 身份角色 |
| datasets/ID/time_roles | 时间角色 |
| datasets/ID/business_links | 业务连接 |
| datasets/ID/relations | 节点内的关系声明 |
| types/ID/values | 枚举成员 |
| types/ID/references | 模型允许的直接引用点 |

Entity 支持与 Dataset 相同的内容分类，按模型实际内容返回结果。具体根和内容分类范围均不匹配自身。references 仅使用模型提供的直接反向引用，不递归、不推断；类型未声明 reverse_references=True 时返回无命中。结果是实际引用点（如 datasets/current_alarm/dimensions/alarm_severity），可以直接交给 oks_info。多个范围按知识 ID 去重后，每词排序取前 10 项。关系路径仍使用 oks_routes；不支持通配符或 references/references。

```js
oks_search({q:["alarm_severity"],scope:["types/AlarmSeverity/references"]})
```

匹配基于名称、别名、说明和规范值；覆盖度优先，其次是精确程度，支持部分词及英文轻微拼写错误，不推断同义词。回执按检索词、父路径分段，行内显示相对名称、逻辑类型和最多 20 字的说明。根节点段显示业务说明；成员未声明逻辑类型时明确标记。空结果显示“✗ 无命中”，截断有明确标记。需要时缩小 scope 或细化 q。

将段标题中的父路径与返回的相对名称用 `/` 连接，即得到 `oks_info` 的精确 ID。例如标题 `datasets/device_kpi/measures` 下的 `cpu_usage` 对应 `datasets/device_kpi/measures/cpu_usage`；名称保持原始编码。

## 关系路径

`oks_routes({from:"datasets/device_kpi",to:"datasets/tenant"})` 查找一对根节点间的有界最短候选路径，包含一跳关系。from/to 接受 Dataset/Entity 完整 ID；Entity 通过承载其身份的 Dataset 进入路径，回执明确指出本次路径使用的承载 Dataset。

max_depth 默认 2，可设 1..3；最多返回 8 条最短候选路径，最多探索 10,000 条边。回执完整显示路径节点、Relation ID、声明方向、沿路径行进方向的基数、连接键、角色 ID，以及存在的 guard。复合连接键完整保留为紧凑 JSON。无路径和搜索截断明确标记；深度内未找到不表示全图不可达。同一个承载 Dataset 内可关联时明确说明无需跨表连接。

连接存在仅说明模型声明了关联。聚合是否放大度量还取决于身份、基数和 Measure 约束；按需通过 `oks_info` 阅读精确定义，再用 `dari_check` 验证查询。查询使用 info 返回的短名称，不直接使用路径中的知识 ID。

## 精确读取

`oks_info({ids:["datasets/current_alarm/dimensions/alarm_severity","datasets/current_alarm/measures/alarm_count"]})` 批量读取 1..64 个点。每个点只返回自身定义，导航不递归展开。

回执以精确 ID 为 Markdown 标题，显式列出 query 使用的短名称。空说明和顶层 null 属性省略；相等的 ops/filters、canonical_order/order 展示一份，复杂定义使用紧凑 JSON 代码块。嵌套空值、空集合、false、0，以及公式、谓词、身份映射、类型和值域等语义完整保留。未知 ID 逐点报告，成功点保留。

知识 ID 用于寻址，dataset/dimension/measure/relation 等短名称用于 query。例：地址 `datasets/device_kpi/dimensions/device_kpi_ts_raw` 交给 info，返回的 `dimension="device_kpi_ts_raw"` 用于 query；nodes[].id 是请求内自定义别名。Field 的 roles 表示称谓（Appellation）、指代（Reference）、分类（Classification）、指标（Metric）；查询和聚合能力以 Dimension、Measure 定义为准。

## 按需咨询领域助手

领域词汇、规范值或关系入口不清楚时，把用户原始问题及明确约束交给 `ka_ask`。它先由 VA 对齐词汇，再让 KA 根据领域关系地图给阅读清单。回执为两段原文：阅读清单、词汇参考。

词汇参考每行形如 `- <name> in <ctx>: <问题中的说法>`，name/ctx 用反引号标记。将 name 放入 search 的 q 数组，ctx 定位共享 scope；需要不同范围的词分开调用，冒号后的说法只是对照说明。KA 负责领域导航，不代替主 agent 阅读细节；普通检索可直接开始，无需每题咨询。

## 手册

`oks_read({path:"oks://help/"})` 列出文本手册，按需读取。DARI、查询、时间、图表分别见 draft.md、query.md、time.md、figures.md。
