# 时间上下文与窗口

## 输入

在分析稿中定义 ctx <- context();，再定义 windows <- time_windows(ctx, {unit,count,mode});。方法读取 utc.epochMillis 和 tz.client.id，无需手动转换单位或计算固定偏移。

## 时间上下文

context() 采集 utc.epochMillis、utc.epochSeconds、utc.rfc3339 和 tz.client.id。同一采集批次内时间与时区保持不变。时区缺失或冲突时向用户澄清；将窗口边界转换为领域时间维度声明的逻辑格式。

## time_windows 参数

- unit：year | quarter | month | week | day。
- count：整数，范围 1..50。
- mode：必填，为 complete | current | rolling。

## 窗口语义

### complete

最近 N 个已完成的日历周期，不包含当前周期。

### current

包含当前周期的 N 个日历周期。最后的 end 为下一日历边界，可能位于未来。

### rolling

以时间上下文时刻为终点的 N 个连续日历长度窗口。所有边界直接从该时刻平移，月末按目标月可用日期收缩，保留毫秒。

### 边界与标签

每个区间为 [start,end)，按从早到晚排序。周从星期一开始，各边界分别应用时区规则（含夏令时）。label 使用 YYYY-MM、YYYY-Qn、YYYY 或起始日期；rolling 使用起点的 RFC3339。

## 调用示例

### 已完成的月份

ctx <- context(); months <- time_windows(ctx, {unit:"month",count:3,mode:"complete"}); {months}

### 包含本月

months <- time_windows(ctx, {unit:"month",count:3,mode:"current"});

### 已完成的周

weeks <- time_windows(ctx, {unit:"week",count:4,mode:"complete"});

### 滚动月窗口

months <- time_windows(ctx, {unit:"month",count:1,mode:"rolling"});

## 底层时间函数

### 输入

所有底层时间函数接收 epoch 秒。使用上下文中的 utc.epochSeconds，或将 epochMillis 除以 1000。

### 向下对齐

tzfloor(unit; zone) 返回包含输入时刻的日历周期起点，单位为 day/week/month/quarter/year。

### 下一周期起点

tzceil(unit; zone) 返回下一个日历周期起点，即使输入已经位于边界也如此。单位与 tzfloor 相同。

### 平移

tzadd(unit; amount; zone)：日历单位为 year/quarter/month/week/day，时长单位为 hour/minute/second。

### 边界复核

strftime_tz("%Y-%m-%dT%H:%M:%S%.f%:z"; zone) 将底层计算的边界格式化为可读文本。

## 返回形状

根据显式 context() 生成日历窗口，按从早到晚排序。每个窗口为 [start,end)，包含 label、zone，以及 epochMillis 和 RFC3339 边界。
