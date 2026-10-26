# RFC 0018：消费初始化发布的知识事实图

- 状态：实施中，工作分支验收，不合入
- 跟踪：[模型 RFC 总议题 #64](https://github.com/hh9527/lab-ontology/issues/64)

## 契约

新模型在 telora.service.metadata 的 ontology.knowledge 条目中发布一份 JSON 事实图。插件直接从模型字节读取，无需启动 Wasm 或调用 info／discovery。图增加 entities、dimension_groups、measure_groups，Dataset 增加 bindings。Group 定义、具体绑定和最终公开成员均可寻址，类型约束和实体角色保持明确。

模型只提供自身事实及正向引用；插件校验地址、引用闭合、契约版本，再派生反向导航、成员索引和词表，并挂载现有 tools 知识。查询能力仅来自模型声明，反向链接不授予权限。名称／说明按 items 稳定地址组合，外部资料内容纳入缓存身份。

保留现有 ontology-knowledge-v3 模型的采集路径；新静态契约使用独立版本，存在但不合法时明确拒绝，不降级到旧模型爬图。新事实与原 jq search／read／members／references／routes 共用最终图，不引入并列知识资源。

## 验收

验证静态读取不调用模型、Entity／Dataset 分离、同一 Group 多次绑定与输出成员溯源、反向引用、未知引用拒绝、地址编码、jq 实际执行及现有回归。使用 relation model 和 IC 新制品验收，并复核 transform。构建测试在隔离工作区，不更新 10923／10924 或运行环境产物。


## 当前协议与实现

Wasm 自定义段为 telora.service.metadata，信封为 {version:1,entries:{"ontology.knowledge":...}}。领域条目声明 ontology-knowledge-v4、ontology-intent-v1、node-member-uri-v1、revision、facts 和 items。每条事实是 {key,value,references}，地址就是最终图地址；插件装配字典、核对正向引用闭合，再补分类与反向导航。新制品元数据损坏、版本不兼容或引用不闭合时直接报错，不能静默退回 discovery。没有该条目的旧制品继续使用旧契约。

类型引用使用 types/<编码后的稳定身份>；Group 身份使用规范定义的 SHA-256，定义仍保留名称与类型，不能只按显示名合并。Dataset 内新增 roles 与 bindings。jq 工具同时支持新类型地址与旧原始类型 ID。

可选的 <model.wasm>.knowledge-items.json 是独立说明文件：{version:1,items:[{key,names,doc}]}。其中 key 必须存在，names 追加别名，非空 doc 补充说明；拒绝事实字段和权限字段。Wasm 摘要、说明文件内容摘要与 domain 共同组成检索身份。没有外部说明时使用模型 items；二者都没有时仍可按稳定地址检索。

本轮只改隔离分支，不改运行配置或部署文件。总进展在 lab-ontology #64 汇报，不另开阶段 issue。
