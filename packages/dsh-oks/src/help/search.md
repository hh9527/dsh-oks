仅使用 va_ask 返回的 ASCII 英文词表原词作为 q，不自行翻译、改写或拼接。

```js
oks_search({q:["cpu"],scope:["datasets/device_kpi"]})
```

q/scope 是非空数组，最多各 12 项；每词独立匹配、最多返回 10 项，没有额外总结果上限。多个 scope 取并集，按知识 ID 去重后排序；词之间不是 AND。匹配名称、别名、说明和规范值，支持部分词及英文轻微拼写错误，不推断同义词。

| scope | 检索范围 |
| --- | --- |
| datasets / entities / types | 对应类别的独立节点 |
| datasets/ID / entities/ID / types/ID | 该根的内部条目，不含自身 |
| datasets/ID/fields、/dimensions、/measures | 字段、维度、指标；Entity 同样支持 |
| datasets/ID/roles、/time_roles、/business_links、/relations | 模型实际声明的对应内容分类；Entity 同样支持 |
| types/ID/values | 枚举成员 |
| types/ID/references | 模型开放反向引用的直接引用点 |

references 返回实际引用点，如 datasets/current_alarm/dimensions/alarm_severity；未开放反向引用时为空，不递归扩展。合法空范围无命中，未知范围报错。回执按词和父路径分段，将父路径与相对名用 `/` 连接即可得到精确 ID，保持原有编码。

