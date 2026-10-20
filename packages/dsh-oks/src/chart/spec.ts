/** Shared figure specification validation, independent of saved-file and draft entry points. */
import { isRecord } from '../host.ts';
import { CHART_KINDS, inferXType, supportedKinds, supports, toNumber } from './shared.ts';
import type { ChartKind, ExpressionSwitch, LayoutOverrides, MarkLine, SecondMetric, StyleOverrides } from './shared.ts';

export interface ChartSpec {
  donut?: boolean | null;
  /** 图元专属：line / area 的缺失点连成直线还是断开。 */
  connectNulls?: boolean | null;
  /** 颜色跟实体：颜色由名字决定。 */
  entityColor?: boolean | null;
  kind: ChartKind;
  title: string | null;
  x: string;
  value: string;
  series: string | null;
  xType: 'number' | 'time' | null;
  xLabel: string | null;
  valueLabel: string | null;
  unit: string | null;
  /** 图元专属：column / area 的堆叠方式。 */
  stack: 'total' | 'percent' | null;
  /** 图元专属：scatter 的第三维（点大小）。 */
  size: string | null;
  /** 第二个度量：同一张图里再画一条线，带独立的右侧数值轴。 */
  second: SecondMetric | null;
  /** 参考线 / 阈值线。 */
  marks: MarkLine[];
  /** 图元专属：histogram 的箱子数；不填按数据量选。 */
  bins: number | null;
  /** 通用表达开关：排序、数值标签、配色。 */
  style: StyleOverrides;
  layout: LayoutOverrides;
}

/** 图的**显示标题**：agent 给了就用它，没给就按"序列 × 维度 × 度量"造一个——**永不为空**。
 *
 *  它进的是产物的自述（清单里显示的那一行），**不改图的绘制**：图里画不画标题仍由 agent 决定
 *  （`spec.title` 为空时绘图区照旧不留标题位）。列名本身就是维度与度量的名字，所以这段话
 *  不需要任何领域知识；全空时才退回图元名。 */
export const chartTitle = (spec: ChartSpec): string => {
  const given = spec.title === null ? '' : spec.title.trim();
  if (given !== '') return given;
  const parts = [spec.series, spec.x, spec.value]
    .filter((part): part is string => typeof part === 'string' && part.trim() !== '');
  return parts.length > 0 ? parts.join(' × ') : spec.kind;
};

/** 解析并校验排版覆盖项：每一项都可选，给了就必须在合理范围内——
 *  越界的值（比如 4pt 的字）画出来是废图，不如直接报错让 agent 重来。 */
const parseLayout = (raw: unknown): { layout: LayoutOverrides } | { error: string } => {
  if (raw === undefined || raw === null) return { layout: {} };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: 'spec.layout 必须是对象：labelFont / titleFont / height / rowHeight / slantTicks 都可选' };
  }
  const record = raw as Record<string, unknown>;
  const layout: LayoutOverrides = {};
  const bounds: Array<[keyof LayoutOverrides, number, number]> = [
    // 正文字号不需要跟着标题放到那么大：18pt 在 720pt 页宽里已经把绘图区压得很窄了。
    ['labelFont', 8, 18],
    ['titleFont', 8, 32],
    ['height', 200, 2000],
    ['rowHeight', 16, 80],
    ['tickCount', 3, 12],
  ];
  for (const [name, min, max] of bounds) {
    const value = record[name];
    if (value === undefined) continue;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
      return { error: `spec.layout.${name} 要在 ${min}..${max} 之间，收到 ${JSON.stringify(value)}` };
    }
    (layout as Record<string, unknown>)[name] = value;
  }
  if (record.slantTicks !== undefined) {
    if (typeof record.slantTicks !== 'boolean') {
      return { error: `spec.layout.slantTicks 必须是 true 或 false，收到 ${JSON.stringify(record.slantTicks)}` };
    }
    layout.slantTicks = record.slantTicks;
  }
  const unknown = Object.keys(record).filter((key) => !['labelFont', 'titleFont', 'height', 'rowHeight', 'slantTicks', 'tickCount'].includes(key));
  if (unknown.length > 0) {
    // agent 常把表达开关写进排版参数：直接告诉它该放哪，比让它再猜一次好。
    const misplaced = unknown.filter((key) => EXPRESSION_KEYS.includes(key));
    const where = misplaced.length > 0
      ? `。${misplaced.join(' / ')} 属于 spec.style（表达开关）`
      : '（layout 只管排版：labelFont / titleFont / height / rowHeight / slantTicks / tickCount）';
    return { error: `spec.layout 里不认识的项：${unknown.join(', ')}${where}` };
  }
  return { layout };
};

/** 解析表格规格：`columns` 选列与顺序，`title` 是表注。
 *  展示哪一份数据由入参顶层的 `src` 给——与图共用同一个字段。 */
export const parseTableSpec = (spec: Record<string, unknown>): { title: string | null; columns: string[] | null } => ({
  title: typeof spec.title === 'string' && spec.title.trim() !== '' ? spec.title.trim() : null,
  columns: Array.isArray(spec.columns)
    ? spec.columns.filter((name): name is string => typeof name === 'string' && name !== '')
    : null,
});

export const CHART_STACKS = ['total', 'percent'] as const;
/** 类别排序：默认沿用数据顺序。 */
export const CHART_SORTS = ['none', 'desc', 'asc'] as const;
/** data 路径的规模上限：更大的数据应当先查询，再把回执里的 asset 当 src 引用。 */

/** 规格里引用的列（含图元专属字段指向的列）。
 *  render_figure 与报告里的图共用这一份，否则会出现"工具接受、报告里报错"的半边差异。 */
const referencedColumns = (spec: ChartSpec): string[] =>
  [spec.x, spec.value, spec.series, spec.size, spec.second?.value ?? null]
    // 空字符串表示"这个图元不需要这一项"（如 histogram 没有 x），不该被当成一个列名去核对。
    .filter((name): name is string => typeof name === 'string' && name !== '');

/** 数据里缺了哪些被引用的列。空数据没有列可校验，也不该因此报错——空结果照样出一张空图。 */
export const missingColumns = (spec: ChartSpec, columns: readonly string[], rowCount: number): string[] =>
  rowCount === 0 ? [] : referencedColumns(spec).filter((name) => !columns.includes(name));

/** 开关填给了不支持的图元：按共享的适用表报错，表在 shared.ts 里只有一份。
 *  在这里再枚一遍图元，就会出现"报错说能用、渲染层不认"这种两边不一致。 */
const unsupported = (name: ExpressionSwitch, kind: string): string =>
  `spec.${name} 只对 ${supportedKinds(name).join(' / ')} 有意义（${kind} 用不上它）`;

/** 解析第二个度量。它就是"同一张图里的另一条线 + 一个独立的右侧数值轴"，
 *  存在的意义是两个量纲差很远的东西能放一起对照。目前只开折线。 */
const parseSecond = (raw: unknown, kind: ChartKind): { second: SecondMetric | null } | { error: string } => {
  if (raw === undefined || raw === null) return { second: null };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: 'spec.second 必须是对象：value 必填（第二个度量的列名），可选 kind / label / unit' };
  }
  if (!supports(kind, 'second')) return { error: unsupported('second', kind) };
  const record = raw as Record<string, unknown>;
  if (record.kind !== undefined && record.kind !== 'line') {
    return { error: `spec.second.kind 目前只支持 "line"，收到 ${JSON.stringify(record.kind)}` };
  }
  if (typeof record.value !== 'string' || record.value.length === 0) {
    return { error: 'spec.second 需要 value（第二个度量的列名）' };
  }
  const unknown = Object.keys(record).filter((key) => !['value', 'kind', 'label', 'unit'].includes(key));
  if (unknown.length > 0) return { error: `spec.second 里不认识的项：${unknown.join(', ')}`
    + '（second 收的字段是 value / kind / label / unit）' };
  return {
    second: {
      value: record.value,
      kind: 'line',
      ...(typeof record.label === 'string' && record.label.length > 0 ? { label: record.label } : {}),
      ...(typeof record.unit === 'string' && record.unit.length > 0 ? { unit: record.unit } : {}),
    },
  };
};

/** 解析参考线 / 阈值线：数值轴上的阈值（axis 默认 y），或类别轴上的一次事件（axis: "x"）。 */
const parseMarks = (raw: unknown, kind: ChartKind): { marks: MarkLine[] } | { error: string } => {
  if (raw === undefined || raw === null) return { marks: [] };
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 12) {
    return { error: 'spec.marks 必须是 1–12 条参考线的数组' };
  }
  if (!supports(kind, 'marks')) return { error: unsupported('marks', kind) };
  const marks: MarkLine[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      return { error: 'spec.marks 的每一项都要是对象：value、可选的 label 与 axis' };
    }
    const record = item as Record<string, unknown>;
    if (typeof record.value !== 'number' && typeof record.value !== 'string') {
      return { error: `spec.marks 的 value 必须是数字或类别名，收到 ${JSON.stringify(record.value)}` };
    }
    if (record.axis !== undefined && record.axis !== 'x' && record.axis !== 'y') {
      return { error: `spec.marks 的 axis 只能是 x 或 y，收到 ${JSON.stringify(record.axis)}` };
    }
    const unknown = Object.keys(record).filter((key) => !['value', 'label', 'axis'].includes(key));
    if (unknown.length > 0) return { error: `spec.marks 的项里不认识的字段：${unknown.join(', ')}` };
    marks.push({
      value: record.value,
      ...(typeof record.label === 'string' && record.label.length > 0 ? { label: record.label } : {}),
      axis: record.axis === 'x' ? 'x' : 'y',
    });
  }
  return { marks };
};

/** 两层的键名清单：agent 放错层时，报错要能指出正确的位置。 */
const EXPRESSION_KEYS = ['sort', 'labels', 'colors', 'stack', 'size', 'bins', 'second', 'marks'];
const LAYOUT_KEYS = ['labelFont', 'titleFont', 'height', 'rowHeight', 'slantTicks', 'tickCount'];

/** 解析并校验通用表达开关：每一项都可选，给了就必须在合理范围内。
 *  越界的值画出来是废图，不如直接报错让 agent 重来。 */
const parseStyle = (raw: unknown): { style: StyleOverrides } | { error: string } => {
  if (raw === undefined || raw === null) return { style: {} };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: 'spec.style 必须是对象：sort / labels / colors 都可选' };
  }
  const record = raw as Record<string, unknown>;
  const style: StyleOverrides = {};
  if (record.sort !== undefined) {
    if (!(CHART_SORTS as readonly unknown[]).includes(record.sort)) {
      return { error: `spec.style.sort 必须是 ${CHART_SORTS.join(' / ')} 之一，收到 ${JSON.stringify(record.sort)}` };
    }
    style.sort = record.sort as StyleOverrides['sort'];
  }
  if (record.labels !== undefined) {
    if (typeof record.labels !== 'boolean') {
      return { error: `spec.style.labels 必须是 true 或 false，收到 ${JSON.stringify(record.labels)}` };
    }
    style.labels = record.labels;
  }
  if (record.colors !== undefined) {
    if (!Array.isArray(record.colors) || record.colors.length === 0 || record.colors.length > 12) {
      return { error: 'spec.style.colors 必须是 1–12 个颜色字符串的数组' };
    }
    for (const color of record.colors) {
      if (typeof color !== 'string' || !/^#[0-9a-fA-F]{3,8}$/.test(color)) {
        return { error: `spec.style.colors 只接受 #rrggbb 这类颜色值，收到 ${JSON.stringify(color)}` };
      }
    }
    style.colors = record.colors as string[];
  }
  const unknown = Object.keys(record).filter((key) => !['sort', 'labels', 'colors'].includes(key));
  if (unknown.length > 0) {
    const misplaced = unknown.filter((key) => LAYOUT_KEYS.includes(key));
    const where = misplaced.length > 0
      ? `。${misplaced.join(' / ')} 属于 spec.layout（排版参数）`
      : '（style 只管表达：sort / labels / colors）';
    return { error: `spec.style 里不认识的项：${unknown.join(', ')}${where}` };
  }
  return { style };
};

/** 校验图表规格；只做形状与必填，不解释领域含义。 */
export const parseChartSpec = (raw: unknown): { spec: ChartSpec } | { error: string } => {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: 'render_figure 需要 spec（对象）：kind 必填——"table" 出表，其余图元出图' };
  }
  const record = raw as Record<string, unknown>;
  const kind = record.kind;
  if (typeof kind !== 'string' || !(CHART_KINDS as readonly string[]).includes(kind)) {
    return { error: `spec.kind 必须是 ${CHART_KINDS.join(' / ')} 之一，收到 ${JSON.stringify(kind)}` };
  }
  const text = (name: string): string | null => {
    const value = record[name];
    return typeof value === 'string' && value.length > 0 ? value : null;
  };
  const spec: ChartSpec = {
    kind: kind as ChartSpec['kind'],
    title: text('title'),
    x: text('x') ?? '',
    value: text('value') ?? '',
    series: text('series'),
    xType: record.xType === 'number' || record.xType === 'time' ? record.xType : null,
    xLabel: text('xLabel'),
    valueLabel: text('valueLabel'),
    unit: text('unit'),
    stack: null,
    size: text('size'),
    second: null,
    marks: [],
    bins: null,
    style: {},
    layout: {},
  };
  const parsedLayout = parseLayout(record.layout);
  if ('error' in parsedLayout) return { error: parsedLayout.error };
  spec.layout = parsedLayout.layout;
  const parsedStyle = parseStyle(record.style);
  if ('error' in parsedStyle) return { error: parsedStyle.error };
  spec.style = parsedStyle.style;
  const parsedSecond = parseSecond(record.second, spec.kind);
  if ('error' in parsedSecond) return { error: parsedSecond.error };
  spec.second = parsedSecond.second;
  const parsedMarks = parseMarks(record.marks, spec.kind);
  if ('error' in parsedMarks) return { error: parsedMarks.error };
  spec.marks = parsedMarks.marks;
  // 图元专属字段：填给不支持的图元时直接报错，不静默忽略——agent 需要知道这个开关在这张图上没意义。
  if (record.stack !== undefined && record.stack !== null) {
    if (!(CHART_STACKS as readonly unknown[]).includes(record.stack)) {
      return { error: `spec.stack 必须是 ${CHART_STACKS.join(' / ')} 之一，收到 ${JSON.stringify(record.stack)}` };
    }
    if (!supports(spec.kind, 'stack')) return { error: unsupported('stack', spec.kind) };
    spec.stack = record.stack as ChartSpec['stack'];
  }
  if (record.bins !== undefined && record.bins !== null) {
    if (typeof record.bins !== 'number' || !Number.isInteger(record.bins) || record.bins < 1 || record.bins > 200) {
      return { error: `spec.bins 必须是 1–200 的整数，收到 ${JSON.stringify(record.bins)}` };
    }
    if (!supports(spec.kind, 'bins')) return { error: unsupported('bins', spec.kind) };
    spec.bins = record.bins;
  }
  if (record.donut !== undefined && record.donut !== null) {
    if (typeof record.donut !== 'boolean') {
      return { error: `spec.donut 是 true / false，收到 ${JSON.stringify(record.donut)}` };
    }
    if (!supports(spec.kind, 'donut')) return { error: unsupported('donut', spec.kind) };
    spec.donut = record.donut;
  }
  if (record.connectNulls !== undefined && record.connectNulls !== null) {
    if (typeof record.connectNulls !== 'boolean') {
      return { error: `spec.connectNulls 是 true / false，收到 ${JSON.stringify(record.connectNulls)}` };
    }
    if (!supports(spec.kind, 'connectNulls')) return { error: unsupported('connectNulls', spec.kind) };
    spec.connectNulls = record.connectNulls;
  }
  if (record.entityColor !== undefined && record.entityColor !== null) {
    if (typeof record.entityColor !== 'boolean') {
      return { error: `spec.entityColor 是 true / false，收到 ${JSON.stringify(record.entityColor)}` };
    }
    if (!supports(spec.kind, 'entityColor')) return { error: unsupported('entityColor', spec.kind) };
    spec.entityColor = record.entityColor;
  }
  if (spec.size !== null && !supports(spec.kind, 'size')) return { error: unsupported('size', spec.kind) };
  if (spec.kind === 'histogram' && spec.value === '') {
    return { error: 'histogram 需要 spec.value（要统计分布的那一列数值）' };
  }
  if (spec.kind === 'box') {
    if (spec.x === '' || spec.value === '') {
      return { error: 'box 需要 spec.x（类别列）与 spec.value（数值列）' };
    }
  }
  if (spec.kind === 'scatter' && (spec.x === '' || spec.value === '')) {
    return { error: 'scatter 需要 spec.x 与 spec.value（两个数值列），可选 spec.size（点大小）' };
  }
  // 矩阵与雷达都要"两个类别维度 + 一个数值维度"：一个类别当横轴（矩阵）/ 当指标（雷达），
  // 另一个当纵轴（矩阵）/ 当被比较的对象（雷达）。少了第二个维度形状就不成立，所以这里当必填。
  if (spec.kind === 'gauge' && (spec.x === '' || spec.value === '')) {
    return {
      error: 'gauge 需要 spec.x（每张仪表的名称列）与 spec.value（数值列）。它是比率型：值按 0–100 读，'
        + '要展示计数就先换算成占比，或者改用 bar / column。',
    };
  }
  if (spec.kind === 'graph' && (spec.x === '' || spec.series === null)) {
    return {
      error: 'graph 需要 spec.x（边的起点列）与 spec.series（边的终点列）；spec.value 可选，'
        + '填的是边的权重列。节点表通过 render_figure 的输入对象 nodes 提供。',
    };
  }
  if (spec.kind === 'sankey' && (spec.x === '' || spec.series === null)) {
    return {
      error: 'sankey 需要 spec.x（边的起点列）与 spec.series（边的终点列）；spec.value 可选，'
        + '填的是边的权重列，不填时每条边计 1。',
    };
  }
  if (spec.kind === 'heatmap' || spec.kind === 'radar') {
    if (spec.x === '' || spec.value === '' || spec.series === null) {
      return {
        error: `${spec.kind} 需要 spec.x（${spec.kind === 'heatmap' ? '横轴类别' : '指标'}）、`
          + `spec.series（${spec.kind === 'heatmap' ? '纵轴类别' : '被比较的对象'}）与 spec.value（数值列）`,
      };
    }
  }
  if (spec.kind === 'bar' && (spec.x === '' || spec.value === '')) {
    return { error: 'bar 需要 spec.x（类别列）与 spec.value（数值列）' };
  }
  if (spec.kind === 'column') {
    // series 可选：给了就是分组柱，不给就是每类一根柱子——后者是"单柱 + 一条线"的常见组合。
    if (spec.x === '' || spec.value === '') {
      return { error: 'column 需要 spec.x（类别列）与 spec.value（数值列）' };
    }
  }
  if (spec.kind === 'pie') {
    if (spec.x === '' || spec.value === '') {
      return { error: 'pie 需要 spec.x（类别列）与 spec.value（数值列）' };
    }
  }
  // line / area 的必填完全相同：同一个约束写两遍，改的时候就会只想起一处
  //（这一波已经因此栽了三次）。合成一条。
  if (spec.kind === 'line' || spec.kind === 'area') {
    if (spec.x === '' || spec.value === '') {
      return { error: `${spec.kind} 需要 spec.x（横轴列）与 spec.value（数值列）` };
    }
  }
  return { spec };
};

/** 折线的前置检查：每行都要有横轴值、每个序列的横轴非递减、数值是有限数值或 null。
 *  （渲染在客户端；这些是规格层面的错，要在工具里就挡掉。） */
/** 给没写 xType 的规格补上推断结果。
 *
 *  原来 line / area 必须显式写 xType，而 column / bar 不用——同一个概念一半要写一半不用写，
 *  agent 每次都要踩一遍。现在改成"可选覆盖"：不写就从这一列的值推断。
 *  返回值说明推断成了什么，好让它出现在回执里（猜错了 agent 看得见）。
 */
export const applyInferredXType = (spec: ChartSpec, rows: readonly Record<string, unknown>[]): 'number' | 'time' | 'category' | null => {
  if (spec.kind !== 'line' && spec.kind !== 'area') return null;
  if (spec.xType !== null) return spec.xType;
  const inferred = inferXType(rows.map((row) => row[spec.x]));
  // 推断成类目时留空：渲染层见到 null 就走类目轴。
  spec.xType = inferred === 'category' ? null : inferred;
  return inferred;
};

const lineProblem = (rows: readonly Record<string, unknown>[], spec: ChartSpec): string | null => {
  const xColumn = spec.x;
  const valueColumn = spec.value;
  // 类目轴（没给 xType，数据也不是数值 / 时间）：顺序由数据本身决定，
  // 既不要求横轴是数值，也不要求递增——类目折线是常见形状。
  if (spec.xType === null) {
    for (const row of rows) {
      const raw = row[xColumn];
      if (raw === null || raw === undefined || raw === '') {
        return `横轴列 ${xColumn} 有空值：折线要求每行都有横轴值`;
      }
    }
    return null;
  }
  const lastX = new Map<string, number>();
  for (const row of rows) {
    const seriesKey = spec.series === null ? '' : String(row[spec.series] ?? '');
    const rawX = row[xColumn];
    if (rawX === null || rawX === undefined || rawX === '') {
      return `横轴列 ${xColumn} 有空值：折线要求每行都有横轴值`;
    }
    const x = spec.xType === 'time' ? toEpochMillis(rawX) : Number(rawX);
    if (x === null || !Number.isFinite(x)) {
      return `横轴列 ${xColumn} 的值 ${JSON.stringify(rawX)} 不是有效的`
        + `${spec.xType === 'time' ? '时间（RFC 3339 文本或 epoch 毫秒）' : '数值'}`;
    }
    const previous = lastX.get(seriesKey);
    if (previous !== undefined && x < previous) {
      return `横轴列 ${xColumn} 在序列 ${seriesKey === '' ? '(单序列)' : seriesKey} 里不是非递减的：`
        + `${previous} 之后出现 ${x}`;
    }
    lastX.set(seriesKey, x);
    const rawValue = row[valueColumn];
    if (rawValue !== null && rawValue !== undefined && !Number.isFinite(Number(rawValue))) {
      return `数值列 ${valueColumn} 的值 ${JSON.stringify(rawValue)} 既不是有限数值也不是 null`;
    }
  }
  return null;
};

/** 数据形状不满足图元的要求时报错：规格写对了、数据不对，同样画不出那张图。
 *  render_figure 是唯一的出图入口，这份判断也只此一处。 */
export const shapeProblem = (rows: readonly Record<string, unknown>[], spec: ChartSpec): string | null => {
  if (spec.kind === 'line') return lineProblem(rows, spec);
  if (spec.kind !== 'radar' || rows.length === 0) return null;
  // 雷达的轴就是指标：少于三根轴围不出形状，画出来像一张坏掉的折线。
  const indicators = [...new Set(rows.map((row) => String(row[spec.x] ?? '')))];
  if (indicators.length < 3) {
    return `radar 至少需要 3 个指标（spec.x 的不同取值），这一列只有 ${indicators.length} 个：`
      + '比较两个量用 bar / column，看一组值怎么分布用 box';
  }
  // 到这里 series 一定非空（parseChartSpec 要求的），类型上收一下。
  const seriesColumn = spec.series;
  if (seriesColumn === null) return null;
  // 每个对象在每个指标上都要有值。缺的那个顶点 echarts 会画在圆心，看起来就是"这一维是 0"，
  // 而"没测到"与"就是 0"是两件事——矩阵对缺格留白，雷达没有留白这个选项，所以只能要求补齐。
  const objects = [...new Set(rows.map((row) => String(row[seriesColumn] ?? '')))];
  const measured = new Set<string>();
  for (const row of rows) {
    if (toNumber(row[spec.value]) === null) continue;
    measured.add(`${String(row[seriesColumn] ?? '')}\u0000${String(row[spec.x] ?? '')}`);
  }
  const gaps: string[] = [];
  for (const object of objects) {
    for (const indicator of indicators) {
      if (!measured.has(`${object}\u0000${indicator}`)) gaps.push(`${object} × ${indicator}`);
    }
  }
  if (gaps.length > 0) {
    const shown = gaps.slice(0, 3).join('、');
    return `radar 要求每个对象在每个指标上都有值，缺 ${gaps.length} 处（${shown}${gaps.length > 3 ? ' …' : ''}）：`
      + '缺的顶点会被画在圆心，看起来像"这一维是 0"。要表达 0 就把那一行写进数据，'
      + '否则把指标拆成不同的图，或换 column / heatmap。';
  }
  return null;
};

/** time 横轴的取值：epoch 毫秒原样用，RFC 3339 文本按 Date.parse 换算。 */
const toEpochMillis = (value: unknown): number | null => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
};
