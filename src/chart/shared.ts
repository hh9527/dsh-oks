// 出图与报告的公共件：色板、取数与排版规则。
//
// 十种图元（bar / line / column / pie / area / scatter / histogram / box / heatmap / radar）
// 都建在这些之上，语义（沿用数据顺序、缺失组合留空、来源标识、字号随数据密度缩放）在这里统一保证。

export type Row = Record<string, unknown>;

/** 全部图元。清单只此一份：schema 的枚举、规格的类型、渲染的分支都从这里取，
 *  否则加一个图元要改三处，漏掉一处就是"工具收下了、渲染认不得"（或反过来）。 */
export const CHART_KINDS = [
  'bar', 'line', 'column', 'pie', 'area', 'scatter', 'histogram', 'box', 'heatmap', 'radar',
] as const;
export type ChartKind = (typeof CHART_KINDS)[number];

/** 图元专属开关各自适用的图元。
 *
 *  这份表只此一份：校验（填给不支持的图元就报错）与渲染（这个开关在这张图上生不生效）都从它取。
 *  两处各写一遍就会漏——漏的后果不是报错，而是开关在这张图上**静默无效**。 */
export const EXPRESSION_SUPPORT = {
  /** 堆叠：把同一个分组里的序列叠起来。 */
  stack: ['column', 'area'],
  /** 气泡：把第三列映射成点的大小。 */
  size: ['scatter'],
  /** 分箱：直方图的箱子数。 */
  bins: ['histogram'],
  /** 第二个度量：另一条线配一个独立的第二数值轴。 */
  second: ['bar', 'column', 'line', 'area'],
  /** 参考线 / 阈值线。 */
  marks: ['bar', 'column', 'line', 'area'],
} as const;

/** 图元专属开关的名字。 */
export type ExpressionSwitch = keyof typeof EXPRESSION_SUPPORT;

/** 这个开关在这张图上生不生效。 */
export const supports = (kind: ChartKind, feature: ExpressionSwitch): boolean =>
  (EXPRESSION_SUPPORT[feature] as readonly ChartKind[]).includes(kind);

/** 开关适用的图元清单，报错时用它告诉 agent 该填给谁。 */
export const supportedKinds = (feature: ExpressionSwitch): readonly ChartKind[] => EXPRESSION_SUPPORT[feature];

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

/** 颜色在色板里的样子：`#rrggbb` → 三个通道。不是这个形状的就当成中性灰，
 *  免得把一处笔误放大成一片崩溃——画出来的颜色不对，比整张图画不出来好定位。 */
const rgbOf = (hex: string): [number, number, number] => {
  const match = /^#([0-9a-fA-F]{6})$/.exec(hex);
  if (match === null) return [128, 128, 128];
  const value = Number.parseInt(match[1], 16);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
};

const hexOf = ([r, g, b]: [number, number, number]): string =>
  `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;

/** 把颜色调暗一档，用于折线 / 面积的描边。
 *
 *  描边和填充同色时等于没有描边——层与层之间因为有别的颜色垫在下面还看得出来，
 *  但**最上面那条外缘线**是同色叠同色，直接消失，整张图看着像"缺了顶部的细节"。
 */
export const darken = (hex: string, amount = 0.26): string => {
  const scale = (channel: number): number => Math.max(0, Math.round(channel * (1 - amount)));
  const [r, g, b] = rgbOf(hex);
  return hexOf([scale(r), scale(g), scale(b)]);
};

/** 把颜色调浅一档（向白色混合），用于色阶的浅端。它是 `darken` 的镜像。 */
export const tint = (hex: string, amount = 0.9): string => {
  const scale = (channel: number): number => Math.min(255, Math.round(channel + (255 - channel) * amount));
  const [r, g, b] = rgbOf(hex);
  return hexOf([scale(r), scale(g), scale(b)]);
};

/** 数值到颜色的连续色阶。
 *
 *  序列色板回答"第几个序列用什么颜色"，色阶回答"数值多大用什么颜色"——两件事，共用 `style.colors`：
 *  agent 给一个颜色就由它生成"浅 → 深"，给多个就按它们插值（于是红-黄-绿的等级色阶也表达得了）。
 */
export const rampStops = (colors: readonly string[] | undefined): string[] => {
  const base = colors === undefined || colors.length === 0 ? SERIES_COLORS[0] : colors[0];
  if (colors !== undefined && colors.length > 1) return [...colors];
  return [tint(base, 0.92), tint(base, 0.55), base, darken(base, 0.42)];
};

/** 色阶上某一点的颜色：在相邻两个锚点之间按 sRGB 线性插值——echarts 取色走的也是这条路径，
 *  所以用它算出来的深浅，和格子上真正的底色是一致的。 */
export const rampAt = (stops: readonly string[], t: number): string => {
  const scaled = Math.max(0, Math.min(1, t)) * (stops.length - 1);
  const index = Math.min(stops.length - 2, Math.floor(scaled));
  const local = scaled - index;
  const from = rgbOf(stops[index]);
  const to = rgbOf(stops[Math.min(index + 1, stops.length - 1)]);
  const mix = (a: number, b: number): number => Math.round(a + (b - a) * local);
  return hexOf([mix(from[0], to[0]), mix(from[1], to[1]), mix(from[2], to[2])]);
};

/** 放在这个底色上的文字该用深色还是浅色：取对比度更高的那一边。
 *  色阶中段的颜色对深浅两种文字都不友好（两边都只有 3.5:1 上下），所以只能挑好的一边；
 *  分界点取"与两者的对比度相等"的那个亮度，不是看着差不多的一刀切。 */
export const readableOn = (background: string): string => {
  const channels = rgbOf(background).map((channel) => {
    const value = channel / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  const luminance = 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  return luminance < 0.249 ? '#ffffff' : '#2a3540';
};

/** 从一列值推断横轴怎么读。
 *
 *  只在"明确像时间"时才判成 time——年份数字（2026）绝不能被当成 epoch 毫秒，
 *  那会把横轴画到 1970 年去，而且看起来还挺像一张图。
 */
export const inferXType = (values: readonly unknown[]): 'number' | 'time' | 'category' => {
  const present = values.filter((value) => value !== null && value !== undefined && value !== '');
  if (present.length === 0) return 'category';
  // 文本：必须带日期与时间两部分的形状才算时间。
  const looksLikeDateTime = (text: string): boolean =>
    /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(text) || /^\d{4}\/\d{1,2}\/\d{1,2}/.test(text);
  if (present.every((value) => typeof value === 'string' && looksLikeDateTime(value))) return 'time';
  if (present.every((value) => typeof value === 'number' && Number.isFinite(value))) {
    // epoch 毫秒：只认合理区间（2000-01-01 ~ 2100-01-01）。年份数字落不进这个区间。
    const min = Date.UTC(2000, 0, 1);
    const max = Date.UTC(2100, 0, 1);
    return present.every((value) => (value as number) >= min && (value as number) <= max) ? 'time' : 'number';
  }
  return 'category';
};

/** 数值轴的说明：valueLabel 与 unit 合成。
 *  label 里已经带了单位就不再重复——agent 常把单位写进 label（"CPU 使用率 (%)"），
 *  再给一次 unit 就会拼成"CPU 使用率 (%)（%）"。 */
export const valueAxisLabel = (valueLabel: string | null, unit: string | null): string | null => {
  if (valueLabel === null) return unit === null ? null : `单位：${unit}`;
  if (unit === null || valueLabel.includes(unit)) return valueLabel;
  return `${valueLabel}（${unit}）`;
};
