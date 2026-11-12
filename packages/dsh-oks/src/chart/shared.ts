// 出图与报告的公共件：色板、取数与排版规则。
//
// 所有图元共用配色、字号单位与外围排版规则。

export type Row = Record<string, unknown>;

/** 全部图元。清单只此一份：schema 的枚举、规格的类型、渲染的分支都从这里取，
 *  否则加一个图元要改三处，漏掉一处就是"工具收下了、渲染认不得"（或反过来）。 */
export const CHART_KINDS = [
  'bar', 'grouped_bar', 'line', 'column', 'grouped_column', 'pie', 'area', 'scatter', 'histogram', 'box', 'heatmap', 'radar',
  'sankey', 'gauge', 'graph',
] as const;
export type ChartKind = (typeof CHART_KINDS)[number];

/** 图元专属开关各自适用的图元。
 *
 *  这份表只此一份：校验（填给不支持的图元就报错）与渲染（这个开关在这张图上生不生效）都从它取。
 *  两处各写一遍就会漏——漏的后果不是报错，而是开关在这张图上**静默无效**。 */
export const EXPRESSION_SUPPORT = {
  /** 堆叠：把同一个分组里的序列叠起来。 */
  stack: ['grouped_bar', 'grouped_column', 'area'],
  /** 气泡：把第三列映射成点的大小。 */
  size: ['scatter'],
  /** 分箱：直方图的箱子数。 */
  bins: ['histogram'],
  /** 第二个度量：另一条线配一个独立的第二数值轴。 */
  second: ['bar', 'grouped_bar', 'column', 'grouped_column', 'line', 'area'],
  /** 参考线 / 阈值线。 */
  marks: ['bar', 'grouped_bar', 'column', 'grouped_column', 'line', 'area', 'gauge'],
  /** 环形：饼图中心留白。 */
  donut: ['pie'],
  /** 断点：缺失点在折线上连成直线（`true`）还是断开成两段（不写）。
   *  缺口本身是信息——"这段没有数据"与"这段数据是平的"在图上必须能分开。 */
  connectNulls: ['line', 'area'],
  /** 颜色跟实体：颜色由名字决定（`true`），于是同一个实体在哪张图里都是同一个颜色；
   *  不写就按序列序号取色。 */
  entityColor: ['bar', 'grouped_bar', 'column', 'grouped_column', 'line', 'area', 'pie', 'radar'],
} as const;

/** 图元专属开关的名字。 */
export type ExpressionSwitch = keyof typeof EXPRESSION_SUPPORT;

/** 这个开关在这张图上生不生效。 */
export const supports = (kind: ChartKind, feature: ExpressionSwitch): boolean =>
  (EXPRESSION_SUPPORT[feature] as readonly ChartKind[]).includes(kind);

/** 开关适用的图元清单，报错时用它告诉 agent 该填给谁。 */
export const supportedKinds = (feature: ExpressionSwitch): readonly ChartKind[] => EXPRESSION_SUPPORT[feature];

/** 开关适用矩阵的一句话说明：声明里那行由它生成，于是表、校验与报错三处不会各写一遍。 */
export const expressionMatrix = (): string =>
  (Object.keys(EXPRESSION_SUPPORT) as ExpressionSwitch[])
    .map((feature) => `${feature}: ${EXPRESSION_SUPPORT[feature].join(' | ')}`)
    .join('; ');

/** 色板：同一个序列在不同图元里颜色保持一致。 */
export const SERIES_COLORS = ['#5a8cf0', '#e0803a', '#4aa96c', '#c0567a', '#8a6ad0'];

/** 跟实体取色时的色板。名字的哈希落在色板上，格子多几个，同一张图里撞色的机会就小几个
 *  （名字多于色板时仍会重复，报告里如实说明）。 */
export const ENTITY_COLORS = [
  '#5a8cf0', '#e0803a', '#4aa96c', '#c0567a', '#8a6ad0', '#2f9bb3', '#b8952e', '#7a8b3a',
  '#d2694f', '#4f7fc4', '#a05fb0', '#3f9e8d', '#c26a2e', '#6b7fd0', '#9e5b7a', '#5aa0c0',
];

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

/** 字号是排版单位；不再根据文字内容或数据密度缩小字体。 */
export const TITLE_FONT = 16;
export const LABEL_FONT = 12;

/** 固定类别槽位；只看类别数量，不测量具体文字。 */
export const needsSlantedTicks = (categories: readonly string[], font = LABEL_FONT): boolean =>
  categories.length > Math.floor(PLOT_WIDTH / (font * 6));

/** 所有图元共用的字号单位。 */
export const fontUnits = (font: number) => ({
  line: Math.ceil(font * 1.5),
  row: Math.ceil(font * 2.5),
  bar: Math.ceil(font * 1.5),
  gap: Math.ceil(font),
  body: Math.ceil(font * 20),
});

/** 按固定字符槽换行，不进行字体测量；全角/半角采用相同槽宽。 */
export const wrapSlots = (text: string, capacity: number): string => text.split('\n').flatMap(line => {
  const chars = [...line];
  return chars.length === 0 ? [''] : Array.from({length: Math.ceil(chars.length / capacity)}, (_, i) => chars.slice(i * capacity, (i + 1) * capacity).join(''));
}).join('\n');

/** 标题和图例占独立行，绘图区只使用剩余的独立空间。 */
export const chartFrame = (title: string | null, names: readonly string[], font: number, titleFont: number) => {
  const u = fontUnits(font);
  const titleText = title === null ? null : wrapSlots(title, Math.max(1, Math.floor((PAGE_WIDTH - 2 * u.gap) / titleFont)));
  const titleHeight = titleText === null ? 0 : titleText.split('\n').length * Math.ceil(titleFont * 1.5) + u.gap;
  // 每个图例项固定为 12 个字槽 + 图标 + 间距，保证预留量不依赖文字宽度。
  const legendColumns = Math.max(1, Math.floor((PAGE_WIDTH - 2 * u.gap) / (font * 15)));
  const legendRows = Math.ceil(names.length / legendColumns);
  const legendHeight = legendRows * u.row;
  return {titleText, legendTop: u.gap + titleHeight, top: u.gap + titleHeight + legendHeight + u.gap, bottom: u.line * 3, legendColumns, ...u};
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
  /** 覆盖色板；普通柱条图按类别，分组图按序列，饼图按扇区取用。 */
  colors?: string[];
}

/** 可选排版参数；尺寸由字号与图表结构自动计算，不开放像素高度。 */
export interface LayoutOverrides {
  /** 轴标签 / 刻度 / 图例的字号（px）。 */
  labelFont?: number;
  /** 标题字号（px）。 */
  titleFont?: number;
  /** 标签是否斜排；不填时按"挤不挤"自动判断。 */
  slantTicks?: boolean;
  /** 数值轴的刻度数量（3–12）；不填用默认档。 */
  tickCount?: number;
}

/** 一张图最终采用的排版值。 */
export interface Layout {
  labelFont: number;
  titleFont: number;
  slantTicks: boolean;
  tickCount: number;
}

/** 数值轴的默认刻度数量：密了像尺子、疏了看不出量级，六档在多数情况下刚好。 */
export const DEFAULT_TICK_COUNT = 6;

/** 把"默认规则 + agent 覆盖"合成最终排版值。
 *  默认规则：字号固定，几何尺寸由字号与结构数量推导。 */
export const resolveLayout = (options: {
  categories: readonly string[];
  overrides: LayoutOverrides;
}): Layout => ({
  labelFont: options.overrides.labelFont ?? LABEL_FONT,
  titleFont: options.overrides.titleFont ?? Math.round((options.overrides.labelFont ?? LABEL_FONT) * TITLE_FONT / LABEL_FONT),
  slantTicks: options.overrides.slantTicks ?? needsSlantedTicks(options.categories, options.overrides.labelFont ?? LABEL_FONT),
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
  // 浅端只到 75% 白：再浅（92% 白 ≈ rgb(242,246,254)）时，"最小的那个值"和"没有数据留的白"
  // 在屏幕上是同一个颜色——真机上就撞到过：21 个有数据的格子里 13 个落在这一档，
  // 而同一张图里还有 15 个真正没数据的空格，读者分不出哪些格子是在说"这里只有 1 条"。
  return [tint(base, 0.75), tint(base, 0.55), base, darken(base, 0.42)];
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

/** 数值轴的说明：valueLabel 与 unit 合成。
 *  label 里已经带了单位就不再重复——agent 常把单位写进 label（"CPU 使用率 (%)"），
 *  再给一次 unit 就会拼成"CPU 使用率 (%)（%）"。 */
export const valueAxisLabel = (valueLabel: string | null, unit: string | null): string | null => {
  if (valueLabel === null) return unit === null ? null : `单位：${unit}`;
  if (unit === null || valueLabel.includes(unit)) return valueLabel;
  return `${valueLabel}（${unit}）`;
};
