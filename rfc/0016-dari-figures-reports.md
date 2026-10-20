# RFC 0016：独立图表、可选报告与对话展示

状态：已实现，分支验收通过，等待真机体验。跟踪：https://github.com/hh9527/dsh-oks/issues/43

## 问题与目标

图表定义嵌在 Template 中，生成的 Markdown 引用工作区 SVG，无法可靠地在当前宿主对话中展示。图表应成为独立输出，报告负责编排，展示行为与计算分开。

## 文档与资源

```jsx
<Dari title="告警分析">
<Pipeline>
let facts = exec_query(query(intent));
let spec = {x:"level",value:"count"};
</Pipeline>
<Figures>
  <PieChart name="severity" spec={spec} data={facts.rows} />
</Figures>
<Report name="overview">
  <article>
    <p>见 <FigureRef ref="severity"/>。</p>
    <figure id="severity"><Figure ref="severity"/><figcaption>告警级别</figcaption></figure>
  </article>
</Report>
</Dari>
```

示例中的 intent 为先前定义并核实的查询意图。Pipeline 和 Asset 的语法及独立校验保持不变。Figures 中的图元必须自闭合、具备唯一 name；spec/data/nodes 仅引用 pipeline 绑定或静态投影。Report 可省略，具名 Report 以 article 为根。原生 figure 保存 id 等布局属性，Figure 引用独立图表，FigureRef 生成文字编号。目标必须在本 Report 中展示。

- `#facts`：pipeline 输出。
- `#figures.severity`：图表的结构数据。
- `#reports.overview`：报告的结构数据。

三个空间独立。报告按第一次 Figure 展示顺序分别编号图、表，重复引用复用编号，各 Report 从头编号。独立图表展示使用标题，不附报告编号。编译器保留旧 Template 的读取兼容；当前帮助和示例使用 Report/Figures。

## 执行与展示

oks_run_answer 执行完整文档并缓存依赖，Report 引用已有图表结果，避免重复查询或渲染。新 Report 默认回执给出保留结果地址。明确要求持久化时才以 delivery:"artifact" 保存业务报告。

oks_show({input:"oks://work/analysis.dari#figures.severity"}) 或 #reports.overview 展示当前会话已有结果。它不执行查询、不运行源码、不刷新上下文、不保存业务报告。结果无效、失败、会话不匹配、已回收时明确报错；源码已编辑则返回 stale。oks_data 读取相同对象的结构数据，负荷字段保持 .data。

通过 ctx.attachments.saveFile 保存 SVG 原文（含证据）或自足 HTML，取得内容寻址的 FileAttachmentRef。工具结果同时包含原生 file 块和短文本回执，presentationMeta 仅携带附件引用。fileHostPath 提供只读路径，回执返回可嵌入回答的 Markdown；宿主认证 api/file 图片路由负责内嵌 SVG，HTML 则以附件链接交付。插件不增加自定义会话展示层。附件保存在宿主附件仓库，避免工作文件清理、源码变更或重新执行改变历史图表。没有 attachments 服务时明确失败。呈现设独立 2 MiB 上限，超限明确失败。

## 验收

Figures-only；多 Report；图表复用；正向/前向 FigureRef；重复引用编号；图与表分号；命名与引用错误的源位置；结构读取；失败输出拒绝展示；不同会话隔离；源码变更 stale；展示前后 SQL/渲染/制品写入计数不变；模型回执不包含 HTML；快照在工作文件删除后保持；原生附件保存、file 内容块与可读引用；全量回归及 10923 真机环境。

验收记录：类型检查、完整回归（smoke 307/307）、独立 bundle + 真实模型/只读 SQLite、宿主附件实现与 10923 原生 SVG 媒体路由通过。尚未合入 main。

## 报告统一交付为宿主附件

报告与图表均通过 `oks_show` 导出至 `ctx.attachments`。报告扩展名为
`.report.html`，内容保留数据、来源和分析源码，表格为 `.html`，图表为 `.svg`。
`oks_run_answer` 仅返回保留结果及报告选择地址，移除 `delivery` 参数。

因为宿主已有持久附件存储和原生展示，删除旧制品账本、保留/回收逻辑、
`oks_artifacts`、自定义 HTTP 端点及产出 UI 包。安装器同步清理旧页签配置。
旧报告与数据的只读解码器保留。附件字节不进入模型上下文，回执只传引用。

### 清理内部材料目录

统一附件交付后，运行与缓存保留在内存，工作源码与持久方法库各有明确目录。
删除 `.oks/` 的磁盘材料读写、数据封装与 Markdown 表文件兼容入口，以及旧制品写入导出。
`oks_data` 仅接收知识图、帮助和当前会话 DARI 保留输出；附件内容仍包含独立的证据与报告归档。
演示工作区内的旧 `.oks/` 可直接删除。

### 报告文件卡片

HTML 附件导出回执提供 `present:{files:[{path,description}]}`，agent 将其作为宿主
`present` 工具参数声明交付，使用宿主的原生文件卡片。SVG 回执继续提供内嵌图片 Markdown。
文件附件内容块负责持久引用，卡片通过宿主 deliverables/presented 流程呈现，两者职责不同。

### 独立验证与完整诊断

容器可解析后，pipeline、具名 jq assets、figures 和 reports 独立收集错误，
资产编译通过 Promise.allSettled 等待所有单元完成。pipeline 失败时仍验证可独立判断的呈现语法，
不以缺失的 pipeline 符号产生级联错误；结构损坏导致块边界不可识别时仍先报告容器错误。
本地语法/静态检查有错时，停止业务执行和模型相关的计划检查。

移除累计 16 条错误即停止的预检行为，完整诊断按原文件位置排序并保留。
工具回执优先预览不同单元，压缩消息并明确 omittedDiagnostics、diagnosticsInput；
`oks_data("file.dari#diagnostics")` 支持分页，不重新编译或执行。
