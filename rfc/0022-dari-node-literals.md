# RFC 0022：DARI 节点字面量

状态：草案。跟踪：https://github.com/hh9527/dsh-oks/issues/59

## 目标

DARI 使用节点树定义图表、报告和回答。节点与表达式中的函数调用具有不同含义，应在每个节点的入口直接标识节点，并让节点树的结构与缩进保持一致。

## 声明与节点

节点以独立的 ASCII 撇号 token `'` 开始，后接标签名、可选属性和可选子节点列表。每个节点都带撇号，包括子节点和条件分支中的节点。撇号与标签之间允许空白和注释，与其他 token 一样处理。

```dari
data facts = table([{name:"设备甲",cpu:42.5}],{kind:"example"});
figure usage = 'ColumnChart(spec={x:"name",value:"cpu"},data=facts);
report full = 'Report(title="资源报告") [
  'h1 ["资源报告"],
  'p ["设备 CPU", 'strong ["概况"]],
  'UseFigure(ref=usage,caption="设备 CPU"),
];
answer 'Answer [
  'p ["分析结果如下"],
  'UseReport(ref=full),
];
```

`figure` 和 `report` 以 `=` 引入具名声明的值；唯一的 `answer` 直接跟节点字面量。每条声明以分号结束。`figure` 根节点为图表组件或 `Table`，`report` 根节点为 `Report`，`answer` 根节点为 `Answer`。已有的组件、属性、引用顺序、类型和呈现约束继续适用。

节点字面量只出现在 `figure`、`report` 和 `answer` 的值及其子节点位置。`data` 和属性值使用表达式文法，不接受节点字面量。节点不是一等值，也不提供节点构造器调用。属性名 `children` 不合法；子节点只能写在方括号中。

节点写法是构造节点树的局部语法糖。概念上，`'Tag(attrs) [children]` 对应 `create_tree_node("Tag", attrs, children)`：标签名标识节点类型，属性保存各自的表达式，子节点按顺序组成列表，嵌套节点递归构造。省略属性或子节点时分别视为空属性集合或空子节点列表。条件分支按既有规则决定实际呈现的子节点。

这里的 `create_tree_node` 仅用于说明结构，并非 DARI 函数或要求实现直接调用的接口。属性的静态值、绑定引用和表达式仍按各组件的既有规则检查与处理；这个模型不规定属性统一求值，也不改变检查期和运行期的边界。

## 文法

以下文法描述节点入口和边界，`Expr`、`Name`、`String` 及条件表达式遵循 DARI 现有规则。逗号分隔的列表允许尾逗号。

```text
FigureDecl  := "figure" Name "=" Node ";"
ReportDecl  := "report" Name "=" Node ";"
AnswerDecl  := "answer" Node ";"
Node        := "'" Name AttrList? ChildList?
AttrList    := "(" [ Attr ( "," Attr )* [ "," ] ] ")"
Attr        := Name "=" Expr
ChildList   := "[" [ Child ( "," Child )* [ "," ] ] "]"
Child       := String | Node | IfNode
IfNode      := "if" Condition ChildList [ "else" ( ChildList | IfNode ) ]
Condition   := "(" Expr ")" | "let" "Some" "(" Name ")" "=" Expr
```

节点属性的 `=` 后进入表达式文法，表达式中的函数调用不带节点撇号。子节点列表中的字符串仍是文本，节点必须带撇号；`if` 是控制结构，其分支中的节点也必须带撇号。空属性列表和空子节点列表允许显式书写；组件对是否允许子节点的约束仍由语义检查负责。

```dari
answer 'Answer [
  if (is_some(winner)) [
    'p ["结果：", 'Value(data=round(winner?.cpu,2))],
  ] else [
    'p ["无数据"],
  ],
  if let Some(row) = winner [
    'p ['Value(data=row.name)],
  ],
];
```

## 解析与诊断

解析器在声明值和子节点位置消费撇号并构造现有 `Element`，保留原文件位置。属性表达式继续由表达式解析器处理，节点引用和条件作用域按现有规则降低。撇号只标识节点文法，不改变依赖、类型检查、执行或渲染语义。

语法和语义错误直接描述所需结构及原文件位置，例如节点位置缺少撇号时提示 `Expected "'" before node`，缺少回答时提示 `Missing answer 'Answer [...]`，非法 `children` 属性提示 `children is not a valid node attribute`。表达式位置使用节点字面量时报告该位置需要表达式。检查和运行错误均以此设计为准，不加入迁移识别或迁移提示。

## 实现范围

- 更新 `src/draft/dom.ts` 的声明入口、子节点及条件分支解析，并禁止 `children` 属性
- 更新检查和运行时涉及节点语法的诊断，保留准确源码范围
- 更新 `tree-sitter-dari` 的语法、查询、生成产物、语料及示例，使编辑器解析与运行时一致
- 更新 DARI 手册、呈现知识、README、示例和测试夹具中面向当前语言的写法
- 保留 RFC 中的历史设计记录；实现时核对归档源码提取和报告相关测试对源码语法的假设

## 验收

- 图表、报告、回答、嵌套节点、空节点和条件分支均按每个节点带撇号的语法解析
- 属性表达式中的调用、字符串和静态下标，以及字符串子节点和条件作用域按既有语义工作
- `data` 和属性表达式拒绝节点字面量，节点位置拒绝缺少撇号的节点，`children` 属性报错，诊断指向原稿位置
- `dari_check` 与 `dari_resolve` 对同一语法采用一致规则；检查不读取业务行，执行与呈现结果符合原有语义
- Tree-sitter 语料、运行时解析测试、手册示例及相关回归测试通过，编辑器解析与运行时语法一致
