# RFC 0014：完整知识图与工具侧用法

- 状态：已实施并通过真机预览验收；用户已授权双仓合入 main。
- 跟踪： https://github.com/hh9527/dsh-oks/issues/37
- 模型分支：lab-ontology `feat/knowledge-facts`。
- 工具分支：dsh-oks `feat/knowledge-graph-tools`。

## 目标与边界

模型发布完整的业务事实、类型、身份、关系、粒度、值域、时间与查询能力约束。工具负责知识读取、查询表达、执行和交付方法。模型与插件的内部接口允许完整、大容量结构；进入 Agent 上下文的最终文本保持 16 KiB UTF-8 上限。

知识核心工具为 `va_ask`（词汇规整）与 `oks_data`（整体图上的 project/jq）。词汇搜索、成员枚举、反向引用采用可复用 jq 程序和 examples，统一通过 oks_data 调用。

## 知识资源

知识资源采用 `{meta,origin,data}` 封装；`knowledge://` 自动解包 data，`knowledge://#meta` 显式读取精简元信息与来源，`knowledge://#contract` 读取工程发现契约。加载为 knowledge 后，`.knowledge` 是以下语义图：

```json
{"datasets":{"current_alarm":{"fields":{},"dimensions":{},"measures":{},"time_roles":{},"business_links":{}}},"types":{"Severity":{"values":{},"fields":["datasets/current_alarm#fields/severity"]}},"relations":{},"items":[{"key":"types/Severity","names":["告警级别"],"doc":"..."}]}
```

业务事实按归属嵌入独立节点，名称和描述集中在 items。反向导航由工具层根据地址归属、正向引用和类型使用事实生成；模型不构建或存储反向索引。模型父节点列出成员以支持发现，成员通过地址表达归属。关系端点与度量依赖仍由模型显式发布。meta 仅包含版本、根集合、计数；词汇助手从同一次收集的模型事实派生词表。图内不注入工具 guide。查询及知识用法通过插件自有 help 资源按需读取。

模型 discovery 显式声明知识与 Intent 工程契约版本，插件校验兼容性，旧快照明确拒绝并提示重建。插件不靠过滤模型文案来构造知识边界。

## 用法与 examples

oks_data 支持插件自有 help 资源，返回知识 shape、读取与检索 examples、完整 Intent 使用方法。用法与知识分别寻址。

jq.src 除 .work/ 程序外支持内置知识 jq 程序，args 为程序参数，进入执行记录与来源链。内置程序与自定义程序均由相同 Wasm jq 引擎执行；内置源代码可读取，程序提供 canonical key、稳定排序、分页和精简结果。

移除 oks_search、oks_references 独立工具注册。词汇助手只返回词表中的候选说法，候选在完整图上核实。工具用法与 builtin 名称、参数由一个定义处派生，examples 必须真实执行验收。

## 模型发布

业务知识图移出 Schema/syntax 操作指南与所有对应边。调用协议与 Intent 文法保留为工程契约文档；模型/query 引擎继续进行语义校验。类型语义、半开放值域、时间桶、Latest 等业务事实保留或补成结构化属性；关键语义不能随 Schema 文本丢失。

index 描述版本和知识身份规则。模型诊断使用规则、输入位置、业务 ID 或知识 key；工具提供读取与修复方法。对外 host service 的 info/discovery/transform 继续运行。

## 验收与体验

- 图版本、身份、引用闭合、跨领域形状、业务能力与语言资料测试。
- project 任意选择、jq 自定义与 builtin 同引擎，examples 真实执行。
- 无独立搜索工具，Agent 可从 help 获取完整操作方法。
- 最终上下文预算覆盖中文、多字节与缩进；大结果支持保存与按引用读取。
- 真实模型端到端完成知识检索、校验、执行、加工、图表/报告。
- 在隔离目录构建验证；运行产物更新、配置或重启前单独告知，验收前暂缓加载。
- 部署通过的分支产物到 oks profile，验证 HTTP、工具、模型版本与工作区，提供真机体验入口。

## 阶段

1. 独立提交 RFC，固定交付边界。
2. 工具统一 data shape、help、builtin 与回归。
3. 模型事实发布、工程契约与回归。
4. 隔离构建、端到端与真机部署；在 issue 记录提交、测试和体验方式。

## 语义分支知识图（本阶段实施）

真机检索表明单节点 80% 的体积可能来自混合成员 links。工具资源改为 `{datasets,types,relations,items}`：数据集拥有 fields/dimensions/measures/time_roles/business_links 字典，类型拥有 values 字典，关系独立发布。名称和说明统一为 items 的 `{key,names,doc}`；事实删除顶层重复描述。导航按目标类别及关系语义组织，保留自动派生的反向引用。精确投影一个分支不附带其他分支。

身份为独立节点与节点内标识组成的二元信息，序列化为 `datasets/<encoded-id>#fields/<encoded-id>` 等。ID 在地址中 URI 编码一次，字典键保留原始 ID。模型发布 address 与分类 role，声明 ontology-knowledge-v3 / node-member-uri-v1。工具拒绝旧契约、地址冲突和断链，并提供同引擎 search/members/references/read jq 及描述配套切片。

metadata 保持简短（版本、根集合、计数），较长发现契约由显式资源读取。当前阶段保留完整内部模型事实进行验收与词汇派生，Agent 可见图采用语义组织；不把两种 shape 同时混在一个资源中。
