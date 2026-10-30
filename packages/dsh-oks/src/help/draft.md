# DARI 分析稿

一个业务问题使用一份 `.dari`。`data` 定义不可变的取数与后处理，`figure` 定义图表，`report` 定义可交付报告。用 oks_write/oks_edit 编辑，oks_check 检查；oks_run 检查后整稿执行；默认直接运行，requireRunApproval=true 时先申请宿主用户批准。

## 声明与节点

```dari
data facts := query({op:"Graph",root:"d",nodes:[{id:"d",entity:"<实际数据集ID>"}],edges:[],select:[],count:"d",limit:100});
data summary := select_one({
  from:{s:facts},group_by:(r)=>({}),
  fields:(g,rows)=>({returned_groups:count(rows)})
});

report answer := Report(title = "对象概览") [
  h1 [ "对象概览" ],
  p [ "返回分组数：", Value(data = summary?.returned_groups), ],
];
```

对象 ID 从 cap/card 获得。绑定共享一个命名空间、不可重复，先定义后引用。`:=` 是不可变绑定；支持 `//` 和 `/* ... */` 注释。每条声明以 `;` 结束。

图表与报告统一使用 `tag(attr = expression, ...) [ children ]`。属性或子节点为空时可省略对应部分；子节点是 JSON 字符串或节点，使用逗号分隔，允许尾逗号。字符串中的中文、&、< 直接书写，渲染器负责 HTML 转义。

```dari
figure counts := ColumnChart(spec = {x:"name",value:"count"}, data = grouped);
report answer := Report [
  h1 [ "对象统计" ],
  p [ "总数：", Value(data = summary?.total), ],
  figure [
    Figure(ref = counts),
    figcaption [ "类别分布" ],
  ],
];
```

figure 绑定右侧是图表组件或 Table，data 直接接受 Table(T)，无需 `.rows`。report 绑定右侧是 Report，直接写正文节点。`Figure(ref = counts)` 中 ref 是已经声明的 figure 绑定；`FigureRef(ref = counts)` 显示本报告对应的图/表编号。

图表属性与 Value.data 接受有类型表达式，例如 `Value(data = round(summary?.cpu,2))`。普通排版节点的属性使用静态字符串，例如 `p(class = "lead")`。业务数值通过 Value 引用；静态业务参数可以直接写入标题或正文。显式字面文本使用 `Lit ["1.2"]`；其子节点只接受字符串。Lit 声明静态文字，观测得到的业务值仍通过 Value 引用。

## 类型检查

`query(intent)` 是 Table(T)。检查调用模型获得 columns，直接建立 T 并参与后续推导，不读取业务行。`select(spec)` 推导 Table(U)；`select_one(spec)` 返回普通 Option(U) 对象。表列在 select 的行参数中访问；报告标量使用 select_one。

表达式、聚合、Option 和有限 map 语义见 `oks://help/pipeline.md`；查询意图见 `oks://help/query.md`；时间见 `oks://help/time.md`；图表形式见摘要中对应的单图表手册，正文见 `oks://help/report.md`。

检查回执的 queries 包含查询和关系节点的列，types 列出绑定类型，diagnostics 给出原稿位置、错误字段和可用字段。检查覆盖图表映射、报告结构、Value 标量和溯源要求，不返回业务值。query 的 limit 必填，范围 1..500；截断结果不能用于后处理聚合。

## 批准与交付

完成整稿检查后调用 `oks_run({src:"oks://work/<问题>.dari"})`。默认检查后直接运行。设置 requireRunApproval=true 时，每次运行通过 DSH 原生批准机制，批准绑定本稿源码、模型、数据配置和冻结的上下文。拒绝或取消时不执行；等待中源码或配置变化会拒绝继续。

只有一个 report 时自动交付；多个 report 使用 `answer:"报告绑定名"` 选择。结果的 `values` 包含报告 Value 引用的标量，`figures` 包含该报告实际展示的图表事实；data 绑定作为内部计算保留，不自动全部返回。报告附件使用运行回执的 `delivery.publication.present` 参数调用宿主 present 工具交付。

普通重跑复用查询和后处理缓存，改后处理不重新取数；refresh:true 创建新的采集上下文。运行后解读获准返回的事实。
