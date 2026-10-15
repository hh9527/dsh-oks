# dsh-oks

把**某个领域的知识服务（OKS）**接进 DSH，成为十七个原生工具 + 三个辅助工具 — 用于在 Harness Web 里
**亲手体验**「业务问句 → 实际查询结果」这条链路。查询在**只读**连接上执行；命中的结果写进工作区
`.oks/data/` 下的结果文件，**默认不进模型上下文**，要看形状或取数时用 `jq_transform` 在它上面做加工、
要留作下一步输入时用 `jq_transform_into` 物化成新的封装数据。

它是一项 **DSH 能力扩展，不是某个 OKS 的包装**：插件本身不认识任何模型。开放哪个模型、模型在哪、
查哪份数据，一律由**会话所在工作区**根目录的 `oks.json` 声明，所以同一份插件、同一行配置
可以同时服务任意多个工作区。

```jsonc
// <workspace>/oks.json   —— 领域名、模型路径、数据文件都由工作区自己给
{
  "version": 1,
  "domain": "<领域名>",
  "model": "<相对 oks.json 的 .wasm 路径>",
  "dataFile": "<相对 oks.json 的 .sqlite 路径>"   // 省略 = 不能查询，只能校验
}
```

`model` 与 `dataFile` 都**相对 `oks.json` 所在目录**解析（绝对路径原样使用）。
没有 `oks.json` 的工作区会**明确报错**（用错模型比报错贵）。

## 安装形态与迭代时的一个坑

插件在 profile 里是一个 **`link:` 依赖**（`node_modules/@local/dsh-oks` 是指向本目录的符号链接）。
它**只有 node 半边**（工具），所以**挂在 preset 里就行**：工具面只在该 preset 的作用域内生效，
profile 顶层不必多一行。

（这里曾评估过客户端半边——图表在浏览器里画成交互组件。但 `dsh-client-modules` 只扫描主 loader 的
`entries()`，而 preset 内的插件由 `dsh-agent-preset-registry` 用独立的 `PresetTree` 装配，写在 preset
里的 client 半边永远不会加载；要它生效只能把插件挂到 profile 顶层、污染所有会话。所以改成
**服务端把图画成 SVG**：图落进工作区、由 agent 引用进回答，插件则留在 preset 里。细节与实测见
[`rfc/0001`](../../rfc/0001-conversation-charts.md)。）

Node 按 URL 缓存 ESM 模块，所以：

- 改 `src/` 下的源码后要重新 `pnpm run build`（产物是自包含的 `lib/index.mjs`，含
  `src/skill.md`、`src/va-prompt-tpl.md` 两份构建期内联的提示词）；改完要**重启 profile**
  才加载新的模块代（`link:` 的好处是**不必重新安装**，重启即可；若用 `file:`，pnpm 会硬链接成拷贝，
  改源码不再生效）；
- 改 profile 的 `cordis.patch.yml` 只会让 profile 重读**配置**（用户补丁层是热重载的）。

## 提供的能力

| 工具 | 输入 | 作用 |
| --- | --- | --- |
| `oks_search` | `{query?, kind?, dataset?, skip?}` | 按**名词/说法**在词汇表里找：回 `kind`、`name`、归属（字段名用词汇表声明的 `owner`）、命中位置（`name`/`alias`/`doc`）与分数，**不回 key**。没有 `limit`——页大小由插件按字节定，`more` 报出还剩多少条。0 命中时给出可用的 kind 与 dataset |
| `oks_references` | `{key, link?, kind?, skip?}` | 按 key **反向**找引用它的节点：回引用种类与引用方的 key。用来回答"哪个维度用了这套值域""哪个数据集声明了这个度量" |
| `oks_info` | `{key:"<不透明字符串>"}` | 按 key 读一个知识节点（每次都向服务要，插件不缓存节点）。**入口是 `key:"index"`**（唯一可以凭记忆给出的 key）；之后按返回内容给出的 key 逐级继续——怎么继续、到哪一层，节点自己的说明会回答。key 一律原样传递，**不要构造、切分或解码** |
| `oks_check_intent` | `{intents:{<名>:Intent}}` | **只校验**：按名字回结论，通过的项给出 `key`（该项 Intent 的标识，提交查询时原样带回）。每个 Intent 必须带顶层 `limit`（1..100）：它是 Intent 的一部分、也参与哈希。不回查询语句，也不碰数据——迭代 Intent 形状时用它 |
| `oks_query` | `{intents:{<名>:{intent,key}}}` | 核 key 后**只读执行**：每个成功项写进 `<工作区>/.oks/data/<时间>-<名>-<内容哈希>.qres.json`，回执只给 `dataSrc`、列信息与行数——**数据行与语句都不进这段对话**（数据按需读回，语句在执行记录与呈现记录里）；失败项按 `key_mismatch` / `rejected` / `query_error` / `save_error` 分别报告 |
| `jq_transform` | `{inputs?, pick?, byFile?}` | 在具名输入上做**加工**（只看，不落盘）：`inputs` 是「名字 → 数据来源」——条目给 `"<src>"` 就是那份数据本身，给 `{"src": "<src>", "root": ".data.rows"}` 就指明要其中的哪一段（`src` 原样取自前面的回执、限定在工作区可读目录内：`.oks/data/`、`.oks/figures/`、`artifacts/` 都收，图/表/报告的材料块**就地**解析，不落任何中间文件）；程序的作用范围是一个**对象**，键就是那些名字。**代码一律在文件里**：程序写进 `.work/` 下的 `.jq`（`work_write`），参数 `byFile` 只给文件名——jq 语法于是永远不与调用的 JSON 相邻（见下文那条硬规则）；不写程序时结果就是那个「名字 → 那一段」的对象（`{"q": <那一份数据>}`，回执标出等价的恒等程序），要用裸名字读一份数据就写 `pick: ".q"`；
  `root` 与 `pick` 是**同一套语法**（jq 点路径：不带引号、只走对象字段与数组下标），`byFile` 是另一种（`.work/` 下的文件名），`pick` 与 `byFile` 二选一。`root` 指出每份输入交出哪一段：默认 `.data`（那份数据本身）——查询结果是 `{rows, columns}`（写 `.q.rows[] \| select(.count > 100)`），加工结果是它产出的值本身，图与表是 `{rows, spec}`，报告是 `{assets, items, structure}`（`structure` 是缩水后的结构区）；`.origin` 是来源链 `{root, nodes}`，`.meta` 是自述，`.` 是整份 `{meta, origin, data}`，更深如 `.data.items` 也收。只认点路径，路径不存在时报出该层可用的键。不给 `inputs` 时结果就是 `{}`（常量走程序文件）。结果是一个**值流**：一个输出就是那个值，多个输出是值的数组，零输出是空数组，回执里的 `outputs` 是个数。回执还给出每份输入（含它用的 `root`）与结果的形状，以及完整的值（超上限就报错，绝不截断） |
| `create_data` | `{name, motivation, data}` | 把 **agent 自己给的数据**落成一份封装（`<工作区>/.oks/data/<时间>-<name>-<内容哈希>.def.json`），于是它可以像查询结果一样被引用：当 `jq_transform` 的具名输入、当 `oks_chart` 的 `src`。`name` 是落点名（`0-9`、`_`、`a-z`，同名不覆盖），`motivation` **必填**——来源链里这个节点只记着"这份数据是给定的"与这句话，给定数据没有别的解释。`data` 是任意 JSON，行对象数组才是图能画的形状。数据文件里查得到的默认走 `oks_query` / `jq_transform_into`；辅助支撑数据、生产模拟与演示数据走 `create_data`——模拟数据用在报表里同样有效 |
| `jq_transform_into` | `{name, inputs?, pick?, byFile?, motivation?}` | 同一套求值，**结果物化**成 `<工作区>/.oks/data/<时间>-<name>-<内容哈希>.tr.json`（`name` 是落点名：`0-9`、`_`、`a-z`，同名不覆盖）——回执给 `dataSrc`、形状、输出个数与**完整来源链**（易读视图：输入在前、本次操作在最后），不重复值。`inputs` / `root` / `pick` / `byFile` 的语义与 `jq_transform` 完全一致。来源链由工具组装：本次的程序正文（不写程序时记 `pick` 那段投影）、`motivation`、输出个数与「哪个名字用了哪份输入的根节点」，加上各输入的全部上游；**上游的 `data` 不跟过来**。求值到上限被截断时明确失败、不落盘（残缺的结果不进链） |
| `oks_chart` | `{spec, src, nodesSrc?, name?, note?}` | 把图画成 **SVG 存进工作区**：数据**只从 `src` 来**——那是前面回执里给的一份封装（`oks_query` 的查询结果、`jq_transform_into` 的加工结果、`create_data` 的输入数据），行不内联进调用。图不再画"来源标识"这类标签（标签说不清：同一份数据经过几层加工就归不到一个入口了），要说来源就看随图带走的来源链。图把**自己用的那份材料**（画出来的行、实际绘图规格、完整来源链）嵌在 SVG 里，所以工作区被回收之后它仍旧说得清这些数字从哪来。十三种图元都用 `x`（类别/横轴列）与 `value`（数值列）作底（`histogram` 只给 `value`；`sankey` 给 `x` 与 `series`，`value` 可选）：**关系图** `graph`（两张表：`src` 边表 `x`/`series`/`value?`/`label?`，`nodesSrc` 节点表 `id`/`label?`/`category?`/`status?`/`depth?`/`x?,y?`；**按 `depth` 分层**、节点按 `category` 着色、`status: 'focus'` 强调其余退灰）；**桑基图** `sankey`（行是边：`x` 起点、`series` 终点、`value` 权重；分层由数据自己算，同一对起终点累加合并）；**仪表盘** `gauge`（每行一张小仪表，值按 0–100 的比率读，越界报错，`marks` 画阈值刻度）；**分组柱** `column`，可选 `series`（组内分组）；**横条** `bar`（可选 `series`：横向的分组条）；**饼图** `pie`（只取正数）；**多序列折线** `line`、**面积图** `area`（可选 `series`，`xType` 不填按数据推断）；**散点** `scatter`（可选 `size` 当第三维）；**直方图** `histogram`（可选 `bins`）；**箱线图** `box`；**矩阵** `heatmap` 与**雷达** `radar`（两者都要 `series`：矩阵的纵轴类别 / 雷达的被比较对象）。要看明细表，直接在回答里写 markdown 表格。回执给出一行 `![标题](路径)`，agent 把它放进回答，图就显示在那里 |
| `oks_view` | `{spec:{kind,src,title?,columns?}, name?, note?}` | 把数据变成**展示件**并落成 markdown 文件，先支持表格（`kind:"table"`）：`src` 是要展示的那份封装（行对象数组），`columns` 选列与顺序，`title` 是表注；数字列右对齐。回执给两份——`![表注](.oks/figures/<文件>.table.md)`（**绑进报告正文**：`inputs` 里的一项 + `<figure data-oks-ref>`）与可直接粘进回答的 markdown 表本体（表太大时不给本体，只给引用）。文件是 markdown，打开就是张表；来源链、最终数据与展示规格藏在文件头的一行 HTML 注释里，报表内联时读它 |
| `oks_report` | `{spec, name?, note?}` | 把叙述与图组织成一份**自足的 HTML 报告**存进工作区：`spec` 给 `title`、可选 `subtitle`、一段 **XHTML 正文文件** `articleFile`（写在 `.work/` 下，习惯叫 `article.xhtml`）与 `inputs`。正文是**严格 XML 的子集**——单个 `<article>` 根，元素限定在 `section`/`h1`–`h3`/`p`/`div`/`span`/`figure`/`figcaption`/`table` 系列/`ul`/`ol`/`li`/`blockquote`/`pre`/`code`/`strong`/`em`/`a`/`br`/`hr`，属性限定在 `id`/`class`/`title`/`lang` 与 `data-oks-ref`/`data-oks-pick`/`data-oks-shrink`（外加 `href`、`colspan`/`rowspan`/`scope`），空元素写自闭合（`<br />`）；章节的**意图**写成 XML 注释（不进版面，留给复用）。**数据只靠引用进来**：图与表写 `<figure data-oks-ref="key"><figcaption>图注</figcaption></figure>`，数值写 `<span data-oks-ref="key" data-oks-pick=".rowCount"></span>`；`inputs` 把每个 key 指到回执给的材料路径（`{"key": {"src": "…", "root": ".data"}}`，`root` 省略即 `.data`）——引用了没声明、声明了没引用都明确失败。**报告里出现的所有数字都必须从投影与计算中得到**（用 jq 现算成标量 → `inputs` 绑定 → `span` 的 `ref` + `pick` 引用；正文里不写手算数字，它没有来源链、读的人无法核对）；文字里的数字用 `<span data-oks-lit="">…</span>` 声明为文字（只能写在 `span` 上、要带空值，报告正文是严格 XML；标识符与引用编号里的数字不算，如 `P95`、`A.1.2.3`、`#123`），自己的解读用 `data-oks-shrink` 标记：把报告当输入读时它被清空，留下组织方式、意图与全部底层材料，成为可复用的样本。图注编号（图 1/表 1…）按正文出现顺序由系统给。每个引用项的**最终数据、完整来源链与实际执行的 jq 源码**都并进页面里的元数据区（`<script type="application/json" id="oks-metadata">` = `{ origin, assets, items }`：`origin` 是共享祖先只存一份的节点表 + 一个"组装这份报告"的根节点，节点用 `asset://<key>` 引用 `assets` 里的源码，`items` 是 key → 该项选出的数据），于是读报告用 `jq_transform` 就够（拿到 `{ assets, items, structure }`；**读回是缩水视角**：`structure` 里 `data-oks-ref` 的容器只有省略标记 `<!-- omitted -->`、`shrink` 段落已清空，核对数值请读 `items`；其中 `structure` 是**缩水后**的结构区）。**取不到材料时整份失败**并说清是哪一项。图以**内联 SVG** 嵌在页面里，单文件可以发给任何人打开。报告**不出现在回答正文**：回执给出一行 markdown 链接，agent 用 `present` 交付，用户点开在右侧栏阅读 |
| `oks_report_check` | `{src}` | 落盘前**校一遍正文**：返回 `{valid, errors, refs, commentCount}`，每条错误带 `code`、行列与元素名（良构、元素与属性白名单、空元素必须自闭合、`id` 报告内唯一、`data-oks-ref`/`data-oks-pick` 规则、链接与表格属性取值）。不落盘、不记账 |
| `work_write` | `{file_path, content}` | 在 `.work/` 下**创建或覆盖**一份文本文件（父目录按需建）：写 jq 程序的地方，之后由 `byFile` 按文件名引用、用 `work_edit` 增量改。越界与超限（256 KB）一律拒绝 |
| `work_read` | `{file_path, offset?, limit?}` | 读 `.work/` 下的一份文本文件（带行号，可 `offset`/`limit` 翻页）；`path: "."` 列出目录里有哪些文件与大小 |
| `work_edit` | `{file_path, old_string, new_string, replace_all?}` | 字面替换改一份 `.work/` 下的文件：`old` 必须原样出现且唯一（否则要 `replaceAll: true`），报错时说清是没找到还是出现了几次 |
| `work_delete` | `{file_path}` | 删掉 `.work/` 下的**一份文件**（目录要先清空里面的文件）：不用的程序就这么退场。删程序不损溯源——来源链记的是程序正文，丢的只是"能不能再跑一遍"。回执给删了哪个、代码区还剩几个文件 |
| `oks_artifacts` | `{}` | 列出本工作区的**图与报告**（最新在前）：标题、类别、时间、是否保留。查询结果是内部制品、不出现。用它回答"产出过什么"，或在保留别的东西之前先找到它的路径 |
| `collect` | `{ttl?}` | 清掉 `.oks/` 下的**内部材料**（查询结果、加工结果、图、表）：超过窗口的删掉，**不是我们命名的文件不动**，`artifacts/` 里的报表也不碰（要留就保留，要删走页签里的 `✕`）。`ttl` 省略时用工作区配置的 manual 窗口；给了就按它（`"15s"` / `"30m"` / `"2h"` / `"3d"` 或分钟数，下限 5 秒）。回执给清了几份、释放多少、还剩几份——清得激进时，之前回执里的 `dataSrc` 就失效了，需要重新取数 |
| `va_ask` | `{query}` | 咨询本会话的**词汇助手**：给一个说法（词/短语/一句话，中英不限），拿回词表里等价或相近的说法——回答是**一行一个字符串**，每个字符串都是词表原文。助手是插件自己建、自己收的**顶层 agent**（preset `oks`、与调用方同一工作区、共用同一份进程内索引），平时归档，被咨询时临时恢复。它给的是线索，检索口径仍由 `oks_search` / `oks_info` 决定。**整份词表由插件渲染成助手系统提示词里的一个 section**（模板 + 全部词条），助手一个工具都没有。装配**不发任何消息**；每个说法才是一次回合，拿到回答后插件把表面上的节点全部收进一个固定文本的标记，所以助手每次只看到「系统提示词里的词表 + 一个标记 + 当前这个说法」（会话日志保持 append-only，标记节点用 `sourceEventSeqs` 记下遮蔽范围）|
| `time_now` | `{timeZone?}` | 当前时刻的**各种标准表示**（epoch 毫秒/秒、UTC 文本、RFC 3339、带偏移的本地文本、日期、ISO 周）+ 实际用的时区。服务不读时钟，所以相对时间必须在这里换成绝对边界 |
| `time_calc` | `{base?, timeZone?, operations?}` | 日历代数：`add`（year/quarter/month/week/day/hour/minute/second）、`floor`/`ceil` 到日历边界（周默认周一起）、`convert` 换时区。日/周保持**本地墙钟**（跨 DST 的一天可能不是 24 小时），月/季/年**钳制**到当月最后一天。区间半开 `[start, end)` |

`time_now` / `time_calc` **与模型无关、也不解释任何领域格式**：它们只做标准表示与日历运算，具体要哪一种
形式由知识节点自己声明；`va_ask` 只管怎么问词汇助手，也不碰词汇。这三个工具都**不需要工作区**
（没有 `oks.json` 也能用）。

### 词汇表与引用图是怎么来的

`oks_search` 与 `oks_references` 用的是插件内存里的一份词汇表与反向引用索引，
它按服务声明的**发现契约**建立：`<domain>/discovery` 声明 revision、入口 roots、每类 key 的
key 模式，以及 `vocabulary`（哪些 kind 进词汇表、每类词条的归属字段与必须非空的字段）；
再沿 `oks_info` 返回的引用图走完整个图，然后在本地派生。派生结果与服务的发布物一致
（同一份产物：节点数、词条数、引用数逐项相同）。

- **只在第一次用到检索时同步建立**（一次全图遍历，实测 2,769 节点约 20 秒），之后按产物的
  模型内容的 sha256 复用——同一个模型被多个工作区、多个会话声明时只派生一次；
- **占用的是插件内存，不是模型上下文**：词汇表与引用图都不进对话；
- **索引里只有词汇与引用边**：节点内容不保留——读节点始终由 `oks_info` 透传给服务，插件不缓存它；
- **进不进词汇表由服务声明**：`vocabulary` 列出哪些 kind 是词条，每条还声明 `owner`
  （词条的归属字段，既是 detail 字段名也是 key 模式里的占位符名，输出行里就用这个名字）
  与 `require`（该 detail 字段必须存在且非空，例如排除没有存储布局的基础类型）；
  有声明的 key 模式但不在 `vocabulary` 里的 kind 不是词条，它的 key 从节点自身的引用里得到；
- 契约对不上时**直接报错**（`ok` 不是发现契约、缺少 roots 或 vocabulary、引用无法解析、
  未知的引用种类），不静默降级。

`oks_search` 只负责给出"往哪走"：key 由 agent 按 `index` 里声明的 key 模式自己拼，节点说明仍由
`oks_info` 按 key 读——所以地址是单一来源，内容不重复。同一份索引还负责把整份词汇**一次性
渲染**成词汇助手系统提示词里的那个 section（不筛不排，按 key 升序、一行一条 `<key> <name> <aliases> <doc>`，字段 json 风格）。

### 校验与查询为什么分开

- **校验便宜且不碰数据**：`oks_check_intent` 只问"这批 Intent 服务收不收"，
  所以它可以在没有 `dataFile` 的工作区里用，也不会因为数据文件坏了而失败；
  通过的项还会拿到 `key`——提交查询时原样带回，工具重算哈希核对，于是"执行的必须是校验过的那一项"。
- **查询才给出语句与结果**：`oks_query` 的结果里带 SQL 与 bindings（**已执行事实的来源**），
  并把命中的数据行写进结果文件；校验路径上没有任何语句，所以"只想看看会生成什么"必须真的跑一次查询。

### 查询是怎么跑的

- **只读**：连接以 `readOnly` 打开；此外只放行 `SELECT` / `WITH` 开头的语句（双保险）。
  Node 自带的 `node:sqlite` 直接读 SQLite 文件，插件仍然零依赖。
- **在 worker 里跑**：`node:sqlite` 是**同步 API**，一条慢查询会卡住宿主线程（GUI 一起卡）；
  放进 worker 之后，到点可以 `terminate()`。
- **行数由 Intent 的 `limit` 决定**：服务把它落到 SQL 的最终限行，插件完整保存这次 Intent 的结果
  （执行器只用同一个数字做保险，不再另加 `queryMaxRows` 截断）。数据行都进了结果文件，所以
  模型可见文本天然远在宿主 tool-result pruner 的阈值（8192 字符）之下。
- **结果落盘**：每个成功项写一个 JSON 文件到 `<工作区>/.oks/data/`，文件名
  `<时间>-<名>-<内容哈希>.qres.json`（`<时间>` 是这次保存的 UTC 时刻、到秒；
  `<内容哈希>` 是文件内容 sha256 的前 8 位）。独占创建，同名的只可能是同一份内容
  （哈希相同即去重，内容不同则报错）；写失败会清掉不完整的文件。加工结果同一套规则，
  落点类别是 `.tr.json`；`create_data` 给的输入数据写 `.def.json`。按需取数由 `jq_transform` 负责——每个 `dataSrc` 限定在
  可读目录（`.oks/data/`、`.oks/figures/`、`artifacts/`）内，并检查真实路径不越界。
- **代码区 `.work/`**：jq 程序放在 `<工作区>/.work/`，参数 `byFile` 给文件名（`byFile: "分析.jq"`）；不写程序时结果就是「名字 → 那一段」的对象，再用 `pick: ".名字"` 把它取回来；
  写、读、改、删由本插件自己的四个工具负责——`work_write` / `work_read` / `work_edit` / `work_delete`，**只作用在
  `.work/` 内**。为什么不用宿主的 `read` / `write` / `edit`：那三个工具的沙箱根是**整个工作区**
  （`dsh-fs-sandbox` 只按 workspace root 判定），给不出"只能 `.work/`"；而"给模型的能力边界写在
  执行层、不写在提示词里"是这个项目一贯的做法。三个工具的形状：`work_write {file_path, content}`
  （父目录按需创建、已存在就覆盖）、`work_read {file_path, offset?, limit?}`（按行给、可翻页；
  `file_path: "."` 列出目录）、`work_edit {file_path, old_string, new_string, replace_all?}`
  （字面替换，`old_string` 必须唯一或显式 `replace_all`）。越界（`..`、绝对路径、符号链接绕出）一律拒绝；单份文件上限 256 KB，
  其中能被 `byFile` 引用的程序上限 64 KB。
  来源链记**程序正文**另附 `snipFile`，所以 `.work/` 被清掉之后链照样解释得了那次执行。
  **报错自足**：程序按文件交给求值器（`jaq -f`，工作区相对路径），所以语法错里是**文件名 + 行号 +
  出错那一行**；失败回执还会附上**这次各输入交出的形状**（名字、来源、取的那一段、形状）——
  照着报错改一次就行，不必先写一个探针程序去问形状。

  **参数名与宿主那套一致**（`file_path` / `content` / `old_string` / `new_string` / `replace_all`），
  所以模型已经掌握的那套形状照样能用；只有工具名不同——而名字恰好承载"作用域只在 `.work/`"这条信息。
  三者只作用在 `.work/` 内，越界（`..`、绝对路径、符号链接绕出）在**执行层**被拒。

  **试过但走不通的两条路**（记在这里，免得再试一遍）：
  - *策略插件*（包一层 fs provider，让原生 `read`/`write`/`edit` 绑到围栏上）：Cordis 的服务语义不允许
    子作用域 `provide` 一个祖先已提供的服务名（实测抛 `service "fs" has been registered at <root>`），
    而 `isolate` 会把外层 provider 切断——组里的 `tool-fs` 于是永远等一个没人提供的 `fs`
    （新建会话报 `agent-preset/invalid: tool-fs: waiting for fs`）。真要走这条，得自己实现一整套
    provider（`resolve`/`stat`/`writeText`/`editText`/`listDir`/`watch`…），代价与收益不成比例。
  - *hook*（`PreToolUse` 匹配这三个工具名，路径越界就 deny）：协议是现成的，但 `runHook` 走
    `bash.execute`——**每次匹配到的事件起一个进程、还要同步等**，对每轮几十次文件操作不划算。
- **读产物是就地的（读数据只有一条路）**：`jq_transform` 的具名输入直接吃**任何产物**——数据封装、图、
  表、报告——图与表的材料块、报告的骨架与展示数据都在读的那一刻从文件里解析出来，每个条目再用它自己的
  `root` 选一段（`.data` / `.origin` / `.meta` / `.`）。于是既没有中间文件要维护，也没有专门的读接口：
  报告的结构读 `root ".data.structure"`（缩水后）、展示项读 `".data.items"`、源码资源读 `".data.assets"`，来源链读 `root ".origin"`，
  "这一项背后的查询与那段程序"就是 `.origin.nodes` 上的一次投影。
- **硬规则：内层语言不与外层 JSON 相邻**。工具调用的参数是 JSON，而 jq 的 `{a: .b}` 与 JSON 的
  `{a: .b}` 几乎一样——实测里 13 次整轮失败（`MALFORMED_RESPONSE`）中有 3 次正是模型把 jq 的对象构造
  直接写成了 JSON 值。对照之下，`bash` / `write` / `edit` / 报告正文这些"内容在一个字符串值里"的调用
  （3200+ 次，含平均 517 个转义引号的报告正文）**一次都没坏**。所以：**凡是"内容"，一律走字符串值
  或文件引用**（`.work/*.jq`），绝不把内容的语法暴露成参数结构；给工具加参数时也照这条办。
- **文件的三段**：每份文件都是 `{ meta, origin, data }`——`meta` 回答"这是什么"（类别、名字、时刻，
  图与报告还带标题与分类），`origin` 回答"数据从哪来"，`data` 就是那份数据（jq 的默认输入）。
  形状靠结构认，**没有版本号**。各 `data` 的形态：查询结果是 `{ rows, columns }`（列名取自 SQL 元数据、
  类型按返回值观察，空结果记 unknown；行与列都是这份数据的一部分），加工结果与 `create_data` 就是产出的
  值本身（值流的输出个数记在 `origin` 的根节点上），图与表是 `{ rows, spec }`，报告是
  `{ assets, items, structure }`（`structure` 是缩水后的结构区，源码在 `assets`）。
  图与报告已经有原生自述元素（`<metadata id="dsh-oks-artifact">` / `<meta name="dsh-oks-artifact">`），
  `meta` 就写在那里（读开头几个字节就够），它们的材料块只有 `origin` 与 `data`。
- **来源链**：`origin` 是产生这份数据的操作及**完整上游来源链**——整份链以节点表写在文件里
  （`{ root, nodes }`；每次物化是一条记录——操作 + 它产出的内容——算一个节点，共享祖先只存一份，
  `inputs` 里的引用是文件内的节点 ID）。节点 ID 由记录内容算出，所以同定义、不同数据的两次执行是两个节点
  （例如同一句动机下的两次 `create_data`），而同一份封装在别的文件里被再次引用仍是同一个 ID。
  报告的 `origin` 也是**一个**：根是"组装这份报告"那个节点，`inputs` 指向各展示项的根。于是文件离开
  工作区也能说明自己的来路；读取时校验根节点与"引用在文件内闭合"，链的易读视图由 `chainLines()` 摊开。
- **空的要说清楚**：结果为空时，若数据目录里有 `manifest.json`，插件会报出数据窗口
  （`[start, endExclusive)`），提示"可能是时间落在窗口之外"。
- **留痕在宿主日志**：每次执行的语句、bindings、行数与耗时写进 `ctx.logger`——日志里有据可查。

### 加工是怎么跑的（求值器与它的能力边界）

- **求值器**：加工走系统里的 `jaq`（`spawn`，不经 shell，所以表达式里没有命令注入面）。
  两个 jq 工具共用同一套具名输入与值流语义；求值沿用查询的超时（`queryTimeoutMs`）与
  256 KiB 输出上限（到点终止并按行边界截断，绝不留下半个 JSON 值）。
  **"求值器从哪来"是实现细节，单独隔在 `src/jaq.ts` 这一层**——将来换成内嵌求值器只改这个文件。
- **能力边界（当前事实）**：jaq 自带若干与环境有关的能力，工具层**还没有**收紧——
  `now` 读墙钟、`env` / `$ENV` 读整个进程环境、`localtime` / `strftime` 受 `TZ` / `LC_ALL` 影响。
  所以"同一定义 + 同输入 → 同结果"目前**不成立**（同一引擎版本内，结果只受这些环境量影响）。
  不涉及它们的表达式是确定的：对象键按插入序、`todate` / `fromdate` 等在 UTC 上是纯的。
  `include` / `import` 在 jaq 里实际不可达（相对名不搜 cwd、绝对路径直接被拒），
  `input` / `inputs` 得到空流（stdin 只有一个文档），`input_filename` 固定是 `"<stdin>"`。
- **方向**：把这层换成**基于 jaq 背后的库自建的确定性求值器**——能力面在那里直接是白名单，
  时钟 / 环境 / 文件 / 额外输入没有对应实现。临时可做的两层（子进程环境收紧成
  `TZ=UTC` / `LC_ALL=C` / `LANG=C`，以及求值前按标识符拒掉那些名字）记在
  [issue #18](https://github.com/hh9527/dsh-oks/issues/18)，**尚未实现**。
- **不承诺跨引擎版本复现**：来源链用来解释来路（输入、动作、理由），不是复算环境；
  换求值器或换引擎版本，同一段程序的结果允许不同。

### 自带引导（技能与工具一起走）

插件**自带**一份引导技能 `oks-query`：加载时通过 `ctx.skills.register()` 注册进 runtime 层，
因此对**所有工作区**可见。

- 正文是 [`src/skill.md`](src/skill.md)、元数据与注册在 [`src/skill.ts`](src/skill.ts)（技能这个模块的两半，构建期内联进产物）；
- runtime 的 rank 是 250，所以工作区自己的 `.dsh/skills`(100) 或 `.agents/skills`(200)
  **可以覆盖**它，用户级(400/500)覆盖不了——正好是"插件给默认引导、工作区可覆盖"；
- 技能服务是**可选**依赖（用 `ctx.get` 取）：没有它时这些工具照常工作。

### 工作区

工作区是**会话属性**（会话创建时的 `cwd`，由 harness 记录在会话头里），不是进程属性；
按工作区工作的工具都在调用时从 `exec.agent.session` 取当前会话的工作区。每个工作区各有一份
惰性建立的运行环境：设置与 wasm 宿主；词汇表与引用图按**产物**持有，
执行器按**数据文件**持有，所以共享同一份产物或数据文件的工作区不会重复建立。

### 诊断

服务的诊断是**批次级的**（`ok.diagnostics: [{index, diagnostic:{severity, message, locs}}]`）——
它不提供 per-Intent 的 `valid` 字段，所以「哪个 Intent 失败」由带 `severity: "Error"`
的诊断**按 index 推导**。而且**成功的 Intent 也可能带 Warning**（例如聚合 Top-N 的分组被
隐藏身份键拆开），因此诊断一律全列，不能只在失败时读。

服务只在**整批 Intent 全部通过**时才回 `queries`。插件默认会把被拒批次中已通过的子集
单独再降一次（`retryAcceptedSubset`），所以"5 个里坏了 1 个"时，其余 4 个照样能出结果。

## 配置

插件代码里**不含任何机器路径，也不含任何模型**。模型、领域、数据文件全部来自工作区的
`oks.json`；插件行的 `config` 只是**覆盖**（优先级：`config` > `oks.json` > 默认值）：

| 键 | 含义 |
| --- | --- |
| `domain` / `model` / `dataFile` | 覆盖工作区声明（缺 `domain` 或 `model` 时报错并给出补法；缺 `dataFile` 时只有 `oks_query` 报错） |
| `requestTimeoutMs` | 默认 60000，单次服务请求的墙钟上限（到点 terminate worker，下次请求再拉起） |
| `queryTimeoutMs` | 默认 30000，单次只读查询的墙钟上限（同上，到点 terminate 执行器） |
| `queryMaxRows` | 默认 200，**执行器**取回行数的保险上限。结果行数由 Intent 顶层的 `limit`（1..100）决定，正常路径用不到这一项 |
| `retryAcceptedSubset` | 默认 true |

时区来自本次请求的上下文（用户消息上的浏览器时区，或调用参数）；工作区来自会话头的 `cwd`。
运行时取不到就报错，请把上下文或会话头带全。

```yaml
- insert:
    - id: oks
      name: '@local/dsh-oks'
      config: {}        # 模型与数据由工作区声明，这里通常什么都不用写
```

`model` 与 `dataFile` 都是**独立部署物**：换机器、换域、换工作区都不用改插件。

## 快照怎么来

```sh
cd lab-ontology
bin/telora -C <模型目录> build <模型名> --snapshot \
  --initialization-fuel 100000 --request-fuel 100000 --with-memory-limit 1024 \
  -o /path/to/model.wasm   # 这个路径相对工作区的 oks.json 填进 model
```

注意三点：

- `--snapshot` 是**必需**的：当前只支持快照产物，插件用 Node 自带的引擎
  （`node:worker_threads` + 内置 WebAssembly）直接导入它。
- `--with-memory-limit` 必须给足：缺省构建会在初始化阶段报 `growth operation limited`
  而失败。这个上限在**构建时**定死，是产物本身的一部分。
- 完整命令与构建后的发布校验见模型仓库的 `icloud_model/docs/SOURCE_REFRESH.md`。

数据侧通常是同一批产物里的 `<name>.sqlite` 与 `manifest.json`（后者记录数据窗口与
来源 revision，插件只读它、不要求它在）。数据文件由工作区的 `dataFile` 指向。

## 安装 / 卸载

- **推荐**：在 Web 的「插件」页安装本目录，或命令行
  `dsh plugin --profile web add link:<本目录>`，再把 `@local/dsh-oks` 加进
  profile `package.json` 的 `dsh.profile.bundles`（两处缺一不可）。这条路上 `add` 会把
  包升成 profile 的 bundle 层，本包自带的 `cordis.patch.yml`（一行顶层 `oks`）跟着生效。
- **只把工具面放进 preset**：`dsh.profile.bundles` 里不列本包，改在一个 preset 行
  （`@deepseek-ai/dsh-agent-preset`，`config.plugins` 里含 `"@local/dsh-oks"`）里挂载。
  此时 `oks_*` / `time_*` / `va_ask` 只属于该 preset 的作用域，其它 preset 的会话没有
  这些工具。仓库根的 `install-preset.sh` 一次配好这个形态——初始化 profile、写 `link:` 依赖、在
  该 profile 里装链接、把 preset 追加进 `cordis.patch.yml`，可重复执行，在仓库根直接跑就行：
  `./install-preset.sh`（profile 默认取 `$DSH_PROFILE`，没有就 `web`；`--profile` /
  `--dsh-home` 只作覆盖，见 `--help`）。
- 用 `link:` 而不是 `file:`：前者是符号链接（改源码重启即生效），后者会被 pnpm
  硬链接成拷贝，插件页能显示但源码改动不再生效。
- 卸载：从 `dsh.profile.bundles` 去掉包名并 `dsh plugin --profile web remove @local/dsh-oks`；
  preset 形态先从 `cordis.patch.yml` 删掉那段 `preset-oks`，再执行同一条 `remove`。

## 词汇助手（va）

`va_ask` 把"说法对不上字面"这件事交给一个**常驻词汇助手**：
插件自己建它（顶层 agent、preset `oks`、同工作区、共用同一份进程内索引）、自己把提示词
（[`src/va-prompt-tpl.md`](src/va-prompt-tpl.md)，词表插在它的 `<!-- 词表 -->` 处）与专属人设
放进助手的**系统提示词**——**装配不发任何消息**；此后每次只发一个说法，把它的回答作为
**工具结果**返回。它平时归档（分组界面不列、模型步被归档门挡住），咨询时临时恢复。
标记是收起时留下的那条**固定文本用户消息**：每次拿到回答，插件都把锚点之后的问答从
模型可见表面收进它——助手每轮只看到「系统提示词里的词汇 + 人设 + 标记 + 当前这个问题」，
而会话日志保持 append-only，标记节点用 `sourceEventSeqs` 记下遮蔽范围。

## 开发

源码在 `src/`（TypeScript），构建出**单一产物** `lib/index.mjs`（profile 里 `link:` 装的插件加载它）
——所以**改完 `src/` 必须重新构建**（`lib/` 不进 git；`pnpm install` 会经 `prepare` 自动构建一次，
`pnpm run test` 也会先构建，忘了构建不会静默用到旧产物）：

```sh
pnpm install          # tsdown + typescript（只用于开发/构建）
pnpm run typecheck    # tsc --noEmit，零报错
pnpm run build        # tsdown → lib/index.mjs（自包含）
pnpm run dev          # 同上，但 watch：改完立刻重建
pnpm run check        # typecheck + build + 冒烟
```

出图与报告都走 **echarts**：规格（业务字段与结果行）直接翻成 echarts option，再由它的 SSR 模式
（`renderer: 'svg'`）产出 SVG。整条链路是纯 JS——`lib/` 里只有一个 `index.mjs`（约 1.6 MB，
echarts 按需导入后打在里面），没有 WASM、字体或包缓存之类的旁资产。

打出去的包只含运行时需要的：`lib/` + `cordis.patch.yml` + `icon.svg` + `locale/*.json`
（`files` 就这么列的）——`src/`、`smoke.ts` 这些都不进 npm。

提示词是**普通源码模块**：`.md` 和 `.ts` 一样按功能/架构归属，不按文件类型分目录、也不单列一个
"提示词"品类。现在 `src/` 还没有按功能拆目录，所以技能的正文是 `src/skill.md`、词汇助手的提示词是
`src/va-prompt-tpl.md`（词表插在它的 `<!-- 词表 -->` 处）；将来某个功能拆成目录时，它就跟着那个功能走。
它们在构建期由 `loader` 内联成字符串常量，所以**改提示词同样要重新构建**——产物因此不需要任何
旁文件（运行时不读 `.md`）。

构建用 [tsdown](https://tsdown.dev)（rolldown 系，和 DSH 自己 node 侧包的产物一致）。Node ≥ 22
能直接跑 `.ts`，所以 `smoke.ts` 不用先构建就能跑（它自己对 `src/time.ts` 这类纯函数的单测也是直接
导入源码）；被测的插件本体则从 `lib/index.mjs` 导入——**测的就是最终制品**。

`smoke.ts` 是 JS 风格的测试脚本（自造假宿主、动态导入），**不纳入 `tsc` 检查**：要纳入需要先给它
写一套假宿主的类型（约 200 处隐式 any），那是另一件事。

## 本地冒烟测试（不安装）

```sh
cd /path/to/workspace && node /path/to/dsh-oks/packages/dsh-oks/smoke.ts   # 被测工作区 = 当前目录
cd packages/dsh-oks && OKS_WORKSPACE=/path/to/ws node smoke.ts          # 或者显式指定
```

被测工作区必须是**已经声明了 `oks.json`** 的那个目录（要跑查询还需要 `dataFile`）。

它用一个假的 cordis `ctx` 加载插件（插件行**什么都不配**，正是要验证"模型与数据只来自工作区"），
并真实调用各工具：验证工具的名字与分工、**检索层派生出的节点数 / 词条数 / 引用数与服务发布物逐项相同**、
`oks_search` 的过滤与 `skip` 翻页（不重不漏）、0 命中时的 facet、超容量时的整条截断与 `more`、
整份词汇的渲染（条数与检索出口一致、一行一条 `<key> <name> <aliases> <doc>`、doc 截到 200 字符、
任何词条都不截半条）、`oks_references` 的反向查询与未知 key 报错、
**校验路径的渲染与结构化值里都不出现任何语句**、通过项带 32 位 key 而坏项不给 key、
**查询路径真的执行并把结果落盘**（意图由服务声明的实体走出来，不是写死的；回执里没有数据行、
结果文件里有，且带原始 Intent 与列信息）、**改了 Intent 复用别的 key 会被 `key_mismatch` 拒掉**、
`queryMaxRows` 触顶时的截断说明、缺 / 坏 `dataFile` 的报错（坏的那份要在回执里写明执行失败）、
**按需取数**（表达式作用在行数组上、求值器的报错原样带回、缺 `query` 与越界 `src` 的明确报错）、
**插件只写 `artifacts/` 与 `.oks/`**（`.oks/` 里是状态库与 `data/`、`figures/` 两类内部材料）、自带技能的注册（名字合法、描述非空、正文与 `src/skill.md` 逐字一致、
正文不含任何具体领域名）、第二个工作区按 `oks.json` 解析相对路径、无 `oks.json` 与**无 `telora.snapshot` 段**
两种情况下都明确报错，以及模型请求与查询两侧 1 ms 上限下的超时强杀与复活。

测试夹具**不含任何领域知识**：实体 id 是运行时从服务里走出来的（读 `index`，按返回的 key
逐级跟随，直到拿到一个带 `detail.id` 的成员），所以模型换形状不会让测试失效——
这也正是"代码里不写形状假设"这条原则的自我验证。

检索层的用例是**数据驱动**的：搜索词与 key 都从产物自己声明的内容里取（例如拿一条真实词条
的名字去搜、用它的归属做过滤、再对它做反向引用查询），所以换一份模型也不会写死断言。

## 实现备注

- **产物自足**：直接注册原始工具定义（`ctx.tools.register()` 只校验 `output.schema`），
  查询用 Node 自带的 `node:sqlite`。代码与 echarts 全部打进 `lib/index.mjs`，没有旁资产——
  冒烟最后一段会把整个 `lib/` 搬进空目录，并在那里真画一张图，验证这一点。
- **一种渲染路径**：十种图元（`bar` / `line` / `column` / `pie` / `area` / `scatter` / `histogram` /
  `box` / `heatmap` / `radar`）都由同一份规格渲染——
  `src/chart/option.ts` 把业务字段与结果行翻成 option，`src/chart/echarts.ts` 用它的 SSR 出 SVG。
  报告（`src/chart/report.ts`）复用同一条链路：正文 markdown 里独占一行的 `![图注](.oks/figures/….<图元>.svg)`
  被读回来、经同一套清理后内联成 SVG——所以报告正文里不带 JSON，图一律"先画后引"。
- `parameters` 只使用受支持的 JSON Schema 关键字子集：`type` / `oneOf` / `properties` /
  `required` / `additionalProperties` / `items` / `enum` / `const` 加注解关键字；
  批次形状、规模与名字校验，以及 key 的重新计算与比对，都放在 `execute` 里。
- **落点是两个目录**：`artifacts/` 放产物（payload），`.oks/state.db` 放**账本**（清单与保留）——
  产物会被保活清理、账本不会被清，所以要分开放。**清单的权威在账本**：`SELECT` 就是清单，
  读它一个字节的文件系统都不碰。
- **保留与删除不在工具面里**：它们是用户在右侧栏「产出」页签上的两个动作（图钉与 `✕`，
  各走插件自己的一条端点）。agent 不需要知道这两件事，也就不会被诱导"出完顺手钉一下"
  或者"顺手清一下"。**只有未保留的产物能删**（保留是保护、删除是销毁，两者不重叠）；
  删一份不给别的产物陪葬：它的材料（图、数据）可能被别的报表引用，由保活按龄回收。
- **当前只有报表算制品**：`artifacts/` 里的图是**报表里的图**（报表会把它内联进去），所以不进清单、
  也不能被保留；查询结果同样是内部制品。`VISIBLE` 就是这条口径——**记进账本的也只有它**。
- 报表可以带一个**精确分类**（`category`：周报 / 月报 / 即时分析…），它写在产物自述里、进清单，
  界面上显示在大类图标旁边；没给就按"即时分析"。
- **界面走五条同源端点**（`GET /oks/artifacts` 清单、`POST /oks/pin` 保留、`POST /oks/delete` 删除、
  `POST /oks/collect` 清理、`GET /oks/download` 下载）。`GET /oks/artifacts` 的回执里还带一块 `usage`（数据 / 图表（含表格）/ 工作文件 / 输出文件
  各自的份数与字节，输出文件另带保留几份），以及账本里记的 `lastCleanup`（`{kind: 'manual'|'auto', at}`，
  只在**确实清到东西**时更新）——页签上方那块概览就是它。
  `POST /oks/collect` 就是产出页签里那个「清理」下拉：请求体可带可选 `ttl`（`"30m"` / `"5m"`，
  页签那两个菜单项），给了就按它清材料与 `.work/`；不给就按工作区配置的 `retention.manual` 清一次（报表不在其中——要留就保留、
  要删走行里的 `✕`），回执给截止时刻、窗口秒数、清掉几个（材料/程序分开）、还剩几个、剩余总大小与
  释放多少（**只给数量与大小，不给路径**）。
  装了 web 服务才开，
  没有 web 的部署里插件照常工作。**会话 → 工作区**是两段式，与宿主的"工作区文件"面板同源：
  活会话表的会话头 `cwd`（`ctx.sessions`；新建的会话在 `create` 返回前就已 publish，第一轮对话
  之前就有）→ 宿主的会话持久化（`ctx.sessionPersistence.stat`，进程重启前建的会话靠它，其 jsonl
  后端连尚未落盘的 pending header 也读得到）。登记晚一拍时按 150/500 毫秒再问两轮；解析过的
  记在内存里，轮询不会反复问。
  **解析不出来就明确报错**——不用 `sandboxPolicy.workspaceRoot` 顶替：那是部署值
  （`process.cwd()`），不是这个会话的工作区；给错工作区（页签显示成"这个工作区还没有图或报告"）
  比报错更难发现。
  右侧栏的「产出」页签只调这几条，不读文件、不碰工作区布局；
  "点条目打开某一份产物"由界面交给宿主的文件页签（资源地址），产物内容不经过插件。产物**自述**自己是什么（报告 `<meta>`，图 `<title>` /
  `<metadata>`，都在文件最前面），所以账本丢了也能重建：库空时**一次读**就把目录里的产物
  按自述全部补登回来（**保留随之丢失**，它是唯一不能重建的东西）。
- **账本：产出时记账，读路径不碰文件**。三条分工写死：
  - **写**：产出与记账在**同一次工具调用**里——`saveArtifact` 先造 meta、嵌进文件、原子落盘
    （临时文件 + `link`：读者要么看到完整旧文件、要么看到完整新文件），把这**同一个 meta 对象**
    交回给 `recordArtifact` 写进库。**不从文件里读回来**（读回来要解 XML 转义、要赌文件形状，
    两件事都以"清单少一条"收场）。记账失败就把文件删掉、整个调用失败：**有文件必有账**。
  - **读**（端点与 `oks_artifacts`）：`adoptArtifacts`（**只补登、不删除**：目录里有、账本上没有的
    可读产物就地登记；没有要补的连事务都不开）+ `SELECT`。不重新解析已知产物的文件头、不删行
    ——所以"目录一时看不见""某个文件读不出来"都不会让清单少一条；而"文件在、账本上没有"
    （过渡期的产物、写完文件就崩、人工放进来的、库被换过）**一次读就自愈**。
  - **碰目录的其余事情都在写路径**：`reconcileArtifacts`（写产物之前的懒惰清理里补登 +
    清掉文件已不在的行）、`pruneArtifacts`（遍历行删过期）、`deleteArtifact`（用户点 `✕`）。
    保留不改这些行为——它只由 `pin` / `unpin` 改。
- **保活清理遍历账本的行**：过期的删文件 + 删行，保留的跳过，文件已经不在的顺手清行。
  **没登记的文件不在清理范围里**（人工放进 `artifacts/` 的东西，我们不替人做删除决定），
  它们会在下一次读或写路径的补登里进账本。目录看不见时清理什么都不做。
- **保活与清理窗口**：未保留的产物在**产生 60 分钟**后由**懒惰清理**删除（写产物之前顺带清一次，没有定时器）；
  清理按账本的行做，删了什么写进宿主日志。窗口在 `oks.json` 的 `retention` 里配置，**分 auto 与 manual 两套**：

  ```json
  "retention": {
    "auto":   { "materials": "62m", "artifacts": "60m", "work": null },
    "manual": { "materials": "5m",  "work": "5m" }
  }
  ```
  - `auto` 由写路径自动执行（**必做，没有开关**）：材料、报表各自一个窗口；`.work/` 给 `null` 就是不参与，
    给了时长才参与。缺省即上表的默认值。
  - `manual` **只在显式触发时**生效：agent 用 `collect({ttl?})`（不给 `ttl` 用 `manual.materials`），
    用户在「产出」页签点"清理"（按 `manual` 清材料与 `.work/`）。
  - 时长写法 `"62m"` / `"2h"` / `"7d"`，也认秒级 `"15s"`；纯数字＝分钟。**下限分两档**：
    `auto` 守 **5 分钟**（它无人值守地自动跑），`manual` 与 `collect` 的 `ttl` 到 **5 秒**
    （这两种都要人/agent 显式触发）。写错的键与非法值当场报错（免得静默用默认值）。
    判据是 mtime＝**产生时刻**，读不算"使用"。
- **落点与命名**：统一是 `<时间>-<名>[-<内容哈希>].<类别><扩展名>`。内部材料分两处——
  `.oks/data/` 放数据封装（查询结果 `.qres.json`、加工结果 `.tr.json`、agent 自填数据 `.def.json`），
  `.oks/figures/` 放图表件（图 `.<图元>.svg`、表 `.table.md`）；报表 `.report.html` 落在交付目录 `artifacts/`。
  时间在最前面，`ls` 就是
  时间序；内容哈希等于文件字节的 sha256 前 8 位，所以**同名即同内容**，撞名不需要"加序号"那套补丁
  （查询结果那一段是名字前缀而不是内容哈希，撞名时读出来核一遍再决定是去重还是报错）。
  名字是**标识**而不是标题：只用 `0-9`、`_` 与 `a-z`，超过 60 字符就截成"前 53 + `~` + 6 位哈希"；
  读取时先按可读目录（`.oks/data/`、`.oks/figures/`、`artifacts/`）收窄，再用真实路径复核，
  挡住符号链接逃逸；独占创建、失败清理。
- 宿主是**进程内 worker**（`node:worker_threads` + 内置 WebAssembly）；当前只支持快照产物，
  产物没有 `telora.snapshot` 段时直接报错。
- 执行器是**另一个 worker**：`node:sqlite` 同步，只有独立线程才能被超时强杀；
  语句前缀检查与只读连接是两道独立防线。
- 死循环 / 慢查询只能靠墙钟超时兜住：到点 `terminate()` 整个 worker 代并拒掉排队请求。
- **每次请求前复位 guest**：快照产物的运行时契约要求先调 `reset-service`、再把
  `telora_reset_global_*` 恢复成初始化后的值。不复位的话 guest 状态会在请求之间累积，
  长会话里表现为 trap（`unreachable`）——全图遍历几百次请求就会撞上。
- 相对时间必须由 Agent 解析成绝对边界再提交 Intent；服务不读时钟，也拒绝 `now`/`ctx`。
