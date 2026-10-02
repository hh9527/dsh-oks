# dsh-oks

把**某个领域的知识服务（OKS）**接进 DSH，成为两个原生工具 + 两个辅助工具 — 用于在 Harness Web 里
**亲手体验**「业务问句 → 可执行查询计划」这条链路。只做计划，不执行查询。

它是一项 **DSH 能力扩展，不是某个 OKS 的包装**：插件本身不认识任何模型。开放哪个模型、
模型在哪，一律由**会话所在工作区**根目录的 `oks.json` 声明，所以同一份插件、同一行配置
可以同时服务任意多个工作区。

```jsonc
// <workspace>/oks.json   —— 领域名、模型路径、计划落点都由工作区自己给
{
  "version": 1,
  "domain": "<领域名>",
  "artifact": "<相对 oks.json 的 .wasm 路径>",
  "planDir": "<相对 oks.json 的计划目录>"   // 省略 = <ws>/.oks/plans；false = 不写
}
```

`artifact` 一律**相对 `oks.json` 所在目录**解析（绝对路径原样使用），与 `cwd` 无关。
没有 `oks.json` 的工作区会**明确报错**（用错模型比报错贵）。

## 迭代时的一个坑

插件是按**绝对路径**被 loader `import` 的，Node 按 URL 缓存 ESM 模块，所以：

- 改 `cordis.patch.yml` 只会让 profile 重读**配置**；
- 改 `index.js` **不会**热生效——需要重启 web profile 才会加载新的模块代。

## 提供的能力

| 工具 | 输入 | 作用 |
| --- | --- | --- |
| `ontology_info` | `{key:"<不透明字符串>"}` | 按 key 读一个知识节点。**入口是 `key:"index"`**（唯一可以凭记忆给出的 key）；之后按返回内容给出的 key 逐级继续——怎么继续、到哪一层，节点自己的说明会回答。key 一律原样传递，**不要构造、切分或解码** |
| `ontology_transform` | `{intents:[1..5]}` | 把 graph Intent 降低为**参数化 SQL + bindings**，不执行 |
| `time_now` | `{timeZone?}` | 当前时刻的**各种标准表示**（epoch 毫秒/秒、UTC 文本、RFC 3339、带偏移的本地文本、日期、ISO 周）+ 实际用的时区。服务不读时钟，所以相对时间必须在这里换成绝对边界 |
| `time_calc` | `{base?, timeZone?, operations?}` | 日历代数：`add`（year/quarter/month/week/day/hour/minute/second）、`floor`/`ceil` 到日历边界（周默认周一起）、`convert` 换时区。日/周保持**本地墙钟**（跨 DST 的一天可能不是 24 小时），月/季/年**钳制**到当月最后一天。区间半开 `[start, end)` |

后两个工具**与模型无关、也不解释任何领域格式**：它们只做标准表示与日历运算，具体要哪一种
形式由知识节点自己声明；正因为如此，它们**不需要工作区**（没有 `oks.json` 也能用）。

### 自带引导（技能与工具一起走）

插件**自带**一份引导技能 `ontology-query`：加载时通过 `ctx.skills.register()` 注册进 runtime 层，
因此对**所有工作区**可见。

- 正文是同目录的 `skill.md`（单一来源，元数据在 `index.js` 里）；
- runtime 的 rank 是 250，所以工作区自己的 `.dsh/skills`(100) 或 `.agents/skills`(200)
  **可以覆盖**它，用户级(400/500)覆盖不了——正好是"插件给默认引导、工作区可覆盖"；
- 技能服务是**可选**依赖（用 `ctx.get` 取）：没有它时四个工具照常工作。

### 工作区

工作区是**会话属性**（会话创建时的 `cwd`，由 harness 记录在会话头里），不是进程属性；
两个工具都在调用时从 `exec.agent.session` 取当前会话的工作区。每个工作区各有一份
惰性建立的运行环境：设置与 wasm 宿主，互不共享，因此互不影响。

### 计划与诊断

`ontology_transform` 的结果里包含三类东西：

1. 模型可见文本：每个 Intent 的 SQL、bindings 与**批次级诊断**；
2. 计划文件：每次成功的批次写一对 `plan-<hash>.sql` 与 `.json`，路径随结果返回，点开即见。
   名字是**内容哈希**（计划内容的 sha256 前 16 位）——所以同一批 Intent 反复问、重试、换措辞问，
   都落在同一对文件上。`.json` 的字节**就是**被哈希的内容，`sha256sum plan-<hash>.json`
   可以自校验（前缀即文件名）；文件一旦写下就不再改动，只有 mtime 跟到最近一次用到，
   `ls -t` 因此仍能看"最近用过的计划"。
   落点由工作区在 `oks.json` 里声明（`planDir`，相对 `oks.json` 解析）；**不声明就写
   `<workspace>/.oks/plans`，声明成 `false` 就不写**。文件落在工作区内才能在 GUI 里直接点开；
3. 原始服务信封 `{schema, ok:{accepted, diagnostics, queries}, error, diagnostics}`（结构化值）。

除了计划文件，插件不写任何东西；模型与 `oks.json` 是工作区自己的配置，插件只读。

**诊断是批次级的**（`ok.diagnostics: [{index, diagnostic:{severity, message, locs}}]`；`locs[0]` 是规则位置，
其后是各参数来源，动态输入的位置报道为 `<input>`）——
服务不提供 per-Intent 的 `valid` 字段，所以「哪个 Intent 失败」由带 `severity: "Error"`
的诊断**按 index 推导**。而且**成功的 Intent 也可能带 Warning**（例如聚合 Top-N 的分组被
隐藏身份键拆开），因此诊断必须全列，不能只在失败时读；使用 `queries` 前先看诊断。

服务只在**整批 Intent 全部通过**时才返回 `queries`。插件默认会把被拒批次中已通过的子集
单独再降一次（`retryAcceptedSubset`），让被拒批次里通过的 Intent 也能看到 SQL。

## 配置

插件代码里**不含任何机器路径，也不含任何模型**。模型、领域、`artifact` 全部来自工作区的
`oks.json`；插件行的 `config` 只是**覆盖**（优先级：`config` > `oks.json` > 默认值）：

| 键 | 含义 |
| --- | --- |
| `domain` / `artifact` | 覆盖工作区声明（缺 `domain` 或 `artifact` 时报错并给出补法） |
| `planDir` | 计划文件落点（插件行覆盖用）。`oks.json` 里也可声明：`"planDir": "plans"`（相对 oks.json）、`"planDir": false`（不写）；两处都不声明时默认 `<workspace>/.oks/plans` |
| `requestTimeoutMs` | 默认 60000，单次请求的墙钟上限（到点 terminate worker，下次请求再拉起） |
| `timeZone` | 两个时间工具用的时区（IANA，与 `time-context` 插件同名）。**不做宿主兜底**：不声明就必须每次显式传 `timeZone`，否则报错 |
| `retryAcceptedSubset` | 默认 true |
| `workspace` | **兜底**：仅当会话头里取不到 `cwd` 时用；正常情况不要写 |

```yaml
- insert:
    - id: oks
      name: '@local/dsh-oks'
      config: {}        # 模型由工作区声明，这里通常什么都不用写
```

`artifact` 是**独立部署物**：换机器、换域、换工作区都不用改插件。

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

## 安装 / 卸载

- **推荐**：在 Web 的「插件」页用 `install_bundle` 指向本目录（绝对路径）。
- 手动等价操作：`dsh plugin --profile web add file:<本目录>`，再把包名加进
  profile `package.json` 的 `dsh.profile.bundles`。
- 卸载：从 `dsh.profile.bundles` 去掉包名并 `dsh plugin --profile web remove @local/dsh-oks`。

## 本地冒烟测试（不安装）

```sh
cd /path/to/workspace && node /path/to/dsh-oks/smoke.mjs   # 被测工作区 = 当前目录
ONTOLOGY_WORKSPACE=/path/to/ws node smoke.mjs              # 或者显式指定
```

被测工作区必须是**已经声明了 `oks.json`** 的那个目录。

它用一个假的 cordis `ctx` 加载插件（插件行**什么都不配**，正是要验证"模型只来自工作区"），
并真实调用四个工具：验证宿主生命周期、请求配对、SQL/bindings 渲染、计划文件落点与
**内容寻址去重**（同一批 Intent 重问一次：路径相同、目录不增长、名字等于内容的 sha256 前缀、
渲染里明说"复用"）、**自带技能的注册**（名字合法、描述非空、正文与 `skill.md` 逐字一致、
正文不含任何具体领域名）、**两个工作区**各自拿到自己的落点、无 `oks.json` 与
**无 `telora.snapshot` 段**两种情况下都明确报错、以及 1 ms 上限下的超时强杀与复活。

测试夹具**不含任何领域知识**：实体 id 是运行时从服务里走出来的（读 `index`，按返回的 key
逐级跟随，直到拿到一个带 `detail.id` 的成员），所以模型换形状不会让测试失效——
这也正是"代码里不写形状假设"这条原则的自我验证。

## 实现备注

- **零依赖**：直接注册原始工具定义（`ctx.tools.register()` 只校验 `output.schema`），
  因此插件从 profile 或工作区加载都能正常工作。
- `parameters` 只使用受支持的 JSON Schema 关键字子集：`type` / `oneOf` / `properties` /
  `required` / `additionalProperties` / `items` / `enum` / `const` 加注解关键字；
  数量校验放在 `execute` 里。
- 宿主是**进程内 worker**（`node:worker_threads` + 内置 WebAssembly）；当前只支持快照产物，
  产物没有 `telora.snapshot` 段时直接报错。
- 进程内宿主唯一能兜住死循环的是墙钟超时：到点 `terminate()` 整个 worker 代并拒掉排队请求。
- 相对时间必须由 Agent 解析成绝对边界再提交 Intent；服务不读时钟，也拒绝 `now`/`ctx`。
