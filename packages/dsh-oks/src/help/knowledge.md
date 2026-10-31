# 知识访问

## 助手与词汇

将用户原始问题及明确约束交给 ka_ask。工具先向独立持有完整词典的 VA 对齐词汇，再把原始问题和 VA 回答交给持有关系地图的 KA。最终返回两部分：KA 的阅读清单和 VA 原始词汇对照，均为自然语言。

## 联合发现

根据 KA 阅读清单选择知识节点 ID 与相关词汇，组织 anchors 参数交给 `oks_cap({anchors:[{id:"datasets/current_alarm",terms:["alarm_severity"]},{id:"datasets/tenant",terms:["tenant_name"]}]})`。

cap 的 index 按类别列出精确 ID；anchors.matches 给出词汇到 ID 的证据，unresolved_terms 标记未命中的词。索引是候选清单，只读当前问题所需的点。

connections 给出所选 Dataset 之间的有界最短候选路径，含中间 Dataset 和 Relation ID。max_depth 默认 2，可设 0..3；截断有明确标记，未找到不代表全图不可达。Entity 的 carriers 是候选 Dataset，需要选择后再作为锚点发现关系。

连接存在仅说明模型声明了关联。聚合是否会放大度量，还取决于 Relation 的方向、基数、身份映射和 Measure 约束；通过 oks_info 阅读这些点，再用 oks_check 验证具体查询。

## 精确读取

`oks_info({ids:["datasets/current_alarm/dimensions/alarm_severity","datasets/current_alarm/measures/critical_alarm_count"]})` 批量读取 1–64 个点。每个点只返回自身定义，空说明省略；完整指代、身份映射、公式、谓词、类型和值域等语义保留。未知 ID 逐点返回错误，成功点保留。

ID 从 KA、cap 或 search 复制，不自行拼接或解码。ID 用于知识寻址；info 返回的 dataset/dimension/measure 等短名称用于 query，枚举和业务值保持原样。

Field 的 roles 标记称谓（Appellation）、指代（Reference）、分类（Classification）、指标（Metric）。Dataset 的 references 提供完整指代字段组，Role 的 parts 提供完整 Entity 身份映射。字段可以兼任多种用途；查询权限和聚合能力由 Dimension、Measure 定义。

## 补充检索与手册

`oks_search({query:"领域词汇",dataset:"device",take:10})` 模糊检索知识 ID、名称和说明；多词按覆盖度排序，支持部分词与英文轻微拼写错误，不推断同义词。dataset 与 type 是可选筛选，命中 ID 交给 oks_info。

`oks_list({path:"oks://help/"})` 列出文本手册，oks_read 按需阅读。DARI、查询、时间、图表分别见 draft.md、query.md、time.md、figures.md。oks_check 检查设计与列类型，oks_resolve 按 data/figures/reports 选择绑定并解析其依赖。
