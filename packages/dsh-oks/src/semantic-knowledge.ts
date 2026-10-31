import { queryKnowledge } from './knowledge-methods.ts';
import { semanticId, knowledgeNode } from './semantic-id.ts';
import { refPath, type SemanticGraph } from './knowledge-graph.ts';

// Only reference-bearing fields are converted. Business values, docs and query
// intents retain their exact model representation.
const references = new Set(['entity','type','ty','field','fields','anchor_field','binding','group','from_dataset','to_dataset','from_role','to_role','relations','types','datasets','entities','dimensions','measures','roles','bindings','time_roles','business_links','dimension_groups','measure_groups']);
function facts(value: any, reference = false): any {
  if (typeof value === 'string') {
    if (!reference) return value;
    try { return semanticId(value); } catch { return value; }
  }
  if (Array.isArray(value)) return value.map(v => facts(v, reference));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, v]) => [key,
    ['value','values','canonical_values','canonical_order','doc','names','source','predicate','guard','wires'].includes(key) ? v : facts(v, references.has(key))]));
}
function nodeRow(row: any): any {
  const { key, id: name, ...rest } = row;
  const path = refPath(key);
  const category = path.at(-2)!;
  const queryName = category === 'datasets' ? {dataset:name ?? path[1]}
    : category === 'entities' ? {entity:name ?? path[1]}
    : category === 'relations' ? {relation:name ?? path[1]}
    : category === 'dimensions' ? {dataset:path[1],dimension:name ?? path[3]}
    : category === 'measures' ? {dataset:path[1],measure:name ?? path[3]} : {};
  return {...facts(rest), id:semanticId(key), ...queryName};
}

/** Public tools adapt knowledge IDs only, never model query identifiers. */
export function semanticKnowledge(graph: SemanticGraph, method: string, args: Record<string, any>): any {
  if (method === 'search') {
    const result = queryKnowledge(graph, method, args) as any;
    return {...result, items:result.items.map(nodeRow)};
  }
  if (method === 'card') {
    const {ref,path} = knowledgeNode(graph,args.id);
    if (path[0] !== 'datasets' || path.length !== 2) {
      if (Object.keys(args).some(k => k !== 'id')) throw new Error('Only Dataset root cards accept section, skip and take');
      const result = queryKnowledge(graph,'read',{key:ref}) as any;
      return {...nodeRow(result), items:result.items.map(nodeRow)};
    }
    const result = queryKnowledge(graph,'card',{...args,id:path[1],docs:true}) as any;
    const converted = nodeRow(result);
    for (const category of ['fields','roles','bindings','dimensions','measures','time_roles','relations','business_links']) {
      if (Array.isArray(result[category])) converted[category] = result[category].map(nodeRow);
    }
    return converted;
  }
  const result = queryKnowledge(graph, method, args) as any;
  // cap's IDs are short query names. Explicit knowledge_id fields navigate to card.
  const cap = (value: any): any => {
    if (Array.isArray(value)) return value.map(cap);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).map(([key,v]) => key === 'candidate_intent' ? [key,v]
      : key === 'address' ? ['knowledge_id',typeof v === 'string' ? semanticId(v) : v]
      : key === 'facts' ? [key,facts(v)] : [key,cap(v)]));
  };
  return cap(result);
}
