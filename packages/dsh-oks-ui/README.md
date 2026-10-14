# @local/dsh-oks-ui

右侧栏的「产出」页签：**只读我们自己的服务端接口**（`oksArtifacts`），呈现的是**制品**
（图与报告：标题、类别、时间、是否保留），而不是工作区里的文件。

- 它只有**浏览器半边**。宿主侧入口（`lib/index.mjs`）是空的——它存在的意义是让 profile 能挂上
  这一条 entry，从而让 `dsh-client-modules` 扫到 `dsh.client` 声明、把页签打进页面加载清单。
- 数据来自**插件自己开的五条同源端点**（`packages/dsh-oks/src/endpoint.ts`）：
  `GET /oks/artifacts?sessionId=…` 拿清单、`POST /oks/pin` 落保留、`POST /oks/delete` 删除、
  `POST /oks/collect` 清理、`GET /oks/download?…` 下载报表。前端**不读文件、不碰工作区布局**：
  清单是插件知道的事实，问它最直接；保留、删除与清理都是机械操作，直接落后台——都不经过 agent。
  删除只在**未保留**的条目上可点（保留中的那份按钮置灰、服务端同样拒绝）。
- 清单**上方**是一块固定大小的**工作区概览**：四行占用（数据 / 图表〔图表与表格合并〕/
  工作件 / 输出件，各带份数与大小）＋一行"最后清理 + 下拉"。数字与清理时间都来自同一次清单轮询（回执里的 `usage`），
  **界面不自己算**；只改数字时也会刷新（`sameListing` 认 `usage`）。清单为空或还没读到时
  这块照常渲染，只把数字显示成"—"——位置不跳、按钮一直在。
- **动作成功不弹消息**（清了什么、还剩什么，概览的数字直接反映）；动作失败（清理 / 删除 / 保留）
  只占**一行不换行**的短行（`oks-artifacts-action-error`，超出用省略号），不把清单顶下去。
- 概览那一行的右侧是一个**「清理」下拉**（不是单个按钮）：`清理 30 分钟前的` / `清理 5 分钟前的`
  ——菜单把窗口作为 `ttl` 传给宿主，材料与工作件按它清，**点了就清、不再弹框确认**；报表不在其中。
  **成功不弹消息**（清了什么，概览的数字直接反映）；失败只占一行不换行的短行。
  不带 `ttl` 调端点时仍按工作区声明的 `retention.manual` 清（agent 的 `collect` 走这条）。
- **读不到清单时把话说清楚**（界面不显示任何路径）：手上有清单就只提示一行、继续显示手上的；
  手上什么都没有时写明"读不到「产出」清单"、原因、以及"每 4 秒会重试一次"——
  "读不到"与"这个工作区没有产出"因此不会长得一样。
- 为什么不是 Typert Remote：那个路径上游目前不支持第三方（装饰器出处要落在 workspace 的
  `packages/*` 注册包里）。同源端点是我们自己的接口，形状由我们定。
- 类型只用**自己的最小声明**：DSH 的客户端类型包依赖一个没有发布的内部包
  （`@deepseek-ai/dsh-type-meta`），第三方装不上；只声明用到的那几个方法反而更稳。

## 交付形态（容易踩的一条）

页面加载器要的不是 ESM，而是**经典脚本 + 宿主模块加载器协议**（与 DSH 自己的 client 包一致）：

```js
window.__ModuleLoader__.load({ id: '@local/dsh-oks-ui', factory: (require) => module.exports });
```

依赖在工厂里用 `require("<包名>")` 取，所以 `src/client.ts` 里**不能有顶层 `import`/`export`**
（类型用 `import type`，会被擦掉）。交出裸 ESM 的现场是浏览器里一句
`Cannot use import statement outside a module`，页签整条 entry 直接不激活。

工厂还要返回 **`inject`：运行时注入的「服务键」**（不是包名！）：这里是
`['slots', 'sidebarRightTabs']`。少了它 cordis 不会把 `ctx.slots` 注进来，`apply` 一进门就抛
——现场只表现为 `web boot: 1 entry did not activate / @local/dsh-oks-ui: failed`。

还有一条容易漏的：右栏空着时播的是**引导页**，它只列登记过 `guide` 条目的 tab 类型——
`sidebarRightTabs.register({ …, guide: [{ id, order, title, description, icon }] })`。
只注册 `kind`、不登记 `guide`，类型是存在的、**界面上却看不见**（图标借 primitives 包现成的那个）。

`pnpm run test`（`test.mjs`）**在本地模拟页面加载器**：查交付形态（经典脚本、无顶层 import）、
查 `apply` 与 `inject` 都在、查 `inject` 覆盖用到的服务，再用一个只有这些服务的假 ctx 真跑一遍
`apply`——这三件事以前只在浏览器控制台里暴露。

构建：`pnpm run build`。
