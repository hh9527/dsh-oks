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
  resolveLayout,
  toLabel,
  toNumber,
  valueAxisLabel,
  type LayoutOverrides,
  type MarkLine,
  type Row,
  type SecondMetric,
  type StyleOverrides,
} from './shared.ts';
import type { EChartsCoreOption } from 'echarts/core';

/** 图表的输出尺寸（px）。echarts 的 SSR 不做自适应，宽高必须在初始化时给定。 */
export const CHART_WIDTH = PAGE_WIDTH;

/** 测得的绘图区高度：竖条 / 折线 / 面积为固定值，横条按行数算，饼图为方框边长。 */
export const plotHeight = (kind: string, categoryCount: number, labelFont: number, overrides: LayoutOverrides): number => {
  const rowHeight = Math.max(overrides.rowHeight ?? 26, Math.round(labelFont * 1.8));
  const fallback = kind === 'bar' ? Math.round(60 + categoryCount * rowHeight) : kind === 'pie' ? 300 : 340;
  return overrides.height ?? fallback;
};

/** 一次渲染要用的全部输入。字段分三层：语义（这份数据是什么）、表达开关（怎么表达）、排版。 */
export interface OptionInput {
  kind: 'bar' | 'column' | 'line' | 'pie' | 'area' | 'scatter';
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
 * 五种图元共用同一套规则：色板按序列轮转、负值用区分色、空序列跳过、类别密度决定标签斜排。
 */
export const buildOption = (rows: readonly Row[], spec: OptionInput): { option: EChartsCoreOption; height: number } => {
  const { categories, seriesNames, points } = group(rows, spec);
  const labelFont = spec.layout?.labelFont ?? labelFontSize(categories);
  const layout = resolveLayout({
    categories,
    overrides: spec.layout ?? {},
    defaultHeight: 340,
  });
  const height = plotHeight(spec.kind, categories.length, labelFont, spec.layout ?? {});

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
  const stack = spec.kind === 'column' || spec.kind === 'area' ? spec.stack : undefined;

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

  const measureAxis = {
    type: 'value' as const,
    name: axisName(spec.valueLabel, spec.unit),
    nameLocation: 'middle' as const,
    nameGap: 48,
    nameTextStyle: { fontSize: labelFont, color: '#5b6b7c' },
    // 百分比堆叠时数据已经归一化到 100，轴上标成百分比。
    axisLabel: stack === 'percent'
      ? { fontSize: labelFont, color: '#1c2b3a', formatter: '{value}%' }
      : { fontSize: labelFont, color: '#1c2b3a' },
    ...(stack === 'percent' ? { max: 100 } : {}),
    // 让上界至少盖住参考线。echarts 的 max 接受函数，入参是它自己算出的边界。
    ...(stack !== 'percent' && markMax !== null
      ? { max: (bounds: { max: number }) => Math.max(bounds.max, markMax) }
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
        lineStyle: { width: 2, color },
        areaStyle: spec.kind === 'area' ? { color, opacity: stack === undefined ? 0.18 : 0.7 } : undefined,
      };
    }
    return { ...base, type: 'bar' as const, barMaxWidth: horizontal ? 18 : 28, barGap: stack === undefined ? '12%' : '0%' };
  });

  // x 轴：横条图是数值轴（第二维度就挂在它旁边），其余是类别轴或时间轴。
  const baseXAxis = horizontal ? measureAxis : (spec.kind === 'line' || spec.kind === 'area') && spec.xType === 'time'
    ? { ...categoryAxis, type: 'time' as const, data: undefined }
    : categoryAxis;

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
      series: (spec.kind === 'line' || spec.kind === 'area') && spec.xType === 'time'
        ? allSeries.map((item, index) => {
          if (index >= series.length) return item;
          const bucket = points.get(seriesNames[index]) ?? new Map<string, number>();
          const rows2 = rows
            .filter((row) => (spec.series === null ? true : toLabel(row[spec.series]) === seriesNames[index]))
            .map((row) => [toLabel(row[spec.x]), toNumber(row[spec.value])] as [string, number | null])
            .filter((pair) => pair[1] !== null);
          return { ...item, data: rows2 };
        })
        : allSeries,
    },
  };
};
