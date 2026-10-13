import { applyOps, encode, parseMoment, resolveZone } from './time.ts';
import type { ContextTimeZone, TimeState } from './time.ts';
import { statSync } from 'node:fs';
import { capLine } from './text.ts';
import { runJaq } from './jaq.ts';
import type { JaqOutcome } from './jaq.ts';
import { buildOption, CHART_WIDTH } from './chart/option.ts';
import { renderEchartsSvg } from './chart/echarts.ts';
import { tableMarkdown } from './view/table.ts';
import { parseArtifactOrigin, reportChapters, reportItems } from './report/read.ts';
import type { ReportItemView } from './report/read.ts';
import { buildFigureHtml, provenanceBlockHtml, renderReportHtml, REPORT_PROVENANCE_MAX_BYTES } from './chart/report.ts';
import type { DisplaySource, ReportData } from './chart/report.ts';
import { CHART_KINDS, inferXType, supportedKinds, supports, toNumber } from './chart/shared.ts';
import type { ChartKind, ExpressionSwitch, LayoutOverrides, MarkLine, SecondMetric, StyleOverrides } from './chart/shared.ts';
import { OBJECT_OUTPUT, renderArtifacts, renderChart, renderCheck, renderCreateData, renderJqInto, renderJqTransform,
  renderJson, renderQuery, renderValue, renderView, renderWorkEdit, renderWorkRead, renderWorkWrite,
  shapeOf, withoutQueries } from './response.ts';
import { KEEP_ALIVE_MINUTES, listArtifacts, MATERIAL_KEEP_ALIVE_MINUTES, openState, pruneArtifacts, pruneMaterials,
  syncArtifacts } from './state.ts';
import type { Row } from './response.ts';
import { REFERENCE_KINDS, referencesOf, renderReferences, renderSearch, searchIndex } from './retrieval.ts';
import type { ReferencesArgs, SearchArgs } from './retrieval.ts';
import { renderAsk, VA_HELPER_PREFIX } from './va.ts';
import type { VaRuntime } from './va.ts';
import type { Knowledge, WorkspaceEntry } from './knowledge.ts';
import type { TimeContext } from './time-context.ts';
import type { PluginConfig } from './config.ts';
import { isArray, isRecord } from './host.ts';
import { errorText } from './host.ts';
import type { DiagnosticEntry, LogFn, ServiceResponse, ToolDefinition, ToolExec, TraceStep } from './host.ts';
import { intentKey } from './key.ts';
import { appendNode, ARTIFACT_DIR, chainLines, CHART_DIR, DEFAULT_ROOT, embedChartInput, nameProblem,
  editWorkFile, listWorkFiles, readArtifact, readCodeFile, readWorkFile, WORK_DIR, writeWorkFile,
  readChartInput, readTableView, rowsOf, saveArtifact, saveInputData,
  saveResult, saveTableView, saveTransform, VIEW_DIR } from './results.ts';
import type { ColumnInfo, DataOrigin, Envelope, OriginNode } from './results.ts';


/** oks_info 的入参。 */
interface InfoArgs {
  key?: unknown;
}

/** oks_check_intent / oks_query 的入参：命名对象（名字 → Intent）。
 *  query 路径的每项形如 {intent, key}，check 路径的值就是 Intent 本身。 */
interface IntentArgs {
  intents?: unknown;
  /** 这次查询的动机：一句自然语言，写进结果封装的 origin。 */
  motivation?: unknown;
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
  /** 精确分类（周报、月报、即时分析…）：没给就按"即时分析"。 */
  category?: unknown;
  note?: unknown;
}

/** 解析并校验报告素材。图的规格与取数都复用 oks_chart 那一套。 */
/** 报告的素材：标题、副标题与正文 markdown。章节（`##`）与图的落点（独占一行的图片）都在正文里，
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
    return { error: 'spec.markdown 必填：用 ## 写章节，用 ![图注](路径) 放图' };
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

/** 落盘时对声明数据文件的一次观察：路径、字节数、修改时间。
 *  **观察时点与范围要说清**：这是**查询返回之后、写结果之前**对那个路径做的 stat；它说明当时该路径
 *  对应这样一份文件，**不保证**与 SQLite 连接实际打开的是同一份（连接、缓存、换文件都不在覆盖范围内），
 *  也不代表查询期间它没有变。观察不到的（例如实际数据窗口）一律不写——`source` 记的是观察到的事实。 */
function observedSource(dataFile: string): Record<string, unknown> {
  const source: Record<string, unknown> = { dataFile };
  try {
    const info = statSync(dataFile);
    source.bytes = info.size;
    source.modifiedAt = new Date(info.mtimeMs).toISOString().replace(/\.\d{3}Z$/, 'Z');
  } catch {
    source.readable = false;
  }
  return source;
}

/** 报告里引用的图（`![图注](路径)`）：把工作区 `.oks/charts/` 下已经画好的 SVG 读进来内联。
 *
 *  路径两种写法都认——`.oks/charts/x.svg`（相对工作区根，和 src 一样）与 `x.svg`
 *  （相对 `.oks/charts/`：图就住在那里，所以这个解释在人看来同样自然）。
 *  与其要求 agent 记住"相对谁"，不如让两种都对；两种都经同一套越界校验，安全性不变。
 *  除此之外（`./`、`../`、绝对路径、子目录、http）一概拒绝，报错里给出正确写法。 */
const resolveReportDisplay = (root: string, href: string): { source: DisplaySource } | { error: string } => {
  const isTable = href.endsWith('.table.md');
  const directory = isTable ? VIEW_DIR : CHART_DIR;
  const extension = isTable ? '.md' : '.svg';
  const label = isTable ? '表' : '图';
  // 两种写法都认：带材料目录前缀，或只给文件名（材料就在那个目录里）。
  const src = href.startsWith(`${directory}/`) ? href : `${directory}/${href}`;
  let content: string;
  try {
    content = readArtifact(root, src, extension);
  } catch (cause) {
    return {
      error: `报告里引用的${label}取不到：${href}（${errorText(cause)}）。`
        + `写法可以是 ${directory}/<文件>${extension} 或 <文件>${extension}，文件要在工作区 ${directory}/ 里`,
    };
  }
  if (isTable) {
    const material = readTableView(content);
    if (material === null) return { error: `报告里引用的表不是本插件写的（文件头没有来源材料）：${href}` };
    return {
      source: {
        kind: 'table',
        markdown: material.markdown,
        origin: material.material.origin,
        data: material.material.data.rows,
        spec: material.material.data.spec,
      },
    };
  }
  if (!/<svg[\s>]/i.test(content)) return { error: `报告里引用的图不是 SVG：${href}` };
  const chart = readChartInput(content);
  if (chart === null) return { error: `报告里引用的图没有来源材料（不是本插件画的？）：${href}` };
  // 图自带的那份材料**搬进**报表级结构：内联的这一份不再重复带（工作区里的图文件仍自带，
  // 那是图自己的契约；报表里只留一份，共享祖先也才只存一份）。
  const svg = content.replace(/<metadata id="dsh-oks-chart-input">[^<]*<\/metadata>/, '');
  return {
    source: {
      kind: 'chart', svg, origin: chart.origin, data: chart.data.rows, spec: chart.data.spec,
    },
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

/** 校验后的图表规格。
 *  x 与 value 在这里是非空字符串：除 histogram 外都要求它们，校验不通过根本走不到画图；
 *  哪些图元还要 series、哪些开关对哪些图元有意义，由 parseChartSpec 按 shared.ts 里那份适用表判定。
 *  layout 是排版覆盖项（字号、高度、是否斜排标签），全部可选、缺省走默认规则。 */
interface ChartSpec {
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
const chartTitle = (spec: ChartSpec): string => {
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

/** 解析展示规格：`kind` 必填，先只支持表格。 */
const parseViewSpec = (raw: unknown): { spec: { kind: 'table'; src: string; title: string | null; columns: string[] | null } } | { error: string } => {
  if (!isRecord(raw)) return { error: 'spec 必须是对象：{"kind": "table", "src": "<dataSrc>"}' };
  const kind = typeof raw.kind === 'string' ? raw.kind : '';
  if (kind !== 'table') {
    return { error: `不支持的展示件：${kind === '' ? '(缺 kind)' : JSON.stringify(kind)}。这一版只有 "table"（表格）。` };
  }
  if (typeof raw.src !== 'string' || raw.src.length === 0) {
    return { error: 'table 需要 spec.src：前面回执里给的那份封装数据（行对象数组）。' };
  }
  const title = typeof raw.title === 'string' && raw.title.trim() !== '' ? raw.title.trim() : null;
  const columns = Array.isArray(raw.columns)
    ? raw.columns.filter((name): name is string => typeof name === 'string' && name !== '')
    : null;
  return { spec: { kind: 'table', src: raw.src, title, columns } };
};

/** 数据接口的单次返回上限（字节）。**不是分页机制，是安全阀**：
 *  数据接口要么返回**完整数据**，要么返回一个合法 JSON 的错误——绝不截断。 */
export const PAYLOAD_MAX_BYTES = 16 * 1024;

/** 超限时交出去的错误（合法 JSON，调用方可直接解析）。 */
export interface PayloadError {
  ok: false;
  error: {
    code: 'payload_too_large' | 'evaluation_truncated';
    tool: string;
    limitBytes: number;
    actualBytes: number | null;
    hint: string;
  };
}

/** 数据接口返回前的守门：完整就放行，超限就把数据换成错误（不返回半份数据）。 */
function payloadGuard<T extends { ok: true }>(tool: string, value: T, hint: string): T | PayloadError {
  const actualBytes = Buffer.byteLength(JSON.stringify(value) ?? '');
  if (actualBytes <= PAYLOAD_MAX_BYTES) return value;
  return {
    ok: false,
    error: { code: 'payload_too_large', tool, limitBytes: PAYLOAD_MAX_BYTES, actualBytes, hint },
  };
}

/** 求值本身被截断（求值器到上限）时同样不返回半份数据，而是报错——调用方收窄程序。 */
const truncatedError = (tool: string, hint: string): PayloadError => ({
  ok: false,
  error: { code: 'evaluation_truncated', tool, limitBytes: PAYLOAD_MAX_BYTES, actualBytes: null, hint },
});

/** 一份图的实际图元（column / pie / heatmap…）：从绘图规格里取；取不到就给 `?`。 */
function chartKindOf(spec: unknown): string {
  return isRecord(spec) && typeof spec.kind === 'string' ? spec.kind : '?';
}

/** 读一份产物（数据封装、图、表、报告）：四种写法都在这一层归一成同一份
 *  `{ meta, origin, data }`，路径校验仍走 readArtifact（可读目录 + 真实路径复核）。 */
function readProduct(root: string, src: string): Envelope {
  const extension = src.endsWith('.report.html') ? '.html'
    : src.endsWith('.chart.svg') ? '.svg'
      : src.endsWith('.table.md') ? '.md' : '.json';
  let content: string;
  try {
    content = readArtifact(root, src, extension);
  } catch (cause) {
    throw new Error(`读不到这份产物：${src}（${errorText(cause)}）`);
  }
  const parsed = parseArtifactOrigin(src, content);
  if ('error' in parsed) throw new Error(parsed.error);
  return parsed;
}

/** oks_chart 的返回值（渲染与 presentationMeta 读它）。 */
interface ChartAnswer {
  ok: true;
  kind: ChartSpec['kind'];
  /** 始终有值：agent 没给标题时这里是工具造的那个。 */
  title: string;
  /** 这份图读的那份封装数据。 */
  src: string;
  /** 落盘的 SVG，相对工作区根。 */
  svgSrc: string;
  /** 可以直接粘进回答的 markdown 引用。 */
  markdown: string;
  at: string;
  note: string | null;
  rowCount: number;
  columns: string[];
  spec: ChartSpec;
  /** 这份图的来源链（易读视图）——图自己另外带着完整的那一份。 */
  chain: string[];
}

/** column / area 的堆叠方式。 */
const CHART_STACKS = ['total', 'percent'] as const;
/** 类别排序：默认沿用数据顺序。 */
const CHART_SORTS = ['none', 'desc', 'asc'] as const;
/** data 路径的规模上限：更大的数据应当先查询、再用 src 引用结果文件。 */

/** 规格里引用的列（含图元专属字段指向的列）。
 *  oks_chart 与报告里的图共用这一份，否则会出现"工具接受、报告里报错"的半边差异。 */
const referencedColumns = (spec: ChartSpec): string[] =>
  [spec.x, spec.value, spec.series, spec.size, spec.second?.value ?? null]
    // 空字符串表示"这个图元不需要这一项"（如 histogram 没有 x），不该被当成一个列名去核对。
    .filter((name): name is string => typeof name === 'string' && name !== '');

/** 数据里缺了哪些被引用的列。空数据没有列可校验，也不该因此报错——空结果照样出一张空图。 */
const missingColumns = (spec: ChartSpec, columns: readonly string[], rowCount: number): string[] =>
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
  if (unknown.length > 0) return { error: `spec.second 里不认识的项：${unknown.join(', ')}` };
  return {
    second: {
      value: record.value,
      kind: 'line',
      label: typeof record.label === 'string' && record.label.length > 0 ? record.label : undefined,
      unit: typeof record.unit === 'string' && record.unit.length > 0 ? record.unit : undefined,
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
      label: typeof record.label === 'string' && record.label.length > 0 ? record.label : undefined,
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
const applyInferredXType = (spec: ChartSpec, rows: readonly Record<string, unknown>[]): 'number' | 'time' | 'category' | null => {
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
 *  oks_chart 是唯一的出图入口，这份判断也只此一处。 */
const shapeProblem = (rows: readonly Record<string, unknown>[], spec: ChartSpec): string | null => {
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

/** 两个 jq 工具的入参：具名输入 + 两种取法（`pick` 取路径 / `byFile` 跑程序）；物化那一个另有落点与动机。 */
interface TransformArgs {
  /** 名字 → 数据来源：`"<src>"` 或 `{"src": "<src>", "root": "<点路径>"}`（默认 `.data`）。 */
  inputs?: unknown;
  /** 从结果里取一段：jq 点路径，与 `byFile` 二选一。 */
  pick?: unknown;
  /** 程序写在 `.work/` 下的哪份文件里。 */
  byFile?: unknown;
  /** 物化的落点名。 */
  name?: unknown;
  motivation?: unknown;
}

/** 代码区三个工具的入参：名字与宿主那套完全一致（`file_path` / `content` / `old_string` /
 *  `new_string` / `replace_all`），只有工具名不同——名字承载"作用域只在 `.work/`"，参数形状
 *  沿用模型已经掌握的那套，于是习惯不浪费。 */
interface WorkReadArgs {
  file_path?: unknown;
  offset?: unknown;
  limit?: unknown;
}
interface WorkWriteArgs {
  file_path?: unknown;
  content?: unknown;
}
interface WorkEditArgs {
  file_path?: unknown;
  old_string?: unknown;
  new_string?: unknown;
  replace_all?: unknown;
}

/** oks_view 的入参：把一个展示件（先支持表格）落成文件。 */
interface ViewArgs {
  spec?: unknown;
  name?: unknown;
  note?: unknown;
}

/** create_data 的入参：agent 自己给的一份数据。 */
interface CreateDataArgs {
  name?: unknown;
  motivation?: unknown;
  data?: unknown;
}

/** jq 输出的字符上限：到点终止求值并标记截断（模型可见文本另有预算）。 */
const JAQ_MAX_CHARS = 256 * 1024;

/** 一份具名输入：名字是程序里引用它的变量名，`value` 是交给程序的那一段，`root` 是取那一段的点路径，
 *  `origin` 是这份产物的来源链。 */
interface NamedInput {
  name: string;
  src: string;
  root: string;
  value: unknown;
  origin: DataOrigin;
}

/** 点路径的两种写法共用一句提示：它是选择器、不是程序。 */
const PATH_HINT = '（"." 整份 / ".data" 那份数据本身 / ".origin" 来源链 / ".data.items" 更深的键）';

/** 解析一段**点路径**：jq 的选择器语法。它出现在两处——每个输入条目自带的 `root`（把这份文件的
 *  哪一段交给程序）与 `pick`（从结果里取回哪一段）——两处都只认点路径，别的一律报错并给出正确写法。 */
function parsePath(raw: unknown, where: string): { path: string[]; text: string } | { error: string } {
  if (typeof raw !== 'string') {
    return { error: `${where} 要写成点路径${PATH_HINT}` };
  }
  const text = raw.trim();
  if (text === '.') return { path: [], text: '.' };
  if (!/^\.[^.\s[\]]+(\.[^.\s[\]]+)*$/.test(text)) {
    return { error: `${where} 只接受点路径${PATH_HINT}，收到 ${JSON.stringify(raw)}` };
  }
  return { path: text.slice(1).split('.'), text };
}

/** 按点路径取一段；走过的那一段缺键就报出该层可用的键，而不是把 null 交出去
 *  （那只会变成一句看不懂的求值错误，或者一个看起来像"没有这个键"的空值）。`what` 说明取的是谁。 */
function selectPath(value: unknown, path: readonly string[], what: string): { value: unknown } | { error: string } {
  let current: unknown = value;
  const walked: string[] = [];
  for (const key of path) {
    if (!isRecord(current) || !(key in current)) {
      const available = isRecord(current) ? Object.keys(current).map((name) => `.${name}`).join(' / ') : '(不是对象)';
      return {
        error: `${what}没有 ${JSON.stringify(`.${[...walked, key].join('.')}`)}：`
          + `${walked.length === 0 ? '这一层' : JSON.stringify(`.${walked.join('.')}`)} 有的是 ${available || '(空)'}`,
      };
    }
    current = (current as Record<string, unknown>)[key];
    walked.push(key);
  }
  return { value: current };
}

/** 读一份产物、摊成本来的三段（`{ meta, origin, data }`；图/表/报告的材料块就地解析）。
 *  于是"读任何产物"只有一条路——具名输入 + 点路径，既不需要派生封装，也不需要专门的读接口。 */
function readDocument(root: string, src: string): { document: Record<string, unknown>; origin: DataOrigin } {
  const product = readProduct(root, src);
  // 交出去的形状与文件一致：把读回来时多出来的展示项视图留在这一层。
  return { document: { meta: product.meta, origin: product.origin, data: product.data }, origin: product.origin };
}

/** 从一份 data 里取列名：查询结果带着列信息，其余数据按第一行现取。 */
function columnsOf(data: unknown, rows: readonly Record<string, unknown>[]): string[] {
  if (isRecord(data) && Array.isArray(data.columns)) {
    return (data.columns as ColumnInfo[]).map((column) => column.name);
  }
  return Object.keys(rows[0] ?? {});
}

/** 解析具名输入：`{ 名字: 来源 }`，来源是 `"<src>"` 或 `{"src": "<src>", "root": "<点路径>"}`。
 *  每个输入都要真读到——读不到就报出是哪一个，而不是让程序去面对一个缺失的键
 *  （那会变成一句看不懂的求值错误）。 */
function readInputs(root: string, inputs: unknown, tool: string): NamedInput[] {
  if (inputs === undefined || inputs === null) return [];
  if (!isRecord(inputs)) {
    throw new Error(`${tool} 的 inputs 要写成"名字 → 数据来源"的对象，例如 {"events": ".oks/data/xxx.query.json"}；`
      + '每个条目可以是 dataSrc 字符串，也可以是 {"src": "<dataSrc>", "root": ".data.rows"}；没有输入就省略这一项。');
  }
  const entries: NamedInput[] = [];
  for (const [name, entry] of Object.entries(inputs)) {
    if (name.trim() === '') throw new Error('inputs 里的名字不能是空串：它同时是程序里引用这份数据的变量名。');
    let src: string;
    let path: string[] = DEFAULT_ROOT.slice(1).split('.');
    let rootText = DEFAULT_ROOT;
    if (typeof entry === 'string') {
      src = entry;
    } else if (isRecord(entry)) {
      if (entry.src === undefined) throw new Error(`输入 ${name} 少了 src：它要写成 {"src": "<dataSrc>", "root": ".data.rows"}。`);
      if (typeof entry.src !== 'string' || entry.src === '') {
        throw new Error(`输入 ${name} 的 src 必须是字符串（前面回执里给的那个相对路径）。`);
      }
      src = entry.src;
      const extra = Object.keys(entry).filter((key) => key !== 'src' && key !== 'root');
      if (extra.length > 0) {
        throw new Error(`输入 ${name} 只认 src 与 root，多了 ${extra.map((key) => JSON.stringify(key)).join(' / ')}。`);
      }
      if (entry.root !== undefined && entry.root !== null) {
        const parsed = parsePath(entry.root, `输入 ${name} 的 root`);
        if ('error' in parsed) throw new Error(parsed.error);
        path = parsed.path;
        rootText = parsed.text;
      }
    } else {
      throw new Error(`输入 ${name} 要写成 dataSrc 字符串，或 {"src": "<dataSrc>", "root": ".data.rows"}。`);
    }
    if (src === '') throw new Error(`输入 ${name} 的 dataSrc 不能是空串。`);
    let read: { document: Record<string, unknown>; origin: DataOrigin };
    try {
      read = readDocument(root, src);
    } catch (cause) {
      throw new Error(`读不到输入 ${name}（${src}）：${errorText(cause)}`);
    }
    // 取那一段失败与"读不到这份文件"是两回事：这里报的是这份文件里没有那个键。
    const picked = selectPath(read.document, path, `输入 ${name}（${src}）里`);
    if ('error' in picked) throw new Error(picked.error);
    entries.push({ name, src, root: rootText, value: picked.value, origin: read.origin });
  }
  return entries;
}

/** `byFile`：程序写在 `.work/` 下的哪份文件里（见 `readCodeFile`）。省略（或 null）时程序是恒等投影 `.`——
 *  于是结果就是「名字 → 各输入那一段」这个对象本身，`pick` 再从它里面取回一段。两条路都不把代码写进参数，
 *  于是 jq 的语法永远不会和外层 JSON 相邻。 */
function programFor(raw: unknown, root: string): { snip: string; generated?: boolean; file?: string } {
  if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) {
    return { snip: '.', generated: true };
  }
  const code = readCodeFile(root, raw);
  return { snip: code.text.trim(), file: code.file };
}

/** 一次读的参数都解析好之后的样子：具名输入、要跑的程序、以及从结果里取哪一段。 */
interface TransformPlan {
  inputs: NamedInput[];
  /** 实际交给求值器的程序：给了 byFile 是那份文件里的程序，否则是恒等投影 `.`。 */
  snip: string;
  /** 程序来自 `.work/` 下的哪份文件。 */
  file?: string;
  /** 程序是省略 byFile 时的恒等投影。 */
  generated?: boolean;
  /** `pick` 的点路径（原样写进回执的那一份）与它拆出来的键。 */
  pick?: string;
  pickPath?: readonly string[];
}

/** 两个 jq 工具共用的入参解析：具名输入（各带 `root`）+ 两种取法（`pick` 取路径 / `byFile` 跑程序）。
 *  取法二选一——要在程序的结果上再取一段，就把那一步写进程序。 */
function planTransform(args: TransformArgs | undefined, tool: string, root: string): TransformPlan {
  const stray = args as Record<string, unknown> | undefined;
  if (stray?.by !== undefined) {
    throw new Error(`${tool} 的程序文件名给 byFile，例如 "byFile": "analysis.jq"。`);
  }
  if (stray?.root !== undefined) {
    throw new Error(`${tool} 的每一份输入各带自己的 root：写进条目里`
      + '（{"inputs": {"d": {"src": "…", "root": ".data.rows"}}}）；要从结果里取一段用 pick（"pick": ".d"）。');
  }
  const inputs = readInputs(root, args?.inputs, tool);
  const code = programFor(args?.byFile, root);
  let pick: { path: string[]; text: string } | undefined;
  if (args?.pick !== undefined && args?.pick !== null) {
    if (code.file !== undefined) {
      throw new Error(`${tool} 的 pick 与 byFile 二选一：pick 从结果里取一段（不跑程序），byFile 跑程序文件；`
        + '要在程序的结果上再取一段，就把那一步写进程序（"| .key"）。');
    }
    const parsed = parsePath(args.pick, `${tool} 的 pick`);
    if ('error' in parsed) throw new Error(parsed.error);
    pick = parsed;
  }
  return {
    inputs,
    snip: code.snip,
    ...(code.file === undefined ? {} : { file: code.file }),
    ...(code.generated === true ? { generated: true } : {}),
    ...(pick === undefined ? {} : { pick: pick.text, pickPath: pick.path }),
  };
}

/** 按 `pick` 从求值结果里取一段；没给 pick 就是整个结果。取不到键时报出这一层有的键。 */
function applyPick(plan: TransformPlan, data: unknown): unknown {
  if (plan.pickPath === undefined) return data;
  const picked = selectPath(data, plan.pickPath, '这次求值的结果里');
  if ('error' in picked) throw new Error(picked.error);
  return picked.value;
}

/** 失败回执里那几行输入形状：名字、来源、取的那一段、形状。 */
function inputLines(inputs: readonly NamedInput[]): string {
  if (inputs.length === 0) return '  （没有输入：程序看到的是 {}）';
  return inputs
    .map((input) => `  输入 ${input.name} ← ${input.src}（${input.root} · ${shapeOf(input.value)}）`)
    .join('\n');
}

/** 求值一次 snip：把各输入的 `data` 按键绑成一个对象交给求值器。
 *  jq 的输出是一个**值流**：恰好一个输出时 data 就是那个值，多个输出时 data 是这些值的数组，
 *  零输出时 data 是空数组；`outputs` 记下个数，于是"一个空数组"与"没有输出"分得开。
 *  失败时把**求值器原话 + 这次各输入交出的形状**一起交出去：语法错照着文件名与行号改，
 *  "取错了键"这类错照着形状改，都不必再写一个探针程序去问。 */
async function runSnip(
  entry: WorkspaceEntry,
  inputs: readonly NamedInput[],
  snip: string,
  signal?: AbortSignal,
  programFile?: string,
): Promise<{ data: unknown; outputs: number; truncated: boolean }> {
  const document: Record<string, unknown> = {};
  for (const input of inputs) document[input.name] = input.value;
  let outcome: JaqOutcome;
  try {
    outcome = await runJaq(snip, {
      input: document,
      // 求值沿用查询的超时约束：jaq 是纯函数，但表达式可以写得很 explosive。
      timeoutMs: entry.settings.queryTimeoutMs,
      maxChars: JAQ_MAX_CHARS,
      signal,
      ...(programFile === undefined
        ? {}
        : { programFile, cwd: entry.settings.workspaceRoot }),
    });
  } catch (cause) {
    throw new Error(`${errorText(cause)}\n这次程序看到的输入：\n${inputLines(inputs)}`);
  }
  // jaq -c 一行一个值；不是 JSON 的行（例如原样输出的字符串）保留成字符串。
  const values: unknown[] = [];
  for (const line of outcome.text.split('\n')) {
    if (line.trim() === '') continue;
    try {
      values.push(JSON.parse(line) as unknown);
    } catch {
      // 解析不了说明输出被动过，报出来而不是把残片当结果塞给模型。
      throw new Error(`jaq 输出里有一行不是 JSON 值：${capLine(line, 120)}`);
    }
  }
  return { data: values.length === 1 ? values[0] : values, outputs: values.length, truncated: outcome.truncated };
}

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

  /** 写产物之前顺带清一次过期的（**懒惰清理**：插件只在被调用时活着，因此不需要定时器）。
   *  保留过的不动、认不出的不动；删了什么进宿主日志——删除是唯一不可逆的动作，必须留痕。 */
  const pruneBeforeWrite = (root: string): void => {
    const state = openState(root);
    try {
      const { removed, kept, untouched } = pruneArtifacts(state, root, KEEP_ALIVE_MINUTES);
      if (removed.length > 0) {
        log(`[oks] prune · 清理 ${removed.length} 个过期产物（保活 ${KEEP_ALIVE_MINUTES} 分钟；`
          + `保留 ${kept} 个、认不出 ${untouched} 个不动）`);
      }
      const materials = pruneMaterials(state, root, MATERIAL_KEEP_ALIVE_MINUTES);
      if (materials.removed.length > 0) {
        log(`[oks] prune · 清理 ${materials.removed.length} 个过期内部材料`
          + `（保活 ${MATERIAL_KEEP_ALIVE_MINUTES} 分钟；认不出 ${materials.untouched} 个不动）`);
      }
      // 顺手把清单同步一次：这样页签在**这次写产物之后**就能看到它，不必等一次清单调用。
      syncArtifacts(state, root);
    } finally {
      state.close();
    }
  };
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
            description: 'A knowledge key that exists in this model — composed from the declared key patterns, or taken verbatim from what a node returned.',
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
            description: 'One to five named graph Intents: an object mapping a batch name to one Intent, e.g. {"ports":{"op":"Graph","root":"d","nodes":[{"id":"d","entity":"<dataset id>"}],"edges":[],"select":[],"limit":100}}. The name labels the batch and becomes part of the result file name, so it is an identifier rather than a title: 0-9, _ and a-z only, at most 60 characters. Every Intent must declare a top-level limit — the integer 1..100 that decides how many rows this query returns; it is part of the Intent and is hashed with it. Closed Intent choices use the declared enum spelling in PascalCase (e.g. op "Graph", filter op "Eq", direction "Desc", row_grain "Root"); the entity is the declared dataset id, not the knowledge key. The service also declares the authoritative Intent syntax — read it from the knowledge nodes it points you to instead of relying on memory.',
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
      description: 'Answer a business question from this workspace\'s data: validate one to five named graph Intents, then run the accepted ones as read-only queries against the data file the workspace declares. Each success is saved as a result file in the workspace (.oks/data/) and the reply reports only its dataSrc, columns and rowCount — the rows stay out of this conversation until you take them with jq_transform. A rejected Intent returns diagnostics instead of a dataSrc, and a name whose key does not match its Intent is refused before execution. Use oks_check_intent first to get the keys.',
      parameters: {
        type: 'object',
        properties: {
          motivation: { type: 'string', description: 'Why this query is being run — one short natural-language sentence. It is recorded on this query\'s node of the saved data\'s source chain (origin.nodes[origin.root].motivation), so the numbers can be explained later; omit it for a purely mechanical lookup.' },
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
          // 来源事实在**执行之前**观察：这是这次查询开始时、声明的数据文件的状态。
          // 它只说明那一刻那个路径上有什么，不证明连接实际读的就是这份文件。
          const source = typeof entry.settings.dataFile === 'string'
            ? observedSource(entry.settings.dataFile) : undefined;
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
            pruneBeforeWrite(entry.settings.workspaceRoot);
            const saved = saveResult({
              root: entry.settings.workspaceRoot,
              name: slot.name,
              intent: item.intent,
              rows: outcome.rows,
              sqlColumns: outcome.columns.length > 0 ? outcome.columns : Object.keys(outcome.rows[0] ?? {}),
              motivation: typeof args?.motivation === 'string' ? args.motivation : undefined,
              source,
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
      name: 'create_data',
      description: 'Turn data you supply yourself into an envelope in the workspace, so that it can be referenced like any other data: give it a name, say why it exists, and pass the JSON. The tool writes {origin, data} into .oks/data/ as <time>-<name>-<content hash>.data.json, where origin is one node saying this data was given and carrying your motivation. The receipt gives you the dataSrc — a figure takes it as src, a transform takes it as one of its named inputs, and a later step can read it like anything else. Row objects (an array of objects) are what a figure needs; nested objects, arrays and scalars are fine too. Use this only for data that comes from outside the workspace (a handful of values from the user, a threshold table, rows copied from somewhere); anything computed from queried data belongs in jq_transform_into, whose provenance is built from the real inputs.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Name of the saved data — an identifier, not a title: 0-9, _ and a-z only, at most 60 characters, e.g. threshold_table. The file is named <time>-<name>-<content hash>.data.json under .oks/data/; an existing file is never overwritten.' },
          motivation: { type: 'string', description: 'Why this data exists and where it came from — one short natural-language sentence. It is recorded on the data\'s own node, and for given data it is the only explanation a reader will have, so it is required.' },
          data: {
            oneOf: [{ type: 'array' }, { type: 'object' }, { type: 'string' }, { type: 'number' }, { type: 'boolean' }],
            description: 'The data itself: any JSON value. An array of row objects is what a figure can draw; nested objects and scalars are fine for anything else.',
          },
        },
        required: ['name', 'motivation', 'data'],
        additionalProperties: false,
      },
      output: { schema: OBJECT_OUTPUT, render: renderCreateData },
      async execute(args: CreateDataArgs, exec: ToolExec) {
        const entry = knowledge.ensureWorkspace(exec);
        const name = typeof args?.name === 'string' ? args.name.trim() : '';
        if (name === '') {
          throw new Error('create_data 需要 name：这份数据的落点名（0-9、_ 与 a-z），例如 threshold_table。');
        }
        const motivation = typeof args?.motivation === 'string' ? args.motivation.trim() : '';
        if (motivation === '') {
          throw new Error('create_data 需要 motivation：这份数据从哪来、为什么存在（一句自然语言）。'
            + '给定数据没有别的解释，读的人只能看到这句话。');
        }
        if (args?.data === undefined || args.data === null) {
          throw new Error('create_data 需要 data：你要落成封装的那份 JSON（行对象数组、对象或标量都可以）。');
        }
        const at = Date.now();
        pruneBeforeWrite(entry.settings.workspaceRoot);
        const saved = saveInputData({ root: entry.settings.workspaceRoot, name, motivation, data: args.data });
        const ms = Date.now() - at;
        log(`[oks] create_data ${name} · ${(saved.bytes / 1024).toFixed(1)} KB · ${ms} ms · ${saved.dataSrc}`);
        return {
          dataSrc: saved.dataSrc,
          name,
          shape: shapeOf(args.data),
          bytes: saved.bytes,
          ms,
        };
      },
    },
    {
      name: 'jq_transform',
      description: 'Run a jaq (jq-compatible) program over saved data without saving anything, so a result can be looked at before it is kept. inputs maps a name of your choosing to a src a previous receipt gave you; each entry is either that src or {"src": "<src>", "root": "<jq dot path>"}, where root is which slice of the file the program gets — the default ".data" is that record\'s own data (a query result is {rows, columns}; a transform is the value it produced; a figure or table is {rows, spec}; a report is {chapters, plainTables, items}), ".origin" is the source chain {root, nodes}, ".meta" is the record\'s self-description, "." is the whole {meta, origin, data}, and deeper paths like ".data.rows" work too — so reading a record\'s provenance takes no separate tool. A path that does not exist fails with the keys that do. The program lives in a file under .work/ and byFile names it — "byFile": "analysis.jq", written first with work_write — so jq syntax never sits next to the JSON of the call itself. The program sees one object whose keys are the input names, so write ".events.rows[] | select(.count > 100)" or "{total: ([.events.rows[].n] | add)}". Leave byFile out and the result is that object itself ({"events": <slice>}); pick then takes one part of the result back, as a jq dot path without quotes ("pick": ".events"), which is how a single input is read under its bare name. With no inputs that object is {}, so a constant arrives through a program file. A jq program produces a stream of values: exactly one value comes back as that value, several come back as an array, none comes back as []. The receipt reports every input, the shape of the result and the values themselves, so look before you save; an expression that fails comes back with the evaluator\'s own message — which names the .work/ file and the line it stopped at, followed by the shape of each input the program saw, so one look at the error is usually enough to fix the program. To keep a result for a later step or for a figure, materialise it with jq_transform_into.',
      parameters: {
        type: 'object',
        properties: {
          inputs: { type: 'object', description: 'Named inputs, {"events": "<src>"} or {"events": {"src": "<src>", "root": ".data.rows"}}: each name becomes a key the program reads, each src is copied verbatim from an earlier receipt (a workspace-relative path under .oks/data/, .oks/charts/, .oks/views/ or artifacts/), and root picks the slice of that file. Omit it when the program needs no input.', additionalProperties: { oneOf: [{ type: 'string' }, { type: 'object', properties: { src: { type: 'string' }, root: { type: 'string' } }, required: ['src'], additionalProperties: false }] } },
          byFile: { type: 'string', description: 'Which .work/ file holds the program: "analysis.jq" (write it there first with work_write). Its input is one object whose keys are the input names, e.g. a program ".events.rows[] | select(.count > 100)". Leave it out to read the inputs unchanged, and use pick to take one part of that result.' },
          pick: { type: 'string', description: 'A jq dot path into the result, without quotes: ".events" gives one input back under its bare name, ".events.rows" goes deeper. It is for taking a part of the result back, so it stands alone — with byFile given, write that step into the program instead ("| .events").' },
        },
        required: [],
        additionalProperties: false,
      },
      output: { schema: OBJECT_OUTPUT, render: renderJqTransform },
      async execute(args: TransformArgs, exec: ToolExec) {
        const entry = knowledge.ensureWorkspace(exec);
        const plan = planTransform(args, 'jq_transform', entry.settings.workspaceRoot);
        const snip = plan.snip;
        const started = Date.now();
        const outcome = await runSnip(entry, plan.inputs, snip, exec?.signal, plan.file);
        const data = applyPick(plan, outcome.data);
        const ms = Date.now() - started;
        // 探索留痕：读过什么、算了什么、产出几个值——探索不进来源链，日志是唯一的记录。
        log(`[oks] jq_transform · ${plan.inputs.length} 份输入 → ${outcome.outputs} 个值`
          + `${plan.pick === undefined ? '' : ` · pick ${plan.pick}`}`
          + `${outcome.truncated ? '（求值到上限）' : ''} · ${ms} ms`
          + ` · ${plan.file === undefined ? '' : `${plan.file} `}snip=${capLine(snip, 200)}`);
        // 求值到上限＝数据不完整：报错，不返回半份（调用方让程序少取一点）。
        if (outcome.truncated) {
          return truncatedError('jq_transform', '让程序少取一点（只取你真正要的那部分：聚合、投影或前 N 项）。');
        }
        return payloadGuard('jq_transform', {
          ok: true as const,
          snip,
          ...(plan.file === undefined ? {} : { snipFile: plan.file }),
          ...(plan.generated === true ? { generated: true } : {}),
          ...(plan.pick === undefined ? {} : { pick: plan.pick }),
          inputs: plan.inputs.map((input) => ({
            name: input.name,
            src: input.src,
            root: input.root,
            shape: shapeOf(input.value),
          })),
          outputs: outcome.outputs,
          data,
          ms,
        }, '让程序少取一点（聚合、投影或前 N 项），不要一次取整份数据。');
      },
    },
    {
      name: 'jq_transform_into',
      description: 'Run a jaq (jq-compatible) program over saved data and save the result as data a later step or a figure can read. inputs maps a name of your choosing to a src from an earlier receipt; each entry is either that src or {"src": "<src>", "root": "<jq dot path>"}, and the program sees one object whose keys are those names — the default ".data" is the record\'s own data (query → {rows, columns}, transform → its value, figure/table → {rows, spec}, report → {chapters, plainTables, items}), ".origin" is the source chain and "." the whole {meta, origin, data}. Leave byFile out and the result is that object itself; pick takes one part of it back as a jq dot path without quotes ("pick": ".events"). With no inputs the object is {}, so a constant arrives through a program file. The tool builds the provenance itself: it reads each input, runs the program, and writes {meta, origin, data} into .oks/data/ — the new origin carries this operation (snip, motivation, output count, which name used which input) plus the complete source chain of every input, while the inputs\' own data stays out of it. A value stream is collected the same way as in jq_transform: one value is that value, several are an array, none is []. The receipt gives you the dataSrc, the shape and the whole source chain — it does not repeat the values, so explore with jq_transform when you want to see them. Data the agent supplies itself does not come in here: create_data makes it an envelope first, so that the numbers have a recorded reason.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Name of the saved result — an identifier, not a title: 0-9, _ and a-z only, at most 60 characters, e.g. events_by_level. The file is named <time>-<name>-<content hash>.transform.json under .oks/data/; an existing file is never overwritten.' },
          motivation: { type: 'string', description: 'Why this step is being done — one short natural-language sentence, recorded on this operation\'s node so the numbers can be explained later.' },
          inputs: { type: 'object', description: 'Named inputs, {"events": "<src>"} or {"events": {"src": "<src>", "root": ".data.rows"}}: each name becomes a key the program reads, each src is copied verbatim from an earlier receipt, and root picks the slice of that file. Omit it when the program needs no input (a constant).', additionalProperties: { oneOf: [{ type: 'string' }, { type: 'object', properties: { src: { type: 'string' }, root: { type: 'string' } }, required: ['src'], additionalProperties: false }] } },
          byFile: { type: 'string', description: 'Which .work/ file holds the program: "analysis.jq" (write it there first with work_write). Its input is one object whose keys are the input names, e.g. a program ".events.rows[] | {level, count}". Leave it out to save the inputs object itself, and use pick to take one part of it.' },
          pick: { type: 'string', description: 'A jq dot path into the result, without quotes: ".events" saves one input under its bare name, ".events.rows" goes deeper. It is for taking a part of the result back, so it stands alone — with byFile given, write that step into the program instead ("| .events").' },
        },
        required: ['name'],
        additionalProperties: false,
      },
      output: { schema: OBJECT_OUTPUT, render: renderJqInto },
      async execute(args: TransformArgs, exec: ToolExec) {
        const entry = knowledge.ensureWorkspace(exec);
        const name = typeof args?.name === 'string' ? args.name.trim() : '';
        if (name === '') {
          throw new Error('jq_transform_into 需要 name：这次加工结果的落点名（0-9、_ 与 a-z），例如 events_by_level。');
        }
        const plan = planTransform(args, 'jq_transform_into', entry.settings.workspaceRoot);
        const snip = plan.snip;
        const started = Date.now();
        const outcome = await runSnip(entry, plan.inputs, snip, exec?.signal, plan.file);
        const data = applyPick(plan, outcome.data);
        // 截断的结果是**不完整**的结果：物化它等于把一份残缺数据写进来源链，所以这里明确失败。
        if (outcome.truncated) {
          throw new Error(`表达式产出超过求值上限（${JAQ_MAX_CHARS} 字符），这份结果不完整，没有物化：`
            + '先用 jq_transform 把范围收窄（聚合或投影），再物化。');
        }
        const motivation = typeof args?.motivation === 'string' && args.motivation.trim() !== ''
          ? args.motivation.trim() : undefined;
        // 来源链由这一层组装：本次操作 + 各输入的**根节点**（产出那份 data 的记录）。
        pruneBeforeWrite(entry.settings.workspaceRoot);
        const saved = saveTransform({
          root: entry.settings.workspaceRoot,
          name,
          node: {
            kind: 'transform',
            ...(motivation === undefined ? {} : { motivation }),
            snip,
            ...(plan.file === undefined ? {} : { snipFile: plan.file }),
            ...(plan.pick === undefined ? {} : { pick: plan.pick }),
            // 输出个数记在**这个操作的节点**上：它是"这次执行产出了什么"的一部分。
            outputs: outcome.outputs,
            ...(plan.inputs.length === 0 ? {} : {
              inputs: Object.fromEntries(plan.inputs.map((input) => [input.name, input.origin.root])),
            }),
          },
          inputs: plan.inputs.map((input) => input.origin),
          data,
        });
        const ms = Date.now() - started;
        log(`[oks] jq_transform_into ${name} · ${plan.inputs.length} 份输入 → ${outcome.outputs} 个值`
          + `${plan.pick === undefined ? '' : ` · pick ${plan.pick}`}`
          + ` · ${(saved.bytes / 1024).toFixed(1)} KB · ${ms} ms · ${saved.dataSrc} · snip=${capLine(snip, 200)}`);
        return {
          dataSrc: saved.dataSrc,
          name,
          outputs: outcome.outputs,
          shape: shapeOf(data),
          bytes: saved.bytes,
          ms,
          chain: chainLines(saved.origin),
        };
      },
    },
    {
      name: 'oks_view',
      description: 'Turn saved data into a display piece and write it as a markdown file — a table, for now. Give spec.kind "table" and spec.src (a src copied verbatim from an earlier receipt — any product works, as long as its data are row objects, either an array or under rows). spec.columns picks and orders the columns to show (omit for every column in the order the data has); spec.title is the caption. Numeric columns are right-aligned. The receipt gives you two things: the line ![caption](.oks/views/<file>.table.md) for the markdown of a report, and the same table as ready-to-paste markdown for your reply. Paste the table itself into your reply — the ![caption](...) line belongs in a report body only, because nothing renders a .table.md as an image. The file holds the table plus the source chain of the data it shows, so the report can inline it and still explain where the numbers came from.',
      parameters: {
        type: 'object',
        properties: {
          spec: {
            type: 'object',
            description: 'What to display. kind is required and only "table" exists for now.',
            properties: {
              kind: { type: 'string', enum: ['table'], description: 'Which display piece: table.' },
              src: { type: 'string', description: 'A src copied verbatim from an earlier receipt — any product whose data are the rows to show: a query result ({rows, columns}), a computed result, rows from create_data, or a figure/table/report reused as a table.' },
              title: { type: 'string', description: 'Caption for the table — it becomes the alt text of the reference line and the table caption in a report, e.g. 各级别告警数量.' },
              columns: { type: 'array', items: { type: 'string' }, description: 'Columns to show, in this order. Omit to show every column the data has, in its own order. At most 12.' },
            },
            required: ['kind', 'src'],
            additionalProperties: false,
          },
          name: { type: 'string', description: 'Optional name for the saved file; defaults to "table". An identifier: 0-9, _ and a-z only, at most 60 characters. The file is <time>-<name>-<content hash>.table.md under .oks/views/.' },
          note: { type: 'string', description: 'Optional short note carried in the receipt — your own narration.' },
        },
        required: ['spec'],
        additionalProperties: false,
      },
      output: { schema: OBJECT_OUTPUT, render: renderView },
      async execute(args: ViewArgs, exec: ToolExec) {
        const entry = knowledge.ensureWorkspace(exec);
        const parsed = parseViewSpec(args?.spec);
        if ('error' in parsed) throw new Error(parsed.error);
        const view = parsed.spec;
        // 消费边界：表要行对象数组，和图同一套读取（rowsOf 会明确拒绝别的形状）。
        const file = readProduct(entry.settings.workspaceRoot, view.src);
        const rows = rowsOf(file.data, view.src);
        const drawn = tableMarkdown(rows, {
          ...(view.columns === null ? {} : { columns: view.columns }),
          ...(view.title === null ? {} : { title: view.title }),
        });
        if ('error' in drawn) throw new Error(drawn.error);
        const title = view.title ?? '数据表';
        pruneBeforeWrite(entry.settings.workspaceRoot);
        const saved = saveTableView({
          root: entry.settings.workspaceRoot,
          name: typeof args?.name === 'string' && args.name.length > 0 ? args.name : 'table',
          title,
          origin: file.origin,
          data: { rows, spec: { ...view, title } },
          markdown: drawn.markdown,
        });
        const markdown = `![${title.replace(/[[\]]/g, '')}](${saved.src})`;
        // 回执里带不带表本体，看它多大：表本来就是给人看的，但大表塞进上下文不划算。
        const body = drawn.markdown.length <= 4000 && rows.length <= 20 ? drawn.markdown : null;
        const note = typeof args?.note === 'string' && args.note.length > 0 ? args.note : null;
        log(`[oks] view table ${title} · ${rows.length} 行 · ${(saved.bytes / 1024).toFixed(1)} KB`
          + ` · src=${view.src} → ${saved.src}`);
        return {
          ok: true as const,
          kind: 'table' as const,
          title,
          src: view.src,
          viewSrc: saved.src,
          markdown,
          table: body,
          rowCount: rows.length,
          columns: drawn.columns,
          bytes: saved.bytes,
          note,
        };
      },
    },
    {
      name: 'oks_chart',
      description: 'Draw a figure from saved data and write it as an SVG file. Data comes in one way only: src, a dataSrc copied verbatim from an earlier receipt (oks_query for queried rows, jq_transform_into for a computed result, create_data for rows you supplied yourself) — rows are never written inline here, so every figure has a recorded origin. The receipt gives you a markdown line: put it verbatim into your answer and the figure shows up there. The figure carries the rows it drew, its specification and its whole source chain inside the SVG, so it still explains itself once the workspace is cleaned up. For a plain table, write a markdown table in your reply instead.',
      parameters: {
        type: 'object',
        properties: {
          spec: {
            type: 'object',
            description: 'Figure specification. kind is required: bar needs x (the category column) and value; column needs x and value — one bar per category, or grouped bars when series is given, or stacked ones when stack is given; line needs x and value (xType is inferred from the column, override it with number or time), plus an optional series for several lines; area is a line with the region below it filled, and takes the same fields as line (stack works here too); pie needs x (the slice label column) and value, and only positive values are drawn; scatter needs x and value (two numeric columns) and takes an optional size column for bubble charts; histogram needs only value (one numeric column) and shows how those values are distributed; box needs x (the category) and value, and draws one box per category; heatmap needs x (the horizontal category), series (the vertical category) and value, and colours each cell by its value — a combination with no row stays blank, not zero; radar needs x (the indicator), series (the object compared) and value, at least three indicators, and gives every indicator its own scale. title / xLabel / valueLabel / unit are display text you supply.',
            properties: {
              kind: { type: 'string', enum: [...CHART_KINDS], description: 'Which figure to draw.' },
              bins: { type: 'number', description: 'histogram only: how many bins to cut the value range into. Omit to let it pick by sample count.' },
              title: { type: 'string', description: 'Title shown above the figure.' },
              x: { type: 'string', description: 'bar / column: the category column. line / area: the horizontal-axis column. pie: the slice label column. scatter: the numeric column drawn on the horizontal axis. histogram: not used. heatmap: the horizontal category. radar: the indicator.' },
              value: { type: 'string', description: 'The numeric column drawn as bar length, column height, line height, area height, slice size, the vertical position of a scatter point, the cell colour of a heatmap or the distance from the centre in a radar.' },
              series: { type: 'string', description: 'line / area: one line (or area) per distinct value. bar: optional — each distinct value becomes its own bar inside every category, drawn side by side along the vertical axis. column: optional — each distinct value becomes its own bar inside every category (stacked when stack is given); omit it for a single bar per category. heatmap: required — the vertical category, one row of the matrix per distinct value. radar: required — the object being compared, one closed line per distinct value.' },
              xType: { type: 'string', enum: ['number', 'time'], description: 'line only: how to read the x column. time accepts RFC 3339 text or epoch milliseconds.' },
              xLabel: { type: 'string', description: 'Axis label for x (display text).' },
              valueLabel: { type: 'string', description: 'Axis label for the value (display text).' },
              unit: { type: 'string', description: 'Unit shown with the values (display text).' },
              stack: { type: 'string', enum: [...CHART_STACKS], description: 'column / area only: "total" stacks the series on top of each other (so the total reads off the top), "percent" normalises each category to 100% so the mix is comparable. Omit to place them side by side (column) or overlay them (area).' },
              size: { type: 'string', description: 'scatter only: a numeric column mapped to the marker size, turning the figure into a bubble chart.' },
              second: {
                type: 'object',
                description: 'A second metric drawn as a line on its own right-hand value axis. Use it when the two numbers differ by orders of magnitude (CPU percent vs port count) and their relationship is the point. bar / column / line / area only.',
                properties: {
                  value: { type: 'string', description: 'Column holding the second metric.' },
                  kind: { type: 'string', enum: ['line'], description: 'How to draw the second metric. Only "line" for now.' },
                  label: { type: 'string', description: 'Label for the right-hand axis (display text).' },
                  unit: { type: 'string', description: 'Unit for the second metric (display text).' },
                },
                required: ['value'],
                additionalProperties: false,
              },
              marks: {
                type: 'array',
                description: 'Reference lines drawn over the figure: thresholds, baselines, or a marked point in time. The value axis grows to fit them, so a threshold above the data still shows. bar / column / line / area only.',
                items: {
                  type: 'object',
                  properties: {
                    value: { oneOf: [{ type: 'number' }, { type: 'string' }], description: 'Where the line sits: a number on the value axis, or a category name on the category axis.' },
                    label: { type: 'string', description: 'Text shown on the line.' },
                    axis: { type: 'string', enum: ['x', 'y'], description: 'Which axis it is drawn on. Default "y" (a threshold); "x" marks a category.' },
                  },
                  required: ['value'],
                  additionalProperties: false,
                },
              },
              style: {
                type: 'object',
                description: 'Optional expression overrides that apply to every figure kind. All fields optional.',
                properties: {
                  sort: { type: 'string', enum: [...CHART_SORTS], description: 'Category order. Default "none" keeps the order the rows came in — data often carries a meaningful order already (severity levels, for instance).' },
                  labels: { type: 'boolean', description: 'Draw the values on the figure: next to each bar, point or slice, or inside each heatmap cell. Default false, except on a heatmap with at most 30 cells, where the numbers are written in by default so the matrix doubles as a table.' },
                  colors: { type: 'array', items: { type: 'string' }, description: 'Override the palette with up to 12 #rrggbb values; they are used in order for the series (or slices). On a heatmap there are no series to colour: one colour is the anchor the ramp is built from (light to dark), several become the ramp itself.' },
                },
                required: [],
                additionalProperties: false,
              },
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
          src: { type: 'string', description: 'A src copied verbatim from an earlier receipt — any product whose data are the rows to draw: oks_query returns queried rows ({rows, columns}), jq_transform_into a computed result, create_data rows you supplied yourself, and a figure, table or report can be drawn from again (its data form is {rows, spec} or a report\'s {chapters, items}). Rows cannot be written inline.' },
          name: { type: 'string', description: 'Optional name for the saved SVG; defaults to "chart". A name is an identifier, not a title: 0-9, _ and a-z only, at most 60 characters (longer ones are cut and tagged with a ~ plus a short hash), and the file is named <time>-<name>-<content hash>.chart.svg.' },
          category: { type: 'string', description: 'The precise kind of report, as a short noun phrase the reader recognizes — 周报 / 月报 / 即时分析 / 复盘 and the like. It is the text next to the type icon in the artifacts list, so keep it to a few characters; omit it for a one-off analysis and it defaults to 即时分析.' },
          note: { type: 'string', description: 'Optional short note carried in the receipt — your own narration, kept apart from the system source label.' },
        },
        required: ['spec', 'src'],
        additionalProperties: false,
      },
      output: { schema: OBJECT_OUTPUT, render: renderChart },
      async execute(args: ChartArgs, exec: ToolExec) {
        const entry = knowledge.ensureWorkspace(exec);
        const parsedSpec = parseChartSpec(args?.spec);
        if ('error' in parsedSpec) throw new Error(parsedSpec.error);
        const spec = parsedSpec.spec;
        if (typeof args?.src !== 'string' || args.src.length === 0) {
          throw new Error('oks_chart 需要 src：前面回执里给过的一份产物（查询结果、加工结果、create_data 的输入数据，'
            + '或一份图/表/报告——它们的数据块也能当表格用）。'
            + '行不能直接填在图里——要让一组自己组织的行成为图的数据，先用 create_data 把它们落成一份封装。');
        }
        // src 走同一套读取与路径校验：任何产物（封装数据、图、表、报告）都能当数据用，
        // rowsOf 另要求它的 data 是行对象数组。
        const file = readProduct(entry.settings.workspaceRoot, args.src);
        const rows = rowsOf(file.data, args.src);
        const columns = columnsOf(file.data, rows);
        const missing = missingColumns(spec, columns, rows.length);
        if (missing.length > 0) {
          throw new Error(`这些列不在数据里：${missing.join(', ')}。可用的列：${columns.join(', ') || '(没有列)'}`);
        }
        const inferredXType = applyInferredXType(spec, rows);
        const issue = shapeProblem(rows, spec);
        if (issue !== null) throw new Error(issue);
        // 服务端出图：画成 SVG 落盘，并把「可以原样粘进回答」的那一行交给 agent。
        // 图里不写来源标签：同一份数据经过几层加工就归不到一个入口，标签说不清；
        // 要说来源，看随后嵌进去的那份来源链。
        // 所有图元都走同一条 echarts 链路：规格 + 结果行 → option → SVG。
        const { option, height } = buildOption(rows, spec);
        const svg = renderEchartsSvg(option, CHART_WIDTH, height);
        const title = chartTitle(spec);
        // 图把**自己用的那份材料**带上：画出来的行、绘图规格、完整来源链。
        // 于是图离开工作区（或工作区被回收）之后仍说得清这些数字从哪来。
        const content = embedChartInput(svg, { origin: file.origin, data: { rows, spec } });
        pruneBeforeWrite(entry.settings.workspaceRoot);
        const saved = saveArtifact({
          root: entry.settings.workspaceRoot,
          name: typeof args?.name === 'string' && args.name.length > 0 ? args.name : 'chart',
          content,
          extension: '.svg',
          kind: 'chart',
          title,
        });
        const alt = title.replace(/[[\]]/g, '');
        const markdown = `![${alt}](${saved.src})`;
        const note = typeof args?.note === 'string' && args.note.length > 0 ? args.note : null;
        log(`[oks] chart ${spec.kind} · ${rows.length} 行 · ${args.src} → ${saved.src}`);
        return {
          ok: true as const,
          kind: spec.kind,
          title,
          src: args.src,
          svgSrc: saved.src,
          markdown,
          at: saved.at,
          note,
          rowCount: rows.length,
          columns,
          spec,
          chain: chainLines(file.origin),
        };
      },
    },
    {
      name: 'oks_report',
      description: 'Assemble a self-contained HTML report from a markdown body. The markdown is parsed with a restricted subset — headings, paragraphs, lists, tables, bold/italic/inline code, links, blockquotes, rules, images and fenced code blocks — and embedded HTML is escaped rather than interpreted. Figures come in one way only: reference a figure you have already drawn, on a line of its own, as ![caption](.oks/charts/<file>.chart.svg) — the report reads that SVG back and inlines it, so the single file opens anywhere with no external assets. Hand the result to the user with the present tool — an HTML report does not render in the reply body itself.',
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
                description: 'The report body in markdown. Use ## for sections (they become the table of contents). A figure comes in one way only: draw it first with oks_chart, then put the line that receipt gave you on a line of its own — ![caption](.oks/charts/<file>.chart.svg). The report reads that SVG back and inlines it, so the file stays single and self-contained; either .oks/charts/<file>.chart.svg or <file>.chart.svg is accepted (the figure itself lives in .oks/charts/), nothing else is. Figure numbers are assigned in the order the references appear. Other fenced blocks are rendered as plain code.',
              },
            },
            required: ['title', 'markdown'],
            additionalProperties: false,
          },
          name: { type: 'string', description: 'Optional name for the saved HTML; defaults to "report". A name is an identifier, not a title: 0-9, _ and a-z only, at most 60 characters, and the file is named <time>-<name>-<content hash>.report.html.' },
          category: { type: 'string', description: 'The precise kind of report, as a short noun phrase the reader recognizes — 周报 / 月报 / 即时分析 / 复盘 and the like. It is the text next to the type icon in the artifacts list, so keep it to a few characters; omit it for a one-off analysis and it defaults to 即时分析.' },
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
        let tableCount = 0;
        const html = renderReportHtml({
          title: parsed.spec.title,
          subtitle: parsed.spec.subtitle,
          generatedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
          markdown: parsed.spec.markdown,
          display: (href) => resolveReportDisplay(entry.settings.workspaceRoot, href),
          // 展示项的来源链在正文渲染完之后合并：每个展示项的原链都整份带过来，
          // 共享祖先按记录身份只留一个节点，节点引用在这个文件内闭合。
          provenanceBlock: (placed, body) => {
            figureCount = placed.filter((item) => item.kind === 'chart').length;
            tableCount = placed.filter((item) => item.kind === 'table').length;
            const records: ReportData['items'] = placed.map((item) => ({
              kind: item.kind,
              no: item.no,
              caption: item.caption,
              root: item.origin.root,
              spec: item.spec,
              data: item.data,
            }));
            // 章节骨架从渲染出的正文里取：哪张图在哪一章下，只有正文的顺序能回答。
            const structure = reportChapters(body, reportItems(records));
            // 报告自己也是一个操作：根指向"组装这份报告"，inputs 是各展示项的根。
            const assembled = appendNode(placed.map((item) => item.origin), {
              kind: 'report',
              inputs: Object.fromEntries(placed.map((item) => [
                `${item.kind === 'table' ? '表' : '图'} ${item.no}`,
                item.origin.root,
              ])),
            }, records.map((record) => ({
              ref: `${record.kind === 'table' ? '表' : '图'} ${record.no}`,
              root: record.root,
            })));
            const data: ReportData = {
              chapters: structure.chapters.map((chapter) => ({
                caption: chapter.caption,
                level: chapter.level,
                figures: chapter.items
                  .filter((item) => item.kind === 'chart')
                  .map((item) => ({ ref: item.label, kind: chartKindOf(item.spec), caption: item.caption })),
                tables: chapter.items
                  .filter((item) => item.kind === 'table')
                  .map((item) => ({ ref: item.label, caption: item.caption })),
              })),
              plainTables: structure.plainTables,
              items: records,
            };
            const bytes = Buffer.byteLength(JSON.stringify({ origin: assembled, data }));
            if (bytes > REPORT_PROVENANCE_MAX_BYTES) {
              throw new Error(`报表要带的来源材料 ${(bytes / 1024 / 1024).toFixed(1)} MB，超过上限 `
                + `${REPORT_PROVENANCE_MAX_BYTES / 1024 / 1024} MB：先缩小展示数据（聚合或投影），再出报表。`);
            }
            return provenanceBlockHtml({ origin: assembled, data });
          },
        });
        pruneBeforeWrite(entry.settings.workspaceRoot);
        const saved = saveArtifact({
          root: entry.settings.workspaceRoot,
          name: typeof args?.name === 'string' && args.name.length > 0 ? args.name : 'report',
          content: html,
          extension: '.html',
          kind: 'report',
          // 报告没有单一来源可写：叙述是 agent 写的，图逐张自证（见渲染层那句注释）。
          title: parsed.spec.title,
          // 大类是"报表"（用图标呈现），这一项是更精确的分类：agent 没给就按"即时分析"。
          category: typeof args?.category === 'string' && args.category.trim() !== ''
            ? args.category.trim()
            : '即时分析',
        });
        const markdown = `[${parsed.spec.title}](${saved.src})`;
        // 来源在报表级：展示项清单与合并后的节点表都在页面里的来源结构里，回执只报件数。
        return { ok: true, htmlSrc: saved.src, markdown, at: saved.at, note, figureCount, tableCount };
      },
    },
    {
      name: 'oks_artifacts',
      description: 'List this workspace\'s reports, newest first, each with its title, category, time and whether it is pinned. Figures live inside reports, and query results are internal: neither appears here. Use it when the user asks what has been produced in this workspace.',
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      output: { schema: OBJECT_OUTPUT, render: renderArtifacts },
      async execute(_args: unknown, exec: ToolExec) {
        const entry = knowledge.ensureWorkspace(exec);
        const root = entry.settings.workspaceRoot;
        const state = openState(root);
        try {
          syncArtifacts(state, root);
          const entries = listArtifacts(state);
          log(`[oks] artifacts · ${entries.length} 条（保留 ${entries.filter((item) => item.pinned).length}）`);
          return { ok: true as const, keepAliveMinutes: KEEP_ALIVE_MINUTES, entries };
        } finally {
          state.close();
        }
      },
    },
    {
      name: 'work_read',
      description: `Read a UTF-8 text file under ${WORK_DIR}/ and return line-numbered content — the same shape as the usual read tool (file_path / offset / limit), except that only ${WORK_DIR}/ is reachable: that is enforced, not requested. ${WORK_DIR}/ is your own code area in this workspace, the place for jq programs you will reference and re-edit. Pass "." as file_path to list what is in ${WORK_DIR}/ instead, so a fresh session can see what it left behind.`,
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: `Path under ${WORK_DIR}/, either "analysis.jq" or "${WORK_DIR}/analysis.jq". Use "." to list the directory.` },
          offset: { type: 'number', description: 'First line to return, 1-based. Default 1.' },
          limit: { type: 'number', description: 'How many lines to return, 1..2000. Default 400.' },
        },
        required: ['file_path'],
        additionalProperties: false,
      },
      output: { schema: OBJECT_OUTPUT, render: renderWorkRead },
      async execute(args: WorkReadArgs, exec: ToolExec) {
        const entry = knowledge.ensureWorkspace(exec);
        const root = entry.settings.workspaceRoot;
        const given = typeof args?.file_path === 'string' ? args.file_path.trim() : '';
        if (given === '.' || given === `${WORK_DIR}/` || given === WORK_DIR) {
          return { ok: true as const, file: WORK_DIR, entries: listWorkFiles(root), lines: [], from: 1, total: 0, bytes: 0 };
        }
        const read = readWorkFile(root, args?.file_path, args?.offset, args?.limit, 'work_read');
        log(`[oks] work_read ${read.file} · 第 ${read.from} 行起 ${read.lines.length} 行`
          + `（共 ${read.total} 行 · ${(read.bytes / 1024).toFixed(1)} KB）`);
        return { ok: true as const, ...read, entries: [] };
      },
    },
    {
      name: 'work_write',
      description: `Write a UTF-8 text file under ${WORK_DIR}/, creating or overwriting it — the same shape as the usual write tool (file_path / content), except that only ${WORK_DIR}/ is reachable. It is how a jq program gets somewhere a transform can name it: write "${WORK_DIR}/peek.jq" here, then give "byFile": "peek.jq", and edit the program later without resending the whole thing. Parent directories are created. Keep data out of here: rows and tables belong in .oks/data/ via create_data or jq_transform_into.`,
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: `Path under ${WORK_DIR}/, e.g. "analysis.jq" (or "${WORK_DIR}/analysis.jq").` },
          content: { type: 'string', description: 'The text to write — the jq program itself, verbatim.' },
        },
        required: ['file_path', 'content'],
        additionalProperties: false,
      },
      output: { schema: OBJECT_OUTPUT, render: renderWorkWrite },
      async execute(args: WorkWriteArgs, exec: ToolExec) {
        const entry = knowledge.ensureWorkspace(exec);
        const saved = writeWorkFile(entry.settings.workspaceRoot, args?.file_path, args?.content, 'work_write');
        log(`[oks] work_write ${saved.file} · ${(saved.bytes / 1024).toFixed(1)} KB · ${saved.created ? '新建' : '覆盖'}`);
        return { ok: true as const, ...saved };
      },
    },
    {
      name: 'work_edit',
      description: `Replace a literal passage in a text file under ${WORK_DIR}/ — the same shape as the usual edit tool (file_path / old_string / new_string / replace_all), except that only ${WORK_DIR}/ is reachable. It is how a jq program gets iterated: write it once, then fix one line at a time instead of resending the file. old_string must appear in the file exactly as given (whitespace included); it must be unique unless replace_all is true.`,
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: `Path under ${WORK_DIR}/, e.g. "analysis.jq".` },
          old_string: { type: 'string', description: 'The exact text to replace (must occur verbatim).' },
          new_string: { type: 'string', description: 'What to put in its place.' },
          replace_all: { type: 'boolean', description: 'Replace every occurrence instead of requiring uniqueness. Default false.' },
        },
        required: ['file_path', 'old_string', 'new_string'],
        additionalProperties: false,
      },
      output: { schema: OBJECT_OUTPUT, render: renderWorkEdit },
      async execute(args: WorkEditArgs, exec: ToolExec) {
        const entry = knowledge.ensureWorkspace(exec);
        const saved = editWorkFile(entry.settings.workspaceRoot, args?.file_path, args?.old_string,
      args?.new_string, args?.replace_all, 'work_edit');
        log(`[oks] work_edit ${saved.file} · 替换 ${saved.replaced} 处 · ${(saved.bytes / 1024).toFixed(1)} KB`);
        return { ok: true as const, ...saved };
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
