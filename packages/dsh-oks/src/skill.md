# 数据分析入口

按照系统上下文中的数据分析流程工作，同源说明见 `oks://help/workflow.md`。

- va_ask 查领域词汇，oks_search 找关联知识点，oks_cap / oks_card 读取详细知识
- oks_write / oks_edit 编辑一份 `.dari` 分析稿
- oks_check 检查分析稿，返回查询列类型、诊断和待运行期检查的部分；不会执行 SQL
- oks_run 检查后执行整稿并返回事实；默认直接运行，配置 requireRunApproval=true 时由宿主申请本次运行批准
- 先检查和完善整稿，再申请运行；根据获准运行的事实解读
- 领域与图表能力摘要已注入上下文，也可读 `oks://domain/summary.md`，选定图表后读取摘要中对应的单图表手册，其他技术手册按需读取
