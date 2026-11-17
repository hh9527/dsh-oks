# dsh-oks

围绕模型知识发现和有类型数据流水线的插件。分析稿扩展名为 .dari，语言定义和编译器位于独立 dari 仓的 dari-core/dari workspace，插件提供知识导航、图表展现、附件发布与 Answer 投递。

## 分析稿

`data` 声明可缓存数据节点，`let` 命名节点内部计划；`query_remote!` 由模型 check_type 证明，`query!` 组合本地有类型关系计划，`tree!` 编排展现。上界、字段、业务类型、可空性、图表映射在检查期验证；执行绑定已经检查的参数化 SQL。

`dari_check({src})` 检查完整分析稿，返回文本诊断、位置和适用的修复建议；`dari_submit({src})` 检查并执行，发布附件并投递唯一 Answer。`dari_renew_context({src})` 更新会话时间快照。行为纪律见 [rules.md](src/help/rules.md)，语言和图表写法见 [dari.md](src/help/dari.md) 与 [dari-figures.md](src/help/dari-figures.md)。

图表直接内联于 Answer 或 Report；UseReport 引用报告。报告保留源码、上下文和执行元数据，SVG 内嵌最终输入 CSV 与 spec。`report_extract_dari({src,sink})` 提取源码和历史执行上下文，不执行查询。

## 模型与运行配置

部署 profile 的插件 config 提供默认领域、模型和只读数据库，路径使用绝对路径。VA、知识导航与 DARI 类型证明、执行共用同一模型，由 Node 内置 WebAssembly 引擎加载：

```json
{"domain":"ic","model":"/path/to/ic.wasm","dataFile":"/path/to/ic.sqlite"}
```

会话工作区的 `dari.json` 可省略。需要覆盖部署默认值时，只声明要覆盖的字段；相对路径以该工作区为基准，例如：

```json
{"model":"models/ic.wasm","dataFile":"data/ic.sqlite"}
```

配置按当前会话工作区解析；更改后下次工具调用生效。没有模型配置时服务仍可启动，模型工具直接报告缺失项；无效 JSON 或读取权限错误会明确报错。部署配置中的执行审批策略由管理员控制。`dari` 配置仅用于指定可信语言服务 `service` 和集成模块 `integration` 路径。

语言服务随插件发布于 dari-runtime，默认使用该入口；service 可显式指定可信服务路径。语言服务在独立常驻进程中运行，需要 Node.js 24 或以上版本。integration 可指定可信集成模块，默认使用插件发布入口导出的 createIntegration，组合模型桥接、展现宿主及知识契约。模型契约绑定具体构建身份，修改模型后重新检查。

知识来自 Wasm 的 ontology.knowledge 构建信息；VA 提供领域词汇，dari_kg_discover 定位承载属性的 Dataset，dari_kg_routes 发现关系路径，dari_kg_info 返回局部知识及精确源码符号。工具和参数规则见 [workflow.md](src/help/workflow.md)。

## 构建与验收

```sh
# 在仓库根目录初始化固定版本的引擎并安装其构建依赖
pnpm run setup:dari
pnpm install --ignore-scripts
cd packages/dsh-oks
pnpm run build
pnpm run typecheck
pnpm test
```

构建和 pretest 更新 dist/dsh-oks/lib 与 dari-runtime；执行前告知并确认运行环境不会提前加载未验收产物。测试临时文件使用 TMPDIR。默认套件不要求真实工作区，模型集成通过 tests/dari-adapter-test.ts 显式运行，独立 bundle 冒烟通过 tests/smoke.ts 验证。

安装及独立环境配置见[仓库说明](../../README.md)。插件通过宿主附件服务持久保存 SVG 与 HTML。Answer 使用 push-to-user 消息投递，可见卡片由 @local/dsh-data-seer-client 渲染。

## 手册维护

固定前缀按 workflow.md、dari.md、rules.md 顺序组成，与 dari_read 读取同源；纪律始终位于末段。图表分册按需读取。变更语法时同步语言实现、手册、样例及 tree-sitter-dari，维护细则见 [help/README.md](src/help/README.md)。

DARI 位于 `vendors/dari` Git submodule，父仓提交固定其精确版本。插件通过 link 使用 submodule 的 dari-core；构建先编译同一版本的 core 与 dari，再生成自包含运行包。产物记录 DARI 提交，不依赖相邻源码仓库。升级时先更新 submodule 指针，完成集成验收后与适配改动一起提交。

### 模型检查与来源诊断

DARI 集成要求 `dari-model/v3` 契约和 Telora publication v4 / Guest ABI 43。worker 内的 Node WebAssembly 引擎直接实例化零导入制品，支持内嵌服务快照及自包含服务初始化。请求使用 TLI1 结构化输入，通过 `run-service-located` 进入模型，不解析嵌套业务 JSON。每次请求重置服务与可变全局，trap 后从初始化快照恢复；超过宿主期限则终止 worker。

query_remote! 的来源范围经请求一起导入。模型 codec 或领域检查返回的输入 subject 会直接定位到 DARI 表达式，模型规则位置作为相关来源保留。模型对实际收到的 intent 计算规范摘要，宿主继续校验步骤消费凭据和输出类型。

隔离验收命令：

```sh
node tests/located-input-test.ts
node tests/model-located-integration.ts /path/to/ic-dari.wasm
```

模型构建使用 release 版 Telora，制品路径与线上模型分开。

## 远端执行与本地后处理

DARI 的 query_remote! 由可信集成适配器执行已证明的计划；IC 适配器按需只读打开业务 SQLite，并注册模型所需的地区分桶函数。CLI/service 的 options.database 来自 --database。检查阶段只获取模型契约，不打开业务数据库。

本地 query! 使用独立内存 SQLite，只在消费远端结果时按已检查 Schema 导入临时表。直接展示远端结果不导入；同次执行共享远端取数及导入缓存。远端每阶段最多 500 行，单个图表或表格最多 110 行，执行时继续核对；不拼接远端与本地 SQL。
