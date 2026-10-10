// offline-all-widgets.typ —— 离线化入口兼能力清单。
//
// 用法：typst compile --package-cache-path <repo>/.typst-cache offline-all-widgets.typ out.pdf
//
// 两个作用：
//   1) 把本插件用到的 typst 包连同传递依赖一起拉到本地缓存，供运行时 WASM 离线读取；
//   2) 列出这些包——编译通过即代表它们可以离线使用。
//
// 依赖树的解析（多层、同包多版本）交给 typst 自己，我们只把结果搬进 dist/typst-pkgs/。

#import "@preview/lilaq:0.6.0" as lq
#import "@preview/cetz:0.5.2"
#import "@preview/cetz-plot:0.1.4": chart

#set page(width: 720pt, height: auto, margin: 12pt)

= 出图能力

== 条形图与折线（lilaq）

#lq.diagram(
  title: "分组柱",
  width: 100%,
  xaxis: (ticks: ((0, "一"), (1, "二"), (2, "三"))),
  lq.bar((0, 1, 2), (3, 5, 4), width: 0.4, offset: -0.2, fill: rgb("#5a8cf0"), label: "甲"),
  lq.bar((0, 1, 2), (2, 4, 6), width: 0.4, offset: 0.2, fill: rgb("#e0803a"), label: "乙"),
)

#lq.diagram(
  title: "面积图",
  width: 100%,
  lq.fill-between((0, 1, 2, 3), (1, 4, 2, 5), fill: rgb("#5a8cf0")),
  lq.plot((0, 1, 2, 3), (1, 4, 2, 5), stroke: rgb("#2c5fa8")),
)

== 饼图（cetz-plot）

#chart.piechart(
  (("甲", 3), ("乙", 5), ("丙", 2)),
)
