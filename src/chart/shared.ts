// 出图 lowering 的公共件：色板、转义、文本宽度估算，以及"从结果行里取类别与序列"。
//
// 五种图元（bar / column / line / pie / area）都建在这些之上；它们只负责把自己那种图的
// lilaq 调用拼出来，语义（沿用数据顺序、缺失组合留空、来源标识）在这里统一保证。

export type Row = Record<string, unknown>;

/** 色板：同一个序列在不同图元里颜色保持一致。 */
export const SERIES_COLORS = ['#5a8cf0', '#e0803a', '#4aa96c', '#c0567a', '#8a6ad0'];

/** 负值条的颜色：方向之外再加一重区分，正负一眼可辨。 */
export const NEGATIVE_COLOR = '#c0567a';

/** 页面宽度（pt）。typst 的 pt 落到 SVG 里会被当作 px，渲染层再按 pt→px 放大。 */
export const PAGE_WIDTH = 720;

/** 绘图区的近似宽度：页面宽度去掉页边距与左侧的轴标签区。 */
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

/** typst 的字符串字面量：转义反斜杠、双引号与换行。 */
export const typstString = (text: string): string =>
  `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, '\\n')}"`;

/** typst 内容块的转义：在 `[...]` 里 `\` `[` `]` `#` `$` 有语法含义。 */
export const typstContent = (text: string): string => text.replace(/[\\[\]$#]/g, (char) => `\\${char}`);

export const round = (value: number): number => Math.round(value * 1000) / 1000;

/** 图上的字号档。标题与来源标识固定；标签随数据密度在有限范围内缩放——
 *  数据量大时小一点确实更清楚，但再小就看不清了，所以下限是 9pt。 */
export const TITLE_FONT = 16;
export const LABEL_FONT_MIN = 9;
export const LABEL_FONT_MAX = 12;
export const FOOTNOTE_FONT = 8;

/** 按数据密度选标签字号：放得下就用上限，挤就按比例往下调，但不低于下限。
 *  真到下限还挤，调用方会退到"斜排标签"那条路（见 needsSlantedTicks）。 */
export const labelFontSize = (categories: readonly string[]): number => {
  if (categories.length === 0) return LABEL_FONT_MAX;
  const slot = PLOT_WIDTH / categories.length;
  const widest = Math.max(...categories.map((category) => estimateTextWidth(category, LABEL_FONT_MAX)));
  if (widest <= slot * 0.8) return LABEL_FONT_MAX;
  const needed = LABEL_FONT_MAX * ((slot * 0.8) / widest);
  return Math.max(LABEL_FONT_MIN, Math.min(LABEL_FONT_MAX, Math.round(needed * 10) / 10));
};

/** typst 的数组字面量：空数组是 `()`，非空一律带尾逗号——`(0)` 在 typst 里是"括号里的整数"，
 *  只有 `(0,)` 才是单元素数组。 */
export const typstArray = (items: readonly (string | number)[]): string =>
  items.length === 0 ? '()' : `(${items.join(', ')},)`;

/** 估算一段文本的宽度（pt）：中日韩字符按一个字宽、其余按 0.55 字宽，再乘字号。 */
const estimateTextWidth = (text: string, fontSize: number): number =>
  [...text].reduce((sum, char) => sum + (/[\u2e80-\u9fff\uff00-\uffef]/.test(char) ? 1 : 0.55), 0) * fontSize;

/** 类别标签会不会挤在一起：最长标签超过每组可用宽度的八成时，就该斜排。 */
export const needsSlantedTicks = (categories: readonly string[]): boolean => {
  if (categories.length === 0) return false;
  const slot = PLOT_WIDTH / categories.length;
  const widest = Math.max(...categories.map((category) => estimateTextWidth(category, 11)));
  return widest > slot * 0.8;
};

/** 把横轴刻度标签斜 45° 并贴到刻度右端——lilaq 文档里的做法，避免长标签互相压住。 */
const SLANTED_TICKS = [
  '#show: lq.show_(',
  '  lq.tick-label.with(kind: "x"),',
  '  it => box(width: 0pt, align(right, rotate(-45deg, reflow: true, it))),',
  ')',
];

/** 把一个时间值写成 typst 的 datetime：接受 epoch 毫秒或可解析的时间文本，按 UTC 解释。
 *  折线与面积图的横轴都用它——lilaq 看到 datetime 会自动把轴切成 datetime 刻度。 */
export const typstDatetime = (value: unknown): string | null => {
  const millis = typeof value === 'number'
    ? value
    : (typeof value === 'string' && value.length > 0 ? Date.parse(value) : Number.NaN);
  if (!Number.isFinite(millis)) return null;
  const date = new Date(millis);
  return 'datetime('
    + `year: ${date.getUTCFullYear()}, month: ${date.getUTCMonth() + 1}, day: ${date.getUTCDate()}, `
    + `hour: ${date.getUTCHours()}, minute: ${date.getUTCMinutes()}, second: ${date.getUTCSeconds()})`;
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

/** agent 可以覆盖的排版参数（都放在 spec 里，全部可选）。
 *  不填就走下面的默认规则——默认值本身也是"文字优先、宽度固定、高度按图元"那套。
 *  开放它们是为了让 agent 能按用户反馈当场调整，不必等插件改版。 */
export interface LayoutOverrides {
  /** 轴标签 / 刻度 / 图例的字号（pt）。 */
  labelFont?: number;
  /** 标题字号（pt）。 */
  titleFont?: number;
  /** 图高（pt）；横条图省略时按行数算。 */
  height?: number;
  /** 横条图每行的高度（pt）。 */
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
 *  默认规则：字号随数据密度在 8.5–11.5pt 之间缩放；高度由各图元给基准（横条按行数算）。 */
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

/** 把"想要的档数"取整到顺眼的间距：在 1 / 2 / 5 × 10ⁿ 里挑一个，
 *  挑的标准是"实际会出几档"最接近目标——直接用 range ÷ 档数 会得到 34 这种刻度值，
 *  而只看最接近的间距又会明显偏档（比如 0–2696 想要 6 档，1000 只出 3 档，500 出 6 档）。 */
const niceDistance = (range: number, tickCount: number): number => {
  let bestDistance = range;
  let bestError = Number.POSITIVE_INFINITY;
  for (let exponent = -6; exponent <= 12; exponent++) {
    for (const step of [1, 2, 5]) {
      const distance = step * 10 ** exponent;
      if (!Number.isFinite(distance) || distance <= 0) continue;
      // 用这个间距会得到几档（含首尾）。
      const ticks = Math.ceil(range / distance) + 1;
      const error = Math.abs(ticks - tickCount);
      if (error < bestError - 1e-9) {
        bestError = error;
        bestDistance = distance;
      }
    }
  }
  return bestDistance;
};

/** 把"想要几档刻度"换算成 lilaq 的 tick-distance：它按间距布刻度，而 agent 想的是"要几档"。
 *  从 0 起算（柱状图的基线就是 0），没有可用值或刻度少于两档时不返回。 */
export const tickDistance = (values: readonly number[], tickCount: number): number | null => {
  if (values.length === 0 || tickCount < 2) return null;
  const lo = Math.min(0, ...values);
  const hi = Math.max(0, ...values);
  if (hi === lo) return null;
  return niceDistance(hi - lo, tickCount);
};

/** 图的公共开头：import、页面设置、字号、可选的刻度斜排、diagram 打开与页宽。 */
export const diagramHeader = (options: {
  title: string | null;
  layout: Layout;
}): string[] => [
  '#import "@preview/lilaq:0.6.0" as lq',
  `#set page(width: ${PAGE_WIDTH}pt, height: auto, margin: 12pt)`,
  // 字号在这里统一给定：刻度、轴标签、图例都跟着它，确保图内文字只有一档。
  `#set text(size: ${options.layout.labelFont}pt)`,
  ...(options.layout.slantTicks ? SLANTED_TICKS : []),
  '#lq.diagram(',
  // lilaq 的图默认只有 6cm 宽，放在整页上会让右边大片留白、每组挤在一起。
  '  width: 100%,',
  `  height: ${options.layout.height}pt,`,
  // title 接受 content，但自己没有字号参数（默认继承文档的 text.size，也就是标签那档），
  // 所以把标题字号写进 content 里，否则 layout.titleFont 落不到图上。
  ...(options.title === null
    ? []
    : [`  title: text(size: ${options.layout.titleFont}pt, weight: "bold")[${typstContent(options.title)}],`]),
];

/** 数值轴的说明：valueLabel 与 unit 合成，已含单位就不再重复。 */
export const valueAxisLabel = (valueLabel: string | null, unit: string | null): string | null => {
  if (valueLabel === null) return unit === null ? null : `单位：${unit}`;
  return unit === null ? valueLabel : `${valueLabel}（${unit}）`;
};

/** 图的公共结尾：来源标识。 */
export const sourceFootnote = (sourceLabel: string): string =>
  `#text(size: ${FOOTNOTE_FONT}pt, fill: rgb("#5b6b7c"))[来源：${typstContent(sourceLabel)}]`;
