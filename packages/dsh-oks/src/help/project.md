# oks_project：读取、处理与投影

## input → transform → select

`oks_project({input})` 读取结构化资源。可选的 `transform:{lib,name,args}` 先调用 jq 方法，再由可选的 `select` 投影完整结果。没有 transform 时，select 作用于输入资源。

工具最后将结果包装在 `.data` 中；select 不包含这层包装。只有资源本身确有 `data` 字段时，才选择 `data`。

```json
{"input":"oks://knowledge","select":"{datasets:keys[0:10],types:len}"}
```

```json
{"input":"oks://knowledge","transform":{"lib":"oks://builtin/tools/ktools.lib.jq","name":"search","args":{"query":"告警"}},"select":"{total,items[0:5]:map({id,key,label}),next}"}
```

结构化资源包括 `oks://knowledge`、保留的 `oks://work/分析.dari#binding`、`#figures.name`、`#reports.name`、`#output`、`#diagnostics` 和 `#meta.binding` 等。读取、处理与投影不会运行分析稿、执行 SQL、刷新或保存文件。

## 快速语法

| 语法 | 含义 |
| --- | --- |
| `ports.rows` 或 `.ports.rows` | 选择路径，保留原层级 |
| `{rows,columns,truncated}` | 组合投影 |
| `owner.{id,name}` | 在 owner 下组合投影 |
| `datasets.'name/with spaces'` | 单引号引用含标点或空格的键 |
| `items[0:25]` | 切片，包含起点、不含终点 |
| `:keys` | 读取根对象的排序键数组 |
| `datasets:len` | 读取字典成员数量 |
| `a?.b.{c?:len,d}` | 可空或缺失字段的显式短路 |
| `items:map({id,name})` | 对数组中的每项执行投影 |
| `datasets:map({grain,dimensions:keys})` | 对字典中的每个 value 投影，保留字典键 |

组合投影必须用 `{…}` 包围，逗号仅用于组合内部。`a.{b,c}` 与 `{a.b,a.c}` 等价，结果递归合并。完整值与其局部投影冲突时明确报错。空组合不允许。

字段名为原始业务 ID，不使用语义地址中的 URI 编码。单引号键支持 `\'` 和 `\\` 转义。引号内的逗号、冒号等字符属于键名。

## 切片与链式操作

`x[start:end]` 接受两个安全整数，采用左闭右开区间。负数从末尾计数，数组和字符串的行为与 JavaScript slice 一致。`[0:10]` 可直接切片根数组。对象取样先用 `:keys[0:10]`。

后缀从左到右处理当前值。`:keys` 对对象返回确定性排序的键数组，对其他值返回 null。`:len` 对数组返回长度，对对象返回成员数，对其他值返回 null。

```text
{rows[0:5],columns,truncated}
datasets:keys[0:10]
items[-5:-1]:map({id,name})
items:map({id}):len
```

切片不会判断业务结果是否完整；查询结果的 `truncated` 和统计口径需要单独核实。

## map：逐项执行同一套投影语法

`:map(p)` 的参数是一个完整投影表达式，不限于字段组合。对数组逐项执行 p 并返回数组；对对象逐 value 执行 p 并保留原键；null 和其他输入类型报错；用 `?` 显式处理可空值。对象一律视为字典，单个业务对象直接用路径或组合投影。

```text
items:map(id)
items[0:25]:map({id,owner.{name,email}})
items:map({id,ports[0:10]:map({name,status})})
datasets:map({grain,dimensions:keys})
:map({name,children:map({id})})
```

`map(id)` 对每项执行保留字段层级的投影，因此输出数组元素为 `{id:值}`，不会自动解包成标量。map 内允许嵌套 map、切片、分组、算子和 `?`。数组或字典中可能含 null 时，用 `:map(?.{id,name})` 显式短路。

## ?：可空或缺失字段的投影

`?` 表示对当前值做可选投影：当前值为 null 时保留字段并返回 null；紧邻它之前访问的字段不存在（absent）时省略当前字段。两者均跳过当前分支的后续投影；否则继续执行。作用域到组合的逗号、右花括号或 map 参数的右括号为止。false、0、空字符串、空数组和空对象不会短路。

```text
a?.b.{c?:len,d}
owner?.{id,name}
items?:map({id})
items:map(?.{id,name})
{owner?.{name},count}
```

`a?.b.{c?:len,d}` 中 a 不存在时输出 `{}`，为 null 时输出 `{a:null}`。a 存在时，b 必须存在且为对象；b 也可缺失或为 null 时写成 `a?.b?.{…}`。c 不存在时省略 `c:len`；c 为 null 时输出 `"c:len":null`。d 仍按普通规则选择。

`?` 省略字段时只影响当前对象投影，不删除 map 的数组元素或字典条目。例如 `:map(a?)` 将输入 `[{}, {a:null}]` 投影为 `[{}, {a:null}]`；字典键同样保留。

`?` 只处理明确标记处的 absent/null，不吞掉后续缺失字段或类型错误。`a?.b` 在 a 存在而 b 缺失时仍报错；用 `a?.b?` 显式允许缺失的 b。未加 `?` 的路径、组合、切片和 map 按输入类型检查；直接读取已有的 null 字段仍返回 null。

`:keys/:len` 对不支持的标量返回 null 的行为保持一致；`?` 可短路整个后续分支。缺失字段只能由紧跟字段的 `?` 处理，例如 `c?:len`；`c:len?` 不能处理缺失的 c。

## 输出形状

路径保留原层级。字段的算子和切片写入输出键名；map 记录为 `:map`，参数表达式不进入键名。根操作直接返回结果，不额外包装字段。`?` 是控制短路的标记，不进入输出键名；短路后的后缀仍记录在键名中。

| select | 输入 | 输出 |
| --- | --- | --- |
| `a.b` | `{a:{b:1,c:2}}` | `{a:{b:1}}` |
| `a[1:3]` | `{a:[0,1,2,3]}` | `{"a[1:3]":[1,2]}` |
| `a:len` | `{a:[1,2]}` | `{"a:len":2}` |
| `a:map(id)` | `{a:[{id:1,x:2}]}` | `{"a:map":[{id:1}]}` |
| `:map(?.{id})` | `{x:{id:1},y:null}` | `{x:{id:1},y:null}` |

组合中的多个分支如果映射到相同输出键且不能递归合并，会报冲突，避免静默丢失结果。

## 错误与预算

语法错误包含位置、合法示例及帮助地址。select 只做结构投影；筛选、排序、关联和计算使用 jq transform，不使用 jq 管道或对象构造语法。

select 最多 16384 字符、1024 个投影表达式、64 层嵌套，每条路径最多 256 步。公共返回预算为 16 KiB。超限时返回 `{error:"payload_too_large",repr,reprLength,len}`：repr 为 JSON.stringify(data) 的前 4096 个字符，reprLength 为完整字符串的 JavaScript 长度。repr 是预览，不保证是完整 JSON；用切片、map 和更精确的投影缩小结果。

transform 的内部输出预算是 8 MiB、执行时间预算是 5 秒；随后应用 select，再检查公共返回预算。内部超限时收窄 transform，公共返回超限时可以重新投影完整的保留结果。

## jq 方法与帮助

`transform.lib` 为 `oks://builtin/tools/ktools.lib.jq` 或 `oks://memory/tools/ktools.lib.jq`，`name` 为方法名，`args` 为传入的 JSON 对象。方法接收完整资源，恰好输出一个 JSON 值。同名方法通过完整库地址区分。

用 `oks_read({path:"oks://help/project.md"})` 阅读本语法，offset/limit 按行分页；`oks://help/knowledge.md` 说明当前知识图，`oks://help/query.md` 说明查询契约。帮助是文本资源，用 oks_read 阅读。
