# dsh-oks

把**某个领域的知识服务（OKS）**接进 DSH，成为八个原生工具 + 三个辅助工具 — 用于在 Harness Web 里
**亲手体验**「业务问句 → 实际查询结果」这条链路。查询在**只读**连接上执行；命中的结果写进工作区
`.data/` 下的结果文件，**默认不进模型上下文**，要用时用 `oks_jaq_result` 在它上面做结构化查询取回。

它是一项 **DSH 能力扩展，不是某个 OKS 的包装**：插件本身不认识任何模型。开放哪个模型、模型在哪、
查哪份数据，一律由**会话所在工作区**根目录的 `oks.json` 声明，所以同一份插件、同一行配置
可以同时服务任意多个工作区。

```jsonc
// <workspace>/oks.json   —— 领域名、模型路径、数据文件都由工作区自己给
{
  "version": 1,
  "domain": "<领域名>",
  "artifact": "<相对 oks.json 的 .wasm 路径>",
  "dataFile": "<相对 oks.json 的 .sqlite 路径>"   // 省略 = 不能查询，只能校验
}
```

`artifact` 与 `dataFile` 都**相对 `oks.json` 所在目录**解析（绝对路径原样使用）。
没有 `oks.json` 的工作区会**明确报错**（用错模型比报错贵）。

## 安装形态与迭代时的一个坑

插件在 profile 里是一个 **`link:` 依赖**（`node_modules/@local/dsh-oks` 是指向本目录的符号链接）。
它**只有 node 半边**（工具），所以**挂在 preset 里就行**：工具面只在该 preset 的作用域内生效，
profile 顶层不必多一行。

（这里曾评估过客户端半边——图表在浏览器里画成交互组件。但 `dsh-client-modules` 只扫描主 loader 的
`entries()`，而 preset 内的插件由 `dsh-agent-preset-registry` 用独立的 `PresetTree` 装配，写在 preset
里的 client 半边永远不会加载；要它生效只能把插件挂到 profile 顶层、污染所有会话。所以改成
**服务端把图画成 SVG**：图落进工作区、由 agent 引用进回答，插件则留在 preset 里。细节与实测见
`rfc/0001`。）

Node 按 URL 缓存 ESM 模块，所以：

- 改 `src/` 下的源码后要重新 `pnpm run build`（产物是自包含的 `dist/index.mjs`，含
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
| `oks_query` | `{intents:{<名>:{intent,key}}}` | 核 key 后**只读执行**：每个成功项写进 `<工作区>/.data/<名>-<key>-<at>.json`，回执只给 `dataSrc`、列信息与行数——**数据行与语句都不进这段对话**（数据按需读回，语句在执行记录与呈现记录里）；失败项按 `key_mismatch` / `rejected` / `query_error` / `save_error` 分别报告 |
| `oks_jaq_result` | `{src, query}` | 在结果文件上做**结构化查询**：`query` 是作用在**行数组**上的 jaq（与 jq 兼容）表达式——`.[] \| select(.count > 100)`、`.[] \| {name, total}`、`sort_by(.total) \| reverse \| .[0:5]`。表达式决定取回什么，按需投影即可；结果文件的内部结构不进契约。`src` 限定在工作区 `.data/` 内 |
| `oks_chart` | `{spec, src?, data?, name?, note?}` | 把图画成 **SVG 存进工作区**：`src` 与 `data` **恰好提供一个**——`src` 引用查询结果文件（来源固定标为「基于查询结果」），`data` 是你自填的对象行数组（「agent 自主填写」）。五种图元都用 `x`（类别/横轴列）与 `value`（数值列）作底：**分组柱** `column` 另需 `series`（组内分组），**横条** `bar`、**饼图** `pie`（只取正数）、**多序列折线** `line` 与**面积图** `area`（后两者要 `xType`，可选 `series`）。要看明细表，直接在回答里写 markdown 表格。回执给出一行 `![标题](路径)`，agent 把它放进回答，图就显示在那里 |
| `oks_report` | `{spec, name?, note?}` | 把叙述与图组织成一份**自足的 HTML 报告**存进工作区：`spec` 给 `title`、可选 `subtitle` 与一段 **markdown 正文**。正文用 `##` 分章节（成为目录），支持列表、表格、加粗、行内代码、引用、分隔线与换行（`<br>` / 行尾两空格 / 行尾 `\`），**除 `<br>` 外的 HTML 会转义**；**图写在它该出现的位置**——一个语言标为 `chart` 的围栏块，块里是 JSON（字段与 `oks_chart` 的 spec 相同，再给 `src` 或 `data` 其一与可选 `caption`，图注编号由系统给）。图以**内联 SVG** 嵌在页面里，单文件可以发给任何人打开。报告**不出现在回答正文**：回执给出一行 markdown 链接，agent 用 `present` 交付，用户点开在右侧栏阅读 |
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
  `artifact_sha256` 复用——同一份产物被多个工作区、多个会话声明时只派生一次；
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
- **结果落盘**：每个成功项写一个 JSON 文件到 `<工作区>/.data/`，文件名 `<名>-<key>-<at>.json`，
  内含原始 Intent、列信息（列名取自 SQL 元数据、类型按返回值观察，空结果记 unknown）、行数与完整数据行。
  独占创建，重名报保存错误；写失败会清掉不完整的文件。按需取数由 `oks_jaq_result` 负责——`src` 限定在
  `.data/` 内，并检查真实路径不越界。
- **空的要说清楚**：结果为空时，若数据目录里有 `manifest.json`，插件会报出数据窗口
  （`[start, endExclusive)`），提示"可能是时间落在窗口之外"。
- **留痕在宿主日志**：每次执行的语句、bindings、行数与耗时写进 `ctx.logger`——日志里有据可查。

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
| `domain` / `artifact` / `dataFile` | 覆盖工作区声明（缺 `domain` 或 `artifact` 时报错并给出补法；缺 `dataFile` 时只有 `oks_query` 报错） |
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

`artifact` 与 `dataFile` 都是**独立部署物**：换机器、换域、换工作区都不用改插件。

## 快照怎么来

```sh
cd lab-ontology
bin/telora -C <模型目录> build <模型名> --snapshot \
  --initialization-fuel 100000 --request-fuel 100000 --with-memory-limit 1024 \
  -o /path/to/model.wasm   # 这个路径相对工作区的 oks.json 填进 artifact
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
  这些工具。`install-preset.sh` 一次配好这个形态——初始化 profile、写 `link:` 依赖、在
  该 profile 里装链接、把 preset 追加进 `cordis.patch.yml`，可重复执行，直接跑就行：
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

源码在 `src/`（TypeScript），构建出**单一产物** `dist/index.mjs`（profile 里 `link:` 装的插件加载它）
——所以**改完 `src/` 必须重新构建**（`dist/` 不进 git；`pnpm install` 会经 `prepare` 自动构建一次，
`pnpm run test` 也会先构建，忘了构建不会静默用到旧产物）：

```sh
pnpm install          # tsdown + typescript（只用于开发/构建）
pnpm run typecheck    # tsc --noEmit，零报错
pnpm run build        # tsdown → dist/index.mjs（自包含）
pnpm run dev          # 同上，但 watch：改完立刻重建
pnpm run check        # typecheck + build + 冒烟
```

出图与报告都走 **echarts**：规格（业务字段与结果行）直接翻成 echarts option，再由它的 SSR 模式
（`renderer: 'svg'`）产出 SVG。整条链路是纯 JS——`dist/` 里只有一个 `index.mjs`（约 1.6 MB，
echarts 按需导入后打在里面），没有 WASM、字体或包缓存之类的旁资产。

打出去的包只含运行时需要的：`dist/` + `cordis.patch.yml` + `icon.svg` + `locale/*.json`
（`files` 就这么列的）——`src/`、`smoke.ts` 这些都不进 npm。

提示词是**普通源码模块**：`.md` 和 `.ts` 一样按功能/架构归属，不按文件类型分目录、也不单列一个
"提示词"品类。现在 `src/` 还没有按功能拆目录，所以技能的正文是 `src/skill.md`、词汇助手的提示词是
`src/va-prompt-tpl.md`（词表插在它的 `<!-- 词表 -->` 处）；将来某个功能拆成目录时，它就跟着那个功能走。
它们在构建期由 `loader` 内联成字符串常量，所以**改提示词同样要重新构建**——产物因此不需要任何
旁文件（运行时不读 `.md`）。

构建用 [tsdown](https://tsdown.dev)（rolldown 系，和 DSH 自己 node 侧包的产物一致）。Node ≥ 22
能直接跑 `.ts`，所以 `smoke.ts` 不用先构建就能跑（它自己对 `src/time.ts` 这类纯函数的单测也是直接
导入源码）；被测的插件本体则从 `dist/index.mjs` 导入——**测的就是最终制品**。

`smoke.ts` 是 JS 风格的测试脚本（自造假宿主、动态导入），**不纳入 `tsc` 检查**：要纳入需要先给它
写一套假宿主的类型（约 200 处隐式 any），那是另一件事。

## 本地冒烟测试（不安装）

```sh
cd /path/to/workspace && node /path/to/dsh-oks/smoke.ts   # 被测工作区 = 当前目录
OKS_WORKSPACE=/path/to/ws node smoke.ts              # 或者显式指定
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
**插件只写 `.data/`**、自带技能的注册（名字合法、描述非空、正文与 `src/skill.md` 逐字一致、
正文不含任何具体领域名）、第二个工作区按 `oks.json` 解析相对路径、无 `oks.json` 与**无 `telora.snapshot` 段**
两种情况下都明确报错，以及模型请求与查询两侧 1 ms 上限下的超时强杀与复活。

测试夹具**不含任何领域知识**：实体 id 是运行时从服务里走出来的（读 `index`，按返回的 key
逐级跟随，直到拿到一个带 `detail.id` 的成员），所以模型换形状不会让测试失效——
这也正是"代码里不写形状假设"这条原则的自我验证。

检索层的用例是**数据驱动**的：搜索词与 key 都从产物自己声明的内容里取（例如拿一条真实词条
的名字去搜、用它的归属做过滤、再对它做反向引用查询），所以换一份模型也不会写死断言。

## 实现备注

- **产物自足**：直接注册原始工具定义（`ctx.tools.register()` 只校验 `output.schema`），
  查询用 Node 自带的 `node:sqlite`。代码与 echarts 全部打进 `dist/index.mjs`，没有旁资产——
  冒烟最后一段会把整个 `dist/` 搬进空目录，并在那里真画一张图，验证这一点。
- **一种渲染路径**：五种图元（`bar` / `column` / `line` / `pie` / `area`）都由同一份规格渲染——
  `src/chart/option.ts` 把业务字段与结果行翻成 option，`src/chart/echarts.ts` 用它的 SSR 出 SVG。
  报告（`src/chart/report.ts`）复用同一条链路：正文 markdown 里的 `chart` 围栏块就地画成内联 SVG。
- `parameters` 只使用受支持的 JSON Schema 关键字子集：`type` / `oneOf` / `properties` /
  `required` / `additionalProperties` / `items` / `enum` / `const` 加注解关键字；
  批次形状、规模与名字校验，以及 key 的重新计算与比对，都放在 `execute` 里。
- **`.data/` 是工作区里唯一的落点**：查询结果写成 `<名>-<key>-<at>.json`，图写成 `<名>-<at>.svg`
  （同毫秒重名时依次加序号）。名字拒绝分隔符、控制字符与 `.`/`..`；读取时先按 `.data/` 前缀收窄，
  再用真实路径复核，挡住符号链接逃逸；独占创建、失败清理。
- 宿主是**进程内 worker**（`node:worker_threads` + 内置 WebAssembly）；当前只支持快照产物，
  产物没有 `telora.snapshot` 段时直接报错。
- 执行器是**另一个 worker**：`node:sqlite` 同步，只有独立线程才能被超时强杀；
  语句前缀检查与只读连接是两道独立防线。
- 死循环 / 慢查询只能靠墙钟超时兜住：到点 `terminate()` 整个 worker 代并拒掉排队请求。
- **每次请求前复位 guest**：快照产物的运行时契约要求先调 `reset-service`、再把
  `telora_reset_global_*` 恢复成初始化后的值。不复位的话 guest 状态会在请求之间累积，
  长会话里表现为 trap（`unreachable`）——全图遍历几百次请求就会撞上。
- 相对时间必须由 Agent 解析成绝对边界再提交 Intent；服务不读时钟，也拒绝 `now`/`ctx`。
