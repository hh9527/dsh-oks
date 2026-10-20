/** 组装一份报告：校验正文 → 过滤绑定 → 编号 → 渲染 → 归档源码 → 拼页面。
 *
 *  这一层是**纯组装**：读材料、取值都由调用方注入，因此它不碰工作区、可以单测。
 *  它实现 RFC 0008 §4 的几条硬规则：正文引用的每一项都必须有绑定、绑定不能多也不能少；
 *  图与表各自按正文出现顺序编号；被引用的每一项都进来源链（含只出现一次的数值）。
 */
import { appendNode } from '../results.ts';
import type { ArtifactMeta, DataOrigin, OriginNode } from '../results.ts';
import { cleanChartSvg } from '../chart/report.ts';
import { escapeHtml, renderMarkdown } from '../chart/markdown.ts';
import { buildReportPage, extractAssets, outlineOf, renderStructure } from './page.ts';
import { checkAuthorXhtml, stripChartMetadata } from './xhtml.ts';

/** 正文里一个绑定项：取哪份材料、切了哪一段、切出来的值，以及它在正文里的展示形态。 */
export interface ReportBinding {
  src: string;
  /** 内部追踪路径：相对于原封装的 .data…，或显式元数据视图的 #meta…。 */
  root: string;
  value: unknown;
  /** 继续加工时要带上的上游来源。 */
  origin: DataOrigin;
  /** 展示件才有的形态：图给 SVG 正文，表给 markdown 正文。 */
  display?: { kind: 'chart' | 'table'; content: string };
}

export interface AssembleInput {
  draft?: OriginNode['draft'];
  motivation?: string;
  name: string;
  title: string;
  subtitle: string | null;
  category: string;
  at: string;
  xhtml: string;
  figurePlacement?: 'before-caption';
  bindings: Record<string, ReportBinding>;
  /** 取一个 span 的值：超范围的形状（对象、数组）在这里明确报错，不留给渲染层。 */
  valueOf: (ref: string, pick: string | undefined) => { value: string } | { error: string };
}

export type AssembleResult = { error: string } | {
  page: string;
  origin: DataOrigin;
  assets: Record<string, string>;
  items: Record<string, unknown>;
  figureCount: number;
  tableCount: number;
  /** 报告正文里「既没有 ref、也没有用 lit 声明」的数字个数（告警）。 */
  NumWithoutSource: number;
  /** `data-oks-lit` 写在 span 以外的次数（告警）。 */
  LitNotOnSpan: number;
};

/** 正文里 figure 引用的出现顺序。 */
/** 表在图注之下内联：外层容器是作者写的 figure，这里只给滚动容器。 */
const tableScroll = (embedded: string): string =>
  `<div class="table-scroll">${renderMarkdown(embedded, (_info, text) => `<pre><code>${escapeHtml(text)}</code></pre>`)}</div>`;

export function assembleReport(input: AssembleInput): AssembleResult {
  const checked = checkAuthorXhtml(input.xhtml);
  if (checked.errors.length > 0) {
    const lines = checked.errors.slice(0, 12)
      .map((error) => `第 ${error.line} 行第 ${error.column} 列：${error.message}`);
    return { error: `报告正文有 ${checked.errors.length} 处要改：\n${lines.join('\n')}` };
  }
  const used = new Set(checked.refs);
  const missing = [...used].filter((ref) => input.bindings[ref] === undefined);
  if (missing.length > 0) {
    return { error: `正文引用了没有绑定的项：${missing.join('、')}；在 spec.inputs 里给它们各自的 src。` };
  }
  const unused = Object.keys(input.bindings).filter((key) => !used.has(key));
  if (unused.length > 0) {
    return { error: `render_html 输入里这些绑定没有被正文引用：${unused.join('、')}；去掉它们，或在正文里引用。` };
  }
  // 取值先行：形状不对的绑定在这里就报出来，渲染层只负责填字。
  const values = new Map<string, string>();
  for (const { ref, pick } of checked.picks) {
    const resolved = input.valueOf(ref, pick);
    if ('error' in resolved) return { error: resolved.error };
    values.set(`${ref}\u0000${pick ?? ''}`, resolved.value);
  }
  const outline = outlineOf(checked.headings);
  // figure 引用的是**完整展示件**：绑到普通数据材料会画出空图，绑到切片会与 items 不一致，
  // 两种都在这里挡下（想换切片就先用 render_figure 出一件新的）。
  for (const ref of checked.figures) {
    const binding = input.bindings[ref];
    if (binding === undefined) continue;
    if (binding.display === undefined) {
      return {
        error: `figure 引用的 ${ref} 不是图或表展示件：先用 render_figure 画一张图或出一张表，再把它绑给这一项。`,
      };
    }
    if (binding.root !== '.data') {
      return {
        error: `figure 引用的 ${ref} 只能整件展示：将 render_figure 的完整结果绑定到 figure；要取标量就用 span 的 data-oks-pick。`,
      };
    }
  }
  // 编号：图与表各自连续，按它们在正文里出现的顺序给。
  const numbers = new Map<string, string>();
  let figureCount = 0;
  let tableCount = 0;
  for (const ref of checked.figures) {
    if (numbers.has(ref)) continue;
    const display = input.bindings[ref]?.display;
    if (display?.kind === 'table') {
      tableCount += 1;
      numbers.set(ref, `表 ${tableCount}`);
    } else if (display?.kind === 'chart') {
      figureCount += 1;
      numbers.set(ref, `图 ${figureCount}`);
    }
  }
  const rendered = renderStructure({
    xhtml: input.xhtml,
    figurePlacement: input.figurePlacement,
    outline,
    valueOf: (ref, pick) => values.get(`${ref}\u0000${pick ?? ''}`) ?? '',
    inlineOf: (ref) => {
      const binding = input.bindings[ref];
      const label = numbers.get(ref);
      if (binding?.display === undefined || label === undefined) return undefined;
      return binding.display.kind === 'chart'
        ? { html: stripChartMetadata(cleanChartSvg(binding.display.content)).xml, label }
        : { html: tableScroll(binding.display.content), label, table: true };
    },
  });
  if (rendered.errors.length > 0) {
    const first = rendered.errors[0]!;
    return { error: `渲染正文时出错：${first.message}（第 ${first.line} 行第 ${first.column} 列）` };
  }
  // 报告自己也是一个操作：根指向"组装这份报告"，inputs 是各绑定的根节点，inputPaths 是选取路径。
  const keys = Object.keys(input.bindings);
  const assembled = appendNode(
    keys.map((key) => input.bindings[key]!.origin),
    {
      kind: 'report',
      spec: { xhtml: input.xhtml, ...(input.figurePlacement?{figurePlacement:input.figurePlacement}:{}) },
      ...(input.draft ? { draft: input.draft } : {}),
      ...(input.motivation ? { motivation: input.motivation } : {}),
      inputs: Object.fromEntries(keys.map((key) => [key, input.bindings[key]!.origin.root])),
      inputPaths: Object.fromEntries(keys.map((key) => [key, input.bindings[key]!.root])),
    },
    keys.map((key) => ({ ref: key, root: input.bindings[key]!.origin.root })),
  );
  const archived = extractAssets(assembled);
  const items: Record<string, unknown> = {};
  for (const key of keys) items[key] = input.bindings[key]!.value;
  const meta: ArtifactMeta = {
    kind: 'report', name: input.name, at: input.at, title: input.title, category: input.category,
  };
  const page = buildReportPage({
    meta,
    subtitle: input.subtitle,
    generatedAt: input.at,
    article: rendered.article,
    origin: archived.origin,
    assets: archived.assets,
    items,
    outline,
  });
  return { page, origin: archived.origin, assets: archived.assets, items, figureCount, tableCount,
    NumWithoutSource: checked.NumWithoutSource.length, LitNotOnSpan: checked.LitNotOnSpan.length };
}
