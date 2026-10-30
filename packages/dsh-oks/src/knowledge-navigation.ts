import { readDomainSummary } from './domain-summary.ts';
import { isRecord, errorText } from './host.ts';
import type { PluginContext, LogFn } from './host.ts';
import type { Knowledge } from './knowledge.ts';

const meanings: Record<string, string> = {
  entities: 'Entity：业务身份与身份类型',
  datasets: 'Dataset：数据源、粒度与具体查询能力',
  dimension_groups: 'DimensionGroup：可复用维度定义',
  measure_groups: 'MeasureGroup：可复用度量及统计约束',
  types: 'Ty：领域类型与规范值域',
  relations: 'Relation：声明的关系与连接约束',
  tools: 'Tool：插件工具用法',
  items: '节点与成员的名称和说明',
};
const selectedKey = (key: string): string => `'${key.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;

/** Enumerate the assembled graph, including unknown and empty branches. No graph mutation. */
export function knowledgeBranches(graph: object) {
  return Object.keys(graph).map(key => {
    const value = (graph as Record<string, unknown>)[key];
    const shape = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
    const count = Array.isArray(value) ? value.length : isRecord(value) ? Object.keys(value).length : undefined;
    const path = selectedKey(key);
    const select = isRecord(value) ? `${path}:keys[0:10]` : Array.isArray(value) ? `${path}[0:3]` : path;
    return { key, shape, ...(count === undefined ? {} : { count }), ...(Object.hasOwn(meanings, key) ? { meaning: meanings[key] } : {}), select };
  });
}

export function renderKnowledgeNavigation(graph: object, domain: string): string {
  return '当前模型的知识根目录（domain=' + JSON.stringify(domain) + '）\n\n'
    + '以下为当前 oks://knowledge 的全部根分支、形状和直接成员数量；从实际对象生成，空分支和未知分支也列出。\n\n'
    + '```json\n' + JSON.stringify(knowledgeBranches(graph), null, 2) + '\n```\n\n'
    + '用 oks_project({input:"oks://knowledge",select:":keys"}) 核对根目录，或使用上表的 select 取样。'
    + '已知类别的含义只是解释，实际目录以这里的键为准；items 是说明数组。只展开相关分支，查询能力仍以模型声明为准。';
}

export function renderKnowledgeHelp(source: string, graph: object, domain: string): string {
  const at = source.indexOf('\n');
  return source.slice(0, at) + '\n\n## 当前工作区\n\n' + renderKnowledgeNavigation(graph, domain) + '\n' + source.slice(at);
}

/** Per-session tool navigation; never mutate a process-wide tool description. */
export function installKnowledgeNavigation({ ctx, knowledge, log }: { ctx: PluginContext; knowledge: Knowledge; log: LogFn }): void {
  if (!ctx.systemPrompt) return;
  const dispose = ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const prior = await next();
    const assembled = { ...prior, sections: prior.sections.filter(section => section.name !== 'oks:knowledge-navigation') };
    if (!context.agent) return assembled;
    context.signal?.throwIfAborted();
    try {
      const text = await readDomainSummary(knowledge, { agent: context.agent, signal: context.signal });
      return { ...assembled, sections: [
        ...assembled.sections.filter(section => section.name !== 'oks:knowledge-navigation'),
        { name: 'oks:knowledge-navigation', text, interpolate: false },
      ] };
    } catch (error) {
      context.signal?.throwIfAborted();
      log('[oks] knowledge navigation unavailable: ' + errorText(error));
      return { ...assembled, sections: assembled.sections.filter(section => section.name !== 'oks:knowledge-navigation') };
    }
  });
  ctx.effect(() => dispose);
}
