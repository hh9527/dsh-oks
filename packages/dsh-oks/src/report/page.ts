/** 报告页面：元数据区 + 结构区，写出来与读回来都走这里。
 *
 *  页面由我们生成，因此**写入时自校验为良构 XML**（`checkWellFormed`），读回按严格 XML 解析——
 *  不需要宽容的 HTML 解析路径。元数据区是来源链、展示项与源码资源唯一的家；结构区只写人读的东西，
 *  靠 `data-oks-ref` 引用元数据里的项。
 */
import { createHash } from 'node:crypto';
import { embedArtifactMeta } from '../results.ts';
import type { ArtifactMeta, DataOrigin, OriginNode } from '../results.ts';
import { REPORT_STYLE } from '../chart/report.ts';
import { escapeHtml } from '../chart/markdown.ts';
import { errorText } from '../host.ts';
import { checkWellFormed, escapeAttribute, extractStructure, readElementText, rewriteXml } from './xhtml.ts';
import type { ElementPolicy } from './xhtml.ts';

/** 元数据区在页面里的 id。 */
export const REPORT_METADATA_ID = 'oks-metadata';

/** 报告内联资源的引用前缀：工作区路径解析器明确拒绝它，隔离由协议保证。 */
export const ASSET_SCHEME = 'src://';

/** 元数据区的 JSON。XML 里 `<script>` 是普通文本，所以 `<`、`&` 与 `>` 都写成 JSON 的 \uXXXX 转义：
 *  一个 `</script>`、一个 `&`、或文本里出现 `]]>`（XML 明文里非法）都会让整页不再是良构 XML。
 *  三者都转义之后，数据与源码里出现什么字符都不会影响页面。 */
export const metadataJson = (payload: { origin: unknown; assets: unknown; items: unknown }): string =>
  JSON.stringify(payload)
    .replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');

/** 资源 key：`<原文件名主干>-<源码 SHA-256 前 16 位>`。工具生成的程序没有文件说明，用固定主干。 */
export function assetKey(snipFile: string | undefined, source: string): string {
  const base = snipFile === undefined ? 'identity' : snipFile.split('/').pop() ?? 'program';
  const stem = base.replace(/\.[^.]+$/, '') || 'program';
  return `${stem}-${createHash('sha256').update(source, 'utf8').digest('hex').slice(0, 16)}`;
}

/** 组装报告时：把来源节点里内嵌的程序正文提取成资源，节点改用 `src://` 引用。 */
export function extractAssets(origin: DataOrigin): { origin: DataOrigin; assets: Record<string, string> } {
  const assets: Record<string, string> = {};
  const nodes: Record<string, OriginNode> = {};
  for (const [id, node] of Object.entries(origin.nodes)) {
    if (node.snip === undefined) {
      nodes[id] = { ...node };
      continue;
    }
    const key = assetKey(node.snipFile, node.snip);
    const seen = assets[key];
    if (seen !== undefined && seen !== node.snip) {
      throw new Error(`资源 key ${key} 同时对应两段不同的源码：程序的命名与内容必须一一对应。`);
    }
    assets[key] = node.snip;
    // 就地改名：`snip` 换成 `byFile`，字段位置与其余字段都不动，于是"提取 → 还原"逐字节可逆。
    nodes[id] = Object.fromEntries(Object.entries(node).map(([field, value]) => (
      field === 'snip' ? ['byFile', `${ASSET_SCHEME}${key}`] : [field, value]
    ))) as OriginNode;
  }
  return { origin: { root: origin.root, nodes }, assets };
}

/** 读回报告继续加工时：把 `src://` 引用还原成内嵌正文，节点记录与提取前一致。 */
export function restoreAssets(origin: DataOrigin, assets: Record<string, string>): DataOrigin {
  const nodes: Record<string, OriginNode> = {};
  for (const [id, node] of Object.entries(origin.nodes)) {
    const ref = node.byFile;
    if (ref === undefined || !ref.startsWith(ASSET_SCHEME)) {
      nodes[id] = { ...node };
      continue;
    }
    const key = ref.slice(ASSET_SCHEME.length);
    const source = assets[key];
    if (source === undefined) throw new Error(`报告缺少资源 ${key}：来源链引用的源码不在 assets 里。`);
    nodes[id] = Object.fromEntries(Object.entries(node).map(([field, value]) => (
      field === 'byFile' ? ['snip', source] : [field, value]
    ))) as OriginNode;
  }
  return { root: origin.root, nodes };
}

/** 渲染结构区：把绑定值填进 span、把展示件内联进 figure，并给图注戴上编号。 */
/** 结构区里的章节：按出现顺序给锚点（作者写了 `id` 就用它），目录与渲染共用这一份。
 *  传入的是解析结果里的章节清单——解析器给出的是真元素，注释里的示例不算。 */
export const outlineOf = (
  headings: ReadonlyArray<{ level: number; text: string; id: string | null }>,
): Array<{ level: number; text: string; id: string }> =>
  headings.map((heading, at) => ({
    level: heading.level,
    text: heading.text,
    id: heading.id ?? `section-${at + 1}`,
  }));

export function renderStructure(input: {
  xhtml: string;
  figurePlacement?: 'before-caption';
  /** 章节锚点，按 `outlineOf` 的顺序与之一一对应。 */
  outline: ReadonlyArray<{ level: number; text: string; id: string }>;
  /** 取一个引用项的值（`pick` 是作者写的点路径，可能未给）；返回值会被当纯文本转义。 */
  valueOf: (ref: string, pick: string | undefined) => string;
  /** 引用项的内联内容与编号；返回 undefined 表示这项不进正文（例如只作数据引用）。 */
  inlineOf: (ref: string) => { html: string; label: string; table?: boolean } | undefined;
}): { article: string; errors: ReturnType<typeof checkWellFormed> } {
  // 当前打开的 figure 栈：`figcaption` 要据此知道自己属于哪一项，好在图注前放编号。
  const figures: Array<string | undefined> = [];
  let heading = 0;
  const rendered = rewriteXml(input.xhtml, {
    // 目录锚点与表格样式由渲染层补：作者写内容，工具管版面。
    attributes: (tag) => {
      if (tag.name === 'h1' || tag.name === 'h2' || tag.name === 'h3') {
        const entry = input.outline[heading];
        heading += 1;
        return entry === undefined || tag.attributes['id'] !== undefined
          ? undefined
          : { ...tag.attributes, id: entry.id };
      }
      if (tag.name === 'figure') {
        const ref = tag.attributes['data-oks-ref'];
        const inline = ref === undefined ? undefined : input.inlineOf(ref);
        return inline?.table === true ? { ...tag.attributes, class: [tag.attributes.class,'table-block'].filter(Boolean).join(' ') } : undefined;
      }
      // 有来源的数字带一句悬停提示：引用键 + 取值路径。只放机器值，也只在作者没写 title 时补。
      if (tag.name === 'span') {
        const ref = tag.attributes['data-oks-ref'];
        if (ref === undefined || tag.attributes['title'] !== undefined) return undefined;
        const pick = tag.attributes['data-oks-pick'];
        return { ...tag.attributes, title: pick === undefined || pick === '.' ? ref : `${ref}${pick}` };
      }
      return undefined;
    },
    policy: (tag): ElementPolicy | undefined => {
      const ref = tag.attributes['data-oks-ref'];
      if (tag.name === 'figure') figures.push(ref);
      // 图注自己不带引用，要按"当前打开的 figure"决定它属于哪一项，所以先判它。
      if (tag.name === 'figcaption') {
        const owner = figures[figures.length - 1];
        const inline = owner === undefined ? undefined : input.inlineOf(owner);
        return inline === undefined
          ? undefined
          : { kind: 'keep', prepend: `<span class="item-no">${escapeHtml(inline.label)}${input.figurePlacement?'：':''}</span>` };
      }
      if (ref === undefined) return undefined;
      if (tag.name === 'span') {
        return { kind: 'replace', text: input.valueOf(ref, tag.attributes['data-oks-pick']) };
      }
      if (tag.name === 'figure') {
        const inline = input.inlineOf(ref);
        return { kind: 'keep', ...(inline === undefined ? {} : (input.figurePlacement?{prepend:inline.html}:{append:inline.html})) };
      }
      return undefined;
    },
    close: (name) => {
      if (name === 'figure') figures.pop();
    },
  });
  return { article: rendered.xml, errors: rendered.errors };
}

export interface ReportPageInput {
  meta: ArtifactMeta;
  subtitle: string | null;
  generatedAt: string;
  /** 渲染好的结构区（`renderStructure` 的产物）。 */
  article: string;
  origin: DataOrigin;
  assets: Record<string, string>;
  items: Record<string, unknown>;
  /** 章节标题（取自结构区的 h1–h3），用于目录。 */
  outline: Array<{ level: number; text: string; id: string }>;
}

/** 拼出一份自足的报告页面；写完立刻自校验，不良构就当场失败（不留半个交付物）。 */
export function buildReportPage(input: ReportPageInput): string {
  const title = input.meta.title ?? input.meta.name;
  const nav = input.outline
    .filter((heading) => heading.level <= 2)
    .map((heading) => `<a href="#${escapeAttribute(heading.id)}">${escapeHtml(heading.text)}</a>`)
    .join('');
  const page = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<style>
${REPORT_STYLE}
</style>
<script type="application/json" id="${REPORT_METADATA_ID}">${metadataJson({ origin: input.origin, assets: input.assets, items: input.items })}</script>
</head>
<body>
<header>
<h1>${escapeHtml(title)}</h1>
${input.subtitle === null ? '' : `<p class="subtitle">${escapeHtml(input.subtitle)}</p>`}
<p class="meta">生成于 ${escapeHtml(input.generatedAt)}</p>
</header>
${nav === '' ? '' : `<nav><span class="nav-title">目录</span>${nav}</nav>`}
${input.article}
<footer>本报告由 oks 插件生成 · 单文件自足；引用项的最终数据、来源链与源码资源都在页面里（${REPORT_METADATA_ID}）</footer>
</body>
</html>
`;
  const named = embedArtifactMeta(page, input.meta);
  const errors = checkWellFormed(named);
  if (errors.length > 0) {
    const first = errors[0]!;
    throw new Error(`报告页面不是良构 XML：${first.message}（第 ${first.line} 行第 ${first.column} 列）`);
  }
  return named;
}

export interface ReportPageParts {
  origin: DataOrigin;
  assets: Record<string, string>;
  items: Record<string, unknown>;
  /** 阅读摘要结构区：引用值与限长正文摘要放在注释中，图表内容省略。 */
  structure: string;
}

/** 读回页面：元数据区 + 结构区（顺带缩水）。 */
export function readReportPage(html: string): ReportPageParts | { error: string } {
  const raw = readElementText(
    html,
    (tag) => tag.name === 'script' && tag.attributes['id'] === REPORT_METADATA_ID,
  );
  if (raw === null) return { error: '这份报告里没有元数据区（不是本插件生成的？）' };
  let parsed: { origin?: DataOrigin; assets?: Record<string, string>; items?: Record<string, unknown> };
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch (cause) {
    return { error: `报告元数据区不是 JSON：${errorText(cause)}` };
  }
  const { origin, assets, items } = parsed;
  if (origin === undefined || assets === undefined || items === undefined) {
    return { error: '报告元数据区缺少 origin / assets / items 中的某一段。' };
  }
  for (const [id, node] of Object.entries(origin.nodes)) {
    const ref = node.byFile;
    if (ref !== undefined && ref.startsWith(ASSET_SCHEME) && assets[ref.slice(ASSET_SCHEME.length)] === undefined) {
      return { error: `来源节点 ${id} 引用的资源 ${ref} 不在报告里：报告被改坏了？` };
    }
  }
  const structure = extractStructure(html, true);
  if (structure.errors.length > 0) {
    const first = structure.errors[0]!;
    return { error: `报告结构区不是良构 XML：${first.message}（第 ${first.line} 行第 ${first.column} 列）` };
  }
  return { origin, assets, items, structure: structure.xml };
}
