# dsh-oks

把工作区声明的本体模型接入 DSH，以 DARI 保存完整业务分析源码。
模型提供业务事实和能力约束；工具负责知识导航、查询、加工、缓存、来源和呈现。

## 工具

| 工具 | 职责 |
| --- | --- |
| `va_ask({query})` | 将问题用词对齐到领域词汇；主 agent 自主检索和读取详情 |
| `oks_discover({queries:[{entity:"原词",props:[...],values?:[...]}]})` | 按概念实体、属性及可选具名值速查承载 Dataset 和查询地址 |
| `oks_search({q:[...],scope:[...]})` | 多个词在共享范围内检索根节点、内容分类或直接引用点 |
| `oks_routes({from,to,via?})` | 查找路径，内联方向、基数和连接键 |
| `oks_info({ids})` | 批量读取精确知识点 |
| `oks_read({path,offset?,limit?})` | 只读内置手册；path 为 oks://help/ 时列出手册 |
| `dari_check({src})` | 全稿检查，返回列类型和诊断；不执行业务 SQL |
| `dari_resolve({src})` | 把唯一 Answer 作为会话消息交付，回执只给消息 id 与计数；批准由配置控制 |
| `dari_renew_context({src})` | 更新时间基准和采集批次，使旧结果失效；不执行查询 |


词汇表进入独立 VA 的固定系统上下文，主 agent 保留工作方法和图表能力。预制工具完整返回其结果，输出规模由查询范围、分页和工具内部结构控制。

agent 先设计和检查分析稿，使用 `dari_resolve({src})` 把唯一 Answer 作为消息交付到会话。只执行 Answer 依赖，运行批准由配置控制。内部宿主运行器保留执行、缓存、来源和呈现能力。

## 知识子会话

`va_ask` 为每个父会话复用一个宿主管理的 `spawn` 子会话，使用 `oks-vocabulary`
预设。父会话的子会话目录保留咨询标签和历史记录；执行完成、失败或取消后释放运行实例，
下次咨询恢复同一个子会话。父会话恢复后从持久目录找回它。
同一父会话同时发起的相同问题共享一次执行，不同问题串行执行。

助手保留完整词汇表的固定系统前缀，每轮把前缀之后的历史问答和旧标记收起为一个固定标记，
再加入当前问题。模型上下文不随咨询次数增长，原始问答完整保留在会话日志中。
工具面为空，权限为只读。
主 agent 可按需把用户问题与明确约束交给 `va_ask`，工具返回词汇对齐结果；
主 Agent 随后自主使用 oks_discover 获取概念映射，按需使用 oks_routes/oks_info 获取相关局部知识。
首次调用使用 `startActivation`，续问使用 `sendMessage`，均采用官方宿主的原生生命周期。
模型路由继承父会话当前请求。DeepSeek 模型的知识助手默认使用 `off`，其他模型默认继承推理档位；显式配置优先，模型须支持配置的档位。
这些选项写在父预设的 OKS 插件行 `config` 中：

```yaml
vaPreset: oks-vocabulary
# 可选覆盖：inherit 表示沿用父会话档位
# vaReasoningEffort: "inherit"
```

安装器会注册助手预设。手工配置时，注册 ID 为 `oks-vocabulary` 的 agent preset，
其中只装配 `@local/dsh-oks`，插件行配置为 `vocabularyHelper: true`。
工作区 `oks.json` 负责模型和数据源声明。

宿主使用官方 DSH `0.2.1-rc.2`，无需源码补丁。咨询的执行、结果投递、中断和释放由宿主管理。

## 快速体验

把 [Answer 示例](examples/answer-markdown.dari) 的内容写到工作区本地文件 `draft.dari`，随后：

```js
dari_check({src: "draft.dari"})
dari_resolve({src: "draft.dari"})
```

该示例明确使用演示数据。真实任务应先发现模型能力，用 query(Intent) 表达取数，再用 dari_check 检查查询及列类型。检查不要求 dataFile；后处理类型在检查期推导，业务数据和渲染在运行时取得。

## DARI 有类型 Pipeline

`.dari` 使用 data、figure、report 声明不可变计算、图表和报告，使用唯一的 `answer tree! { Answer [...] }` 定义回答。图表、报告和回答统一使用 `tree! { ... }` 包围组件树；扩展组件使用 PascalCase（如 `Value`、`Lit`），普通标签使用小写，节点写作 `tag(attrs) [ children ]`。当前语法与使用说明见 [DARI 手册](src/help/dari.md)，早期设计见 [RFC 0021](../../rfc/0021-typed-relational-pipeline.md)。

```text
data facts = query({...});
data result = select({
  from:{f:facts},
  fields:(r)=>({name:r.f.name,value:r.f.value}),
  order_by:(out)=>[desc(out.value),asc(out.name)]
});
data first = select_one({
  from:{r:result},fields:(row)=>({name:row.r.name,value:row.r.value}),
  order_by:(out)=>[desc(out.value),asc(out.name)],limit:1
});
figure chart = tree! { BarChart(spec = {x:"name",value:"value"}, data = result) };
report full = tree! { Report [
  h1 [ "分析结果" ],
  p [ "首项：", Value(data= first?.name), ],
  UseFigure(ref = chart),
] };
answer tree! { Answer [
  p ["分析已完成"],
  UseFigure(ref = chart),
  UseReport(ref = full),
] };
```

模型在 check 时返回 query 的 columns，直接构成 Table(T) 的行类型。select 根据表类型、行作用域和表达式签名推导新的 Table(U)；select_one 得到普通的 Option(U)。表列通过行函数访问，报告标量使用可选对象投影，例如 `Value(data= first?.name)`。

支持 inner/left join、筛选、投影、排序、limit、分组聚合、Option、有限 map、union_all 和时间转换。数值和字符串不发生隐式转换。错误字段、错误算术类型、可空谓词、非法聚合、图表列映射都在不读业务数据时检查。模型 columns 不包含的信息，如业务键唯一性和单位，不自行猜测。

运行以有类型计划生成参数化 SQL，在每份分析稿的临时 SQLite 中执行；临时数据库闲置 15 分钟后回收。每个结果集保留 schema；查询与派生计算按依赖缓存，缓存命中也能恢复临时表。select_one 的动态多行约束会在运行时拒绝。截断输入、schema 漂移、值类型不符、资源超限均明确失败。

图表写成 `figure chart = tree! { BarChart(spec = spec, data = result) };`，检查器验证列名和数值映射。报告通过 `UseFigure(ref = chart, caption = "说明")` 编排，caption 可选。绑定不可变，先定义后引用。Answer 作为消息进入对话；UseFigure 生成图表嵌入，UseReport 生成可点击的报告链接。简单问数、简单报表各一次 resolve；探索任务每步一次，保留原稿过程并替换 Answer 为增量结果。解读数据后的观点在对话中补充，除非用户要求，不重新生成报告或 Answer。报告保留源码、上下文及执行元数据；SVG 内含最终绘图输入 CSV 和紧凑 JSON spec，表格与正文直接从 HTML 读取。

## 知识发现

数据分析流程直接进入预制 prompt，并以同一份文本在 `oks://help/workflow.md` 提供：理解意图、发现词汇和知识、批量检查查询及列类型、建立后处理后执行、审视数据并形成报告。

完整词汇表进入独立 VA 的固定系统上下文；主 agent 按需咨询 VA，自主使用 search/routes/info 读取局部知识。图表索引进入主 agent 已载入的 DARI 手册。search/routes/info 的公开回执为紧凑 Markdown，内部保留结构化结果。

```js
va_ask({query:"业务说法"})
oks_search({q:["device_class"],scope:["datasets/device"]})
oks_info({ids:["datasets/device/dimensions/device_class"]})
oks_read({path:"oks://help/"})
```

知识查询使用固定工具参数；具体约束以卡片和 transform 校验为准。有类型 Pipeline 负责 DARI 的数据计算。后处理与摘要写在分析稿中，由宿主运行。


## 时间与缓存

```js
data ctx = context();
data months = time_windows(ctx,{unit:"month",count:3,mode:"complete"});
```

complete 为最近 N 个完整期间；current 含当前期间，末端可能在未来；rolling 以捕获时刻为末端按日历回移。
unit 为 year/quarter/month/week/day，count 为 1..50。周从周一开始，边界分别适用时区/DST 规则。
时间、窗口与 Pipeline 写法已完整载入 `oks://help/dari.md`。

## 设计检查

dari_check 返回 queries（模型查询及关系节点的列）、types（各绑定的推导类型）、diagnostics 和 deferred。query columns 在本次检查内参与所有后续类型推导；检查不读业务数据库，不把未知事实折叠成空表、零或 None。业务值决定下一次 query 的写法会被拒绝。

dari_resolve 重新检查当前稿件，冻结检查与执行共享的时间上下文，按配置申请本次用户批准后执行。修改后处理不会重新采集未变化的 query；dari_renew_context({src}) 创建新采集上下文。运行期验证真实 schema、值域、来源与单行守卫，把唯一 Answer 作为消息交付到会话，图表和报告通过其 UseFigure/UseReport 引用交付。

## 工作区与运行配置

会话 cwd 对应的工作区须有 oks.json；model/dataFile 相对该文件解析，也可使用绝对路径：

```json
{"version":1,"domain":"<domain>","model":"models/model.snapshot.wasm","dataFile":"data/source.sqlite"}
```

插件行 config 可覆盖 domain/model/dataFile；requestTimeoutMs 默认 60000，queryTimeoutMs 默认 30000。
宿主执行 query 时使用 Intent limit 作为行数保险。模型和数据源是独立部署物；当前进程已加载的工作区环境在重启后重新加载。
运行器的内存结果有独立的容量与保留窗口，导出的宿主附件持久保留。

## 构建期知识

插件从 Wasm 的 `telora.build.information` 读取 `ontology.knowledge`。
当前协议为 `ontology-knowledge-javascript-v1`，发布固定 JS 函数体 program 和模型 JSON data。同一 ontology 版本对所有模型使用完全一致的 JS；模型标注只派生 `{revision,instructions}` JSON，指令格式为 `[operation,...args]`。

插件 JSON.parse 构建信息后执行：

```js
const buildKnowledge = new Function("data", publication.program);
const { graph, vocabulary } = buildKnowledge(publication.data);
```

插件信任模型代码，直接同步执行。静态 JS 负责模型结构、规范地址、Group 哈希、Map／Set 去重和事实合并；插件验证最终 v4 图和词条，再派生导航与反向链接。
vocabulary 决定 `va_ask` 的业务词条；`<model>.knowledge-items.json` 可补充名称、别名和说明。
成功索引按模型内容、domain 及展示文件摘要缓存，知识工具和知识助手共享它；编译、执行或验证错误拒绝加载且不进入缓存。

## 快照怎么来

```sh
cd lab-ontology
bin/telora -C <模型目录> build <模型名> --staged \
  --initialization-fuel 100000 --request-fuel 100000 --with-memory-limit 1024 \
  -o /path/to/model.wasm   # 这个路径相对工作区的 oks.json 填进 model
```

注意三点：

- 当前模型使用 `--staged` 在构建期准备状态及知识描述。插件通过 Node worker 和 WebAssembly 执行 transform。
- `--with-memory-limit` 必须给足：缺省构建会在初始化阶段报 `growth operation limited`
  而失败。这个上限在**构建时**定死，是产物本身的一部分。
- 完整命令与构建后的发布校验见模型仓库的 `icloud_model/docs/SOURCE_REFRESH.md`。

数据侧通常是同一批产物里的 `<name>.sqlite` 与 `manifest.json`（后者记录数据窗口与
来源 revision，插件只读它、不要求它在）。数据文件由工作区的 `dataFile` 指向。

## 安装 / 卸载

- 独立运行环境使用仓库根目录的 `just install-profile` 安装，在运行目录使用 `just run` 启动，目录与端口配置见[安装说明](../../README.md)。
- **手工全局安装**：在 Web 的「插件」页安装本目录，或命令行
  `dsh plugin --profile web add link:<本目录>`，再把 `@local/dsh-oks` 加进
  profile `package.json` 的 `dsh.profile.bundles`（两处缺一不可）。这条路上 `add` 会把
  包升成 profile 的 bundle 层，本包自带的 `cordis.patch.yml`（一行顶层 `oks`）跟着生效。
- **只把工具面放进 preset**：`dsh.profile.bundles` 里不列本包，改在一个 preset 行
  （`@deepseek-ai/dsh-agent-preset`，`config.plugins` 里含 `"@local/dsh-oks"`）里挂载。
  此时 `oks_*` / `dari_*` / `va_ask` 只属于该 preset 的作用域，其它 preset 的会话没有
  这些工具。`just install-profile` 配好这个形态并注册 `oks-vocabulary` 助手预设，可重复执行。
  手工安装也须按“知识子会话”一节注册助手预设。
- 用 `link:` 而不是 `file:`：前者是符号链接（改源码重启即生效），后者会被 pnpm
  硬链接成拷贝，插件页能显示但源码改动不再生效。
- 卸载：从 `dsh.profile.bundles` 去掉包名并 `dsh plugin --profile web remove @local/dsh-oks`；
  preset 形态先从 `cordis.patch.yml` 删掉 `preset-oks` 与 `preset-oks-vocabulary`，再执行同一条 `remove`。

## 开发与验收


TypeScript 在 src/，发布产物为单文件 lib/index.mjs。知识查询由固定 JS 方法实现，日历计算使用内联的 Temporal，后处理使用 typed pipeline 编译到 SQLite。
echarts 依赖及技能源码在构建期打包，运行不依赖源码或 node_modules。
Node 按 URL 缓存 ESM，link 安装需要重建并重启 profile 才加载新模块。

```sh
pnpm install
pnpm run typecheck
pnpm run build
pnpm run check
```

build/pretest 直接更新 `dist/dsh-oks/lib`，运行中的 link 安装需先暂停服务，验收通过后重启。
构建仅需 Node.js 与 pnpm；模型执行使用独立的 Telora 模型宿主。
源码解析、依赖/缓存/来源、只读生命周期、图表/DARI 报告、知识索引、JS 日历和临时数据库生命周期各有独立测试。

`pnpm test` 运行 `tests/` 下的默认套件（类型检查覆盖 `src/` 与 `tests/`）；需要真实工作区的用例单独运行：`pnpm run test:smoke`、`pnpm run test:integration`。

真实模型/只读 SQLite 的工具集成使用 [tests/model-integration-test.ts](tests/model-integration-test.ts)，可对只含产物的独立目录验收。

语法、执行和交付方式见 [DARI 手册](src/help/dari.md)。

### 呈现知识

DARI 手册已包含一行一图的能力索引和必填 spec 键，由实际图表能力生成。选定图表后，按需读取 `oks://help/figure-<kind>.md`；完整通用规格见 `oks://help/figure-options.md`。图表分册不进入初始提示词，报告与回答语法已归入 DARI 手册。

## 文件与内置手册

- 分析稿由宿主内置文件工具读取、创建、编辑与删除；src 支持工作区内的相对路径和绝对路径，真实路径决定缓存身份
- `oks://help/*.md`：独立的只读文本手册
- 图表和报告由宿主附件服务持久保存，回执返回附件引用与呈现指引

agent 可检查稿件并通过 dari_resolve 运行；默认直接运行，配置 requireRunApproval=true 时先申请批准；dari_resolve 仅接收 src，把可直接交付的 Answer 作为消息推入会话。

### 已载入手册与按需分册

初始提示词按 `workflow.md` → `dari.md` → `rules.md` 固定拼接，每段标记对应的 oks://help 地址，rules 始终位于插件手册前缀最末。三份手册已完整载入，首题无需再读；只有逐字引用或上下文被压缩后才通过 oks_read 重读。图表分册仍按需读取，暂不生成目录/行号索引。

workflow 负责工作顺序和知识导航，dari 负责语言、工具、类型、时间、查询、报告、回答与图表索引，rules 以短句强化关键纪律。旧 knowledge/draft/pipeline/query/time/figures/report 手册已归并删除。runtime skill 不再复制方法论。

文本由 `src/help/*.md` 在构建时内联；图表索引及按需分册由 `src/presentation-facts.ts` 的现有能力生成。注入与读取共用同一文本，修改手册直接改变固定前缀。维护约定见 `src/help/README.md`。

文本读取：`oks_read` 与标准 read 使用相同窗口规则：默认/最多 2000 行，单行保留 2000 字符并标注截断，正文上限 50 KiB，返回续读 offset；偏移越界报错。本地目录由宿主内置文件工具列出。


### Answer 交付

dari_resolve 把唯一 Answer 作为一条 user 消息推入会话：`source.kind` 为 `push-to-user`，`label` 为 `dsh-oks`，正文即 Answer Markdown。工具回执只给消息 id、run 和计数，不再复制正文。模型在下一步读到这条消息，回复中不重复它；交付失败时回执退回完整 Answer 并要求转发。

对话流里的可见卡片由独立的客户端包 [@local/dsh-push-to-user](../dsh-push-to-user/README.md) 提供：它认领该 source kind 并渲染淡色卡片与来源标签。没有该客户端包时，消息仍是模型可见的上下文，但界面按默认策略隐藏。

### 报告归档

DARI 报告 HTML 保留两个非执行 script 节点：`dari-source`（text/plain）保存完整原始源码，`dari-context`（application/json）保存版本、实际上下文、执行时间和模型标识等元数据。删除重复的 `dari-values`；表格与正文值直接读取 HTML，图表输入在 SVG metadata 中：`dari-data` 保存 CSV，`dari-spec` 保存紧凑 JSON spec，网络图的 `dari-nodes` 保存节点 CSV。源码嵌入时转义 HTML 敏感字符，提取时无损还原；JSON 转义 `<` 等字符，避免结束标签截断节点。

`report_extract_dari({src,sink})` 将源码写入新的本地 `.dari` 文件，并以行注释附上历史执行上下文；不覆盖文件、不刷新时间、不执行查询。运行期内部的完整归档仍受运行存储预算约束。


### 有类型 Pipeline 验收

[IC CPU 两期比较](examples/cpu-typed-pipeline.dari) 覆盖窗口、18 个模型查询、关系组合、单行对象、聚合和逐日图；[NS 网元分类](examples/ns-typed-pipeline.dari) 覆盖另一模型的列 schema 与普通聚合对象。示例使用 data 声明后处理，无需单独的 asset。

`node --import ./scripts/markdown-loader.mjs tests/draft-typed-test.ts` 验证无业务数据的类型检查、字段诊断、Option、左关联、空表/空组、聚合、单行守卫、有限展开、缓存恢复、schema 变化和预制图表手册示例。Issue [#49](https://github.com/hh9527/dsh-oks/issues/49) 跟踪实现与验收，当前为分支实现。


### 运行批准配置

requireRunApproval 默认为 false，dari_resolve 完成检查后直接执行。设为 true 时，每次运行（含缓存复用与刷新）通过宿主申请一次性批准；批准服务不可用、拒绝或取消时不执行。

该字段可写在工作区 oks.json 或插件 config 中。优先级为插件显式配置 > 工作区配置 > 默认值，例如：

```json
{"requireRunApproval": true}
```

`remove_file({path})` 删除工作区内的单个普通文件，遵循宿主沙箱和批准策略；拒绝目录、符号链接、通配符和批量路径。

`move_entry({src, sink})` 移动或重命名工作区内的单个文件或目录。src/sink 均为包含最终名字的完整路径；sink 必须不存在，其父目录必须存在。遵循宿主沙箱和批准策略。
