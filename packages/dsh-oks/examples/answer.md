# 示例数据概览

下面的数值是演示数据，用于体验稿件执行、图表和交付，不是业务查询结果。

## pipeline
```js
// 为演示提供两行数据，并明确标记其性质。
let sample = data([{label: "A", value: 2}, {label: "B", value: 3}], {kind: "example"});
let summary = jq("summary.jq", {sample});
debug(summary);
let chart = render_figure({kind: "column", x: "label", value: "value", title: "示例数值"}, {data: sample});
let table = render_figure({kind: "table", columns: ["label", "value"]}, {data: sample});
let conclusion = render_html("answer.xhtml", {summary, chart, table});
```

## assets
```jq name="summary.jq"
{total: (.sample | map(.value) | add), rows: (.sample | length)}
```

```xhtml name="answer.xhtml"
<article>
  <p>示例共 <span data-oks-ref="summary" data-oks-pick=".rows" /> 行，合计 <span data-oks-ref="summary" data-oks-pick=".total" />。</p>
  <figure data-oks-ref="chart"><figcaption>示例数值</figcaption></figure>
  <figure data-oks-ref="table"><figcaption>示例明细</figcaption></figure>
  <p data-oks-shrink="">这些数值仅用于展示处理流程。</p>
</article>
```
