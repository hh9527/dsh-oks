// 面积图（area）的 lowering：折线 + 填充到横轴，可选 series 分成多块。
//
// lilaq 的 fill-between(x, y1) 在 y2 为 none 时正好是"y1 与横轴之间填充"，
// 所以一块面积 = 一次 fill-between；再叠一条 plot 描出上边缘，线条更清楚。

import {
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
  typstDatetime,
  typstString,
  valueAxisLabel,
  type LayoutOverrides,
  type Row,
} from './shared.ts';

export interface AreaSpec {
  title: string | null;
  sourceLabel: string;
  x: string;
  value: string;
  series: string | null;
  xType: 'number' | 'time' | null;
  xLabel: string | null;
  valueLabel: string | null;
  unit: string | null;
  /** 排版覆盖项（字号、高度、是否斜排标签），都可选。 */
  layout?: LayoutOverrides;
}

/** 生成一张面积图的 typst 源码。 */
export const renderAreaTypst = (rows: readonly Row[], spec: AreaSpec): string => {
  const isTime = spec.xType === 'time';
  const seriesNames = spec.series === null ? [''] : distinct(rows, spec.series);

  const areas = seriesNames.flatMap((series, index) => {
    const xs: string[] = [];
    const ys: string[] = [];
    for (const row of rows) {
      if (spec.series !== null && toLabel(row[spec.series]) !== series) continue;
      const y = toNumber(row[spec.value]);
      const x = isTime ? typstDatetime(row[spec.x]) : (() => {
        const value = toNumber(row[spec.x]);
        return value === null ? null : String(value);
      })();
      if (x === null || y === null) continue;
      xs.push(x);
      ys.push(String(y));
    }
    // 该序列没有有效点就跳过：既画不出面积，也免得生成空数组。
    if (xs.length === 0) return [];
    const color = SERIES_COLORS[index % SERIES_COLORS.length];
    const xArray = typstArray(xs);
    const yArray = typstArray(ys);
    return [
      `  lq.fill-between(${xArray}, ${yArray}, fill: rgb("${color}").transparentize(60%)),`,
      `  lq.plot(${xArray}, ${yArray}, stroke: rgb("${color}"), mark: none),`,
    ];
  });

  const measureLabel = valueAxisLabel(spec.valueLabel, spec.unit);
  const layout = resolveLayout({
    categories: distinct(rows, spec.x),
    overrides: spec.layout ?? {},
    // 面积图与折线同高，两者叠在一起看时比例一致。
    defaultHeight: 340,
  });
  // 数值轴的说明与刻度数量（tickCount 换算成 lilaq 按间距布的 tick-distance）。
  const values = rows.map((row) => toNumber(row[spec.value])).filter((value): value is number => value !== null);
  const distance = tickDistance(values, layout.tickCount);
  const measureAxis = [
    ...(measureLabel === null ? [] : [`label: ${typstString(measureLabel)}`]),
    ...(distance === null ? [] : [`tick-distance: ${round(distance)}`]),
  ].join(', ');
  const lines = [
    ...diagramHeader({ title: spec.title, layout }),
    ...(spec.xLabel === null ? [] : [`  xaxis: (label: ${typstString(spec.xLabel)}),`]),
    ...(measureAxis === '' ? [] : [`  yaxis: (${measureAxis}),`]),
    ...areas,
    ')',
    sourceFootnote(spec.sourceLabel),
  ];
  return `${lines.join('\n')}\n`;
};
