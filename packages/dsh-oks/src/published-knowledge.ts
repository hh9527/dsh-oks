import { graphRoots, refPath, resolveFact, encodePart, kindRoles } from './knowledge-graph.ts';
import type { SemanticGraph, KnowledgeItem } from './knowledge-graph.ts';
import type { RetrievalIndex, ReferenceEdge, Term } from './retrieval.ts';
import { isRecord } from './host.ts';
import { mountPresentationKnowledge } from './presentation-knowledge.ts';

const own = (target: Record<string, unknown>, key: string, value: unknown): void => {
  Object.defineProperty(target, key, { value, writable: true, configurable: true, enumerable: true });
};
const kindOf = (role: string): string => Object.entries(kindRoles).find(([, value]) => value === role)?.[0] ?? role;

/** Only navigation is derived here. All capabilities remain model facts. */
export function derivePublishedKnowledge(input: unknown, presentation?: unknown): RetrievalIndex {
  if (!isRecord(input) || input.knowledge_contract !== 'ontology-knowledge-v4' || input.intent_contract !== 'ontology-intent-v1' || input.addressing !== 'node-member-uri-v1') throw new Error('Unsupported initialization knowledge contract');
  if (typeof input.revision !== 'string' || input.revision === '' || !Array.isArray(input.facts) || !Array.isArray(input.items)) throw new Error('Invalid initialization knowledge publication');
  const graph: SemanticGraph = { entities: {}, datasets: {}, dimension_groups: {}, measure_groups: {}, types: {}, relations: {}, tools: {}, items: [] };
  const facts = new Map<string, { value: Record<string, unknown>; references: string[] }>();
  for (const entry of input.facts) {
    if (!isRecord(entry) || typeof entry.key !== 'string' || !isRecord(entry.value) || !Array.isArray(entry.references) || entry.references.some(ref => typeof ref !== 'string')) throw new Error('Invalid initialization knowledge fact');
    const path = refPath(entry.key);
    if (path[0] === 'tools' || (path.length === 4 && path[0] !== 'datasets' && path[0] !== 'types')) throw new Error(`Invalid published fact address: ${entry.key}`);
    if (facts.has(entry.key)) throw new Error(`Duplicate published fact: ${entry.key}`);
    // Navigation belongs to the plugin; model facts cannot replace it.
    if (['related', 'traversable', 'referenced_by'].some(key => Object.hasOwn(entry.value as Record<string, unknown>, key))) throw new Error(`Reserved navigation field: ${entry.key}`);
    facts.set(entry.key, { value: structuredClone(entry.value), references: [...new Set(entry.references as string[])] });
  }
  for (const [key, fact] of facts) {
    const path = refPath(key);
    if (path.length === 2) own((graph as unknown as Record<string, Record<string, unknown>>)[path[0]], path[1], fact.value);
  }
  for (const [key, fact] of facts) {
    const path = refPath(key);
    if (path.length !== 4) continue;
    const parent = resolveFact(graph, `${path[0]}/${encodePart(path[1])}`);
    if (!Object.hasOwn(parent, path[2])) own(parent, path[2], {});
    if (!isRecord(parent[path[2]])) throw new Error(`Published member conflicts with fact: ${key}`);
    own(parent[path[2]] as Record<string, unknown>, path[3], fact.value);
  }
  for (const dataset of Object.values(graph.datasets)) {
    for (const role of ['fields', 'roles', 'bindings', 'dimensions', 'measures', 'time_roles', 'business_links']) {
      if (!Object.hasOwn(dataset, role)) own(dataset, role, {});
    }
  }
  const edges: ReferenceEdge[] = [];
  const direct = (fact: Record<string, unknown>, category: string, ref: string): void => {
    if (!Object.hasOwn(fact, category)) own(fact, category, []);
    const list = fact[category];
    if (isRecord(list)) return; // The owned member directory already provides this navigation.
    if (!Array.isArray(list) || list.some(value => typeof value !== 'string')) throw new Error(`Navigation category conflicts with model facts: ${category}`);
    if (!list.includes(ref)) list.push(ref);
  };
  const add = (fact: Record<string, unknown>, branch: string, category: string, ref: string): void => {
    if (!Object.hasOwn(fact, branch)) own(fact, branch, {});
    const into = fact[branch];
    if (!isRecord(into)) throw new Error('Invalid knowledge navigation');
    if (!Object.hasOwn(into, category)) own(into, category, []);
    const list = into[category];
    if (!Array.isArray(list)) throw new Error('Invalid knowledge navigation category');
    if (!list.includes(ref)) list.push(ref);
  };
  for (const [source, fact] of facts) {
    const path = refPath(source);
    for (const target of fact.references) {
      const targetFact = facts.get(target);
      if (targetFact === undefined) throw new Error(`Unresolved published knowledge reference: ${source} → ${target}`);
      direct(fact.value, refPath(target).at(-2)!, target);
      direct(targetFact.value, path.at(-2)!, source);
      add(fact.value, 'related', refPath(target).at(-2)!, target);
      add(targetFact.value, 'referenced_by', path.at(-2)!, source);
      edges.push({ source, target, link: 'Related' });
    }
    if (path.length === 4) {
      const parent = `${path[0]}/${encodePart(path[1])}`;
      add(fact.value, 'referenced_by', path[0], parent);
      edges.push({ source: parent, target: source, link: 'Member' });
    }
  }
  const items = new Map<string, KnowledgeItem>();
  for (const [key] of facts) items.set(key, { key, names: typeof facts.get(key)!.value.name === 'string' ? [facts.get(key)!.value.name as string] : [], doc: '' });
  for (const item of input.items) {
    if (!isRecord(item) || typeof item.key !== 'string' || !facts.has(item.key) || !Array.isArray(item.names) || item.names.some(name => typeof name !== 'string') || typeof item.doc !== 'string') throw new Error('Invalid knowledge presentation item');
    items.set(item.key, { key: item.key, names: item.names as string[], doc: item.doc });
  }
  if (presentation !== undefined) {
    if (!isRecord(presentation) || presentation.version !== 1 || !Array.isArray(presentation.items) || Object.keys(presentation).some(key => !['version', 'items'].includes(key))) throw new Error('Invalid external knowledge presentation');
    const seen = new Set<string>();
    for (const item of presentation.items) {
      if (!isRecord(item) || typeof item.key !== 'string' || !facts.has(item.key) || seen.has(item.key) || !Array.isArray(item.names) || item.names.some(name => typeof name !== 'string') || typeof item.doc !== 'string' || Object.keys(item).some(key => !['key', 'names', 'doc'].includes(key))) throw new Error('Invalid external knowledge presentation item');
      seen.add(item.key);
      const previous = items.get(item.key)!;
      items.set(item.key, { key: item.key, names: [...new Set([...previous.names, ...item.names as string[]])], doc: item.doc || previous.doc });
    }
  }
  graph.items = [...items.values()].sort((a, b) => a.key.localeCompare(b.key, 'en'));
  mountPresentationKnowledge(graph);
  const terms: Term[] = graph.items.map(item => {
    const path = refPath(item.key); const name = path.at(-1)!;
    return { key: item.key, kind: kindOf(path.at(-2)!), name, doc: item.doc, aliases: item.names.filter(alias => alias !== name), owner: path.length === 4 ? path[0] === 'datasets' ? 'dataset' : 'ty' : null, ownerValue: path.length === 4 ? path[1] : null };
  });
  return { revision: input.revision, knowledge: graph, sourceNodes: [], contract: { knowledge_contract: input.knowledge_contract, intent_contract: input.intent_contract, addressing: input.addressing },
    meta: { format: 'oks-knowledge-v3', revision: input.revision, roots: graphRoots, counts: Object.fromEntries(graphRoots.map(root => [root, Object.keys(graph[root] ?? {}).length])) },
    terms, keys: new Set(graph.items.map(item => item.key)), links: edges };
}
