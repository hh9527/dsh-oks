# 数据分析入口

按照系统上下文中的数据分析流程工作，同源说明见 `oks://help/workflow.md`。

不要为了探索能力单独开分析稿，而是一个问题一个分析稿，直接在分析稿内进行尝试。

除非用户明确要求，否则不要根据取数结果重新调整取数计划。取数计划只依据用户意图和领域知识制定，不因已取得的数据结果改变查询范围、筛选条件、聚合口径或查询组合。

每轮问题尽量只调用两次 `dari_resolve`：第一次一次性获取报告及形成观点所需的事实（显式选择 reports、data，使用 answer:false）；根据这些事实完善同一分析稿中的 Answer，第二次使用 answer:true 获取最终回答。简单问题可以一次完成，不必凑足两次。运行前的语法、类型和查询计划修正优先使用 `dari_check`；不要为了反复核对结果或细碎探索增加运行次数。确有运行错误或用户新增要求时再按需追加。

- 使用 oks_search({q:[...],scope:[...]}) 检索，q/scope 均为必填非空数组，所有词共用 scope；datasets/entities/types 找对应类别根节点，具体根 ID 找成员，Dataset/Entity 的 /fields、/dimensions、/measures 和 Type 的 /values 限定内容分类，types/类型名/references 找模型允许的直接引用点；需要连接时用 oks_routes，精确定义用 oks_info。词汇或领域关系不清楚时按需咨询 ka_ask，不要求每题调用
- 知识节点 ID 用于知识寻址；query 的 entity、dimension、measure、relation 使用 oks_info 返回的模型短名称，不使用知识地址。nodes[].id 是查询内自定义别名
- 使用宿主内置文件工具 编辑一份 `.dari` 分析稿
- dari_check 检查分析稿，返回查询列类型、诊断和待运行期检查的部分；不会执行 SQL
- 用唯一的 `answer := Answer [...]` 定义回答，动态值用 value(ref=...)、图表用 UseFigure、报告链接用 UseReport；正常交付调用 `dari_resolve({src,answer:true})`，原样贴出 answer.embedded；配置 requireRunApproval=true 时由宿主申请本次运行批准
- figures/reports 的 embedded 是 Markdown，原样加入回答展示；需要解读的事实通过 data 显式选择
- 用户要求报告时，Answer 保持简短，通过 UseReport 交付可点击的报告链接，不重复整份报告；调试时使用 answer:false 并显式选择 data/figures/reports
- 先检查和完善整稿，再申请运行；根据获准运行的事实解读
- 领域摘要由 KA 持有，完整词汇表由独立的 VA 持有，图表能力说明保留在主上下文，选定图表后读取对应的单图表手册，其他技术手册按需读取

当前时刻和客户端时区从 `context()` 获取，时区字段为 `ctx.tz.client.id`；`time_windows(ctx, ...)` 直接使用该时区。采用的统计时区应在报告中注明，仅在统计口径存在实质歧义或 context 无法提供有效时区时澄清。

分析稿使用宿主内置文件工具管理，src 使用工作区内的本地路径。普通解析复用同一采集上下文；需要最新时间或数据时调用 `dari_renew_context({src})`，下一次 `dari_resolve` 再重新取数。`dari_resolve` 接收 src、必填的 answer 布尔参数及可选的 data、figures、reports。

词汇参考每行是 `- <name> in <ctx>: <问题中的说法>`（name 和 ctx 用反引号标记）；search 的 q 数组收集 name，ctx 用于定位共享 scope；需要不同范围的词分开调用，冒号后的用户说法只作对照。
