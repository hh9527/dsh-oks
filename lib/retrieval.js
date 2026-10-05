import { capLine, normalize, oneLineText, tokenize, uniqueText } from './text.js';

// ── 检索层 ───────────────────────────────────────────────────────────────────
// 派生规则来自服务自己声明的**发现契约**：`<domain>/discovery` 返回 `revision`、入口
// `roots`、每类 key 的 `key_patterns`，以及 `vocabulary`——哪些 kind 进词汇表、每类词条的
// 归属字段（`owner`，既是 detail 字段名也是 key 模式里的占位符名）与必须非空的字段
// （`require`）。消费方沿 `info` 的引用图（`node.links`，`Index` 另加 `detail.schemas`）
// 走完整个图，再按 vocabulary 把节点派生成词汇表与引用边：不在 vocabulary 里的 kind
// 不进词汇表，即使它有声明的 key 模式。任何一步对不上契约都直接报错。

const SEARCH_BUDGET_CHARS = 5600;
const REFERENCE_BUDGET_CHARS = 5600;
// 词汇表出口：整页（首行 + 词条行 + 页脚）的 UTF-8 字节数留在 6000 以内，装页时先扣掉
// 首行与页脚的余量。按字节算是因为页里会有中文 alias/doc——同一个页在字符口径下只会更小。
// 一条词条的说明最多给这么多字符：一页要装下尽量多的词条，doc 是补充不是主体。
const VOCABULARY_DOC_CHARS = 200;
const FACET_DATASET_CHARS = 300;
export const REFERENCE_KINDS = ['Member', 'Traversable', 'Related'];

/** 一个节点 → 一条词条。成员资格、归属与文本一律来自发现契约与节点自己的声明：
 *  `declaration` 是已确认包含该 kind 的那条 vocabulary 项。文本只取自节点自己声明的
 *  描述（summary/label/aliases、localized、terms）。 */
function deriveTerm(node, declaration) {
  const parts = node.key.split('/').map((part) => decodeURIComponent(part));
  const name = parts[parts.length - 1];
  const detail = node.detail ?? {};
  const description = node.description ?? {};
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
  // `key` 只为确定顺序（词汇表出口按它排序）；检索出口不回 key，由 agent 按声明模式自己拼。
  const entry = { key: node.key, kind: declaration.kind, name, doc, aliases, owner: null, ownerValue: null };
  // 归属：声明了 owner 就取同名 detail 字段，输出行里也用这个字段名。
  if (typeof declaration.owner === 'string' && detail[declaration.owner] != null) {
    entry.owner = declaration.owner;
    entry.ownerValue = detail[declaration.owner];
  }
  return entry;
}

/** 派生：词条 + 反向引用索引 + 已知 key 集合。断言保留自发现契约，走样时直接报错。
 *  这里只留下检索需要的东西；节点本身不保留——读节点始终由 oks_info 透传给服务。 */
function deriveIndex(nodes, contract) {
  const byKey = new Map(nodes.map((node) => [node.key, node]));
  const byKind = new Map(contract.vocabulary.map((item) => [item.kind, item]));
  const terms = [];
  const edges = new Map();
  for (const node of [...nodes].sort((left, right) => left.key.localeCompare(right.key, 'en'))) {
    for (const link of node.links) {
      if (!byKey.has(link.key)) throw new Error(`dsh-oks: 知识引用无法解析 ${node.key} → ${link.key}`);
      if (!REFERENCE_KINDS.includes(link.type)) throw new Error(`dsh-oks: 未知的引用种类 ${link.type}`);
      const edge = `${node.key}|${link.key}|${link.type}`;
      if (!edges.has(edge)) edges.set(edge, { source: node.key, target: link.key, link: link.type });
    }
    const declaration = byKind.get(node.key.split('/')[0]);
    if (declaration === undefined) continue; // 不在词汇表里的 kind：有 key 模式也不是词条
    if (declaration.require != null && (node.detail ?? {})[declaration.require] == null) continue;
    terms.push(deriveTerm(node, declaration));
  }
  const linksByTarget = new Map();
  for (const edge of edges.values()) {
    if (!linksByTarget.has(edge.target)) linksByTarget.set(edge.target, []);
    linksByTarget.get(edge.target).push({ link: edge.link, source: edge.source });
  }
  const kindCounts = contract.vocabulary
    .map((item) => [item.kind, terms.filter((term) => term.kind === item.kind).length])
    .filter(([, count]) => count > 0);
  const datasets = [...new Set(terms
    .filter((term) => term.owner === 'dataset')
    .map((term) => String(term.ownerValue)))].sort();
  return {
    revision: contract.revision,
    terms,
    keys: new Set(byKey.keys()),
    vocabKinds: contract.vocabulary.map((item) => item.kind),
    patterns: new Map(contract.keyPatterns.map((item) => [item.kind, item.pattern])),
    links: [...edges.values()],
    linksByTarget,
    facets: {
      kinds: kindCounts.map(([kind, count]) => `${kind} ${count}`).join(' · '),
      datasets: `${datasets.length} 个：${capLine(datasets.join(', '), FACET_DATASET_CHARS)}`,
    },
  };
}

/** 请求了不在词汇表里的 kind 时，把"可发现性"讲清楚：词汇表收录哪些、哪些只是有 key 模式。 */
function kindError(index, kind, where) {
  const available = index.vocabKinds.join(' / ');
  const pattern = index.patterns.get(kind);
  if (pattern === undefined) {
    return new Error(`dsh-oks: ${where} 的 kind ${kind} 不存在：发现契约的 key 模式与词汇表里都没有它。`
      + `词汇表收录的 kind：${available}。`);
  }
  return new Error(`dsh-oks: ${where} 的 kind ${kind} 不可检索：它有声明的 key 模式 ${pattern}，`
    + `但不属这个产物的词汇表；这类 key 从节点自身的引用里得到（oks_info / oks_references）。`
    + `词汇表收录的 kind：${available}。`);
}

/** 按发现契约爬完整个图并派生。首次检索时同步执行（同步阻塞，便于先跑通）。 */
export async function buildRetrievalIndex(entry, sha, log) {
  const started = Date.now();
  const { domain } = entry.settings;
  const discovery = await entry.runner.send(`${domain}/discovery`, {});
  if (discovery?.error === true) {
    throw new Error(`dsh-oks: ${domain}/discovery 失败：`
      + `${discovery?.diagnostics?.[0]?.message ?? '未知错误'}；检索需要这条路由。`);
  }
  const ok = discovery?.ok;
  if (ok === null || typeof ok !== 'object' || Array.isArray(ok)) {
    throw new Error(`dsh-oks: ${domain}/discovery 没有返回发现契约`
      + '（ok 需要 {revision, roots, key_patterns, vocabulary}）。');
  }
  if (!Array.isArray(ok.roots)) {
    throw new Error(`dsh-oks: ${domain}/discovery 没有声明入口 roots（发现契约的 roots 是入口 key 的数组）`);
  }
  if (!Array.isArray(ok.vocabulary)) {
    throw new Error(`dsh-oks: ${domain}/discovery 没有声明 vocabulary`
      + '（发现契约用 vocabulary 声明哪些 kind 进词汇表，以及每类词条的 owner 与 require）');
  }
  if (typeof ok.revision !== 'string' || ok.revision === '') {
    throw new Error(`dsh-oks: ${domain}/discovery 没有声明 revision`);
  }
  for (const item of ok.vocabulary) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)
      || typeof item.kind !== 'string' || item.kind === '') {
      throw new Error(`dsh-oks: ${domain}/discovery 的 vocabulary 里有不合法的条目`
        + '（每条需要 kind，可带 owner / require）');
    }
    for (const field of ['owner', 'require']) {
      const value = item[field];
      if (value !== undefined && value !== null && (typeof value !== 'string' || value === '')) {
        throw new Error(`dsh-oks: ${domain}/discovery 的 vocabulary 里 ${item.kind} 的 ${field} 不是字段名`);
      }
    }
  }
  const keyPatterns = Array.isArray(ok.key_patterns)
    ? ok.key_patterns.filter((item) => item !== null && typeof item === 'object' && typeof item.kind === 'string')
    : [];
  const roots = ok.roots;
  if (roots.length === 0) throw new Error(`dsh-oks: ${domain}/discovery 没有返回任何入口 key`);
  const pending = [...new Set(['index', ...roots])];
  const seen = new Set(pending);
  const nodes = [];
  for (const key of pending) {
    const response = await entry.runner.send(`${domain}/info`, { key });
    const node = response?.ok?.Document?.Found;
    if (node?.key !== key || !Array.isArray(node.links)) {
      throw new Error(`dsh-oks: 无法解析知识 key ${key}（发现契约要求每个入口都能取到节点）`);
    }
    nodes.push(node);
    for (const link of node.links) {
      if (typeof link?.key === 'string' && !seen.has(link.key)) {
        seen.add(link.key);
        pending.push(link.key);
      }
    }
    if (node.type === 'Index' && Array.isArray(node.detail?.schemas)) {
      for (const schema of node.detail.schemas) {
        if (typeof schema === 'string' && !seen.has(schema)) {
          seen.add(schema);
          pending.push(schema);
        }
      }
    }
  }
  const index = deriveIndex(nodes, { revision: ok.revision, vocabulary: ok.vocabulary, keyPatterns });
  log(`[oks] discovery index · ${index.revision} · ${sha.slice(0, 12)} · `
    + `${nodes.length} 节点 · ${index.terms.length} 词条 · ${index.links.length} 引用 · ${Date.now() - started} ms`);
  return index;
}

/** 一条词条 → 检索结果行（不含 key：agent 按声明的 key 模式自己拼）。
 *  词条声明了 owner 时，行里用 owner 这个名字作字段。 */
function termRow(term, field, score) {
  const row = { kind: term.kind, name: term.name, field, score };
  if (term.owner !== null) row[term.owner] = term.ownerValue;
  return row;
}

// 行里除协议字段外至多一个字段——它是该词条的归属，字段名由词汇表声明。
const ROW_FIELDS = new Set(['kind', 'name', 'field', 'score']);
const termOwner = (row) => {
  for (const [name, value] of Object.entries(row)) if (!ROW_FIELDS.has(name)) return `[${value}]`;
  return '';
};
const termLine = (row) => {
  const owner = termOwner(row);
  return `${row.kind}  ${row.name}${owner === '' ? '' : `  ${owner}`}  ${row.field} ${row.score}`;
};

/** 匹配：对 name / aliases / doc 做模糊匹配（AND 全部查询词），报出命中的那一类。 */
function matchTerm(term, tokens, query) {
  const name = normalize(term.name);
  const aliasText = normalize(term.aliases.join(' '));
  const docText = normalize(term.doc);
  const all = `${name} ${aliasText} ${docText}`;
  if (!tokens.every((token) => all.includes(token))) return null;
  if (tokens.every((token) => name.includes(token))) return { field: 'name', score: name === query ? 1 : 0.9 };
  if (tokens.every((token) => aliasText.includes(token))) return { field: 'alias', score: 0.7 };
  if (tokens.every((token) => docText.includes(token))) return { field: 'doc', score: 0.5 };
  return { field: 'doc', score: 0.3 };
}

/** 检索：过滤 → 稳定排序 → 按字节装页。`skip` 是分页起点，`more` 是剩余条数。 */
export function searchIndex(index, args) {
  const query = normalize(args?.query ?? '').trim();
  const kind = typeof args?.kind === 'string' && args.kind !== '' ? args.kind : null;
  const dataset = typeof args?.dataset === 'string' && args.dataset !== '' ? args.dataset : null;
  const skip = Number.isInteger(args?.skip) && args.skip > 0 ? args.skip : 0;
  if (kind !== null && !index.vocabKinds.includes(kind)) throw kindError(index, kind, 'oks_search');
  const tokens = tokenize(query);
  const matched = [];
  for (const term of index.terms) {
    if (kind !== null && term.kind !== kind) continue;
    if (dataset !== null && !(term.owner === 'dataset' && String(term.ownerValue) === dataset)) continue;
    if (tokens.length === 0) { matched.push({ term, field: 'all', score: 0 }); continue; }
    const hit = matchTerm(term, tokens, query);
    if (hit !== null) matched.push({ term, ...hit });
  }
  matched.sort((left, right) => right.score - left.score
    || left.term.kind.localeCompare(right.term.kind, 'en')
    || String(left.term.ownerValue ?? '').localeCompare(String(right.term.ownerValue ?? ''), 'en')
    || left.term.name.localeCompare(right.term.name, 'en'));
  const total = matched.length;
  const page = matched.slice(skip);
  const rows = [];
  let used = 0;
  for (const item of page) {
    const row = termRow(item.term, item.field, item.score);
    const size = termLine(row).length + 1;
    if (used + size > SEARCH_BUDGET_CHARS) break;
    used += size;
    rows.push(row);
  }
  const remaining = total - skip - rows.length;
  return { start: skip, total, more: remaining > 0 ? remaining : null, matched: rows, facets: index.facets };
}

/** 反向引用：`skip` 分页；未知 key 直接报错（区别于"没有任何引用"）。 */
export function referencesOf(index, args) {
  const key = typeof args?.key === 'string' && args.key !== '' ? args.key : null;
  if (key === null) throw new Error('dsh-oks: oks_references 需要 key');
  const link = typeof args?.link === 'string' && args.link !== '' ? args.link : null;
  const kind = typeof args?.kind === 'string' && args.kind !== '' ? args.kind : null;
  const skip = Number.isInteger(args?.skip) && args.skip > 0 ? args.skip : 0;
  if (link !== null && !REFERENCE_KINDS.includes(link)) {
    throw new Error(`dsh-oks: link 只能是 ${REFERENCE_KINDS.join(' / ')}`);
  }
  if (kind !== null && !index.vocabKinds.includes(kind)) throw kindError(index, kind, 'oks_references');
  if (!index.keys.has(key)) {
    throw new Error(`dsh-oks: ${key} 不是这个产物里的知识 key（用 oks_search 先找到 key）`);
  }
  const all = (index.linksByTarget.get(key) ?? [])
    .filter((reference) => link === null || reference.link === link)
    .filter((reference) => kind === null || reference.source.split('/')[0] === kind)
    .sort((left, right) => left.link.localeCompare(right.link, 'en') || left.source.localeCompare(right.source, 'en'));
  const total = all.length;
  const page = all.slice(skip);
  const rows = [];
  let used = 0;
  for (const reference of page) {
    const line = `${reference.link}  ${reference.source}`;
    if (used + line.length + 1 > REFERENCE_BUDGET_CHARS) break;
    used += line.length + 1;
    rows.push(reference);
  }
  const remaining = total - skip - rows.length;
  return { key, start: skip, total, more: remaining > 0 ? remaining : null, references: rows };
}

/** 一条词条 → 词汇表出口的一条：kind / name / aliases / doc，声明了 owner 就带 owner 字段。
 *  aliases 全给（它是这个出口的主要价值）；doc 是给"区分同名词条"用的，截到 DOC_CHARS。 */
function vocabularyEntry(term) {
  const entry = {
    kind: term.kind,
    name: term.name,
    aliases: term.aliases,
    doc: capLine(oneLineText(term.doc), VOCABULARY_DOC_CHARS),
  };
  if (term.owner !== null) entry[term.owner] = term.ownerValue;
  return entry;
}

// 词条里除协议字段外至多一个字段——它是该词条的归属，字段名由词汇表声明。
const VOCABULARY_FIELDS = new Set(['kind', 'name', 'aliases', 'doc']);
const vocabularyOwner = (entry) => {
  for (const [name, value] of Object.entries(entry)) if (!VOCABULARY_FIELDS.has(name)) return `[${value}]`;
  return '';
};

/** 词条行：` · ` 连接的 kind / name / [owner] / 全部 aliases。aliases 为空时 doc 是唯一能
 *  区分它的文本，再附一行。装页与渲染用的是同一份行，所以"整条截止"不会截到半条。 */
function vocabularyEntryLines(entry) {
  const parts = [entry.kind, entry.name];
  const owner = vocabularyOwner(entry);
  if (owner !== '') parts.push(owner);
  parts.push(...entry.aliases);
  const lines = [parts.join(' · ')];
  if (entry.aliases.length === 0 && entry.doc !== '') lines.push(`    ${entry.doc}`);
  return lines;
}

/** 整份词汇：按 key 排序（确定，翻页不重、不漏）→ 按字节装页（整条截止）。
 *  与检索不同，这里不筛不排：用途是把整份词汇原样交给词汇助手，而不是在工作会话里筛着看。 */
/** 整份词汇一次性渲染：一行一条、无页眉页脚。插件把它作为**一条消息**喂进助手的上下文，
 *  所以这里没有分页、没有游标、也没有"下一页"——模型不做任何搬运。 */
export function renderWholeVocabulary(index) {
  const sorted = [...index.terms].sort((left, right) => left.key.localeCompare(right.key, 'en'));
  return sorted.map((term) => vocabularyEntryLines(vocabularyEntry(term)).join('\n')).join('\n');
}

export function renderSearch(_args, value) {
  const lines = [`命中 ${value.total} · 从 ${value.start} 起显示 ${value.matched.length} 条`
    + `${value.more === null ? '（已到底）' : ` · 还有 ${value.more}`}`];
  if (value.matched.length === 0) {
    lines.push('', '没有匹配。可用的 kind：' + value.facets.kinds, '可用的 dataset：' + value.facets.datasets,
      '换个说法，或用 kind= / dataset= 收窄。');
  } else {
    for (const row of value.matched) lines.push(termLine(row));
    lines.push('', '用 index 里声明的 key 模式把 kind/name[/owner] 拼成 key，再用 oks_info 读节点。');
  }
  return [{ type: 'text', text: `${lines.join('\n')}\n` }];
}

/** oks_references 的模型可见渲染：谁引用了这个 key（`link` 是引用种类）。 */
export function renderReferences(_args, value) {
  const lines = [`引用 ${value.key} 的共 ${value.total} 条 · 从 ${value.start} 起显示 ${value.references.length} 条`
    + `${value.more === null ? '（已到底）' : ` · 还有 ${value.more}`}`];
  if (value.references.length === 0) lines.push('', '没有任何节点引用它。');
  else for (const row of value.references) lines.push(`${row.link}  ${row.source}`);
  return [{ type: 'text', text: `${lines.join('\n')}\n` }];
}

/** oks_vocabulary 的模型可见渲染：概况 + 一行一条。归属带方括号（与检索出口同一套写法），
 *  aliases 全给；没有 aliases 时才附 doc 行——那时它是唯一能区分这条词条的文本。 */
