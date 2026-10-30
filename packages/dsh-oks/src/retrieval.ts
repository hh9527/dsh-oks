import { collectProgrammedKnowledge, programmedKnowledgeContract } from './programmed-knowledge.ts';
import { derivePublishedKnowledge } from './published-knowledge.ts';
import type { SemanticGraph } from './knowledge-graph.ts';
import { isRecord } from './host.ts';
import type { LogFn } from './host.ts';
import type { Settings } from './config.ts';
import type { Runner } from './runners.ts';

/** 一条词条：检索与词汇表出口共用的最小面。 */
export interface Term {
  key: string;
  kind: string;
  name: string;
  doc: string;
  aliases: string[];
  owner: string | null;
  ownerValue: unknown;
}

/** 反向引用索引里的一条引用边。 */
export interface ReferenceEdge {
  source: string;
  target: string;
  link: string;
}

/** 内存里的检索层：词汇表 + 反向引用索引 + 已知 key 集合。 */
export interface RetrievalIndex {
  revision: string;
  knowledge: SemanticGraph;
  contract: unknown;
  meta: Record<string, unknown>;
  terms: Term[];
  keys: Set<string>;
  links: ReferenceEdge[];
}

/** 派生检索层需要的两处：设置（domain）与 wasm 宿主。 */
export interface IndexWorkspace {
  publishedKnowledge?: unknown;
  presentationItems?: unknown;
  settings: Settings;
  runner: Runner | null;
}

/** Execute the trusted build-time knowledge program and validate its result. */
export async function buildRetrievalIndex(entry: IndexWorkspace, sha: string, log: LogFn): Promise<RetrievalIndex> {
  if (!isRecord(entry.publishedKnowledge) || entry.publishedKnowledge.knowledge_contract !== programmedKnowledgeContract) {
    throw new Error(`dsh-oks: knowledge publication requires ${programmedKnowledgeContract}; rebuild the model`);
  }
  const result = await collectProgrammedKnowledge(entry.publishedKnowledge);
  const index = derivePublishedKnowledge(result.graph, entry.presentationItems, result.vocabulary);
  log(`[oks] build-time knowledge ${sha} · ${index.keys.size} facts`);
  return index;
}

/** 一行一条：- key:name,alias;doc。地址保留原文，词汇中的分隔符和换行归一为空格。 */
export function renderWholeVocabulary(index: RetrievalIndex): string {
  const plain = (text: string) => text.replace(/[\\,:;\s]+/g, ' ').trim();
  const sorted = [...index.terms].sort((left, right) => left.key.localeCompare(right.key, 'en'));
  return sorted.map(term => '- ' + term.key + ':'
    + [term.name, ...term.aliases].map(plain).join(',')
    + ';' + plain(term.doc)).join('\n');
}
