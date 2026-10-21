# 工具帮助的维护方式

手写的工具用法集中在本目录；`src/skill.md` 保留任务、工作方法与帮助入口。

- `knowledge.md`：知识图的整体形状、事实、地址、关系与方法库。
- `project.md`：oks_project 的字符串投影、切片和 jq 方法调用。
- `draft.md`：DARI、查询计划、jq、调试、采集和交付。
- `query.md`：查询意图语法与约束。
- `time.md`：时间上下文、窗口和时间原语。
- `figures.md`：图表、报告、引用与示例。

每份文档的一级标题说明用途。二级及更深标题对应知识字段；叶子正文保留为 Markdown 字符串。单独的 json 代码块表示结构化值，source 代码块表示完整源码字符串。分支只包含子标题，不能同时放正文。重复字段或跳级标题会报错。

这些文档作为 oks://help/*.md 只读文本文件，由 oks_read 按行读取，oks_list 可列出 oks://help/。上述标题解析仅用于内部知识挂载与示例校验。

构建时将 Markdown 内联到单文件插件，运行时不依赖源码目录。源码测试通过 `scripts/markdown-loader.mjs` 加载 Markdown 与 jq。
内置 jq 源码集中在 `src/builtin/`，打包时作为文本内联，运行时不依赖旁文件。
组件映射、能力矩阵、XHTML 白名单、方法签名以及反向引用由实现生成，避免与帮助内容分开维护。
