# RFC 0019：消费构建期外部信息

- 状态：工作分支实施，不合入
- 跟踪：lab-ontology #64

## 契约

Telora 构建期 A 产生 P1／P2：P1 支撑运行程序，P2 是插件可读取的外部信息。插件从 telora.build.information 的 {version:1,entries:{"ontology.knowledge":...}} 读取知识。此能力与 Service、运行期源和配置重导入无关。

领域事实、外部说明、缓存身份及导航派生继续遵循 RFC 0018。兼容旧 telora.service.metadata；新段存在但非法时直接报错，不回退。两个段同时提供 ontology.knowledge 时拒绝歧义，即使值看似相等也不能掩盖制品协议错误。

## 验收

覆盖普通非 Service Wasm 的信息读取、新旧段兼容、重复／冲突／损坏拒绝、不调用运行模型，以及现有静态图、外部说明和旧发现回归。构建和测试仅使用隔离目录，不更新 10923／10924。沿用现有分支并自主阶段提交。
