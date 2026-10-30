import { presentationOverview } from './presentation-guide.ts';
import { isRecord, type ToolExec } from './host.ts';
import type { Knowledge } from './knowledge.ts';

export const DOMAIN_SUMMARY_URI = 'oks://domain/summary.md';

/** A catalogue, not a second knowledge graph: no vocabulary or navigation edges. */
export function domainSummary(graph: object, domain: string) {
  const g = graph as Record<string, unknown>;
  const entries = (value: unknown) => isRecord(value) ? Object.entries(value) : [];
  const docs = new Map<string, { name?: string; doc: string }>();
  if (Array.isArray(g.items)) for (const item of g.items) {
    if (!isRecord(item) || typeof item.key !== 'string') continue;
    const text = typeof item.doc === 'string' ? item.doc.trim() : '';
    const name = Array.isArray(item.names) && typeof item.names[0] === 'string' ? item.names[0] : undefined;
    docs.set(item.key, { ...(name ? { name } : {}), doc: text.length > 180 ? text.slice(0, 180) + '…' : text });
  }
  const description = (root: string, id: string) => docs.get(root + '/' + encodeURIComponent(id)) ?? { doc: '' };
  const pick = <K extends string>(value: unknown, keys: K[]): Partial<Record<K, unknown>> => isRecord(value)
    ? Object.fromEntries(keys.filter(k => value[k] !== undefined).map(k => [k, value[k]])) as Partial<Record<K, unknown>> : {};
  const members = (value: unknown) => entries(value).map(([id]) => id);
  return {
    domain,
    entities: entries(g.entities).map(([id, v]) => ({ id, ...description('entities', id), ...pick(v, ['identity']) })),
    datasets: entries(g.datasets).map(([id, v]) => ({
      id, ...description('datasets', id), ...pick(v, ['kind', 'grain', 'clock', 'scope', 'references']),
      roles: entries(isRecord(v) ? v.roles : undefined)
        .flatMap(([role, value]) => isRecord(value) && typeof value.entity === 'string' ? [{ role, entity: value.entity, ...pick(value, ['optional']), parts: Array.isArray(value.parts) ? value.parts.map(part => pick(part, ['source', 'target', 'nullable'])) : [] }] : []),
      field_roles: entries(isRecord(v) ? v.fields : undefined).flatMap(([field, value]) =>
        isRecord(value) && Array.isArray(value.roles) && value.roles.length ? [{ field, roles: value.roles }] : []),
      dimensions: members(isRecord(v) ? v.dimensions : undefined),
      measures: members(isRecord(v) ? v.measures : undefined),
      time_roles: members(isRecord(v) ? v.time_roles : undefined),
    })),
    relations: entries(g.relations).map(([id, v]) => ({ id, ...description('relations', id), ...pick(v, ['from_dataset', 'to_dataset', 'cardinality', 'key', 'guard']) })),
    counts: Object.fromEntries(Object.entries(g).filter(([k]) => !['items', 'tools'].includes(k)).map(([k,v]) => [k, entries(v).length])),
  };
}

// Keep model text as text, and model IDs exact inside code spans.
const prose = (value: string) => value.replace(/\r\n|\r|\n/g, ' ').replace(/[\\`*_{}[\]<>#!|]/g, '\\$&');
const code = (value: unknown) => {
  const text = String(value).replace(/\r\n|\r|\n/g, ' ');
  const fence = '`'.repeat(Math.max(0, ...Array.from(text.matchAll(/`+/g), match => match[0].length)) + 1);
  return fence + ' ' + text + ' ' + fence;
};
const addressId = (address: unknown) => {
  const text = String(address ?? '未声明');
  const part = /^(?:datasets|entities)\/(.*)$/.exec(text)?.[1];
  if (part === undefined) return text;
  try { return decodeURIComponent(part); } catch { return text; }
};

export function renderDomainSummary(graph: object, domain: string): string {
  const summary = domainSummary(graph, domain);
  const note = (item: { name?: string; doc: string }) => [item.name, item.doc].filter(Boolean).map(value => prose(value!)).join('：');
  const lines = ['# 全局领域摘要', '', '领域：'+code(domain), '',
    '本摘要概览领域对象、数据集、关系导航及图表能力，已在上下文中。具体字段、度量、身份映射、连接条件与约束按需通过 oks_cap / oks_card 获取；领域词汇与规范值通过 va_ask 获取。', '',
    '局部入口：Dataset 使用 oks_cap({cq:{target:{dataset:ID}}}) 或 oks_card({id:ID})；Entity 使用 oks_card({key:"entities/ID"})。', '',
    '## 业务实体（Entity）', '',
    ...summary.entities.map(e=>'- '+code(e.id)+(note(e)?'：'+note(e):'')), '',
    '## 数据集与查询能力（Dataset）', '',
    '每项保留粒度、对象和能力数量；字段角色（称谓、指代、分类、指标）及其完整定义在局部卡片。', ''];
  for(const d of summary.datasets){
    const objects=[...new Set(d.roles.map(r=>addressId(r.entity)))];
    const parts=[note(d),d.kind===undefined?'':String(d.kind),d.grain===undefined?'':'粒度 '+JSON.stringify(d.grain),
      objects.length?'对象 '+objects.join('、'):'',
      `${d.dimensions.length} 维度 / ${d.measures.length} 度量`,d.time_roles.length?'支持时间分析':''].filter(Boolean);
    lines.push('- '+code(d.id)+'：'+parts.map(prose).join('；'));
  }
  lines.push('', '## 关系导航', '', '按声明方向合并列出可关联的数据集；关系 ID、基数、连接键和覆盖范围通过相应 Dataset 的 relations 卡片或 cap 获取。', '');
  const neighbors=new Map<string,Set<string>>();
  for(const r of summary.relations){
    const from=addressId(r.from_dataset),to=addressId(r.to_dataset);
    if(!neighbors.has(from))neighbors.set(from,new Set());
    neighbors.get(from)!.add(to);
  }
  for(const [from,to] of neighbors)lines.push('- '+code(from)+' → '+[...to].map(code).join('、'));
  lines.push('', ...presentationOverview());
  return lines.join('\n')+'\n';
}

// Graph identity changes with model/presentation content; domain keeps workspace labels separate.
const rendered = new WeakMap<object, Map<string, string>>();
export async function readDomainSummary(knowledge: Knowledge, exec: ToolExec): Promise<string> {
  exec.signal?.throwIfAborted();
  const entry = knowledge.ensureWorkspace(exec);
  const index = await knowledge.ensureIndex(entry);
  exec.signal?.throwIfAborted();
  let domains = rendered.get(index.knowledge);
  if (!domains) { domains = new Map(); rendered.set(index.knowledge, domains); }
  let text = domains.get(entry.settings.domain);
  if (text === undefined) { text = renderDomainSummary(index.knowledge, entry.settings.domain); domains.set(entry.settings.domain, text); }
  return text;
}
