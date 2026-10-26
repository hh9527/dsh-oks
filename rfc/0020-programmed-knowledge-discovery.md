# RFC 0020：静态 JavaScript 与模型 JSON 构图

- 状态：已实现并通过隔离验收及 10924 体验部署
- 跟踪：https://github.com/hh9527/lab-ontology/issues/65
- 联动：lab-ontology RFC 0005

## 协议

模型发布 `ontology-knowledge-javascript-v1`，包含静态 JS 函数体 program 和 JSON 描述 data。data 为 `{revision,instructions}`，每条指令为 `[operation,...args]`。具体模型标注仅派生 JSON；同一 ontology 版本的 program 对所有模型完全一致。

静态资源和 JSON 同时放入 `telora.build.information` 的 `ontology.knowledge` 条目。插件读取 custom section 并 JSON.parse 后，用 `new Function("data", publication.program)` 物化构图函数，再把 publication.data 传入。静态程序自行 initialize、顺序执行指令并 finish，返回 `{graph,vocabulary}`。

## 职责

插件信任模型代码并直接同步执行，不使用 eval，不提供沙箱、外部宿主参数或强制超时承诺。静态程序负责地址、类型、Group、绑定、关系、内容哈希和事实合并，使用 Map／Set 与原地更新；插件仅理解入口和输出结构。

最终 graph 使用 ontology-knowledge-v4，插件验证事实和引用，派生导航及反向链接。vocabulary 使用 Term 字段，供 va_ask 使用；外部展示补充经验证后丰富名称和文档。成功结果沿用现有模型身份缓存；编译、执行、图或词表验证失败均不进入缓存。

知识加载只接受本协议。jq discovery／expand、旧完整 v4 发布和运行期发现不作为知识来源。

## 验收

覆盖静态代码执行及数据复用、错误指令／输出、模型词表和外部展示、图引用闭合、旧协议拒绝和失败缓存。跨模型 program 字节完全一致，JSON 随模型变化。

以 relation／生成样本／IC 验证完整图等价，测量构图和导航／词表分项，运行插件完整 typecheck/test 及新 IC SQLite smoke。模型和插件的实现及验收已完成；10924 体验部署和部署产物 smoke 96/96 通过，10923 保持不变。

## 决策记录

原 jq 批量发现方案停止推进。相同 IC JSON 的外置实验中，JS 指令构图约 79 ms，正式 jq 约 1963 ms；总计约 348 ms 对 2231 ms。单次 jq 仍约 1551 ms。直接调用与 JSON 指令的差距小，选用指令表达；正式制品的构建分布、首次加载及完整验收见 lab-ontology 的 `evaluations/static-javascript-knowledge.md`。
