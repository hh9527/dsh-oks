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

/** VA 专用领域词典；检索索引仍保留全部成员地址和原始词条。 */
export function renderWholeVocabulary(index: RetrievalIndex): string {
  const plain = (text: string) => text.replace(/[\\,:;\s]+/g, ' ').trim();
  const hash = /^[a-f0-9]{64}$/i;
  const groups = new Map<string, Map<string, string>>();
  for (const term of index.terms) {
    const generated = (word: string) => (['DimensionGroup', 'MeasureGroup'].includes(term.kind) && hash.test(word))
      || (term.kind === 'Role' && /^role_\d+$/.test(word))
      || (['DimensionGroup', 'MeasureGroup'].includes(term.kind)
        && (/^ns\/(dimension|sample)\/\d+$/.test(word) || ['search', 'exact', 'epoch_millis'].includes(word)));
    // Binding 的默认名称是序列化的执行表达式，不是领域词汇。
    const names = [...(term.kind === 'Binding' ? [] : [term.name]), ...term.aliases]
      .filter(word => !generated(word)).map(plain).filter(Boolean);
    const words = [...new Set(names)];
    if (!words.length) continue;
    const root = term.key.split('#', 1)[0];
    const rootId = root.slice(root.indexOf('/') + 1);
    // 无业务名字的生成分组已被排除；具名分组以名字作为检索上下文，不暴露哈希。
    const context = hash.test(rootId) ? '分组 ' + words.join(',') : root;
    let entries = groups.get(context);
    if (!entries) groups.set(context, entries = new Map());
    const line = '- ' + words.join(',') + ';' + plain(term.doc);
    entries.set(line, line);
  }
  return [...groups].sort(([a], [b]) => a.localeCompare(b, 'en'))
    .map(([context, entries]) => '[' + context + ']\n'
      + [...entries.values()].sort((a, b) => a.localeCompare(b, 'en')).join('\n')).join('\n\n');
}
