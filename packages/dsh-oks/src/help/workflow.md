# 工作方法

## 分析顺序

1. 理解用户意图，明确对象、指标、时间范围、比较方式和交付形式
2. 将问题拆成实体、属性和可选的具名值，先用 va_ask 获得领域词汇，再调用 oks_discover 查找概念及承载 Dataset
3. 根据发现结果形成取数计划；缺少源码符号、业务口径或具体约束时读取 oks_info，缺少关联路径时使用 oks_routes。无命中时向 va_ask 补充对齐，再发现；已有信息充分时进入编写
4. 建立一份分析稿，按当前环境的语言手册编写查询，通过 dari_check 获取类型和诊断并修正
5. 根据类型完成后处理、图表和交付节点，检查完整分析稿；图表配置分册在选定组件后按需读取
6. 使用 dari_resolve 交付结果，读取同次交付的数据；执行次数、回答投递和补充说明遵循工作纪律

## 知识定位

去重领域词表由独立 VA 持有；主上下文不展开领域全文。va_ask 返回候选词，不提供知识地址，候选不代表词义等价。oks_discover 每条 query 的 entity/props/values 只能逐字使用 va_ask 返回的词表原词（ASCII 英文），保持拼写和大小写。无合适原词时再次向 va_ask 对齐，不自行翻译、改写、缩写或拼接。routes 和 info 使用知识工具返回的真实 ID，不受检索词规则约束。

oks_discover 按实体与属性定位；props 包含维度、度量和计数，values 可省略。具名值通过所属 Type 反查相关属性，与属性词命中合并。返回的知识地址和查询映射是后续依据；不从词汇拼造 ID，不自动认定计数就是去重实体数。

仅当 va_ask 已逐字返回下列英文词时，才可这样检索：

```js
oks_discover({queries:[{entity:"device",props:["cpu"]}]})
oks_discover({queries:[{entity:"alarm",props:["count"],values:["critical"]}]})
```

`oks_routes({from:"datasets/a",to:"datasets/b",via:["datasets/c"]})` 返回满足约束的最短路径集合。via 可省略，指定时按顺序经过这些 Dataset/Entity 根节点。回执包含方向、基数、完整连接键、角色 ID 和 guard；Entity 经承载其身份的 Dataset 进入路径。返回最多 20 条最短路径，超过时标记截断；没有路径时明确报告。via 表达业务必经节点。路径存在与聚合安全分别判断，后者依据具体度量约束。

`oks_info({ids:["datasets/device_kpi/measures/cpu_usage"]})` 批量读取 1..64 个精确知识点，未知 ID 逐点报告。每点给出业务定义和查询短名称；启用类型化源码契约时，还附带模型发布的精确符号、逻辑类型和关系信息。Field.roles 的 Appellation/Reference/Classification/Metric 分别是称谓、指代、分类、指标；筛选和聚合能力由 Dimension/Measure 声明决定。

## 交付形式

- 问数：在 Answer 中组织结果，需要图表时内联图表组件
- 报表：在 Report 中组织报表，在 Answer 中用 UseReport 交付可打开的链接
- 探索：按用户目标组织增量分析，最终需要报表时整合为 Report

统计时区口径有实质歧义或 context 无有效时区时澄清；时间接口及日历窗口见语言手册。行为约束以工作纪律为准，本手册描述操作流程。
