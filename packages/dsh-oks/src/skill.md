# 数据分析入口

按照系统上下文中的数据分析流程工作，同源说明见 `oks://help/workflow.md`。

不要为了探索能力单独开分析稿，而是一个问题一个分析稿，直接在分析稿内进行尝试。

- 把用户原始问题交给 ka_ask 获得领域词汇和知识导航，主 agent 自主使用 oks_search 找关联知识点，oks_cap / oks_info 读取详细知识
- 知识节点 ID 用于知识寻址；query 的 entity、dimension、measure、relation 使用 oks_info 返回的模型短名称，不使用知识地址。nodes[].id 是查询内自定义别名
- 使用宿主内置文件工具 编辑一份 `.dari` 分析稿
- dari_check 检查分析稿，返回查询列类型、诊断和待运行期检查的部分；不会执行 SQL
- dari_resolve 检查后按 data/figures/reports 选择绑定并解析其依赖；默认直接运行，配置 requireRunApproval=true 时由宿主申请本次运行批准
- figures/reports 的 embedded 是 Markdown，原样加入回答展示；需要解读的事实通过 data 显式选择
- 用户要求输出报告时，回答简短，并用宿主 present 工具将返回的报告文件交付为可打开的文件卡片，不重复整份报告
- 先检查和完善整稿，再申请运行；根据获准运行的事实解读
- 领域摘要由 KA 持有，完整词汇表由独立的 VA 持有，图表能力说明保留在主上下文，选定图表后读取对应的单图表手册，其他技术手册按需读取

分析稿使用宿主内置文件工具管理，src 使用工作区内的本地路径。普通解析复用同一采集上下文；需要最新时间或数据时调用 `dari_renew_context({src})`，下一次 `dari_resolve` 再重新取数。`dari_resolve` 只接收 src、data、figures、reports。
