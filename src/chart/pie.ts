// 饼图（pie）的 lowering：用 cetz-plot 的 piechart。
//
// 饼图表达的是"部分与整体"，所以只取正数（零与负数在饼图里没有意义，工具层会先拒绝这种数据）。
// 与其他图元一致：类别按首次出现顺序、不做隐式排序与聚合——每行一个扇区，
// 同一类别出现在多行就会画成多个扇区，聚合是查询该做的事。

import {
  PAGE_WIDTH,
  SERIES_COLORS,
  resolveLayout,
  sourceFootnote,
  toLabel,
  toNumber,
  typstArray,
  typstContent,
  type LayoutOverrides,
  type Row,
} from './shared.ts';

export interface PieSpec {
  title: string | null;
  sourceLabel: string;
  x: string;
  value: string;
  valueLabel: string | null;
  unit: string | null;
  /** 排版覆盖项（字号、画布边长），都可选。 */
  layout?: LayoutOverrides;
}

/** 生成一张饼图的 typst 源码。 */
export const renderPieTypst = (rows: readonly Row[], spec: PieSpec): string => {
  const items: Array<[string, number]> = [];
  for (const row of rows) {
    const value = toNumber(row[spec.value]);
    if (value === null || value <= 0) continue;
    items.push([toLabel(row[spec.x]), value]);
  }

  // 没有任何正数可画：出一张只有标题与说明的图，而不是报错。
  if (items.length === 0) {
    return [
      `#set page(width: ${PAGE_WIDTH}pt, height: auto, margin: 12pt)`,
      ...(spec.title === null ? [] : [`#text(size: 12pt, weight: "bold")[${typstContent(spec.title)}]`, '']),
      '#text[（没有可画的正数数据）]',
      '',
      sourceFootnote(spec.sourceLabel),
      '',
    ].join('\n');
  }

  const data = typstArray(items.map(([label, value]) => `(label: ${JSON.stringify(label)}, value: ${value})`));
  const sliceStyle = typstArray(items.map((_, index) => `rgb("${SERIES_COLORS[index % SERIES_COLORS.length]}")`));
  // 字号与条形/折线同一套：标题固定档，正文（图例里的标签）随条目数缩放。
  // 饼图没有"高度"概念，用 spec.layout.height 换算成画布边长（默认 255pt ≈ 9cm）。
  const layout = resolveLayout({
    categories: items.map(([label]) => label),
    overrides: spec.layout ?? {},
    defaultHeight: 255,
  });
  const canvasLength = `${Math.round((layout.height / 28.3465) * 100) / 100}cm`;
  return [
    '#import "@preview/cetz:0.5.2"',
    '#import "@preview/cetz-plot:0.1.4": chart',
    `#set page(width: ${PAGE_WIDTH}pt, height: auto, margin: 12pt)`,
    `#set text(size: ${layout.labelFont}pt)`,
    ...(spec.title === null ? [] : [`#text(size: ${layout.titleFont}pt, weight: "bold")[${typstContent(spec.title)}]`, '']),
    // cetz-plot 的 piechart 要放在 cetz 的画布里；数据给字典行，标签与数值各指一个键，
    // 配色走 slice-style（它是命名参数，别塞成位置参数）。
    // length 是画布边长：不给的话画布很小，饼图只占页面左上角一小块。
    // 外侧标签与底部图例说的是同一件事，关掉它，让图例单独承担标签。
    `#cetz.canvas(length: ${canvasLength}, {`,
    '  chart.piechart(',
    `    ${data},`,
    '    value-key: "value",',
    '    label-key: "label",',
    `    slice-style: ${sliceStyle},`,
    '    outer-label: (content: none),',
    '  )',
    '})',
    '',
    sourceFootnote(spec.sourceLabel),
    '',
  ].join('\n');
};
