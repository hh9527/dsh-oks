# 知识访问

## 助手与词汇

将用户原始问题及明确约束交给 ka_ask。工具先向独立持有完整词典的 VA 对齐词汇，再把原始问题和 VA 回答交给持有关系地图的 KA。最终返回两部分：KA 的阅读清单和 VA 原始词汇对照，均为自然语言。

## 联合发现

根据 KA 阅读清单选择 Entity/Dataset 知识节点 ID，并从 ka_ask 的词汇对照中逐字选择领域词汇（不直接使用用户原话或自行改写），组织 anchors 参数交给 `oks_cap({anchors:[{id:"datasets/current_alarm",terms:["alarm_severity"]},{id:"datasets/tenant",terms:["tenant_name"]}]})`。

cap 先发现路径，再裁剪返回结果：锚点、完整路径节点和关系始终保留，外延只保留词汇命中的成员及必要类型 ID，中间节点不全量展开成员。未提供词汇或零命中时不回退全量成员。terms 不影响路径搜索的子图。index 按类别列出保留的精确 ID；anchors.matches 给出词汇到 ID 的证据，unresolved_terms 标记未命中的词。索引是候选清单，只读当前问题所需的点。

connections 给出所选 Dataset 之间的有界最短候选路径，含中间 Dataset 和 Relation ID。max_depth 默认 2，可设 0..3；截断有明确标记，未找到不代表全图不可达。Entity 的 carriers 是候选 Dataset，需要选择后再作为锚点发现关系。

连接存在仅说明模型声明了关联。聚合是否会放大度量，还取决于 Relation 的方向、基数、身份映射和 Measure 约束；通过 oks_info 阅读这些点，再用 dari_check 验证具体查询。

## 精确读取

`oks_info({ids:["datasets/current_alarm/dimensions/alarm_severity","datasets/current_alarm/measures/critical_alarm_count"]})` 批量读取 1–64 个点。每个点只返回自身定义，空说明省略；完整指代、身份映射、公式、谓词、类型和值域等语义保留。未知 ID 逐点返回错误，成功点保留。

ID 从 KA、cap 或 search 复制，不自行拼接或解码。ID 用于知识寻址；info 返回的 dataset/dimension/measure 等短名称用于 query，枚举和业务值保持原样。例如 datasets/device_kpi/dimensions/device_kpi_ts_raw 是交给 oks_info 的地址，query 中则使用 dimension:"device_kpi_ts_raw"；短名称从 info 定义读取，不通过拆解地址推导。query 的 nodes[].id 另为请求内自定义别名，由 root、node、from、to 引用。

Field 的 roles 标记称谓（Appellation）、指代（Reference）、分类（Classification）、指标（Metric）。Dataset 的 references 提供完整指代字段组，Role 的 parts 提供完整 Entity 身份映射。字段可以兼任多种用途；查询权限和聚合能力由 Dimension、Measure 定义。

## 补充检索与手册

`oks_search({query:"领域词汇",dataset:"device",take:10})` 模糊检索知识 ID、名称和说明；多词按覆盖度排序，支持部分词与英文轻微拼写错误，不推断同义词。dataset 与 type 是可选筛选，命中 ID 交给 oks_info。

`oks_read({path:"oks://help/"})` 列出文本手册，oks_read 按需阅读。DARI、查询、时间、图表分别见 draft.md、query.md、time.md、figures.md。dari_check 检查设计与列类型，inspect 按需读取形状，dari_resolve 按 data/figures/reports 选择绑定并解析其依赖。
