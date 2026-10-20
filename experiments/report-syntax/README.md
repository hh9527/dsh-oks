# 报告语法可行性试验

跟踪：[issue #41](https://github.com/hh9527/dsh-oks/issues/41)，设计见 [RFC 0015](../../rfc/0015-report-template-syntax.md)。

本目录保留最初可行性原型，使用历史 Markdown 桥接，不被插件入口导入。
正式执行入口、编译器和回归测试见 packages/dsh-oks；以下记录描述原型阶段。

## 验证方法

从仓库根运行，使用项目已经构建的 jq Wasm：

```sh
./packages/dsh-oks/node_modules/.bin/tsc --project experiments/report-syntax/tsconfig.json
node experiments/report-syntax/test.ts
```

`example.dari` 包含 pipeline、原始 jq asset 和只引用 pipeline 的模板。
编译器提取带原始位置的引用，将 Value 降为标量绑定、Figure 降为 render_figure，
再生成 Markdown 调用现有 DraftRuntime。这条桥接只用于验证语义能否复用。

测试覆盖：

- 真实 jq 中的 `<`、`&` 与行内结束标签字符串。
- 片段到原 `.dari` 的位置映射，包括 UTF-8/UTF-16、中文、emoji、CRLF、首行列、EOF 与片段移动。
- 模板静态引用、对象键/数组下标投影、依赖集合和原始行列/偏移。
- 真实 SVG、数值与文本插值、空结果、来源链、重复运行和正文编辑的缓存复用。
- 16 类非法输入：构造/调用/运算、缺失花括号、未知绑定、动态投影、缺失或重复属性、
  错配标签、未闭合原始块、模板重名、pipeline 前向引用、缺失 asset、普通属性动态引用、正文表达式。

## 结论与局限

语法在限定范围内可行，现有 pipeline、渲染与来源机制可复用。

source.ts 已验证语言模块的相对范围到原文的映射；当前 jaq ABI 只有格式化错误字符串，实际 jq token 诊断接线需要增加结构化范围，原型尚未实现。

原型先报一个错误，不实现恢复后的多错误诊断。XHTML 校验错误只回指整个模板；
经过 Markdown 桥接后的后端错误、执行记录和来源链中的 draft 仍指向生成稿。
生产实现必须直接生成统一 AST，并让资产与 XHTML 校验结果映射回原始报告，
不能把本原型的 Markdown 转译路径当作最终实现。

仅实现 RFC 核心子集；notes、多个模板的交付选择、所有预算边界、恢复性诊断与
编辑器支持需要按 RFC 分阶段完成。扩展名采用 `.dari`，内容按专用类 JSX 语法解析，不要求标准 XML 转义。
