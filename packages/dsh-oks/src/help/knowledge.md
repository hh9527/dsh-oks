# 知识图的形状与导航

## 先理解知识图的整体形状

oks://knowledge 可以看成一个完整的大 JSON 文件，用 oks_project 读取、处理和投影，根分支、形状和直接成员数量由当前图的实际键动态生成，显示在本页的当前工作区概览及会话工具导航中。对象分支保存按 ID 索引的事实和分类关系；items 是说明条目数组，保存 {key,names,doc}。名称和说明与事实分开存放，内置 read 方法可以配对读取。

Entity、Dataset、DimensionGroup、MeasureGroup、Type、Relation 和 Tool 都是独立节点；Dataset 的 fields、roles、bindings、dimensions 等及 Type 的 values 是节点内成员。自有成员用字典内嵌，关联目标用地址数组表达。引用按类别组织，工具层生成反向引用；理解一个节点时可以沿关系继续探索，也可以仅投影所需分支。

同名字段在不同位置可能有不同形状：datasets.<id>.fields 是自有字段字典，types.<id>.fields 是使用该类型的字段地址数组。判断自有成员和引用要结合所在位置与实际 shape，不能把所有 links 混为同一种结构。

知识图的事实来自领域模型，tools 中的用法知识由工具初始化时挂载。下面是结构示意，不代表当前领域实际存在这些 ID，也不授予任何查询能力。

已知分支的含义如下；未知分支也会进入动态概览，完整目录与节点数量以当前模型的 `:keys` 和各分支 `:len` 为准。结构示例中的 ID 和成员不用于推断目录是否完整。

| 根分支 | 节点类型 | 用途 |
|---|---|---|
| `entities` | Entity | 业务身份及其身份类型，独立于具体数据集 |
| `datasets` | Dataset | 物理数据源、行类型、粒度、字段及已绑定的查询能力 |
| `dimension_groups` | DimensionGroup | 可复用维度定义，通过 Dataset 的 bindings 映射到输入字段和公开维度 |
| `measure_groups` | MeasureGroup | 可复用度量定义及统计约束，通过 Dataset 的 bindings 发布具体度量 |
| `types` | Ty | 领域类型、规范值域及显式允许的反向引用 |
| `relations` | Relation | 数据集之间声明的关系与连接约束 |
| `tools` | Tool | 插件提供的工具用法知识 |
| `items` | 说明条目数组 | 通过 key 配对节点及成员的名称与说明 |

### 结构示意

```json
{
  "entities": {},
  "dimension_groups": {},
  "measure_groups": {},
  "datasets": {
    "current_alarm": {
      "fields": {"severity": {"nullable": false}},
      "dimensions": {"alarm_severity": {"type": "Severity", "fields": ["datasets/current_alarm#fields/severity"]}},
      "measures": {},
      "time_roles": {},
      "relations": ["relations/alarm_belongs_to_tenant"]
    }
  },
  "types": {
    "Severity": {
      "reverse_references": true,
      "values": {"major": {}},
      "fields": ["datasets/current_alarm#fields/severity"],
      "dimensions": ["datasets/current_alarm#dimensions/alarm_severity"]
    }
  },
  "relations": {"alarm_belongs_to_tenant": {"from_dataset": "current_alarm", "to_dataset": "tenant"}},
  "tools": {"render_figure": {"kinds": {}, "topics": {}}, "report": {"topics": {}}},
  "items": [{"key": "datasets/current_alarm", "names": ["当前告警"], "doc": "业务口径与约束"}]
}
```

## 从概览逐层理解事实与关系

先读取根目录 `:keys`，再查看实际分支的 keys 和 len，了解节点类别及规模。不要根据示例列举的节点类别判断当前模型缺少某种知识。再选择相关 Entity、Dataset、Group 或 Type，读取自身事实、所需成员和对应说明。字段、维度、度量与时间角色各有用途；业务可用能力以实际声明为准。沿分类引用查相关节点时，只展开需要的类别。

不必读取整个大节点：可以同时选择 grain、scope 等自身事实，并将 fields、dimensions、measures 等分支投影为 keys 或 len。需要值域时只选 values。需要名称和说明时，使用 read 配对读取小分支，或用 search、members 和 references 导航。

```json
{"input":"oks://knowledge","select":"entities:len,datasets:len,dimension_groups:len,measure_groups:len,types:len,relations:len,tools:len,items:len"}
```

## 地址与事实

### 数据根

oks_project 以 oks://knowledge 为输入时直接接收当前模型的知识图根对象，根键由实际对象决定，不以本文的示例清单为边界。字典键使用原始业务 ID，items 为 [{key,names,doc}]。

### 语义地址

独立节点地址为 entities/<编码后的ID>、datasets/<编码后的ID>、dimension_groups/<编码后的ID>、measure_groups/<编码后的ID>、types/<编码后的ID>、relations/<编码后的ID>、tools/<工具名>。工具成员为 #kinds/<类型>、#topics/<主题>；节点成员为 node#fields/<编码后的ID>、#roles/<ID>、#bindings/<ID>、#dimensions/<ID>、#measures/<ID>、#time_roles/<ID>、#business_links/<ID> 或 types/<ID>#values/<ID>。地址中的每个 ID 恰好进行一次 URI 组件编码，返回的 key 应原样使用；字典键保持原始 ID。

### 工具知识

tools.render_figure 包含 kinds 与 topics，tools.report 包含 topics。工具知识由插件注入，描述渲染和 Report 用法，与模型事实共用 search/read/members/references 导航。可以独立读取图表类型或主题，示例包含可执行的示例数据。

### 分类导航

Dataset 拥有 fields/roles/bindings/dimensions/measures/time_roles/business_links 字典；Role 引用 Entity，Binding 引用可复用 Group，具体维度和度量引用自己的 Binding 与 Group。Type 拥有 values 字典；只有 reverse_references 为 true 时才提供 fields/dimensions 等使用方的反向引用。工具根据归属和正向事实派生允许的反向引用；related/traversable 保留关系类别，referenced_by 提供反向导航。引用数组保存地址，自有字典保存事实；引用表达关联，查询权限以模型声明为准。

### 类型的字段引用

显式允许反向引用的 types.<id>.fields 包含通过声明该值类型的维度暴露的字段。这是导航信息，不表示原始存储字段的类型。维度的 type 为声明的值域 ID，input_kinds 为可接受的字面量类型。

### 分支投影

选择分支只读取该分支，例如 .types.Severity.values 不包含 fields。名称与说明位于 items，read 将事实片段与说明配对。事实保留业务约束，包括空值、顺序、范围、时间编码与确定性的 Latest 选择规则。

## 调用示例

### 根目录

```json
{
  "input": "oks://knowledge",
  "select": ":keys"
}
```

### 分支目录

```json
{
  "input": "oks://knowledge",
  "select": "entities:keys[0..10],datasets:keys[0..10],dimension_groups:keys[0..10],measure_groups:keys[0..10],types:keys[0..10],relations:keys[0..10],tools:keys,items:len"
}
```

### 检索

```json
{
  "input": "oks://knowledge",
  "transform": {
    "lib": "oks://builtin/tools/ktools.lib.jq",
    "name": "search",
    "args": {
      "query": "<va_ask 返回的词汇>",
      "take": 10
    }
  }
}
```

### 读取事实与说明

```json
{
  "input": "oks://knowledge",
  "transform": {
    "lib": "oks://builtin/tools/ktools.lib.jq",
    "name": "read",
    "args": {
      "key": "<返回的地址>"
    }
  }
}
```

### 维度成员

```json
{
  "input": "oks://knowledge",
  "transform": {
    "lib": "oks://builtin/tools/ktools.lib.jq",
    "name": "members",
    "args": {
      "key": "datasets/<返回的编码ID>",
      "link": "dimensions",
      "take": 10
    }
  }
}
```

### 只读值域

```json
{
  "input": "oks://knowledge",
  "select": "types.'<原始类型ID>'.values"
}
```

### 反向引用

```json
{
  "input": "oks://knowledge",
  "transform": {
    "lib": "oks://builtin/tools/ktools.lib.jq",
    "name": "references",
    "args": {
      "key": "<返回的地址>"
    }
  }
}
```

### 字段说明

```json
{
  "input": "oks://knowledge",
  "transform": {
    "lib": "oks://builtin/tools/ktools.lib.jq",
    "name": "read",
    "args": {
      "key": "datasets/<返回的编码ID>#fields"
    }
  }
}
```

### 数据集概览

```json
{
  "input": "oks://knowledge",
  "transform": {
    "lib": "oks://builtin/tools/ktools.lib.jq",
    "name": "overview",
    "args": {
      "take": 10
    }
  }
}
```

### 数据集卡片

```json
{
  "input": "oks://knowledge",
  "transform": {
    "lib": "oks://builtin/tools/ktools.lib.jq",
    "name": "card",
    "args": {
      "id": "<原始数据集ID>",
      "section": "dimensions",
      "docs": true,
      "take": 10
    }
  }
}
```

### 批量读取节点

```json
{
  "input": "oks://knowledge",
  "transform": {
    "lib": "oks://builtin/tools/ktools.lib.jq",
    "name": "nodes",
    "args": {
      "keys": [
        "<返回的地址>"
      ],
      "mode": "both",
      "take": 8
    }
  }
}
```

### 探索连接

```json
{
  "input": "oks://knowledge",
  "transform": {
    "lib": "oks://builtin/tools/ktools.lib.jq",
    "name": "routes",
    "args": {
      "nodes": [
        "<返回的起点地址>",
        "<返回的终点地址>"
      ],
      "max_depth": 3,
      "max_paths": 5,
      "budget": 1000
    }
  }
}
```

### 自定义方法

```jq
def dataset_dimensions($args): .datasets | to_entries | map({id:.key,dimensions:(.value.dimensions|keys)});
```

## 分页与预算

search/members/references 默认 skip=0、take=10（范围 1..50），用 next 作为下一页的 skip；read 必须提供 key。其他方法的分页与上限见下方说明。方法在 Wasm jq 引擎中运行。用 oks_read 阅读 oks://builtin/tools/ktools.lib.jq；自定义 def name($args): ...; 方法保存在 oks://memory/tools/ktools.lib.jq，跨会话及工作区清理保留。库只包含定义和注释，保存前先编译，通过后替换有效文件。最终返回限 16 KiB，可缩小分支或使用内置分页。

## 按需查看知识分支

用 oks_project 的 select 字符串精确选择知识分支。选择路径保留原有层级，未选择的兄弟分支不会自动展开；例如 types.Severity.values 不会同时带上 fields。先用 datasets:keys 或 datasets:len 看目录，再选择实际节点。通用规则见 oks://help/project.md，示例 ID 仅为示意。

投影语法见 `oks://help/project.md`。

## 方法库

### 内置方法库

阅读 oks://builtin/tools/ktools.lib.jq，理解知识图形状与基本方法。该库只读。

### 持久方法库

oks://memory/tools/ktools.lib.jq 保存已积累的自定义方法。通过完整库地址选择方法，同名方法互不覆盖。

### 编写方法

持久库只保存注释和 def name($args): ...; 定义。保存前先编译，内容无效时保留上次有效源码。该库跨会话及工作区清理保留。

## 查询帮助

用 oks_read({path:"oks://help/query.md"}) 阅读查询帮助。领域词汇用 va_ask 寻找线索，再通过检索和事实核实。

## 内置方法说明

### search

检索 ID、名称和说明，返回精确语义地址与精简匹配结果。

### members

读取分类出向引用或自有成员。link 选择 fields/dimensions/values 等类别，type 可选，用于限制目标类型。

### references

查找指向精确语义地址的入向引用；可按类别 link 和来源类型 type 筛选。

### read

配对读取事实与说明。key 可指向节点、成员或 datasets/alarm#dimensions 这样的分类分支；只展开所选分支。

### overview

列出数据集的名称、粒度和能力数量。稳定分页：skip=0、take=40（1..50）。include_source 默认为 true；显式设为 false 时过滤 source_ 开头的 ID。数量用于导航，查询权限以模型声明为准。

### card

用原始字典 id 读取数据集卡片，包含粒度、维度允许的操作、度量、时间编码、关系基数和值域。section 为 all/shape/dimensions/measures/time_roles/relations/values；默认 skip=0、take=20（1..50）、docs=false。counts 和 pages 按分段报告总量、截断与下一页偏移。值域各有 total/truncated/next；value_skip=0 控制域内值分页。所有值 ID 均保留。

### nodes

用 keys 批量读取至多 50 个语义地址。mode=docs 返回说明和提纲，facts 返回精简结构，both 同时返回两者。take=8（1..50）限制各成员列表，并返回 total/truncated。expand 指定完整展开的事实字段，docs=false 省略说明。编码地址原样使用，未知地址逐项返回错误。直接结构投影可用 select。

### routes

在 nodes 中给出恰好两个语义地址，查找有向简单路径。默认 max_depth=3（0..8）、max_paths=20（1..50）、budget=20000（1..20000 条检查边）。via 限制边类别；avoid 排除地址包含指定子串的目标。分类边保留 related.datasets 等类别名。扩展过程受限：truncated 表示路径数或搜索预算耗尽，depth_capped 表示深度限制下仍有未探索分支。受限搜索没有找到路径，不足以证明不连通。路径用于导航，写查询前仍需核实模型关系与基数。
