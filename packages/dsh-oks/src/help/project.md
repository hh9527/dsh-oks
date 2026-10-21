# oks_project：直读、jq 处理与规则投影

## overview

### title

input → transform（可选）→ select（可选）

### text

oks_project({input}) 直接读取结构化资源。transform 用 {lib,name,args} 指定 jq 方法，select 用字符串表达投影规则；两者可以同时提供，固定先处理、再投影。select 作用于 transform 的完整结果；没有 transform 时作用于输入资源。返回负荷统一在 .data 中。

oks://knowledge 视为一个完整的大 JSON 文件。结构化输入包括该知识图、已运行的 oks://work/分析.dari#binding、#figures.name、#reports.name 等。读取、处理和投影都不会执行 SQL、运行分析稿、刷新采集或保存文件。

### examples

```json
{
  "read": {"input":"oks://knowledge"},
  "select": {"input":"oks://knowledge","select":"datasets:keys[0..10],types:keys"},
  "transform": {"input":"oks://knowledge","transform":{"lib":"oks://builtin/tools/ktools.lib.jq","name":"search","args":{"query":"告警","take":10}}},
  "compose": {"input":"oks://knowledge","transform":{"lib":"oks://builtin/tools/ktools.lib.jq","name":"search","args":{"query":"告警","take":10}},"select":"total,items[0..5],next"}
}
```

## paths

### title

路径、引号键与组合

### text

a.b 保留层级，得到 {a:{b:input.a.b}}。字段名有空格、点、冒号、斜线等标点时，用单引号包围，例如 a.'hello world'。引号内用反斜线转义单引号或反斜线；字典键使用原始业务 ID，不使用知识地址中的 URI 编码。

a.{b,c} 同时选择两个字段；a.{b,c.{x,y}} 可以嵌套。a.b,a.c 与 a.{b,c} 等价，结果递归合并。完整值与其局部投影发生输出冲突时明确报错。缺失字段会报出路径；已有字段为 null 时正常保留。未知结构先查看 :keys。

### examples

```json
{
  "branch": {"input":"oks://knowledge","select":"types.Severity.values"},
  "members": {"input":"oks://knowledge","select":"datasets.current_alarm.{fields:keys,dimensions:keys,measures:keys}"},
  "specialKey": {"input":"oks://knowledge","select":"datasets.'name/with spaces'.fields:keys"}
}
```

## operators

### title

链式调用与输出键名

### text

x:ff 等效于 ff(x)，x:ff:gg 等效于 gg(ff(x))。内置算子为 len、keys。后缀从左到右处理当前值，最后包装投影结果。字段路径保留层级；该字段的算子和切片记录在输出键名中。

a:len 输出 {"a:len":len(input.a)}。a.{b:keys:len} 输出 {a:{"b:keys:len":len(keys(input.a.b))}}。len 名称始终保持为 len，不转换为 length。

len 对数组返回 length，对 object 返回键数量，对标量（含字符串与 null）返回 null。keys 对 object 返回按确定性字符串顺序排序的键数组，对其他类型返回 null，排序不依赖 locale。

没有字段前缀的 :keys、:len 直接作用于根值并返回结果，不额外包装字段。

### examples

```json
{
  "root": {"input":"oks://knowledge","select":":keys"},
  "count": {"input":"oks://knowledge","select":"datasets:keys:len"},
  "sampleKeys": {"input":"oks://knowledge","select":"datasets:keys[0..10]"}
}
```

## slices

### title

切片与取样

### text

x[0..100] 等效于 slice(x,0,100)，采用包含 start、不包含 end 的区间。边界是安全整数，负数从末尾计数。支持数组与字符串，行为与 JavaScript slice 相同；object 先用 :keys 取得排序键数组再切片。

a[1..10] 返回 {"a[1..10]":input.a.slice(1,10)}。a:keys[0..10]:len 返回 {"a:keys[0..10]:len":len(slice(keys(input.a),0,10))}。根切片 [0..10] 直接返回切片数组，适合读取诊断和根数组结果。

切片不会替你判断业务结果是否完整；查询结果中的 truncated 和业务统计口径应单独核实。

### examples

```json
{
  "rows": {"input":"oks://work/分析.dari#facts","select":"rows[0..5],columns,truncated"},
  "diagnostics": {"input":"oks://work/分析.dari#diagnostics","select":"[0..10]"},
  "size": {"input":"oks://work/分析.dari#diagnostics","select":":len"}
}
```

## overflow

### title

超限摘要

### text

公共返回预算为 16 KiB。超过预算时返回 {error:"payload_too_large",repr,reprLength,len}。repr 是 JSON.stringify(data) 的前 4096 个字符；reprLength 是该完整 JSON 字符串的长度，按 JavaScript string.length 计算，不是 UTF-8 字节数。len 对数组和字符串为 length，对对象为 Object.keys(data).length，对其他值为 null。repr 是预览，可能不是完整、可解析的 JSON；用更精确的 select 或 transform 取得所需数据。

## transform

### title

利用 jq 方法检索、计算和加工

### text

transform.lib 是完整库地址，transform.name 是方法名，transform.args 是直接传递的 JSON 对象，省略时为 {}。方法接收资源的完整值，并恰好输出一个 JSON 值。内置方法库为 oks://builtin/tools/ktools.lib.jq，自定义持久库为 oks://memory/tools/ktools.lib.jq；用 oks_read 阅读源码。同名方法不会覆盖或自动回退。

结构选择、概览与取样优先使用 select。筛选、排序、关联或计算可用 jq 方法。纳入分析稿并保留依赖链的计算写在 DARI 中。

transform 的内部输出预算是 8 MiB、执行时间预算是 5 秒。随后应用 select，最后由公共出口检查 16 KiB 返回预算。大中间结果可以经 select 缩小；内部预算超限则需要收窄 transform。公共返回超限时提供上述摘要；原始数据保持完整，可重新投影读取。

## resources

### title

帮助主题与来源

### text

oks:// 是虚拟文件系统。oks://help/*.md 是只读 Markdown 文本文件，用 oks_read({path:"oks://help/project.md"}) 阅读，offset/limit 按行分页；用 oks_list({path:"oks://help/"}) 列出文件。文本帮助不作为 oks_project 的结构化输入。

已运行输出的来源与取值路径通过 oks://work/分析.dari#meta.<binding> 读取。编辑后的已有结果会标记 stale，重新运行分析稿后才产生新结果。诊断可用根切片分批读取，用 :len 查询数量。
