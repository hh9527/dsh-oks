# RFC 0003：用 echarts 重建图表链路与报告

- 状态：**已完成**。实现在 `main` 上：图表与报告统一走 echarts，typst 那条线已移除；
  验收见 <https://github.com/hh9527/dsh-oks/issues/3>。
- 立项：<https://github.com/hh9527/dsh-oks/issues/3>
- 分支：`explore/echarts-report`（合入后已删除）
- 创建日期：2026-10-10
- 关系：**在渲染层上取代 [`rfc/0002`](./0002-typst-rendering.md)**（typst → echarts SSR），
  并新增报告形态；`rfc/0002` 里仍然有效的是**契约与产物形态**
  （`oks_chart` 的调用形状、来源标识、落盘与回执）。
- 前置观察：`rfc/0001` 立项时说"图表的呈现规格与客户端渲染"，`rfc/0002` 推翻了它（改成服务端渲染）。
  本文重新采纳"**呈现规格**"这个立足点——因为 echarts 的输入正是 JSON option，**规格即渲染输入**。

## 决策

图表渲染改走 **echarts 的服务端渲染**（`renderer: 'svg'` + `ssr: true`）：由**呈现规格**
（业务字段 + 结果行，纯 JSON）直接生成 SVG，不再经过一门中间语言。

- **正文里的图**：`![标题](.data/x.svg)`，与今天完全一致；
- **交付与报告**：`present` 把文件送进右侧栏；报告是一份**自足的 HTML**，图以 data URI 内联；
- **PDF**：**仍走 typst**（echarts 出不了 PDF）。即"**屏幕用 echarts、纸张用 typst**"，两条并行。

## 为什么改为这条路线

`rfc/0002` 的 typst 链路是通的、也稳定（99 条断言、真机验收过），但有三处代价：

1. **重**：`dist/` 约 46 MB（编译器 WASM 28 MB + 字体 17 MB），常驻 rss 约 460 MB；
2. **大**：单张图 100–250 KB——为了字体一致，typst 把文字**光栅化成 `<path>`**；
3. **图型有限**：lilaq 覆盖柱 / 条 / 折线 / 饼 / 面积。

echarts 在同样"服务端出静态 SVG"的前提下，把这三处一起解决：

| | typst（rfc/0002） | echarts（本文） |
|---|---|---|
| 单张图 | 100–250 KB | **4–5 KB** |
| 运行时依赖 | WASM 28 MB + 字体 17 MB | **约 1 MB，无字体资产** |
| 文字 | `<path>`（光栅化） | **真 `<text>`** |
| 图型 | 有限 | **全**（热力、雷达、桑基、地图…） |
| 生成方式 | 写 typst 源码 → 编译 | **`setOption(JSON)` → 字符串** |
| 首图耗时 | 约 76–154 ms（另有约 0.5–0.9 s 初始化） | 待实测 |

**最关键的一行是"生成方式"**：echarts 吃的是 JSON，而"呈现规格"本来就是 JSON。
`rfc/0002` 里"业务规格 → typst 源码 → SVG"这条两段式链路，在 echarts 下**退化成一段**：
规格**直接**就是渲染输入。这消掉了中间语言带来的整类问题——转义、语法陷阱
（`()` / `(0,)` / y 必须递增 / title 没有字号参数……详见 `rfc/0002` 的踩坑记录）。

## 实施范围

### 呈现规格（核心）

沿用 `oks_chart` 现有的 `spec` 形状，不发明新概念：

```
{
  kind,          // bar | column | line | pie | area
  title, x, value, series, xType, xLabel, valueLabel, unit,
  layout         // 排版覆盖：titleFont / labelFont / tickCount / height / rowHeight / slantTicks
}
```

**分工保持不变**：`spec` 描述"要表达什么"，`layout` 描述"排版上怎么让"。**不暴露 echarts 的 option**——
一旦暴露，规格就退化成"让 agent 写 echarts 配置"，那与"呈现规格"的初衷相反。

### 三种产物、三个档位

| 档 | 内容 | 出口 | 说明 |
|---|---|---|---|
| ① | **安全 SVG** | 正文内联 `![x](.data/x.svg)` | 与今天一致，是默认 |
| ② | **安全 HTML / PDF** | `present` → 侧栏 | 报告；HTML 自足，图以 `<svg>` 元素内联 |
| ③ | **带脚本 HTML** | `present` → 侧栏 | 富交互报告；**脚本只来自我们**，agent 只提供数据 |

### 安全约定（四条硬规矩）

1. **代码永远来自我们**：三个档位的 HTML / CSS / JS 模板都是插件里的常量，agent 只填数据；
2. **数据走 JSON、不走字符串拼接**：`<script type="application/json">` 内嵌，渲染用 `textContent`
   或 canvas，**不用 `innerHTML`**；
3. **报告里的图以 `<svg>` 元素内联**（而不是 `<img src="data:...">`）：base64 会把体积撑大三分之一，
   内联后图里的文字还能被选中、页面样式也能作用到图内。代价是**内联的 `<svg>` 会执行其中的脚本**
   （`<img>` 里的不会），所以生成器在拼装时自己剥一遍——脚本、`on*` 事件属性、指向外部的 `href`。
   安全性由那段清理保证，而不是"依赖我们的图恰好干净"；
4. **第 ③ 档默认关闭**：要显式要求才生成带脚本的产物。

### 报告容器

**自足的单个 HTML 文件**（发给别人也能打开）：

- 封面区（标题 / 生成时间 / 来源 / 时间窗）；
- 目录（锚点）；
- 章节：标题 + 一段叙述 + 图 + 图注（图 1、图 2…）；
- 可选的可折叠明细表（`<details>`，纯 HTML/CSS）；
- 口径说明节；
- 页脚。

**排版由模板定，章节内容由 agent 定**——每份报告长得一致，又不限制它写什么。

### preset 变更

`oks` preset 补挂 `@deepseek-ai/dsh-tool-present`（两行）。**没有它，②③ 都交付不了**。

## 里程碑（issue #3 上按此汇报）

| # | 内容 |
|---|---|
| M1 | 立项 + 分支 + 四条可行性验证（**已完成**：四条全部走通） |
| M2 | 呈现规格 → echarts option 的 lowering；`oks_chart` 切到 echarts |
| M3 | 报告生成：spec → 自足 HTML（图 data URI 内联）；preset 补挂 `present` |
| M4 | 冒烟与文档更新；真机逐项验收（正文内联 / present / 报告） |
| M5 | 合入 `main`，清理分支（需人确认） |

## 验收

- [ ] 五种图元（bar / column / line / pie / area）由 echarts 生成，正文内联显示正常；
- [ ] 同一份 SVG 既能在正文内联，也能 `present` 后由侧栏渲染；
- [ ] 报告 HTML 自足（无外链、无脚本），图以内联 data URI 显示，目录与折叠可用；
- [ ] `dist/` 体积与常驻内存显著下降（去掉 WASM 与字体）；
- [ ] `pnpm run check` 全绿；
- [ ] 真机验收通过。

## 待探问题

1. **SSR 的宽高自适应**——echarts 要在 `init` 时给定宽高，报告里的图得按版式常量算；
2. **字体**：不内嵌字体意味着中文由宿主渲染，同一份 SVG 在不同环境观感有差异，要确认可接受；
3. **首图耗时**：echarts 只有约 1 MB，预期比 typst 快，待实测；
4. **PDF 是否维持 typst**：本文假定维持；若将来要统一，需要另立项（echarts 出不了 PDF）；
5. **第 ③ 档的脚本边界**：渲染器与数据分离后，还要确认沙箱内的具体能力（能否联网、能否读同目录文件）。

## 风险与边界

- **文字一致性的让步**：不内嵌字体，换来包体积从 46 MB 降到几 MB；
- **依赖单一图表库**：图型丰富度、样式与后续维护都押在 echarts 上；
- **`oks_chart` 的契约不变**，但**产物内容会变**——工作区里旧的 typst SVG 仍能正常显示（都是 SVG）；
- **不做的部分**：更换 PDF 的生成方式（维持 typst）、把 echarts option 暴露给 agent、
  服务端动态图表（echarts SSR 只出静态图，交互只存在于第 ③ 档的报告里）。
