// 服务端出图：把结果行画成 SVG 文本。
//
// 为什么在服务端画：客户端视图进不了 preset（只能挂 profile 顶层，等于污染所有会话），
// 而图片能直接进回答正文（宿主 markdown 会按会话 cwd 解析本地图片，实测认 SVG）。
// SVG 本身就是文本，拼字符串即可生成——依赖只有 d3 的**纯计算**包（比例尺与路径生成），
// 它们不需要 DOM，构建时全部打进 dist/index.mjs，产物依旧自包含。
//
// 这一层只认「行数组 + 规格」，不认识结果文件的内部结构，也不做校验（校验在 oks_chart 里）。
// 来源标识由调用方以现成文案传进来（这一层不解释"来源"的含义）。

import { scaleBand, scaleLinear, scaleTime } from 'd3-scale';
import { line as shapeLine } from 'd3-shape';

export type ChartKind = 'bar' | 'line';

/** 画一张图需要的全部输入：规格已在工具侧校验过。 */
export interface ChartSpec {
  kind: ChartKind;
  title: string | null;
  /** 系统来源标识（现成文案）：它会画进图里，让图离开对话也能自证来源。 */
  sourceLabel: string;
  x: string;
  value: string;
  series: string | null;
  xType: 'number' | 'time' | null;
  xLabel: string | null;
  valueLabel: string | null;
  unit: string | null;
}

type Row = Record<string, unknown>;

const WIDTH = 720;
const BAR_FILL = '#5a8cf0';
const BAR_NEGATIVE_FILL = '#c0567a';
const SERIES_COLORS = ['#5a8cf0', '#e0803a', '#4aa96c', '#c0567a', '#8a6ad0'];
const FONT = 'font-family="-apple-system, BlinkMacSystemFont, Segoe UI, Helvetica, Arial, sans-serif"';
const TEXT = '#1f2d3d';
const MUTED = '#5b6b7c';
const AXIS = '#c9d2e0';

const escapeXml = (text: string): string => text
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&apos;');

const toNumber = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const toEpoch = (value: unknown): number | null => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
};

const round = (value: number): number => Math.round(value * 100) / 100;

/** 轴上的数字：太大的数不铺满位数。 */
const shortNumber = (value: number): string => {
  const size = Math.abs(value);
  if (size >= 1e9) return `${round(value / 1e9)}B`;
  if (size >= 1e6) return `${round(value / 1e6)}M`;
  if (size >= 1e4) return `${round(value / 1e3)}K`;
  return String(round(value));
};

const labelOf = (value: unknown): string => {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object') return JSON.stringify(value) ?? '';
  return String(value);
};

const formatNumber = (value: number, unit: string | null): string => `${round(value)}${unit ?? ''}`;

const formatInstant = (value: number): string => {
  const date = new Date(value);
  const pad = (part: number): string => String(part).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

interface TextOptions {
  size?: number;
  fill?: string;
  anchor?: 'start' | 'middle' | 'end';
  weight?: string;
}

const text = (x: number, y: number, content: string, options: TextOptions = {}): string =>
  `<text x="${round(x)}" y="${round(y)}" ${FONT} font-size="${options.size ?? 12}"`
  + ` fill="${options.fill ?? TEXT}"`
  + (options.anchor === undefined ? '' : ` text-anchor="${options.anchor}"`)
  + (options.weight === undefined ? '' : ` font-weight="${options.weight}"`)
  + `>${escapeXml(content)}</text>`;

const rect = (x: number, y: number, width: number, height: number, fill: string): string =>
  `<rect x="${round(x)}" y="${round(y)}" width="${round(Math.max(0, width))}" height="${round(height)}" fill="${fill}"/>`;

const line = (x1: number, y1: number, x2: number, y2: number, stroke: string): string =>
  `<line x1="${round(x1)}" y1="${round(y1)}" x2="${round(x2)}" y2="${round(y2)}" stroke="${stroke}"/>`;

const path = (d: string, stroke: string): string =>
  `<path d="${d}" fill="none" stroke="${stroke}" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/>`;

/** 画布外壳：标题（可选）+ 常驻的**系统来源标识** + 图形。 */
const frame = (height: number, spec: ChartSpec, body: string): string => {
  const parts: string[] = [
    `<rect width="${WIDTH}" height="${round(height)}" fill="#ffffff"/>`,
  ];
  if (spec.title !== null) parts.push(text(24, 30, spec.title, { size: 15, weight: '600' }));
  parts.push(text(24, spec.title === null ? 30 : 50, spec.sourceLabel, { size: 11, fill: MUTED }));
  parts.push(body);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${round(height)}"`
    + ` viewBox="0 0 ${WIDTH} ${round(height)}" role="img">`
    + parts.join('') + '</svg>';
};

/** 图形区上沿：给标题（可选）与来源标识各留一行。 */
const bodyTop = (spec: ChartSpec): number => (spec.title === null ? 46 : 66);

/** 横条图：沿用数据顺序；有负值时 0 轴居中，正值向右、负值向左。 */
function renderBar(rows: readonly Row[], spec: ChartSpec): string {
  const left = 168;
  const right = 96;
  const top = bodyTop(spec);
  const rowHeight = 22;
  const gap = 6;
  const plotWidth = WIDTH - left - right;
  const height = top + rows.length * (rowHeight + gap) + 20;
  const values = rows.map((row) => toNumber(row[spec.value]));
  const known = values.filter((value): value is number => value !== null);
  // domain 取到 0：负值于是落在 0 轴左边，方向一眼可辨。
  const xMin = Math.min(0, ...known);
  const xMax = Math.max(0, ...known);
  const scale = scaleLinear().domain([xMin, xMax]).range([left, left + plotWidth]);
  const zero = scale(0);
  const band = scaleBand<number>()
    .domain(rows.map((_row, index) => index))
    .range([top, top + rows.length * (rowHeight + gap) - gap])
    .paddingInner(0.18);
  const parts: string[] = [];
  if (spec.valueLabel !== null) parts.push(text(left, top - 14, spec.valueLabel, { size: 11, fill: MUTED }));
  if (spec.xLabel !== null) parts.push(text(left - 12, top - 14, spec.xLabel, { anchor: 'end', size: 11, fill: MUTED }));
  rows.forEach((row, index) => {
    const y = band(index) ?? top;
    const barHeight = band.bandwidth();
    const value = values[index] ?? null;
    const end = value === null ? zero : scale(value);
    const start = Math.min(zero, end);
    const width = Math.abs(end - zero);
    const negative = value !== null && value < 0;
    parts.push(text(left - 12, y + barHeight * 0.72, labelOf(row[spec.x]), { anchor: 'end', size: 12 }));
    parts.push(rect(start, y, width, barHeight, negative ? BAR_NEGATIVE_FILL : BAR_FILL));
    // 数值标签贴着条的外端：正值在右、负值在左。
    parts.push(text(negative ? start - 8 : start + width + 8, y + barHeight * 0.72,
      value === null ? '—' : formatNumber(value, spec.unit),
      { size: 12, fill: MUTED, anchor: negative ? 'end' : 'start' }));
  });
  // 有负值时才画 0 轴，免得正数图上多一条无意义的线。
  if (xMin < 0) {
    parts.push(line(zero, top - 4, zero, top + rows.length * (rowHeight + gap) - gap + 4, MUTED));
  } else {
    parts.push(line(left, top - 4, left, top + rows.length * (rowHeight + gap) - gap + 4, AXIS));
  }
  return frame(height, spec, parts.join(''));
}

interface Point {
  series: string;
  x: number | null;
  y: number | null;
}

/** 折线图：多序列、空值断点、时间轴或数值轴；刻度由 d3 的比例尺给出。
 *  连线用 d3 的默认直线（按输入顺序连接），不做平滑插值。 */
function renderLine(rows: readonly Row[], spec: ChartSpec): string {
  const left = 68;
  const right = 28;
  const top = bodyTop(spec);
  const bottom = 58;
  const height = 380;
  const plotWidth = WIDTH - left - right;
  const plotHeight = height - top - bottom;
  const isTime = spec.xType === 'time';
  const points: Point[] = rows.map((row) => ({
    series: spec.series === null ? '' : labelOf(row[spec.series]),
    x: isTime ? toEpoch(row[spec.x]) : toNumber(row[spec.x]),
    y: toNumber(row[spec.value]),
  }));
  const xs = points.map((point) => point.x).filter((value): value is number => value !== null);
  const ys = points.map((point) => point.y).filter((value): value is number => value !== null);
  if (xs.length === 0 || ys.length === 0) return frame(height, spec, '');
  const xMin = Math.min(...xs);
  const xMax = Math.max(...xs);
  const yMin = Math.min(0, ...ys);
  const yMax = Math.max(...ys);
  // 时间轴交给 scaleTime，数值轴交给 scaleLinear；两者都只做纯计算，不需要 DOM。
  const px: (value: number) => number = isTime
    ? (() => {
      const scale = scaleTime().domain([new Date(xMin), new Date(xMax)]).range([left, left + plotWidth]);
      return (value: number) => scale(new Date(value));
    })()
    : (() => {
      const scale = scaleLinear().domain([xMin, xMax]).range([left, left + plotWidth]);
      return (value: number) => scale(value);
    })();
  const pyScale = scaleLinear().domain([yMin, yMax]).range([top + plotHeight, top]).nice();
  const py = (value: number): number => pyScale(value);
  const parts: string[] = [];
  for (const tick of pyScale.ticks(4)) {
    const y = py(tick);
    parts.push(line(left, y, left + plotWidth, y, AXIS));
    parts.push(text(left - 8, y + 4, shortNumber(tick), { anchor: 'end', size: 11, fill: MUTED }));
  }
  const keys = [...new Set(points.map((point) => point.series))];
  keys.forEach((key, index) => {
    const color = SERIES_COLORS[index % SERIES_COLORS.length];
    const series = points.filter((point) => point.series === key);
    // defined() 让空值自然形成断点，不必自己分段拼点。
    const build = shapeLine<Point>()
      .defined((point) => point.x !== null && point.y !== null)
      .x((point) => px(point.x as number))
      .y((point) => py(point.y as number));
    const d = build(series);
    if (d !== null) parts.push(path(d, color));
    // 单点序列画不出线，补一个点，免得看起来是空的。
    if (series.length === 1) {
      const only = series[0];
      if (only !== undefined && only.x !== null && only.y !== null) {
        parts.push(`<circle cx="${round(px(only.x))}" cy="${round(py(only.y))}" r="2.6" fill="${color}"/>`);
      }
    }
  });
  parts.push(line(left, top + plotHeight, left + plotWidth, top + plotHeight, AXIS));
  parts.push(text(left, top + plotHeight + 18, isTime ? formatInstant(xMin) : shortNumber(xMin), { size: 11, fill: MUTED }));
  parts.push(text(left + plotWidth, top + plotHeight + 18, isTime ? formatInstant(xMax) : shortNumber(xMax), { anchor: 'end', size: 11, fill: MUTED }));
  if (spec.xLabel !== null) {
    parts.push(text(left + plotWidth / 2, top + plotHeight + 38, spec.xLabel, { anchor: 'middle', size: 11, fill: MUTED }));
  }
  if (spec.valueLabel !== null) parts.push(text(left - 8, top - 14, spec.valueLabel, { anchor: 'end', size: 11, fill: MUTED }));
  if (keys.length > 1) {
    keys.forEach((key, index) => {
      const x = left + index * 132;
      const y = height - 10;
      parts.push(rect(x, y - 8, 10, 3, SERIES_COLORS[index % SERIES_COLORS.length]));
      parts.push(text(x + 16, y - 3, key === '' ? '(单序列)' : key, { size: 11, fill: MUTED }));
    });
  }
  return frame(height, spec, parts.join(''));
}

/** 按规格画一张 SVG；规格已在工具侧校验，这里只管画。 */
export const renderChartSvg = (rows: readonly Row[], spec: ChartSpec): string =>
  (spec.kind === 'bar' ? renderBar(rows, spec) : renderLine(rows, spec));
