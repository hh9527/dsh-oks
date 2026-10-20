import { mountPresentationKnowledge } from './presentation-knowledge.ts';
import { buildSemanticGraph } from './knowledge-graph.ts';
import type { SemanticGraph } from './knowledge-graph.ts';
import { modelContracts } from './contracts.ts';
import { oneLineText, uniqueText } from './text.ts';
import { isArray, isRecord, isKnowledgeNode } from './host.ts';
import type { KnowledgeNode, LogFn, NodeDescription, NodeDetail } from './host.ts';
import type { Settings } from './config.ts';
import type { Runner } from './runners.ts';

// ── 检索层 ───────────────────────────────────────────────────────────────────
// 派生规则来自服务自己声明的**发现契约**：`<domain>/discovery` 返回 `revision`、入口
// `roots`、每类 key 的 `key_patterns`，以及 `vocabulary`——哪些 kind 进词汇表、每类词条的
// 归属字段（`owner`，既是 detail 字段名也是 key 模式里的占位符名）与必须非空的字段
// （`require`）。消费方沿 `info` 的引用图（`node.links`，`稳定 key）
// 走完整个图，再按 vocabulary 把节点派生成词汇表与引用边：不在 vocabulary 里的 kind
// 不进词汇表，即使它有声明的 key 模式。任何一步对不上契约都直接报错。

export const REFERENCE_KINDS = ['Member', 'Traversable', 'Related'];

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

/** 发现契约里的一条 vocabulary 声明。 */
export interface VocabularyItem {
  kind: string;
  owner?: string | null;
  require?: string | null;
}

/** 发现契约里的一条 key 模式声明。 */
export interface KeyPattern {
  kind: string;
  pattern?: unknown;
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
  sourceNodes: KnowledgeNode[];
  contract: unknown;
  meta: Record<string, unknown>;
  terms: Term[];
  keys: Set<string>;
  links: ReferenceEdge[];
}

/** 派生检索层需要的两处：设置（domain）与 wasm 宿主。 */
export interface IndexWorkspace {
  settings: Settings;
  runner: Runner | null;
}

/** 一个节点 → 一条词条。成员资格、归属与文本一律来自发现契约与节点自己的声明：
 *  `declaration` 是已确认包含该 kind 的那条 vocabulary 项。文本只取自节点自己声明的
 *  描述（summary/label/aliases、localized、terms）。 */
function deriveTerm(node: KnowledgeNode, declaration: VocabularyItem): Term {
  const parts = node.key.split('/').map((part) => decodeURIComponent(part));
  const name = parts[parts.length - 1];
  const detail: NodeDetail = node.detail ?? {};
  const description: NodeDescription = node.description ?? {};
  const localized = [...(description.localized ?? []), ...(detail.localized ?? [])];
  const terms = description.terms ?? [];
  const aliases = uniqueText([
    description.label,
    ...(description.aliases ?? []),
    ...localized.map((item) => item.label),
    ...terms.map((term) => term.term),
  ]).filter((alias) => alias !== name);
  const aliasDoc = (description.aliases ?? []).some((alias) => !terms.some((term) => term.term === alias))
    ? (description.summary || description.label)
    : '';
  const doc = uniqueText([
    description.summary,
    ...localized.map((item) => item.summary),
    ...terms.map((term) => term.description),
    aliasDoc,
  ]).join('\n');
  // canonical key 保留节点身份，并确定词汇表的稳定顺序。
  const entry: Term = { key: node.key, kind: declaration.kind, name, doc, aliases, owner: null, ownerValue: null };
  // 归属：声明了 owner 就取同名 detail 字段，输出行里也用这个字段名。
  if (typeof declaration.owner === 'string' && detail[declaration.owner] != null) {
    entry.owner = declaration.owner;
    entry.ownerValue = detail[declaration.owner];
  }
  return entry;
}

/** 派生：词条 + 反向引用索引 + 已知 key 集合。断言保留自发现契约，走样时直接报错。
 *  保留知识事实节点全文，知识访问与词汇派生共享同一次收集。 */
function deriveIndex(nodes: KnowledgeNode[], contract: {
  revision: string;
  vocabulary: VocabularyItem[];
  keyPatterns: KeyPattern[];
  discovery: unknown;
}): RetrievalIndex {
  const byKey = new Map<string, KnowledgeNode>(nodes.map((node) => [node.key, node]));
  const byKind = new Map<string, VocabularyItem>(contract.vocabulary.map((item) => [item.kind, item]));
  const terms: Term[] = [];
  const edges = new Map<string, ReferenceEdge>();
  for (const node of [...nodes].sort((left, right) => left.key.localeCompare(right.key, 'en'))) {
    for (const link of node.links) {
      if (!byKey.has(link.key)) throw new Error(`dsh-oks: 知识引用无法解析 ${node.key} → ${link.key}`);
      if (!REFERENCE_KINDS.includes(link.type)) throw new Error(`dsh-oks: 未知的引用种类 ${link.type}`);
      const edge = `${node.key}|${link.key}|${link.type}`;
      if (!edges.has(edge)) edges.set(edge, { source: node.key, target: link.key, link: link.type });
    }
    const declaration = byKind.get(node.type ?? "");
    if (declaration === undefined) continue; // 不在词汇表里的 kind：有 key 模式也不是词条
    const required = declaration.require;
    if (required != null && (node.detail ?? {})[required] == null) continue;
    terms.push(deriveTerm(node, declaration));
  }
  const {graph,addresses} = buildSemanticGraph(nodes);
  mountPresentationKnowledge(graph);
  for(const term of terms) term.key=addresses.get(term.key)!;
  return {
    sourceNodes: nodes, contract: contract.discovery,
    knowledge: graph,
    meta: {
      format: 'oks-knowledge-v2', revision: contract.revision,
      roots: ['datasets','types','relations','tools'],
      counts: {datasets:Object.keys(graph.datasets).length,types:Object.keys(graph.types).length,relations:Object.keys(graph.relations).length,tools:Object.keys(graph.tools).length,items:graph.items.length},
    },
    revision: contract.revision,
    terms,
    keys: new Set(graph.items.map(item=>item.key)),
    links: [...edges.values()].filter(e=>addresses.has(e.source)&&addresses.has(e.target)).map(e=>({...e,source:addresses.get(e.source)!,target:addresses.get(e.target)!})),

  };
}

/** 按发现契约爬完整个图并派生。首次检索时同步执行（同步阻塞，便于先跑通）。 */
export async function buildRetrievalIndex(entry: IndexWorkspace, sha: string, log: LogFn): Promise<RetrievalIndex> {
  const started = Date.now();
  const { domain } = entry.settings;
  // ensureWorkspace 返回前一定装配好宿主；这里按这个约定断言。
  const runner = entry.runner!;
  const discovery = await runner.send(`${domain}/discovery`, {});
  if (discovery?.error === true) {
    throw new Error(`dsh-oks: ${domain}/discovery 失败：`
      + `${discovery?.diagnostics?.[0]?.message ?? '未知错误'}；检索需要这条路由。`);
  }
  const ok = discovery?.ok;
  if (ok === null || typeof ok !== 'object' || Array.isArray(ok)) {
    throw new Error(`dsh-oks: ${domain}/discovery 没有返回发现契约`
      + '（ok 需要 {revision, roots, key_patterns, vocabulary}）。');
  }
  if (ok.knowledge_contract !== modelContracts.knowledge || ok.intent_contract !== modelContracts.intent) {
    throw new Error('dsh-oks: 模型契约不兼容，需要 ontology-knowledge-v3 / ontology-intent-v1；请用配套本体版本重建快照。');
  }
  if (ok.addressing !== 'node-member-uri-v1') throw new Error('dsh-oks: 模型地址契约不兼容');
  const rawRoots = ok.roots;
  if (!isArray(rawRoots)) {
    throw new Error(`dsh-oks: ${domain}/discovery 没有声明入口 roots（发现契约的 roots 是入口 key 的数组）`);
  }
  const rawVocabulary = ok.vocabulary;
  if (!isArray(rawVocabulary)) {
    throw new Error(`dsh-oks: ${domain}/discovery 没有声明 vocabulary`
      + '（发现契约用 vocabulary 声明哪些 kind 进词汇表，以及每类词条的 owner 与 require）');
  }
  const revision = ok.revision;
  if (typeof revision !== 'string' || revision === '') {
    throw new Error(`dsh-oks: ${domain}/discovery 没有声明 revision`);
  }
  const vocabulary: VocabularyItem[] = [];
  for (const item of rawVocabulary) {
    if (!isRecord(item) || typeof item.kind !== 'string' || item.kind === '') {
      throw new Error(`dsh-oks: ${domain}/discovery 的 vocabulary 里有不合法的条目`
        + '（每条需要 kind，可带 owner / require）');
    }
    for (const field of ['owner', 'require'] as const) {
      const value = item[field];
      if (value !== undefined && value !== null && (typeof value !== 'string' || value === '')) {
        throw new Error(`dsh-oks: ${domain}/discovery 的 vocabulary 里 ${item.kind} 的 ${field} 不是字段名`);
      }
    }
    vocabulary.push({
      kind: item.kind,
      owner: typeof item.owner === 'string' ? item.owner : null,
      require: typeof item.require === 'string' ? item.require : null,
    });
  }
  const keyPatterns = isArray(ok.key_patterns)
    ? ok.key_patterns.filter((item): item is KeyPattern => isRecord(item) && typeof item.kind === 'string')
    : [];
  const roots = rawRoots;
  if (roots.length === 0) throw new Error(`dsh-oks: ${domain}/discovery 没有返回任何入口 key`);
  const pending = [...new Set<unknown>(['index', ...roots])];
  const seen = new Set<unknown>(pending);
  const nodes: KnowledgeNode[] = [];
  for (const key of pending) {
    const response = await runner.send(`${domain}/info`, { key });
    const document = response?.ok?.Document;
    const node = document === null || typeof document !== 'object' ? undefined : document.Found;
    if (!isKnowledgeNode(node) || node.key !== key) {
      throw new Error(`dsh-oks: 无法解析知识 key ${key}（发现契约要求每个入口都能取到节点）`);
    }
    nodes.push(node);
    for (const link of node.links) {
      if (typeof link?.key === 'string' && !seen.has(link.key)) {
        seen.add(link.key);
        pending.push(link.key);
      }
    }
  }
  if (nodes.some(node => node.type === 'Schema')) {
    throw new Error('dsh-oks: ontology-knowledge-v3 图只能发布知识事实，发现操作 Schema；请重建正确的模型快照。');
  }
  const indexNode = nodes.find(node => node.key === 'index');
  if (indexNode?.detail?.revision !== revision) throw new Error('dsh-oks: 模型发现与知识图版本不一致。');
  const index = deriveIndex(nodes, { revision, vocabulary, keyPatterns, discovery: ok });
  log(`[oks] discovery index · ${index.revision} · ${sha.slice(0, 12)} · `
    + `${nodes.length} 节点 · ${index.terms.length} 词条 · ${index.links.length} 引用 · ${Date.now() - started} ms`);
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
