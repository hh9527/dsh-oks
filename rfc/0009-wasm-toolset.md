# RFC 0009：求值器自建——jaq 的库 + 白名单 builtin，落到 wasm（`crates/oks-wti`）（草案）

- 状态：**草案**（决策已定；阶段 0 的骨架已跑通，见文末「探索结果（阶段 0）」）
- 立项：本 RFC（话题起于 #25 之后的一次设计讨论；不另开 issue）
- 分支：`rfc/0009-wasm-toolset`（本文件 + 阶段 0 骨架）
- 创建日期：2026-10-15
- 关系：改的是**求值器从哪来**这一层实现（[`packages/dsh-oks/src/jaq.ts`](../packages/dsh-oks/src/jaq.ts)），
  **不动**工具契约（`jq_transform` / `jq_transform_into` 的参数与回执）、不动材料形态、不动报告。
  「时钟只有一个入口」这一条与「时间锚点落成材料」配套，后者单独交付。
- 前置观察（实测，jaq 3.1.1，经 mise 的 `.../installs/jaq/latest` 解析）：
  - 求值器是**外部进程**，`spawn` 时没有传 `env`，于是继承宿主全量环境——实测 `env | keys | length`
    是 **52** 个变量，`env.PATH` 直接读得出；
  - `now` 返回墙钟（`1792044186.7244868`）；`localtime` 随 `TZ` 变（`TZ=UTC` → 小时 `0`，
    `TZ=Asia/Shanghai` → `8`）；
  - `include` / `import` 有文件面（绝对路径被拒，`-L` 指到某个目录就能读出来）；
  - 引擎身份不记录：来源链里只有 `snip`（程序正文）与 `snipFile`，而解析路径字面就是 `latest`；
  - 上游把能力分组写成**私有函数**（`std()` 里只有 `env` / `now` 两条），公开的只有
    `base_funs` / `extra_funs` / `funs`——但 `base_funs` 与 `funs` 之分，本身就是为「自己组装能力」留的口子。

## 一、要什么（判据五条）

「干净」必须有判据，否则会漂。这五条都要**可验收**：

1. **闭包性**：结果只依赖 `(程序正文, 输入值, 引擎版本)` 三项；把这三项拿到任何一台机器上跑，
   输出逐字节相同；
2. **无外部读**：求值器能碰到的外部状态是**空集**（不是「我们拒绝了名单上的几个」）；
3. **能力显式**：任何跟外部打交道的动作，都在**调用点**可见（值写在程序或输入里），没有隐式来源；
4. **可枚举**：引擎的全部外部接口是一张**我们写的短名单**，并且测试逐个断言；
5. **失败响**：名单外的东西明确报错，而不是静默无效。

## 二、决策

一句话：**把「外部通用引擎」这个前提换掉——用 jaq 的库自建求值器，能力按组装（白名单），编到 wasm；
时钟与上下文只以「材料里的值」进入。**

1. **求值器 = 我们自己的 crate**：`jaq-core` + `jaq-std`（只要 `base_funs` + `defs`）+ `jaq-json`
   + 我们自己的组；编到 `wasm32-unknown-unknown`，作为**独立 `.wasm` 旁资产**随插件分发；
2. **不组装 = 语义上不存在**：`env`、`now`、`localtime`、`strflocaltime`、`input`、`inputs`。
   `debug` / `stderr` 必须留名（`defs.jq` 引用 `debug_empty` / `stderr_empty`），但给的是
   **明确报错**的桩。`include` / `import` 是**语法**，`def` 盖不住 → 在 loader 层拒（见「待探问题」）；
3. **时间与日历是受控内建**：纯的那几条照 jaq 语义（`fromdateiso8601` / `todateiso8601` /
   `strftime`(UTC) / `gmtime`(UTC) / `strptime` / `mktime`），另加**显式时区**的 `gmtime_tz(zone)`；
   日历运算（`tzadd` / `tzfloor`）按 jiff 的墙钟语义补（跨 DST 的一天不是 24 小时、月末钳制）。
   tzdata **编进产物**（wasm 里没有 `/usr/share/zoneinfo`，内嵌数据还跨机器一致）；
4. **版本以 `dsh-oks` 自己的版本号为准**（客户视角只感知工具的版本）：引擎身份（jaq / jiff / 产物
   哈希）**不进来源链**——它是我们的实现细节。链上钉住「同一段程序重跑得到同一份数字」的，是
   `snip`（程序正文）加上「这台机器上的 dsh-oks 版本」；
5. **目录**：仓库根 `Cargo.toml`（workspace）+ `crates/oks-wti`
   （**w**asm **t**oolset **i**mplementations；以后别的 wasm 能力同处 `crates/`，一个能力一个 crate）。
   插件本体仍是 Node/TypeScript（`packages/dsh-oks`），只多加载一个旁资产；
6. **接口层不变**：`runJaq(query, options)` 的语义不变，子进程换成 wasm 实例（实例可复用，顺带省掉
   每次 spawn 一个进程的开销）。

## 三、为什么不选另外两条路

- **外部 jaq + 加固**（空环境、钉 `TZ`、绝对路径、黑名单 / 遮蔽）：
  名单是**开放集合**（引擎在演进）；检查层与语义层**两套机制**并存（程序里再 `def now:` 一次就盖掉遮蔽，
  正则又会误伤 `.now` 字段与字符串）；引擎身份与供应链仍在外面。它能让今天好一点，但达不到上面五条；
- **沙箱外部进程**（landlock / seccomp / bwrap）：平台相关（本机 landlock 就是 partial enforcement），
  每台机器能力不同 → 会引入「同一份程序在不同机器上行为不同」这种**新的**不确定性。只作纵深；
- **自己写求值器**：解析器、表达力、错误信息都要重造；而 jaq 有第三方安全审计、fuzz target、
  500+ 测试，且它是 Rust 库、`ValT` 可扩展——借力比自己写划算得多。

## 四、能力清单（只此一份）

| 能力 | 处置 | 说明 |
|---|---|---|
| `jaq_core::funs()`（`length` / `keys` / 算术 / 路径…） | 留 | 核心通用 filter |
| `jaq_std::base_funs()`（`floor` / `sort` / `group_by` / `trim` / `halt`… 28 条） | 留 | 通用纯 filter |
| `jaq_json::funs()` / `defs()`（`fromjson` / `tojson` / `tobytes` / `contains`…） | 留 | json 侧转换 |
| 时间：纯的那几条 | 留 | [`crates/oks-wti/src/time.rs`](../crates/oks-wti/src/time.rs)，UTC 语义 |
| `gmtime_tz(zone)`（新增） | 留 | 显式时区的「localtime」，内嵌 tzdata |
| `tzadd` / `tzfloor` / `tzceil` | **已接进** | jiff 的墙钟语义：加减按墙钟（跨 DST 的一天不是 24 小时）、月末钳制、对齐到日历边界（周从周一）；`time_calc` 因此退场 |
| `env` / `now` / `localtime` / `strflocaltime` | **不组装** | `jaq-std` 关掉 default features 即可 |
| `input` / `inputs` | **不组装** | `jaq_std::input` 是单独模块，不组装就没有 |
| `debug` / `stderr` | 留名，**报错** | `defs.jq` 引用它们，必须有名字；用到就明确失败 |
| `include` / `import` | **拒** | **装载期**就拒（不用任何文本扫描）：`import` 走 `jaq_core::load::import()` 的装载回调（我们给的加载函数直接返回"这条求值路上没有文件系统…"），`include` 由 jaq 自己的装载路径拒；报错都带「文件名 + 行号 + 出错那一行」，字段名 / 字符串 / 注释里的同名词是普通程序 |
| math / regex / format 三组（含 `defs.jq` 引用的 16 个原生名） | **已接进** | 照 jaq-std 的 `math.rs` / `regex.rs` / format 表改写（MIT）；与 jaq CLI 逐条对照 22/22 一致 |

「不组装」不等于「能跑」：语言层的 `defs.jq` **直接引用**若干原生名，编译器在编译期就解析它们，
缺一个则**任何程序都编译不过**。当初编译器一次列全了缺口，共 16 条，**全是纯函数**：
math 组 `ilogb` / `tgamma` / `scalbln` / `pow` / `remainder` / `copysign` / `nextafter`；
regex 组 `matches` / `split_matches` / `split_`；
format 组 `escape_html` / `unescape_html` / `encode_uri` / `decode_uri` / `encode_base64` / `decode_base64`。
现在这 16 条随**整组**接了进来（`src/maths.rs` / `src/regexp.rs` / `src/format.rs`，照 jaq-std 改写，
MIT；依赖 `libm` / `regex-bites` / `base64` / `urlencoding` / `bstr`，都只做字节进字节出）。
**没有一条需要跟外部世界打交道**——这正是「关掉 env/now/localtime 之后仍有一门完整语言」的证据。
检查的办法也是硬的：缺任何一个，冒烟里那批程序会当场编译不过。

## 五、形状

- **目录**：`Cargo.toml`（workspace，`members = ["crates/oks-wti"]`）＋ `crates/oks-wti/`
  （`Cargo.toml` / `src/lib.rs` / `src/time.rs` / `src/missing.rs` / `check.mjs`）；
  `target/` 不进版本库，`Cargo.lock` **进**（引擎版本是确定性的一部分）；
- **依赖只有一处**：根 `Cargo.toml` 是**纯 workspace**（里面没有 crate），外部依赖全部声明在
  `[workspace.dependencies]`——版本、feature、`default-features` 都只写一遍；成员 crate 里一律只写
  `xxx.workspace = true`。于是「这个工作区用了哪些外部件、各是什么版本」有个唯一答案，升级只动一处；
  后续新增的 wasm 能力（别的 crate）照同一条规矩走；
- **旁资产与构建**：产物是 `lib/index.mjs` **加一个与它同目录的** `lib/oks-wti.wasm`
  （profile 里是 `link:` 装的，运行时按 `import.meta.url` 就近加载）。`pnpm run wasm` 跑
  `cargo build -p oks-wti --target wasm32-unknown-unknown` 并把产物拷进 `lib/`；
  `pnpm run build` = `wasm + tsdown`，`prepare` / `pretest` 都走它，于是 `pnpm install` 与
  `pnpm run check` 都会带上引擎；`package.json` 的 `files` 里声明 `lib/oks-wti.wasm`；
  `install-preset.sh` 的产物检查也认它（少一个就不算构建完成）。缺 Rust 工具链时**明确报错**，
  不静默出一份没有引擎的产物。`lib/` 不进版本库，所以新克隆/新机器要么装 Rust，要么由发布方提供
  同哈希的 `.wasm`（真要免工具链，退路是把产物提交进仓库并全程记哈希，见「待探问题」）；
- **ABI**（不引 wasm-bindgen，保持零 glue）：导出 `alloc` / `dealloc` / `run`；
  `run(程序, 程序名, 输入, 上限)` 返回 `[status u8][len u32 LE][payload]`——
  `0` = 结果、`1` = 错误、`2` = 到上限被截断（**引擎自己**到点就停并按行边界回退，
  不会先造出一个巨大的串）。
  **程序名由调用方给**（`.work/kpi.jq` → 报错里就写这个名字），空串按 `<inline>`；
  `panic` 在 wasm 里表现为**可捕获的 trap**（实例报废）→ 调用侧「丢弃重建」（见下）；
- **求值在哪跑**：`packages/dsh-oks/src/jaq.ts` 是唯一入口，引擎跑在一个 **worker** 里
  （`src/jaq-worker.ts` 的源码以 `eval` 内联，插件仍是单文件产物；worker 是唯一能被强杀的边界，
  超时 `terminate()` 并复活），trap 由 worker 自己重建实例。**子进程那条路整个没有了**：
- **构建**：`cargo build --release --target wasm32-unknown-unknown`
  → `target/wasm32-unknown-unknown/release/oks_wti.wasm`；
- **验收**：`node crates/oks-wti/check.mjs [wasm 路径]`（不装任何依赖）；
- **错误信息**：走 `jaq-all` 的 `load_errors` / `compile_errors` + `codesnake` 排版
  （与 jaq CLI 同一套，只是**不上色**）→「文件名 + 行号 + 出错那一行」原样保住；
- **trap**：wasm 里的 `panic` 会变成 trap 并**废掉实例** → 调用点要能「丢弃重建」。

## 六、验收

1. **越界清单逐个断言**（**只在验收时跑一次**，跑完就从常驻测试里删掉——负面清单会越滚越长；
   常驻的正向保证是「零 host imports + 能力只有白名单那一张表」）：`now` / `env` / `$ENV` /
   `localtime` / `strflocaltime` / `input` / `inputs` / `debug` / `stderr` 都必须**明确失败**
   ——本次实测全部是 `undefined filter` 或我们的话术（见文末探索结果）；
2. **跨环境逐字节一致**：同一批程序在 `TZ=UTC` 与 `TZ=Asia/Shanghai`（外加别的环境变量）下输出
   **逐字节相同**——这条不依赖任何引擎内部知识，是闭包性的硬证据；
3. **时区与日历**：`gmtime_tz` 在 DST 切换日、跨年、历史规则上正确；`tzadd` / `tzfloor` / `tzceil`
   的墙钟语义正确（跨 DST 的一天不是 24 小时、月末钳制、周从周一起）；
4. **材料与报告不受影响**：`jq_transform` / `jq_transform_into` 的入参与回执不变，`pnpm run check` 全绿；
5. **体积上限**：`.wasm` 不超过 **2 MB**（当前实测 ~1.26 MB）。

## 七、实施范围（每阶段独立可验收）

- **阶段 0**（已完成，见文末）：workspace + crate + ABI + 白名单组装 + `gmtime_tz` + 越界与确定性验收；
- **阶段 1**（已完成）：补齐那 16 个纯原生名（随 math / regex / format 整组接入），并与 jaq CLI 对照；
- **阶段 2**（已完成）：模块指令拒绝（落在**装载期**：`jaq_core::load::import()` 的装载回调）、错误格式化、trap 行为钉死；
- **阶段 3（桥接）**（已完成）：接进 [`jaq.ts`](../packages/dsh-oks/src/jaq.ts)（契约不变），
  求值改在 worker 里的 wasm 实例上跑；trap 的「丢弃重建」落在 worker 里；
- **阶段 4（日历运算）**（已完成）：`tzadd` / `tzfloor` / `tzceil` 接进引擎；工具面随之收敛 ——
  `time_now` / `time_calc` **退场**，改由 `create_current_ctx_data`（**无参数**）把当轮会话上下文读一次、落成
  `.oks/data/<date>-current-<hash>.ctx.json`（回执给 `dataSrc`，后续 jq 当具名输入用）。**建议**一次任务只用一份上下文，
  但这是建议不是硬规矩（不做"两个上下文就报错"那种结构化强制）；
- **不做**：引擎身份进来源链——版本以 `dsh-oks` 自己的版本号为准（客户视角只感知工具版本）。

## 八、待探问题

- **16 个纯名怎么来**：自己写 vs vendor `jaq-std` vs 向上游提 feature（「不要环境能力」对 wasm 与
  嵌入式用户普遍有用——上游的 playground 就是 wasm）。倾向前两者之一先落地，同时提上游；
- **`import` 的静默洞已堵**：原因是只调 `Loader::load` + `Compiler::compile`、少了
  `jaq_core::load::import(&modules, …)` 那一步；补上之后 `import "x" as $y; .` 与 `$y` 都是**明确报错**。
  值得给上游提 issue 的是"少了那一步会静默成功、用到时才 panic"这个组合（它自述不 panic）；
  `trap` 本身（栈溢出）仍会有，所以调用侧照旧要做「丢弃重建」；
- **性能**：wasm 与外部进程的对比（含实例复用后的启动开销）；
- **时间锚点**的形状已定（`create_current_ctx_data`，`.ctx.json`）：材料里只有**绝对值**（`utc.{epochMillis, rfc3339}`）与**按层放的时区**（`tz.client` 的 `id` / `offset` / `offsetMinutes`）；**不存 `local`**，也不叫 `now`（它是一个固定时刻）——墙钟离开时区就是歧义，要用就由程序当场算（`gmtime_tz(zone)`）。：一次任务建议只用一份，需要另一个时刻（隔夜 / 另一个时区口径）就再落一份并在动机里写清。
- **非浏览器（服务端）时区：以后再做**。形状已留好——`tz` 按**层**放：现在只有 `tz.client`（当轮会话/浏览器这一层），将来加服务端就是再添一个 `tz.server` 槽位 + 一个参数（参数名届时定，之前记的是 `serverSideTz`：叫它而不是 `serviceTz`，因为这个仓库里"服务"通常指**知识服务**）。**槽位只增不改**，所以读 `tz.client` 的程序含义不会漂；哪一层生效的规则等真加的时候再定。工具现在无参数：时区只来自当轮会话上下文，缺失或冲突时报错要求澄清。
- **升级节奏**：jaq 版本 pin ＋ tzdb 版本进链；缺口清单要在构建时**自动重算**
  （拿编译器列出的缺失名与我们的清单比对），否则升级会静默漂。

## 九、风险与边界

- 我们**不 fork 引擎**，只写自己的 std 层 → 升级 = 换 `jaq-core` / `jaq-std` 版本 + 重跑验收；
- 体积与产物自足：`lib/index.mjs` 保持自足，`.wasm` 是旁资产 —— 分发时要**成对**；
- 资源耗尽：jaq 自述不做防护（时间 / 内存 / 栈）→ 上限由 wasm 侧给（阶段 2）；
- 错误信息质量取决于我们自己的格式化层（阶段 2）。

## 十、明确不做

- 不把沙箱（landlock / seccomp）当主路；只作纵深；
- 不用正则扫程序做能力校验（会误伤 `.now`、字符串、注释，也会漏）；
- 不 fork jaq 的 CLI，也不自研语言 / 求值器；
- 不把 `.wasm` base64 塞进 `lib/index.mjs`（先用旁资产；破自足这件事另议）；
- 不改工具契约与数据形态。

## 关联

- jaq（MIT）：<https://github.com/01mf02/jaq>；`jaq-core` / `jaq-std` / `jaq-json` 的 docs.rs 页面；
- jiff（`tzdb-bundle-always` 内嵌 tzdata）：<https://docs.rs/jiff>；
- 本仓库：[`crates/oks-wti`](../crates/oks-wti/Cargo.toml)、
  [`packages/dsh-oks/src/jaq.ts`](../packages/dsh-oks/src/jaq.ts)。

## 探索结果（阶段 0）

crate 在 `crates/oks-wti`，`cargo build --release --target wasm32-unknown-unknown` 一次编过；
`node crates/oks-wti/check.mjs` 的结果：

| 验收项 | 实测 |
|---|---|
| 独立 `.wasm` 体积 | **1,106,313 字节**（约 1.1 MB；`strip` 后） |
| host imports | **零**（`WebAssembly.Module.imports` 为空）——没有 env、没有 fd、没有时钟 |
| 普通程序 | `[1,2,3] \| map(.+1)` → `[2,3,4]`；`keys_unsorted \| sort` → `["a","b"]` |
| `now` / `env` / `$ENV` / `localtime` / `strflocaltime` / `input` / `inputs` | **未知 filter / 未知变量**（不是被拒，是不存在） |
| `debug` / `stderr` | 按我们的话术明确报错 |
| 纯时间 | `strftime`(UTC)、`todate` / `fromdate` 往返、`mktime` / `strptime` 都对 |
| 时区（内嵌 tzdata） | `0 \| tzwall("Asia/Shanghai")` → `[1970,0,1,8,0,0,4,0]`；`America/New_York` → 前一天 19:00；**DST 当天正确**（2026-03-08T00:00Z → 3/7 19:00 EST） |
| 坏时区名 | `failed to find time zone ... in time zone database`（明确报错） |
| 跨环境确定性 | `TZ=UTC` 与 `TZ=Asia/Shanghai`（外加别的环境变量）两次运行输出**逐字节一致** |
| 纯能力组（math / regex / format） | 整组接进后与系统里的 **jaq CLI 逐条对照 22/22 一致**（含浮点打印 `pow(2;10)` → `1024.0`、`scan`/`match` 语义、`1e1000` 与大整数）——换引擎不改数字 |
| 模块指令 | `include` / `import`（含"导入了但不用"）一律明确失败，报错里写清"没有文件系统"；字段名 / 字符串 / 注释里的同名词不误判 |
| 时间函数的行为基准 | **跟 jaq**（实测 jq 1.7 在几处更严：`mktime` 只收 8 元数组、`fromdateiso8601` 不收带偏移 / 秒以下 / 基本式、`todateiso8601` 会丢小数）；命名约定：同名 = 与原生一致、`_tz` 后缀 = 原生同名函数 + 一个 zone 参数、`tz` 前缀 = 引擎新增的能力 |
| 越界清单（一次性） | 本次验收逐个跑过：`now` / `env` / `$ENV` / `localtime` / `strflocaltime` / `input` / `inputs` 全是 `undefined filter`，`debug` / `stderr` 是我们的话术；跑完即从常驻测试里删掉 |
| 报错排版 | 与 jaq CLI 同一套（`codesnake`）：`Error: …` + `╭─.work/probe.jq` + 行号 + 插入符；运行时错是一句话（`cannot calculate 1 + "a"`） |
| trap | 栈溢出 → **可捕获**的 `RuntimeError`（实例报废），新实例照常可用（worker 自己重建） |
| 桥接（阶段 3） | 全部 jq 走 wasm：`pnpm run check` → **420 / ✗ 0**；产物里再没有 `child_process`；求值耗时从子进程时代的 **13–26 ms** 降到 **1–3 ms**（不再每次起进程） |

已知缺口（就是「待探问题」里那两条）：`import` 缺模块静默成功、以及用到未解析的导入变量会 panic
（trap）；16 个纯原生名还是「明确报错」的桩。
