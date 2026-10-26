import { collectProgrammedKnowledge, programmedKnowledgeContract } from './programmed-knowledge.ts';
import { derivePublishedKnowledge } from './published-knowledge.ts';
import type { SemanticGraph } from './knowledge-graph.ts';
import { oneLineText } from './text.ts';
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

/** 整份词汇一次性渲染：按 key 升序、一行一条 `"<key>" "<name>" [<aliases>] "<doc>"`（每个字段
 *  json 风格编码，aliases 是数组，doc 按词表原文给、只压成一行）。
 *  插件把它作为**一条消息**喂进助手的上下文——没有页眉页脚、没有分页、没有游标，模型不做任何搬运。 */
export function renderWholeVocabulary(index: RetrievalIndex): string {
  const sorted = [...index.terms].sort((left, right) => left.key.localeCompare(right.key, 'en'));
  return sorted.map((term) => [
    JSON.stringify(term.key),
    JSON.stringify(term.name),
    JSON.stringify(term.aliases),
    JSON.stringify(oneLineText(term.doc)),
  ].join(' ')).join('\n');
}
