import { encodePart, refPath, graphRoots, resolveFact, type SemanticGraph } from './knowledge-graph.ts';

/** Public knowledge-node IDs; model/query names remain unchanged. */
export function semanticId(ref: string): string {
  return refPath(ref).map((part, i) => i % 2 ? encodePart(part) : part).join('/');
}
export function internalRef(id: string): string {
  const parts = id.split('/');
  if ((parts.length !== 2 && parts.length !== 4) || !graphRoots.includes(parts[0] as any) || id.includes('#')) {
    throw new Error('Invalid knowledge node ID: ' + id + '; use datasets/name or datasets/name/dimensions/name (copy IDs from search or KA)');
  }
  const ref = parts.slice(0, 2).join('/') + (parts.length === 4 ? '#' + parts.slice(2).join('/') : '');
  try { refPath(ref); } catch { throw new Error('Noncanonical knowledge node ID: ' + id + '; copy the encoded ID from search or KA'); } // Decode exactly once.
  return ref;
}
export function knowledgeNode(graph: SemanticGraph, id: string) {
  const ref = internalRef(id);
  const path = refPath(ref);
  if (path[0] === 'tools') throw new Error('Use a domain knowledge node ID');
  try { resolveFact(graph, ref); } catch { throw new Error('Unknown knowledge node ID: ' + id); }
  return { ref, path };
}
