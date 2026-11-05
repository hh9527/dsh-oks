import { COMPONENT_KINDS } from './draft/components.ts';
import { presentationFacts } from './presentation-facts.ts';
import { EXPRESSION_SUPPORT } from './chart/shared.ts';

/** The front-loaded index and optional manuals share the renderer's capability facts. */
export function presentationOverview():string[] {
  return ['### 图表索引', '', ...Object.entries(COMPONENT_KINDS).map(([component,kind])=>{
    const item=presentationFacts.roots.render_figure.kinds[kind];
    const required:string[]=item.facts.required;
    return '- '+component+'：'+item.doc.split('。')[0]+'；必填 spec：'+(required.length?required.join(', '):'无')+'；oks://help/figure-'+kind+'.md';
  }), ''];
}
export function presentationManuals():Record<string,string> {
  const block=(v:unknown)=>'```json\n'+JSON.stringify(v,null,2)+'\n```\n';
  return Object.fromEntries([
    ...Object.entries(COMPONENT_KINDS).map(([component,kind])=>[
      `oks://help/figure-${kind}.md`,
      `# ${component}\n\n组件标签确定图表类型，spec 省略 kind。使用 figure name = ${component}(spec = spec, data = rows); 声明图表，data 引用 Table(T)。规格材料使用 JSON 表示；写入 DARI 源码时布尔值与空值使用 True/False/None。先在 query/select 中完成聚合，映射字段使用检查返回的列名。\n\n`+
      block(presentationFacts.roots.render_figure.kinds[kind])+
      '\n通用规格和开关见 oks://help/figure-options.md；图表、报告及回答语法已载入 oks://help/dari.md。\n',
    ]),
    ['oks://help/figure-options.md','# 图表通用规格与开关\n\n'+block({topics:presentationFacts.roots.render_figure.topics,expression_support:EXPRESSION_SUPPORT})],
  ]);
}
