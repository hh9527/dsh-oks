/** 图表与报告的结构化能力和可运行示例；文本帮助独立维护在 help/figures.md。 */
export const presentationFacts = {
  "roots": {
    "render_figure": {
      "names": [
        "图表",
        "图形",
        "表格",
        "呈现",
        "render_figure"
      ],
      "doc": "生成图表或表格。kinds 提供逐图元的必填映射、series 语义、专属开关及最小示例；topics 提供规格、表头与完整分析稿。",
      "facts": {
        "signature": "figure comparison := ColumnChart(spec = spec, data = rows);",
        "pipelineSignature": "render_figure({kind,...spec},{data:rows,nodes?:rows})",
        "input": "data 接受 rows[] 或 {rows:[...]}；nodes 仅用于 graph。"
      },
      "kinds": {
        "bar": {
          "names": [
            "横条图",
            "bar",
            "BarChart"
          ],
          "doc": "横向比较类别数值；series 可选，表示分组。",
          "facts": {
            "required": [
              "x",
              "value"
            ],
            "series": "group",
            "example": {
              "spec": {
                "x": "label",
                "value": "count"
              },
              "rows": [
                {
                  "label": "甲",
                  "count": 3
                },
                {
                  "label": "乙",
                  "count": 5
                }
              ]
            }
          }
        },
        "line": {
          "names": [
            "折线图",
            "时间趋势",
            "line",
            "LineChart"
          ],
          "doc": "沿 x 展示趋势；series 分线。时间 xType=time，使用 RFC3339 或 epoch 毫秒；数值/时间 x 在每个序列内须非递减。null 留缺口，connectNulls 控制连接。",
          "facts": {
            "required": [
              "x",
              "value"
            ],
            "series": "group",
            "example": {
              "spec": {
                "x": "at",
                "value": "count",
                "xType": "time"
              },
              "rows": [
                {
                  "at": "2026-01-01T00:00:00Z",
                  "count": 3
                },
                {
                  "at": "2026-02-01T00:00:00Z",
                  "count": 5
                }
              ]
            }
          }
        },
        "column": {
          "names": [
            "柱状图",
            "分组柱图",
            "堆叠柱图",
            "column",
            "ColumnChart"
          ],
          "doc": "纵向比较类别；series 为分组列，省略 stack 时并列，stack=total 堆叠，percent 按类别归一为百分比。",
          "facts": {
            "required": [
              "x",
              "value"
            ],
            "series": "group",
            "example": {
              "spec": {
                "x": "label",
                "value": "count",
                "series": "group",
                "stack": "total"
              },
              "rows": [
                {
                  "label": "甲",
                  "group": "A",
                  "count": 3
                },
                {
                  "label": "甲",
                  "group": "B",
                  "count": 5
                }
              ]
            }
          }
        },
        "pie": {
          "names": [
            "饼图",
            "环形图",
            "pie",
            "PieChart"
          ],
          "doc": "单序列类别占比，仅绘制正数。用 x 指类别，donut=true 为环形；省略 series，先在 select 中筛选/汇总成单序列。",
          "facts": {
            "required": [
              "x",
              "value"
            ],
            "series": "unused",
            "example": {
              "spec": {
                "x": "label",
                "value": "count",
                "donut": true
              },
              "rows": [
                {
                  "label": "甲",
                  "count": 3
                },
                {
                  "label": "乙",
                  "count": 5
                }
              ]
            }
          }
        },
        "area": {
          "names": [
            "面积图",
            "堆叠面积图",
            "area",
            "AreaChart"
          ],
          "doc": "趋势面积；x 与 line 相同，series 分组；stack=total/percent 控制堆叠。缺失组合留空，不推定为零。",
          "facts": {
            "required": [
              "x",
              "value"
            ],
            "series": "group",
            "example": {
              "spec": {
                "x": "at",
                "value": "count",
                "series": "group",
                "stack": "percent"
              },
              "rows": [
                {
                  "at": 1,
                  "group": "A",
                  "count": 3
                },
                {
                  "at": 1,
                  "group": "B",
                  "count": 5
                },
                {
                  "at": 2,
                  "group": "A",
                  "count": 4
                },
                {
                  "at": 2,
                  "group": "B",
                  "count": 6
                }
              ]
            }
          }
        },
        "scatter": {
          "names": [
            "散点图",
            "气泡图",
            "scatter",
            "ScatterChart"
          ],
          "doc": "x/value 为两个数值列；size 可映射第三数值列为点大小。series 不用于分组。",
          "facts": {
            "required": [
              "x",
              "value"
            ],
            "series": "unused",
            "example": {
              "spec": {
                "x": "a",
                "value": "b",
                "size": "size"
              },
              "rows": [
                {
                  "a": 1,
                  "b": 4,
                  "size": 2
                },
                {
                  "a": 2,
                  "b": 3,
                  "size": 5
                }
              ]
            }
          }
        },
        "histogram": {
          "names": [
            "直方图",
            "分布",
            "histogram",
            "Histogram"
          ],
          "doc": "value 为逐条原始观测值，自动分箱计数；bins=1..200 可指定箱数。无需 x 或 series。",
          "facts": {
            "required": [
              "value"
            ],
            "series": "unused",
            "example": {
              "spec": {
                "value": "n",
                "bins": 3
              },
              "rows": [
                {
                  "n": 1
                },
                {
                  "n": 2
                },
                {
                  "n": 2
                },
                {
                  "n": 4
                }
              ]
            }
          }
        },
        "box": {
          "names": [
            "箱线图",
            "box",
            "BoxPlot"
          ],
          "doc": "x 为类别，value 为逐条观测值；工具计算四分位数和离群点。series 不用于分组；先用 select 构造类别列。",
          "facts": {
            "required": [
              "x",
              "value"
            ],
            "series": "unused",
            "example": {
              "spec": {
                "x": "label",
                "value": "n"
              },
              "rows": [
                {
                  "label": "甲",
                  "n": 1
                },
                {
                  "label": "甲",
                  "n": 2
                },
                {
                  "label": "甲",
                  "n": 3
                },
                {
                  "label": "甲",
                  "n": 8
                }
              ]
            }
          }
        },
        "heatmap": {
          "names": [
            "热力图",
            "矩阵",
            "heatmap",
            "Heatmap"
          ],
          "doc": "x 为横轴类别，series 为纵轴类别，value 为格子数值。缺失格子留空。",
          "facts": {
            "required": [
              "x",
              "series",
              "value"
            ],
            "series": "y-category",
            "example": {
              "spec": {
                "x": "day",
                "series": "group",
                "value": "n"
              },
              "rows": [
                {
                  "day": "周一",
                  "group": "A",
                  "n": 3
                },
                {
                  "day": "周二",
                  "group": "A",
                  "n": 5
                }
              ]
            }
          }
        },
        "radar": {
          "names": [
            "雷达图",
            "radar",
            "RadarChart"
          ],
          "doc": "x 为指标，series 为比较对象，value 为数值；至少三个指标，每个对象×指标均需有限数值，缺失不补零。先明确不同指标的单位与可比性。",
          "facts": {
            "required": [
              "x",
              "series",
              "value"
            ],
            "series": "entity",
            "example": {
              "spec": {
                "x": "metric",
                "series": "group",
                "value": "n"
              },
              "rows": [
                {
                  "metric": "A",
                  "group": "甲",
                  "n": 3
                },
                {
                  "metric": "B",
                  "group": "甲",
                  "n": 4
                },
                {
                  "metric": "C",
                  "group": "甲",
                  "n": 5
                }
              ]
            }
          }
        },
        "sankey": {
          "names": [
            "桑基图",
            "流向",
            "sankey",
            "Sankey"
          ],
          "doc": "每行是一条边：x 起点、series 终点；value 可选权重列，缺省每条边计 1。",
          "facts": {
            "required": [
              "x",
              "series"
            ],
            "series": "target",
            "example": {
              "spec": {
                "x": "source",
                "series": "target",
                "value": "weight"
              },
              "rows": [
                {
                  "source": "甲",
                  "target": "乙",
                  "weight": 3
                },
                {
                  "source": "乙",
                  "target": "丙",
                  "weight": 2
                }
              ]
            }
          }
        },
        "gauge": {
          "names": [
            "仪表盘",
            "仪表图",
            "gauge",
            "Gauge"
          ],
          "doc": "x 为仪表名称，value 为 0..100 的比率值；0..1 的比率须先乘 100，计数须先换算比例。series 不用于分组。",
          "facts": {
            "required": [
              "x",
              "value"
            ],
            "series": "unused",
            "example": {
              "spec": {
                "x": "label",
                "value": "percent"
              },
              "rows": [
                {
                  "label": "完成率",
                  "percent": 75
                }
              ]
            }
          }
        },
        "graph": {
          "names": [
            "关系图",
            "网络图",
            "graph",
            "NetworkGraph"
          ],
          "doc": "每行是一条边：x 起点、series 终点；value 可选权重。输入 nodes 必须提供节点表，节点字段见 nodes 主题。",
          "facts": {
            "required": [
              "x",
              "series"
            ],
            "series": "target",
            "example": {
              "spec": {
                "x": "source",
                "series": "target",
                "value": "weight"
              },
              "rows": [
                {
                  "source": "甲",
                  "target": "乙",
                  "weight": 3
                },
                {
                  "source": "乙",
                  "target": "丙",
                  "weight": 2
                }
              ],
              "nodes": [
                {
                  "id": "甲",
                  "depth": 0
                },
                {
                  "id": "乙",
                  "depth": 1
                },
                {
                  "id": "丙",
                  "depth": 2
                }
              ]
            }
          }
        },
        "table": {
          "names": [
            "表格",
            "列顺序",
            "table"
          ],
          "doc": "columns 为字符串列名数组，决定选列和顺序；表头就是数据键名。中文表头先用 select 重命名数据键，详见 table_headers 主题。",
          "facts": {
            "required": [],
            "columns": "字符串数组：按显示顺序列出现有数据列名，默认使用数据键名。",
            "example": {
              "spec": {
                "columns": [
                  "label",
                  "count"
                ]
              },
              "rows": [
                {
                  "label": "甲",
                  "count": 3
                }
              ]
            }
          }
        }
      },
      "topics": {
        "switches": {
          "names": [
            "图表能力矩阵",
            "stack",
            "series",
            "专属开关"
          ],
          "doc": "专属开关的支持矩阵由渲染器生成；series 的含义见各个 kinds 节点。开关放在 spec 顶层。",
          "facts": {
            "values": {
              "stack": [
                "total",
                "percent"
              ],
              "size": "数据列名",
              "bins": "整数，范围 1..200",
              "second": {
                "value": "数据列名",
                "kind": "line",
                "label": "可选",
                "unit": "可选"
              },
              "marks": "1..12 项：{value:number|string,axis?:x|y,label?:string}",
              "donut": "Bool",
              "connectNulls": "Bool",
              "entityColor": "Bool"
            }
          }
        },
        "spec": {
          "names": [
            "图表规格",
            "坐标轴",
            "排版",
            "style",
            "layout"
          ],
          "doc": "x/value/series 指向数据列名；标题、轴名、单位与排版可覆盖。类别顺序默认沿用输入。查询/汇总与展示分开完成。",
          "facts": {
            "fields": {
              "title": "String",
              "x": "数据列名",
              "value": "数据列名",
              "series": "数据列名；含义见图表类型说明",
              "xType": "line/area 使用 number|time；省略时从 x 推断",
              "xLabel": "坐标轴名称",
              "valueLabel": "度量名称",
              "unit": "显示单位"
            },
            "style": {
              "sort": [
                "none",
                "desc",
                "asc"
              ],
              "labels": "Bool",
              "colors": "1..12 个十六进制颜色字符串"
            },
            "layout": {
              "labelFont": [
                8,
                18
              ],
              "titleFont": [
                8,
                32
              ],
              "height": [
                200,
                2000
              ],
              "rowHeight": [
                16,
                80
              ],
              "tickCount": [
                3,
                12
              ],
              "slantTicks": "Bool"
            },
            "aggregation": "分组类别图须在 query/select 中准备唯一的 (x,series) 行；重复单元保留最后一个有效数值，不进行聚合。缺失组合保持缺失。"
          }
        },
        "table_headers": {
          "names": [
            "表头",
            "中文列名",
            "columns",
            "label"
          ],
          "doc": "表格 columns 只接受字符串列名数组；表头取数据键名。用 select 重命名后再选列；{key,label} 会报错。",
          "facts": {
            "example": {
              "input": {
                "rows": [
                  {
                    "level": "major",
                    "count": 3
                  }
                ]
              },
              "pipeline": "data rows := select({from:{f:facts},fields:(r)=>({\"告警级别\":r.f.level,\"数量\":r.f.count})});",
              "spec": {
                "columns": [
                  "告警级别",
                  "数量"
                ]
              }
            }
          }
        },
        "nodes": {
          "names": [
            "关系图节点表",
            "nodes"
          ],
          "doc": "graph 的输入 nodes 必填；边的起终点使用节点 id。每个节点应提供 depth，或同时提供 x/y 固定坐标。",
          "facts": {
            "fields": {
              "id": "节点 ID",
              "label": "可选 显示名称",
              "depth": "数值层级",
              "x": "可选 坐标，须与 y 一起提供",
              "y": "可选 坐标，须与 x 一起提供",
              "category": "可选 颜色类别",
              "status": "focus 强调节点或边"
            },
            "call": "figure network := NetworkGraph(spec = spec, data = edges, nodes = nodes);"
          }
        },
        "draft": {
          "names": [
            "图表完整示例",
            "分析稿",
            "pipeline"
          ],
          "doc": "可运行 DARI：示例数据、有类型表头转换、柱图、表格与 DARI 报告。",
          "facts": {
            "dari": "data facts := table([{level:\"major\",count:3}],{kind:\"example\"});\ndata rows := select({from:{f:facts},fields:(r)=>({\"告警级别\":r.f.level,\"数量\":r.f.count})});\ndata winner := select_one({from:{f:facts},fields:(r)=>({level:r.f.level}),order_by:(o)=>[asc(o.level)],limit:1});\ndata chartSpec := {x:\"告警级别\",value:\"数量\"};\ndata tableSpec := {columns:[\"告警级别\",\"数量\"]};\ndata summary := select_one({from:{f:facts},group_by:(r)=>({}),fields:(g,rows)=>({total:sum(rows.f.count)})});\n\nfigure comparison := ColumnChart(spec = chartSpec, data = rows);\n\nfigure details := Table(spec = tableSpec, data = rows);\n\nreport answer := Report(title = \"呈现示例\") [\n  h1 [ \"示例结果\" ],\n  p [\n    \"数量：\",\n    Value(data = summary?.total),\n  ],\n  p [\n    \"首项：\",\n    Value(data = winner?.level),\n  ],\n  figure [\n    Figure(ref = comparison),\n    figcaption [ \"类别比较\" ],\n  ],\n  figure [\n    Figure(ref = details),\n    figcaption [ \"明细\" ],\n  ],\n];\n"
          }
        }
      }
    },
    "report": {
      "names": [
        "报告",
        "Report",
        "DARI 正文"
      ],
      "doc": "通过 DARI Report 绑定标量和具名图表，直接从编译结构生成报告。topics 提供引用、正文规则、交付和完整示例。",
      "facts": {
        "signature": "report answer := Report [ p [ \"正文\" ], ];"
      },
      "kinds": {},
      "topics": {
        "references": {
          "names": [
            "引用",
            "绑定",
            "路径",
            "DARI",
            "Value",
            "figure",
            "图序号"
          ],
          "doc": "data 定义不可变计算，figure 定义具名图表，report 定义报告。Value 显示标量；Report 通过 Figure 引用图表，figcaption 自动获得图/表编号，FigureRef 显示文字编号。",
          "facts": {
            "scalar": "Value(data = summary.total);",
            "arrayScalar": "Value(data = winner?.level);",
            "pick": "属性写成 key = expression，支持绑定、静态/可选投影及有类型计算。子节点使用 JSON 字符串和 DOM-like 节点；动态标量通过 Value(data = expression) 插入。",
            "figure": "figure [ Figure(ref = comparison), figcaption [ \"说明\" ], ];",
            "bindings": "report answer := Report [ p [ \"正文\" ], ];",
            "spec": "组件 spec 省略 kind，标签决定图表类型；只有 NetworkGraph 接受 nodes。组件语法为 tag(attrs) [ children ]，属性或子节点为空时可省略对应部分。",
            "structure": "figure 声明具名图表。Report 的 figure 排版块内先放 Figure(ref = chart)，再放可选 figcaption。FigureRef(ref = chart) 显示本报告的编号，目标须在同一 Report 中展示。图和表按文档顺序分别编号，图注位于图表之后。"
          }
        },
        "draft": {
          "names": [
            "DARI 完整示例",
            "报告示例"
          ],
          "doc": "可运行 DARI：精确绑定标量、数组元素、图表与表格。",
          "facts": {
            "dari": "data facts := table([{level:\"major\",count:3}],{kind:\"example\"});\ndata rows := select({from:{f:facts},fields:(r)=>({\"告警级别\":r.f.level,\"数量\":r.f.count})});\ndata winner := select_one({from:{f:facts},fields:(r)=>({level:r.f.level}),order_by:(o)=>[asc(o.level)],limit:1});\ndata chartSpec := {x:\"告警级别\",value:\"数量\"};\ndata tableSpec := {columns:[\"告警级别\",\"数量\"]};\ndata summary := select_one({from:{f:facts},group_by:(r)=>({}),fields:(g,rows)=>({total:sum(rows.f.count)})});\n\nfigure comparison := ColumnChart(spec = chartSpec, data = rows);\n\nfigure details := Table(spec = tableSpec, data = rows);\n\nreport answer := Report(title = \"呈现示例\") [\n  h1 [ \"示例结果\" ],\n  p [\n    \"数量：\",\n    Value(data = summary?.total),\n  ],\n  p [\n    \"首项：\",\n    Value(data = winner?.level),\n  ],\n  figure [\n    Figure(ref = comparison),\n    figcaption [ \"类别比较\" ],\n  ],\n  figure [\n    Figure(ref = details),\n    figcaption [ \"明细\" ],\n  ],\n];\n"
          }
        },
        "body": {
          "names": [
            "正文语法",
            "元素",
            "属性",
            "Lit",
            "data-oks-shrink"
          ],
          "doc": "Report 直接包含正文节点，编译器生成 article。普通节点属性使用静态字符串，文本使用 JSON 字符串，& 和 < 直接书写并由渲染器转义。业务数字通过 Value 引用填入。",
          "facts": {
            "numbers": "静态业务参数可以直接写在正文中；观测得到的业务数字通过 Value(data = expression) 从绑定取值。",
            "dariMarkers": "属性写成 key = value。Lit [\"1.2\"] 标记字面文本，span(data-oks-shrink = true) 标记解读文字。",
            "shrink": "data-oks-shrink 标记解读或评价文字，完整内容保存在报告及作者源码中。"
          }
        }
      }
    }
  },
  "examples": {
    "report": "data facts := table([{level:\"major\",count:3}],{kind:\"example\"});\ndata rows := select({from:{f:facts},fields:(r)=>({\"告警级别\":r.f.level,\"数量\":r.f.count})});\ndata winner := select_one({from:{f:facts},fields:(r)=>({level:r.f.level}),order_by:(o)=>[asc(o.level)],limit:1});\ndata chartSpec := {x:\"告警级别\",value:\"数量\"};\ndata tableSpec := {columns:[\"告警级别\",\"数量\"]};\ndata summary := select_one({from:{f:facts},group_by:(r)=>({}),fields:(g,rows)=>({total:sum(rows.f.count)})});\n\nfigure comparison := ColumnChart(spec = chartSpec, data = rows);\n\nfigure details := Table(spec = tableSpec, data = rows);\n\nreport answer := Report(title = \"呈现示例\") [\n  h1 [ \"示例结果\" ],\n  p [\n    \"数量：\",\n    Value(data = summary?.total),\n  ],\n  p [\n    \"首项：\",\n    Value(data = winner?.level),\n  ],\n  figure [\n    Figure(ref = comparison),\n    figcaption [ \"类别比较\" ],\n  ],\n  figure [\n    Figure(ref = details),\n    figcaption [ \"明细\" ],\n  ],\n];\n",
    "tableHeaders": {
      "input": {
        "rows": [
          {
            "level": "major",
            "count": 3
          }
        ]
      },
      "pipeline": "data rows := select({from:{f:facts},fields:(r)=>({\"告警级别\":r.f.level,\"数量\":r.f.count})});",
      "spec": {
        "columns": [
          "告警级别",
          "数量"
        ]
      }
    }
  }
};
