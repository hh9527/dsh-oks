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
        "signature": "<Figures><ColumnChart name=\"comparison\" spec={spec} data={rows} /></Figures>",
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
          "doc": "单序列类别占比，仅绘制正数。用 x 指类别，donut=true 为环形；省略 series，先在 jq 中筛选/汇总成单序列。",
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
          "doc": "x 为类别，value 为逐条观测值；工具计算四分位数和离群点。series 不用于分组；先用 jq 构造类别列。",
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
          "doc": "columns 为字符串列名数组，决定选列和顺序；表头就是数据键名。中文表头先用 jq 重命名数据键，详见 table_headers 主题。",
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
            "aggregation": "分组类别图须在 query/jq 中准备唯一的 (x,series) 行；重复单元保留最后一个有效数值，不进行聚合。缺失组合保持缺失。"
          }
        },
        "table_headers": {
          "names": [
            "表头",
            "中文列名",
            "columns",
            "label"
          ],
          "doc": "表格 columns 只接受字符串列名数组；表头取数据键名。用 jq 重命名后再选列；{key,label} 会报错。",
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
              "jq": ".facts.rows | map({\"告警级别\":.level,\"数量\":.count})",
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
            "call": "<Figures><NetworkGraph name=\"network\" spec={spec} data={edges} nodes={nodes} /></Figures>"
          }
        },
        "draft": {
          "names": [
            "图表完整示例",
            "分析稿",
            "pipeline"
          ],
          "doc": "可运行 DARI：示例数据、jq 表头转换、柱图、表格与 DARI 报告。",
          "facts": {
            "dari": "<Dari title=\"呈现示例\">\n<Pipeline>\nfacts <- data({rows:[{level:\"major\",count:3}]},{kind:\"example\"});\nrows <- jq(\"headers.jq\",{facts});\nchartSpec <- data({x:\"告警级别\",value:\"数量\"});\ntableSpec <- data({columns:[\"告警级别\",\"数量\"]});\nsummary <- jq(\"summary.jq\",{facts});\n</Pipeline>\n<Asset language=\"jq\" name=\"headers.jq\">\n.facts.rows | map({\"告警级别\":.level,\"数量\":.count})\n</Asset>\n<Asset language=\"jq\" name=\"summary.jq\">\n{total:(.facts.rows | map(.count) | add),rows:.facts.rows}\n</Asset>\n<Figures><ColumnChart name=\"comparison\" spec={chartSpec} data={rows} /><Table name=\"details\" spec={tableSpec} data={rows} /></Figures>\n<Report name=\"answer\">\n<article><h1>示例结果</h1><p>数量：<Value data={summary.total} /></p><p>首项：<Value data={summary.rows[0].level} /></p><figure><Figure ref=\"comparison\" /><figcaption>类别比较</figcaption></figure><figure><Figure ref=\"details\" /><figcaption>明细</figcaption></figure></article>\n</Report></Dari>"
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
        "signature": "<Report name=\"answer\"><article>...</article></Report>"
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
          "doc": "DARI 模板只引用 pipeline 绑定及静态投影。Value 显示标量；Figures 定义具名图表；Report 通过 Figure 引用，figcaption 自动获得图/表编号，FigureRef 显示文字编号。",
          "facts": {
            "scalar": "<Value data={summary.total} />",
            "arrayScalar": "<Value data={summary.rows[0].level} />",
            "pick": "静态投影为 binding.field[0][\"中文键\"]。Report 花括号只接受引用；对象在 pipeline 构造，运算在 jq 完成。",
            "figure": "<figure><Figure ref=\"comparison\" /><figcaption>说明</figcaption></figure>",
            "bindings": "<Report name=\"answer\"><article>...</article></Report>",
            "spec": "组件 spec 省略 kind，标签决定图表类型；只有 NetworkGraph 接受 nodes，组件使用自闭合标签。",
            "structure": "Figures 包含具名、自闭合图表组件。Report 的 figure 内先放 Figure ref，再放可选 figcaption。FigureRef ref 显示本报告的编号，目标须在同一 Report 中展示。id/class/title/lang 放在 figure 上；图和表在每份答案中按文档顺序分别编号，图注位于图表之后。"
          }
        },
        "delivery": {
          "names": [
            "交付",
            "附件",
            "attachment"
          ],
          "doc": "Report 的 name 对应 reports.name；只有一个时自动选择，多个时用 answer 指定 reports.name。Figures 可独立于 Report 运行与展示。",
          "facts": {
            "reply": "oks_show({input:\"oks://work/draft.dari#figures.comparison\"}) 或 #reports.answer 将已有输出发布为宿主持久附件。SVG 将返回的 markdown 原样放入回答即可内嵌展示；报告和表格使用返回的 present 对象调用宿主 present 工具，显示原生文件卡片。此操作读取已保留输出。",
            "report": "oks_show({input:\"oks://work/draft.dari#reports.answer\"}) 导出自包含 .report.html 宿主附件，包含数据、来源及分析源码；随后调用 present(result.present) 显示原生文件卡片。"
          }
        },
        "draft": {
          "names": [
            "DARI 完整示例",
            "报告示例"
          ],
          "doc": "可运行 DARI：精确绑定标量、数组元素、图表与表格。",
          "facts": {
            "dari": "<Dari title=\"呈现示例\">\n<Pipeline>\nfacts <- data({rows:[{level:\"major\",count:3}]},{kind:\"example\"});\nrows <- jq(\"headers.jq\",{facts});\nchartSpec <- data({x:\"告警级别\",value:\"数量\"});\ntableSpec <- data({columns:[\"告警级别\",\"数量\"]});\nsummary <- jq(\"summary.jq\",{facts});\n</Pipeline>\n<Asset language=\"jq\" name=\"headers.jq\">\n.facts.rows | map({\"告警级别\":.level,\"数量\":.count})\n</Asset>\n<Asset language=\"jq\" name=\"summary.jq\">\n{total:(.facts.rows | map(.count) | add),rows:.facts.rows}\n</Asset>\n<Figures><ColumnChart name=\"comparison\" spec={chartSpec} data={rows} /><Table name=\"details\" spec={tableSpec} data={rows} /></Figures>\n<Report name=\"answer\">\n<article><h1>示例结果</h1><p>数量：<Value data={summary.total} /></p><p>首项：<Value data={summary.rows[0].level} /></p><figure><Figure ref=\"comparison\" /><figcaption>类别比较</figcaption></figure><figure><Figure ref=\"details\" /><figcaption>明细</figcaption></figure></article>\n</Report></Dari>"
          }
        },
        "body": {
          "names": [
            "正文语法",
            "元素",
            "属性",
            "data-oks-lit",
            "data-oks-shrink"
          ],
          "doc": "Report 正文根为 article，元素与属性由 DARI 编译器检查，属性使用静态字符串，空元素显式自闭合；文本中的 & 与 < 使用实体。业务数字通过 Value 引用填入。",
          "facts": {
            "numbers": "正文中的字面数字使用 <span data-oks-lit=\"\">…</span> 声明；观测得到的业务数字从绑定取值。",
            "dariMarkers": "data-oks-shrink 和 data-oks-lit 可以省略 =\"\"；其他属性显式赋值。",
            "shrink": "data-oks-shrink 标记解读或评价文字，完整内容保存在报告及作者源码中。"
          }
        }
      }
    }
  },
  "examples": {
    "report": "<Dari title=\"呈现示例\">\n<Pipeline>\nfacts <- data({rows:[{level:\"major\",count:3}]},{kind:\"example\"});\nrows <- jq(\"headers.jq\",{facts});\nchartSpec <- data({x:\"告警级别\",value:\"数量\"});\ntableSpec <- data({columns:[\"告警级别\",\"数量\"]});\nsummary <- jq(\"summary.jq\",{facts});\n</Pipeline>\n<Asset language=\"jq\" name=\"headers.jq\">\n.facts.rows | map({\"告警级别\":.level,\"数量\":.count})\n</Asset>\n<Asset language=\"jq\" name=\"summary.jq\">\n{total:(.facts.rows | map(.count) | add),rows:.facts.rows}\n</Asset>\n<Figures><ColumnChart name=\"comparison\" spec={chartSpec} data={rows} /><Table name=\"details\" spec={tableSpec} data={rows} /></Figures>\n<Report name=\"answer\">\n<article><h1>示例结果</h1><p>数量：<Value data={summary.total} /></p><p>首项：<Value data={summary.rows[0].level} /></p><figure><Figure ref=\"comparison\" /><figcaption>类别比较</figcaption></figure><figure><Figure ref=\"details\" /><figcaption>明细</figcaption></figure></article>\n</Report></Dari>",
    "tableHeaders": {
      "input": {
        "rows": [
          {
            "level": "major",
            "count": 3
          }
        ]
      },
      "jq": ".facts.rows | map({\"告警级别\":.level,\"数量\":.count})",
      "spec": {
        "columns": [
          "告警级别",
          "数量"
        ]
      }
    }
  }
};
