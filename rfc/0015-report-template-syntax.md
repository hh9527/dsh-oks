# RFC 0015：以 .dari 组织处理流程与只引用数据的模板

- 状态：已实施；完整自动验收与 10923 测试环境部署验证通过。
- 跟踪：https://github.com/hh9527/dsh-oks/issues/41。
- 实现分支（历史）：`spike/report-template-syntax`。
- 创建日期：2026-10-20。
- 关系：拟演进 RFC 0013 的源码容器与模板绑定；复用既有 pipeline、执行图、jq、图表、来源链和交付语义。

## 一、动机与阶段范围

Markdown 分别保存 pipeline、jq 和 XHTML，再通过字符串名字连接图表、数据与模板。
拟以 `.work/<问题>.dari` 表达一份回答源码，让模板直接引用 pipeline 的已有数据，
由编译器提取依赖并生成渲染节点，减少作者手动维护的图表变量与 data-oks-ref/data-oks-pick 连接。

DARI 的英文名称为 **Data Analysis and Representation Intermediate Format**。
`.dari` 是文件扩展名，内容是一门专用的类 JSX 小语言，按本 RFC 的语法解析。
不要求标准 XML 良构，也不调用 JS 求值。jq 与 pipeline 原样书写，不为容器转义 `<`、`>`、`&`，
模板使用 `data={facts.rows}` 等引用属性。

本阶段接入正式工具，以 `.dari` 为执行入口；直接构建项目 lib/，验收后更新 10923。
原型保留于 `experiments/report-syntax/` 作为历史证据。模型侧无需变更，main 合入另需授权。

## 二、源码结构

```jsx
<report title="告警概览">
  <script type="jq" name="summary.jq">
    {total:(.facts.rows | map(.count) | add)}
  </script>

  <pipeline>
    let facts = query({ /* 按实际模型声明编写 Intent */ });
    let summary = jq("summary.jq", {facts});
    let chartSpec = {kind:"column", x:"level", value:"count"};
    debug(summary);
  </pipeline>

  <template name="answer">
    <article>
      <h1>告警概览</h1>
      <p>总数：<Value data={summary.total} /></p>
      <Figure spec={chartSpec} data={facts.rows}>
        <figcaption>按级别比较</figcaption>
      </Figure>
    </article>
  </template>
</report>
```

- 一个 report 根，一个 pipeline；探索稿可以没有 template。
- jq asset 通过 script 的 type/name 声明，名称在文件内唯一。
- template 可具名声明多个，名字与 pipeline 绑定共享交付名字空间，冲突即报错。
- report 的 title 为静态字符串；块的物理排列不授予执行顺序，pipeline 内仍先定义后引用。
- 保留 pipeline 独立 `//` 注释的步骤意图和业务说明。
- 可选 notes 块保存静态业务说明，不进入计算。正文原样保存，以首个 `</notes>` 结束；这个串为保留分隔符。
- script 也支持 type="xhtml" 的显式资产，用于低层 render_html 组合和既有草稿显式迁移；主要写法为 template。

### 原始代码块边界

顶层 script/pipeline 开始标签后进入对应语言的原始正文模式；其中的比较符、逻辑符、
对象花括号、字符串与注释均不作为模板标记解析。

正式实现采用语言感知扫描：只有字符串、注释之外的结束标签才闭合代码块。
pipeline 识别 JSON 双引号字符串、// 和 /* */ 注释；jq 识别双引号字符串、# 注释及字符串插值中的嵌套表达式。
字符串/注释中的同形结束标记保持原样。未闭合字符串/注释遇到独占一行结束标记时，
优先恢复容器边界并交给独立语言编译器诊断；不执行带错源码。

## 三、两种表达式能力

### pipeline：独立的进程内语言模块

沿用受限语法：不可变 let、debug、JSON 字面量/数组/对象构造、绑定引用、静态投影和固定算子。
筛选、遍历、条件、算术与聚合由 jq 完成。pipeline 解析/编译器为可直接调用的进程内模块，
拥有自己的 AST、语法检查、绑定/依赖检查与诊断接口；不通过启动外部 JS/Node 进程解析。
现有 parsePipeline 已符合该模块化方向，可复用并进一步分离诊断与依赖分析。

### 模板：只引用 pipeline 的数据

模板花括号仅接受：

```text
Reference := Binding ( "." Identifier | "[" JsonString "]" | "[" SafeIndex "]" )*
```

例如 `{summary.total}`、`{facts.rows[0]}`、`{summary["中文键"]}`。
花括号内不构造对象/数组，不调用算子，不使用算术、条件、动态索引或局部绑定。
模板只读 pipeline 的公共绑定；其他 template 和编译器生成节点不成为可引用的作者变量。

模板解析器调用专用 reference 子解析器，输出绑定身份、路径和源范围。
它与 pipeline 共享引用/投影的定义与 AST 约定，不需要完整 JS/JSX 解析器。

普通 XHTML 元素及属性沿用报告白名单；第一版普通属性只接受静态字符串。
动态内容通过 Value/Figure 表达。正文中需要字面花括号时使用明确的文本转义表示，
不将正文 `{...}` 解释为隐式计算；正文用 `&#123;` 表示左花括号；普通文本和属性沿用 XHTML 实体规则。

## 四、模板组件与依赖图

### Value

`<Value data={summary.total} />` 选择一个标量值，按字符串/数字/布尔值/null 的已有显示规则呈现，
保留原绑定身份与完整投影路径。对象/数组不能自动字符串化为正文，须在 jq 中生成明确的摘要。
编译器可生成内部引用槽，但作者不维护临时绑定、data-oks-ref 或字符串摘取路径。

### Figure

`<Figure spec={chartSpec} data={facts.rows} />` 声明一个渲染节点；可选 nodes 也只能引用 pipeline。
kind 位于 spec，不增加第二份 kind 属性。子节点承载现有 figcaption 等说明。
编译器生成 render_figure 节点，复用现有表格/图表校验与渲染。
空数据、缺失路径、错误规格及不支持的开关沿用明确诊断，不静默修改图意。

### 编译结果

外层编译器直接产生统一 DraftDocument/执行 IR：

1. pipeline 模块产生作者节点、对绑定与具名 asset 的依赖。
2. 模板模块产生引用槽和组件节点，依赖只指向 pipeline 的既有绑定或本模板的内部组件节点。
3. template 产生答案节点，持有其引用与图表节点的依赖。
4. 内部名字与作者名字隔离，不占用、猜测或改变作者的绑定名。

正式实现不生成 JS 执行代码，不经 Markdown 再解析。所有生成节点都携带原模板组件的位置。
构造值与静态路径继续携带来源链；生成 XHTML 内部 ref 到作者组件的关系需要 source map。
runtime、校验缓存、计算缓存、调试读取和交付复用同一套机制。

## 五、独立语言模块与原文件诊断

### 源文件和片段

外层负责一次读取完整 `.dari`，建立 SourceFile 与行索引；抽取的片段保留原始字符，不 trim、
不去缩进、不改换行。每个 SourceFragment 至少包含：

```ts
interface SourceFragment {
  file: string;                   // .work/analysis.dari
  name: string;                   // summary.jq 或 pipeline
  language: "jq" | "pipeline";
  text: string;
  originalRange: SourceRange;
}
```

逻辑资产名用于依赖寻址，不充当用户诊断文件路径。pipeline 的进程内入口类似：

```ts
compilePipeline(fragment: SourceFragment): CompileResult<PipelineProgram>
checkJq(fragment: SourceFragment): Promise<CompileResult<CompiledJqHandle>>
```

jq 独立编译使用实际运行引擎与相同白名单，不执行虚拟输入来替代语法检查。
沿用 Wasm worker 的超时/取消边界；独立编译模块不等于每个片段启动一个外部进程。

### 统一诊断

```ts
interface Diagnostic {
  stage: "container" | "pipeline" | "jq" | "template" | "validation";
  message: string;
  file: string;
  span: SourceRange;              // 原 .dari 的范围
  related?: {span:SourceRange; message:string}[];
  asset?: string;                 // 可选上下文，不替代 file/range
}
```

语言模块可在内部使用片段相对范围，由统一源位置层映射为原文件坐标。
统一对外范围采用半开 UTF-16 offset；行列从 1 开始。Rust/jaq 的 UTF-8 byte range 必须先在原片段内
转换，再加片段基址；不能直接相加，也不能只给行号加一个常量。CRLF、中文、emoji、首行列偏移、EOF
与相关位置都必须覆盖。生成 XHTML 的验证器也须经 source map 回指原组件/属性。

目标诊断：

```text
.work/analysis.dari:4:18 [jq/undefined-filter]
  未定义的 jq 函数 missing_filter
  asset: summary.jq
```

位置应标到 `.dari` 中实际 token；snippet 和 caret 都从原文件抽取。
不能只将片段错误标题改为 `.dari`，却保留片段内的行列或展示生成稿正文。

### jq 结构化诊断接口

Rust 在 jaq 原始 load/compile 错误格式化前提取 UTF-8 primary/related 范围。
check_program 的 status=3 返回 `{message,diagnostics}`，保留 status=1 运行时文本错误协议。
worker 将结构传给 JaqCompileError；工具在 SourceFragment 中转换范围并映射回原 `.dari`。
不反解析排版字符串，不填充虚构空行。引擎内部或资源错误缺少范围时使用资产整体位置。

### 检查顺序与缓存

容器检查 → pipeline/template 的独立编译 → 名称、依赖与资产检查 → 全部具名 jq 独立编译、
组件静态校验 → 实际执行。可以批量收集独立片段诊断；任何静态错误都阻止业务查询采集。

合法性/编译缓存键包含语言、源码、编译器/白名单版本，保存相对诊断或编译产物，
不缓存已经绑定到旧文件位置的错误。资产移动、改名或插入说明文字后，重新映射到本轮源文件；
源码不变时仍可复用编译产物。执行缓存继续以操作、实际输入与环境为依据，正文修改不重查业务数据。

## 六、错误恢复与预算

正式编译接口返回诊断列表。第一版容器/pipeline/template 在首个错误停止；各独立资产可合并最多 16 条编译诊断。
原始代码未闭合的恢复只采用独占一行结束标记。
未闭合引用/标签/原始片段要有主要诊断，随后抑制不可信区域的衍生错误。
恢复用于多报独立问题，不用于带错执行。第一阶段不承诺任意未完成源码的编辑器级增量解析。

保留现有源码、嵌套、节点、资产、输出和执行预算；新增模板节点/引用槽计入总预算。
诊断的条数和总字节数同样有界，说明剩余错误被省略。

## 七、工具接入与迁移

- work_* 允许 `.work/*.dari` 的文本编辑与读回；文件路径约束和预算保持一致。
- oks_run_answer 只接受 `.dari`，直接生成统一执行图，运行/交付返回原报告路径。
- oks_data 继续读取 `.work/analysis.dari#binding`、`#debug`，只读已有结果。
- 多模板以现有 answer 参数指定交付目标；单模板可自动选择；模板顺序不暗含答案优先级。
- `.md` 保留为普通文本；离线 `scripts/migrate-draft.ts source.md destination.dari` 显式转换，目标必须不存在。
  转换保留说明、pipeline、具名 jq/XHTML，先校验原结构与转换后 DARI；运行时不回退 Markdown parser。
- 格式版本/解析器版本参与相关缓存身份，避免切换格式时复用不兼容产物。
- 模型侧不感知源码扩展名、模板或呈现语法；工具知识图与最小引导随正式能力更新。
- 本阶段直接更新 lib/；暂停 10923 后构建，验收通过再启动，保留既有 .md 并创建 .dari 体验稿。

## 八、可行性证据与后续验收

分支原型已验证：

- 原始 jq 与独立进程内 parsePipeline；模板属性仅接受绑定/静态投影。
- 模板依赖提取、内部名字避让、模板可省略，未知绑定/缺失 asset 在执行前拒绝。
- 真实 jq、数值/文本引用、SVG、来源链、空结果、重复运行与正文编辑缓存复用。
- 16 类错误输入及引用原始位置；UTF-8/UTF-16 范围映射覆盖中文、emoji、CRLF、EOF 和片段移动。

原型通过临时 Markdown 转译桥接未改动的 runtime。它不验证直接 IR 接入、真实 jq 结构化诊断、
生成 XHTML 细粒度映射、恢复后的多诊断、notes、多模板交付或完整预算；这些由正式实现的测试单独验收。

正式验收还须覆盖：

1. 真实 jq 词法/语法/未定义函数错误及 pipeline 各类错误，都指向原 `.dari` 的准确 token 范围。
2. 编译缓存命中后移动片段仍指向新位置；不同文件相同片段不串位置；取消/资源失败分类明确。
3. 错配标签、缺失花括号、原始片段边界和错误恢复的主要诊断与级联抑制。
4. 无效模板/jq 不能先触发 query；动态投影缺失和渲染错误回指原属性/组件。
5. 直接统一 IR 后，采集批次、刷新、缓存、来源链、只读查看、交付预算与已有格式行为一致。
6. 多模板选择、表格/所有图元、nodes 输入、特殊字符、探索稿、notes 和大文档预算。
7. 按用户约定直接构建项目 lib/；更新 10923 前告知，验收通过后再部署并真机体验。

## 九、推进顺序

1. 独立实验确定核心可行性，单独提交本 RFC 并记录待定边界。
2. 固定原始代码块/文本转义/notes 文法；实现原文 SourceFile/SourceFragment 与独立编译接口。
3. 扩展 jq 结构化诊断，完成真实原文定位测试；不先靠格式化文本兼容凑齐。
4. 模板降为统一 IR，复用执行、来源和渲染；接入工具、知识节点与回归。
5. 本地 lib 构建和 10923 真机验收；main 合入另需授权。

## 十、第一版实现与边界

- 正式代码位于 src/draft/{document,pipeline,source,runtime,backend,tools}.ts，直接生成 IR。
- DARI 限 256 KiB、2048 个模板元素、128 层模板嵌套、1024 个总节点、128 个总资产；pipeline 沿用原预算。
- 内部 Figure 节点参与失败/阻塞判断，成功时不挤占回执预览；作者通过 pipeline 绑定和 template name 读取结果。
- 生成 XHTML 诊断经分段映射定位到原组件/属性；jq 词法、语法与名称错误映射到原 token 范围。
- 诊断回执截取最多 8 条，并有总回执预算；独立资产预检最多收集 16 条。
- 呈现知识图、最小引导、README、examples/answer.dari 与执行工具同步。
- 本次不增加编辑器增量解析或任意错误恢复，不改变领域模型接口。

### 本地验收记录（2026-10-20）

- TypeScript typecheck、Rust oks-wti 单元测试通过。
- 完整 pnpm test 通过（smoke 使用显式测试工作区，构建产物直接位于项目 lib/）；集成冒烟 307 项通过。
- 独立 bundle + canonical 模型 + 只读 SQLite 验证通过：真实计数、columns/truncated、日历窗口、缓存、交付和示例。
- 14 个图元通过正式 Figure 模板执行；多模板选择、内部节点隐藏、失败传播和只读边界通过。
- 真实 jq 编译诊断覆盖中文/emoji/CRLF、EOF、未定义函数 token、缓存后移动与资产改名；静态错误不采集 query。
- oks-demo 保留原 .md，显式迁移 diag_limit_slot.dari；新增 dari_alarm_overview.dari，验证真实分组查询、jq、Value/Figure、debug、原稿来源及自足报告。

## 十一、具体图元组件与原生 figure（2026-10-20）

本轮按用户确认更新第一版文法：根为 Dari；结构标签为 Pipeline、Asset、Template、Notes。
Asset 使用 language="jq" / "xhtml" 与 name 声明具名资源；大小写严格，不保留小写别名。

```jsx
<Dari title="告警概览">
  <Pipeline>
    let rows = data([{level:"major",count:3}],{kind:"example"});
    let spec = {x:"level",value:"count"};
  </Pipeline>
  <Template name="answer">
    <article>
      <figure id="severity">
        <ColumnChart spec={spec} data={rows} />
        <figcaption>按级别比较</figcaption>
      </figure>
    </article>
  </Template>
</Dari>
```

- 自定义组件为 BarChart、ColumnChart、LineChart、AreaChart、PieChart、ScatterChart、Histogram、BoxPlot、Heatmap、RadarChart、Sankey、NetworkGraph、Gauge、Table。
- 标签决定渲染类型，spec 必须省略 kind（即使与标签一致也报错）；编译节点携带内部类型元数据。pipeline 的显式 render_figure 仍使用含 kind 的规格。
- 每个原生 figure 放一个自闭合图元，再接可选 figcaption；组件为 figure 的直接子元素。只有 NetworkGraph 接受 nodes 属性。
- figure 上的 id/class/title/lang 为静态属性；Value 和组件参数继续只接受绑定及静态投影。
- 编译结果直接把原生 figure 绑定到内部渲染结果，不生成嵌套 figure。图表位于说明之前，caption 自动显示“图 1：…”或“表 1：…”。图与表分别编号，每个答案从头计数；编号只在呈现层产生。
- 内部图元类型参与计算缓存身份；同配置换标签不会误用旧图。修改 caption 可复用图表计算；当前模板位置与来源重新装配。
- 呈现知识中每种图元提供 component 字段与不含 kind 的 spec 示例。显式 XHTML 资产的布局语义保持不变。

本节替代前文小写容器和 Figure 组件的第一版语法。已有 .md 的显式迁移生成上述大写容器；第一版 .dari 体验稿同步更新。

本轮验收：TypeScript typecheck、完整 pnpm test（含新增组件测试）通过，smoke 307 项通过；独立 bundle + canonical 模型 + 只读 SQLite 验证通过。oks-demo 两份已知 .dari 体验稿已更新，旧稿备份到 /tmp；真实查询、columns/truncated、debug、原稿来源和报告交付均通过。

### 宿主 JSON 返回边界修复（2026-10-20）

真机宿主在 output.render 前对返回值做无损 JSON 快照；可选字段为 undefined 时会整体拒绝。
DARI 回执改为仅在存在时添加 diagnostics、related、错误位置；debug 目录返回省略 outputs 字段。
查询来源在 dataFile 不存在时也省略该可选字段。保持宿主严格校验，不通过 JSON.stringify 清洗返回值。
工具回归对每次成功返回检查 JSON 往返一致性；独立 bundle 回归支持以 OKS_VALUES_MODULE 加载当前宿主实际 snapshotJsonValue，对真实查询、模板、debug、来源及交付逐次验证。

### 运行失败定位

运行回执提供独立的 `failures` 根因优先摘要，包含失败 binding、组件或 asset、输入 binding、源码位置和原因。成功输出摘要先让出预算，回执主体以 6500 字节为目标，为交付字段及回复保留空间。保留所有失败项的身份和位置，过长 message 按预算缩短并用 `messageTruncated` 标记，完整原文保存在运行记录中；失败目录本身超出通常输出预算时仍传递诊断，省略成功摘要及回复正文。`oks_data({input:"report.dari#failures",offset:0,limit:20})` 只读分页获取完整失败列表（包括内部图元），不依赖显式 debug。jq 运行错误保留资产身份及引擎原始原因；源码位置定位到调用表达式。

图元诊断使用模板名与作者的 `figure id`（如 `report#tbl-dominant（Table）`），同时提供结构化 `template`、`figureId`、`component` 字段。缺少 id 时以模板名、组件及源码行列定位；下游 blocked 原因使用同一标识。内部执行序号与报告图表展示编号分别独立，不作为诊断定位依据。

DARI Template 的标记属性 `data-oks-shrink`、`data-oks-lit` 支持省略值，与显式 `=""` 等价；生成 XHTML 时统一输出空字符串属性。引用、路径及其他带值属性继续显式赋值，重复属性仍报错。独立 XHTML Asset 保持 XML 良构要求。

### 查询计划与采集快照

`query(intent)` 校验并编译计划，独立于业务数据库和采集批次，可见负荷为 `{columns:[{name,type,nullable}]}`。模型缺少列声明时明确失败。SQL、bindings、limit_slot、原始 intent 和模型编译身份保存在内部计划负荷中，完整绑定引用保留执行身份，JSON 构造/投影/jq 不生成可执行计划。`exec_query(plan)` 仅执行完整计划，结果为 `{rows,columns,truncated}`，来源链继续记录真实 intent 与数据来源。

`exec_query(plan)` 与 `context()` 是采集算子：同一稿件/会话/批次内，相同输入复用首次成功捕获；计划变化只重新采集相应查询，context 无输入，捕获的时间和时区保持固定。执行环境变化视为有效输入变化。纯计划缓存不依赖数据库和批次；执行缓存区分同列声明但不同查询的完整计划。

`oks_run_answer({src,refresh:true})` 重置该稿采集批次并运行；`renew_context({src})` 仅重置当前会话中指定稿件的批次，清除旧输出可读状态，不执行 SQL 或源码，下次运行才采集。其他稿件及会话独立。采集快照被回收时同一输入不自动重查，明确要求 refresh/renew。资源保留仍受现有会话/源码生命周期约束，服务重启开启新的运行状态。

第一版通过仅包含 query 的探索稿实现低成本验证；确认 columns 后加入 exec_query，不新增检查运行模式。既有取数稿可通过 scripts/split-query.ts 显式迁移到另一文件，原稿保留。模型侧沿用当前 transform 接口。
