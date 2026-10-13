// 读一份自带来源的产物：数据封装、图、表、报告——四种写法归一成同一份 { meta, origin, data }。
//
// 为什么单独一层：**"从产物里把来源读回来"**这件事与工具面无关。图/表/报告各用自己那一段
// 元数据（`<metadata>`、文件头注释、报表级 JSON 块），但读回来之后都是同一套
// `{ meta, origin, data }` + `chainLines`；工具只负责把结果说给人听。

import { statSync } from 'node:fs';
import { errorText } from '../host.ts';
import {
  nameParts, parseEnvelope, readArtifactMeta, readChartInput, readTableView,
} from '../results.ts';
import type { DataOrigin, EnvelopeMeta, OriginNode } from '../results.ts';
import { readReportProvenance } from '../chart/report.ts';
import type { ReportData } from '../chart/report.ts';

/** 报告里的一个展示项（从报表级来源结构里读出来的视图）。 */
export interface ReportItemView {
  /** 报告内序号（1 起，正文出现顺序）——取数工具寻址用它。 */
  index: number;
  kind: string;
  /** 图 N / 表 N：报告里印在编号 chip 上的那个。 */
  label: string;
  caption: string;
  /** 该项在报表级节点表里的根节点。 */
  root: string;
  /** 实际展示的数据。 */
  data: unknown;
  spec: unknown;
}

/** 报表级结构 → 展示项清单。编号按图/表各自连续，与页面上印的一致。 */
export function reportItems(raw: ReportData['items']): ReportItemView[] {
  return raw.map((item, at) => ({
    index: at + 1,
    kind: item.kind,
    label: `${item.kind === 'table' ? '表' : '图'} ${item.no}`,
    caption: item.caption,
    root: item.root,
    data: item.data,
    spec: item.spec,
  }));
}

/** 寻址一个展示项：序号（`4`）与报告里印的编号（`"表 1"` / `"图 4"`）都收。
 *  两种编号并存是刻意的——页面上印的是「表 1」，清单里给的是序号，不该逼人换算。 */
export function resolveItem(
  items: readonly ReportItemView[],
  address: unknown,
): { item: ReportItemView } | { error: string } {
  const list = items.map((item) => `${item.index}（${item.label}）`).join('、');
  if (typeof address === 'number' && Number.isInteger(address)) {
    const found = items.find((item) => item.index === address);
    return found === undefined ? { error: `报告里没有第 ${address} 项。可选的：${list}` } : { item: found };
  }
  if (typeof address === 'string') {
    const text = address.trim();
    const flat = (value: string): string => value.replace(/\s+/g, '');
    const found = items.find((item) => String(item.index) === text || flat(item.label) === flat(text));
    return found === undefined ? { error: `报告里没有 ${JSON.stringify(address)} 这一项。可选的：${list}` } : { item: found };
  }
  return { error: `取哪一项？给序号或报告里印的编号（例如 4 或 "表 1"）。可选的：${list}` };
}

/** 从某个根**可达**的那些节点：封装的节点表只该装它自己那条链。
 *  （报表级的表是合并过的，直接用会把别的展示项的链也带进新文件，链上就出现走不到的节点。） */
export const reachableOrigin = (nodes: Record<string, OriginNode>, root: string): DataOrigin => {
  const kept: Record<string, OriginNode> = {};
  const visit = (id: string): void => {
    if (kept[id] !== undefined) return;
    const node = nodes[id];
    if (node === undefined) return;
    kept[id] = node;
    for (const upstream of Object.values(node.inputs ?? {})) visit(upstream);
  };
  visit(root);
  return { root, nodes: kept };
};

/** 该展示项的来源链：把它在报表级节点表里那条**可达**的链拿出来。 */
export const itemChain = (nodes: Record<string, OriginNode>, item: { root: string }): DataOrigin =>
  reachableOrigin(nodes, item.root);

/** 一份产物读回来的形态：与文件里的三段一致，外加报告才有的展示项视图。
 *  四种产物到这里就同形了——读的人不必再分辨它是图、表还是报告。 */
export interface ArtifactView {
  meta: EnvelopeMeta;
  origin: DataOrigin;
  data: unknown;
  /** 报告：可寻址的展示项（序号、图 N/表 N、根节点）。其余产物是空数组。 */
  items: ReportItemView[];
}

/** 按扩展名分派：`.report.html` / `.chart.svg` / `.table.md` / 其余当数据封装读。
 *  `content` 由调用方读进来（它负责路径校验与读文件），这一层只管形状。 */
export function parseArtifactOrigin(src: string, content: string): ArtifactView | { error: string } {
  // 图与报告的自述写在原生元素里（读开头几个字节就够），材料块里只有来源与数据。
  if (src.endsWith('.report.html')) {
    const provenance = readReportProvenance(content);
    if (provenance === null) return { error: '这份报告里没有报表级来源结构（不是本插件生成的？）' };
    const data = provenance.data;
    return {
      meta: readArtifactMeta(content) ?? nameParts(src),
      origin: provenance.origin,
      data,
      items: reportItems(data.items),
    };
  }
  if (src.endsWith('.chart.svg')) {
    const material = readChartInput(content);
    if (material === null) return { error: '这张图里没有来源材料（不是本插件画的？）' };
    return {
      meta: readArtifactMeta(content) ?? nameParts(src),
      origin: material.origin,
      data: material.data,
      items: [],
    };
  }
  if (src.endsWith('.table.md')) {
    const view = readTableView(content);
    if (view === null) return { error: '这份表里没有来源材料（不是本插件出的？）' };
    return { ...view.material, items: [] };
  }
  try {
    return { ...parseEnvelope(content, src), items: [] };
  } catch (cause) {
    return { error: `这份文件不是一份 { meta, origin, data } 封装，也不是报告/图/表：${errorText(cause)}` };
  }
}

/** 正文里的结构：**所有 heading**（`h1`–`h3`，即大纲里那些带 `section-N` 锚点的）
 *  以及每个展示项跟随**最近一个** heading 的归属关系。
 *
 *  为什么读正文：heading 是文档结构的摘要，而"哪张图在哪一章下"只有正文的顺序能回答；
 *  项的**数据**仍从报表级结构取，两边用 `data-oks-item` 对齐。
 *  报表标题（外壳里的 `<h1>`）不带 `section-N` 锚点，所以不会被当成章节。 */
export function reportChapters(
  content: string,
  items: readonly ReportItemView[],
): { chapters: Array<{ caption: string | null; level: string | null; items: ReportItemView[] }>; plainTables: number } {
  const hits: Array<{ at: number; kind: 'heading'; caption: string; level: string } | { at: number; kind: 'item'; index: number }> = [];
  for (const match of content.matchAll(/<h([1-3])[^>]*\bid="section-\d+"[^>]*>([\s\S]*?)<\/h\1>/g)) {
    hits.push({ at: match.index ?? 0, kind: 'heading', caption: plainText(match[2]), level: `h${match[1]}` });
  }
  for (const match of content.matchAll(/<figure[^>]*data-oks-item="(\d+)"/g)) {
    hits.push({ at: match.index ?? 0, kind: 'item', index: Number(match[1]) });
  }
  hits.sort((left, right) => left.at - right.at);
  // 第一个 heading 之前的展示项也要有归属：给一个 caption/level 都为 null 的起始段，只有它非空时才出现。
  const chapters: Array<{ caption: string | null; level: string | null; items: ReportItemView[] }> = [
    { caption: null, level: null, items: [] },
  ];
  for (const hit of hits) {
    if (hit.kind === 'heading') {
      chapters.push({ caption: hit.caption, level: hit.level, items: [] });
      continue;
    }
    const item = items[hit.index - 1];
    if (item !== undefined) chapters[chapters.length - 1]!.items.push(item);
  }
  const tableItems = items.filter((item) => item.kind === 'table').length;
  const plainTables = Math.max(0, (content.match(/<table[\s>]/g) ?? []).length - tableItems);
  return { chapters: chapters.filter((chapter, at) => at > 0 || chapter.items.length > 0), plainTables };
}

/** heading 里的文字：剥标签 + 还原我们转义过的那几个实体。 */
const plainText = (html: string): string => html
  .replace(/<[^>]*>/g, '')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'").replace(/&amp;/g, '&')
  .trim();

/** 漂移核对：链里每个 query 节点都记着"执行时实际用的数据来源"，看它现在还在不在、变没变。
 *  **只核对、不重算**——重算等于承诺复现，rfc 明确不承诺。 */
export function driftLines(origin: DataOrigin): string[] {
  const lines: string[] = [];
  for (const [id, node] of Object.entries(origin.nodes)) {
    if (node.kind !== 'query') continue;
    const source = node.source as { dataFile?: unknown; bytes?: unknown; modifiedAt?: unknown } | undefined;
    const file = typeof source?.dataFile === 'string' ? source.dataFile : null;
    if (file === null) {
      lines.push(`[${id}] 当时没有观察到数据来源，无从核对`);
      continue;
    }
    let now: { size: number; mtime: string };
    try {
      const info = statSync(file);
      now = { size: info.size, mtime: new Date(info.mtimeMs).toISOString().replace(/\.\d{3}Z$/, 'Z') };
    } catch {
      lines.push(`[${id}] 当时的数据文件现在不在了（${file}）——这些数字不一定还成立`);
      continue;
    }
    const same = now.size === source?.bytes && now.mtime === source?.modifiedAt;
    lines.push(same
      ? `[${id}] 当时的数据文件与现在一致（${now.size} 字节 · ${now.mtime}）`
      : `[${id}] 当时的数据文件**变过**（当时 ${String(source?.bytes)} 字节 · ${String(source?.modifiedAt)}`
        + ` → 现在 ${now.size} 字节 · ${now.mtime}）——这些数字不一定还成立`);
  }
  return lines;
}
