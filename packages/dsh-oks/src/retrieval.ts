import { collectProgrammedKnowledge, programmedKnowledgeContract } from './programmed-knowledge.ts';
import { derivePublishedKnowledge } from './published-knowledge.ts';
import { refPath, type SemanticGraph } from './knowledge-graph.ts';
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

/** VA 检索候选由领域标识、名称和别名拆词并去重得到。 */
export function renderWholeVocabulary(index: RetrievalIndex): string {
  const kinds = new Set(['Dimension','Measure','Dataset','Entity','Ty','Type','Value','Field','Relation']);
  const words = new Set<string>();
  const shortStopWords = new Set(['an','as','at','be','by','do','if','in','is','it','of','on','or','so','to','up','we']);
  const explanations = new Set<string>();
  const inline = (value: string) => value.replace(/\s+/g, ' ').trim();
  const add = (value: string) => {
    const parts = value.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2').match(/[A-Za-z]+/g) ?? [];
    for (const part of parts) {
      const word = part.toLowerCase();
      if (word.length >= 2 && !shortStopWords.has(word)) words.add(word);
    }
  };
  for (const term of index.terms) {
    if (!kinds.has(term.kind)) continue;
    const id = refPath(term.key).at(-1)!;
    add(id);add(term.name);term.aliases.forEach(add);
    const doc = inline(term.doc);
    const names = [...new Set([term.name,...term.aliases].map(inline).filter(Boolean))];
    if (doc && names.length) explanations.add(`- ${names.join(',')}:${doc}`);
  }
  const sorted = (items: Set<string>) => [...items].sort((a, b) => a.localeCompare(b, 'en'));
  return '### 词表\n'+sorted(words).map(word=>'- '+word).join('\n')+'\n\n### 解释词表\n'+sorted(explanations).join('\n');
}
