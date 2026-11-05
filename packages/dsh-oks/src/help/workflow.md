# 工作方法

## 分析顺序

1. 理解用户意图，明确对象、指标、时间范围、比较方式和交付形式。
2. 发现知识入口：直接用 oks_search 检索已知领域词；词汇、规范值或关系入口不清楚时，向 ka_ask 提交原始问题和明确约束。KA 提供阅读清单，VA 提供词汇参考，主 agent 自行读取所需定义。
3. 需要关联时用 oks_routes 找路径，用 oks_info 批量读取涉及的维度、指标、身份、时间和连接约束，形成取数计划。
4. 建立一份 `.dari` 分析稿，一次设计所需查询，先用 dari_check 检查；按需 inspect 读取返回列及类型，依据诊断修正。
5. 根据列类型建立 select/select_one 后处理、图表和交付节点，再检查全稿。形状指纹未变时沿用已读类型；选定图表后才读对应 figure 分册。
6. 通常分两次解析：第一次显式选择 data/reports 获取形成观点所需的事实；完善同稿 Answer 后，第二次获取最终正文。简单问题可一次完成。最后审视事实，完成用户要求的解读与交付。

## 知识定位

领域摘要由 KA 持有，完整词汇表由独立 VA 持有；主上下文不展开领域全文。ka_ask 返回「阅读清单」与「词汇参考」两段自然语言。词汇参考格式为 `- <name> in <ctx>: <问题中的说法>`，name/ctx 用反引号标记：q 数组收集 name，ctx 定位共享 scope，冒号后的文字只作词汇对照。需要不同范围的词分开调用。

```js
oks_search({q:["设备","租户"],scope:["datasets","entities"]})
oks_search({q:["cpu_usage","memory_usage"],scope:["datasets/device_kpi"]})
```

q/scope 是非空数组，最多各 12 项；每词独立匹配、最多返回 10 项，没有额外总结果上限。多个 scope 取并集，按知识 ID 去重后排序；词之间不是 AND。匹配名称、别名、说明和规范值，支持部分词及英文轻微拼写错误，不推断同义词。

| scope | 检索范围 |
| --- | --- |
| datasets / entities / types | 对应类别的独立节点 |
| datasets/ID / entities/ID / types/ID | 该根的内部条目，不含自身 |
| datasets/ID/fields、/dimensions、/measures | 字段、维度、指标；Entity 同样支持 |
| datasets/ID/roles、/time_roles、/business_links、/relations | 模型实际声明的对应内容分类；Entity 同样支持 |
| types/ID/values | 枚举成员 |
| types/ID/references | 模型开放反向引用的直接引用点 |

references 返回实际引用点，如 datasets/current_alarm/dimensions/alarm_severity；未开放反向引用时为空，不递归扩展。合法空范围无命中，未知范围报错。回执按词和父路径分段，将父路径与相对名用 `/` 连接即可得到精确 ID，保持原有编码。

`oks_routes({from:"datasets/a",to:"datasets/b"})` 返回一对 Dataset/Entity 根节点的最短候选路径，含一跳关系、方向、基数、完整连接键、角色 ID 和 guard。Entity 经承载其身份的 Dataset 进入路径；同一承载 Dataset 无需跨表连接。max_depth 默认 2、可设 1..3，最多 8 条路径和 10,000 次边探索；无路径和截断均明确报告。路径存在与聚合安全分别判断。

`oks_info({ids:["datasets/device_kpi/measures/cpu_usage"]})` 批量读取 1..64 个精确点，每点仅返回自身定义，未知 ID 逐点报告。回执显式给出查询短名称。Field.roles 的 Appellation/Reference/Classification/Metric 分别是称谓、指代、分类、指标；筛选和聚合能力由 Dimension/Measure 声明决定。

## 交付节奏

通常先设计并检查，后执行并解读；不是靠观察业务结果反复试探查询能力。查询检查只获得列类型和诊断，实际值留在解析阶段。初次检查后已有充分列信息时，可直接完成后处理与展示。

仅当统计时区口径有实质歧义或 context 无有效时区时澄清；当前时间和客户端时区本来就能从 context() 获得。报告中注明实际采用的口径。

用户要求报告时，Answer 保持简短，用 UseReport 交付可点击链接；普通问题可在 Answer 直接放正文、数值、表格或图表。最终使用解析结果中的 Markdown，略去状态头、分隔注释和调试数据。
