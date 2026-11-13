# .dari 语言手册

本环境使用 `.dari`，工具为 dari_check({src})、dari_submit({src})、dari_renew_context({src})；用宿主文件工具读写工作区文件。分析顺序见 oks://help/workflow.md，行为约束见 oks://help/rules.md。

## 声明与类型

这是围绕数据获取、处理和展现的流水线定义语言：声明式、强类型、有边界。query_remote! 由外部模型证明领域查询，query! 由本地证明关系处理，遵循有类型约束的 SQL 语义；tree! 组织展现。! 标识特殊语法或语义边界，不表示立即执行。语言提供有限算子组合，不开放手写函数、循环、递归、任意代码或物理 source。

顶层按依赖顺序声明：`type T = Schema({...});` 定义类型；`data name = expr;` 绑定可缓存的数据节点；`report name = tree! { Report [...] };` 绑定报告；唯一交付根为 `answer tree! { Answer [...] };`，不写名称或等号。节点内 let 命名不可变的计划片段，不增加缓存或物化边界。

注释使用 `#` 到行尾，字符串内保持原值。绑定、对象键、列名和函数参数采用 ASCII snake_case；类型、枚举成员与扩展组件采用 PascalCase，HTML 元素保持原标签名。对象字段用 `:`，tree! 节点属性用 `=`；布尔与空值为 True/False/None。中文写在展示文案与标签中。

Dataset、成员、类型、enum 和 Relation 使用 oks_info 发布的精确 .dari 符号；知识卡片中的 JSON 查询不是源码语法。

表结果为 Table(Schema({...}))，可选单行为 Option(Schema({...}))；表字段为逻辑标量或 Option(T)。业务 newtype 保留名义类型和计算约束，相同物理存储不代表可以混算。共享概念包括 Percent、Ratio、EpochMillis、DateTimeUtc、DateTimeTz 和 TimeZone。

`data x = do { let a = ...; a };` 表达局部纯计算：let 不可变、按依赖顺序声明、仅块内可见，末尾表达式决定返回类型。do 可以嵌套并引用数据节点，不能嵌入上下文获取、查询或展示结构；data 才是缓存边界。

## 查询计划与结果边界

query!/query_remote! 内 let 支持顺序 shadow：右侧使用旧绑定，后续使用新绑定，已保存的分支保留旧计划。后置 `.as!(name)` 绑定并返回当前计划，遵循相同规则；connect 后绑定新对端节点。

结果列通过实际 let 绑定访问，没有隐式 out。project 可从一个明确输入推导 Schema；引用多个输入时先 join 或 connect，再从关联计划投影。筛选、投影、聚合、排序按书写顺序组成计划。

```telora
data top = query! {
    let rows = from(samples);
    let rows = rows |> filter(rows.cpu > 50.0);
    let rows = rows |> project({name:rows.name,cpu:rows.cpu});
    rows |> order_by(desc(rows.cpu)) |> take(10)
};
```

中间 query_remote!/query! 可保持无上界 SQL 计划，供后续聚合、连接、集合运算和排名；不会先取 500 行再计算。只有交付的表和图表输入必须证明不超过 500 行。query_remote! 无 take 时也不写 order_by，排序放在后续 query! 中。is_empty(table) 使用数据库 EXISTS 判断，不拉取全表。take(n) 的 n 为静态整数 1..500，多行取前 N 必须 order_by；已知有界输入的后处理无需重复 take。无分组聚合至多一行，可直接 take_opt()，返回 Option(Schema)。可选行在展示树中解构，见下文。

## 远端领域查询

query_remote! 投影维度和度量时，模型对完整输入按所投影维度聚合。take 限制的是聚合后的输出行数，不截断参与聚合的原始数据。只有逐对象指标才使用 group_by_identity(a)。

```telora
data rows = query_remote! {
    let a = from(ic::current_alarm);
    let output = project({severity:a.alarm_severity,total:a.alarm_count});
    output |> order_by(asc(output.severity)) |> take(10)
};

answer tree! { Answer [h1 ["告警构成"],PieChart(data = rows,spec = {x:$.severity,value:$.total,title:"告警严重级别构成"})]};
```

远端 project 接受已发布成员及模型支持的分桶、时间转换、not_none。常量标签、lookup、case_when 和派生列放在后续 query!；影响分组口径的计算须在聚合前完成，例如远端分桶或分别筛选完整时间窗口。

逐对象指标先关联到对象身份节点并 group_by_identity，再投影称谓。设备名不能替代身份；KPI 身份可能包含采样时间，不能代替设备身份。

query_remote! 通过 from 引入模型源，用 `from(公开Dataset符号).as!(a) |> connect(公开Relation符号).as!(b)` 遍历关联。as! 绑定当前节点并保留整个计划，connect 从当前节点推导对端 Dataset，连续连接从最新节点继续。Relation 决定连接方向、基数和可选关联；可选关联保留根行，并使对端维度可空，即使其字段声明本身非空。先用 oks_info 读取涉及 Dataset 的 Relation 符号。维度筛选作用于聚合前原始行，独立的度量 filter 作用于聚合后；支持多个度量 filter。维度比较采用 `成员 比较符 参数`，可连续 filter 或嵌套 && / ||；文本筛选使用 contains/not_contains/starts_with/ends_with(成员,String参数)，不区分 ASCII 大小写。参数用声明的逻辑类型，例如 EpochMillis(...)、模型 newtype 或 Type::Variant。模型检查字段是否允许对应算子。排序可引用未投影成员；聚合后只能按已有分组键、已按身份分组的节点维度或聚合度量排序，模型拒绝会改变分组口径的隐藏排序。

```telora
data rows = query_remote! {
    let linked = from(ic::frame).as!(f)
        |> connect(ic::relations::frame_belongs_to_device).as!(d);
    let output = linked |> project({frame:f.frame_name,device:d.device_name});
    output |> order_by(asc(output.frame)) |> take(10)
};
```

query_remote! 的行级 filter 可用 is_some(a.optional_dimension) / is_none(a.optional_dimension) 筛选非 NULL / NULL，并可通过 && / || 与其他维度条件组合。使用模型发布的可空、可筛选维度成员；空字符串仍属于非 NULL，不等同于无数据。这些条件在数据库内执行。

远端查询中的参数表达式若不引用模型节点，会在本地计算并携带类型传入模型，例如 `a.ts >= to_datetime_utc(days[0].start.epoch_millis)`。引用模型列的时间转换由模型检查与执行。

两期比较可绑定 `let populations = pair(l,r) |> ...; let output = populations |> project({...});`，使用 `pair(l,r)`，两端分别声明独立节点及 Relation，再分别 `group_by_identity` 声明对齐身份，filter 划定各期完整输入。每端投影一个度量；`order_by(desc(growth_rate(output.after,output.before)))`、difference、ratio 在数据库内比较并排名，最后 take。增长率分母非正或比率分母为零时不参与对应排名。多个指标的劣化比较可以分别查询各指标，然后统一投影同一 Schema，通过 union_all 合并，再排序取前 N；不能把不同量纲的绝对差直接排名。

## 本地关系处理

可组合 filter、group_by、project、order_by、take、take_opt、distinct()。投影前的筛选针对源数据；投影后的筛选针对已聚合或已映射的结果，编译器保留这个顺序。新投影结果用新的 let 名称绑定。紧随投影的排序也可引用该阶段未输出的源字段。group_by 后必须 project 消费分组，分组投影使用 count/sum/avg/min/max。

局部计划绑定不可变：`let g = r |> group_by({tenant: r.tenant});` 后，从 `g |> project({tenant: g.tenant, n: count()})` 消费分组结果。全表计数直接使用 `r |> project({n: count()})`。

联接写为 `let joined = join({a,b},a.key == b.key); let output = joined |> project({left:a.value,right:b.value});`。left_join、semi_join、anti_join 使用相同结构；semi_join/anti_join 用数据库 EXISTS/NOT EXISTS 保留或排除左侧行。集合运算写为 `let combined = union({a,b}); combined |> order_by(asc(combined.field)) |> take(10)`；union/union_all/intersect/except 要求一致的字段名、业务类型及可空性。top_per({group:r.group},desc(r.value),n) 在各组内按指定顺序取前 N。

有限算术、lookup、unwrap_or!、round(value,precision)、concat、case_when、is_some/is_none、difference/ratio/growth_rate 放在前序 data 或 query! 中。整数余数用 `%`，除零或余数除零返回空值。map_opt(optional_row,$.field) 投影可选行字段。in_subnet/not_in_subnet(address,"192.168.1.0/24") 在 query! 中筛选已投影 IPv4 字段，非规范地址为空，子网必须规范且主机位为零。有限补充数据用 `table([{name:"目标",value:1}])`；空表必须声明 Table(Schema(...))。

等值标签映射用 lookup(value, [{value, label}, ...])：非空静态数组、键唯一且与输入业务类型一致、label 类型一致；未命中或输入为空返回 None，可按口径使用 value.unwrap_or!(default_expr)。前置 unwrap_or!(value,default_expr) 与后置形式等价，默认表达式只在 None 时求值，类型为 Option(T) × T → T。稳定业务编码用模型映射，任务显示标签用 lookup。例如 query! 的 project 字段：

```telora
category: unwrap_or!(lookup(r.cls, [
    {value: ic::DeviceClass::Lsw, label: "交换机"},
    {value: ic::DeviceClass::Router, label: "路由器"},
    {value: ic::DeviceClass::Ap, label: "无线接入点"}
]), "未标注分类")
```

枚举键使用已发布的精确符号；标签用于展示，筛选和计算保留原业务字段。

case_when(condition, then_value, else_value) 接受三个参数，条件为 Bool，两支类型兼容；多条件嵌套在 else_value 中。

ratio(a,b) / growth_rate(a,b) 返回 Option(Ratio)；输入为空、ratio 分母为零或 growth_rate 基线非正时为空。结果经投影、round、avg/min/max 保留 Ratio；difference 保留兼容输入的名义类型，包括 Percent/Ratio。Ratio(value) 只接受非空 Float，可空输入须先按业务处理。

### 空值与非空投影

条件必须为 Bool。可空比较得到 Option(Bool) 时，按业务明确空值分支：空值表示不满足可用 unwrap_or!(原条件, False)，需要保留空值行则选择 True 或显式判断，不能机械补零或套默认值。空字符串仍是非 NULL。

非空投影写为 project({field:not_none(expr)})：expr 必须是 Option(T)，该列输出为 T；任一标记列为空则排除整行，其他列保持原类型。not_none 仅允许在投影字段最外层。query! 支持可推导表达式及聚合，query_remote! 支持自身可空或由可选 Relation 变为可空的直接成员；筛除在投影结果计算后、后续排序和 take 前执行，空字符串不会被排除。带内置 pair 排名的 query_remote! 请在后续 query! 中作非空投影。

## 时间上下文与计算

顶层 `data ctx = context! { now: Context::Now, tz: Context::ClientTz };` 选择同次执行的固定上下文快照，类型为 Schema({now:EpochMillis,tz:TimeZone})。字段名可自定，仅读声明项；ClientTz 缺失或无效即报错。

时间转换用 to_epoch_millis(t)、to_datetime_utc(t)、to_datetime_tz(t,"Asia/Shanghai")；DateTimeTz 保留偏移和 IANA 时区。EpochMillis 可加减整数毫秒偏移，两个 EpochMillis 相减得到 Int 时长。time_bucket(t,{unit:TimeUnit::Day,time_zone:"Asia/Shanghai"}) 返回桶起点 DateTimeUtc，unit 使用 TimeUnit::Minute/Hour/Day/Week/Month/Quarter/Year，周从星期一开始；可用于 query! 投影。时间比较、排序按瞬时值进行。

time_windows({epoch_millis:ctx.now,time_zone:ctx.tz},{unit:TimeUnit::Day,count:3,mode:WindowMode::Complete}) 返回从早到晚的窗口。unit 为 TimeUnit::Minute/Hour/Day/Week/Month/Quarter/Year，mode 为 WindowMode::Complete/Current/Rolling，均须检查期确定。每项含 label、zone、start/end；边界含 epoch_millis/date_time_utc/rfc3339。参数可写 windows[0].start.epoch_millis；窗口为 [start,end)。

### 日历区间

在顶层 data 或纯 do 中准备日历区间，向 query_remote!/query! 传递标量端点：

```telora
data ctx = context! { now: Context::Now, tz: Context::ClientTz };
data window = do {
    let today = date_of(ctx.now, ctx.tz);
    let dates = calendar_period(today, CalendarUnit::Week);
    at_zone(dates, ctx.tz)
};
```

LocalDate("2026-02-01") 表达日期，TimeZone("Asia/Shanghai") 表达固定时区。CalendarUnit 为 Year/Quarter/Month/Week/Day；Weekday 为 Monday 到 Sunday，默认 Monday；DateOverflow 为 Reject/Clamp，默认 Reject。使用 Type::Variant 枚举符号，不使用字符串单位。

calendar_floor/calendar_ceil/date_of/shift_date 返回 LocalDate；calendar_period/date_range/shift_dates 返回 DateRange；at_zone(DateRange,TimeZone) 与 time_range(instant,instant) 返回 TimeRange。calendar_floor/calendar_ceil/calendar_period 接收日期、单位及可选 Weekday；shift_date/shift_dates 接收日期或区间、单位、移动数量及可选 DateOverflow。date_of 接收瞬时值和 TimeZone。intersection/overlaps 接收同类区间；contains 接收区间和端点；is_empty 判断空区间。

区间端点为 `.start` / `.end`，DateRange 端点为 LocalDate，TimeRange 端点为 EpochMillis。统一使用半开区间，空区间有效，逆向区间报错；普通对象不能冒充区间。日期转瞬时值必须显式指定时区，月末收敛必须显式选择 Clamp。当前这些日历准备函数只在局部计算中使用，不在 SQL 行表达式中展开；地区日历分桶见下节；固定时长分桶、批量分割及 input! 尚未提供。

按地区日历计算日、周、月的起止端点，再分别传入查询；跨日区间不要用固定 86400000 毫秒推算，以保留夏令时等地区规则。

### 数据库分桶

`utc_bucket(value, CalendarUnit::Day)` 支持 DateTimeUtc → DateTimeUtc，Option 输入保留 Option。单位为静态 CalendarUnit::Year/Quarter/Month/Week/Day，周固定从周一 UTC 00:00 开始，不接收时区、字符串单位或隐式 EpochMillis。

query! 中先投影桶字段，再对该字段 group_by 并 project 聚合值。query_remote! 中直接在 project 同时声明分桶维度和模型度量，模型按桶分组，并沿用该度量已发布的聚合规则：

```telora
data rows = query_remote! {
    let a = from(ic::device_kpi);
    let grouped = a |> project({day: utc_bucket(a.device_kpi_ts_raw, CalendarUnit::Day), cpu: a.cpu_usage});
    grouped |> order_by(asc(grouped.day)) |> take(100)
};
```

EpochMillis 先显式 to_datetime_utc，再 utc_bucket；远端转换源须为直接 EpochMillis/DateTimeUtc 维度，也可单独投影转换结果。数据库按桶聚合，保留来源可空性，不补空桶、不增加指标聚合权限。

`calendar_bucket(value, CalendarUnit::Day, zone)` 在 query!/query_remote! 中按地区日历分桶，value 为 DateTimeUtc，zone 为非空 TimeZone，结果为 DateTimeUtc，保留输入时间的可空性。支持 Year/Quarter/Month/Week/Day，周从周一开始。EpochMillis 来源显式使用 to_datetime_utc 转换。

```telora
data ctx = context! { tz: Context::ClientTz };
data daily = query_remote! {
    let a = from(ic::device_kpi);
    let grouped = a |> project({day: calendar_bucket(a.device_kpi_ts_raw, CalendarUnit::Day, ctx.tz), cpu: a.cpu_usage});
    grouped |> order_by(asc(grouped.day)) |> take(100)
};
```

固定地区用 `data zone = TimeZone("America/New_York");`。远端 zone 须为非空 TimeZone 参数，普通 String 成员不是地区身份。模型决定日历语义，适配 PostgreSQL/SQLite；分桶键用于分组，筛选边界用 DateRange/at_zone。无效地区报错，无默认时区回退；DateTimeLocal 和固定时长分桶尚未提供。

## 展示树与交付

树节点写 `Component(attr = value) [children]`。tree! 只组织文本、组件引用和条件；计算、映射和格式准备放在前序 data/do/query!。字段访问器写 $.field，由组件 data 的行 Schema 校验，不使用匿名函数。

tree! 子节点可直接写字符串，例如 p ["统计窗口：", UseValue(ref = window_label)]。直接字符串包含数字时，check 成功并给出 warning：查询结果应通过 UseValue(...) 引用；确属固定文案时，用 Lit(value = "最近 3 天") 显式确认。Lit 只接受 value 属性中的静态字符串，不对其数字发出 warning。

UseValue(ref = a.b.c) 只接受直接标量引用，字面量、调用、算术和空值默认值处理提前放在 data 中。先用 data highest_cpu = map_opt(highest,$.cpu); 准备可选标量，再用 UseValue(ref = highest_cpu) 展示。记录字段可先在 data/do 中绑定。条件写 `if condition [...] else [...]`；可选行写 `if let Some(row) = highest [...] else [...]`，行存在不代表其中字段非空，可继续解构。各分支均检查类型，执行时只渲染选中分支。

图表及 Table 直接内联在 Answer/Report 中，例如 `BarChart(data = rows,spec = {...})`。spec 不含 kind，组件标签决定种类。完整组件和配置见 oks://help/dari-figures.md。

Table 的列配置写 spec = {columns:[$.label,$.n]}，也接受字符串列名列表 ["label","n"]；裸标识 [label,n] 表示静态绑定引用。spec 配置在检查期确定，字段选择必须存在于 data 的行 Schema。

报告写 `report report = tree! { Report(title = "标题") [...] };`，Answer 用 UseReport(ref = report) 交付链接。title 用于 document.title 和链接名，默认取报告绑定名；正文标题用 h1/h2/h3，图表标题用 spec.title。支持 section、h1/h2/h3、p、div/span、ul/ol/li、blockquote、pre/code、strong/em、a、br/hr、Lit、Value；报告归档源码和 context。

Answer 的图表为 SVG 附件与 Markdown 图片，Report 内嵌图表；Table 分别为 Markdown/HTML 表格。两处分别渲染、共享同次执行的数据。submit 回执提供本次实际展示的数据文档：图表为 CSV，表格为 Markdown，Value 按引用列出展示值；按 answer/reports 路径与图表编号定位。根据回执理解数据，无需读取 HTML/SVG 附件。Answer 和各 Report 按实际展示顺序分别编号“图 1、图 2”与“表 1、表 2”；未选中分支不占编号，title 无需手写编号。

数值默认最多两位小数并去尾零，Int 保留整数。Percent(12.0) 与 Ratio(0.12) 都显示为 12%，原值、排序和计算不变；无需手动乘以 100。Value 用 precision = 3 覆盖精度（静态整数 0..12）；图表与 Table 的类型展示、精度和数据形态见图表分册。

## 诊断

dari_check 失败时返回 CheckFailed 文本，列出行列位置、相关声明与可确定的修复建议。一次收集多个独立错误，最多展示 20 条并提示剩余数量。类型及计划错误会说明期望与实际、错误原因和适用的修复方式。语法恢复以可靠的括号或声明边界为限；上游声明失败时，依赖它的内容等待修复后再检查。检查失败的稿件不会执行或发布结果。

运行期输入、数据与展示错误采用 SubmitFailed 文本并定位负责节点。输入编码错误应修正输入；模型/context 版本变化后重新检查同一稿件；模型结果违背已证明契约属于实现问题，不靠放宽类型、删条件或伪造数据规避。

`$.x.y` 按输入行类型逐级选择记录字段；`$.x?.y` 在 x 为 None 时整个选择器返回 None，否则继续取字段。`?` 要求 Option，返回类型为 Option(最终字段类型)，不叠加 Option。普通 `.` 不隐式穿透 Option。`$` 只在组件字段配置或 map_opt 的行上下文中使用。UseValue(ref = prepared.value) 使用具名数据引用。
