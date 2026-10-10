// 出图与报告的公共件：色板、取数与排版规则。
//
// 五种图元（bar / column / line / pie / area）都建在这些之上，语义（沿用数据顺序、
// 缺失组合留空、来源标识、字号随数据密度缩放）在这里统一保证。

export type Row = Record<string, unknown>;

/** 色板：同一个序列在不同图元里颜色保持一致。 */
export const SERIES_COLORS = ['#5a8cf0', '#e0803a', '#4aa96c', '#c0567a', '#8a6ad0'];

/** 负值条的颜色：方向之外再加一重区分，正负一眼可辨。 */
export const NEGATIVE_COLOR = '#c0567a';

/** 图的输出宽度（px）。 */
export const PAGE_WIDTH = 720;

/** 绘图区的近似宽度：页面宽度去掉两侧留白与左侧的轴标签区。 */
const PLOT_WIDTH = PAGE_WIDTH - 24 - 60;

export const toNumber = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

export const toLabel = (value: unknown): string => {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object') return JSON.stringify(value) ?? '';
  return String(value);
};

/** 一列里出现过的不同取值，按首次出现的顺序（沿用数据顺序，不做隐式排序）。 */
export const distinct = (rows: readonly Row[], column: string): string[] => {
  const seen: string[] = [];
  for (const row of rows) {
    const value = toLabel(row[column]);
    if (!seen.includes(value)) seen.push(value);
  }
  return seen;
};

/** 图上的字号档。标题固定；标签随数据密度在有限范围内缩放——
 *  数据量大时小一点确实更清楚，但再小就看不清了，所以下限是 9pt。 */
export const TITLE_FONT = 16;
export const LABEL_FONT_MIN = 9;
export const LABEL_FONT_MAX = 12;

/** 估算一段文本的宽度（pt）：中日韩字符按一个字宽、其余按 0.55 字宽，再乘字号。 */
const estimateTextWidth = (text: string, fontSize: number): number =>
  [...text].reduce((sum, char) => sum + (/[\u2e80-\u9fff\uff00-\uffef]/.test(char) ? 1 : 0.55), 0) * fontSize;

/** 按数据密度选标签字号：放得下就用上限，挤就按比例往下调，但不低于下限。 */
export const labelFontSize = (categories: readonly string[]): number => {
  if (categories.length === 0) return LABEL_FONT_MAX;
  const slot = PLOT_WIDTH / categories.length;
  const widest = Math.max(...categories.map((category) => estimateTextWidth(category, LABEL_FONT_MAX)));
  if (widest <= slot * 0.8) return LABEL_FONT_MAX;
  const needed = LABEL_FONT_MAX * ((slot * 0.8) / widest);
  return Math.max(LABEL_FONT_MIN, Math.min(LABEL_FONT_MAX, Math.round(needed * 10) / 10));
};

/** 类别标签会不会挤在一起：最长标签超过每组可用宽度的八成时，就该斜排。 */
export const needsSlantedTicks = (categories: readonly string[]): boolean => {
  if (categories.length === 0) return false;
  const slot = PLOT_WIDTH / categories.length;
  const widest = Math.max(...categories.map((category) => estimateTextWidth(category, 11)));
  return widest > slot * 0.8;
};

/** 第二个度量：让同一张图里再画一条线，并给它一个独立的右侧数值轴。
 *  它的存在意义就是"两个量纲差很远的东西放一起看"（如 CPU 百分比与端口数计数）。 */
export interface SecondMetric {
  /** 第二个度量所在的列名。 */
  value: string;
  /** 第二个度量画成什么。目前只开折线——柱与柱并排会混淆"哪个是主轴"。 */
  kind?: 'line';
  /** 右侧数值轴的说明；不填时用 value 的列名。 */
  label?: string;
  /** 第二个度量的单位。 */
  unit?: string;
}

/** 一条参考线 / 阈值线。只画线加标签，不做区域填充。 */
export interface MarkLine {
  /** 线的位置：数值轴上是数值，类别轴上是类别名。 */
  value: number | string;
  /** 线上的标签。 */
  label?: string;
  /** 画在哪根轴上：`y` 是数值轴（阈值，默认），`x` 是类别轴（某个时间点）。 */
  axis?: 'y' | 'x';
}

/** agent 可以覆盖的表达开关（都放在 spec 里，全部可选）。
 *  它们管"这份数据怎么表达"：排序、数值标签、配色。不填就走默认。 */
export interface StyleOverrides {
  /** 类别排序。默认沿用数据顺序——数据本身常常带着有意义的顺序（如告警等级的严重度）。 */
  sort?: 'none' | 'desc' | 'asc';
  /** 是否在图上标出数值。 */
  labels?: boolean;
  /** 覆盖色板；按序列（或扇区）依次取用。 */
  colors?: string[];
}

/** agent 可以覆盖的排版参数（都放在 spec 里，全部可选）。
 *  不填就走默认规则——默认值本身也是"文字优先、宽度固定、高度按图元"那套。
 *  开放它们是为了让 agent 能按用户反馈当场调整，不必等插件改版。 */
export interface LayoutOverrides {
  /** 轴标签 / 刻度 / 图例的字号（px）。 */
  labelFont?: number;
  /** 标题字号（px）。 */
  titleFont?: number;
  /** 图高（px）；横条图省略时按行数算。 */
  height?: number;
  /** 横条图每行的高度（px）。 */
  rowHeight?: number;
  /** 标签是否斜排；不填时按"挤不挤"自动判断。 */
  slantTicks?: boolean;
  /** 数值轴的刻度数量（3–12）；不填用默认档。 */
  tickCount?: number;
}

/** 一张图最终采用的排版值。 */
export interface Layout {
  labelFont: number;
  titleFont: number;
  height: number;
  slantTicks: boolean;
  tickCount: number;
}

/** 数值轴的默认刻度数量：密了像尺子、疏了看不出量级，六档在多数情况下刚好。 */
export const DEFAULT_TICK_COUNT = 6;

/** 横条图每行的默认高度：一行 = 正文 + 上下留白。 */
export const ROW_HEIGHT = 26;

/** 把"默认规则 + agent 覆盖"合成最终排版值。
 *  默认规则：字号随数据密度在 9–12 之间缩放；高度由各图元给基准（横条按行数算）。 */
export const resolveLayout = (options: {
  categories: readonly string[];
  overrides: LayoutOverrides;
  /** 该图元的默认高度（横条由调用方按行数算好再传进来）。 */
  defaultHeight: number;
}): Layout => ({
  labelFont: options.overrides.labelFont ?? labelFontSize(options.categories),
  titleFont: options.overrides.titleFont ?? TITLE_FONT,
  height: options.overrides.height ?? options.defaultHeight,
  slantTicks: options.overrides.slantTicks ?? needsSlantedTicks(options.categories),
  tickCount: options.overrides.tickCount ?? DEFAULT_TICK_COUNT,
});

/** 数值轴的说明：valueLabel 与 unit 合成。
 *  label 里已经带了单位就不再重复——agent 常把单位写进 label（"CPU 使用率 (%)"），
 *  再给一次 unit 就会拼成"CPU 使用率 (%)（%）"。 */
export const valueAxisLabel = (valueLabel: string | null, unit: string | null): string | null => {
  if (valueLabel === null) return unit === null ? null : `单位：${unit}`;
  if (unit === null || valueLabel.includes(unit)) return valueLabel;
  return `${valueLabel}（${unit}）`;
};
