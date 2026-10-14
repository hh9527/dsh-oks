// 读一份自带来源的产物：数据封装、图、表、报告——四种写法归一成同一份 { meta, origin, data }。
//
// 为什么单独一层：**"从产物里把来源读回来"**这件事与工具面无关。图/表/报告各用自己那一段
// 元数据（`<metadata>`、文件头注释、报表级 JSON 块），但读回来之后都是同一套
// `{ meta, origin, data }` + `chainLines`；工具只负责把结果说给人听。

import { errorText } from '../host.ts';
import {
  nameParts, parseEnvelope, readArtifactMeta, readChartInput, readTableView,
} from '../results.ts';
import type { Envelope, EnvelopeMeta } from '../results.ts';
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

/** 一份产物读回来的形态就是文件本身的三段：`{ meta, origin, data }`。
 *  四种产物到这里同形了——读的人不必再分辨它是图、表还是报告。 */
/** 按文件名里的**文件类别**分派：`.report.html` 报告、图（`<名>.<图元>.svg`）与 `.table.md` 表各有原生自述，
 *  其余（`.qres.json` / `.tr.json` / `.def.json` 数据封装）当三段 JSON 读。类别 ↔ 文件的映射由
 *  `nameParts` / `kindOfFile`（`results.ts`）一处给出。
 *  `content` 由调用方读进来（它负责路径校验与读文件），这一层只管形状。 */
export function parseArtifactOrigin(src: string, content: string): Envelope | { error: string } {
  const kind = nameParts(src).kind;
  // 图与报告的自述写在原生元素里（读开头几个字节就够），材料块里只有来源与数据。
  if (src.endsWith('.report.html')) {
    const provenance = readReportProvenance(content);
    if (provenance === null) return { error: '这份报告里没有报表级来源结构（不是本插件生成的？）' };
    return {
      meta: readArtifactMeta(content) ?? nameParts(src),
      origin: provenance.origin,
      data: provenance.data,
    };
  }
  if (kind === 'chart') {
    const material = readChartInput(content);
    if (material === null) return { error: '这张图里没有来源材料（不是本插件画的？）' };
    return {
      meta: readArtifactMeta(content) ?? nameParts(src),
      origin: material.origin,
      data: material.data,
    };
  }
  if (src.endsWith('.table.md')) {
    const view = readTableView(content);
    if (view === null) return { error: '这份表里没有来源材料（不是本插件出的？）' };
    return view.material;
  }
  try {
    return parseEnvelope(content, src);
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
