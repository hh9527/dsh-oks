# DARI 分析与执行的同源降低

跟踪 [Issue #52](https://github.com/hh9527/dsh-oks/issues/52)。同一份源码共享 AST、绑定、位置和类型规则，分别产生分析 IR 与执行 IR。

- 分析入口允许参数计算、模型 transform 和 schema-only SQL prepare
- `context()` 在分析时使用固定时刻 `2026-01-15T12:00:00.000Z`，保留配置时区；执行时独立捕获真实时间
- 分析 IR 保留 map 的函数体，按元素类型检查一次关系后处理；依赖元素的 query 参数逐一 transform，兼容的列类型合并
- 执行 IR 展开有界计划，重新 transform 实际参数并采集结果，缓存和来源仍归执行阶段管理
- 纯参数表达式可求值；业务行始终未知，不能决定远端 query 参数

## 验收

`draft-design-test.ts` 覆盖两个 IR、禁止调用执行入口、禁止读取真实时钟和业务数据、固定诊断、map 函数体单次检查、全部参数组合诊断、纯参数 map、嵌套 map、参数表、真实运行时钟与聚合结果。

真实模型验收脚本可在仓库根目录运行：

```sh
node --import ./packages/dsh-oks/scripts/markdown-loader.mjs experiments/analysis-execution/check-model.ts ic /path/to/ic.wasm /path/to/telora-run
node --import ./packages/dsh-oks/scripts/markdown-loader.mjs experiments/analysis-execution/check-model.ts ns /path/to/ns.wasm /path/to/telora-run
```

脚本对源码示例运行完整检查，业务执行器及运行时钟一旦被访问即抛错。

| 模型示例 | 实际 transform 调用 | 回执语义节点 | 公开绑定类型数 | 检查回执字节 |
|---|---:|---:|---:|---:|
| IC CPU 对比及逐日趋势 | 18 | 13 | 18 | 7018 |
| NS 网元分类 | 1 | 3 | 4 | 1814 |

以上为本次现有模型制品的单次验证结果，不作为性能基准。检查时刻不能证明真实执行日期下的查询必定可用；运行期继续检查实际 transform、结果 schema、单元格、基数及预算。map 仍要求静态有界输入；空数组缺少元素类型时不能推导其函数体。
