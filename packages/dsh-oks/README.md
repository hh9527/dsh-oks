# dsh-oks

围绕模型知识发现和有类型数据流水线的插件。分析稿扩展名为 .dari，语言定义和编译器位于 lab-ontology/dari，插件提供知识导航、图表展现、附件发布与 Answer 投递。

## 分析稿

`data` 声明可缓存数据节点，`let` 命名节点内部计划；`query_remote!` 由模型 check_type 证明，`query!` 组合本地有类型关系计划，`tree!` 编排展现。上界、字段、业务类型、可空性、图表映射在检查期验证；执行绑定已经检查的参数化 SQL。

`dari_check({src})` 检查完整分析稿，返回文本诊断、位置和适用的修复建议；`dari_submit({src})` 检查并执行，发布附件并投递唯一 Answer。`dari_renew_context({src})` 更新会话时间快照。行为纪律见 [rules.md](src/help/rules.md)，语言和图表写法见 [dari.md](src/help/dari.md) 与 [dari-figures.md](src/help/dari-figures.md)。

图表直接内联于 Answer 或 Report；UseReport 引用报告。报告保留源码、上下文和执行元数据，SVG 内嵌最终输入 CSV 与 spec。`report_extract_dari({src,sink})` 提取源码和历史执行上下文，不执行查询。

## 模型与运行配置

会话工作区的 oks.json 指定知识模型和只读 SQLite：

```json
{"domain":"ic","model":"models/ic.wasm","dataFile":"data/ic.sqlite"}
```

插件 config 的 dari 项指定语言服务、类型证明模型和 Telora runner，路径为绝对路径：

```json
{"dari":{"service":"/path/to/lab-ontology/dari/service.ts","model":"/path/to/ic-dari.wasm","runner":"/path/to/telora-run"}}
```

语言服务在独立常驻进程中运行，需支持 TypeScript 与 node:sqlite 的 Node.js。hostModule 可显式指定展现宿主，默认使用插件发布入口导出的 dariHost。模型契约绑定具体构建身份，修改模型后重新检查。

知识来自 Wasm 的 ontology.knowledge 构建信息；VA 提供领域词汇，oks_discover 定位承载属性的 Dataset，oks_routes 发现关系路径，oks_info 返回局部知识及精确源码符号。工具和参数规则见 [workflow.md](src/help/workflow.md)。

## 构建与验收

```sh
pnpm install
pnpm run typecheck
pnpm run build
pnpm test
```

构建和 pretest 更新 dist/dsh-oks/lib；执行前告知并确认运行环境不会提前加载未验收产物。测试临时文件使用 TMPDIR。默认套件不要求真实工作区，模型集成通过 tests/dari-adapter-test.ts 显式运行，独立 bundle 冒烟通过 tests/smoke.ts 验证。

安装及独立环境配置见[仓库说明](../../README.md)。插件通过宿主附件服务持久保存 SVG 与 HTML。Answer 使用 push-to-user 消息投递，可见卡片由 @local/dsh-push-to-user 渲染。

## 手册维护

固定前缀按 workflow.md、dari.md、rules.md 顺序组成，与 oks_read 读取同源；纪律始终位于末段。图表分册按需读取。变更语法时同步语言实现、手册、样例及 tree-sitter-dari，维护细则见 [help/README.md](src/help/README.md)。
