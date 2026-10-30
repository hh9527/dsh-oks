# 工具帮助的维护方式

手写的工具用法集中在本目录；`src/skill.md` 保留任务、工作方法与帮助入口。

- `workflow.md`：工作方法和纪律，与直接注入的预制 prompt 共用文本
- `knowledge.md`：全局摘要、预制知识卡片与知识助手。
- `draft.md`：DARI、有类型 Pipeline、设计检查与按配置申请批准的运行。
- `pipeline.md`：关系 DSL、类型推导、Option、聚合与有限展开
- `query.md`：查询意图语法与约束。
- `time.md`：时间上下文和日历窗口。
- `figures.md`：图表通用语法与按需读取入口。单图表、Report 和通用规格手册从结构化能力生成。

帮助文档是普通 Markdown 文本，标题与代码块仅用于阅读，不承担知识字段或结构化值的编码。通过 oks://help/*.md 直接读取，oks_list 可列出文件。

模型知识保留结构化事实；图表与报告的结构化能力、约束和示例维护在 `src/presentation-facts.ts`，由单图表手册、report.md 和 figure-options.md 按主题提供规格。文本帮助按主题解释用法，不参与结构化知识生成。

构建时将 Markdown 内联到单文件插件，运行时不依赖源码目录。源码测试通过 `scripts/markdown-loader.mjs` 加载 Markdown。
组件映射、能力矩阵、报告正文白名单、方法签名以及反向引用由实现生成，避免与帮助内容分开维护。

全局领域摘要由 `src/domain-summary.ts` 从模型事实生成，与完整词汇表一起进入 KA 的固定系统上下文。主 agent 通过 ka_ask 获取领域导航，再自主检索和读取 cap/card。图表形式和单图表手册入口单独进入主 agent 的系统上下文。
