# .dari 语言手册

本环境使用 `.dari`，工具为 dari_check({src})、dari_resolve({src})、dari_renew_context({src})。用宿主文件工具读写工作区内的 .dari 文件。自定义绑定、对象键、列名和函数参数使用 ASCII snake_case；类型、枚举类型、枚举成员和扩展组件使用 PascalCase，HTML 元素保持原标签名；中文展示内容写在正文和标签中。这是围绕数据获取、处理和展现的流水线定义语言：声明式、强类型、有边界、本地与远程两阶段证明。query_remote! 由模型证明领域查询，query! 由本地证明关系处理，tree! 组织展现；关系处理遵循有类型约束的 SQL 语义。data 声明可缓存的数据节点，节点内 let 命名不可变的计划片段，不新增数据节点或物化边界。顶层使用 type、data、report 和唯一的 answer，节点内使用 let；按依赖顺序声明。不开放手写函数、循环、递归、任意代码或物理 source。

源码标识使用 oks_info 中模型发布的 .dari 契约。读取 Dataset 获取其精确 Dataset/成员/类型/enum/Relation 符号；读取单个维度或度量获取对应成员契约。源码使用返回的精确符号。知识卡片中的 JSON 查询不是 .dari 语法。

## 查询与后处理

query! / query_remote! 内的 let 支持顺序 shadow：右侧先使用旧绑定，再发布新绑定，后续步骤按新类型访问字段；之前保存的分支仍引用旧计划。`.as!(name)` 是表达式位置的绑定语法糖，绑定后仍返回当前计划，采用相同的 shadow 规则，可用于 from、filter、project 等计划；connect 后命名的是新对端节点。

```telora
data top = query! {
    let rows = from(samples);
    let rows = rows |> filter(rows.cpu > 50.0);
    let rows = rows |> project({name:rows.name,cpu:rows.cpu});
    rows |> order_by(desc(rows.cpu)) |> take(10)
};
```

query_remote! 投影维度和度量时，模型对完整输入按所投影维度聚合。take 限制的是聚合后的输出行数，不截断参与聚合的原始数据。只有逐对象指标才使用 group_by_identity(a)。

```telora
data rows = query_remote! {
    let a = from(ic::current_alarm);
    let output = project({severity:a.alarm_severity,total:a.alarm_count});
    output |> order_by(asc(output.severity)) |> take(10)
};

answer tree! { Answer [h1 ["告警构成"],PieChart(data = rows,spec = {x:project!(severity),value:project!(total),title:"告警严重级别构成"})]};
```

query_remote! 的 project 使用已发布成员及模型明确支持的分桶、时间转换、not_none；本次任务的常量标签、lookup、case_when 和派生列在后续 query! 中准备。计算若决定分组口径，必须先在远程阶段表达：使用已支持的分桶，或按各时间窗口分别筛选并聚合，再在本地补标签；不能在聚合后补分组而改变统计含义。

逐对象统计先选择代表该对象身份的节点并 group_by_identity，再投影称谓作为展示。设备名称不代表设备身份；按设备汇总 KPI 应关联设备节点并按设备身份分组，KPI 自身身份可能还包含采样时间，不能代替设备身份。

query_remote! 通过 from 引入模型源，用 `from(公开Dataset符号).as!(a) |> connect(公开Relation符号).as!(b)` 遍历关联。as! 绑定当前节点并保留整个计划，connect 从当前节点推导对端 Dataset，连续连接从最新节点继续。Relation 决定连接方向、基数和可选关联；可选关联保留根行，并使关联字段可空。先用 oks_info 读取涉及 Dataset 的 Relation 符号。维度筛选作用于聚合前原始行，独立的度量 filter 作用于聚合后；支持多个度量 filter。维度比较采用 `成员 比较符 参数`，可连续 filter 或嵌套 && / ||；文本筛选使用 contains/not_contains/starts_with/ends_with(成员,String参数)，不区分 ASCII 大小写。参数用声明的逻辑类型，例如 EpochMillis(...)、模型 newtype 或 Type::Variant。模型检查字段是否允许对应算子。排序可引用未投影成员；聚合后只能按已有分组键、已按身份分组的节点维度或聚合度量排序，模型拒绝会改变分组口径的隐藏排序。

```telora
data rows = query_remote! {
    let linked = from(ic::frame).as!(f)
        |> connect(ic::relations::frame_belongs_to_device).as!(d);
    let output = linked |> project({frame:f.frame_name,device:d.device_name});
    output |> order_by(asc(output.frame)) |> take(10)
};
```

两期比较可绑定 `let populations = pair(l,r) |> ...; let output = populations |> project({...});`，使用 `pair(l,r)`，两端分别声明独立节点及 Relation，再分别 `group_by_identity` 声明对齐身份，filter 划定各期完整输入。每端投影一个度量；`order_by(desc(growth_rate(output.after,output.before)))`、difference、ratio 在数据库内比较并排名，最后 take。增长率分母非正或比率分母为零时不参与对应排名。多个指标的劣化比较可以分别查询各指标，然后统一投影同一 Schema，通过 union_all 合并，再排序取前 N；不能把不同量纲的绝对差直接排名。

query! 使用显式绑定，例如 `let r = from(rows); let output = project({name:r.name}); output |> order_by(asc(output.name)) |> take(10)`。project 从一个明确输入的成员推导输出 Schema；引用多个输入时，先声明显式 join/Relation，再以关联计划为输入投影。let 只在当前 data 内可见，结果列通过其真实绑定名称访问，名称可以是 output/result/out 等，不存在隐式 out。

可组合 filter、group_by、project、order_by、take、take_opt、distinct()。投影前的筛选针对源数据；投影后的筛选针对已聚合或已映射的结果，编译器保留这个顺序。新投影结果用新的 let 名称绑定。紧随投影的排序也可引用该阶段未输出的源字段。group_by 后必须 project 消费分组，分组投影使用 count/sum/avg/min/max。

联接写为 `let joined = join({a,b},a.key == b.key); let output = joined |> project({left:a.value,right:b.value});`。left_join、semi_join、anti_join 使用相同结构；semi_join/anti_join 用数据库 EXISTS/NOT EXISTS 保留或排除左侧行。集合运算写为 `let combined = union({a,b}); combined |> order_by(asc(combined.field)) |> take(10)`；union/union_all/intersect/except 要求一致的字段名、业务类型及可空性。top_per({group:r.group},desc(r.value),n) 在各组内按指定顺序取前 N。

有限算术、lookup、coalesce、round(value,precision)、concat、case_when、is_some/is_none、difference/ratio/growth_rate 放在前序 data 或 query! 中。整数余数用 `%`，除零或余数除零返回空值。map_opt(optional_row,project!(field)) 投影可选行字段。lookup 返回可空结果；稳定业务编码由模型映射，任务显示标签用 lookup。in_subnet/not_in_subnet(address,"192.168.1.0/24") 在 query! 中筛选已投影 IPv4 字段，非规范地址为空，子网必须规范且主机位为零。有限补充数据用 `table([{name:"目标",value:1}])`；空表必须声明 Table(Schema(...))。

等值标签映射优先使用 `lookup(value, [{value, label}, ...])`；范围判断或复合条件使用 case_when。lookup 的查找表为非空静态数组，键唯一且与输入的非空业务类型一致，所有 label 类型一致；未命中或输入为空时返回 None，可按展示口径用 coalesce 提供兜底文案。例如在 query! 的 project 中：

```telora
category: coalesce(lookup(r.cls, [
    {value: ic::DeviceClass::Lsw, label: "交换机"},
    {value: ic::DeviceClass::Router, label: "路由器"},
    {value: ic::DeviceClass::Ap, label: "无线接入点"}
]), "未标注分类")
```

枚举键使用 oks_info 发布的精确符号。标签用于展示，筛选和计算保留原业务字段；用 lookup 表达标签查找，无需展开嵌套 case_when。

`case_when(condition, then_value, else_value)` 恰好三个参数，condition 必须为非空 Bool，两支结果类型须兼容。多个条件嵌套在 else_value 中，例如 `case_when(a, "甲", case_when(b, "乙", "其他"))`。可空比较如 `r.severity == Type::Variant` 返回 Option(Bool) 时，按业务明确空值分支；空值表示不命中时可用 `coalesce(原条件, False)`。

本地 `ratio(a,b)` 与 `growth_rate(a,b)` 返回 Option(Ratio)，携带比例计算约束与百分比展示语义；输入为空时返回 None，ratio 分母为零、growth_rate 基线非正时也返回 None。非空 Float 可显式用 `Ratio(value)` 表达比例，例如 `Ratio(0.12)` 展示为 12%。上述结果直接投影、round、avg/min/max 后仍保留 Ratio，无需额外转换或乘以 100。difference 保留兼容输入的名义类型，包括 Percent 与 Ratio。Ratio 构造器不直接接受 Option(Float)；应先按业务处理空值，再转换，不能为了显示百分号擅自补零。记录或标量展示用 `Value(value = prepared_value)`；`Value(data = rows, field = project!(field))` 用于已证明至多一行的表或可选行。展示记录字段时先在 data/do 中绑定该字段，无需制造占位表。

中间 query_remote!/query! 可保持无上界 SQL 计划，供后续聚合、连接、集合运算和排名；不会先取 500 行再计算。只有交付的表和图表输入必须证明不超过 500 行。query_remote! 无 take 时也不写 order_by，排序放在后续 query! 中。is_empty(table) 使用数据库 EXISTS 判断，不拉取全表。take(n) 的 n 为静态整数 1..500，多行取前 N 必须 order_by；已知有界输入的后处理无需重复 take。无分组聚合至多一行，可直接 take_opt()，返回 Option(Schema)。用 `if let Some(row) = highest [...] else [...]` 消费可选行；行存在不代表字段非空，可继续解构字段。

## 时间与展现

顶层 `data ctx = context! { now: Context::Now, tz: Context::ClientTz };` 选择固定上下文快照，返回 Schema({now:EpochMillis,tz:TimeZone})。字段名可自定，只读取声明的选择项；请求 ClientTz 时客户端时区缺失或无效就报错。窗口调用写为 `time_windows({epoch_millis:ctx.now,time_zone:ctx.tz},{unit:TimeUnit::Day,count:3,mode:WindowMode::Complete})`，返回从早到晚的窗口。unit 使用 TimeUnit::Minute/Hour/Day/Week/Month/Quarter/Year，mode 使用 WindowMode::Complete/Current/Rolling，均为枚举而非字符串；选项在检查期确定。每个窗口有 label、zone、start/end，各边界含 epoch_millis/date_time_utc/rfc3339。静态下标如 windows[0].start.epoch_millis 可用于 query_remote! 参数；窗口采用 [start,end)。

对象字段用冒号，tree! 节点属性用等号。True/False/None 首字母大写。tree! 只组织文本、组件引用和条件，不承担复杂计算。唯一回答为 `answer tree! { Answer [...]};`。Value(value = prepared_value) 展示前序值；Value(data = highest,field = project!(cpu)) 展示静态单行结果的字段。字段选择用 project!(field)，不写字符串访问器或匿名函数。

图表及 Table 直接内联在 Answer/Report 中，例如 `BarChart(data = rows,spec = {...})`。spec 不含 kind，组件标签决定种类。完整组件和配置见 oks://help/dari-figures.md。

报告写 `report report = tree! { Report(title = "标题") [...]};`，Answer 用 UseReport(ref = report)。支持 section、h1/h2/h3、p、div/span、ul/ol/li、blockquote、pre/code、strong/em、a、br/hr、Lit、Value。报告内联图表和 HTML 表格，并携带源码及 context 归档。Answer 中的 Table 直接显示 Markdown 表格。

工作纪律与本手册一并完整加载，以共享的 oks://help/rules.md 为准。

## 检查诊断

dari_check 失败时返回 CheckFailed 文本，列出行列位置、相关声明与可确定的修复建议。一次收集多个独立错误，最多展示 20 条并提示剩余数量。类型及计划错误会说明期望与实际、错误原因和适用的修复方式。可空条件需按业务明确空值含义：若空值表示不满足，用 coalesce(原条件, False)，若需保留空值对应的行，可选择 True 或单独表达空值条件；不要机械套用默认值。语法恢复以可靠的括号或声明边界为限；上游声明失败时，依赖它的内容等待修复后再检查。检查失败的稿件不会执行或发布结果。

query_remote! 的行级 filter 可用 is_some(a.optional_dimension) / is_none(a.optional_dimension) 筛选非 NULL / NULL，并可通过 && / || 与其他维度条件组合。使用模型发布的可空、可筛选维度成员；空字符串仍属于非 NULL，不等同于无数据。这些条件在数据库内执行。

非空投影写为 project({field:not_none(expr)})：expr 必须是 Option(T)，该列输出为 T；任一标记列为空则排除整行，其他列保持原类型。not_none 仅允许在投影字段最外层。query! 支持可推导表达式及聚合，query_remote! 支持已发布的可空成员；筛除在投影结果计算后、后续排序和 take 前执行，空字符串不会被排除。带内置 pair 排名的 query_remote! 请在后续 query! 中作非空投影。

共享类型为 Percent、Ratio、EpochMillis、DateTimeUtc、DateTimeTz、TimeZone。Percent(12.0) 与 Ratio(0.12) 展示为 12%，保留原始计算值及各业务 newtype 的约束。时间转换用 to_epoch_millis(t)、to_datetime_utc(t)、to_datetime_tz(t,"Asia/Shanghai")；DateTimeTz 保留偏移和 IANA 时区。EpochMillis 可加减整数毫秒偏移，两个 EpochMillis 相减得到 Int 时长。time_bucket(t,{unit:TimeUnit::Day,time_zone:"Asia/Shanghai"}) 返回桶起点 DateTimeUtc，unit 使用 TimeUnit::Minute/Hour/Day/Week/Month/Quarter/Year，周从星期一开始；可用于 query! 投影。时间比较、排序按瞬时值进行。

声明职责受类型检查：data name = expr; 绑定数据；report name = tree! {Report [...]}; 绑定报告；answer tree! {Answer [...]}; 为唯一交付根节点，不写名称或等号。

query_remote! { ... } 是模型查询计划入口；context! { ... } 只能直接初始化顶层 data，选择 Context::Now / Context::ClientTz，同次 resolve 共享上下文快照。query_remote! 在检查期取得模型证明，执行期绑定参数取数。

`data x = do { let a = ...; a };` 表达局部纯计算：let 不可变、按依赖顺序声明、仅块内可见，末尾表达式决定返回类型。do 可以嵌套并引用数据节点，不能嵌入上下文获取、查询或展示结构；data 才是缓存边界。

图表在 Answer 中生成独立 SVG 附件和 Markdown 图片引用，在 Report 中直接嵌入 HTML；Table 分别输出 Markdown 或 HTML 表格。两个位置分别渲染，输入 data 结果在同一次 resolve 内共享。图表渲染不使用缓存。Answer 和每份 Report 分别按实际展示顺序自动编号，图与表独立计数为“图 1、图 2”和“表 1、表 2”；未选中的条件分支不占编号，作者无需把编号写进 title。

展示宿主内置 Stack::None/Total/Percent，spec.stack 只接受这些枚举值，默认 None。Total/Percent 均要求指标具有加总能力，宽表不同指标只允许并列展示。数值默认最多两位小数、去尾零，Int 保留整数；Percent/Ratio 自动按百分比显示。图表和 Table 用 spec.precision，Value 用 precision = 3 覆盖精度（0..12 静态整数）；显式精度优先于模型默认。显示舍入不改变原始值、计算、排序和 SVG 内嵌数据。

query! { ... } 是关系计划宏，query_remote! { ... } 是模型查询计划宏；tree! { ... } 构造展示树，context! { ... } 选择执行上下文。! 标识特殊语法或语义边界，不等同于副作用或立即执行。普通管道算子保持函数调用形式。

运行期输入、数据与展示错误采用 ResolveFailed 文本并定位负责节点。输入编码错误应修正输入；模型/context 版本变化后重新检查同一稿件；模型结果违背已证明契约属于实现问题，不靠放宽类型、删条件或伪造数据规避。

### 日历区间准备

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

区间端点为 `.start` / `.end`，DateRange 端点为 LocalDate，TimeRange 端点为 EpochMillis。统一使用半开区间，空区间有效，逆向区间报错；普通对象不能冒充区间。日期转瞬时值必须显式指定时区，月末收敛必须显式选择 Clamp。当前这些日历准备函数只在局部计算中使用，不在 SQL 行表达式中展开；地区日历分桶见下节；固定时长分桶、批量分割及 input! 尚未提供。纪律要求保持原有约束。

### 数据库 UTC 分桶

`utc_bucket(value, CalendarUnit::Day)` 支持 DateTimeUtc → DateTimeUtc，Option 输入保留 Option。单位为静态 CalendarUnit::Year/Quarter/Month/Week/Day，周固定从周一 UTC 00:00 开始，不接收时区、字符串单位或隐式 EpochMillis。

query! 中先投影桶字段，再对该字段 group_by 并 project 聚合值。query_remote! 中直接在 project 同时声明分桶维度和模型度量，模型按桶分组，并沿用该度量已发布的聚合规则：

```telora
data rows = query_remote! {
    let a = from(ic::device_kpi);
    let grouped = a |> project({day: utc_bucket(a.device_kpi_ts_raw, CalendarUnit::Day), cpu: a.cpu_usage});
    grouped |> order_by(asc(grouped.day)) |> take(100)
};
```

query_remote! 在投影中支持直接 DateTimeUtc 维度，也支持 `utc_bucket(to_datetime_utc(a.epoch), CalendarUnit::Day)`，先显式转换 EpochMillis 再分桶。也可单独投影 `to_datetime_utc(a.epoch)`；转换的源须为直接 EpochMillis/DateTimeUtc 维度，结果保持 DateTimeUtc 及来源可空性，通过已投影字段排序。SQL 在数据库内完成分桶和聚合，不能取回原始记录自行分组。分桶不补齐空桶，不增加业务类型的聚合权限。IC 符号仅作示例，语言能力不依赖具体模型。

### 地区 TimeZone 分桶

`calendar_bucket(value, CalendarUnit::Day, zone)` 在 query!/query_remote! 中按地区日历分桶，value 为 DateTimeUtc，zone 为非空 TimeZone，结果为 DateTimeUtc，保留输入时间的可空性。支持 Year/Quarter/Month/Week/Day，周从周一开始。EpochMillis 来源显式使用 to_datetime_utc 转换。

```telora
data ctx = context! { tz: Context::ClientTz };
data daily = query_remote! {
    let a = from(ic::device_kpi);
    let grouped = a |> project({day: calendar_bucket(a.device_kpi_ts_raw, CalendarUnit::Day, ctx.tz), cpu: a.cpu_usage});
    grouped |> order_by(asc(grouped.day)) |> take(100)
};
```

也可用顶层 `data zone = TimeZone("America/New_York");`。query_remote! 当前接收类型化时区参数，不把模型成员的普通 String 自动转换为地区身份。模型决定 SQL 语义：PostgreSQL 使用原生 date_trunc，SQLite 适配固定注册地区分桶 UDF；不退化为当前固定偏移。桶键采用 PostgreSQL 的本地午夜消歧，重复午夜取较后瞬时值，跳变午夜按跳变前偏移解释。特殊午夜的规范桶键不能直接用作日期覆盖范围的最早边界；筛选范围仍用 DateRange/at_zone。无效地区报错，无默认时区回退。当前尚未提供公开 DateTimeLocal 转换或固定时长分桶。
