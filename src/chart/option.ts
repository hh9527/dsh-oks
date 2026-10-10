/** 呈现规格 → echarts option。
 *
 *  这是整条出图链路里"把业务字段与结果行翻译成渲染输入"的那一层。echarts 吃的是 JSON，
 *  所以规格本身就是渲染输入的形状——不需要先生成一门中间语言。
 *
 *  译者只做映射，不做判断：哪些序列要画、配色怎么轮、空数据怎么办，都由这里与调用方共享的规则决定。
 */
import {
  NEGATIVE_COLOR,
  PAGE_WIDTH,
  SERIES_COLORS,
  distinct,
  labelFontSize,
  needsSlantedTicks,
  rampAt,
  rampStops,
  readableOn,
  resolveLayout,
  supports,
  toLabel,
  toNumber,
  valueAxisLabel,
  type ChartKind,
  darken,
  type LayoutOverrides,
  type MarkLine,
  type Row,
  type SecondMetric,
  type StyleOverrides,
} from './shared.ts';
import { boxSummary, histogramBins } from './stats.ts';
import type { EChartsCoreOption } from 'echarts/core';

/** 图表的输出尺寸（px）。echarts 的 SSR 不做自适应，宽高必须在初始化时给定。 */
export const CHART_WIDTH = PAGE_WIDTH;

/** 测得的绘图区高度：竖条 / 折线 / 面积为固定值，横条按行数算，饼图为方框边长。
 *  `count` 是"有多少行要占高度"：横条与矩阵是一行一个类别（矩阵传的是分组数），其余传类别数。 */
export const plotHeight = (kind: string, count: number, labelFont: number, overrides: LayoutOverrides): number => {
  const rowHeight = Math.max(overrides.rowHeight ?? 26, Math.round(labelFont * 1.8));
  const fallback = kind === 'bar' ? Math.round(60 + count * rowHeight)
    // 矩阵的行是分组，高度按行数走；再给标题与底部色标留出位置。
    : kind === 'heatmap' ? Math.max(240, Math.round(104 + count * rowHeight))
      : kind === 'pie' ? 300
        : kind === 'radar' ? 420
          : 340;
  return overrides.height ?? fallback;
};

/** 一次渲染要用的全部输入。字段分三层：语义（这份数据是什么）、表达开关（怎么表达）、排版。 */
export interface OptionInput {
  kind: ChartKind;
  title: string | null;
  /** 系统来源标识（基于查询结果 / agent 自主填写），画在图内左下角。 */
  sourceLabel: string;
  x: string;
  value: string;
  series: string | null;
  xType: 'number' | 'time' | null;
  xLabel: string | null;
  valueLabel: string | null;
  unit: string | null;
  /** 图元专属：column / area 的堆叠方式。total 是绝对量、percent 是各组占比。 */
  stack?: 'total' | 'percent' | null;
  /** 图元专属：scatter 的第三维——把这一列的数值映射成点的大小。 */
  size?: string | null;
  /** 第二个度量：同一张图里再画一条线，带独立的右侧数值轴。 */
  second?: SecondMetric | null;
  /** 参考线 / 阈值线。 */
  marks?: readonly MarkLine[];
  /** 图元专属：histogram 的箱子数；不填按数据量选。 */
  bins?: number | null;
  /** 通用表达开关。 */
  style?: StyleOverrides;
  layout?: LayoutOverrides;
}

/** 轴名与 `valueAxisLabel` 是同一件事，只是这里的"没有名字"要还原成 echarts 认的 `undefined`。 */
const axisName = (label: string | null, unit: string | null): string | undefined =>
  valueAxisLabel(label, unit) ?? undefined;

/** 把结果行按 x 归类，再按 series 分组；返回类别顺序与每个序列的取值。
 *  类别顺序默认沿用数据——数据本身常带语义顺序（如告警等级的严重度）；有 style.sort 时按合计重排。 */
const group = (
  rows: readonly Row[],
  spec: OptionInput,
): { categories: string[]; seriesNames: string[]; points: Map<string, Map<string, number>> } => {
  const categories = distinct(rows, spec.x);
  const seriesNames = spec.series === null
    ? ['']
    : [...new Set(rows.map((row) => toLabel(row[spec.series as string])))];
  const points = new Map<string, Map<string, number>>();
  for (const name of seriesNames) points.set(name, new Map<string, number>());
  for (const row of rows) {
    const name = spec.series === null ? '' : toLabel(row[spec.series]);
    const value = toNumber(row[spec.value]);
    if (value === null) continue;
    const bucket = points.get(name);
    if (bucket !== undefined) bucket.set(toLabel(row[spec.x]), value);
  }

  const order = spec.style?.sort;
  if (order === undefined || order === 'none') return { categories, seriesNames, points };

  // 一个类别上的合计才是排序该看的量：多序列时它决定先后，单序列时就是它自己。
  const totalOf = (category: string): number => {
    let sum = 0;
    for (const bucket of points.values()) sum += bucket.get(category) ?? 0;
    return sum;
  };
  const sorted = [...categories].sort((a, b) => (order === 'desc' ? totalOf(b) - totalOf(a) : totalOf(a) - totalOf(b)));
  return { categories: sorted, seriesNames, points };
};

/** 来源标识：固定在图内左下角，由系统写，不由 agent 决定。 */
const footnote = (sourceLabel: string, fontSize: number): unknown => ({
  type: 'text',
  left: 8,
  bottom: 2,
  style: { text: `来源：${sourceLabel}`, fontSize: Math.max(8, fontSize - 3), fill: '#8494a5' },
  silent: true,
});

/** 轴上的短数字：分箱边界常是 10.568414634146341 这种，按量级留三到四位有效数字。 */
const short = (value: number): string => {
  if (!Number.isFinite(value)) return String(value);
  const abs = Math.abs(value);
  if (abs === 0) return '0';
  if (abs >= 1000 || abs < 0.01) return value.toExponential(2);
  const digits = abs >= 100 ? 1 : abs >= 10 ? 2 : 3;
  return String(Number(value.toFixed(digits)));
};

/** 轴上限取整到 1 / 2 / 5 的整十倍数。
 *  雷达的每个指标各有各的量纲，上限只能是"这个人看得懂的数"，不能是 3421 这种实测最大值。 */
const niceMax = (value: number): number => {
  if (!(value > 0)) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const scaled = value / magnitude;
  const step = scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 5 ? 5 : 10;
  return step * magnitude;
};

/** 没有可画的数据时，给一张只有标题与说明的图，而不是空白画布。 */
const emptyOption = (spec: OptionInput, layout: ReturnType<typeof resolveLayout>): EChartsCoreOption => ({
  title: {
    text: spec.title ?? '',
    subtext: '（没有数据）',
    left: 'center',
    top: 'middle',
    textStyle: { fontSize: layout.titleFont, fontWeight: 'bold', color: '#1c2b3a' },
    subtextStyle: { fontSize: layout.labelFont, color: '#8494a5' },
  },
  graphic: footnote(spec.sourceLabel, layout.labelFont),
});

/**
 * 规格 + 结果行 → echarts option。
 * 所有图元共用同一套规则：色板按序列轮转、负值用区分色、空序列跳过、类别密度决定标签斜排。
 */
export const buildOption = (rows: readonly Row[], spec: OptionInput): { option: EChartsCoreOption; height: number } => {
  const { categories, seriesNames, points } = group(rows, spec);
  const labelFont = spec.layout?.labelFont ?? labelFontSize(categories);
  const layout = resolveLayout({
    categories,
    overrides: spec.layout ?? {},
    defaultHeight: 340,
  });
  const height = plotHeight(
    spec.kind,
    // 占高度的"行"数：矩阵的行是分组（横轴才是类别）；横条图是一行一条，
    // 分组时每个类别里有 series 条，行数要乘开——不乘的话每根只有几个像素高，图不可读。
    spec.kind === 'heatmap' ? seriesNames.length
      : spec.kind === 'bar' ? categories.length * Math.max(seriesNames.length, 1)
        : categories.length,
    labelFont,
    spec.layout ?? {},
  );

  const hasValues = [...points.values()].some((bucket) => bucket.size > 0);
  if (!hasValues) return { option: emptyOption(spec, layout), height };

  const title = spec.title === null
    ? undefined
    : {
      text: spec.title,
      left: 'center' as const,
      textStyle: { fontSize: layout.titleFont, fontWeight: 'bold' as const, color: '#1c2b3a' },
    };
  const legend = seriesNames.length > 1 && spec.kind !== 'pie'
    ? { top: spec.title === null ? 0 : 34, right: 0, itemWidth: 12, itemHeight: 10, textStyle: { fontSize: labelFont, color: '#1c2b3a' } }
    : undefined;

  // 表达开关：色板可被覆盖，数值标签按需打开，堆叠只在 column / area 上有意义。
  const palette = spec.style?.colors !== undefined && spec.style.colors.length > 0 ? spec.style.colors : SERIES_COLORS;
  const pick = (index: number): string => palette[index % palette.length];
  const showLabels = spec.style?.labels === true;
  // spec.stack 的"没写"是 null，而下面各处的判断比的是 undefined——两种"没有"混在一起，
  // "不给 stack"就会被当成 stack: 'total'。"分组柱"因此在真机上从来画不出来（永远是多段的一根）。
  // 在这一行统一成 undefined，让"没写"和"没写"只有一个样子。
  const stack = supports(spec.kind, 'stack') ? spec.stack ?? undefined : undefined;

  // 散点：两个量之间的关系。给了 size 就把第三维映射成点的大小（气泡图）。
  if (spec.kind === 'scatter') {
    const sizeColumn = spec.size ?? null;
    const sizes = sizeColumn === null
      ? []
      : rows.map((row) => toNumber(row[sizeColumn])).filter((value): value is number => value !== null);
    const sizeMin = sizes.length === 0 ? 0 : Math.min(...sizes);
    const sizeMax = sizes.length === 0 ? 0 : Math.max(...sizes);
    // 12–30 px：差别看得出来，又不至于让最大的点压住邻座（半径 15px 以内，轴留白放得下）。
    const scaleSize = (value: number): number => (sizeMax === sizeMin ? 16 : 12 + ((value - sizeMin) / (sizeMax - sizeMin)) * 18);
    const data = rows.flatMap((row) => {
      const xValue = toNumber(row[spec.x]);
      const yValue = toNumber(row[spec.value]);
      if (xValue === null || yValue === null) return [];
      if (sizeColumn === null) return [{ value: [xValue, yValue] as [number, number], symbolSize: 10 }];
      const sizeValue = toNumber(row[sizeColumn]);
      return [{
        value: [xValue, yValue] as [number, number],
        symbolSize: sizeValue === null ? 10 : scaleSize(sizeValue),
        name: sizeValue === null ? '' : toLabel(row[sizeColumn]),
      }];
    });
    if (data.length === 0) return { option: emptyOption(spec, layout), height };
    const valueAxis = (name: string | undefined, gap: number, showSplit: boolean): unknown => ({
      type: 'value',
      name,
      nameLocation: 'middle',
      nameGap: gap,
      // 散点的轴跟着数据范围走（scale: true）。默认的 scale: false 会强制从 0 起，
      // 而 KPI 常常挤在很窄的区间里（CPU 40–74、内存 48–89）——那样点会全被压到一角。
      // 留白要给够：点的半径最大 15px，留白小于它就等于把最外圈的点画到绘图区外
      //（echarts 的散点默认不裁剪，会真的露在外面）。
      scale: true,
      boundaryGap: [0.12, 0.12],
      nameTextStyle: { fontSize: labelFont, color: '#5b6b7c' },
      axisLabel: { fontSize: labelFont, color: '#1c2b3a' },
      axisLine: { show: false },
      axisTick: { show: false },
      splitLine: showSplit ? { lineStyle: { color: '#eef2f7' } } : { show: false },
    });
    return {
      height,
      option: {
        title,
        graphic: footnote(spec.sourceLabel, labelFont),
        grid: { left: 64, right: 28, top: spec.title === null ? 20 : 52, bottom: 48, containLabel: false },
        xAxis: { ...(valueAxis(axisName(spec.xLabel, null), 30, true) as object), axisLine: { show: true, lineStyle: { color: '#d8e0ea' } } },
        yAxis: valueAxis(axisName(spec.valueLabel, spec.unit), 52, true),
        series: [{
          type: 'scatter',
          data,
          itemStyle: { color: pick(0), opacity: 0.75 },
          label: showLabels
            ? { show: true, position: 'right', fontSize: Math.max(9, labelFont - 2), color: '#5b6b7c', formatter: (params: { data: { name?: string } }) => params.data.name ?? '' }
            : undefined,
        }],
      },
    };
  }

  // 饼图：单一序列，数据是"名称 + 数值"，配色按扇区轮转。
  if (spec.kind === 'pie') {
    const bucket = points.get(seriesNames[0]) ?? new Map<string, number>();
    const data = [...bucket.entries()]
      .filter(([, value]) => value > 0)
      .map(([name, value], index) => ({
        name,
        value,
        itemStyle: { color: pick(index) },
      }));
    if (data.length === 0) return { option: emptyOption(spec, layout), height };
    return {
      height,
      option: {
        title,
        graphic: footnote(spec.sourceLabel, labelFont),
        series: [{
          type: 'pie',
          radius: ['0%', '68%'],
          center: ['50%', spec.title === null ? '52%' : '56%'],
          data,
          label: { fontSize: labelFont, color: '#1c2b3a' },
          labelLine: { length: 10, length2: 10 },
        }],
      },
    };
  }

  const horizontal = spec.kind === 'bar';
  const categoryAxis = {
    type: 'category' as const,
    data: categories,
    name: axisName(spec.xLabel, null),
    nameLocation: 'middle' as const,
    nameGap: horizontal ? 30 : 40,
    nameTextStyle: { fontSize: labelFont, color: '#5b6b7c' },
    axisLabel: {
      fontSize: labelFont,
      color: '#1c2b3a',
      // 类别在横轴上、又挤的时候斜排；横条的类别在纵轴上，保持水平。
      rotate: !horizontal && needsSlantedTicks(categories) ? 45 : 0,
      hideOverlap: true,
    },
    axisLine: { lineStyle: { color: '#d8e0ea' } },
    axisTick: { show: false },
  };
  // 参考线的值要能落在轴上：echarts 对超出轴范围的 markLine 直接不画，而"线不见了"比
  // "线画歪了"更难发现——阈值本来就是用来对照的，画不出来等于没给。
  const markValues = (spec.marks ?? [])
    .filter((mark) => mark.axis !== 'x' && typeof mark.value === 'number')
    .map((mark) => mark.value as number);
  const markMax = markValues.length === 0 ? null : Math.max(...markValues);
  const markMin = markValues.length === 0 ? null : Math.min(...markValues);
  // 折线的数值轴跟着数据走（scale），别的图元从 0 起。
  // 折线读的是"走势"，而走势常常发生在很窄的一段里——可用率 98.4–99.9% 落在 0–100 的轴上
  // 就是一条平线（真机报告里的图 9/图 10 正是如此：三条线的全部差距只有 3px）。
  // 柱与面积不能这样：长度与面积本身就是量，不从 0 起会说谎。
  const fitRange = spec.kind === 'line';

  const measureAxis = {
    type: 'value' as const,
    name: axisName(spec.valueLabel, spec.unit),
    nameLocation: 'middle' as const,
    nameGap: 48,
    nameTextStyle: { fontSize: labelFont, color: '#5b6b7c' },
    // 百分比堆叠时数据已经归一化到 100，轴上标成百分比。
    axisLabel: stack === 'percent'
      // 上限是 110（给堆叠顶部留一成余量，否则那条 100% 的线会压在轴顶上像被截断），
      // 但 110 这个刻度没有意义，隐掉它——读者看到的刻度仍是 0–100%。
      ? { fontSize: labelFont, color: '#1c2b3a', formatter: '{value}%', showMaxLabel: false }
      : { fontSize: labelFont, color: '#1c2b3a' },
    // 百分比堆叠的总和恒为 100%，堆叠顶部因此是一条水平线。若轴正好停在 100，那条线就压在轴顶上，
    // 看起来像"图被截断了"。放宽 max 会让那个怪数字直接变成刻度（108%、110%…），所以改用
    // boundaryGap：值域向上扩一成，刻度仍收在 100%。
    ...(stack === 'percent' ? { max: 110 } : {}),
    ...(fitRange ? { scale: true, boundaryGap: [0.08, 0.08] } : {}),
    // 让上界至少盖住参考线。echarts 的 max 接受函数，入参是它自己算出的边界。
    ...(stack !== 'percent' && markMax !== null
      ? { max: (bounds: { max: number }) => Math.max(bounds.max, markMax) }
      : {}),
    // 下界同理：轴收窄之后，比数据还低的阈值线会像上一波那样静默消失。
    ...(markMin !== null && (fitRange || markMin < 0)
      ? { min: (bounds: { min: number }) => Math.min(bounds.min, markMin) }
      : {}),
    // echarts 的 splitNumber 是"分割段数"，档数减一。
    splitNumber: Math.max(1, layout.tickCount - 1),
    axisLine: { show: false },
    axisTick: { show: false },
    splitLine: { lineStyle: { color: '#eef2f7' } },
  };

  const grid = {
    left: horizontal ? 96 : 62,
    right: 24,
    top: spec.title === null ? (legend === undefined ? 16 : 30) : (legend === undefined ? 50 : 66),
    bottom: horizontal ? 42 : 46,
    containLabel: false,
  };

  const series = seriesNames.map((name, index) => {
    const bucket = points.get(name) ?? new Map<string, number>();
    const raw = categories.map((category) => bucket.get(category) ?? null);
    // 百分比堆叠：把每个类别上各序列的值归一化到 100，这样"构成"才可比。
    const data = stack === 'percent'
      ? categories.map((category, i) => {
        const totals = seriesNames.reduce((sum, other) => sum + (points.get(other)?.get(category) ?? 0), 0);
        const value = raw[i];
        return value === null || totals === 0 ? null : Math.round((value / totals) * 1000) / 10;
      })
      : raw;
    const color = pick(index);
    const base = {
      name: name === '' ? axisName(spec.valueLabel, spec.unit) ?? 'value' : name,
      data,
      itemStyle: {
        // 负值换区分色：柱状图里正负同轴时更好读。
        color: (params: { value: number | null }) => (params.value !== null && params.value < 0 ? NEGATIVE_COLOR : color),
      },
      connectNulls: false,
      // 堆叠只在 column / area 上有意义：同一个 stack 名的序列会叠在一起。
      stack: stack === undefined ? undefined : 'total',
      label: showLabels
        ? { show: true, fontSize: Math.max(9, labelFont - 2), color: '#3d4d5c', position: spec.kind === 'bar' ? 'right' as const : 'top' as const }
        : undefined,
    };
    if (spec.kind === 'line' || spec.kind === 'area') {
      return {
        ...base,
        type: 'line' as const,
        smooth: false,
        symbol: 'circle',
        symbolSize: 6,
        // 描边比填充深一档：同色叠同色时，最上面那条外缘线会整个消失。
        lineStyle: { width: 2, color: darken(color) },
        areaStyle: spec.kind === 'area' ? { color, opacity: stack === undefined ? 0.18 : 0.7 } : undefined,
      };
    }
    return { ...base, type: 'bar' as const, barMaxWidth: horizontal ? 18 : 28, barGap: stack === undefined ? '12%' : '0%' };
  });

  // x 轴：横条图是数值轴（第二维度就挂在它旁边），其余是类别轴或时间轴。
  const baseXAxis = horizontal ? measureAxis : (spec.kind === 'line' || spec.kind === 'area') && spec.xType === 'time'
    ? { ...categoryAxis, type: 'time' as const, data: undefined }
    : categoryAxis;

  // 直方图：一列数值先分箱再按箱画柱。散点表现不了"一组值怎么分布"（三档数据画出来就是三个点），
  // 这类形状要的是直方图——先把箱子算出来，再交给柱。
  if (spec.kind === 'histogram') {
    const values = rows
      .map((row) => toNumber(row[spec.value]))
      .filter((value): value is number => value !== null);
    const bins = histogramBins(values, spec.bins ?? undefined);
    if (bins.length === 0) return { option: emptyOption(spec, layout), height };
    // 轴标签用短数字：分箱边界常是 10.568414634146341 这种，直接写上去没法看。
    const labels = bins.map((bin) => (bin.start === bin.end ? short(bin.start) : `${short(bin.start)}–${short(bin.end)}`));
    return {
      height,
      option: {
        title,
        graphic: footnote(spec.sourceLabel, labelFont),
        grid,
        xAxis: {
          ...categoryAxis,
          data: labels,
          name: axisName(spec.xLabel ?? spec.value, null),
          axisLabel: {
            fontSize: labelFont,
            color: '#1c2b3a',
            interval: 0,
            // 箱标签本来就长，斜排比挤成一团好读。
            rotate: needsSlantedTicks(labels) ? 45 : 0,
          },
        },
        yAxis: { ...measureAxis, name: axisName(spec.valueLabel ?? '计数', spec.unit) },
        series: [{
          type: 'bar' as const,
          name: axisName(spec.valueLabel ?? '计数', spec.unit) ?? '计数',
          data: bins.map((bin) => bin.count),
          itemStyle: { color: pick(0) },
          barCategoryGap: '2%',
          barMaxWidth: 40,
          label: showLabels
            ? { show: true, position: 'top' as const, fontSize: Math.max(9, labelFont - 2), color: '#3d4d5c' }
            : undefined,
        }],
      },
    };
  }

  // 箱线图：按类别看分布。四分位与离群点都由服务端算好（见 stats.ts），图里只负责画。
  if (spec.kind === 'box') {
    const byCategory = new Map<string, number[]>();
    for (const row of rows) {
      const value = toNumber(row[spec.value]);
      if (value === null) continue;
      const key = toLabel(row[spec.x]);
      const bucket = byCategory.get(key);
      if (bucket === undefined) byCategory.set(key, [value]);
      else bucket.push(value);
    }
    const summaries = categories.map((category) => boxSummary(byCategory.get(category) ?? []));
    if (summaries.every((summary) => summary === null)) return { option: emptyOption(spec, layout), height };
    // 离群点单独画：echarts 的 boxplot 只画箱与须，不画点。
    const outliers: [number, number][] = [];
    summaries.forEach((summary, index) => {
      for (const value of summary?.outliers ?? []) outliers.push([index, value]);
    });
    return {
      height,
      option: {
        title,
        graphic: footnote(spec.sourceLabel, labelFont),
        grid,
        xAxis: { ...categoryAxis, data: categories },
        yAxis: measureAxis,
        series: [
          {
            type: 'boxplot' as const,
            name: axisName(spec.valueLabel, spec.unit) ?? 'value',
            // echarts 的箱线数据是 [min, Q1, median, Q3, max]。
            data: summaries.map((summary) => (summary === null ? null : [summary.min, summary.q1, summary.median, summary.q3, summary.max])),
            itemStyle: { color: pick(0), borderColor: pick(0) },
            boxWidth: ['20%', '45%'],
          },
          {
            type: 'scatter' as const,
            name: '离群点',
            data: outliers,
            symbolSize: 5,
            itemStyle: { color: NEGATIVE_COLOR },
          },
        ],
      },
    };
  }

  // 矩阵：两个类别维度加一个数值维度，数值映射成颜色深浅。它是"分组柱"的另一种画法，
  // 数据形状完全一样（行 = 类别 + 分组 + 数值），只是用颜色代替了柱高。
  if (spec.kind === 'heatmap') {
    const yNames = seriesNames;
    const cells: Array<[number, number, number]> = [];
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    categories.forEach((category, xi) => {
      yNames.forEach((name, yi) => {
        const value = points.get(name)?.get(category);
        if (value === undefined) return;
        cells.push([xi, yi, value]);
        min = Math.min(min, value);
        max = Math.max(max, value);
      });
    });
    if (cells.length === 0) return { option: emptyOption(spec, layout), height };
    // 只有一个取值时色阶没有跨度：把区间撑开半格，免得色标除零。
    const span = max - min;
    const floor = span === 0 ? min - 0.5 : min;
    const ceiling = span === 0 ? max + 0.5 : max;
    // 格子少时默认写出数值：矩阵本来就可以当表格读。挤的时候得关掉，否则一片糊。
    const showCellLabels = spec.style?.labels ?? cells.length <= 30;
    const ramp = rampStops(spec.style?.colors);
    const data = cells.map((value) => {
      if (!showCellLabels) return value;
      // 数字用深色还是浅色，要看它脚下那格的实际底色——算出来再挑对比度更高的一边。
      const t = (value[2] - floor) / (ceiling - floor);
      return { value, label: { color: readableOn(rampAt(ramp, t)) } };
    });
    return {
      height,
      option: {
        title,
        graphic: footnote(spec.sourceLabel, labelFont),
        // 纵轴是分组（可能是设备名或日期），左边留得比柱状图宽一些；底部留给颜色标尺。
        grid: { ...grid, left: 118, top: spec.title === null ? 24 : 56, bottom: 62 },
        xAxis: { ...categoryAxis, data: categories },
        yAxis: { ...categoryAxis, data: yNames, axisLabel: { fontSize: labelFont, color: '#1c2b3a', rotate: 0 } },
        visualMap: {
          type: 'continuous' as const,
          min: floor,
          max: ceiling,
          calculable: false,
          orient: 'horizontal' as const,
          left: 'center',
          bottom: 4,
          // 横向色标里 itemHeight 才是长度，itemWidth 是厚度。
          itemWidth: 12,
          itemHeight: 120,
          // 标尺两端写数据里真实的最小 / 最大值——跨度为零时上下限是撑开过的，别把撑开的那两个数写上去。
          text: [short(max), short(min)],
          textStyle: { fontSize: Math.max(9, labelFont - 1), color: '#5b6b7c' },
          inRange: { color: ramp },
        },
        series: [{
          type: 'heatmap' as const,
          data,
          label: { show: showCellLabels, fontSize: Math.max(9, labelFont - 2) },
          // 格子之间留一道白缝，邻格的深浅才分得开。
          itemStyle: { borderColor: '#ffffff', borderWidth: 1 },
        }],
      },
    };
  }

  // 雷达：一圈指标轴，每个对象一条闭合折线。它也是"行 = 指标 + 对象 + 数值"这份三元组，
  // 与分组柱同源——只是把"每个对象在每个指标上"画成了形状而不是长度。
  if (spec.kind === 'radar') {
    const indicator = categories.map((category) => {
      const values = seriesNames
        .map((name) => points.get(name)?.get(category))
        .filter((value): value is number => value !== undefined);
      const peak = values.length === 0 ? 0 : Math.max(...values);
      const low = values.length === 0 ? 0 : Math.min(...values);
      // 每个指标一根自己的量纲：共用一根的话，"端口数"会把"可用率百分比"压成圆心的一团。
      return { name: category, max: niceMax(peak), ...(low < 0 ? { min: -niceMax(-low) } : {}) };
    });
    // 缺值留 null（断开这一段），不补 0——补 0 会伪造出一个"这一维为零"的形状。
    const data = seriesNames.map((name, index) => ({
      name: name === '' ? axisName(spec.valueLabel, spec.unit) ?? 'value' : name,
      value: categories.map((category) => points.get(name)?.get(category) ?? null),
      itemStyle: { color: pick(index) },
      lineStyle: { width: 2, color: darken(pick(index)) },
      areaStyle: { color: pick(index), opacity: 0.12 },
      label: showLabels
        ? { show: true, fontSize: Math.max(9, labelFont - 2), color: '#3d4d5c' }
        : undefined,
      symbolSize: 4,
    }));
    return {
      height,
      option: {
        title,
        legend,
        graphic: footnote(spec.sourceLabel, labelFont),
        radar: {
          center: ['50%', spec.title === null ? '54%' : '57%'],
          radius: '64%',
          indicator,
          axisName: { fontSize: labelFont, color: '#5b6b7c' },
          // 圈数就是雷达的刻度档数，太密会糊成一团蛛网。
          splitNumber: Math.max(2, Math.min(layout.tickCount, 6)),
          axisLine: { lineStyle: { color: '#d8e0ea' } },
          splitLine: { lineStyle: { color: '#eef2f7' } },
          splitArea: { show: false },
        },
        series: [{ type: 'radar' as const, data }],
      },
    };
  }

  // 第二个度量：独立的右侧数值轴。它存在的前提就是"两个量纲差很远"，所以轴必须分开。
  // 取值按类别取第一行——有 series 时，第二维度不该随分组变化。
  const second = spec.second ?? null;
  const firstRowByCategory = new Map<string, Row>();
  for (const row of rows) {
    const key = toLabel(row[spec.x]);
    if (!firstRowByCategory.has(key)) firstRowByCategory.set(key, row);
  }
  const secondName = second === null ? null : axisName(second.label ?? second.value, second.unit ?? null) ?? second.value;
  // 横条图的数值在 x 轴上：第二个度量与它的轴都要跟着换边（轴在上方，不从左边抢位置）。
  const secondAxis = second === null || secondName === null ? null : {
    ...measureAxis,
    name: secondName,
    // 第二个度量总是折线，所以它的轴也按数据收紧——主轴是柱（从 0 起）时它照样收紧。
    ...(fitRange ? {} : { scale: true, boundaryGap: [0.08, 0.08] }),
    position: horizontal ? ('top' as const) : ('right' as const),
    splitLine: { show: false },
  };
  const secondSeries = second === null || secondName === null ? null : {
    type: 'line' as const,
    name: secondName,
    ...(horizontal ? { xAxisIndex: 1 } : { yAxisIndex: 1 }),
    smooth: false,
    symbol: 'circle',
    symbolSize: 6,
    connectNulls: false,
    lineStyle: { width: 2, color: pick(seriesNames.length) },
    itemStyle: { color: pick(seriesNames.length) },
    // 时间轴时同样要以 [时间, 值] 给出，echarts 才会按时间排布。
    data: spec.xType === 'time' && (spec.kind === 'line' || spec.kind === 'area')
      ? categories
        .map((category) => [category, toNumber(firstRowByCategory.get(category)?.[second.value])] as [string, number | null])
        .filter((pair) => pair[1] !== null)
      : categories.map((category) => toNumber(firstRowByCategory.get(category)?.[second.value])),
  };

  // 参考线 / 阈值线：挂在主轴的第一条 series 上。只画线加标签，不做区域填充。
  const markLine = spec.marks === undefined || spec.marks.length === 0 ? undefined : {
    silent: true,
    symbol: 'none' as const,
    lineStyle: { color: '#c0567a', type: 'dashed' as const, width: 1.5 },
    label: { fontSize: labelFont, color: '#c0567a' },
    // `axis` 说的是"画在哪根角色轴上"：默认 y 表示数值轴（阈值），x 表示类别轴。
    // 横条图的数值轴是 x，所以要按图元的朝向换过来——否则阈值线会静默不画。
    data: spec.marks.map((mark) => {
      const onCategory = mark.axis === 'x';
      const target = horizontal
        ? (onCategory ? 'yAxis' : 'xAxis')
        : (onCategory ? 'xAxis' : 'yAxis');
      return { [target]: mark.value, label: { formatter: mark.label ?? String(mark.value) } };
    }),
  };

  const allSeries: Record<string, unknown>[] = secondSeries === null ? [...series] : [...series, secondSeries];
  if (markLine !== undefined && allSeries.length > 0) allSeries[0].markLine = markLine;

  const yAxis = horizontal
    ? categoryAxis
    : (secondAxis === null ? measureAxis : [measureAxis, secondAxis]);
  const xAxis = horizontal && secondAxis !== null ? [baseXAxis, secondAxis] : baseXAxis;

  return {
    height,
    option: {
      title,
      legend,
      graphic: footnote(spec.sourceLabel, labelFont),
      // 右侧多了数值轴，留出位置。
      grid: secondAxis === null ? grid : { ...grid, right: 56 },
      xAxis,
      yAxis,
      // 时间轴时数据要以 [时间, 值] 形式给出，echarts 才会按时间排布。
      // 值必须取**已经算好的那一份**（stack: 'percent' 时它就是归一化结果）——回到原始行再取一次
      // 会把归一化丢掉，堆叠的总和线于是一路爬出绘图区、看起来像"图被截断"。
      series: (spec.kind === 'line' || spec.kind === 'area') && spec.xType === 'time'
        ? allSeries.map((item, index) => {
          if (index >= series.length) return item;
          const values = (item as { data?: (number | null)[] }).data ?? [];
          return {
            ...item,
            data: categories
              .map((category, i) => [category, values[i] ?? null] as [string, number | null])
              .filter((pair) => pair[1] !== null),
          };
        })
        : allSeries,
    },
  };
};
