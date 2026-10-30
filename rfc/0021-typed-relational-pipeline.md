# RFC 0021：DARI 有类型的关系 Pipeline

- 状态：分支实现，IC/NS 端到端验证通过；跟踪 [Issue #49](https://github.com/hh9527/dsh-oks/issues/49)
- 日期：2026-10-30
- 工作分支：`feat/guided-knowledge`
- 范围：定义无 Asset 的 Pipeline、类型传播、检查与执行协议

## 源码语法

DARI 使用 `data name := expression;`、`figure name := node;`、`report name := node;` 三种不可变声明，共享命名空间，先定义后引用。data 承载内部计算，figure 的右侧为图表组件或 Table，report 的右侧为 Report。

```text
data facts := query({...});
figure cpu := BarChart(spec = {x:"name",value:"cpu"}, data = facts);
report answer := Report [
  h1 [ "CPU 使用率" ],
  p [ "最高值：", Value(data = summary?.peak), ],
  figure [ Figure(ref = cpu), figcaption [ "窗口内的平均值" ], ],
];
```

统一节点语法为 `tag(attr = expression, ...) [ children ]`，属性或子节点为空时可省略对应部分。每个声明必须以分号结束，子节点用逗号分隔，允许尾逗号。文本是 JSON 字符串，直接包含 &、< 等字符，渲染器负责转义；动态值通过 Value 插入。显式字面文本使用 `Lit ["1.2"]`，子节点只接受字符串，编译器负责生成内部字面标记。支持行注释、块注释，所有诊断映射到原稿位置。

一个 report 自动成为交付目标；多个 report 由 oks_check/oks_run 的 answer 参数选择。没有 export 或末尾输出对象。运行结果只释放所选报告 Value 引用的标量与实际展示的图表事实，内部 data 和未选报告不自动全部返回。作者源码、所有图表执行状态、来源及上下文仍完整保存在报告归档中。图表和报告绑定使用声明名，例如 #cpu、#answer。

DOM 语法直接构造已有的类型化数据 IR 和报告节点树，复用查询缓存、Option、SQLite lowering、图表检查、溯源及原生批准机制，不通过文本拼接或执行 JavaScript 解释源码。

## 目标与边界

一份 `.dari` 以 data 声明表达取数、关系运算和普通值计算，以 figure 和 report 声明表达呈现，以源码注释和报告正文记录业务口径。Agent 通过 `oks_check` 修复程序，由 `oks_run` 按配置完成批准并执行，随后解读事实。

SQL 是执行器的内部目标。Pipeline 是受限 DSL，源码由解析器构造 AST，不作为 JavaScript 执行。行函数只是构造有类型的表达式，不具有 JavaScript 的任意调用、可变状态或宿主访问能力。

本文定义语言语义；分支已接入解析、类型检查、SQLite 编译和运行，部署环境尚未更新。原始 SQL 实验的时延不代表此 DSL 的时延。完整的模型特定示例见 [IC CPU 分析稿](../packages/dsh-oks/examples/cpu-typed-pipeline.dari)。

## 类型推导的起点

`query(intent)` 在 check 阶段调用模型的 transform/lowering 检查接口，取得查询计划及 `columns`。此调用不执行业务 SQL。

例如模型返回：

```json
[
  {"name":"server_id","type":"String","nullable":false},
  {"name":"cpu","type":"Float","nullable":true}
]
```

则编译器直接得到：

```text
a : Table({server_id: String, cpu: Option(Float)})
```

这份 schema 是后续计算的类型依据。用户不重复声明列类型；编译器不根据列名、样例、首行或实际值猜测类型。模型拒绝查询、列重名或返回无法识别的逻辑类型时，检查失败。依赖此查询的节点标记为 blocked，其他独立节点继续检查。

`columns` 是模型检查的元信息，不意味着 query 在 check 时返回了一个可计算其行数或首行的空表。检查器中的 query 值是带 schema 的表计划；运行时才具有行。

现有模型的列协议主要包含逻辑类型和可空性。只有模型显式提供的单位、独立类型和键约束才可参与进一步检查；不能从一个 `Float` 反推出它是百分比，也不能从 `server_id` 这个名字证明唯一性。第一阶段按现有列协议实现，保留扩展类型元信息的位置。

## 三类结果

| 表达式 | 语言类型 | 语义 |
|---|---|---|
| `query(intent)` | `Table(T)` | 从模型取得 schema，执行时采集结果 |
| `select(spec)` | `Table(U)` | 从输入表和表达式推导 U，执行时进行关系运算 |
| `select_one(spec)` | `Option(U)` | 同样推导 U，执行时返回零行或单行对象 |

`Table(T)` 是关系值，不能通过 `a.cpu` 或 `a.rows[0]` 取得业务数据。行参数中的 `r.a.cpu` 才是标量列表达式。表在宿主内部可以编码为 `{columns,rows,truncated}`，该编码不是语言侧可绕过类型检查的对象。

普通值包括标量、记录、数组和 Option。`select_one` 使表进入普通值世界：其结果为 None 或一个字段类型完整的记录，不带 rows/columns 包装。JSON 边界以 null 表达 None。

类型构造包括 `Int`、`Float`、`Bool`、`String`、模型已支持的时间逻辑类型、`Option(T)`、`Array(T)`、`Record` 和 `Table(T)`。空表仍保留 T。集合的元素类型必须能静态确定，不能以首个实际元素推导。

## 源码与绑定

```text
data a := query({...});
data b := select({...});
data c := select_one({...});
{b, c}
```

绑定不可变，先定义后引用，名称唯一。末尾输出对象可选；检查只返回其类型与来源，不返回业务值。对象键可以是标识符或双引号字符串；字段可以使用点投影或静态字符串键投影。

表达式包括字面量、记录与数组构造、静态投影、可选投影、内置调用、标量运算以及受限行函数。行函数写成 `(r) => expression` 或 `(g, rows) => expression`，只出现在规定的参数位置；不支持用户定义递归函数、任意函数值和运行期动态字段名。

标量运算优先级从高到低为：投影与调用、一元 `!` / `-`、`*` / `/` / `%`、`+` / `-`、比较、`&&`、`||`、`??`。`??` 与布尔连接混合使用时要求括号。比较不允许连续串联。记录构造作为行函数返回值时使用括号，例如 `(r) => ({id:r.a.id})`。

## select：有作用域的关系计算

```text
data comparison := select({
  from: {b: base},
  joins: [{
    kind: "inner",
    source: {c: current},
    on: (r) => r.b.server_id == r.c.server_id
  }],
  where: (r) => is_some(r.b.cpu) && is_some(r.c.cpu),
  fields: (r) => ({
    server_id: r.b.server_id,
    base_cpu: r.b.cpu,
    current_cpu: r.c.cpu,
    delta: r.c.cpu - r.b.cpu
  }),
  order_by: (out) => [desc(out.delta), asc(out.server_id)],
  limit: 3
});
```

`from` 必填，恰好包含一个别名与表的映射。`fields` 必填，决定输出列名与顺序；记录中重复的键报错。输出字段是标量或 Option(标量)，不能嵌入表、记录或数组；复杂普通对象在 Pipeline 的记录构造中组织。

`joins` 可选，按声明顺序引入新别名；首版支持 inner 和 left。每项 source 恰好包含一个别名与表。别名不能重复。当前 join 的 on 可以访问主表、已引入的表与当前表，不能访问后续别名。

行参数 `r` 是别名到行类型的记录。inner join 的别名类型为该表行类型；left join 的右侧别名在后续表达式中为 `Option(Row)`。当前 left join 的 on 使用尚未补空的右侧 Row，后续 join 的 on 使用已经补空的作用域。读取可选右行使用 `r.tenant?.name`，其结果为 Option(String)。可选投影会展平已有 Option，不产生重复的 Option 包装。

`where` 在 join 后、fields 前计算，必须返回 Bool。`order_by` 使用投影后的输出行 out，只能引用输出列。原始字段需先投影到中间表，再进行排序和下一步投影。limit 是已知非负 Int；使用 limit 选择子集时必须提供 order_by，除非输入已能证明至多一行。未声明 order_by 的关系不承诺行顺序。

asc/desc 可带 `{nulls:"first"|"last"}`，默认始终 nulls:last。业务上如何破同分由计划显式表达；仅有列类型不能证明排序键的唯一性。

语义顺序固定为：from → joins → where → group_by → 聚合投影 → having → order_by → limit。没有 group_by 时，fields 是逐行投影，不允许聚合函数。

## 分组与聚合

```text
data byTenant := select({
  from: {s: samples},
  group_by: (r) => ({tenant_id: r.s.tenant_id}),
  fields: (g, rows) => ({
    tenant_id: g.tenant_id,
    sample_count: count(rows),
    valid_cpu_count: count(rows.s.cpu),
    mean_cpu: avg(rows.s.cpu)
  }),
  having: (out) => out.valid_cpu_count > 0,
  order_by: (out) => [desc(out.mean_cpu), asc(out.tenant_id)]
});
```

group_by 返回具名标量键记录。g 是该键记录；rows 是当前分组的内部行集合，`rows.s.cpu` 为内部 `Column(Option(Float))` 表达式。Column 只可传给规定的聚合函数，不能当标量使用，也不能离开聚合作用域。分组后的 fields 只能访问 g、聚合结果与捕获的普通值，不能直接引用任意原始行。

`group_by: (r) => ({})` 表达全局聚合，空输入也产生一个组。非空分组键的空输入产生零组。having 只用于分组 select，在聚合投影后使用输出行，返回 Bool。

| 函数 | 返回类型 | 空组或全缺失 |
|---|---|---|
| `count(rows)` | Int | 0 |
| `count(Column(T))` | Int | 0，忽略 None |
| `sum(Column(Int))` | Option(Int) | None |
| `sum(Column(Float))` | Option(Float) | None |
| `avg(Column(数值))` | Option(Float) | None |
| `min/max(Column(T))` | Option(T) | None |

聚合只对非 None 值计算。是否把 None 改成零由显式表达式决定，编译器不自动补零。

## 普通值与 Option

| 表达式 | 规则 |
|---|---|
| `is_some(x)` / `is_none(x)` | Option(T) → Bool |
| `x?.field` | Option(Record) → Option(字段类型)，展平 Option |
| `x ?? fallback` | 用兼容的 fallback 消解或保留 Option |
| `map_opt(x,(v)=>expr)` | Option(T) → Option(U)，None 不计算分支 |
| `round(x,digits)` | 数值 → 同类数值，保留 Option |
| `case_when(test,a,b)` | test 为 Bool，分支须有公共类型 |

数值运算支持 Int 向 Float 的明确提升；Int + Int 仍为 Int，除法返回 Option(Float)，除数为零返回 None；结果越界或非有限数为运行错误。算术在 Option 上提升，任一输入为 None 则结果为 None。关系比较遇到 Option 时返回 Option(Bool)，where/on/having 要求 Bool，需显式使用 `?? false` 等表达式。与 null 的相等比较专门等价于 is_none/is_some。字符串与数字不发生隐式转换，字符串拼接使用有签名的 concat。

首版不依赖 where 自动缩窄后续字段的可空性。即使 where 排除了空 CPU，delta 仍可保守推导为 Option(Float)，但绝不会变成 Unknown。后续可以增加有证明的谓词缩窄。

类型不能被内嵌任意 SQL、jq 或 JavaScript 打断；不提供不经验证的断言式 cast。新增函数需要同时具备类型规则、执行实现和错误行为。

## select_one 与行数约束

select_one 接受与 select 相同的 spec，并增加“至多一行”的约束：零行返回 None，一行返回 Some(Row)，多行报 CardinalityViolation。它不隐式添加 limit:1，也不把多行时第一行视为答案。

```text
data winner := select_one({
  from: {c: comparison},
  fields: (r) => ({server_id:r.c.server_id, delta:r.c.delta}),
  order_by: (out) => [desc(out.delta), asc(out.server_id)],
  limit: 1
});
data winnerName := winner?.server_id;
```

编译器跟踪与值类型独立的行数边界，例如 limit:0 得到 0..0、limit:1 得到 0..1、全局聚合得到 1..1。无法静态证明至多一行的 select_one 仍可检查通过，但运行计划带有显式行数守卫，最多读取两行以判断违约；该守卫出现在检查回执中。字段类型检查不依赖守卫的实际结果。

不得依据模型未声明的“名称看起来唯一”省略守卫。用户意图是“第一名”时，显式排序及 limit:1；意图是“唯一匹配对象”时，保留多行报错语义。

## 时间和有限的数组组合

context 返回固定类型的时间上下文。time_windows 返回 `Array(TimeWindow)`；窗口具有 label、zone、start、end，start/end 为 TimePoint。TimePoint.dateTimeUtc 为规范 DateTimeUtc，TimePoint.epochMillis 为 EpochMillis，rfc3339 为带本地偏移的展示文本。不允许时间类型与普通 Int/String 隐式混用；不能无声截掉精度。

map 支持 `(item) => expr` 和 `(item,index) => expr`。首版用于检查期已知、有界数组的计划展开；例如 14 个时间窗口生成 14 个 query。每个展开的 query 都取得自己的 columns。普通的记录构造和时间函数也可以写在 map 内。

```text
data daily := union_all(map(days, (day) => select({
  from: {s: query({ /* 当前 day 的完整模型查询意图 */ })},
  fields: (r) => ({date:day.label, server:r.s.server_name, cpu:r.s.cpu})
})));
```

union_all 接受 Array(Table(T))，按列名与顺序验证 schema 兼容，Int/Float 可以提升，Option 取可空性的上界，其他不兼容列报错。它保留重复行，不承诺合并后的顺序。数组为空且无法推导 T 时，检查失败；不能据实际首个结果推导 T。

map 的展开上限由编译器统一限制，例如最多 50 项、总查询节点最多 128 个。不能把运行期的查询结果变成新的 query 参数、查询数量或字段名。业务数据可以进入 select、join 和标量表达式，却不能决定另一次远端取数；需要的数据一次规划完整。

## 类型传播验收样例

以下是编译器验收夹具的模型响应，不是让用户在源码中补写 schema：

```text
query(baseIntent).columns    ⇒ {server_id:String, cpu:Option(Float)}
query(currentIntent).columns ⇒ {server_id:String, cpu:Option(Float)}
```

上文 comparison 的结果应为：

```text
comparison : Table({
  server_id:String,
  base_cpu:Option(Float),
  current_cpu:Option(Float),
  delta:Option(Float)
})
winner : Option({server_id:String, delta:Option(Float)})
winnerName : Option(String)
```

把 fields 中的 `r.c.cpu` 改成 `r.c.cpu_typo`，应在模型 columns 到达后的同一次检查中报错。把排序列改成 out.missing、把图表 value 改成 server_id，分别在后续节点报字段错误与数值列错误，不需要任何业务行。

把 query 的 columns 改为 cpu:String，即使列名不变，也应使后续减法检查失败并失效旧的有类型计划。空结果不能改变 Table 的行类型；select_one 不能因为检查没有取数而被折叠为 None。

## 检查期与运行期

编译器为表达式记录阶段属性：Known 表示本次检查上下文中已知的值，Deferred 表示只知道类型或关系计划的值。这是内部分析属性，不要求用户写额外类型。

- 字面量、参数记录和已冻结的时间上下文可以为 Known
- query 的 intent 和计划展开次数必须为 Known，结果的业务行始终为 Deferred
- select 的结构、字段名、函数签名和类型在检查期确定，业务行仍为 Deferred
- select_one 在检查期只有 Option(T) 类型，不伪造 None，也不伪造一行记录
- 捕获运行期普通标量的 select 仍可检查，其值作为运行期 SQL 参数；类型不能决定列数或列名
- map_opt 的函数体按 T 检查，即使值未知也不能跳过字段校验

检查顺序为：解析 → 绑定与作用域 → 对 Known 参数求值 → 向模型索取 query columns → 逐节点推导类型和行数约束 → 检查图表与 Report → 输出可执行计划及诊断。类型错误阻止整稿运行；独立诊断尽量一次返回。

检查回执以 binding 为键，返回 query/select/select_one 及普通输出的类型、来源位置、表列顺序与可空性、静态行数边界、运行期守卫和 diagnostics。query 与 select 都是表，不能因为前者来自模型就漏掉后者的类型。回执不包含业务行、推测值或根据空表执行而得到的零/None。

query columns 变化会使后续节点重新类型检查。check 阶段的 SQL lowering 还可在空 schema 上进行 prepare 作为后端一致性检查，但类型推导的权威是模型 columns 和 DSL 的类型规则，而非 SQLite 对表达式类型的推测。

## 图表和报告

Figures 的 data 直接引用 Table(T)。检查列映射时使用 T，不需要收集真实行；数值图元必须引用数值或 Option(数值) 字段。图表运行时按规则表达空值，不把空值变成零。完整表格规格也按 T 检查。

Report 的 Value 读取普通标量或 Option(标量)，不直接读取 Table。获取报告摘要使用 select_one 的全局聚合或显式的至多一行选择。Value 的 None 显示为统一的“无数据”；需要不同文字时先在 Pipeline 中使用 ?? 明确表达。Value 和图表属性支持有类型表达式，普通排版属性使用静态字符串。

图表、报告通过统一 DOM-like 表达式构造；计算不引用语言文件名。源码语法见上文。

## 执行、临时表和缓存

运行以检查通过的类型计划为依据。query 结果校验列名、顺序、逻辑类型和可空性；schema 漂移或不合规单元格产生结构化错误，不自动重新猜测类型。模型或配置变化后需重新检查。

同一会话中的每份分析稿复用一个临时 SQLite 文件工作区。检查使用独立的 `:memory:` 工作区，只创建表结构。绑定 a 对应内部可读表名 t_a；编译器为 map 展开、别名、重名规避生成稳定的私有标识。用户不拼表名和 SQL 标识符。运行期标量以参数绑定，DSL 函数具有固定 lowering，数字、布尔和时间编码与解码遵循类型。

select 可以成为视图、CTE 或物化表。计划优化、SQL 融合与物化策略不能改变值、类型、行数约束、排序和来源语义。命中缓存的结果也可以注册为当前工作区的表；运行期间不回收；最后一次运行结束后空闲 15 分钟关闭连接并删除临时文件，下次运行自动重建。检查不延长执行缓存有效期。插件释放分析稿时清理临时文件，异常退出的遗留缓存由后续进程首次使用缓存目录时清理。嵌套 query 与顶层绑定的 query 具有相同的采集与缓存语义。

| 节点 | 缓存身份 |
|---|---|
| query | 模型与编译器版本、规范化 intent、数据采集批次/快照身份、数据源配置 |
| select | 规范化有类型关系计划、捕获的标量参数、上游结果身份、执行器版本 |
| select_one | 同 select，加上行数约束 |
| 普通表达式 | 类型、规范化表达式、依赖身份和参数 |

源码位置不改变计算身份，来源按本次源码重新组装。主输入在 lowering 时映射到私有 source 槽位；当前函数参数和表别名仍保留在规范化 AST 中，语义等价的别名改写可能使派生缓存重算。进一步的 alpha 规范化属于优化，不影响查询缓存和结果语义。是否物化、生成的 t_a 名称不进入语义键。来源位置按当前源码重新组装，不沿用缓存条目的旧位置。数据刷新会产生新采集身份，不能仅凭 intent 未变化复用旧数据。

check 与 run 共用冻结的上下文和计划身份；批准绑定源码、模型、数据配置及该上下文。refresh 创建新采集上下文并重新检查；开启 requireRunApproval 时申请批准。跨过日历边界或修改配置后，不能用一组边界检查再悄悄用另一组边界执行。

表的完整性与行数限制分开。query 返回传输截断时，默认拒绝在其上完成后处理，避免局部数据冒充全集；用户显式的 select limit 是已设计的关系运算，不是传输截断。执行资源上限超出时明确失败，不静默把结果变成一个成功的完整表。

## 诊断与运行期边界

字段诊断应包含原始 `.dari` 位置、当前行参数的类型、错误字段和可用字段。例如历史错误可在不取数据时报告：

```text
E_UNKNOWN_FIELD at daily fields.cpu
r.s : {sq_server_name:String, kq_server_cpu_usage:Option(Float)}
sq_server_cpu_usage 不存在，可用字段：sq_server_name, kq_server_cpu_usage
```

其他确定性错误包括别名越界、重复字段、非 Bool 谓词、不可相减的类型、Option 未处理、非法聚合、union schema 不兼容、图表列类型不匹配、用业务结果构造 query，以及无类型签名的函数调用。

类型检查不证明实体名称唯一、join 是一对一、数据源没有重复行、业务口径正确或结果具有业务代表性。这些需要模型约束和明确的查询设计。运行时仍检查来源完整性、输入完整性、值域、资源限制和 select_one 行数约束。

## 验收与实现顺序

实现按以下三部分验收：

1. AST、标量/Option 类型、模型 columns → Table(T)、逐行 select、select_one 和 Figures/Value 类型检查
2. 有类型 IR → SQLite、运行期输入校验、采集和派生缓存、行数守卫及来源链
3. 分组聚合、有限 map 展开、union_all、规范化时间内置函数，以及 IC/NS 完整分析稿迁移

每一步以真实模型 columns 为依据。最终验收需证明：业务数据库不存在时，整稿仍能检查并推导所有输出；错误字段在 check 报错；检查不会把未知事实求成空表或 None；同一份通过检查的源码能生成表格、逐日图和报告；修改后处理不重新取数；缓存恢复、空输入、缺失值、left join、多行守卫、截断和 schema 漂移均按本文语义处理。

Asset、jq 和原始 SQL 的入口在新 Pipeline 实现验收后整体退出，不保留两套用户写法。模型查询协议与领域知识接口继续复用。分支的提示词、手册及预制图表程序已经使用有类型 Pipeline；部署后解释器与手册同步生效。


## 固定宿主方法与单文件插件

知识查询由 JS 的固定 search/read/card/cap 方法直接读取已加载的知识图；公开接口为 oks_search、oks_card、oks_cap，不接受用户源码或自由投影。词汇助手继续使用同一模型知识索引。日历计算由 JS Temporal 实现，公开为 context 与 time_windows，直接返回有逻辑类型的 UTC 文本和 epoch 毫秒边界。

因为分析稿已经使用有类型的关系 Pipeline，这轮整体移除 jq asset、自定义 jq 方法库、jaq worker、引擎 Wasm 和 Rust 构建链。插件仅发布 index.mjs，图表与 Temporal 依赖内联。模型 transform 仍通过独立的模型宿主执行，与插件的知识查询和日历计算相互独立。

验收覆盖固定知识方法与旧实现的差分比较、时间边界、原始类型传递、缓存和批准机制，以及 IC/NS 在无业务数据库时完成检查、按配置完成实际运行。


## 按配置选择运行批准

requireRunApproval 为布尔配置，默认为 false。oks_run 始终先完成整稿检查，默认随后直接运行；设为 true 时，每次调用申请原生一次性批准，沿用源码、模型、数据与上下文绑定以及拒绝、取消和服务不可用时停止的规则。配置优先级为插件显式配置 > 工作区 oks.json > 默认值。
