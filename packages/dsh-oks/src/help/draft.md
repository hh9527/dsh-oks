# DARI 分析稿

不要为了探索能力单独开分析稿，而是一个问题一个分析稿，直接在分析稿内进行尝试。 一个业务问题使用一份 `.dari`。`data` 定义不可变的取数与后处理，`figure` 定义图表，`report` 定义可交付报告，唯一的 `answer := Answer [...]` 定义回答流正文。用 宿主内置文件工具 编辑，dari_check 检查；dari_resolve 检查后根据必填的 answer 布尔参数解析回答及显式选择的产物和依赖；默认直接运行，requireRunApproval=true 时先申请宿主用户批准。

源码使用本地文件路径，src 可以是工作区相对路径或工作区内的绝对路径；缓存按会话和文件的真实路径隔离。用宿主内置工具读取、创建和编辑文件。`dari_check({src:"analysis.dari"})` 检查全稿，可通过可选 inspect 参数点名读取类型形状。`oks_read` 只读取内置手册。

## 声明与节点

```dari
data facts := query({op:"Graph",root:"d",nodes:[{id:"d",entity:"<实际数据集ID>"}],edges:[],select:[],count:"d",limit:100});
data summary := select_one({
  from:{s:facts},group_by:(r)=>({}),
  fields:(g,rows)=>({returned_groups:count(rows)})
});

answer := Answer [
  h1 [ "对象概览" ],
  p [ "返回分组数：", value(ref = summary?.returned_groups), ],
];
```

对象 ID 从 search/routes/info 获得。绑定共享一个命名空间、不可重复，先定义后引用。`:=` 是不可变绑定；支持 `//` 和 `/* ... */` 注释。每条声明以 `;` 结束。

图表与报告统一使用 `tag(attr = expression, ...) [ children ]`。属性或子节点为空时可省略对应部分；子节点是 JSON 字符串或节点，使用逗号分隔，允许尾逗号。字符串中的中文、&、< 直接书写，渲染器负责 HTML 转义。

```dari
figure counts := ColumnChart(spec = {x:"name",value:"count"}, data = grouped);
report full := Report [
  h1 [ "对象统计" ],
  p [ "总数：", Value(data = summary?.total), ],
  UseFigure(ref = counts, caption = "类别分布"),
];
answer := Answer [
  p ["分析结果如下"],
  UseFigure(ref = counts, caption = "类别分布"),
  UseReport(ref = full),
];
```

figure 绑定右侧是图表组件或 Table，data 直接接受 Table(T)，无需 `.rows`。report 绑定右侧是 Report，直接写正文节点。`UseFigure(ref = counts, caption = "说明")` 中 ref 是已经声明的 figure 绑定，caption 为可选的静态文字说明。表格使用 Table 图表组件，通过 UseFigure 嵌入；`FigureRef(ref = counts)` 显示本报告对应的图/表编号。

图表属性与 Value.data 接受有类型表达式，例如 `Value(data = round(summary?.cpu,2))`。普通排版节点的属性使用静态字符串，例如 `p(class = "lead")`。业务数值通过 Value 引用；静态业务参数可以直接写入标题或正文。显式字面文本使用 `Lit ["1.2"]`；其子节点只接受字符串。Lit 声明静态文字，观测得到的业务值仍通过 Value 引用。

## 类型检查

`query(intent)` 是 Table(T)。检查调用模型获得 columns，直接建立 T 并参与后续推导，不读取业务行。`select(spec)` 推导 Table(U)；`select_one(spec)` 返回普通 Option(U) 对象。表列在 select 的行参数中访问；报告标量使用 select_one。

表达式、聚合、Option 和有限 map 语义见 `oks://help/pipeline.md`；查询意图见 `oks://help/query.md`；时间见 `oks://help/time.md`；图表形式见摘要中对应的单图表手册，正文见 `oks://help/report.md`。

检查返回纯文本，以 `Succeed` 和分割线表示成功，以 `CheckFailed` 和分割线表示检查失败。`ready-status` 列出全部公开声明，包含未使用的声明；data/figure 的 `t1-...` 指纹表示本次检查通过及推导出的类型形状，`?` 表示尚未通过检查。report/answer 通过时显示 `checked`。存在不可恢复的语法错误时，无法列出声明，依据 errors 修正源码。

需要列名或对象字段类型时，调用 `dari_check({src:"analysis.dari",inspect:{data:["facts","summary"],figures:["counts"]}})`；名称使用源码绑定名，每个列表最多 32 项。inspect 只返回推导出的形状，figure 显示数据及可选节点表的类型，不重复源码定义。指纹不变，就可以沿用上下文中此前 inspect 获得的形状信息，不重复读取。没有读过形状时，按需 inspect。

指纹包含类型、字段名、可空性和表列顺序；普通对象字段按名字排序，值、源码、数组长度和运行缓存不参与。指纹以 t1 标识格式版本。报告和回答通过 errors 判断，不参与 inspect。

errors 给出原稿行列范围和诊断原话，每次最多 20 条，超过时报告省略数量；上游连锁错误不显示。失败时也返回可用节点状态及所请求的已通过节点形状，并表现为失败的工具调用。检查覆盖图表映射、报告结构、Value 标量和溯源要求，不返回业务值。query 的 limit 必填，范围 1..500；截断结果不能用于后处理聚合。

## 批准与交付

完成整稿检查后，正常交付调用 `dari_resolve({src:"analysis.dari",answer:true})`。调试时关闭回答并选择需要读取的绑定：

```js
dari_resolve({
    answer: false,
    src: "<问题>.dari",
    data: ["summary"],
    figures: ["counts"],
    reports: ["full"]
})
```

answer 为必填布尔值，三个列表均可省略，名称必须对应声明种类。answer:false 只解析显式选中的内容，至少选择一项。成功回执以 `Succeed` 和分割线开头，只输出请求的内容；下面用 HTML 注释分块：`<!-- answer -->` 是唯一 Answer 的 Markdown 正文，`<!-- reports.name -->` 是报告链接，`<!-- figures.name -->` 是图表图片或 Markdown 表格，`<!-- data.name -->` 是保留完整结构的 JSON 代码块。正文和链接直接使用 Markdown，不包在 JSON 字符串里。

交付时原样使用相应块中的 Markdown，略去状态头、分隔注释和调试数据；需要解读的事实通过 data 显式选择。图表可以独立交付，不要求编写 report。检查失败使用 CheckFailed 回执；执行或选择失败使用 ResolveFailed 和精简根因诊断，并表现为失败的工具调用。

只执行所选产物的依赖，共享计算与缓存。普通重复解析复用查询和后处理缓存，改后处理不重新取数；dari_renew_context({src}) 创建新的采集上下文，下一次解析重新取数。

默认检查后直接解析。设置 requireRunApproval=true 时，每次解析通过 DSH 原生批准机制，批准绑定本稿源码、模型、数据配置和冻结的上下文。拒绝或取消时不执行；等待中源码或配置变化会拒绝继续。根据显式返回的事实解读。

## 回答流出口

每份分析稿最多声明一个 `answer := Answer [...]`，先定义数据、图表和报告，再声明回答。正常交付调用 `dari_resolve({src:"analysis.dari",answer:true})`，将 `<!-- answer -->` 块中的 Markdown 原样贴进回答，不重复编写或解读同一份正文。answer:true 时也可以额外选择 data/figures/reports；调试使用 `dari_resolve({src:"analysis.dari",answer:false,data:["summary"]})`。省略 answer 或请求不存在的 Answer 会报错。

Answer 沿用 node 写法：h1/h2/h3 转为 Markdown 标题，strong/em 转为强调，p、列表、引用、代码和链接转为对应 Markdown。动态标量写作 `value(ref=summary?.total)`，检查引用及标量类型，保留来源追踪；文字与动态值均转义 Markdown。`Lit ["1.2"]` 表示明确的静态文字。null 显示为破折号。

`UseFigure(ref=chart,caption="说明")` 发布图表并嵌入图片 Markdown，Table 则生成表格文件链接。`UseReport(ref=full)` 发布已经声明的 Report，并嵌入可点击的报告文件链接；不需要额外调用 present。相同产物在一次解析中只发布一次。UseReport 只用于 Answer；Answer 不接受无法用 Markdown 表达的 class、id 等排版属性，检查时会明确报错。

SVG 图表文件只包含图形和标题。数据、查询与加工过程、上下文及最终绘图数据保存在报告归档中，溯源从报告读取。报告包含三个非执行 script 节点：dari-source 保存源码，dari-context 保存实际执行上下文，dari-values 保存当前报告使用的引用值（含图表数据），相同引用去重。

## 从报告恢复分析稿

`report_extract_dari({src:"report.html",sink:"restored.dari"})` 将报告归档中的原始源码写入指定的新 `.dari` 文件，目标目录须已存在，文件不覆盖。源码前附加历史执行上下文（含 context 实际值）、执行时间及模型标识等注释。它不执行查询；重新运行会取得新的上下文，不保证重现原报告结果。提取后使用宿主文件工具读写该文件。
