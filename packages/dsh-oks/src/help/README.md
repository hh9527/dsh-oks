# 工具帮助的维护方式

手写的工具用法集中在本目录；`src/skill.md` 保留任务、工作方法与帮助入口。

- `knowledge.md`：知识图的整体形状、事实、地址、关系与方法库。
- `project.md`：oks_project 的字符串投影、切片和 jq 方法调用。
- `draft.md`：DARI、查询计划、jq、调试、采集和交付。
- `query.md`：查询意图语法与约束。
- `time.md`：时间上下文、窗口和时间原语。
- `figures.md`：图表、报告、引用与示例。

帮助文档是普通 Markdown 文本，标题与代码块仅用于阅读，不承担知识字段或结构化值的编码。通过 oks://help/*.md 直接读取，oks_list 可列出文件。

模型知识保留结构化事实；图表与报告的结构化能力、约束和示例维护在 `src/presentation-facts.ts`，直接挂载到知识图。文本帮助按主题解释用法，不参与结构化知识生成。

构建时将 Markdown 内联到单文件插件，运行时不依赖源码目录。源码测试通过 `scripts/markdown-loader.mjs` 加载 Markdown 与 jq。
内置 jq 源码集中在 `src/builtin/`，打包时作为文本内联，运行时不依赖旁文件。
组件映射、能力矩阵、报告正文白名单、方法签名以及反向引用由实现生成，避免与帮助内容分开维护。
