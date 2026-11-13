# 手册维护

主 agent 的固定前缀按 `workflow.md` → `dari.md` → `rules.md` 拼接，文本与 oks_read 完全同源，地址注释用于压缩后重读或逐字引用。rules 始终是插件手册前缀的末段；新增说明放在它之前。

- workflow：顺序与知识导航，回答先做什么。
- dari：语法、接口、类型、查询、时间、图表索引、Report/Answer，回答怎么写。
- rules：短句、祈使、可判定的纪律，回答必须/不得做什么。对前两份的关键约束复述是有意强化，不按信息去重规则删减。

workflow 与 dari 避免重复解释。准入前缀的内容应是完成所有任务的基本能力；仅某类任务所需的内容按需读取。Report 因 UseReport 属于 Answer 保留在 dari，若后续膨胀，优先拆出。

图表分册 dari-figures.md 按需读取，图表组件与属性由 chart/components.ts 和 dari-host.ts 实现。不重新添加独立呈现前缀或旧散装手册入口。

Markdown 在构建期内联到单文件插件；手册内容改变就改变实际固定前缀文本，宿主按新文本构建上下文，不维护独立旧手册缓存。runtime skill 仅保留已载入提示，不复制完整方法论。

词表进入独立 VA；VA 不注入主 agent 的 DARI 手册。暂不生成目录/行号索引。

语法或工具接口发生改变时，同步核对实现（vendors/dari/packages/dari-core/src 与 vendors/dari/packages/dari/src、dari-tools.ts、dari-host.ts）、dari.md、dari-figures.md 中的签名与示例、examples，以及 vendors/dari/editors/tree-sitter-dari 的文法与样例。dari.md 是运行时提示词，描述必须与实现一致；示例通过现有的手册示例与组件执行检查验证，不能仅修改解析器而留下旧写法。
