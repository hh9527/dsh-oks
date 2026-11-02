# 数据分析流程

不要为了探索能力单独开分析稿，而是一个问题一个分析稿，直接在分析稿内进行尝试。

1. 理解用户意图，明确要回答的问题
2. 将用户原始问题（含明确约束）交给 ka_ask，获得领域词汇和相关知识点建议，根据自然语言阅读清单选择节点 ID 与词汇，组织 oks_cap 的 anchors 参数 获得联合索引与连接候选
3. 从 cap 的索引和词汇命中中选择相关 ID，用 oks_info 批量读取精确知识点；检查时间、聚合、身份与连接的适用条件
4. 建立一份 `.dari` 分析稿，一次设计所需的多个 `query(...)`。用 dari_check 检查并获得返回列及类型，修正查询诊断
5. 根据列类型用有类型的 select/select_one 设计后处理流程和需要的图表映射（语法见 oks://help/pipeline.md），再用 dari_check 检查，完成分析稿
6. 需要获取事实时调用 dari_resolve，显式选择所需 data/figures/reports，解析后根据返回事实解读；开启 requireRunApproval 时由宿主申请本次运行批准

知识节点 ID 只用于知识寻址，不直接填入 query。query 的 entity、dimension、measure、relation 使用 oks_info 返回的模型短名称；例如知识地址 datasets/device_kpi/dimensions/device_kpi_ts_raw 对应 dimension:"device_kpi_ts_raw"。不要自行拆解知识地址推导名称。nodes[].id 是本次查询自行定义的节点别名，供 root、node、from、to 引用。

将 figures/reports 返回的 embedded Markdown 原样加入回答；需要解读的事实通过 data 显式选择。用户要求输出报告时，回答要简短，并使用宿主的 present 工具将 dari_resolve 返回的报告文件交付为可打开的文件卡片；不要在回答中重复整份报告。

dari_check 不执行查询；dari_resolve 默认检查后直接执行。配置 requireRunApproval=true 时，每次运行都通过宿主申请批准，拒绝或取消后不执行。依据返回事实解读，不编造数据结论。依赖实际数据的检查由运行期完成。
除非用户明确要求评价、推断或建议，观点采用“述而不作”的态度，客观陈述查询事实、统计口径与数据限制。这一原则同时适用于分析稿、报告正文和最终回复；不主动归因、作价值判断或提出行动建议。用户要求进一步分析时，区分事实与推断，说明依据及不确定性。

领域摘要由 KA 持有，完整词汇表由独立的 VA 持有；当前上下文提供图表与报告能力及手册入口。只需读取所选图表的说明。工具和语言说明见 `oks://help/*.md`，按需读取。

分析稿使用宿主内置文件工具管理，src 使用工作区内的本地路径。普通解析复用同一采集上下文；需要最新时间或数据时调用 `dari_renew_context({src})`，下一次 `dari_resolve` 再重新取数。`dari_resolve` 只接收 src、data、figures、reports。
