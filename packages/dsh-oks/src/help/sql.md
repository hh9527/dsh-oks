# SQL 后处理（实验）

远端查询结果存入本次运行的临时 SQLite `:memory:`，不修改业务数据库。用一个 SQL asset 声明一条 SELECT/WITH 语句；输入必须是具备 `columns/rows/truncated` 的完整结果集。

```dari
<Dari>
<Pipeline>
base <- query({ /* 从 cap/card 取得查询意图，必填 limit */ });
current <- query({ /* 同一粒度的观察期查询 */ });
comparison <- sql("compare.sql", {base,current});
</Pipeline>
<Asset language="sql" name="compare.sql">
SELECT b.server_id, b.cpu AS base_cpu, c.cpu AS current_cpu,
       c.cpu - b.cpu AS delta
FROM t_base b JOIN t_current c USING (server_id)
WHERE b.cpu IS NOT NULL AND c.cpu IS NOT NULL
ORDER BY delta DESC, b.server_id
LIMIT 3
</Asset>
</Dari>
```

示例的查询意图为占位；列名必须使用 oks_check 返回的实际模型列名。输入键 `base/current` 对应 `t_base/t_current`；通常直接使用同名绑定的简写对象。SQL 只能引用本节点声明的输入表。`sql("next.sql", {comparison})` 引用上一步结果表 `t_comparison`。不要传 `.rows`，否则会丢失列结构。

输出统一为 `{rows,columns,truncated}`。图表 `data={comparison}` 传完整结果集，使检查能验证列映射；报告标量可引用 `comparison.rows[0].delta`，空结果时的处理仍须设计。

oks_check 只用列结构建立同名空表并 prepare SQL，不读远端数据、不执行 SQL，也不返回虚构的结果行。它能检查语法、表名、列名、歧义与下游 SQL/图表引用。SQLite 并非完整类型系统：直接列通常保留声明类型，计算表达式不能可靠推导的类型为 `Unknown`，可空性保守记为 true；隐式转换、除零、实际值与数据相关约束仍在运行期判断。

运行复用本稿查询与后处理缓存；命中缓存的结果也能注册成表。临时连接在本次运行结束后销毁。截断的上游结果会拒绝进入 SQL，避免把局部结果当成全集聚合。后处理输出最多一万行，超出时 `truncated:true`；输入、输出各限制 8 MiB，单步超时 5 秒。业务规则决定排序、并列、缺失值与关联键，不通过运行结果猜测计划。
