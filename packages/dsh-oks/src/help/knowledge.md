# 知识的三层入口

基本约定见 `oks://help/workflow.md`，与预制 prompt 共用文本。

## 全局领域摘要

全局领域摘要已随系统上下文提供，以 Markdown 组织全部 Entity、Dataset、维度与度量概览、关系端点和基数。用 `oks_read({path:"oks://domain/summary.md"})` 重新读取，用 `oks_list({path:"oks://domain/"})` 查看摘要目录。读取接口与自动注入使用同一份内容。摘要不含词汇表与反向连接，说明可能节选，具体约束通过卡片核实。

## 关联知识点检索

`va_ask` 提供领域词汇；`oks_search({query:"领域词汇",dataset:"device",take:10})` 检索 ID、名称和说明，返回关联知识点的语义地址。dataset 和 type 是可选筛选条件。用 oks_card 读取命中节点，oks_cap 获取其查询能力。

## 局部知识（JSON）

oks_cap / oks_card 返回结构稳定的 JSON，在精确事实与约束中携带必要说明。

### 查询能力

调用 `oks_cap({cq:{target:{dataset:"device"}},join_depth:1,skip:0,take:20})` 获取能力、连接候选和查询骨架。也可使用 `target:{entity:"device_entity"}`；多个候选时显式选择 Dataset。

cq 可提供 `select:[{dimension:"id"}]`、`measures:[{measure:"count"}]`、`window:{dimension:"ts",start:"...",end:"..."}`、`rank:{measure:"count",direction:"desc",take:10}`。省略字段时探索模型能力。骨架必须通过 transform 校验。

### 事实卡片

- `oks_card({id:"device",section:"dimensions",skip:0,take:20})` 分页读取 Dataset 成员和说明
- section 可选 all、shape、fields、roles、bindings、dimensions、measures、time_roles、relations、business_links
- `oks_card({key:"entities/device_entity"})` 读取精确领域节点；也支持 types、groups、relations 与成员语义地址
- 分页结果中的 pages 包含总数和截断信息

## 词汇与手册

`va_ask` 负责业务名词、别名和规范值定位。结果中的语义地址可用 oks_card 核实。

`oks_list({path:"oks://help/"})` 列出独立文本手册，使用 oks_read 阅读。DARI 与查询见 draft.md、query.md，时间见 time.md，图表与报告见 figures.md。agent 使用 oks_check 检查分析稿，oks_run 检查后执行并返回结果；开启 requireRunApproval 时先申请用户批准。

### 字段业务用途

Dataset 卡片的 `field_roles` 提供称谓（Appellation）、指代（Reference）、分类（Classification）、指标（Metric）。`references` 保留 Dataset 内完整指代字段组；`roles` 保留指向 Entity 的完整身份映射，两者都需要按范围解释。`section:"fields"` 分页读取原始字段事实，包含用途标记。字段可以兼任多种用途；具体查询权限和聚合能力由维度与 Measure 定义。
