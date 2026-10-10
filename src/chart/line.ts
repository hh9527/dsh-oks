// 折线（line）的 lowering：x 是横轴、value 是纵轴，可选 series 分成多条线。
//
// 时间轴交给 typst 的 datetime 值，lilaq 会自动把轴切成 datetime 刻度；数值轴直接用数字。
// 空值的点不出现在数组里，折线因此自然断开（与规格里"空值形成断点"一致）。
// 连线保持直线（不用平滑插值）。

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
  typstString,
  valueAxisLabel,
  type LayoutOverrides,
  type Row,
} from './shared.ts';

export interface LineSpec {
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

/** 把一个时间值写成 typst 的 datetime：接受 epoch 毫秒或可解析的时间文本，按 UTC 解释。 */
const typstDatetime = (value: unknown): string | null => {
  const millis = typeof value === 'number'
    ? value
    : (typeof value === 'string' && value.length > 0 ? Date.parse(value) : Number.NaN);
  if (!Number.isFinite(millis)) return null;
  const date = new Date(millis);
  return 'datetime('
    + `year: ${date.getUTCFullYear()}, month: ${date.getUTCMonth() + 1}, day: ${date.getUTCDate()}, `
    + `hour: ${date.getUTCHours()}, minute: ${date.getUTCMinutes()}, second: ${date.getUTCSeconds()})`;
};

/** 生成一张折线图的 typst 源码。 */
export const renderLineTypst = (rows: readonly Row[], spec: LineSpec): string => {
  const isTime = spec.xType === 'time';
  const seriesNames = spec.series === null ? [''] : distinct(rows, spec.series);

  const plots = seriesNames.flatMap((series, index) => {
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
    // 该序列一个有效点都没有就不画：既画不出线，也免得生成空数组。
    if (xs.length === 0) return [];
    const color = SERIES_COLORS[index % SERIES_COLORS.length];
    const label = series === '' ? '' : `, label: ${typstString(series)}`;
    return [`  lq.plot(${typstArray(xs)}, ${typstArray(ys)}, `
      + `stroke: rgb("${color}"), mark: none${label}),`];
  });

  const measureLabel = valueAxisLabel(spec.valueLabel, spec.unit);
  const layout = resolveLayout({
    categories: distinct(rows, spec.x),
    overrides: spec.layout ?? {},
    // 折线的高度固定：横轴的点越密只影响可读性，比例不变。
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
    ...plots,
    ')',
    sourceFootnote(spec.sourceLabel),
  ];
  return `${lines.join('\n')}\n`;
};
