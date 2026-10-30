# 数据分析入口

按照系统上下文中的数据分析流程工作，同源说明见 `oks://help/workflow.md`。

- ka_ask 提供领域词汇和知识导航，主 agent 自主使用 oks_search 找关联知识点，oks_cap / oks_card 读取详细知识
- oks_write / oks_edit 编辑一份 `.dari` 分析稿
- oks_check 检查分析稿，返回查询列类型、诊断和待运行期检查的部分；不会执行 SQL
- oks_run 检查后执行整稿并返回事实；默认直接运行，配置 requireRunApproval=true 时由宿主申请本次运行批准
- 先检查和完善整稿，再申请运行；根据获准运行的事实解读
- 领域摘要与完整词汇表由 KA 持有，图表能力说明保留在主上下文，选定图表后读取对应的单图表手册，其他技术手册按需读取
