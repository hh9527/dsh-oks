# RFC：对话中的图表呈现与按需读取数据

- 状态：**技术选型部分已被 [RFC 0002](./0002-typst-rendering.md) 取代**——本文里"图表在服务端用 d3
  自绘"的路线不再采用；本文仍然有效的是**产物形态**部分：图落成工作区文件、回执给出一行 markdown、
  图出现在回答正文里。
- 立项：[#1](https://github.com/hh9527/dsh-oks/issues/1)
- 创建日期：2026-10-09
- 实施档位：第 3 档（高复杂度 / 长程）

## 摘要

拟在对话流中直接呈现图表，通过统一的绘图接口提供两条数据路径：agent 自主填写数据，以及直接引用已查询结果。
后者由系统直接取得查询数据用于渲染，使数据有机会全程不进入 agent 上下文；agent 需要时可以主动读取。
图表显示由系统确定的数据来源标识，帮助用户判断来源与可信度。

本文记录已确认的外部特性，并给出接口设计初稿。标为“设计初稿”的细节供后续讨论调整；宿主接入能力已完成源码调查与运行验收。

## 动机

当前 `oks_query` 将查询结果通过工具文本返回给 agent，用户主要通过文字和表格查看数据。
希望查询得到的数据能直接形成对话中的图表，同时减少默认进入 agent 上下文的数据量。
图表也应能表达 agent 自主提供的数据，例如方案比较、估算或示意；用户需要清楚分辨这些数据的来源。

## 外部特性与使用方式

### 对话流中的直接呈现（实测后修订）

用户可以在对话流里直接看到图表：图表由服务端画成 SVG 落进工作区，agent 把回执给的 markdown 行
放进回答，图就显示在**回答正文**里（而不是工具卡）。图上带有系统来源标识；展开与交互不在本期范围。

### 首期图表与基础规格（已确认）

首期支持表、横条图、多序列折线图。
表用于查看明细，横条图用于类别比较并沿用数据顺序，折线图用于有序横轴上的变化。
基础规格包含标题、横轴列、数值列和可选的序列列，直接使用提供的数据。
具体字段、选列与空值等规则见技术设计初稿。

### 统一接口与两条数据路径（已确认）

| 入口 | agent 提供什么 | 数据路径 |
|---|---|---|
| 独立生成图表 | 自主填写的数据与图表规格 | agent 提交的数据参与渲染 |
| 基于已查询结果生成图表 | 已查询结果的引用与图表规格 | 系统直接读取查询结果参与渲染 |

统一工具 oks_chart 通过 src 与 data 区分两条数据路径，两者必须恰好提供一个。
src 直接引用查询结果文件，使渲染可以使用数据，避免要求 agent 先读取并转写数值。
data 接收 agent 自主填写的数据。

### agent 按需读取（已确认）

一般情况下，返回的查询数据和生成的图表都不自动进入 agent 上下文。
agent 需要数据时可以主动读取。

独立生成图表时，agent 自主填写的数据已出现在提交过程中；这一路径与查询数据的上下文隔离分别设计。
默认回执见查询回执约定，主动读取采用宿主读文件能力，见技术设计。

### 来源标识（已确认）

独立生成的图表在渲染时标识为“agent 自主填写”，透明呈现其来源，供用户判断可信度。
基于查询结果生成的图表标识为“基于查询结果”。
来源标识由系统根据入口确定。agent 填写的标题、标签和来源说明与系统标识分开呈现。
具体文案和视觉样式待定；标识说明来源，数据是否正确仍需结合原始数据与业务口径判断。

### 来源核对（已确认）

每张图都可展开查看系统来源标识，以及该图实际使用的数据。
基于查询结果的图表同时展示 dataSrc、key 和 at。
来源信息的承载清单如下，后续章节引用此清单：

| 位置 | 承载内容 |
|---|---|
| 结果 JSON 文件 | name、key、at、intent、columns、rowCount、rows |
| 查询调用参数 | 命名 Intent 及其 key |
| 查询 presentationMeta | Intent、SQL、bindings、执行信息 |
| 绘图调用参数 | spec（含 name），以及 src 或 data，可选 note |
| 图表产物 | `.data/<名>-<at>.svg`，图里画着系统来源标识 |

图表不再声明 presentationMeta：它的消费者（客户端视图）已经退场，而图本身的来源标识直接画在图里。
图表产物与查询结果一样是工作区文件，用相对路径引用即可——这条路径既不需要文件 RPC，也不需要把
数据再复制一份进会话事件。
宿主源码已确认 inspect 入口，默认指向当前绘图调用；当前会话内定位原查询的 callId 关联与跳转在实施时确定并验收。

### 对话呈现（实测后改为服务端出图）

- 图表由 **node 半边画成 SVG** 落进 `<工作区>/.data/`，回执给出一行 `![标题](相对路径)`；agent 把它
  放进回答，图就显示在**回答正文**里（宿主 markdown 会把该路径解析成本地图片，已实测）。
- 工具卡里不再有插件视图：插件**没有 client 半边**，因此可以留在 preset 作用域内。
- 自主填写图表的数据与规格仍随调用记录保存，用于核对来源。

**为什么改**：最初的方案是 client-half（浏览器里画成交互组件）。实测确认两条硬约束：
`dsh-client-modules` 只扫描主 loader 的 `entries()`，preset 内的插件由独立的 `PresetTree` 装配，
client 半边写在 preset 里永远不会加载——要它生效只能把插件挂到 profile 顶层，从而污染该 profile
的所有会话；同时 toolview 的宿主是工具行，图表只能出现在**过程流**里，进不了回答正文。
服务端出图同时解决这两点：图能进回答，插件回到 preset。

代价与边界：回答里的图是**静态**的（没有悬停、切换、动图）；要看细节用 `oks_jaq_result` 取数，
或在回答里写 markdown 表格。出图依赖 d3 的两个纯计算包（`d3-scale`、`d3-shape`），构建时打进产物，
`dist/index.mjs` 因此从约 132 KB 增至约 225 KB（gzip 约 44 → 67 KB）。

## 技术设计

### 先校验，再执行（已确认）

拟将查询流程调整为：agent 先通过 `oks_check_intent` 校验 Intent，取得该 Intent 对应的 `key`，再通过 `oks_query` 执行。
`key = hash(intent)`，按单个 Intent 计算；对于 agent，key 是不透明值，必须从校验结果原样传递。
查询请求仍需携带 Intent 和 key，工具重新计算哈希并核对一致性。
key 用于核对请求，不提供通过 key 取回 Intent 或查询定义的能力。
算法留在工具内部，agent 通过校验工具取得 key；查询工具重算并比对哈希，无需登记已校验的 key。
哈希算法和 Intent 的规范化规则见设计初稿。

### Intent 行数约束（已确认）

每个 Intent 必须显式声明顶层 limit，取值为 1 至 100 的整数。
100 是首期暂定的产品上限，预计可以满足绝大部分面向用户的输出；它不是已验证的服务或宿主技术上限。
后续可根据实际使用场景调整，本期按 100 校验。
插件负责顶层 limit 必填及 1 至 100 的产品范围检查；`oks_check_intent` 在调用服务前检查，缺失、null 或不符合范围时返回诊断。
上游服务支持可选的顶层 limit，负责非 null 值的正整数语义校验，以及将其 lowering 到 SQL + bindings，限制最终结果行数；省略或 null 保持旧查询行为。插件通过必填校验保证本插件的查询均受限。
插件检查和服务校验均通过后才返回 key；查询工具执行时也检查产品范围，避免仅依赖 key 比对。
limit 属于 Intent 的查询语义，参与哈希并由生成的查询执行。
limit 由调用记录及结果文件中的原始 Intent 承载，回执和结果文件不增加独立的 limit 字段。
插件在回执中提供 rowCount；是否触及 limit 由 agent 结合自己声明的 limit 判断，系统不额外提示。
这是事实与判断的分工：行数达到 limit 时，agent 应考虑可能还有更多匹配数据，并据查询口径限定结论；仅凭行数达到上限不能确定还有更多数据，也不能据此声称涵盖全部匹配数据。
查询完整保存该 Intent 的结果，不另行使用 queryMaxRows 截断。
完整保存指完整保存包含 limit 的 Intent 执行结果，并不表示取得全部匹配数据。
limit 控制结果行数，不保证扫描、聚合和排序的计算量；执行仍保留超时约束。

### 查询结果结构（方向已确认）

每个 Intent 独立命名、独立校验、独立保存文件；一次调用仍可提交多个 Intent。
每个 Intent 的结果有自己的 key、at 和 dataSrc，与该 Intent 一一对应。
某项失败不影响其他项保存，绘图时直接引用对应的文件。
批次输入与回执的具体结构见设计初稿。

每个 Intent 的结果改为保存到一个 JSON 文件，包含原始 Intent、结果描述与 rows 数组，不保存 query。单个 Intent 是否产生多个结果，需要核对服务契约。
结果文件记录成功结果及其原始 Intent；诊断、阶段状态和失败通过查询回执与日志报告。

### 查询结果保存（已确认）

拟将 `oks_query` 调整为每个成功查询都将结果保存到会话工作区的 `.data/` 目录下。
数据文件名采用 `<name>-<key>-<at>.json`，其中 name 是 intents 命名对象的成员名，key 是该 Intent 的哈希，at 是执行时间。
查询返回 `dataSrc: ".data/<name>-<key>-<at>.json"`，使用相对 workspace root 的路径，供后续图表渲染和 agent 按需读取引用。
读取与绘图入口通过 dataSrc 加载同一个结果文件。

这会改变当前插件只读取工作区的行为：查询工具按调用参数在工作区写入结果产物。
结果文件保存成功后才返回 dataSrc。

### 文件规则与失败行为（已确认）

- name 作为单个文件名前缀，拒绝路径分隔符和空白名称。
- at 使用 UTC、毫秒精度且适合文件名的格式，具体编码见设计初稿。
- 文件创建时避免覆盖，重名则明确报错。
- 查询失败或保存失败时返回对应错误，不返回 dataSrc。
- 绘图时文件缺失或内容无效，明确显示失败原因。
- 文件被修改后，按读取时的内容绘图；key 与 at 标识查询和执行时间，不校验文件内容是否被修改。

### 查询回执（已确认）

默认回执包含列名及类型、行数，以及诊断或执行错误，数据行按需读取。
只有查询和结果文件保存均成功时才返回 `dataSrc`；失败项不返回 `dataSrc`。
批次中每个 Intent 分别报告自己的回执。

### 批次接口（设计初稿）

沿用工具名 `oks_check_intent` 与 `oks_query`。两者的 intents 均改为命名对象，一次接收 1 至 5 项。
名字在批次内唯一，用于对应诊断、回执和结果文件。

校验请求：

```json
{
  "intents": {
    "ports": { "op": "Graph", "root": "p", "nodes": [], "edges": [], "select": [], "limit": 100 }
  }
}
```

示例仅展示封装形状，Intent 内容仍以知识服务声明为准。校验回执按名字组织：

```json
{
  "results": {
    "ports": { "accepted": true, "key": "<opaque-key>", "diagnostics": [] }
  }
}
```

仅通过校验的项返回 key。查询请求将各项的 Intent 和 key 放在一起：

```json
{
  "intents": {
    "ports": {
      "intent": { "op": "Graph", "root": "p", "nodes": [], "edges": [], "select": [], "limit": 100 },
      "key": "<opaque-key>"
    }
  }
}
```

批次名字同时用于回执对应、结果文件中的 name 和文件名前缀。
工具按项核对 key、调用服务并执行查询；服务返回的批次下标诊断映射到对应名字。
查询仍进行服务校验，使执行时使用的产物变化能表现为诊断。某项失败后继续处理其余项。
首期按项串行处理，以保持单项错误与回执对应明确。

### key、时间与文件创建（设计初稿）

key 使用单个 Intent 的规范化 JSON 的 SHA-256 前 32 个十六进制字符（128 位）。
校验返回、查询核对、结果文件和文件名统一使用该 key。
规范化递归按对象字段名排序，保留数组顺序，采用 JSON 数值和字符串编码。
批次名字和图表规格位于 Intent 外，不参与哈希。
key 是一致性标识，agent 通过校验取得并原样传递；它不是访问授权凭据。

at 记录该项成功执行结束的 UTC 时间，格式为 `YYYYMMDDTHHmmssSSSZ`，例如 `20261009T083012123Z`。
请求入口检查批次名字：允许中文等普通文件名字符，拒绝 `/`、`\\`、控制字符、空白名称及 `.`、`..`。
创建 `.data/` 后，以独占创建方式写入单个 JSON 文件；目标重名报保存错误。
写入失败时移除本次创建的不完整文件，保留已有文件，回执不含 dataSrc。
读取入口要求 JSON 结构完整可用；该约定不承诺进程崩溃时的原子提交。

### 数据文件与回执（设计初稿）

每个成功 Intent 对应一个 JSON 文件，结构示例：

```json
{
  "name": "ports",
  "key": "<opaque-key>",
  "at": "20261009T083012123Z",
  "intent": { "op": "Graph", "root": "p", "nodes": [], "edges": [], "select": [], "limit": 100 },
  "columns": [
          { "name": "port", "types": ["string"], "nullable": false },
          { "name": "utilization", "types": ["number"], "nullable": false }
  ],
  "rowCount": 2,
  "rows": [
    { "port": "p1", "utilization": 42 },
    { "port": "p2", "utilization": 37 }
  ]
}
```

rowCount 是该 Intent 实际返回并完整保存的行数，最多 100 行。
空结果属于成功，保存 rows=[]、rowCount=0 的 JSON 文件。列名优先从 SQL statement 的列元数据取得，类型按返回值观察，
空结果的列类型记为 unknown；这些类型描述数据结构，不解释领域语义。
SQLite 大整数以十进制字符串保存并标记 integer-string；二进制值以 base64 字符串保存并标记 binary-base64。
结果文件与宿主呈现信息的字段归属见“来源核对”中的承载清单。
阶段状态、诊断和错误保留在调用回执与日志中。

保存成功的模型可见回执：

```json
{
  "results": {
    "ports": {
      "status": "saved",
      "dataSrc": ".data/ports-<opaque-key>-20261009T083012123Z.json",
      "columns": [],
      "rowCount": 2,
      "diagnostics": []
    }
  }
}
```

columns 与文件中的对应列信息一致，示例省略具体条目。
失败回执以 status 区分 key_mismatch、rejected、query_error 和 save_error，附 error 或 diagnostics，均不含 dataSrc。
save_error 可以附已执行成功的列信息和行数，但不自动回传数据行。
结构化工具值可以承载宿主呈现所需的信息；保存路径的模型可见 render 只输出上述回执。
宿主呈现信息按“来源核对”中的承载清单提供；源码已确认 meta 的独立事件通道，实施时验收其实际可读性及上下文隔离。

### 按需取数（已确认，经三轮讨论后定案）

曾考虑三条路：复用宿主的读文件工具（配合 grep 与分段读）、插件提供固定形状的读取接口
（选列 + 分页，即早期的 `oks_read_data`）、以及插件提供**表达式查询**接口。定案为第三种。

- **不复用宿主读文件工具**：目标 profile（`oks`）是收敛过的领域助手工具面，不挂 `dsh-tool-fs`
  与 `dsh-tool-bash`，agent 手里没有通用读文件能力；即便挂上，"读回一份带缩进的 JSON 再自己挑值"
  也不如直接声明要什么。
- **不用固定形状的读取接口**：选列 + 按行分页只能表达"取哪些列、从第几行起"，而 agent 真正需要
  的是筛选、投影、排序、聚合与切片；为这些逐项加参数，工具签名会变成一门自造的方言。
- **改用表达式查询**：`oks_jaq_result(src, query)`，`query` 是 jaq（与 jq 兼容）表达式，**输入是
  行对象数组**。表达能力与 jq 同档，agent 不必读文件，也不必了解结果文件的内部结构。

表达式作用在**行数组**而不是整个文件，是这一节的关键：结果文件的结构
（name/key/at/intent/columns/rowCount）因此继续保持插件内部实现，不成为对外契约；agent 面对的
契约只有"一组行对象"。

求值器的来源（系统 jaq、内嵌求值器、自实现子集）**不影响工具契约**，收在实现里另行决定；
当前实现调用系统 `jaq` 可执行文件（`spawn`，不经 shell，因此表达式没有命令注入面），
缺失时返回明确错误并指出该机器不支持结构化查询。

取数回执报告输入行数、产出值数与值本身，模型可见文本有整体预算；求值带墙钟超时与输出字符上限，
避免一条表达式把会话撑爆。求值器自身的报错（jaq 会带位置指示）原样带回，便于直接改表达式。

首期文件由工作区持有，持续保留。
每次成功查询产生一个独立的 JSON 文件，同 name、同 key 的后续执行也保留独立文件。
文件清理不纳入本期设计与验收。

### 绘图接口与规格（接口方向已确认，字段细节为设计初稿）

新增统一工具 `oks_chart`，接收 spec、可选说明 note，以及 src 或 data。
src 与 data 必须恰好提供一个；同时提供或均未提供时返回参数错误。
src 接收查询返回的 dataSrc，data 接收对象行数组，空数组属于有效输入。
来源标识由输入路径固定确定：src 为“基于查询结果”，data 为“agent 自主填写”。
即使 agent 将读取过的查询数据填入 data，来源仍标为“agent 自主填写”。

```json
{ "src": ".data/<name>-<key>-<at>.json", "spec": { "kind": "bar", "x": "port", "value": "utilization" } }
```

```json
{ "data": [{ "label": "方案 A", "value": 42 }], "spec": { "kind": "bar", "x": "label", "value": "value" } }
```
图表工具的模型可见回执只包含成功状态、图表种类、标题及来源引用，不回传数据行或图表图像。

spec 的字段约定：

| 字段 | 含义 |
|---|---|
| kind | bar 或 line |
| title | agent 填写的标题（同时画进图里） |
| x | bar 的类别列、line 的横轴列 |
| value | bar/line 的数值列 |
| series | line 可选的序列列 |
| xType | line 必填，number 或 time；time 接受有明确偏移的 RFC 3339 文本或 epoch 毫秒数 |
| xLabel / valueLabel / unit | 可选显示标签与单位，由 agent 提供，属于叙事层 |

字段绑定使用回执中的实际结果列名，首期由 agent 根据 Intent 与知识节点确定其业务含义。
图表规格位于查询 Intent 之外。列名、原始值与系统来源在展开区独立展示。

横条图按行顺序展示，每行一条，重复类别保留为独立条目；空值保留位置并标注无值。
折线图按每个序列的输入顺序连接，工具检查横轴非递减；不满足时返回规格错误。
重复横轴保留原点，空数值形成断点，空横轴或无效时间返回明确错误。
数值列只接受有限数值或 null；字符串数值、integer-string 和二进制字段可以在表中呈现。
空数据呈现空状态；查询图表呈现文件中保存的完整结果。
规格引用未知列或数据类型不适配时明确返回错误；要看明细表，agent 直接在回答里写 markdown 表格。

### 宿主接入（实测后改为服务端出图）

最初评估的是 client-half：在浏览器里把图画成交互组件。实测后改为服务端出图，宿主接入面因此只剩两件：

1. **工具声明**：`oks_chart` 仍是普通工具（`output.schema` 只校验结构化值），render 输出简短回执
   与一行 `![标题](相对路径)`；
2. **markdown 图片解析**：回答正文里的 `![...](相对路径)` 由宿主按会话 cwd 解析成本地文件并渲染
   ——这是宿主已有能力（chat 的 `MarkdownDelegate.fileImages.resolve`），实测认 SVG。

插件侧不再需要 `dsh.client`：没有 client 半边，就没有 `tool.call.toolview` 注册、没有
`presentationMeta` 消费者，也不需要 `remote.workspaceFiles`。图表产物与查询结果一样是工作区文件，
用相对路径引用，天然可导出、也能被其他工具再次引用。

**保留的宿主接入事实**（与出图无关，仍是当前实现依赖的）：工具结果的消息与 meta 分离、
`deriveMessages` 不把 meta 混进模型请求、会话持久化按事件保存。`oks_query` 的 presentationMeta
继续记录执行事实（Intent / SQL / bindings），供来源核对使用。

**已知的宿主能力缺口**（记下来，不在本期范围）：插件无法让内容进入"答案"区或消息正文——
`conversation.chat.node` 按会话事件类型分派、`TURN_PROCESS_INDEPENDENT_KINDS` 是固定集合，
工具调用节点必然落在过程区；消息正文只经 markdown 渲染（文本 + 图片 + 链接），没有可注册的组件
渲染器。服务端出图是在这些约束下能同时满足"图进回答"与"插件留在 preset"的做法。

### 宿主源码调查记录（2026-10-09）

调查对象为本机已安装的 @deepseek-ai/dsh-* 0.2.0-rc.2 的发布 JavaScript 和类型声明，
位于 `~/.cache/pnpm/dlx/49046643a18cfbba449d8cec1aec7ada/muz9qg8p-1mq1/node_modules/.pnpm/`。
本次仅阅读文件，未运行宿主、构建、测试或探针。以下结论是代码层面的能力确认，不是当前 profile 的运行验收。
标注为“后续参考”的历史卡片与会话持久化调查不构成本期恢复设计或验收要求。

| 核对项 | 源码依据（各包根目录下） | 结论 |
|---|---|---|
| 工具输出分离 | dsh-tools `lib/index.js:3539` 的 createSuccessResult | execute 值分别投影为 render 的 content 和 presentationMeta 的 meta；原始 value 本身不随标准工具结果事件持久化 |
| 结果提交 | dsh-agent-loop `lib/index.js:691` 的 appendToolResult | 工具消息只带 content/isError，meta 在 tool/result.data 的独立字段保存；tool/call 保存原参数 |
| 模型上下文 | dsh-session `lib/index.js:224`、`lib/index.js:1554`；dsh-agent-loop `lib/index.js:1262` | deriveMessages 对工具结果只取 data.message，构造模型请求时采用这些消息，未混入 meta |
| 历史卡片（后续参考） | dsh-client-ui-chat `lib/client.js:9555` 的 rootResult | 由历史 tool/call 与 tool/result 重建 call.argsRaw、content、meta；窗口无调用头时 call 为 null |
| 自定义工具视图 | dsh-client-ui-tool `lib/types/client/contract/slots.d.ts`、`lib/client.js:1818` | tool.call.toolview 按任意工具名注册，props 有 cwd/callId/block/inspect；call 为 null 时分派名为空 |
| 文件读取 | dsh-api-workspace-files `lib/index.js:400`、`lib/index.js:425`、`lib/typert.remote-client.d.ts` | workspaceFiles.read/readBytes 接收会话 ID 和相对路径；会话头来自 live session 或持久化 stat，按 cwd 解析 |
| 文件规模 | dsh-api-workspace-files `lib/index.js:380`、`lib/index.js:535` | 默认文本页 5000 行、2 MiB，全文件字节读取 32 MiB；达到部署边界需处理错误或分段读取，不能假定 100 行一定小于字节上限 |
| 会话持久化（后续参考） | dsh-session-persistence-jsonl `lib/index.js:406`、`lib/index.js:954`；dsh-session-persistence `lib/index.js:242` | session/event 路由到事件写入，保存事件 JSON；append 为后台保存，flush 是持久性屏障，崩溃恢复只保证已持久化前缀 |
| 客户端加载 | dsh-client-modules `lib/index.js:701`、`lib/index.js:833`、`lib/index.js:858` | 扫描 `ctx.loader.entries()`；**实测只有主 loader 树里的条目会被扫到**——preset 内的插件由独立的 PresetTree 装配，扫不到（见「部署选择」） |

（客户端产物那条路线已放弃：它要求声明 `dsh.client.platform=web`、导出 `./client`、apply 声明
`inject: ['slots']`，并采用宿主模块加载器的惰性工厂格式——这些机制本身成立、也有已发布插件作为依据，
但只对挂在 profile 顶层的插件有效，见「部署选择」。）

**运行验收（2026-10-09，host 0.2.0-rc.2）**：图表在真实宿主里跑通——`oks_chart` 把图画成 SVG 落进
工作区，agent 把回执给的 `![标题](相对路径)` 放进回答后，**图出现在回答正文**（绝对与相对路径都试过）。
更早的一次验收（client-half 探针）确认过：toolview 能读到 `phase` / `callId` / 配对调用的原始参数
（`block.call.argsRaw`），`presentationMeta` 与 `render` 的内容分别到达、meta 不进模型上下文。

**部署选择（实测后修订两次，最终回到 preset）**：本包**写在一个 agent preset 的 plugins 里**，
profile 顶层不需要它；专用 profile 仍用于承载该 preset 与会话的默认作用域（persona 与少量辅助工具）。

第一次修订曾把本包提到 profile 顶层，理由是 client 半边：preset 内的插件由
`dsh-agent-preset-registry` 的 `PresetTree` 装配（`mountPreset` 里 `new PresetTree(ctx)`，构造时把
owner entry 的 subtree/subgroup 复原），这些条目不在主 loader 的 `entries()` 里，而
`dsh-client-modules` 只扫描 `ctx.loader.entries()`——实测放 profile 顶层时 client 模块数 64 → 65
（含 `@local/dsh-oks`），放 preset 里始终是 64。于是 client 半边要生效，就只能挂顶层。

第二次修订（也就是现在）放弃 client 半边：改由服务端出 SVG、图经回答正文呈现。既然不再需要
client 半边，"挂顶层"的唯一理由随之消失，本包回到 preset 作用域内——profile 顶层保持干净。
若宿主将来让 client 扫描覆盖 preset 树，交互式图表可以重新成为选项。

### 上游服务依赖（已合入，快照接入待完成）

当前 `oks_check_intent` 调用 WASM 的 `<domain>/transform`，服务完成 Intent 校验与 SQL 生成，插件负责批次包装、诊断呈现和隐藏查询文本。
上游需求 [lab-ontology #59](https://github.com/hh9527/lab-ontology/issues/59) 已关闭，实现经 [PR #60](https://github.com/hh9527/lab-ontology/pull/60) 合入 main，提交为 `369ee1c`。只读源码调查确认，Graph、GraphPair、GraphUnion 支持可选顶层 limit：省略或 null 保持原查询及 bindings，其他值必须为 1 至 9223372036854775807 的整数；内部操作数不要求声明该字段。相对于最初的服务层必填方案，必填要求移至消费插件，以保持服务向后兼容。
lowering 在业务查询构造后将 limit 加入 bindings，并在 QueryAst 的独立 result_limit 字段记录最终结果上限。SQLite 与 PostgreSQL 渲染器将其用于最终结果限行；与已有业务最终 take 组合时取较小值，内部业务限制仍保留原有语义。该路径没有额外固定的 100 行截断，100 上限仍应由插件实施。
插件应直接检查每个 Intent 的顶层 limit，要求 agent 显式提供 1 至 100 的整数。上游评估适配器采用自动覆盖为 100 的策略，本 RFC 的插件应采用显式校验策略。
上游报告已完成 117 组 SQLite/PostgreSQL 实际执行验收及最终 WASM 快照集成验证，并生成本地 `icloud-source-v21` 模型快照，尚未部署到外部服务；这些是上游报告，本次调查仅阅读源码与报告，未运行验收。插件消费对应快照后的兼容性与结果限行验收仍需完成。

## 缺点与代价

- 查询结果的持有、引用与读取会引入生命周期和资源管理问题。
- 每次成功查询保存一个文件，重复查询与 Intent 迭代会持续累积磁盘占用；本期不设计文件清理能力。
- agent 给出数据结论时可能需要额外读取，增加调用步骤。
- 对话图表需要宿主客户端接入与可见效果验收。

## 理由与备选方案

统一绘图接口保留自主填写的灵活性，并通过 src 路径让查询结果直接参与渲染。
两条路径在工具内明确区分，系统来源标识依据实际输入确定。

## 与 issue #1 的关系

#1 提供了立项目标、呈现设想和宿主接入线索。本次讨论进一步明确了统一绘图接口的两条数据路径、默认上下文隔离和来源标识。
issue 中的首期图元、挂载时重新查询、`ui` 放在 Intent 上、`presentationMeta` 和客户端部署方式，均需要结合本 RFC 的目标重新核对。
这些技术选择尚未作为本 RFC 的确定规格。

## 未决问题

- 核对单个 Intent 与服务生成查询的基数；初稿按每个 Intent 一个查询设计，契约不符时调整。
- 核对服务顶层 limit 的支持及生成查询的语义，验证返回行数遵守限制。
- 核对服务是否可能在 Intent 的 limit 之内再截断结果；若存在额外截断，需要重新评估上述事实与判断分工，并调整结果契约。
- 图表本身的可见效果（工具卡里的图表渲染）留待 oks_chart 实现后验收；render/meta 隔离、来源记录与调用参数的可读性已由最小视图验收确认（见「部署选择」）。
- 确定当前会话内原查询 callId 关联与跳转方式；跨历史卡片的跳转留待后续。
- 确认当前 profile 的客户端加载，并验证文件 RPC 的依赖、大小边界和错误处理。
  （已定：客户端加载按「部署选择」一节；图表渲染改由呈现记录携带数据、不走文件 RPC；
  agent 取数走 `oks_jaq_result`，也不走文件 RPC。）
- 验证绘图组件选择、依赖与构建方式，以及工具注册的作用域。
- 实施前确认本节设计初稿的接口与边界，结合调查结果修订。

## 调查计划

- 核对宿主区分用户可见产物与模型上下文的能力。
- 核对对话流的图表挂载机制、客户端加载与插件部署方式。
- 调查查询结果持有、引用及 agent 按需读取的通道。
- 调查独立生成图表的入口。
- 复核 #1 中记录的宿主技术假设与实测结论。

## 验收与后续方向

### 落地时的文档更新

- `README.md`：更新工具清单与调用示例，说明命名 Intent、先校验取得 key 再查询、顶层 limit、结果文件与 dataSrc、按需读取和统一绘图接口；同步工作区写入与产物保留约定。
- `src/skill.md`：更新 agent 的查询流程，说明 key 原样传递、数据默认通过文件引用、按需读取后形成结论，以及 src/data 两条绘图路径的来源标识；补充行数达到 Intent 的 limit 时如何判断和表述结论范围。
- `src/tools.ts` 中的工具描述与参数说明：同步校验和查询契约，以及读取和绘图接口，准确描述模型可见回执和错误行为。
- `package.json`、`locale/zh.json`、`locale/en.json`：同步插件能力介绍、工具数量和结果保存行为；客户端可见文案按实际接入方式补充来源、空结果与文件错误提示。
- 相关源码注释与 `smoke.ts` 的测试说明：同步工作区文件写入、完整结果保存、limit 校验、宿主按需读取和图表呈现的实际行为。

上述产品文档按落地后的当前事实直接描述；本 RFC 和提交说明保留变更理由与演进过程。

### 验收

设计初稿拟采用以下验收场景：

- 混合成功、拒绝和执行失败的批次按名字报告，成功项各自保存文件，失败项无 dataSrc。
- 修改 Intent 后复用原 key 被拒绝；调整对象字段顺序不改变 key。
- 保存成功的模型可见结果含结构回执，数据行仅在主动读取时出现。
- 插件拒绝缺失、null 或不符合 1 至 100 整数范围的 limit；服务兼容省略/null，拒绝其他语义非法值，并将合法正整数落实到 SQL + bindings 的最终结果限行。
- 技能与查询工具描述明确 rowCount 和 limit 的判断分工，引导 agent 在达到上限时限定结论；服务额外截断的调查有明确结论，结果契约与其一致。
- 空结果可保存，成功结果完整保存并可用 `oks_jaq_result` 取数，结果文件包含原始 Intent 与结果描述。
- 文件名符合约定，重名不覆盖，路径越界和无效前缀得到明确错误。
- 查询结果图表与自主填写图表都能出图：SVG 落进 `.data/`，回执给出可粘进回答的 markdown 行，
  来源标识由输入路径固定。
- `oks_chart` 要求 src 与 data 恰好提供一个；空数组有效（画一张空图）；非法图表名被拒。
- `bar` 与 `line` 的画法见「绘图接口与规格」；要看明细表，由 agent 在回答里写 markdown 表格。
- 本包写在 agent preset 的 plugins 里即可生效（没有 client 半边）；查询工具保持该 preset 的作用域。
- 产物保持自包含：`dist/index.mjs` 单独放进空目录仍能加载（d3 已打进产物）。
- 图表规格错误、空值、时间轴与重复坐标符合上述约定。

当前草稿的验收是准确记录已确认方向，并将建议与未决技术选择明确标为待定。
后续图元扩展、交互与导出等方向，随讨论补充。
