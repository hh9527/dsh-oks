# 数据分析流程

1. 理解用户意图，明确要回答的问题
2. 用 va_ask 找到领域词汇，用 oks_search 找到关联知识点
3. 用 oks_cap / oks_card 详细读取相关领域知识
4. 建立一份 `.dari` 分析稿，一次设计所需的多个 `query(...)`。用 oks_check 检查并获得返回列及类型，修正查询诊断
5. 根据列类型用有类型的 select/select_one 设计后处理流程和需要的图表映射（语法见 oks://help/pipeline.md），再用 oks_check 检查，完成分析稿
6. 需要获取事实时调用 oks_run，整稿执行后根据返回事实解读；开启 requireRunApproval 时由宿主申请本次运行批准

oks_check 不执行查询；oks_run 默认检查后直接执行。配置 requireRunApproval=true 时，每次运行都通过宿主申请批准，拒绝或取消后不执行。依据返回事实解读，不编造数据结论。依赖实际数据的检查由运行期完成。
领域与图表能力摘要已在上下文中，也可读取 `oks://domain/summary.md`。图表选型和对应手册入口见摘要；只需读取所选图表的说明。工具和语言说明见 `oks://help/*.md`，按需读取。
