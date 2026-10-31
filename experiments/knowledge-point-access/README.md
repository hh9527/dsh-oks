# 知识点访问实验（Issue #52）

链路：KA 输出分类锚点与节点范围内的词汇，cap 输出词汇命中、分类点读 ID 和明确的关系路径，info 批量读取独立节点。业务查询短名称独立返回，不要求 Agent 拆解知识 ID。

## 真实模型验证

| 模型 | 旧卡片首页合计 bytes | cap + 所需 info bytes | 减少 | 点读数 |
| --- | ---: | ---: | ---: | ---: |
| IC | 162496 | 23246 | 86% | 11 |
| NS | 173510 | 20282 | 88% | 10 |

两套模型各构造两个聚合查询，真实 transform 均接受，返回称谓 String、计数 Int 或可空 Float 列。所有分类索引中的 ID 都逐一验证可读。公式、谓词、身份 parts、依赖引用等保留，空 doc 和邻居展开省略。

运行方式（仓库根目录）：

```sh
node --import ./packages/dsh-oks/scripts/markdown-loader.mjs experiments/knowledge-point-access/check-model.mjs ic /path/ic.wasm /path/telora-run
```

NS 使用 ns 参数。结果文件记录实际锚点、字节、列类型和路径。

## 边界

- 以上是确定性锚点验证，未调用 LLM，不证明 KA 自动选择锚点的质量或完整会话加速。
- 基线是三张旧 card 的第一页，不是知识全集；数字是 JSON UTF-8 bytes，不是 token。
- cap 仅查有界最短无环路径，明确报告截断；未找到不代表全图不可达。
- NS alarm-record 到 dev-info 在默认深度内无路径，负例验证不猜测关系。正例改用 physical-server 及其 KPI。NS 告警没有声明 time role，告警查询不强加时间窗口；KPI 查询仍检查时间窗口。
- Entity 只给候选 carriers，不自动将全部候选纳入路径搜索。
- 点读只取当前问题所需节点，不要求读取完整索引。基线通过内部 semanticKnowledge 的 card 实现计算，不向主 Agent 注册旧 card 或旧 cap 模式。
- 未合入实验，未部署。

## 单入口与自然语言助手

主 Agent 的知识工具为 ka_ask、oks_cap（anchors/max_depth）、oks_info 和模糊检索 oks_search。KA 与 VA 都是子助手，使用自然语言交流；工具原样返回回答，不解析 JSON 或改写阅读清单。VA 固定前缀使用紧凑文本词典，KA 固定前缀使用关系摘要。

主 Agent 根据 KA 的阅读清单选择知识节点和词汇，组织 cap 参数；cap 校验节点 ID 并报告词汇命中，info 逐点报告未知 ID。结构化工具参数与自然语言助手回答各自承担职责。技能、关系摘要和手册使用同一入口。

Field 精确点读保留 roles 业务用途标记。cap 的连接候选仅证明关联存在，具体聚合适用性仍由 Relation、Measure 定义和查询检查决定。候选索引规模与 check 诊断瘦身未在本阶段全面解决，完整 LLM 会话耗时需要另行验证。

## 插件侧类型地址

插件导入模型知识时，为类型根分配当前模型内唯一的短 ID：canonical name 的最后一段作为默认 ID，重名依次使用 `Name-1`、`Name-2`。完整来源地址排序后分配，相同输入的顺序变化不影响结果。已有默认名会被预留，避免后缀覆盖其他类型。

模型的原始类型身份不变。插件统一改写类型节点、成员地址、结构化类型表达式、导航引用、词汇归属以及外部说明索引；search/cap/info 使用分配后的地址，例如 `types/AlarmCleared`。同名类型的领域名称仍可相同，唯一性由 ID 的后缀承担。枚举值、业务字面值和文本说明保持原样。

## 工具内 VA → KA 编排

ka_ask 先将原始问题交给 VA，再把原始问题及 VA 原始回答交给 KA。两个助手作为主会话的独立子会话，各自复用固定前缀并重置问答，均没有工具。工具分别返回“阅读清单”和“词汇对照”，保留两份自然语言原文。同一调用方的并发同问合并整个流程，VA 失败或取消时不启动 KA。
