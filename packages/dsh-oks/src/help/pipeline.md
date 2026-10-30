# 有类型的关系 Pipeline

计算声明为 `data name := expression;`，先定义后引用。图表与报告使用 DOM-like 节点，见 `oks://help/draft.md`。

query 的 columns 由模型在检查期返回，直接参与本语言的类型推导。后处理使用有签名的表达式；所有表列均有明确类型和可空性。模型列的 nullable:true 对应 Option(T)。字段名必须使用模型实际返回值，通常带节点名前缀。

## select

```text
data comparison := select({
  from:{b:base},
  joins:[{kind:"inner",source:{c:current},on:(r)=>r.b.server_id == r.c.server_id}],
  where:(r)=>is_some(r.b.cpu) && is_some(r.c.cpu),
  fields:(r)=>({id:r.b.server_id,base_cpu:r.b.cpu,current_cpu:r.c.cpu,delta:r.c.cpu-r.b.cpu}),
  order_by:(out)=>[desc(out.delta),asc(out.id)],limit:3
});
```

from 恰好声明一个别名和表。joins 按顺序引入别名，支持 inner/left。on/where 必须返回 Bool。fields 返回具名标量记录，决定输出列名。order_by 使用投影后的 out；limit 选择子集时指定排序。asc/desc 默认空值排最后，可加 `{nulls:"first"}`。

left join 的右行是 Option(记录)，使用 `r.tenant?.name ?? "未关联"`。当前 join 的 on 可以访问尚未补空的当前右行；后续表达式处理其可空性。类型检查不证明关联键唯一，join 的匹配粒度由模型与业务口径决定。

数值运算支持 Int/Float 提升，不进行 String 与数字隐式转换。Option 上的算术得到 Option，缺失不自动补零。除法返回 Option(Float)，零除数得到 None。可空比较得到 Option(Bool)，作为谓词时显式写 `(r.s.cpu > 0) ?? false`。`x == null` 等价于 is_none(x)。

## select_one

```text
data winner := select_one({
  from:{s:comparison},fields:(r)=>({id:r.s.id,delta:r.s.delta}),
  order_by:(out)=>[desc(out.delta),asc(out.id)],limit:1
});
data name := winner?.id ?? "无匹配对象";
```

返回 Option(记录)，零行为 None，一行为对象，多行报 CardinalityViolation。它不会默认取第一行。第一名使用显式排序与 limit:1；唯一匹配可以保留多行守卫。表不能当普通对象投影，Report 标量通过 select_one 得到。

## 分组

```text
data groups := select({
  from:{s:samples},group_by:(r)=>({tenant:r.s.tenant_id}),
  fields:(g,rows)=>({tenant:g.tenant,n:count(rows),valid:count(rows.s.cpu),cpu:avg(rows.s.cpu)}),
  having:(out)=>out.valid > 0,
  order_by:(out)=>[desc(out.cpu),asc(out.tenant)]
});
```

分组 fields 接收 `(g,rows)`，g 是分组键，rows 的列只能用于聚合。count(rows) 计行，count(列) 计非空值；sum/avg/min/max 忽略缺失。sum/min/max 返回 Option(原类型)，avg 返回 Option(Float)，count 返回 Int。`group_by:(r)=>({})` 是全局聚合，空表也有一个组，其 count 为零、sum/avg/min/max 为 None。

给定或演示数据可用 `table([{name:"示例",count:3}],{kind:"example"})` 建立表，列类型从已知记录推导；空数组或全 null 列缺乏类型依据时会报错。业务事实由 query 获取。

## 其他表达式

- is_some / is_none：Option → Bool
- `x?.field`：可选记录投影，展平 Option
- `x ?? fallback`：显式缺失行为
- map_opt(x,(v)=>expr)：处理可选普通对象或标量
- round(number,digits)：保留数值类型及可空性，digits 为已知 0..15
- concat(a,b,...)：连接字符串，保留缺失
- case_when(test,a,b)：test 为 Bool，两个分支类型兼容
- 窗口边界的 dateTimeUtc / epochMillis：直接提供 DateTimeUtc / EpochMillis；rfc3339 用于本地时间展示

## 有限展开

`map(days,(day)=>query({...}))` 对已知、有界数组展开计划，每个查询都返回 columns 参与检查。map 支持第二个 index 参数，最多 50 项；全稿最多 128 个查询。业务结果不能决定新的 query 参数或数量。

`union_all(parts)` 合并同 schema 的表数组，保留重复行；列名和顺序必须一致，Int/Float 可提升。空表保留类型；没有 schema 的空表数组不能合并。合并后需要顺序时再用 select 排序。

## 检查与执行边界

oks_check 不读业务数据库，检查字段、作用域、类型、Option、聚合、图表映射和 Report 标量。运行时仍检查远端 schema/值域、输入完整性、select_one 行数及资源限制。数据在按会话与分析稿隔离的临时 SQLite 文件中计算；同一分析稿多次运行复用缓存，运行期间保留，最后一次运行结束后空闲 15 分钟关闭并删除，下次运行自动重建。检查使用独立的内存库，只准备表结构，不延长执行缓存有效期。SQL 由编译器生成；语言侧只使用有类型的 Pipeline。
