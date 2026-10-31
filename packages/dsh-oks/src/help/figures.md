# 图表通用语法

支持的图表形式与适用场景已在主 agent 的图表能力说明中。选定形式后读取 `oks://help/figure-<kind>.md`，例如柱状图 `figure-column.md`、折线图 `figure-line.md`、表格 `figure-table.md`。

## 绑定与映射

```dari
data rows := table([{day:"周一",count:3}],{kind:"example"});
data spec := {x:"day",value:"count"};

figure daily := ColumnChart(spec = spec, data = rows);
```

组件标签确定类型，spec 省略 kind。data 引用 data 绑定的 Table(T)。x/value/series 指向检查返回的列名；series 的含义由图表类型决定。先在 query/select 中完成聚合；图表不自动汇总重复单元。

规格各层级严格检查字段名与类型。排版使用 `layout:{height:300,rowHeight:20}`，排序和数值标签使用 `style:{sort:"desc",labels:true}`；未知或放错层级的字段会在 oks_check 中报错，并提示正确路径。

时间轴 xType=time 接受 RFC3339 或 epoch 毫秒；数值与时间 x 在每个序列内须非递减。窗口的自然日时区来自 context，与存储时标格式分别表达。

## 按需读取

- 本图表的必填映射、开关、最小示例：全局摘要列出的对应 `figure-<kind>.md`
- 标题、轴名、单位、排版及完整通用规格：`oks://help/figure-options.md`
- Report 正文、Value、图表引用、编号和完整报告示例：`oks://help/report.md`

Table 的 columns 是字符串列名数组，表头就是数据键名；中文表头在 select 的 fields 中指定输出列名。只有 NetworkGraph 接受独立 nodes 数据。
