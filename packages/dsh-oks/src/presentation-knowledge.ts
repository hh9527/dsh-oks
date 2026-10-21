import { presentationFacts as authored } from './presentation-facts.ts';
import { COMPONENT_KINDS } from './draft/components.ts';
import { CHART_KINDS, EXPRESSION_SUPPORT } from './chart/shared.ts';
import { AUTHOR_ATTRIBUTES, AUTHOR_ELEMENTS } from './report/structure.ts';
import { resolveFact } from './knowledge-graph.ts';
import type { SemanticGraph } from './knowledge-graph.ts';

export const tableHeaderExample = authored.examples.tableHeaders;
export const presentationExample: string = authored.examples.report;

/** 直接挂载结构化事实；组件、能力矩阵、白名单与反向引用由当前实现生成。 */
export function mountPresentationKnowledge(graph: SemanticGraph): void {
  graph.tools = {};
  for (const [owner, raw] of Object.entries(authored.roots)) {
    const root = raw as Record<string, any>;
    graph.tools[owner] = {...root.facts, kinds: {}, topics: {}};
    graph.items.push({key:`tools/${owner}`, names:root.names, doc:root.doc});
    for (const category of ['kinds', 'topics']) {
      for (const [id, rawNode] of Object.entries(root[category])) {
        const node = rawNode as Record<string, any>;
        (graph.tools[owner][category] as Record<string, unknown>)[id] = {...node.facts, tools:[`tools/${owner}`]};
        graph.items.push({key:`tools/${owner}#${category}/${id}`, names:node.names, doc:node.doc});
      }
    }
  }
  graph.tools.render_figure.related = {tools:['tools/report']};
  graph.tools.report.related = {tools:['tools/render_figure']};
  delete graph.tools.report.kinds;
  for (const [component, kind] of Object.entries(COMPONENT_KINDS)) {
    const fact = resolveFact(graph, `tools/render_figure#kinds/${kind}`);
    fact.component = component;
    if (kind !== 'table') fact.switches = Object.keys(EXPRESSION_SUPPORT).filter(feature => (EXPRESSION_SUPPORT[feature as keyof typeof EXPRESSION_SUPPORT] as readonly string[]).includes(kind));
  }
  resolveFact(graph, 'tools/render_figure#topics/switches').support = EXPRESSION_SUPPORT;
  resolveFact(graph, 'tools/report#topics/references').components = COMPONENT_KINDS;
  Object.assign(resolveFact(graph, 'tools/report#topics/body'), {elements:AUTHOR_ELEMENTS, attributes:AUTHOR_ATTRIBUTES});
  for (const kind of [...CHART_KINDS, 'table']) {
    const fact = resolveFact(graph, `tools/render_figure#kinds/${kind}`);
    const topics = kind === 'table' ? ['table_headers'] : kind === 'graph' ? ['spec','nodes'] : ['spec','switches'];
    fact.related = {topics:topics.map(topic => `tools/render_figure#topics/${topic}`)};
    for (const topic of topics) {
      const target = resolveFact(graph, `tools/render_figure#topics/${topic}`);
      const reverse = (target.referenced_by ??= {kinds:[]}) as {kinds:string[]};
      reverse.kinds.push(`tools/render_figure#kinds/${kind}`);
    }
  }
  graph.items.sort((a,b) => a.key.localeCompare(b.key,'en'));
}
