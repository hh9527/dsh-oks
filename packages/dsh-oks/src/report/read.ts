// 读一份自带来源的产物：数据封装、图、表展示件、报告——四处把同一套东西读出来。
//
// 为什么单独一层：**"从产物里把来源读回来"**这件事与工具面无关。图/表/报告各用自己那一段
// 元数据（`<metadata>`、文件头注释、报表级 JSON 块），但读回来之后都是同一套
// `DataOrigin` + `chainLines`；工具只负责把结果说给人听。

import { statSync } from 'node:fs';
import { readChartInput, readTableView } from '../results.ts';
import type { DataOrigin, OriginNode } from '../results.ts';
import { readReportProvenance } from '../chart/report.ts';

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

/** 报表级来源结构 → 展示项清单。编号按图/表各自连续，与页面上印的一致。 */
export function reportItems(
  raw: readonly { kind: string; no: number; caption: string; root: string; data: unknown; spec: unknown }[],
): ReportItemView[] {
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

/** 该展示项的来源链：把它在报表级节点表里的那条链拿出来。 */
export const itemChain = (nodes: Record<string, OriginNode>, item: { root: string }): DataOrigin =>
  ({ version: 1, root: item.root, nodes });

/** 产物读回来的形态：单条来源（数据/图/表），或一份报告（一张合并后的节点表 + 展示项）。 */
export type ArtifactOrigin =
  | { kind: 'data' | 'chart' | 'table'; origin: DataOrigin }
  | { kind: 'report'; nodes: Record<string, OriginNode>; items: ReportItemView[] };

/** 按扩展名分派：`.report.html` / `.chart.svg` / `.table.md` / 其余当数据封装读。
 *  `content` 由调用方读进来（它负责路径校验与读文件），这一层只管形状。 */
export function parseArtifactOrigin(src: string, content: string): ArtifactOrigin | { error: string } {
  if (src.endsWith('.report.html')) {
    const provenance = readReportProvenance(content);
    if (provenance === null) return { error: '这份报告里没有报表级来源结构（不是本插件生成的？）' };
    return { kind: 'report', nodes: provenance.nodes, items: reportItems(provenance.items) };
  }
  if (src.endsWith('.chart.svg')) {
    const material = readChartInput(content);
    return material === null
      ? { error: '这张图里没有来源材料（不是本插件画的？）' }
      : { kind: 'chart', origin: material.origin };
  }
  if (src.endsWith('.table.md')) {
    const view = readTableView(content);
    return view === null
      ? { error: '这份表里没有来源材料（不是本插件出的？）' }
      : { kind: 'table', origin: view.material.origin };
  }
  const parsed: unknown = JSON.parse(content);
  if (parsed === null || typeof parsed !== 'object' || !('origin' in parsed) || !('data' in parsed)) {
    return { error: '这份文件不是一份 { origin, data } 封装，也不是报告/图/表' };
  }
  return { kind: 'data', origin: (parsed as { origin: DataOrigin }).origin };
}

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
