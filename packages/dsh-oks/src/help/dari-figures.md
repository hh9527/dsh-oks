# .dari 图表组件

组件声明、字段投影和引用语法见 oks://help/dari.md。本分册列出各组件的数据映射与配置。

| 组件 | 主要映射 |
| --- | --- |
| BarChart / ColumnChart | x 类别，value 数值，颜色按类别 |
| GroupedBarChart / GroupedColumnChart | x 类别，series 分组，value 数值 |
| LineChart / AreaChart | x 横轴，value 数值，显式 x_type，可选 series |
| PieChart | x 类别，value 数值，可选 donut |
| ScatterChart | x 与 value 数值，可选 size |
| Histogram | value 原始观测值，可选 bins（1..200） |
| BoxPlot | x 类别，value 原始观测值 |
| Heatmap | x 与 series 为两维类别，value 数值 |
| RadarChart | x 指标，series 比较对象，value 数值，至少三个指标 |
| Sankey | x 起点，series 终点，可选 value 权重 |
| NetworkGraph | x 起点，series 终点，可选 value 权重；额外 nodes = 节点表，节点至少含 id/depth |
| Gauge | x 名称，value 为 0..100 的百分数 |
| Table | 可选 columns 列名数组、labels 表头映射 |

图表共同配置：title、x_label、value_label、unit、style:{labels:True,colors:["#..."],sort:"none"}、layout:{label_font:12,title_font:16,slant_ticks:False,tick_count:8}。这些字段的适用范围仍由组件校验。bar/column 的行高由字体驱动，不需手调画布高度。单序列组件不接纳 series；多分组用对应 Grouped 组件。

LineChart/AreaChart 的 x_type 为 "Int"/"Float"/"String"/"Rfc3339"/"EpochMillis"，且必须与横轴类型匹配；可选 connect_nulls。GroupedBarChart/GroupedColumnChart/AreaChart 可设 stack:Stack::None/Stack::Total/Stack::Percent（默认 None；Total 为原值堆叠，Percent 为类别内归一化构成比）。堆叠要求指标允许 Sum；Percent/Ratio 本身不具备加总能力。适用的图表支持 second:{value:project!(other),label:"...",unit:"...",kind:"line"} 和 marks:[{value:80.0,label:"阈值"}]。

BarChart/ColumnChart 及对应分组图的 value_min 可设置轴基线，例如 99.0；条/柱上的标注仍是原始数值。空输入默认报错；显式 allow_no_data:True 接受空表并显示“无数据”。Table 同样支持 allow_no_data，保留表头。表格 labels 例如 {device:"设备",cpu:"CPU (%)"}，columns 决定列顺序。SVG 内嵌最终图表输入的 CSV 和 spec，报告保留这些信息。

### 宽表多指标并列

GroupedBarChart / GroupedColumnChart / LineChart 支持每个数值列对应一个序列，各列保留自身业务类型。共用数值轴的序列必须显式声明相同单位，不能跨指标堆叠或按序列之和排序；可显式使用 stack:Stack::None。

```text
answer tree! {Answer [GroupedColumnChart(data = weekly, spec = {
  x:project!(period),
  series:[
    {value:project!(cpu),label:"CPU 平均使用率",unit:"%"},
    {value:project!(memory),label:"内存平均使用率",unit:"%"},
    {value:project!(online),label:"设备在线率",unit:"%"}
  ]
})]};
```

LineChart 使用相同的 series 列表，并声明 x_type，例如：

```text
LineChart(data = daily, spec = {
  x:project!(day), x_type:"Rfc3339",
  series:[
    {value:project!(cpu),label:"CPU 平均使用率",unit:"%"},
    {value:project!(memory),label:"内存平均使用率",unit:"%"}
  ]
})
```

不同业务类型可以共用展示单位一致的数值轴，无需转成长表或剥离类型。各列按自身 presentation 转换到展示尺度，例如 Ratio 与 Percent 都显示为百分比；空值默认断开折线，可用 connect_nulls:True 连线。宽表多序列共用一个数值轴，不能同时声明 second。

多张结果表先通过 query! 中的 join 按共同键（如周期）对齐，再 project 成宽表；不能按行位置配对。单次 query_remote! 能投影出各指标时直接使用该宽表。类别分组仍使用 series:project!(category)、value:project!(value) 的长表形式。

比例类型的显示遵循模型发布的 presentation：Percent(12) 和 Ratio(0.12) 都显示为 12%。Value 和表格自动附加百分号；图表将数值映射到百分比显示尺度，并在轴上声明单位。原始数据与运算尺度保持不变，不需要手写乘以 100。value_min 等坐标轴配置使用显示尺度；显式 unit 必须与类型显示单位一致。SVG 的内嵌 CSV 保留原值，spec.presentation 记录相应列的显示倍率和后缀。

数值默认最多两位小数并去尾零；Int 完整显示。图表及 Table 可设 spec.precision:3（静态整数 0..12），优先于模型发布的展示精度，模型默认优先于系统默认。轴刻度、数值标签及提示框使用同一规则，Percent/Ratio 自动显示百分号；几何计算、排序及 SVG 内嵌输入保留原值。百分比堆叠只在最终显示时舍入，不能用其消除业务指标之间的加总限制。
