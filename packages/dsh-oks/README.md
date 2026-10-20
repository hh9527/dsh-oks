# dsh-oks

把工作区声明的本体模型接入 DSH，以 DARI 保存完整业务分析源码。
模型提供业务事实和能力约束；工具负责知识导航、查询、加工、缓存、来源和呈现。

## 工具

| 工具 | 职责 |
| --- | --- |
| `va_ask({query})` | 词汇规整，返回线索，随后核实事实 |
| `oks_knowledge({project})` / `({jq:{src,args}})` | 在 datasets/types/relations/tools/items 图上精确投影或执行只读知识检索 |
| `oks_knowledge({help,topic?})` | 读取工具帮助；query 帮助默认列主题，topic 精确选取 |
| `work_read/write/edit/list/delete` | 只读写 `.work/` 文本文件，参数为完整工作区相对路径 |
| `oks_run_answer({src,answer?,delivery?,refresh?})` | 执行整份分析稿，复用采集与计算，返回有界反馈及可选答案 |
| `renew_context({src})` | 重置当前会话中指定稿件的采集批次，不执行；下次运行重新采集 |
| `oks_data({input,pointer?,offset?,limit?,meta?})` | 只读取已有运行输出或产物数据 |
| `oks_artifacts({})` | 列出工作区报告；保留/清理由右侧栏操作 |

业务计算定义在稿件内。`oks_data` 的普通读取视图是 `.data`；meta 显式查看追踪信息。

## 快速体验

把 [examples/answer.dari](examples/answer.dari) 的内容写到工作区 `.work/draft.dari`，随后：

```js
oks_run_answer({src: ".work/draft.dari"})
oks_data({input: ".work/draft.dari#summary"})
oks_data({input: ".work/draft.dari#debug"})
oks_run_answer({src: ".work/draft.dari", delivery: "artifact"})
```

该示例明确使用演示数据。真实任务应先发现模型能力，在 pipeline 中先用 `query(Intent)` 校验计划，再用 `exec_query(plan)` 取得业务证据。
支持只有计算的探索稿，逐步加入 jq、图表和答案。工作区必须声明模型；exec_query 另需 dataFile，query 计划校验不依赖数据库。

## DARI 与最小语言

`.dari`（Data Analysis and Representation Intermediate Format）是 JSX 风格的专用容器。
Dari 内包含一个 Pipeline、具名 jq Asset（language="jq"）、可选 Notes 与 Template。代码正文无需 XML 转义。
pipeline 是独立的进程内语言模块；jq 使用真实 Wasm 引擎独立编译。
诊断携带原文件路径和 UTF-16 半开范围、从 1 开始的行列，支持中文、emoji 与 CRLF。
全部具名程序在查询前预检，缓存结果重新映射到本轮原文件位置。

模板以 article 为根：`<Value data={summary.total} />` 显示标量，
`<figure><ColumnChart spec={chartSpec} data={facts.rows} /><figcaption>说明</figcaption></figure>` 生成图表及编号。
图元自闭合，spec 省略 kind，由标签决定类型；仅 NetworkGraph 接受 nodes。
每个 figure 放一个图元和可选的尾部 figcaption；图和表各自按文档顺序编号，每个答案重新开始。
花括号只接受 pipeline 绑定和静态投影；对象构造在 pipeline，运算在 jq。
普通正文元素遵守 XHTML 白名单，属性为静态字符串，文本中的 & 与 < 使用实体。
Notes 为静态原文，以 `</Notes>` 为保留结束标记；不参与计算。

执行入口为 `.dari`。已有 Markdown 文件保留为文本，显式转换命令（目标须尚不存在）：

```sh
node scripts/migrate-draft.ts old.md new.dari
```

转换保留说明、pipeline 和具名 jq/XHTML；可随后把显式 render_html 改写为 Value/具体图元模板。
运行时直接编译 DARI 为统一执行图，不通过 Markdown 转译。

```js
let params = data({threshold: 10}, {kind: "parameter"});
let plan = query({op:"Graph",root:"d",nodes:[{id:"d",entity:"<发现的数据集ID>"}],edges:[],select:[],count:"d",limit:100});
let facts = exec_query(plan);
debug(facts.rows[0]);
let summary = jq("summary.jq", {facts, params});
```

语法支持 immutable let、debug、JSON 值/数组/对象、静态 project 和固定算子。
语句必须有分号，变量先定义后引用；对象可简写 `{facts}`。注释支持 // 和 /* */。
静态路径支持 `.field`、`["field"]`、`[0]`；不存在的字段、越界及类型错配明确报错。
复杂筛选、遍历、算术与聚合写入 jq；输入文本按本语言解析，不执行任意 JS。

| 算子 | 数据与来源 |
| --- | --- |
| `data(value,{kind?})` | given（默认）/parameter/assumption/example，实际内容随来源保存 |
| `context()` | 显式捕获浏览器时区与时刻，批次内固定；utc 有 epochMillis/epochSeconds/rfc3339 |
| `time_windows(ctx,{unit,count,mode})` | 带 label、zone、毫秒及 RFC3339 起止的半开日历窗口 |
| `query(Intent)` | 只校验并编译计划，不访问数据库；可见负荷 `{columns}`，列为模型声明的 `{name,type,nullable}`，顶层 limit 为 1..500 |
| `exec_query(plan)` | 执行完整计划，结果 `{rows,columns,truncated}`；同批相同计划复用首次成功采集 |
| `jq("a.jq",{...})` | 当前文档具名 asset，恰好输出一个 JSON 值，完整源码随来源保存 |
| `render_figure(spec,{data,nodes?})` | 图/表展示件；table 选 columns，图使用 x/value/series 等列映射 |
| `render_html("a.xhtml",{...})` | 以当前绑定及来源组装答案 |

绑定传递 `.data` 值，来源带外携带。紧邻语句前的独立 // 行注释记录该步业务说明。
资产语法、静态 Intent 和可提前判断的规格先检查，再开始新业务计算；动态 Intent 就绪后校验。
运行中单分支失败阻塞其下游，独立分支继续。

## 知识发现

```js
oks_knowledge({project:{datasets:"Shape",types:"Shape"}})
oks_knowledge({jq:{src:"builtin://knowledge/search.jq",args:{query:"候选词",take:10}}})
oks_knowledge({jq:{src:"builtin://knowledge/read.jq",args:{key:"返回的地址"}}})
oks_knowledge({help:"oks://help/query",topic:"graph/filter"})
```

project 直接作用于图根，jq 输入为 `{knowledge:<图>}`。自定义知识程序为 `.work/*.jq`。
成员导航用 members.jq，反向引用用 references.jq；next 作为 skip 续页。
独立地址形如 `datasets/<URI编码ID>`，成员形如 `datasets/<ID>#dimensions/<ID>`；返回地址原样使用。
字典键是原始 ID。names/doc 与事实分开保存在 items；read.jq 配对读取。
精确选择 types 下的 values 不携带 fields 等分类引用。导航引用不授予查询能力，能力以领域声明为准。

## 时间与缓存

```js
let ctx = context();
let months = time_windows(ctx,{unit:"month",count:3,mode:"complete"});
debug(months);
```

complete 为最近 N 个完整期间；current 含当前期间，末端可能在未来；rolling 以捕获时刻为末端按日历回移。
unit 为 year/quarter/month/week/day，count 为 1..50。周从周一开始，边界分别适用时区/DST 规则。
细节见 `oks_knowledge({help:"oks://help/time"})`，jq 时间原语使用 epoch 秒。

低成本验证时，稿内只写 `let plan=query(intent); debug(plan.columns);`，确认后加入 `let facts=exec_query(plan);`。计划身份保存在运行器内部，完整绑定可直接引用；JSON 构造、投影和 jq 重构不会生成可执行计划。

反复提交完整源码默认复用本采集批次中相同计划的执行结果；输入计划变化只重采该查询，改 jq 或模板只影响其实际依赖。context 无输入，同批捕获的时间与时区固定。
`refresh:true` 新建采集批次并立即运行；`renew_context({src:".work/draft.dari"})` 只重置当前会话中指定稿件的批次，下次运行才采集，旧输出暂不可读。编译计划不因采集刷新而失效。批次不代表数据库事务快照，实际采集时间随证据保存。
运行回执的 acquisitions 摘要包含 acquiredAt、fromRun/fromBatch，以及复用、显式刷新、环境变化等原因；省略项有计数。
校验缓存包含程序/模型/检查器身份，计算缓存按实际值与环境判断，命中后仍装配本轮真实来源。

内部缓存与输出保留有容量上限：8 份工作区/会话/源码状态，30 分钟保留，计算缓存每份 128 项/16 MiB，
单轮输出 32 MiB。源码至多 256 KiB、512 语句，标识符最长 128 字符，单稿执行 120 秒。
采集快照被回收时会明确要求 refresh/renew_context，避免相同输入悄悄重查。进程重启允许缓存失效；读取不延长保留期，不恢复或重算。

## 只读查看与交付

```js
oks_data({input:".work/draft.dari#facts",pointer:"/rows",offset:0,limit:5})
oks_data({input:".work/draft.dari#debug/1"})
oks_data({input:".work/draft.dari#summary",meta:true})
```

pointer 是 JSON Pointer，范围读取支持数组或对象成员，limit 1..100。
读取对应当前会话该源码的最近一次运行；失败/移除/阻塞/回收不回退旧成功值。改稿后保留结果标 stale。
查询的 `truncated` 表示是否还有未返回的行；rows 最多包含请求的 limit 行。
查询的 `columns` 采用模型声明的 Int/Float/Bool/String/DatetimeUtc/EpochMillis/LocalDateTime，
保留最终投影顺序与保守 nullable；空结果、全 NULL 不影响声明。运行回执有列预览，完整读取可用
`oks_data({input:".work/draft.dari#facts",pointer:"/columns"})`，稿内可写 `debug(facts.columns)`。
LocalDateTime 是不带时区或偏移量的日期与钟表时间。旧模型未提供 columns 时使用观察类型 `types`。

新的计算、筛选或取样写回稿件再运行。debug 无需人为命名，回执关联原位置，小值直接返回，大值给引用。

单个直接 render_html 绑定自动选择；多个时用 answer 指定。计算和交付状态分开报告。
reply（默认）转为原生 Markdown，图为含来源的内部 SVG；8 KiB 以外或不支持的版式给诊断。
artifact 生成自足 HTML 并登记报告，带全部引用数据、来源、jq/XHTML，内部材料回收后仍可解释。
相同证据/源码重复交付复用仍存在的文件。最终工具反馈限制为 16 KiB。

XHTML 使用 `<article>` 根、严格元素/属性子集、显式自闭合空元素。
标量使用 data-oks-ref/data-oks-pick，图使用 figure 引用，绑定与正文双向核对。
正文业务数字通过引用填入；文字数字用 span 的 data-oks-lit 声明，解释段用 data-oks-shrink 标记。
报告读模型为 `{assets,items,structure}`，structure 是有界阅读摘要，完整引用数据在 items。

## 工作区与运行配置

会话 cwd 对应的工作区须有 oks.json；model/dataFile 相对该文件解析，也可使用绝对路径：

```json
{"version":1,"domain":"<domain>","model":"models/model.snapshot.wasm","dataFile":"data/source.sqlite"}
```

插件行 config 可覆盖 domain/model/dataFile；requestTimeoutMs 默认 60000，queryTimeoutMs 默认 30000。
exec_query 使用计划内的 Intent limit 作为行数保险。模型和数据源是独立部署物；当前进程已加载的工作区环境在重启后重新加载。
retention.auto 管理报告与磁盘内部材料，retention.manual 供用户清理；work 默认不自动清理。
运行器的内存结果保留窗口独立于磁盘保留配置。

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
  此时 `oks_*` / `work_*` / `va_ask` 只属于该 preset 的作用域，其它 preset 的会话没有
  这些工具。仓库根的 `install-preset.sh` 一次配好这个形态——初始化 profile、写 `link:` 依赖、在
  该 profile 里装链接、把 preset 追加进 `cordis.patch.yml`，可重复执行，在仓库根直接跑就行：
  `./install-preset.sh`（profile 默认取 `$DSH_PROFILE`，没有就 `web`；`--profile` /
  `--dsh-home` 只作覆盖，见 `--help`）。
- 用 `link:` 而不是 `file:`：前者是符号链接（改源码重启即生效），后者会被 pnpm
  硬链接成拷贝，插件页能显示但源码改动不再生效。
- 卸载：从 `dsh.profile.bundles` 去掉包名并 `dsh plugin --profile web remove @local/dsh-oks`；
  preset 形态先从 `cordis.patch.yml` 删掉那段 `preset-oks`，再执行同一条 `remove`。

## 开发与验收

TypeScript 在 src/，纯 jq Wasm 引擎在 crates/oks-wti。产物仅为 lib/index.mjs 与同目录 oks-wti.wasm。
XHTML 和 echarts 依赖及技能源码在构建期打包，运行不依赖源码或 node_modules。
Node 按 URL 缓存 ESM，link 安装需要重建并重启 profile 才加载新模块。

```sh
pnpm install
pnpm run typecheck
pnpm run build
pnpm run check
```

build/prepare/pretest 会更新 lib，运行中的 link 安装需先隔离构建验收，再更新在线产物。
Rust 需要 wasm32-unknown-unknown target；求值器没有时钟、环境或文件系统，超时/取消可强制终止 worker。
源码解析、依赖/缓存/来源、只读生命周期、图表/XHTML、知识索引与原生引擎各有独立测试。
真实模型/只读 SQLite 的工具集成使用 draft-plugin-test.ts，可对只含两份产物的独立目录验收。

源码格式见 [RFC 0015](../../rfc/0015-report-template-syntax.md)；执行与来源协议见 [RFC 0013](../../rfc/0013-answer-source.md)。

### 呈现知识

工具初始化时将领域无关的呈现用法挂载到 `tools`，与模型事实共享搜索、导航与投影。
`tools/render_figure#kinds/<kind>` 提供必填列映射、series 语义、专属开关和可执行示例；
`tools/render_figure#topics/table_headers` 说明字符串列名与 jq 表头重命名；
`tools/render_html#topics/references` 说明 XHTML 绑定和点分路径。
使用 `oks_knowledge({help:"oks://help/render"})` 查看入口，或用知识搜索查“图表”“表头”“data-oks-pick”。
每个主题可单独读取；`#topics/draft` 提供完整可运行 DARI 示例。

已有稿件若使用 query 直接取数，可显式迁移并保留原稿：

```sh
node scripts/split-query.ts old.dari new.dari
```

该命令将旧 query 调用包装为 exec_query(query(...))；新写的计划探索稿无需迁移。
