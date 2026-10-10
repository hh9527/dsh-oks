// 条形图的 lowering：column（竖条）与 bar（横条）。
//
// 两者共用同一套"类别 × 序列"的组织逻辑，只差朝向与轴的角色：
//   竖条：lq.bar(x = 类别位置, y = 值)，类别在横轴
//   横条：lq.hbar(x = 值, y = 类别位置)，类别在纵轴
//
// 语义：类别与序列都按首次出现顺序；某个序列在某个类别上没有行时那个坐标不出现，
// 于是位置留空、后面的条不会被挤过来。

import {
  NEGATIVE_COLOR,
  PAGE_WIDTH,
  ROW_HEIGHT,
  SERIES_COLORS,
  diagramHeader,
  distinct,
  resolveLayout,
  round,
  sourceFootnote,
  tickDistance,
  toLabel,
  toNumber,
  typstArray,
  typstContent,
  typstString,
  valueAxisLabel,
  type LayoutOverrides,
  type Row,
} from './shared.ts';

export interface BarsSpec {
  title: string | null;
  /** 系统来源标识（基于查询结果 / agent 自主填写），画进图里。 */
  sourceLabel: string;
  x: string;
  value: string;
  /** 分组列：column 必填；bar 省略时就是单序列的横条。 */
  series: string | null;
  xLabel: string | null;
  valueLabel: string | null;
  unit: string | null;
  /** 排版覆盖项（字号、高度、是否斜排标签），都可选。 */
  layout?: LayoutOverrides;
}

export type BarsOrientation = 'vertical' | 'horizontal';

/** 生成一张条形图的 typst 源码。 */
export const renderBarsTypst = (
  rows: readonly Row[],
  spec: BarsSpec,
  orientation: BarsOrientation,
): string => {
  const categories = distinct(rows, spec.x);
  const seriesNames = spec.series === null ? [''] : distinct(rows, spec.series);
  const vertical = orientation === 'vertical';

  // 空数据：lilaq 需要至少一个刻度才能定轴，画不出来。这里出一张只有标题与说明的图，
  // 让"查到 0 行"也有产物可交付，而不是一个报错。
  if (categories.length === 0) {
    return [
      '#import "@preview/lilaq:0.6.0" as lq',
      `#set page(width: ${PAGE_WIDTH}pt, height: auto, margin: 12pt)`,
      ...(spec.title === null ? [] : [`#text(size: 12pt, weight: "bold")[${typstContent(spec.title)}]`, '']),
      '#text[（没有数据）]',
      '',
      sourceFootnote(spec.sourceLabel),
      '',
    ].join('\n');
  }

  // 组内每根条的宽度与偏移：全部序列一起占满一个类别的槽位。
  const slot = seriesNames.length === 0 ? 0.8 : 0.8 / seriesNames.length;

  // 横条的纵轴从下往上长，而 lilaq 要求 y 坐标递增，所以把"显示顺序"倒过来：
  // 数据里第一个类别落在 y 最大处，也就是图的最上面（竖条从左往右，顺序天然一致）。
  const display = vertical ? categories : [...categories].reverse();
  const positionOf = (category: string): number => display.indexOf(category);

  const bars = seriesNames.flatMap((series, index) => {
    const points: Array<[number, number]> = [];
    for (const row of rows) {
      if (spec.series !== null && toLabel(row[spec.series]) !== series) continue;
      const value = toNumber(row[spec.value]);
      if (value === null) continue;
      const position = positionOf(toLabel(row[spec.x]));
      if (position < 0) continue;
      points.push([position, value]);
    }
    // 该序列一个数据点都没有就不画：既没东西可画，也免得生成空数组。
    if (points.length === 0) return [];
    const color = SERIES_COLORS[index % SERIES_COLORS.length];
    const offset = round((index - (seriesNames.length - 1) / 2) * slot);
    const positions = typstArray(points.map(([position]) => position));
    const values = typstArray(points.map(([, value]) => value));
    const call = vertical ? `lq.bar(${positions}, ${values}` : `lq.hbar(${values}, ${positions}`;
    const label = series === '' ? '' : `, label: ${typstString(series)}`;
    // 逐条给色：负值换成对比色，方向之外再加一重区分。
    const fills = typstArray(points.map(([, value]) => `rgb("${value < 0 ? NEGATIVE_COLOR : color}")`));
    return [`  ${call}, width: ${round(slot)}, offset: ${offset}, fill: ${fills}${label}),`];
  });

  const ticks = typstArray(display.map((category) => `(${positionOf(category)}, ${typstString(category)})`));
  const categoryAxis = `${spec.xLabel === null ? '' : `label: ${typstString(spec.xLabel)}, `}ticks: (${ticks})`;
  const measureLabel = valueAxisLabel(spec.valueLabel, spec.unit);
  // 高度：横条是"行数即高度"；竖条固定 340pt，宽高比稳定。两者都能被 spec.layout.height 覆盖。
  // 行高与字号耦合——字大了行就得跟着长，否则横条里的字会挤在一起；用户给的 rowHeight 当下限用。
  const baseRow = spec.layout?.rowHeight ?? ROW_HEIGHT;
  const layout = resolveLayout({
    categories,
    overrides: spec.layout ?? {},
    defaultHeight: vertical ? 340 : Math.round(60 + categories.length * baseRow),
  });
  const rowHeight = Math.max(baseRow, Math.round(layout.labelFont * 1.8));
  const height = vertical ? layout.height : (spec.layout?.height ?? Math.round(60 + categories.length * rowHeight));

  // 数值轴的说明与刻度数量：tickCount 换算成 lilaq 的 tick-distance（它按间距布刻度）。
  const values = rows.map((row) => toNumber(row[spec.value])).filter((value): value is number => value !== null);
  const distance = tickDistance(values, layout.tickCount);
  const measureAxis = [
    ...(measureLabel === null ? [] : [`label: ${typstString(measureLabel)}`]),
    ...(distance === null ? [] : [`tick-distance: ${round(distance)}`]),
  ].join(', ');

  const lines = [
    ...diagramHeader({ title: spec.title, layout: { ...layout, height } }),
    vertical ? `  xaxis: (${categoryAxis}),` : `  yaxis: (${categoryAxis}),`,
    ...(measureAxis === '' ? [] : [vertical ? `  yaxis: (${measureAxis}),` : `  xaxis: (${measureAxis}),`]),
    ...bars,
    ')',
    sourceFootnote(spec.sourceLabel),
  ];
  return `${lines.join('\n')}\n`;
};
