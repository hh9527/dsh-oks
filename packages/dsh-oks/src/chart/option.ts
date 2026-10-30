/** 呈现规格 → echarts option。
 *
 *  这是整条出图链路里"把业务字段与结果行翻译成渲染输入"的那一层。echarts 吃的是 JSON，
 *  所以规格本身就是渲染输入的形状——不需要先生成一门中间语言。
 *
 *  译者只做映射，不做判断：哪些序列要画、配色怎么轮、空数据怎么办，都由这里与调用方共享的规则决定。
 */
import {
  ENTITY_COLORS,
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
  x: string;
  value: string;
  series: string | null;
  xType: 'number' | 'time' | null;
  xLabel: string | null;
  valueLabel: string | null;
  unit: string | null;
  /** 图元专属：column / area 的堆叠方式。total 是绝对量、percent 是各组占比。 */
  stack?: 'total' | 'percent' | null;
  donut?: boolean | null;
  /** 图元专属：line / area 的缺失点连不连成直线；不写就断开。 */
  connectNulls?: boolean | null;
  /** 颜色跟实体：颜色由名字决定，同一个实体跨图同色。 */
  entityColor?: boolean | null;
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
});

/** 名字到色板的落点：同一串文字每次都得到同一个数（FNV-1a，跨运行、跨机器都一样）。 */
const hashName = (name: string): number => {
  let hash = 2166136261;
  for (const char of name) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash;
};

/**
 * 规格 + 结果行 → echarts option。
 * 所有图元共用同一套规则：色板按序列轮转、负值用区分色、空序列跳过、类别密度决定标签斜排。
 */
export const buildOption = (
  rows: readonly Row[],
  spec: OptionInput,
  nodes: readonly Row[] | undefined = undefined,
): { option: EChartsCoreOption; height: number } => {
  // 桑基图：行是**边**——`x` 起点、`series` 终点、`value` 权重（不填时每条边计 1）。
  // 布局由 echarts 从 DAG 自己分层，作者不给层级。它与别的图元不同，先于通用分组处理。
  if (spec.kind === 'sankey') {
    const layout = resolveLayout({ categories: [], overrides: spec.layout ?? {}, defaultHeight: 340 });
    const title = spec.title === null ? undefined : {
      text: spec.title,
      left: 'center' as const,
      textStyle: { fontSize: layout.titleFont, fontWeight: 'bold' as const, color: '#1c2b3a' },
    };
    const weights = spec.style?.colors !== undefined && spec.style.colors.length > 0 ? spec.style.colors : SERIES_COLORS;
    const links = new Map<string, { source: string; target: string; value: number }>();
    const nodes: Array<{ name: string; itemStyle?: { color: string } }> = [];
    const seen = new Set<string>();
    for (const row of rows) {
      const source = toLabel(row[spec.x]);
      const target = spec.series === null ? '' : toLabel(row[spec.series]);
      // 自环、空节点与不成对的边不进图：sankey 不接受它们。
      if (source === '' || target === '' || source === target) continue;
      const weight = spec.value === '' ? 1 : toNumber(row[spec.value]);
      if (weight === null || weight <= 0) continue;
      const key = `${source}\u0000${target}`;
      const existing = links.get(key);
      // 同一对起终点出现多次 → 累加合并（echarts 的 sankey 不接受重复 link）。
      if (existing === undefined) links.set(key, { source, target, value: weight });
      else existing.value += weight;
      for (const name of [source, target]) {
        if (seen.has(name)) continue;
        seen.add(name);
        nodes.push({ name, itemStyle: { color: weights[nodes.length % weights.length]! } });
      }
    }
    if (links.size === 0) {
      return { option: emptyOption(spec, layout), height: 240 };
    }
    return {
      option: {
        title,
        series: [{
          type: 'sankey',
          data: nodes,
          links: [...links.values()],
          nodeAlign: 'justify',
          // 标题占着顶部中间，而中间层的节点标签正好落在那里——给它留出上边距，别叠在一起。
          top: spec.title === null ? 10 : 48,
          bottom: 26,
          nodeWidth: 14,
          nodeGap: 12,
          // 标签压在色带上很难读：加一圈白色描边，色带再淡一点。
          label: {
            fontSize: layout.labelFont,
            color: '#1c2b3a',
            textBorderColor: '#ffffff',
            textBorderWidth: 3,
          },
          itemStyle: { borderWidth: 0 },
          lineStyle: { color: 'gradient', opacity: 0.28, curveness: 0.5 },
        }],
      } as EChartsCoreOption,
      // 高度按节点数走：每个节点给它一个可读的竖直位置。
      height: Math.max(240, Math.round(120 + nodes.length * Math.max(18, Math.round(layout.labelFont * 1.6)))),
    };
  }

  // 仪表盘：行是"一张小仪表"——`x` 名称、`value` 值。v1 限定比率型：值按 0–100 读，
  // 超出范围明确报错（宁可失败，也不画一张假装合格的图）。同样先于通用分组处理。
  if (spec.kind === 'gauge') {
    const layout = resolveLayout({ categories: [], overrides: spec.layout ?? {}, defaultHeight: 340 });
    const title = spec.title === null ? undefined : {
      text: spec.title,
      left: 'center' as const,
      textStyle: { fontSize: layout.titleFont, fontWeight: 'bold' as const, color: '#1c2b3a' },
    };
    const palette = spec.style?.colors !== undefined && spec.style.colors.length > 0 ? spec.style.colors : SERIES_COLORS;
    const items: Array<{ name: string; value: number }> = [];
    for (const row of rows) {
      const name = toLabel(row[spec.x]);
      const value = spec.value === '' ? null : toNumber(row[spec.value]);
      if (name === '' || value === null) continue;
      if (value < 0 || value > 100) {
        throw new Error(`gauge 是比率型：值要在 0–100 之间，这里是 ${value}（${name}）。`
          + '要让计数看起来像仪表，先在加工里换算成占比；或者改用 bar / column 这类量值图。');
      }
      items.push({ name, value });
    }
    if (items.length === 0) return { option: emptyOption(spec, layout), height: 200 };
    const perRow = Math.min(items.length, 4);
    const gaugeRows = Math.ceil(items.length / perRow);
    // 按**像素**摆位：画布宽度是固定的、高度是我们算的。用百分比时 echarts 会按 min(宽,高) 折算，
    // 一张仪表会缩成一小撮、四周全是空白（真机上就是这样）。
    const cellWidth = CHART_WIDTH / perRow;
    const cellHeight = 140;
    // 标题占着顶部中间——不给它留位置，第一行仪表就会被压住（真机上就是这样）。
    const titleGap = spec.title === null ? 0 : 34;
    const radius = Math.min(cellWidth, cellHeight) * 0.4;
    const series = items.map((item, index) => {
      const column = index % perRow;
      const row = Math.floor(index / perRow);
      const centerX = cellWidth * (column + 0.5);
      const centerY = titleGap + cellHeight * (row + 0.5);
      const color = palette[index % palette.length]!;
      // marks 在仪表上是阈值：刻度值之前是正常色，之后转警戒色。
      const stops = (spec.marks ?? [])
        .map((mark) => toNumber((mark as { value?: unknown }).value))
        .filter((value): value is number => value !== null && value > 0 && value < 100)
        .sort((a, b) => a - b);
      const axisColors: Array<[number, string]> = [[0, '#4aa96c']];
      for (const stop of stops) axisColors.push([stop / 100, '#c0567a']);
      axisColors.push([1, '#c0567a']);
      return {
        type: 'gauge',
        center: [centerX, centerY],
        radius,
        min: 0,
        max: 100,
        startAngle: 210,
        endAngle: -30,
        axisLine: stops.length === 0
          ? { lineStyle: { width: 10 } }
          : { lineStyle: { width: 10, color: axisColors } },
        axisTick: { show: false },
        splitLine: { length: 8, lineStyle: { width: 1 } },
        axisLabel: { show: items.length <= 2, fontSize: Math.max(8, layout.labelFont - 3) },
        pointer: { width: 4, length: '60%' },
        progress: { show: true, width: 10, itemStyle: { color } },
        title: { fontSize: layout.labelFont, color: '#1c2b3a', offsetCenter: [0, '72%'] },
        detail: {
          fontSize: layout.labelFont + 2,
          color: '#1c2b3a',
          formatter: '{value}',
          offsetCenter: [0, '30%'],
        },
        data: [{ value: item.value, name: item.name }],
      };
    });
    return {
      option: { title, series } as EChartsCoreOption,
      height: Math.max(160, titleGap + gaugeRows * cellHeight),
    };
  }

  // 关系图：`x` / `series` 是**边**的两端（与 sankey 同一套列语义），节点来自第二张表（`nodesSrc`）。
  // 布局默认**按 `depth` 列分层**（层号由 Pipeline 计算：拓扑深度、到中心的跳数、网络层级都成）；
  // 节点表同时给了 `x`/`y` 就用给的坐标。力引导不做——排障图两次打开必须一样，随机观感不适合。
  if (spec.kind === 'graph') {
    const layout = resolveLayout({ categories: [], overrides: spec.layout ?? {}, defaultHeight: 340 });
    const title = spec.title === null ? undefined : {
      text: spec.title,
      left: 'center' as const,
      textStyle: { fontSize: layout.titleFont, fontWeight: 'bold' as const, color: '#1c2b3a' },
    };
    const palette = spec.style?.colors !== undefined && spec.style.colors.length > 0 ? spec.style.colors : SERIES_COLORS;
    const titleGap = spec.title === null ? 0 : 34;
    const parsed = (nodes ?? []).map((row) => ({
      id: toLabel(row['id']),
      label: toLabel(row['label'] === undefined ? row['id'] : row['label']),
      depth: toNumber(row['depth']),
      category: toLabel(row['category'] === undefined ? '' : row['category']),
      status: toLabel(row['status'] === undefined ? '' : row['status']),
      given: toNumber(row['x']) !== null && toNumber(row['y']) !== null
        ? { x: toNumber(row['x'])!, y: toNumber(row['y'])! }
        : null,
    })).filter((node) => node.id !== '');
    if (parsed.length === 0) {
      throw new Error('graph 需要节点表：用 nodesSrc 指向一份行数据，每行一个节点，至少给 id 与 depth。');
    }
    // 同 id 只留先出现的那个；分层要的层号缺了就明确报错，不猜。
    const unique = new Map<string, (typeof parsed)[number]>();
    for (const node of parsed) if (!unique.has(node.id)) unique.set(node.id, node);
    const all = [...unique.values()];
    if (all.every((node) => node.given === null)) {
      for (const node of all) {
        if (node.depth === null) {
          throw new Error(`节点 ${node.id} 没有 depth：分层布局要一列层号`
            + '（在加工里算出来——拓扑深度、到某个节点的跳数、网络层级都行）；或者给每个节点 x 与 y 坐标。');
        }
      }
    }
    // 坐标：给了 x/y 就用它；否则按 depth 分列、层内按出现顺序从上到下（确定、可复现）。
    const levels = [...new Set(all.filter((node) => node.given === null).map((node) => node.depth!))].sort((a, b) => a - b);
    const columnGap = Math.max(120, Math.round((CHART_WIDTH - 180) / Math.max(levels.length - 1, 1)));
    const rowGap = Math.max(30, Math.round(layout.labelFont * 2.4));
    const seenInLevel = new Map<number, number>();
    const placed = new Map<string, { x: number; y: number }>();
    for (const node of all) {
      if (node.given !== null) {
        placed.set(node.id, node.given);
        continue;
      }
      const index = seenInLevel.get(node.depth!) ?? 0;
      seenInLevel.set(node.depth!, index + 1);
      placed.set(node.id, { x: 90 + levels.indexOf(node.depth!) * columnGap, y: 40 + index * rowGap });
    }
    const deepest = Math.max(1, ...[...seenInLevel.values()]);
    // 焦点用**数据**表达：节点或边写了 `status: 'focus'` 就强调它、其余退为灰；没有任何焦点时保持原样。
    const focusNodes = new Set(all.filter((node) => node.status === 'focus').map((node) => node.id));
    const anyFocus = focusNodes.size > 0 || rows.some((row) => toLabel(row['status'] ?? '') === 'focus');
    const colorsOfCategories = new Map<string, string>();
    const graphNodes = all.map((node) => {
      const key = node.category === '' ? node.status : node.category;
      if (key !== '' && !colorsOfCategories.has(key)) {
        colorsOfCategories.set(key, palette[colorsOfCategories.size % palette.length]!);
      }
      return {
        name: node.id,
        x: placed.get(node.id)!.x,
        y: placed.get(node.id)!.y,
        symbolSize: focusNodes.has(node.id) ? 26 : anyFocus ? 12 : 18,
        itemStyle: {
          color: anyFocus && !focusNodes.has(node.id)
            ? '#c8d2dc'
            : key === '' ? palette[0]! : colorsOfCategories.get(key)!,
        },
        label: {
          show: true,
          formatter: node.label === '' ? node.id : node.label,
          position: 'bottom' as const,
          fontSize: layout.labelFont,
          color: '#1c2b3a',
          fontWeight: focusNodes.has(node.id) ? 'bold' as const : 'normal' as const,
          textBorderColor: '#ffffff',
          textBorderWidth: 3,
        },
      };
    });
    // 边按「起点 / 终点 / 关系名」去重：同一对节点之间的**不同关系名是信息**，各留一条并用曲率错开；
    // 三样都相同的才合并。关系名取边表的 `label` 列（与节点表同一列名），没有就不写。
    const graphLinks = new Map<string, { source: string; target: string; label: string; focused: boolean }>();
    for (const row of rows) {
      const source = toLabel(row[spec.x]);
      const target = spec.series === null ? '' : toLabel(row[spec.series]);
      if (source === '' || target === '' || source === target) continue;
      if (!placed.has(source) || !placed.has(target)) continue;
      const label = row['label'] === undefined ? '' : toLabel(row['label']);
      const key = `${source}\u0000${target}\u0000${label}`;
      if (!graphLinks.has(key)) {
        graphLinks.set(key, {
          source,
          target,
          label,
          focused: toLabel(row['status'] ?? '') === 'focus',
        });
      }
    }
    if (graphLinks.size === 0) return { option: emptyOption(spec, layout), height: 240 };
    return {
      option: {
        title,
        series: [{
          type: 'graph',
          layout: 'none',
          data: graphNodes,
          links: [...graphLinks.values()].map((link, index) => ({
            ...link,
            // 同一对节点上的第 2、3 条边弯得更明显，免得叠在一起看不出来。
            lineStyle: {
              curveness: 0.08 + (index % 3) * 0.12,
              color: link.focused ? '#5a8cf0' : anyFocus ? '#e4e9ef' : '#b9c6d8',
              width: link.focused ? 2 : 1.2,
            },
          })),
          edgeSymbol: ['none', 'arrow'],
          edgeSymbolSize: 8,
          lineStyle: { color: '#b9c6d8', width: 1.2 },
          // 平行边用曲率错开；关系名写在边上，带白描边压在灰线上也读得清。
          edgeLabel: {
            show: true,
            fontSize: Math.max(9, layout.labelFont - 2),
            color: '#5c6b7a',
            textBorderColor: '#ffffff',
            textBorderWidth: 3,
            formatter: (params: { data?: { label?: string } }) => params.data?.label ?? '',
          },
          label: { fontSize: layout.labelFont, color: '#1c2b3a' },
        }],
      } as EChartsCoreOption,
      height: Math.max(240, titleGap + 80 + deepest * rowGap),
    };
  }

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
  // 断点：缺失点在折线上连成直线还是断开。不写就是断开——缺口是"这段没有数据"，
  // 连起来会读成"这段数据是平的"。
  const connectNulls = supports(spec.kind, 'connectNulls') && spec.connectNulls === true;
  // 颜色跟实体：名字决定颜色，于是同一个机房在饼图与折线图里同色，读者能靠颜色对照。
  // 名字的哈希定落点；同一张图里两个名字撞到同一格时按名字顺序往后顺延，图内就不会出现两个实体同色
  //（名字比色板还多时仍会重复——色板是有限的）。
  const entityColor = supports(spec.kind, 'entityColor') && spec.entityColor === true;
  const colorResolver = (names: readonly string[]): ((name: string, index: number) => string) => {
    if (!entityColor) return (_name, index) => pick(index);
    const byName = spec.style?.colors !== undefined && spec.style.colors.length > 0 ? spec.style.colors : ENTITY_COLORS;
    const taken = new Set<number>();
    const slots = new Map<string, number>();
    for (const name of [...new Set(names)].sort()) {
      let slot = hashName(name) % byName.length;
      while (taken.has(slot)) slot = (slot + 1) % byName.length;
      taken.add(slot);
      slots.set(name, slot);
    }
    // 名字为空的那一条没有实体可跟，退回按序号取色：单序列的图不会因为开了这个开关就换个颜色。
    return (name, index) => (name === '' ? pick(index) : byName[slots.get(name) ?? 0]);
  };

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

  // 饼图：单一序列，数据是"名称 + 数值"，配色按扇区轮转（颜色跟实体时按名字取色）
  if (spec.kind === 'pie') {
    const bucket = points.get(seriesNames[0]) ?? new Map<string, number>();
    const slices = [...bucket.entries()].filter(([, value]) => value > 0);
    const colorAt = colorResolver(slices.map(([name]) => name));
    const data = slices.map(([name, value], index) => ({
      name,
      value,
      itemStyle: { color: colorAt(name, index) },
    }));
    if (data.length === 0) return { option: emptyOption(spec, layout), height };
    return {
      height,
      option: {
        title,
        series: [{
          type: 'pie',
          // 环形：中心留白（`donut` 开关，只有饼图有这个形状）。
          radius: [spec.donut === true ? '45%' : '0%', '68%'],
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
  // 竖着排的类别轴自上而下：第一项在最上面。
  // 名次、清单、矩阵的行，人都是从第一行往下读的——横条图的"第一名"落在最下面，
  // 矩阵的行从下往上排（我们把数值写进格子、说它"同时就是一张表"），两处都说不过去。
  const verticalCategoryAxis = { ...categoryAxis, inverse: true };
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

  const colorAt = colorResolver(seriesNames);
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
    const color = colorAt(name, index);
    const base = {
      name: name === '' ? axisName(spec.valueLabel, spec.unit) ?? 'value' : name,
      data,
      itemStyle: {
        // 负值换区分色：柱状图里正负同轴时更好读。
        color: (params: { value: number | null }) => (params.value !== null && params.value < 0 ? NEGATIVE_COLOR : color),
      },
      connectNulls,
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
        // 纵轴是分组（可能是设备名或日期），左边留得比柱状图宽一些；底部留给颜色标尺。
        grid: { ...grid, left: 118, top: spec.title === null ? 24 : 56, bottom: 62 },
        xAxis: { ...categoryAxis, data: categories },
        yAxis: { ...verticalCategoryAxis, data: yNames, axisLabel: { fontSize: labelFont, color: '#1c2b3a', rotate: 0 } },
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
      itemStyle: { color: colorAt(name, index) },
      lineStyle: { width: 2, color: darken(colorAt(name, index)) },
      areaStyle: { color: colorAt(name, index), opacity: 0.12 },
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
    connectNulls,
    lineStyle: { width: 2, color: pick(seriesNames.length) },
    itemStyle: { color: pick(seriesNames.length) },
    // 时间轴时同样要以 [时间, 值] 给出，echarts 才会按时间排布。缺失的那个点也照样列出
    //（值为 null）——把整条删掉等于说"这段时间不在轴上"，缺口会消失、线会直接跨过去。
    data: spec.xType === 'time' && (spec.kind === 'line' || spec.kind === 'area')
      ? categories
        .map((category) => [category, toNumber(firstRowByCategory.get(category)?.[second.value])] as [string, number | null])
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
    ? verticalCategoryAxis
    : (secondAxis === null ? measureAxis : [measureAxis, secondAxis]);
  const xAxis = horizontal && secondAxis !== null ? [baseXAxis, secondAxis] : baseXAxis;

  return {
    height,
    option: {
      title,
      legend,
      // 右侧多了数值轴，留出位置。
      grid: secondAxis === null ? grid : { ...grid, right: 56 },
      xAxis,
      yAxis,
      // 时间轴时数据要以 [时间, 值] 形式给出，echarts 才会按时间排布。
      // 值必须取**已经算好的那一份**（stack: 'percent' 时它就是归一化结果）——回到原始行再取一次
      // 会把归一化丢掉，堆叠的总和线于是一路爬出绘图区、看起来像"图被截断"。
      // 缺失点（null）留在数组里：断点由 `connectNulls` 决定，不在这一步被抹掉。
      series: (spec.kind === 'line' || spec.kind === 'area') && spec.xType === 'time'
        ? allSeries.map((item, index) => {
          if (index >= series.length) return item;
          const values = (item as { data?: (number | null)[] }).data ?? [];
          return {
            ...item,
            data: categories.map((category, i) => [category, values[i] ?? null] as [string, number | null]),
          };
        })
        : allSeries,
    },
  };
};
