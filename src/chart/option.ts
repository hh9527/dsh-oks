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
  type Row,
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

/** 一次渲染要用的全部输入。 */
export interface OptionInput {
  kind: 'bar' | 'column' | 'line' | 'pie' | 'area';
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
  layout?: LayoutOverrides;
}

const axisName = (label: string | null, unit: string | null): string | undefined => {
  if (label === null) return unit === null ? undefined : unit;
  return unit === null ? label : `${label}（${unit}）`;
};

/** 把结果行按 x 归类，再按 series 分组；返回类别顺序与每个序列的取值。 */
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
  return { categories, seriesNames, points };
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

  // 饼图：单一序列，数据是"名称 + 数值"，配色按扇区轮转。
  if (spec.kind === 'pie') {
    const bucket = points.get(seriesNames[0]) ?? new Map<string, number>();
    const data = [...bucket.entries()]
      .filter(([, value]) => value > 0)
      .map(([name, value], index) => ({
        name,
        value,
        itemStyle: { color: SERIES_COLORS[index % SERIES_COLORS.length] },
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
  const measureAxis = {
    type: 'value' as const,
    name: axisName(spec.valueLabel, spec.unit),
    nameLocation: 'middle' as const,
    nameGap: 48,
    nameTextStyle: { fontSize: labelFont, color: '#5b6b7c' },
    axisLabel: { fontSize: labelFont, color: '#1c2b3a' },
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
    const data = categories.map((category) => bucket.get(category) ?? null);
    const color = SERIES_COLORS[index % SERIES_COLORS.length];
    const base = {
      name: name === '' ? axisName(spec.valueLabel, spec.unit) ?? 'value' : name,
      data,
      itemStyle: {
        // 负值换区分色：柱状图里正负同轴时更好读。
        color: (params: { value: number | null }) => (params.value !== null && params.value < 0 ? NEGATIVE_COLOR : color),
      },
      connectNulls: false,
    };
    if (spec.kind === 'line' || spec.kind === 'area') {
      return {
        ...base,
        type: 'line' as const,
        smooth: false,
        symbol: 'circle',
        symbolSize: 6,
        lineStyle: { width: 2, color },
        areaStyle: spec.kind === 'area' ? { color, opacity: 0.18 } : undefined,
      };
    }
    return { ...base, type: 'bar' as const, barMaxWidth: horizontal ? 18 : 28, barGap: '12%' };
  });

  const xAxis = horizontal ? measureAxis : (spec.kind === 'line' || spec.kind === 'area') && spec.xType === 'time'
    ? { ...categoryAxis, type: 'time' as const, data: undefined }
    : categoryAxis;
  const yAxis = horizontal ? categoryAxis : measureAxis;

  return {
    height,
    option: {
      title,
      legend,
      graphic: footnote(spec.sourceLabel, labelFont),
      grid,
      xAxis,
      yAxis,
      // 时间轴时数据要以 [时间, 值] 形式给出，echarts 才会按时间排布。
      series: (spec.kind === 'line' || spec.kind === 'area') && spec.xType === 'time'
        ? series.map((item, index) => {
          const bucket = points.get(seriesNames[index]) ?? new Map<string, number>();
          const rows2 = rows
            .filter((row) => (spec.series === null ? true : toLabel(row[spec.series]) === seriesNames[index]))
            .map((row) => [toLabel(row[spec.x]), toNumber(row[spec.value])] as [string, number | null])
            .filter((pair) => pair[1] !== null);
          return { ...item, data: rows2 };
        })
        : series,
    },
  };
};
