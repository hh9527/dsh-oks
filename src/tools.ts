import { applyOps, encode, parseMoment, resolveZone } from './time.ts';
import type { ContextTimeZone, TimeState } from './time.ts';
import { capLine } from './text.ts';
import { runJaq } from './jaq.ts';
import { buildOption, CHART_WIDTH } from './chart/option.ts';
import { renderEchartsSvg } from './chart/echarts.ts';
import { buildFigureHtml, renderReportHtml } from './chart/report.ts';
import type { LayoutOverrides } from './chart/shared.ts';
import { OBJECT_OUTPUT, renderChart, renderCheck, renderJaq, renderJson, renderQuery, renderValue, withoutQueries } from './response.ts';
import type { Row } from './response.ts';
import { REFERENCE_KINDS, referencesOf, renderReferences, renderSearch, searchIndex } from './retrieval.ts';
import type { ReferencesArgs, SearchArgs } from './retrieval.ts';
import { renderAsk, VA_HELPER_PREFIX } from './va.ts';
import type { VaRuntime } from './va.ts';
import type { Knowledge, WorkspaceEntry } from './knowledge.ts';
import type { TimeContext } from './time-context.ts';
import type { PluginConfig } from './config.ts';
import { isArray } from './host.ts';
import { errorText } from './host.ts';
import type { DiagnosticEntry, LogFn, ServiceResponse, ToolDefinition, ToolExec, TraceStep } from './host.ts';
import { intentKey } from './key.ts';
import { nameProblem, readResult, saveArtifact, saveResult } from './results.ts';
import type { ColumnInfo } from './results.ts';

/** oks_info 的入参。 */
interface InfoArgs {
  key?: unknown;
}

/** oks_check_intent / oks_query 的入参：命名对象（名字 → Intent）。
 *  query 路径的每项形如 {intent, key}，check 路径的值就是 Intent 本身。 */
interface IntentArgs {
  intents?: unknown;
}

/** 一项命名 Intent：名字用于回执对应、结果文件名与来源核对。 */
interface NamedIntent {
  name: string;
  intent: unknown;
  key: string | null;
}

/** 命名批次的解析结果：要么拿到有序的项，要么拿到一句可读的原因。 */
type ParsedIntents = { items: NamedIntent[] } | { error: string };

/** Intent 顶层 limit 的产品范围：必填，1..100。上限由插件来管，服务只负责执行。 */
const INTENT_LIMIT_MIN = 1;
const INTENT_LIMIT_MAX = 100;

/** 校验一个 Intent 的顶层 limit；返回 null 表示合格。 */
const limitProblem = (intent: unknown): string | null => {
  if (intent === null || typeof intent !== 'object' || Array.isArray(intent)) {
    return 'Intent 必须是一个对象，并在顶层声明 limit';
  }
  const limit = (intent as Record<string, unknown>).limit;
  if (limit === undefined || limit === null) {
    return `Intent 必须在顶层显式声明 limit（${INTENT_LIMIT_MIN} 到 ${INTENT_LIMIT_MAX} 的整数），它决定这次查询取多少行`;
  }
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < INTENT_LIMIT_MIN || limit > INTENT_LIMIT_MAX) {
    return `limit 必须是 ${INTENT_LIMIT_MIN} 到 ${INTENT_LIMIT_MAX} 的整数，收到 ${JSON.stringify(limit)}`;
  }
  return null;
};

/** 取一个已通过校验的 Intent 的 limit。 */
const limitOf = (intent: unknown): number | null => {
  if (intent === null || typeof intent !== 'object' || Array.isArray(intent)) return null;
  const limit = (intent as Record<string, unknown>).limit;
  return typeof limit === 'number' && Number.isInteger(limit) ? limit : null;
};

/** oks_report 的入参：报告素材 + 文件名前缀 + 可选备注。 */
interface ReportArgs {
  spec?: unknown;
  name?: unknown;
  note?: unknown;
}

/** 取一张图的数据：src 与 data 恰好提供一个，并校验规格要用的列都在。
 *  oks_chart 与 oks_report 共用这一套，保证两处的口径一致。 */
const resolveChartRows = (
  source: { src?: unknown; data?: unknown },
  root: string,
  spec: ChartSpec,
): { rows: Array<Record<string, unknown>>; columns: string[]; source: 'query' | 'agent' } | { error: string } => {
  const hasSrc = typeof source.src === 'string' && source.src.length > 0;
  const hasData = source.data !== undefined && source.data !== null;
  if (hasSrc === hasData) {
    return { error: '需要 src 与 data 恰好提供一个：src 引用查询结果文件，data 是你要画的数据本身。' };
  }
  let rows: Array<Record<string, unknown>>;
  let columns: string[];
  let kind: 'query' | 'agent';
  if (hasSrc) {
    // src 走与 oks_jaq_result 同一套读取与路径校验：只认工作区 .data/ 里的结果文件。
    const file = readResult(root, source.src);
    rows = file.rows;
    columns = file.columns.map((column) => column.name);
    kind = 'query';
  } else {
    const parsed = parseChartData(source.data);
    if ('error' in parsed) return { error: parsed.error };
    rows = parsed.rows;
    columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
    kind = 'agent';
  }
  const referenced = [spec.x, spec.value, spec.series].filter((name): name is string => name !== null);
  // 空数据没有列可校验，也不该因此报错：空结果照样出一张空图。
  const missing = rows.length === 0 ? [] : referenced.filter((name) => !columns.includes(name));
  if (missing.length > 0) {
    return { error: `这些列不在数据里：${missing.join(', ')}。可用的列：${columns.join(', ') || '(没有列)'}` };
  }
  return { rows, columns, source: kind };
};

/** 解析并校验报告素材。图的规格与取数都复用 oks_chart 那一套。 */
/** 报告的素材：标题、副标题与正文 markdown。章节（`##`）与图的落点（```chart 块）都在正文里，
 *  所以不需要另外的结构——报告只认这一种写法。 */
interface ReportSpec {
  title: string;
  subtitle: string | null;
  markdown: string;
}

const parseReportSpec = (raw: unknown): { spec: ReportSpec } | { error: string } => {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { error: 'oks_report 需要 spec（对象）：title 与 markdown 必填' };
  }
  const record = raw as Record<string, unknown>;
  const title = record.title;
  if (typeof title !== 'string' || title.trim() === '') return { error: 'spec.title 必填，且不能是空字符串' };
  const markdown = record.markdown;
  if (typeof markdown !== 'string' || markdown.trim() === '') {
    return { error: 'spec.markdown 必填：用 ## 写章节，用 ```chart 块放图' };
  }
  const unknown = Object.keys(record).filter((key) => !['title', 'subtitle', 'markdown'].includes(key));
  if (unknown.length > 0) return { error: `spec 里不认识的项：${unknown.join(', ')}` };
  return {
    spec: {
      title,
      subtitle: record.subtitle === undefined || record.subtitle === null ? null : String(record.subtitle),
      markdown,
    },
  };
};

/** 画报告里的一张图：解析规格、取数、列校验、渲染成内联 SVG。
 *  与 oks_chart 共用 parseChartSpec / resolveChartRows，所以两处的口径完全一致。 */
const renderReportFigure = (
  json: Record<string, unknown>,
  root: string,
): { html: string; caption: string | null } | { error: string } => {
  const parsedChart = parseChartSpec(json);
  if ('error' in parsedChart) return { error: parsedChart.error };
  const chartSpec = parsedChart.spec;
  const resolved = resolveChartRows({ src: json.src, data: json.data }, root, chartSpec);
  if ('error' in resolved) return { error: resolved.error };
  if (chartSpec.kind === 'line') {
    const issue = lineProblem(resolved.rows, chartSpec);
    if (issue !== null) return { error: issue };
  }
  // 来源逐图判定：这张图是从结果文件取数，还是用 agent 自填的行。
  const sourceLabel = resolved.source === 'query' ? '基于查询结果' : 'agent 自主填写';
  const { option, height } = buildOption(resolved.rows, { ...chartSpec, sourceLabel });
  const svg = renderEchartsSvg(option, CHART_WIDTH, height);
  return {
    html: buildFigureHtml(svg, null),
    caption: json.caption === undefined || json.caption === null ? null : String(json.caption),
  };
};

/** oks_chart 的入参：图表规格 + 恰好一个数据路径（src 或 data）。 */
interface ChartArgs {
  spec?: unknown;
  src?: unknown;
  data?: unknown;
  name?: unknown;
  note?: unknown;
}

/** 校验后的图表规格。图元：横条（bar）、分组柱（column）、多序列折线（line）、饼图（pie）、
 *  面积图（area）。x 与 value 在这里是非空字符串：五种图元都要求它们，校验不通过根本走不到画图；
 *  column 另外要求作为分组维度的 series，line 与 area 还要求 xType。
 *  layout 是排版覆盖项（字号、高度、是否斜排标签），全部可选、缺省走默认规则。 */
interface ChartSpec {
  kind: 'bar' | 'line' | 'column' | 'pie' | 'area';
  title: string | null;
  x: string;
  value: string;
  series: string | null;
  xType: 'number' | 'time' | null;
  xLabel: string | null;
  valueLabel: string | null;
  unit: string | null;
  layout: LayoutOverrides;
}

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
  if (unknown.length > 0) return { error: `spec.layout 里不认识的项：${unknown.join(', ')}` };
  return { layout };
};

/** oks_chart 的返回值（渲染与 presentationMeta 读它）。 */
interface ChartAnswer {
  ok: true;
  kind: ChartSpec['kind'];
  title: string | null;
  source: 'query' | 'agent';
  /** 查询结果文件（src 路径才有）。 */
  src: string | null;
  /** 落盘的 SVG，相对工作区根。 */
  svgSrc: string;
  /** 可以直接粘进回答的 markdown 引用。 */
  markdown: string;
  at: string;
  note: string | null;
  rowCount: number;
  columns: string[];
  spec: ChartSpec;
  /** 只有 src 路径才有：结果文件里的原始 Intent，交给来源核对。 */
  intent: unknown;
}

const CHART_KINDS = ['bar', 'line', 'column', 'pie', 'area'] as const;
/** data 路径的规模上限：更大的数据应当先查询、再用 src 引用结果文件。 */
const CHART_DATA_MAX_ROWS = 1000;
const CHART_DATA_MAX_BYTES = 256 * 1024;

/** 校验图表规格；只做形状与必填，不解释领域含义。 */
const parseChartSpec = (raw: unknown): { spec: ChartSpec } | { error: string } => {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: 'oks_chart 需要 spec（对象）：kind 必填，各个图元有各自的字段' };
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
    layout: {},
  };
  const parsedLayout = parseLayout(record.layout);
  if ('error' in parsedLayout) return { error: parsedLayout.error };
  spec.layout = parsedLayout.layout;
  if (spec.kind === 'bar' && (spec.x === '' || spec.value === '')) {
    return { error: 'bar 需要 spec.x（类别列）与 spec.value（数值列）' };
  }
  if (spec.kind === 'column') {
    if (spec.x === '' || spec.value === '') {
      return { error: 'column 需要 spec.x（类别列）与 spec.value（数值列）' };
    }
    if (spec.series === null) {
      return { error: 'column 需要 spec.series（分组列）：每个类别里按它分成相邻的几根柱子' };
    }
  }
  if (spec.kind === 'pie') {
    if (spec.x === '' || spec.value === '') {
      return { error: 'pie 需要 spec.x（类别列）与 spec.value（数值列）' };
    }
  }
  if (spec.kind === 'area') {
    if (spec.x === '' || spec.value === '') {
      return { error: 'area 需要 spec.x（横轴列）与 spec.value（数值列）' };
    }
    if (spec.xType === null) return { error: 'area 需要 spec.xType：number 或 time' };
  }
  if (spec.kind === 'line') {
    if (spec.x === '' || spec.value === '') {
      return { error: 'line 需要 spec.x（横轴列）与 spec.value（数值列）' };
    }
    if (spec.xType === null) return { error: 'line 需要 spec.xType：number 或 time' };
  }
  return { spec };
};

/** 校验 agent 自填的数据行：对象行数组，空数组有效。 */
const parseChartData = (raw: unknown): { rows: Array<Record<string, unknown>> } | { error: string } => {
  if (!Array.isArray(raw)) return { error: 'data 必须是对象行数组' };
  if (raw.length > CHART_DATA_MAX_ROWS) {
    return { error: `data 最多 ${CHART_DATA_MAX_ROWS} 行（收到 ${raw.length} 行）：要画更多请先查询，再用 src 引用结果文件` };
  }
  const rows: Array<Record<string, unknown>> = [];
  for (const item of raw) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return { error: 'data 的每一行都必须是对象' };
    rows.push(item as Record<string, unknown>);
  }
  const bytes = JSON.stringify(rows).length;
  if (bytes > CHART_DATA_MAX_BYTES) {
    return { error: `data 太大（${bytes} 字符 > ${CHART_DATA_MAX_BYTES}）：请先查询，再用 src 引用结果文件` };
  }
  return { rows };
};

/** 折线的前置检查：每行都要有横轴值、每个序列的横轴非递减、数值是有限数值或 null。
 *  （渲染在客户端；这些是规格层面的错，要在工具里就挡掉。） */
const lineProblem = (rows: readonly Record<string, unknown>[], spec: ChartSpec): string | null => {
  const xColumn = spec.x;
  const valueColumn = spec.value;
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

/** time 横轴的取值：epoch 毫秒原样用，RFC 3339 文本按 Date.parse 换算。 */
const toEpochMillis = (value: unknown): number | null => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
};

/** 解析命名批次：1..5 项的对象，名字要能当文件名前缀用。
 *  同一个 JSON 对象里重复的成员名在解析阶段就已经丢了、工具看不到，所以这里只保证「看到的名字」
 *  合法；批次内唯一由对象本身保证。 */
const parseNamedIntents = (raw: unknown, withKey: boolean, toolName: string): ParsedIntents => {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: `${toolName} 需要 1 到 5 项命名 Intent：一个「名字 → Intent」的对象，例如 {"ports": {"op":"Graph",...}}` };
  }
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length < 1 || entries.length > 5) {
    return { error: `${toolName} 需要 1 到 5 项命名 Intent，收到 ${entries.length} 项` };
  }
  const items: NamedIntent[] = [];
  for (const [name, value] of entries) {
    const problem = nameProblem(name);
    if (problem !== null) return { error: `${toolName} 的名字不合法（${JSON.stringify(name)}）：${problem}` };
    let intent: unknown = value;
    let key: string | null = null;
    if (withKey) {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return { error: `${toolName} 的 ${name} 需要 {intent, key}：key 由 oks_check_intent 给出` };
      }
      const record = value as Record<string, unknown>;
      if (typeof record.key !== 'string' || record.key.length === 0) {
        return { error: `${toolName} 的 ${name} 缺少 key：先用 oks_check_intent 校验并取得它，再原样传回` };
      }
      intent = record.intent;
      key = record.key;
    }
    const limitIssue = limitProblem(intent);
    if (limitIssue !== null) return { error: `${toolName} 的 ${name}：${limitIssue}` };
    items.push({ name, intent, key });
  }
  return { items };
};

/** 两个时间工具的入参。 */
interface TimeArgs {
  timeZone?: string;
  base?: unknown;
  operations?: unknown;
}

/** oks_jaq_result 的入参：引用结果文件，并给出作用在行数组上的表达式。 */
/** oks_jaq_result 的入参：引用结果文件，并给出作用在行数组上的表达式。 */
interface JaqArgs {
  src?: unknown;
  query?: unknown;
}

/** jq 输出的字符上限：到点终止求值并标记截断（模型可见文本另有预算）。 */
const JAQ_MAX_CHARS = 256 * 1024;

/** va_ask 的入参。 */
interface AskArgs {
  query?: string;
}

/** 一批 Intent 的服务响应，加上它映射回命名批次的下标与名字。 */
interface Batch {
  response: ServiceResponse;
  intents: unknown[];
  /** 提交数组的下标 → 命名批次里的下标。 */
  indexes: number[];
  /** 命名批次里的名字，与 indexes 同序。 */
  names: string[];
}

interface Subset {
  indexes: number[];
  accepted: boolean;
}

interface LoweredBatch {
  method: string;
  trace: TraceStep[];
  response: ServiceResponse;
  diagnostics: DiagnosticEntry[];
  batch: Batch | null;
  subset: Subset | null;
}

/** oks_query 里一项的状态：保存成功，或四种失败之一。
 *  key_mismatch 表示请求里的 key 与重算结果不符（Intent 被改过、或 key 抄错）。 */
type QueryStatus = 'saved' | 'key_mismatch' | 'rejected' | 'query_error' | 'save_error';

/** oks_query 的一项结果。成功项带 dataSrc；数据行只在结果文件里，不在模型可见面。 */
interface QueryAnswerResult {
  name: string;
  /** 命名批次里的下标，渲染用它把回执与诊断对齐。 */
  index: number;
  status: QueryStatus;
  dataSrc: string | null;
  columns: ColumnInfo[];
  rowCount: number | null;
  sql: string | null;
  bindings: unknown[];
  truncated: boolean;
  ms: number | null;
  error: string | null;
}

/** oks_query 的返回值（渲染层与 presentationMeta 读它的一个视图）。 */
interface QueryAnswer {
  trace: TraceStep[];
  /** 命名批次，保序；回执与 meta 只引用名字。 */
  intents: Array<{ name: string; intent: unknown }>;
  accepted: boolean;
  diagnostics: DiagnosticEntry[];
  results: QueryAnswerResult[];
  dataFile: string | null;
  window: { start: string; endExclusive: string } | null;
  queryMaxRows: number;
}

export function createTools({ knowledge, va, timeContext, log, config }: {
  knowledge: Knowledge;
  va: VaRuntime;
  timeContext: TimeContext;
  log: LogFn;
  config: PluginConfig | undefined;
}): ToolDefinition[] {
  /** 降一批 Intent。服务只在整批通过时才回 queries，所以被拒批次里没有报 Error 的子集
   *  会再提交一次——这样"5 个里坏了 1 个"仍能拿到其余 4 个的执行物。 */
  const lowerBatch = async (
    entry: WorkspaceEntry,
    items: NamedIntent[],
    signal: AbortSignal | undefined,
  ): Promise<LoweredBatch> => {
    const method = `${entry.settings.domain}/transform`;
    const trace: TraceStep[] = [];
    // ensureWorkspace 返回前一定装配好宿主；这里按这个约定断言。
    const runner = entry.runner!;
    // 服务只认 Intent 的数组；名字是插件自己的批次标识，不进协议。
    const intents = items.map((item) => item.intent);
    const names = items.map((item) => item.name);
    const response = await runner.send(method, { intents }, signal);
    trace.push({ method, request: { intents }, response });
    const rawDiagnostics = response?.ok?.diagnostics;
    const diagnostics: DiagnosticEntry[] = Array.isArray(rawDiagnostics) ? rawDiagnostics : [];
    const errors = new Set(diagnostics
      .filter((item) => item?.diagnostic?.severity === 'Error')
      .map((item) => item.index));
    let batch: Batch | null = null;
    let subset: Subset | null = null;
    if (response?.ok?.accepted === true && Array.isArray(response?.ok?.queries)) {
      batch = { response, intents, indexes: intents.map((_intent, index) => index), names };
    } else if (entry.settings.retryAcceptedSubset !== false) {
      const indexes = intents.map((_intent, index) => index).filter((index) => !errors.has(index));
      if (indexes.length > 0 && indexes.length < intents.length) {
        const subsetIntents = indexes.map((index) => intents[index]);
        const retry = await runner.send(method, { intents: subsetIntents }, signal);
        trace.push({ method, request: { intents: subsetIntents }, response: retry, note: '仅未报 Error 的子集，再降一次' });
        const passed = retry?.ok?.accepted === true && Array.isArray(retry?.ok?.queries);
        subset = { indexes, accepted: passed };
        if (passed) batch = { response: retry, intents: subsetIntents, indexes, names };
      }
    }
    return { method, trace, response, diagnostics, batch, subset };
  };

  /** 批次本身不合法（形状、规模、名字、key）：不调服务，直接给一条批次级诊断。 */
  const intentError = (method: string, message: string, items: NamedIntent[]): {
    trace: TraceStep[];
    intents: Array<{ name: string; intent: unknown }>;
    diagnostics: DiagnosticEntry[];
  } => ({
    trace: [{
      method,
      request: { intents: items.map((item) => item.intent) },
      response: { error: true, diagnostics: [{ message }] },
    }],
    intents: items.map((item) => ({ name: item.name, intent: item.intent })),
    diagnostics: [{ index: 0, diagnostic: { severity: 'Error', message } }],
  });

  /** 上下文时区：会话不在（或没记过）时按缺失处理，与原写法 `zones.get(exec?.agent?.session)` 一致。 */
  const contextZone = (exec: ToolExec | undefined): ContextTimeZone | undefined => {
    const session = exec?.agent?.session;
    return session === undefined ? undefined : timeContext.zones.get(session);
  };

  // 工具描述在注册时写死，此时还不知道任何工作区，所以文本里不出现领域名。
  // 设计约束：**这里也不写任何"地图长什么样"的假设**。工具描述只说协议（怎么打交道）
  // 与呈现（收到什么就原样给什么）；具体有哪些种类、入口、字段、格式、路由、分页，
  // 一律由服务自己的声明回答——模型换了形状，这里一行都不用改。
  const definitions: ToolDefinition[] = [
    {
      name: 'oks_info',
      description: 'Read one knowledge node of this workspace\'s knowledge service by its opaque string key. Start with key "index" — the one key you may supply from memory; it tells you where to go next. From there, follow the keys the service returns, whatever shape it declares, and copy each key verbatim: never construct, split or decode one. Use only the canonical IDs the service declares when writing Intents; display names and physical column names are not substitutes.',
      parameters: {
        type: 'object',
        properties: {
          key: {
            type: 'string',
            description: 'Opaque knowledge key, copied verbatim from what the service returned — another node, a link, or a diagnostic. "index" is the one key you may supply from memory.',
          },
        },
        required: ['key'],
        additionalProperties: false,
      },
      output: { schema: OBJECT_OUTPUT, render: renderJson },
      async execute(args: InfoArgs, exec: ToolExec) {
        const entry = knowledge.ensureWorkspace(exec);
        const method = `${entry.settings.domain}/info`;
        const request = args?.key !== undefined && args?.key !== null ? { key: args.key } : null;
        if (request === null) {
          return {
            trace: [{
              method,
              request: {},
              response: { error: true, diagnostics: [{ message: 'oks_info needs a knowledge key' }] },
            }],
          };
        }
        const runner = entry.runner!;
        const response = await runner.send(method, request, exec?.signal);
        return { trace: [{ method, request, response }] };
      },
    },
    {
      name: 'oks_search',
      description: 'Find this workspace\'s knowledge vocabulary by name, alias or description and get what you need to address a node: its kind, its name, its owner, where the term matched and how well. Keys are not returned — compose the key with the pattern the service declares for that kind in index.detail.key_patterns, then read the node with oks_info. Use it when you know what a thing is called but not its key; narrow with kind= or dataset=, and page with skip=.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Words to look for in a term\'s name, aliases or description. Matching is case-insensitive and splits camelCase and separators; every word must appear somewhere in the term. Omit it to list everything the filters allow.',
          },
          kind: { type: 'string', description: 'Restrict to one kind of term. The kinds that are discoverable are declared by the knowledge service of this workspace; a kind outside that declaration is rejected with the declared list.' },
          dataset: { type: 'string', description: 'Restrict to terms whose declared owner "dataset" is this one.' },
          skip: { type: 'number', description: 'Start at this match (default 0). The response reports how many matches remain, so page with skip = start + matched.length.' },
        },
        additionalProperties: false,
      },
      output: { schema: OBJECT_OUTPUT, render: renderSearch },
      async execute(args: SearchArgs, exec: ToolExec) {
        const entry = knowledge.ensureWorkspace(exec);
        const index = await knowledge.ensureIndex(entry);
        const result = searchIndex(index, args);
        log(`[oks] search query=${JSON.stringify(args?.query ?? '')} kind=${args?.kind ?? '-'}`
          + ` dataset=${args?.dataset ?? '-'} skip=${result.start} → ${result.total} 命中 · 返回 ${result.matched.length}`
          + `${result.more === null ? '' : ` · 还有 ${result.more}`}`);
        return result;
      },
    },
    {
      name: 'oks_references',
      description: 'List what references a knowledge key, from the reference graph the plugin derives when the vocabulary is built. Each row names the reference kind and the referencing node\'s key, so you can read that node with oks_info or follow it further. Use it to see what depends on a term before you change how you address it.',
      parameters: {
        type: 'object',
        properties: {
          key: {
            type: 'string',
            description: 'A knowledge key that exists in this artifact — composed from the declared key patterns, or taken verbatim from what a node returned.',
          },
          link: { type: 'string', enum: REFERENCE_KINDS, description: 'Restrict to one reference kind.' },
          kind: { type: 'string', description: 'Restrict to referencing nodes of one kind. The kinds that are discoverable are declared by the knowledge service of this workspace.' },
          skip: { type: 'number', description: 'Start at this reference (default 0).' },
        },
        required: ['key'],
        additionalProperties: false,
      },
      output: { schema: OBJECT_OUTPUT, render: renderReferences },
      async execute(args: ReferencesArgs, exec: ToolExec) {
        const entry = knowledge.ensureWorkspace(exec);
        const index = await knowledge.ensureIndex(entry);
        const result = referencesOf(index, args);
        log(`[oks] references key=${result.key} link=${args?.link ?? '-'} kind=${args?.kind ?? '-'}`
          + ` skip=${result.start} → ${result.total} 条 · 返回 ${result.references.length}`);
        return result;
      },
    },
    {
      name: 'oks_check_intent',
      description: 'Validate one to five named graph Intents against this workspace\'s knowledge model and report the result per name. Nothing is executed and no query text comes back — this is the cheap way to find out whether a batch is acceptable, and the names that pass come back with a `key` that oks_query then requires verbatim. All Intents are checked even if one fails, and the subset without Error diagnostics is checked again so a partially bad batch still tells you which members are good. On rejection, read the diagnostics and repair the Intent with its business meaning intact.',
      parameters: {
        type: 'object',
        properties: {
          intents: {
            type: 'object',
            description: 'One to five named graph Intents: an object mapping a batch name to one Intent, e.g. {"ports":{"op":"Graph","root":"d","nodes":[{"id":"d","entity":"<dataset id>"}],"edges":[],"select":[],"limit":100}}. The name labels the batch and becomes the result file name prefix, so it must be non-empty and free of path separators. Every Intent must declare a top-level limit — the integer 1..100 that decides how many rows this query returns; it is part of the Intent and is hashed with it. Closed Intent choices use the declared enum spelling in PascalCase (e.g. op "Graph", filter op "Eq", direction "Desc", row_grain "Root"); the entity is the declared dataset id, not the knowledge key. The service also declares the authoritative Intent syntax — read it from the knowledge nodes it points you to instead of relying on memory.',
            additionalProperties: { type: 'object', additionalProperties: true },
          },
        },
        required: ['intents'],
        additionalProperties: false,
      },
      output: { schema: OBJECT_OUTPUT, render: renderCheck },
      async execute(args: IntentArgs, exec: ToolExec) {
        const entry = knowledge.ensureWorkspace(exec);
        const method = `${entry.settings.domain}/transform`;
        const parsed = parseNamedIntents(args?.intents, false, 'oks_check_intent');
        if ('error' in parsed) {
          return { ...intentError(method, parsed.error, []), results: [], subset: null, queryCount: 0 };
        }
        const items = parsed.items;
        const { trace, response, diagnostics, batch, subset } = await lowerBatch(entry, items, exec?.signal);
        const queries = batch?.response?.ok?.queries;
        // batch.indexes 是「命名批次」的下标（第一次提交的顺序就是命名顺序），所以直接对名。
        const passed = new Set(batch === null ? [] : batch.indexes);
        return {
          trace: trace.map((step) => ({ ...step, response: withoutQueries(step.response) })),
          intents: items.map((item) => ({ name: item.name, intent: item.intent })),
          // 只有通过校验的项给 key：它是这一项 Intent 的一致性标识，query 必须原样带回来。
          results: items.map((item, index) => ({
            name: item.name,
            accepted: passed.has(index),
            key: passed.has(index) ? intentKey(item.intent) : null,
            diagnostics: diagnostics.filter((entry2) => entry2.index === index),
          })),
          accepted: response?.ok?.accepted === true,
          diagnostics,
          subset,
          queryCount: Array.isArray(queries) ? queries.length : 0,
        };
      },
    },
    {
      name: 'oks_query',
      description: 'Answer a business question from this workspace\'s data: validate one to five named graph Intents, then run the accepted ones as read-only queries against the data file the workspace declares. Each success is saved to a result file in the workspace (.data/) and the reply reports only its dataSrc, columns and rowCount — the rows stay out of this conversation until you take them with oks_jaq_result. A rejected Intent returns diagnostics instead of a dataSrc, and a name whose key does not match its Intent is refused before execution. Use oks_check_intent first to get the keys.',
      parameters: {
        type: 'object',
        properties: {
          intents: {
            type: 'object',
            description: 'One to five named graph Intents, each carrying the key oks_check_intent returned for exactly that Intent: {"ports":{"intent":{...,"limit":100},"key":"<opaque-key>"}}. The key is opaque — copy it verbatim, never edit or recompute it; the tool recomputes the hash and refuses a name whose key does not match its Intent. Keep the names you used in the check batch so the reply lines up. Editing the Intent (including its limit) invalidates the key: check again.',
            additionalProperties: {
              type: 'object',
              properties: {
                intent: { type: 'object', additionalProperties: true },
                key: { type: 'string' },
              },
              required: ['intent', 'key'],
              additionalProperties: false,
            },
          },
        },
        required: ['intents'],
        additionalProperties: false,
      },
      // 宿主呈现记录：Intent、SQL、bindings 与执行信息只进 meta；数据行留在结果文件里。
      output: {
        schema: OBJECT_OUTPUT,
        render: renderQuery,
        presentationMeta: (_args: unknown, value: QueryAnswer) => ({
          version: 1,
          kind: 'oks.query',
          accepted: value.accepted,
          dataFile: value.dataFile,
          window: value.window,
          queryMaxRows: value.queryMaxRows,
          intents: value.intents,
          diagnostics: value.diagnostics,
          results: value.results.map((result) => ({
            name: result.name,
            status: result.status,
            dataSrc: result.dataSrc,
            columns: result.columns,
            rowCount: result.rowCount,
            sql: result.sql,
            bindings: result.bindings,
            truncated: result.truncated,
            ms: result.ms,
            error: result.error,
          })),
        }),
      },
      async execute(args: IntentArgs, exec: ToolExec) {
        const entry = knowledge.ensureWorkspace(exec);
        const method = `${entry.settings.domain}/transform`;
        const answers: QueryAnswer = {
          trace: [],
          intents: [],
          accepted: false,
          diagnostics: [],
          results: [],
          dataFile: entry.settings.dataFile ?? null,
          window: null,
          queryMaxRows: entry.settings.queryMaxRows,
        };
        const parsed = parseNamedIntents(args?.intents, true, 'oks_query');
        if ('error' in parsed) {
          const failure = intentError(method, parsed.error, []);
          answers.trace = failure.trace;
          answers.diagnostics = failure.diagnostics;
          return answers;
        }
        const items = parsed.items;
        answers.intents = items.map((item) => ({ name: item.name, intent: item.intent }));

        // 先核 key：Intent 被改过、或 key 不是这一项的，直接拒掉、不执行。
        const mismatched = new Set<number>();
        items.forEach((item, index) => {
          if (intentKey(item.intent) !== item.key) mismatched.add(index);
        });

        const { trace, response, diagnostics, batch } = await lowerBatch(entry, items, exec?.signal);
        answers.trace = trace;
        answers.accepted = response?.ok?.accepted === true;
        answers.diagnostics = diagnostics;
        const passed = new Set(batch === null ? [] : batch.indexes);
        const results: QueryAnswerResult[] = items.map((item, index) => ({
          name: item.name,
          index,
          status: mismatched.has(index) ? 'key_mismatch' : passed.has(index) ? 'query_error' : 'rejected',
          dataSrc: null,
          columns: [],
          rowCount: null,
          sql: null,
          bindings: [],
          truncated: false,
          ms: null,
          error: mismatched.has(index)
            ? 'key 与这一项 Intent 的哈希不符：Intent 被改过，或 key 不是它。用 oks_check_intent 重新取得 key 再提交。'
            : null,
        }));
        answers.results = results;
        if (batch === null) return answers;

        const { executor, manifest } = knowledge.executorFor(entry.settings);
        answers.window = manifest?.window ?? null;
        const queries = batch.response?.ok?.queries ?? [];
        for (let at = 0; at < queries.length; at += 1) {
          const query = queries[at];
          const index = batch.indexes[at] ?? at;
          const slot = results[index];
          if (slot === undefined || slot.status === 'key_mismatch') continue;
          const sql = String(query?.sql ?? '');
          const bindings: unknown[] = isArray(query?.bindings) ? query.bindings : [];
          slot.sql = sql;
          slot.bindings = bindings;
          const item = items[index]!;
          const started = Date.now();
          let outcome;
          try {
            // 行数由 Intent 自己的 limit 决定（服务已把它落到 SQL 的最终限行）；执行器这一层只用
            // 同一个数字做保险，不再另加 queryMaxRows 截断——保存的是这次 Intent 的完整结果。
            outcome = await executor.send(
              sql, bindings, exec?.signal, limitOf(item.intent) ?? entry.settings.queryMaxRows,
            );
          } catch (cause) {
            slot.status = 'query_error';
            slot.ms = Date.now() - started;
            slot.error = errorText(cause);
            log(`[oks] query ${slot.name} failed after ${slot.ms} ms: ${slot.error}`);
            continue;
          }
          slot.ms = Date.now() - started;
          slot.truncated = outcome.truncated;
          try {
            // 只读执行成功就落盘：数据行只留在结果文件里，模型可见面只有引用。
            const saved = saveResult({
              root: entry.settings.workspaceRoot,
              name: slot.name,
              key: item.key ?? '',
              intent: item.intent,
              rows: outcome.rows,
              sqlColumns: outcome.columns.length > 0 ? outcome.columns : Object.keys(outcome.rows[0] ?? {}),
            });
            slot.status = 'saved';
            slot.dataSrc = saved.dataSrc;
            slot.columns = saved.columns;
            slot.rowCount = saved.rowCount;
            // 执行留痕进宿主日志：模型可见面之外唯一能查到「跑了什么」的地方。
            log(`[oks] query ${slot.name} → ${saved.rowCount}${outcome.truncated ? '+' : ''} row(s)`
              + ` · ${slot.ms} ms · ${saved.dataSrc}`
              + ` · sql=${capLine(sql.replace(/\s+/g, ' '), 200)}`
              + ` · bindings=${capLine(JSON.stringify(bindings), 200)}`);
          } catch (cause) {
            // 数据已经查出来了，只是没保存成功：与执行失败分开报。
            slot.status = 'save_error';
            slot.error = errorText(cause);
            log(`[oks] query ${slot.name} not saved: ${slot.error}`);
          }
        }
        return answers;
      },
    },
    {
      name: 'oks_jaq_result',
      description: 'Query a saved query result with a jaq (jq-compatible) expression instead of reading the whole file back. src identifies the result file that oks_query returned; query is the expression, and its input is the array of row objects — write it as if those rows were the whole document, e.g. ".[] | select(.count > 100)", "map({name, total})", "sort_by(.total) | reverse | .[0:5]". The expression decides what comes back, so project narrowly when you only need a few fields: the file can hold as many rows as the limit you declared in the Intent. The reply reports how many rows went in, how many values came out, and the values themselves; an expression that fails to run comes back with the evaluator\'s own message.',
      parameters: {
        type: 'object',
        properties: {
          src: { type: 'string', description: 'A dataSrc returned by oks_query, copied verbatim — a workspace-relative path under .data/.' },
          query: { type: 'string', description: 'A jaq/jq expression whose input is the array of row objects from that file.' },
        },
        required: ['src', 'query'],
        additionalProperties: false,
      },
      output: { schema: OBJECT_OUTPUT, render: renderJaq },
      async execute(args: JaqArgs, exec: ToolExec) {
        const entry = knowledge.ensureWorkspace(exec);
        const file = readResult(entry.settings.workspaceRoot, args?.src);
        const query = typeof args?.query === 'string' ? args.query.trim() : '';
        if (query === '') {
          throw new Error('oks_jaq_result 需要 query：作用在行数组上的 jaq 表达式，例如 ".[] | select(.count > 100)"。');
        }
        const started = Date.now();
        const outcome = await runJaq(query, {
          input: file.rows,
          // 求值沿用查询的超时约束：jaq 是纯函数，但表达式可以写得很 explosive。
          timeoutMs: entry.settings.queryTimeoutMs,
          maxChars: JAQ_MAX_CHARS,
          signal: exec?.signal,
        });
        // jaq -c 一行一个值；不是 JSON 的行（例如原样输出的字符串）保留成字符串。
        const result: unknown[] = [];
        for (const line of outcome.text.split('\n')) {
          if (line.trim() === '') continue;
          try {
            result.push(JSON.parse(line) as unknown);
          } catch {
            // jaq -c 一行一个 JSON 值；解析不了说明输出被动过，报出来而不是把残片当字符串塞给模型。
            throw new Error(`jaq 输出里有一行不是 JSON 值：${capLine(line, 120)}`);
          }
        }
        log(`[oks] jaq ${file.name} · 输入 ${file.rows.length} 行 → 产出 ${result.length} 个值`
          + ` · ${Date.now() - started} ms · query=${capLine(query, 200)}`);
        return {
          src: String(args?.src),
          name: file.name,
          totalRows: file.rows.length,
          returned: result.length,
          truncated: outcome.truncated,
          result,
        };
      },
    },
    {
      name: 'oks_chart',
      description: 'Draw a figure from either a saved query result or data you supply yourself, and save it as an SVG file. Give exactly one of src (a dataSrc returned by oks_query — the figure then reads that result file, and it is labelled "based on query results") or data (an array of row objects you fill in — labelled "filled in by the agent"). The receipt gives you a markdown line: put it verbatim into your answer and the figure shows up there. The rows themselves never enter this conversation, and the file stays in the workspace so you can reference it again. For a plain table, write a markdown table in your reply instead.',
      parameters: {
        type: 'object',
        properties: {
          spec: {
            type: 'object',
            description: 'Figure specification. kind is required: bar needs x (the category column) and value; column needs x, series (the grouping column: one bar per distinct value inside each category) and value — it draws grouped vertical bars; line needs x, value and xType (number or time), plus an optional series for several lines; area is a line with the region below it filled, and takes the same fields as line; pie needs x (the slice label column) and value, and only positive values are drawn. title / xLabel / valueLabel / unit are display text you supply.',
            properties: {
              kind: { type: 'string', enum: ['bar', 'line', 'column', 'pie', 'area'], description: 'Which figure to draw.' },
              title: { type: 'string', description: 'Title shown above the figure.' },
              x: { type: 'string', description: 'bar / column: the category column. line / area: the horizontal-axis column. pie: the slice label column.' },
              value: { type: 'string', description: 'The numeric column drawn as bar length, column height, line height, area height or slice size.' },
              series: { type: 'string', description: 'line / area: one line (or area) per distinct value. column: required — one bar per distinct value, placed side by side inside each category.' },
              xType: { type: 'string', enum: ['number', 'time'], description: 'line only: how to read the x column. time accepts RFC 3339 text or epoch milliseconds.' },
              xLabel: { type: 'string', description: 'Axis label for x (display text).' },
              valueLabel: { type: 'string', description: 'Axis label for the value (display text).' },
              unit: { type: 'string', description: 'Unit shown with the values (display text).' },
              layout: {
                type: 'object',
                description: 'Optional typography overrides — use these when the user is unhappy with the default proportions. All fields optional.',
                properties: {
                  labelFont: { type: 'number', description: 'Axis label / tick / legend size in pt, 8-18. Default scales with data density between 8.5 and 11.5.' },
                  titleFont: { type: 'number', description: 'Title size in pt, 8-32. Default 12.' },
                  height: { type: 'number', description: 'Figure height in pt, 200-2000. Default 340 for column / line / area; for bar it is derived from the row count; for pie it sets the canvas size (default 255 ≈ 9cm).' },
                  rowHeight: { type: 'number', description: 'Height of one category row in a horizontal bar chart, in pt, 16-80. Default 26, and it grows automaticallly when labelFont is large.' },
                  slantTicks: { type: 'boolean', description: 'Force (true) or forbid (false) slanted x-axis labels. Default: slant only when labels would collide.' },
                  tickCount: { type: 'number', description: 'Number of ticks on the value axis, 3-12. Default 6. Increase it when the reader needs finer granularity, decrease it when the axis looks like a ruler.' },
                },
                required: [],
                additionalProperties: false,
              },
            },
            required: ['kind'],
            additionalProperties: false,
          },
          src: { type: 'string', description: 'A dataSrc returned by oks_query, copied verbatim. Exactly one of src and data must be given.' },
          data: { type: 'array', items: { type: 'object', additionalProperties: true }, description: 'Row objects you supply yourself (an empty array is valid). Exactly one of src and data must be given.' },
          name: { type: 'string', description: 'Optional file-name prefix for the saved SVG; defaults to "chart". Same rules as a query batch name.' },
          note: { type: 'string', description: 'Optional short note carried in the receipt — your own narration, kept apart from the system source label.' },
        },
        required: ['spec'],
        additionalProperties: false,
      },
      output: { schema: OBJECT_OUTPUT, render: renderChart },
      async execute(args: ChartArgs, exec: ToolExec) {
        const entry = knowledge.ensureWorkspace(exec);
        const parsedSpec = parseChartSpec(args?.spec);
        if ('error' in parsedSpec) throw new Error(parsedSpec.error);
        const spec = parsedSpec.spec;
        const hasSrc = typeof args?.src === 'string' && args.src.length > 0;
        const hasData = args?.data !== undefined && args?.data !== null;
        if (hasSrc === hasData) {
          throw new Error('oks_chart 需要 src 与 data 恰好提供一个：src 引用查询结果文件，data 是你要画的数据本身。');
        }
        let rows: Array<Record<string, unknown>>;
        let columns: string[];
        let intent: unknown = null;
        let source: 'query' | 'agent';
        if (hasSrc) {
          // src 走与 oks_jaq_result 同一套读取与路径校验：只认工作区 .data/ 里的结果文件。
          const file = readResult(entry.settings.workspaceRoot, args?.src);
          rows = file.rows;
          columns = file.columns.map((column) => column.name);
          intent = file.intent;
          source = 'query';
        } else {
          const parsedData = parseChartData(args?.data);
          if ('error' in parsedData) throw new Error(parsedData.error);
          rows = parsedData.rows;
          columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
          source = 'agent';
        }
        const referenced = [spec.x, spec.value, spec.series]
          .filter((name): name is string => name !== null);
        // 空数据没有列可校验，也不该因此报错：空结果照样出一张空图。
        const missing = rows.length === 0 ? [] : referenced.filter((name) => !columns.includes(name));
        if (missing.length > 0) {
          throw new Error(`这些列不在数据里：${missing.join(', ')}。可用的列：${columns.join(', ') || '(没有列)'}`);
        }
        if (spec.kind === 'line') {
          const issue = lineProblem(rows, spec);
          if (issue !== null) throw new Error(issue);
        }
        // 服务端出图：画成 SVG 落盘，并把「可以原样粘进回答」的那一行交给 agent。
        // 来源标识画进图里——图离开这段对话也要能自证数据来自查询还是 agent 自填。
        // 五种图元都走同一条 echarts 链路：规格 + 结果行 → option → SVG。
        const sourceLabel = source === 'query' ? '基于查询结果' : 'agent 自主填写';
        const { option, height } = buildOption(rows, { ...spec, sourceLabel });
        const svg = renderEchartsSvg(option, CHART_WIDTH, height);
        const saved = saveArtifact({
          root: entry.settings.workspaceRoot,
          name: typeof args?.name === 'string' && args.name.length > 0 ? args.name : 'chart',
          content: svg,
          extension: '.svg',
          label: '图表名',
        });
        const alt = (spec.title ?? (source === 'query' ? '查询结果图' : '数据图')).replace(/[[\]]/g, '');
        const markdown = `![${alt}](${saved.src})`;
        const note = typeof args?.note === 'string' && args.note.length > 0 ? args.note : null;
        log(`[oks] chart ${spec.kind} · source=${source} · ${rows.length} 行 → ${saved.src}`);
        return {
          ok: true as const,
          kind: spec.kind,
          title: spec.title,
          source,
          src: hasSrc ? String(args?.src) : null,
          svgSrc: saved.src,
          markdown,
          at: saved.at,
          note,
          rowCount: rows.length,
          columns,
          spec,
          intent,
        };
      },
    },
    {
      name: 'oks_report',
      description: 'Assemble a self-contained HTML report from a markdown body. The markdown is parsed with a restricted subset — headings, paragraphs, lists, tables, bold/italic/inline code, links, blockquotes, rules and fenced code blocks — and embedded HTML is escaped rather than interpreted. A ```chart fenced block draws a figure: its body is a JSON object shaped like the spec of oks_chart, plus src or data and an optional caption. Figures are inlined as SVG, so the single file opens anywhere with no external assets. Hand the result to the user with the present tool — an HTML report does not render in the reply body itself.',
      parameters: {
        type: 'object',
        properties: {
          spec: {
            type: 'object',
            description: 'The report material.',
            properties: {
              title: { type: 'string', description: 'Report title.' },
              subtitle: { type: 'string', description: 'Optional subtitle — usually the time window the report covers.' },
              markdown: {
                type: 'string',
                description: 'The report body in markdown. Use ## for sections (they become the table of contents). Where a figure should appear, put a fenced ```chart block whose body is a JSON object such as {"kind":"bar","title":"…","x":"col","value":"col","src":".data/….json","caption":"…"} — give exactly one of src and data, and the named columns must exist in that data. Other fenced blocks are rendered as plain code.',
              },
            },
            required: ['title', 'markdown'],
            additionalProperties: false,
          },
          name: { type: 'string', description: 'Optional file-name prefix for the saved HTML; defaults to "report". Same rules as a query batch name.' },
          note: { type: 'string', description: 'Optional short note carried in the receipt — your own narration, kept apart from the system source label.' },
        },
        required: ['spec'],
        additionalProperties: false,
      },
      output: { schema: OBJECT_OUTPUT, render: renderValue },
      async execute(args: ReportArgs, exec: ToolExec) {
        const entry = knowledge.ensureWorkspace(exec);
        const parsed = parseReportSpec(args?.spec);
        if ('error' in parsed) throw new Error(parsed.error);
        const note = typeof args?.note === 'string' ? args.note : null;
        let figureCount = 0;
        const html = renderReportHtml({
          title: parsed.spec.title,
          subtitle: parsed.spec.subtitle,
          generatedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
          markdown: parsed.spec.markdown,
          figure: (json) => {
            const rendered = renderReportFigure(json, entry.settings.workspaceRoot);
            if ('html' in rendered) figureCount += 1;
            return rendered;
          },
        });
        const saved = saveArtifact({
          root: entry.settings.workspaceRoot,
          name: typeof args?.name === 'string' && args.name.length > 0 ? args.name : 'report',
          content: html,
          extension: '.html',
          label: '报告名',
        });
        const markdown = `[${parsed.spec.title}](${saved.src})`;
        // 来源逐图判定，报告级没有单一来源可报；每张图的标识已经画在图里。
        return { ok: true, htmlSrc: saved.src, markdown, at: saved.at, note, figureCount };
      },
    },
    {
      name: 'time_now',
      description: 'Read the current instant from the host clock in several standard forms — epoch milliseconds and seconds, UTC text, RFC 3339, local text with its UTC offset, calendar date, and ISO week. The knowledge service never reads the clock, so every relative expression ("last week", "the last 24 hours") has to become an absolute boundary before it is submitted: resolve it here, state the time zone you used, and pick whichever form the knowledge node itself declares. This tool knows nothing about domain time formats.',
      parameters: {
        type: 'object',
        properties: {
          timeZone: {
            type: 'string',
            description: 'IANA time zone such as "Asia/Shanghai". By default the zone comes from the request context — the browser zone the client attached to the current turn messages, read per the plugin spec — so pass one only to override it (for example when the context zone is mixed or missing). The zone comes from the request context or from this argument; with neither, the call fails and asks you to confirm it with the user. The source actually used is echoed back.',
          },
        },
        additionalProperties: false,
      },
      output: { schema: OBJECT_OUTPUT, render: renderValue },
      async execute(args: TimeArgs, exec: ToolExec) {
        const { zone, source } = resolveZone(args?.timeZone, contextZone(exec));
        return { timeZone: zone, timeZoneSource: source, ...encode(Date.now(), zone) };
      },
    },
    {
      name: 'time_calc',
      description: 'Apply ordered calendar arithmetic to an instant and return every standard form of the result: add (year/quarter/month/week/day/hour/minute/second), floor/ceil to a calendar boundary (weeks start on Monday unless weekStartsOn is given), and convert between time zones. Day and week arithmetic keeps the local wall clock, so a day across a daylight-saving change is not always 24 hours; month/quarter/year addition clamps to the last valid day. Intervals are half-open [start, end), so compute both ends. base accepts "now" (the default), epoch milliseconds as a number, RFC 3339 text, or zone-less text "YYYY-MM-DD[ HH:MM[:SS]]" read as local time in the given zone.',
      parameters: {
        type: 'object',
        properties: {
          base: {
            oneOf: [{ type: 'string' }, { type: 'number' }],
            description: '"now" (default), epoch milliseconds as a number, RFC 3339 text, or zone-less "YYYY-MM-DD[ HH:MM[:SS]]" read as local time in timeZone.',
          },
          timeZone: {
            type: 'string',
            description: 'IANA time zone such as "Asia/Shanghai". By default the zone comes from the request context — the browser zone the client attached to the current turn messages, read per the plugin spec — so pass one only to override it (for example when the context zone is mixed or missing). The zone comes from the request context or from this argument; with neither, the call fails and asks you to confirm it with the user. The source actually used is echoed back.',
          },
          operations: {
            type: 'array',
            description: 'Applied in order, e.g. {"op":"add","unit":"month","amount":-1}, {"op":"floor","unit":"week","weekStartsOn":1}, {"op":"ceil","unit":"day"}, {"op":"convert","zone":"UTC"}.',
            items: { type: 'object', additionalProperties: true },
          },
        },
        additionalProperties: false,
      },
      output: { schema: OBJECT_OUTPUT, render: renderValue },
      async execute(args: TimeArgs, exec: ToolExec) {
        const { zone, source } = resolveZone(args?.timeZone, contextZone(exec));
        const base = parseMoment(args?.base, zone);
        const state: TimeState = { epochMillis: base, zone };
        const result = applyOps(state, args?.operations);
        return {
          timeZone: result.zone,
          timeZoneSource: source,
          base: { input: args?.base ?? 'now', ...encode(base, zone) },
          operations: result.applied,
          ...encode(result.epochMillis, result.zone),
        };
      },
    },
    {
      name: 'va_ask',
      description: 'Consult this session\'s vocabulary helper and get its answer back: send one paraphrase — a word, a phrase or a sentence, any language — and you receive the vocabulary\'s own equivalent or near expressions, one per line and verbatim. The helper holds the whole vocabulary in its system prompt, so the first call sets it up and takes longer; each later call is one question. Treat what it returns as leads: look the strings up with oks_search and read the declarations with oks_info.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'The paraphrase to consult about, e.g. "丢包" or "port pressure".',
          },
        },
        required: ['query'],
        additionalProperties: false,
      },
      output: { schema: OBJECT_OUTPUT, render: renderAsk },
      async execute(args: AskArgs, exec: ToolExec) {
        const query = typeof args?.query === 'string' ? args.query.trim() : '';
        if (query.length === 0) throw new Error('dsh-oks: va_ask 需要一个说法（query）。');
        const caller = exec?.agent;
        const key = caller?.session?.id;
        if (typeof key === 'string' && key.startsWith(VA_HELPER_PREFIX)) {
          throw new Error('dsh-oks: 词汇助手不咨询自己。');
        }
        if (caller === undefined || typeof key !== 'string' || key.length === 0) {
          throw new Error('dsh-oks: 无法确定调用方会话，va_ask 需要它来记住词汇助手。');
        }
        return va.ask(caller, key, query, exec?.signal);
      },
    },
  ];

  return definitions;
}
