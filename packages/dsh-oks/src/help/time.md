# 时间上下文与窗口

分析稿使用 context() 获得冻结的时间上下文，再用 time_windows(ctx,{unit,count,mode}) 生成日历窗口。检查与运行使用相同的时间和时区；显式刷新时重新捕获。

## 参数

- unit：year、quarter、month、week 或 day
- count：1..50 的整数
- mode：complete、current 或 rolling

complete 返回最近 N 个已完成日历周期。current 包含当前周期，最后的结束时间为下一日历边界，可能在未来。rolling 以捕获时刻为终点，每个边界直接从该时刻平移，月末按目标月可用日期收缩，保留毫秒。

窗口按从早到晚排列，每个区间为 [start,end)，周从星期一开始。自然日遵循时区日历规则，可以为 23 或 25 小时。午夜跳时取当天第一个有效时刻；滚动平移采用 Temporal compatible 规则，重复墙钟取较早时刻，缺失墙钟向后平移。若时区历史跳过整日导致窗口没有时长，检查返回诊断，请调整范围。

时区来自当轮用户消息。缺失、冲突或无效时向用户澄清。计算使用显式时区，不能用固定偏移代替日历运算。

## 边界

每个窗口包含 label、zone、start 和 end。start/end 是 TimePoint，直接提供三种字段：

- epochMillis：EpochMillis，UTC epoch 毫秒
- dateTimeUtc：DateTimeUtc，规范 UTC 文本，以 Z 结尾
- rfc3339：String，带本地偏移的展示文本

根据领域维度声明的逻辑类型选择 epochMillis 或 dateTimeUtc。时间角色 ID 说明语义，query.time_windows.dimension 使用实际维度 ID。

```dari
data ctx := context();
data days := time_windows(ctx,{unit:"day",count:7,mode:"complete"});
data facts := query({
  op:"Graph",root:"a",nodes:[{id:"a",entity:"current_alarm"}],edges:[],
  select:[{node:"a",dimension:"alarm_tenant_id"}],
  measures:[{node:"a",measure:"alarm_count"}],
  time_windows:[{node:"a",dimension:"alarm_occur_utc_raw",start:days[0].start.epochMillis,end:days[6].end.epochMillis}],
  limit:500
});
```

本例使用 IC 的 EpochMillis 维度；其他模型按 card 中声明的实际能力替换。DateTimeUtc 维度使用 days[0].start.dateTimeUtc 和 days[6].end.dateTimeUtc。窗口在检查时即可计算，检查只向模型请求校验和列类型，不取业务数据。

逐日计算可以在 map(days,(day)=>...) 中逐窗引用 day.start / day.end。报告展示时保留 rfc3339 和 zone，日期标签不能代替实际边界。
