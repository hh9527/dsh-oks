# dsh-oks

把工作区声明的本体模型接入 DSH，以 DARI 保存完整业务分析源码。
模型提供业务事实和能力约束；工具负责知识导航、查询、加工、缓存、来源和呈现。

## 工具

| 工具 | 职责 |
| --- | --- |
| `va_ask({query})` | 发起词汇咨询；子 agent 回答送达后，核实词汇线索 |
| `oks_search({query,type?,dataset?,skip?,take?})` | 按领域词汇检索关联知识点 |
| `oks_cap({cq,join_depth?,skip?,take?})` | 获取目标的查询能力、关联候选与待校验骨架 |
| `oks_card({id?,key?,section?,skip?,take?})` | 按预制卡片核实数据集或精确领域节点 |
| `oks_run({src,answer?,refresh?})` | 检查后执行整稿，返回事实和选中的报告附件；按 requireRunApproval 配置申请批准 |
| `oks_check({src})` | 检查分析稿，返回查询列类型、诊断和待运行期检查项；不执行 SQL |
| `oks_read/write/edit/list/delete` | 管理逻辑源码地址；read 支持独立文本手册，list 用 path 指定目录 |


摘要直接进入系统上下文。预制工具完整返回其结果，输出规模由查询范围、分页和工具内部结构控制。

agent 先设计和检查分析稿，oks_run 检查后执行并返回事实，按配置申请本次批准。内部宿主运行器保留执行、缓存、来源和呈现能力。

## 词汇子会话

`va_ask` 为每个父会话复用一个宿主管理的 `spawn` 子会话，使用 `oks-vocabulary`
预设。父会话的子会话目录保留咨询标签和历史记录；执行完成、失败或取消后释放运行实例，
下次咨询恢复同一个子会话。父会话恢复后从持久目录找回它。
同一父会话同时发起的相同问题共享一次执行，不同问题串行执行。

助手保留完整词表的固定系统前缀，每轮把前缀之后的历史问答和旧标记收起为一个固定标记，
再加入当前问题。模型上下文不随咨询次数增长，原始问答完整保留在会话日志中。
工具面为空，权限为只读。
主 agent 每次通过 `va_ask` 发起咨询，工具返回子会话 ID 与消息 ID；
答案由宿主作为子 agent 消息送回主 agent，收到后再使用其中的词汇线索。
首次调用使用 `startActivation`，续问使用 `sendMessage`，均采用官方宿主的原生生命周期。
模型路由继承父会话当前请求。DeepSeek 模型的词汇助手默认使用 `off`，其他模型默认继承推理档位；显式配置优先，模型须支持配置的档位。
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

把 [examples/answer.dari](examples/answer.dari) 的内容写到工作区 `oks://work/draft.dari`，随后：

```js
oks_check({src: "oks://work/draft.dari"})
```

该示例明确使用演示数据。真实任务应先发现模型能力，用 query(Intent) 表达取数，再用 oks_check 检查查询及列类型。检查不要求 dataFile；后处理类型在检查期推导，业务数据和渲染在运行时取得。

## DARI 有类型 Pipeline

`.dari` 使用 data、figure、report 声明不可变计算、图表和报告。图表与报告统一使用 `tag(attrs) [ children ]` 构造表达式。语法规范见 [RFC 0021](../../rfc/0021-typed-relational-pipeline.md)，使用说明见 [Pipeline 手册](src/help/pipeline.md)。

```text
data facts := query({...});
data result := select({
  from:{f:facts},
  fields:(r)=>({name:r.f.name,value:r.f.value}),
  order_by:(out)=>[desc(out.value),asc(out.name)]
});
data first := select_one({
  from:{r:result},fields:(row)=>({name:row.r.name,value:row.r.value}),
  order_by:(out)=>[desc(out.value),asc(out.name)],limit:1
});
figure chart := BarChart(spec = {x:"name",value:"value"}, data = result);
report answer := Report [
  h1 [ "分析结果" ],
  p [ "首项：", Value(data = first?.name), ],
  figure [ Figure(ref = chart), ],
];
```

模型在 check 时返回 query 的 columns，直接构成 Table(T) 的行类型。select 根据表类型、行作用域和表达式签名推导新的 Table(U)；select_one 得到普通的 Option(U)。表列通过行函数访问，报告标量使用可选对象投影，例如 `Value(data = first?.name);`。

支持 inner/left join、筛选、投影、排序、limit、分组聚合、Option、有限 map、union_all 和时间转换。数值和字符串不发生隐式转换。错误字段、错误算术类型、可空谓词、非法聚合、图表列映射都在不读业务数据时检查。模型 columns 不包含的信息，如业务键唯一性和单位，不自行猜测。

运行以有类型计划生成参数化 SQL，在本次运行的 SQLite `:memory:` 内执行。每个结果集保留 schema；查询与派生计算按依赖缓存，缓存命中也能恢复临时表。select_one 的动态多行约束会在运行时拒绝。截断输入、schema 漂移、值类型不符、资源超限均明确失败。

图表写成 `figure chart := BarChart(spec = spec, data = result);`，检查器验证列名和数值映射。报告通过 `figure [ Figure(ref = chart) ];` 编排。绑定不可变，先定义后引用；一个 report 自动交付，多个 report 通过 answer 选择。内部数据不自动返回，运行结果包含所选报告引用的标量和图表事实。源码、当前来源位置和计算过程跟随图表与报告保存。

## 知识发现

数据分析流程直接进入预制 prompt，并以同一份文本在 `oks://help/workflow.md` 提供：理解意图、发现词汇和知识、批量检查查询及列类型、建立后处理后执行、审视数据并形成报告。

模型的全局领域摘要以 Markdown 在系统上下文中一次性提供，覆盖全部 Entity、Dataset、维度、度量与关系概览；词汇表、反向连接和插件手册独立提供。摘要按模型缓存，不累积重复注入；`oks://domain/summary.md` 提供同源读取，`oks://domain/` 提供目录。局部 cap/card 保持结构化 JSON，携带事实与必要说明。

```js
va_ask({query:"业务说法"})
oks_cap({cq:{target:{dataset:"目标数据集"}},take:20})
oks_card({id:"目标数据集",section:"dimensions",skip:0,take:20})
oks_card({key:"词汇助手返回的语义地址"})
oks_list({path:"oks://help/"})
```

知识查询使用固定工具参数；具体约束以卡片和 transform 校验为准。有类型 Pipeline 负责 DARI 的数据计算。后处理与摘要写在分析稿中，由宿主运行。


## 时间与缓存

```js
data ctx := context();
data months := time_windows(ctx,{unit:"month",count:3,mode:"complete"});
```

complete 为最近 N 个完整期间；current 含当前期间，末端可能在未来；rolling 以捕获时刻为末端按日历回移。
unit 为 year/quarter/month/week/day，count 为 1..50。周从周一开始，边界分别适用时区/DST 规则。
细节见 `oks_read({path:"oks://help/time.md"})`，Pipeline 提供规范的 UTC/毫秒时间转换。

## 设计检查

oks_check 返回 queries（模型查询及关系节点的列）、types（各绑定的推导类型）、diagnostics 和 deferred。query columns 在本次检查内参与所有后续类型推导；检查不读业务数据库，不把未知事实折叠成空表、零或 None。业务值决定下一次 query 的写法会被拒绝。

oks_run 重新检查当前稿件，冻结检查与执行共享的时间上下文，按配置申请本次用户批准后执行。修改后处理不会重新采集未变化的 query；refresh 创建新采集上下文。运行期验证真实 schema、值域、来源与单行守卫，并返回事实和可用的报告附件。

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
成功索引按模型内容、domain 及展示文件摘要缓存，知识工具和词汇助手共享它；编译、执行或验证错误拒绝加载且不进入缓存。

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

- 独立运行环境使用仓库根目录的 `just install` / `just run`，目录与端口配置见[安装说明](../../README.md)。
- **手工全局安装**：在 Web 的「插件」页安装本目录，或命令行
  `dsh plugin --profile web add link:<本目录>`，再把 `@local/dsh-oks` 加进
  profile `package.json` 的 `dsh.profile.bundles`（两处缺一不可）。这条路上 `add` 会把
  包升成 profile 的 bundle 层，本包自带的 `cordis.patch.yml`（一行顶层 `oks`）跟着生效。
- **只把工具面放进 preset**：`dsh.profile.bundles` 里不列本包，改在一个 preset 行
  （`@deepseek-ai/dsh-agent-preset`，`config.plugins` 里含 `"@local/dsh-oks"`）里挂载。
  此时 `oks_*` / `va_ask` 只属于该 preset 的作用域，其它 preset 的会话没有
  这些工具。`just install` 配好这个形态并注册 `oks-vocabulary` 助手预设，可重复执行。
  手工安装也须按“词汇子会话”一节注册助手预设。
- 用 `link:` 而不是 `file:`：前者是符号链接（改源码重启即生效），后者会被 pnpm
  硬链接成拷贝，插件页能显示但源码改动不再生效。
- 卸载：从 `dsh.profile.bundles` 去掉包名并 `dsh plugin --profile web remove @local/dsh-oks`；
  preset 形态先从 `cordis.patch.yml` 删掉 `preset-oks` 与 `preset-oks-vocabulary`，再执行同一条 `remove`。

## 开发与验收

`mdast-util-from-markdown` 仅供旧 Markdown 草稿的迁移脚本与测试夹具使用，属于开发依赖，不进入插件运行产物。


TypeScript 在 src/，发布产物为单文件 lib/index.mjs。知识查询由固定 JS 方法实现，日历计算使用内联的 Temporal，后处理使用 typed pipeline 编译到 SQLite。
echarts 依赖及技能源码在构建期打包，运行不依赖源码或 node_modules。
Node 按 URL 缓存 ESM，link 安装需要重建并重启 profile 才加载新模块。

```sh
pnpm install
pnpm run typecheck
pnpm run build
pnpm run check
```

build/prepare/pretest 直接更新 lib，运行中的 link 安装需先暂停服务，验收通过后重启。
构建仅需 Node.js 与 pnpm；模型执行使用独立的 Telora 模型宿主。
源码解析、依赖/缓存/来源、只读生命周期、图表/DARI 报告、知识索引、JS 日历和临时数据库生命周期各有独立测试。
真实模型/只读 SQLite 的工具集成使用 model-integration-test.ts，可对只含两份产物的独立目录验收。

源码格式见 [RFC 0015](../../rfc/0015-report-template-syntax.md)；执行与来源协议见 [RFC 0013](../../rfc/0013-answer-source.md)。

### 呈现知识

工具初始化时将领域无关的呈现用法挂载到 `tools`，与模型事实共享搜索、导航与投影。
`tools/render_figure#kinds/<kind>` 提供必填列映射、series 语义、专属开关和可执行示例；
`tools/render_figure#topics/table_headers` 说明字符串列名与 select 输出列命名；
`tools/report#topics/references` 说明 Value、Figure 引用与静态投影。
使用 `oks_read({path:"oks://help/figures.md"})` 查看入口，或用知识搜索查“图表”“表头”“data-oks-pick”。
每个主题可单独读取；`#topics/draft` 提供完整可运行 DARI 示例。

## 逻辑文件系统

- `oks://work/`：临时分析稿与工作文件，物理位置为 `.work/`，通过 oks_delete 显式清理
- `oks://help/*.md`：独立的只读文本手册
- `oks://domain/summary.md`：模型与插件自动生成的全局领域摘要
- 图表和报告由宿主附件服务持久保存，回执返回附件引用与呈现指引

agent 可检查稿件并通过 oks_run 运行；默认直接运行，配置 requireRunApproval=true 时先申请批准；result 直接返回最终输出，无独立结果读取工具。

### 按需读取工具用法

入口提示词保留任务和工作方法。工具帮助是 oks://help/*.md 只读文本文件，用 oks_list({path:"oks://help/"}) 列出，再用 oks_read({path:"oks://help/draft.md"}) 阅读，offset/limit 按行分页。knowledge.md 解释摘要、预制卡片和词汇助手，draft.md、query.md、time.md 和 figures.md 分别提供分析稿、查询、时间与呈现的方法。

工具帮助统一维护在 `src/help/*.md`，作为普通 Markdown 文本在构建时内联，不转换为结构化知识。图表和报告的结构化能力与示例直接维护在 `src/presentation-facts.ts`；组件、能力矩阵和白名单由实现生成。维护约定见 `src/help/README.md`。

文本读取：`oks_read` 与标准 read 使用相同窗口规则：默认/最多 2000 行，单行保留 2000 字符并标注截断，正文上限 50 KiB，返回续读 offset；偏移越界报错。文件目录使用 `oks_list`。


### 报告归档

DARI 报告 HTML 在非执行元数据中保留 `{version:1,context,dari}`。context 是本次运行与实际采集的快照；dari 包含完整 source、title、notes、assets、pipeline、reports，以及所有图表的 code、binding、status 和成功时的实际 data。dari.values 以规范化投影 code 为键，保存正文实际引用的标量，例如 `{"summary.total":42}`；相同投影跨报告去重。归档只保存图表数据与正文引用值，不保存全部中间绑定。整稿源码可完整恢复，导出不会刷新时间或执行查询。

宿主内部可按需读取归档，agent 通过获准的 oks_run 获取结果。图表与报告无依赖的分支执行结束后也纳入归档；失败分支保留状态。归档受运行存储预算约束。


### 有类型 Pipeline 验收

[IC CPU 两期比较](examples/cpu-typed-pipeline.dari) 覆盖窗口、18 个模型查询、关系组合、单行对象、聚合和逐日图；[NS 网元分类](examples/ns-typed-pipeline.dari) 覆盖另一模型的列 schema 与普通聚合对象。两份稿件均不含 Asset。

`node --import ./scripts/markdown-loader.mjs draft-typed-test.ts` 验证无业务数据的类型检查、字段诊断、Option、左关联、空表/空组、聚合、单行守卫、有限展开、缓存恢复、schema 变化和预制图表手册示例。Issue [#49](https://github.com/hh9527/dsh-oks/issues/49) 跟踪实现与验收，当前为分支实现。


### 运行批准配置

requireRunApproval 默认为 false，oks_run 完成检查后直接执行。设为 true 时，每次运行（含缓存复用与刷新）通过宿主申请一次性批准；批准服务不可用、拒绝或取消时不执行。

该字段可写在工作区 oks.json 或插件 config 中。优先级为插件显式配置 > 工作区配置 > 默认值，例如：

```json
{"requireRunApproval": true}
```
