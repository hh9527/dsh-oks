import { COMPONENT_KINDS } from './draft/components.ts';
import { presentationFacts } from './presentation-facts.ts';
import { EXPRESSION_SUPPORT } from './chart/shared.ts';
import { PUBLIC_AUTHOR_ATTRIBUTES, AUTHOR_ELEMENTS } from './report/structure.ts';

/** The catalogue and focused manuals share the renderer's existing capability facts. */
export function presentationOverview():string[] {
  return ['## 图表与报告能力', '',
    '按分析目的选择形式，具体映射和示例只需读取对应手册。图表可选；简单问题可用正文与数值回答。', '',
    ...Object.entries(COMPONENT_KINDS).map(([component,kind])=>{
      const item=presentationFacts.roots.render_figure.kinds[kind];
      return `- ${component}（${item.names[0]}）：${item.doc.split('。')[0]}；手册 oks://help/figure-${kind}.md`;
    }), '',
    'Report 支持正文、Value 数值、图表引用及自动编号；语法见 oks://help/report.md。图表通用规格见 oks://help/figures.md。', ''];
}
export function presentationManuals():Record<string,string> {
  const block=(v:unknown)=>'```json\n'+JSON.stringify(v,null,2)+'\n```\n';
  return Object.fromEntries([
    ...Object.entries(COMPONENT_KINDS).map(([component,kind])=>[
      `oks://help/figure-${kind}.md`,
      `# ${component}\n\n组件标签确定图表类型，spec 省略 kind。使用 figure name := ${component}(spec = spec, data = rows); 声明图表，data 引用 Table(T)。先在 query/select 中完成聚合，映射字段使用检查返回的列名。\n\n`+
      block(presentationFacts.roots.render_figure.kinds[kind])+
      '\n通用规格和开关见 oks://help/figures.md；报告语法见 oks://help/report.md。\n',
    ]),
    ['oks://help/report.md','# 报告语法\n\n'+block({...presentationFacts.roots.report,report_body:{elements:AUTHOR_ELEMENTS,attributes:PUBLIC_AUTHOR_ATTRIBUTES}})],
    ['oks://help/figure-options.md','# 图表通用规格与开关\n\n'+block({topics:presentationFacts.roots.render_figure.topics,expression_support:EXPRESSION_SUPPORT})],
  ]);
}
