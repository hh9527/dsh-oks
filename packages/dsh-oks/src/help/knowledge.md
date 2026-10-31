# 知识的三层入口

基本约定见 `oks://help/workflow.md`，与预制 prompt 共用文本。

## 全局领域摘要

KA（知识助手）持有领域关系地图，VA（词汇助手）独立持有完整词汇表。KA 向 VA 对齐词汇后沿关系给出阅读清单。把用户原始问题及明确约束交给 `ka_ask`，工具等待并返回相关知识点、必要词汇与歧义，然后自主使用 search/cap/card 读取局部事实与约束。摘要不含反向连接，说明可能节选。

## 关联知识点检索

`ka_ask` 解释领域词汇并推荐相关知识点；`oks_search({query:"领域词汇",dataset:"device",take:10})` 检索 ID、名称和说明，返回关联知识点的知识节点 ID。支持多词模糊检索：任一词匹配即可返回，覆盖更多词的节点优先，其次比较整句、精确度和 ID/名称/说明的匹配位置；支持部分词和英文标识符的轻微拼写错误，不做同义词语义推断。dataset 和 type 是可选筛选条件；type 不区分大小写，可用 Dimension/dimension/dimensions，未知类别会返回诊断。用 oks_card 读取命中节点，oks_cap 获取其查询能力。

## 局部知识（JSON）

oks_cap / oks_card 返回结构稳定的 JSON，在精确事实与约束中携带必要说明。

### 查询能力

调用 `oks_cap({dataset:"device",join_depth:1,skip:0,take:20})` 获取能力、连接候选和查询骨架。也可使用 `oks_cap({entity:"device_entity"})`；多个候选时显式选择 Dataset。

还可提供 `select:[{dimension:"id"}]`、`measures:[{measure:"count"}]`、`window:{dimension:"ts",start:"...",end:"..."}`、`rank:{measure:"count",direction:"desc",take:10}`。省略字段时探索模型能力。骨架必须通过 transform 校验。

### 事实卡片

card 的 id 是带类别和归属的知识节点 ID，由 search/KA 返回，直接复制使用。cap 和 query 则继续使用短模型名称（例如 dataset:"device"、dimension:"id"），不使用节点路径。卡片的 dataset/dimension/measure 字段提供这些短名称；cap 的 knowledge_id 可直接交给 card。枚举和业务值保持原样。

成员示例：`oks_card({id:"datasets/device/dimensions/id"})`。路径中的名称段独立 URI 编码，不自行拼接或解码。

- `oks_card({id:"datasets/device",section:"dimensions",skip:0,take:20})` 分页读取 Dataset 成员和说明
- section 可选 all、shape、fields、roles、bindings、dimensions、measures、time_roles、relations、business_links
- `oks_card({id:"entities/device_entity"})` 读取精确领域节点；也支持 types、groups、relations 与成员知识节点 ID
- 分页结果中的 pages 包含总数和截断信息

## 词汇与手册

`ka_ask` 负责领域知识导航及业务名词、别名和规范值定位；主 agent 自主调用 search/cap/card 读取详细知识。结果中的知识节点 ID可用 oks_card 核实。

`oks_list({path:"oks://help/"})` 列出独立文本手册，使用 oks_read 阅读。DARI 与查询见 draft.md、query.md，时间见 time.md，图表与报告见 figures.md。agent 使用 oks_check 检查分析稿，oks_run 检查后执行并返回结果；开启 requireRunApproval 时先申请用户批准。

### 字段业务用途

Dataset 卡片的 `field_roles` 提供称谓（Appellation）、指代（Reference）、分类（Classification）、指标（Metric）。`references` 保留 Dataset 内完整指代字段组；`roles` 保留指向 Entity 的完整身份映射，两者都需要按范围解释。`section:"fields"` 分页读取原始字段事实，包含用途标记。字段可以兼任多种用途；具体查询权限和聚合能力由维度与 Measure 定义。
