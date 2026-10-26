import { isRecord } from './host.ts';

export const programmedKnowledgeContract = 'ontology-knowledge-javascript-v1';
export interface ModelKnowledge {
  graph: Record<string, unknown>;
  vocabulary: unknown[];
}

/** A trusted static model program accepts parsed JSON and returns knowledge once. */
export async function collectProgrammedKnowledge(publication: unknown): Promise<ModelKnowledge> {
  if (!isRecord(publication) || publication.knowledge_contract !== programmedKnowledgeContract ||
      typeof publication.program !== 'string' || !publication.program.trim() || !isRecord(publication.data)) {
    throw new Error('Invalid JavaScript knowledge publication');
  }
  const buildKnowledge = new Function('data', publication.program) as (data: Record<string, unknown>) => unknown;
  const built = buildKnowledge(publication.data);
  if (!isRecord(built) || !isRecord(built.graph) || !Array.isArray(built.vocabulary)) {
    throw new Error('Invalid built knowledge graph or vocabulary');
  }
  return { graph: built.graph, vocabulary: built.vocabulary };
}
