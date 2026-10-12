import { basename } from 'node:path';
import { capLine } from './text.ts';
import type { DiagnosticEntry, OkPayload, RenderBlock, ServiceResponse, TraceStep } from './host.ts';

// 模型可见文本的预算：留在宿主 tool-result pruner 的阈值（8192 字符）以下，否则结果会被
// 从**中间**截掉，反而同时丢掉 SQL 和一部分行。
const RESULT_BUDGET_CHARS = 6000;
const RESULT_MAX_COLUMNS = 32;
const RESULT_MAX_CELL_CHARS = 200;
const SQL_DISPLAY_CHARS = 1200;
const BINDINGS_DISPLAY_CHARS = 400;
const REQUEST_DISPLAY_CHARS = 300;

export const OBJECT_OUTPUT = { type: 'object', additionalProperties: true };

/** 一行结果 / 一条诊断之外的动态对象：字段名由服务或词汇表声明。 */
export interface Row {
  [key: string]: unknown;
}

/** 命名批次里的一项 Intent（渲染只用到名字与原文）。 */
export interface NamedIntentView {
  name: string;
  intent: unknown;
}

/** oks_check_intent 渲染读到的值。 */
export interface CheckValue {
  trace?: readonly TraceStep[] | null;
  intents?: readonly NamedIntentView[] | null;
  results?: ReadonlyArray<{
    name: string;
    accepted: boolean;
    key: string | null;
    diagnostics: readonly DiagnosticEntry[];
  }> | null;
  diagnostics?: readonly DiagnosticEntry[] | null;
  subset?: { indexes: number[]; accepted: boolean } | null;
  queryCount?: number | null;
}

/** 渲染层看到的 oks_query 一项：只有结构，没有数据行。 */
export interface QueryResult {
  name: string;
  index: number;
  status: string;
  dataSrc: string | null;
  columns: ReadonlyArray<{ name: string; types: string[]; nullable: boolean }>;
  rowCount: number | null;
  sql: unknown;
  bindings: unknown;
  truncated: boolean;
  ms: number | null;
  error: unknown;
}

/** oks_query 渲染读到的值。 */
export interface QueryValue {
  trace?: readonly TraceStep[] | null;
  intents?: readonly NamedIntentView[] | null;
  diagnostics?: readonly DiagnosticEntry[] | null;
  results?: readonly QueryResult[] | null;
  dataFile: string;
  queryMaxRows: number;
  window?: { start: string; endExclusive: string } | null;
}

/** oks_jaq_result 渲染读到的值。 */
export interface JaqValue {
  src: string;
  name: string;
  /** 输入的行数（结果文件里的全部行）。 */
  totalRows: number;
  /** 表达式产出的值个数。 */
  returned: number;
  /** 输出是否到达上限而被截断。 */
  truncated: boolean;
  /** 表达式产出的值（每个已经是一个 JSON 值）。 */
  result: readonly unknown[];
}

/** oks_info 渲染读到的值。 */
export interface JsonValue {
  trace?: readonly TraceStep[] | null;
}

/** 一张有预算的表：lines 之外还带 notes 时才算截断说明。 */
interface Table {
  lines: string[];
  truncated: boolean;
  notes?: string[];
}

function summarize(response: ServiceResponse | undefined): string {
  if (response?.error === true) {
    const count = Array.isArray(response.diagnostics) ? response.diagnostics.length : 0;
    return `error=true · ${count} diagnostic(s)`;
  }
  const ok: OkPayload = response?.ok ?? {};
  if (ok.Document !== undefined) {
    const document = ok.Document;
    if (typeof document === 'string') return `error=false · Document=${document}`;
    const found = document?.Found;
    const shape = Object.keys(document ?? {})[0] ?? 'Document';
    const detail = found?.detail;
    // 只报"收回了什么形状"，不解释字段含义——字段语义由节点自己的 description 讲。
    if (detail !== null && typeof detail === 'object') {
      const parts = Object.entries(detail).map(([k, v]) => {
        if (Array.isArray(v)) return `${k}#${v.length}`;
        if (v !== null && typeof v === 'object') return `${k}={…}`;
        return `${k}=${String(v)}`;
      }).join(' ');
      return `error=false · Document=${shape} · ${found?.type ?? '?'}${parts === '' ? '' : ` · ${parts}`}`;
    }
    return `error=false · Document=${shape} · ${found?.type ?? '?'}`;
  }
  if (ok.accepted !== undefined) {
    // 批次级诊断：成功路径也可能带 Warning，所以要分别数 error / warning。
    const diagnostics: readonly DiagnosticEntry[] = Array.isArray(ok.diagnostics) ? ok.diagnostics : [];
    const errors = diagnostics.filter((item) => item?.diagnostic?.severity === 'Error').length;
    const warnings = diagnostics.filter((item) => item?.diagnostic?.severity === 'Warning').length;
    const parts = ['error=false', `accepted=${ok.accepted}`, `errors=${errors}`, `warnings=${warnings}`];
    // 校验路径会把 queries 摘掉（那是 SQL/bindings），所以这里只在真的有 queries 时才报数量。
    if (Array.isArray(ok.queries)) parts.push(`queries=${ok.queries.length}`);
    return parts.join(' · ');
  }
  return 'error=false';
}

/** 校验路径的响应：**摘掉 queries**。SQL/bindings 只在 oks_query 的结果里出现，
 *  而轨迹里的响应会被工具卡与宿主日志留存，所以这里必须真的摘掉，不能只靠渲染不打印。 */
export function withoutQueries(response: ServiceResponse): ServiceResponse {
  const ok = response?.ok;
  if (ok === null || typeof ok !== 'object') return response;
  const { queries: _queries, ...rest } = ok;
  return { ...response, ok: rest };
}

/** 过程轨迹：让工具卡自己呈现「发了什么、收回了什么」。
 *  请求回显只留一小段——Intent 批次可能很长，而写它的人正是读它的模型。 */
function renderTrace(trace: readonly TraceStep[] | null | undefined): string[] {
  const lines: string[] = [];
  for (const step of trace ?? []) {
    const note = step.note ? `  （${step.note}）` : '';
    lines.push(`▸ OKS ${step.method}${note}`);
    lines.push(`  请求 ${capLine(JSON.stringify(step.request), REQUEST_DISPLAY_CHARS)}`);
    lines.push(`◂ OKS ${step.method}  ${summarize(step.response)}`);
  }
  return lines;
}

/** 纯计算类工具（不经过 OKS）的渲染：直接给结构化结果。 */
export function renderValue(_args: unknown, value: unknown): RenderBlock[] {
  return [{ type: 'text', text: `${JSON.stringify(value, null, 2)}\n` }];
}

/** 渲染不做形状分类：同一套 JSON 通道对任何节点都成立。 */
export function renderJson(_args: unknown, value: JsonValue | null | undefined): RenderBlock[] {
  const lines = renderTrace(value?.trace);
  lines.push('', JSON.stringify(value?.trace?.[0]?.response ?? value, null, 2));
  return [{ type: 'text', text: `${lines.join('\n')}\n` }];
}

/** 诊断段：批次级诊断必须全列——成功的 Intent 也可能带 Warning。 */
function diagnosticLines(diagnostics: readonly DiagnosticEntry[] | null | undefined): string[] {
  const lines: string[] = [];
  if (!Array.isArray(diagnostics) || diagnostics.length === 0) return lines;
  lines.push('', '诊断（批次级；成功的 Intent 也可能带 Warning）');
  for (const item of diagnostics) {
    const severity = item?.diagnostic?.severity ?? '?';
    const mark = severity === 'Error' ? '✕' : severity === 'Warning' ? '⚠' : '·';
    lines.push(`  #${(item?.index ?? 0) + 1}  ${mark} ${severity} — ${item?.diagnostic?.message ?? JSON.stringify(item)}`);
  }
  return lines;
}

const rejectedIndexes = (diagnostics: readonly DiagnosticEntry[] | null | undefined): number[] =>
  [...new Set((diagnostics ?? [])
    .filter((item) => item?.diagnostic?.severity === 'Error')
    .map((item) => item.index))].sort((left, right) => left - right);

/** oks_check_intent 的模型可见渲染：结论按名字给，通过项带 key，**没有 SQL**。 */
export function renderCheck(_args: unknown, value: CheckValue | null | undefined): RenderBlock[] {
  const lines = renderTrace(value?.trace);
  const items = value?.intents ?? [];
  const results = value?.results ?? [];
  lines.push(...diagnosticLines(value?.diagnostics));
  const subset = value?.subset;
  if (subset) {
    lines.push('', `再校验一次（把没有报 Error 的 ${subset.indexes.length} 个 Intent 单独提交）：`
      + `${subset.accepted ? '通过' : '仍被拒'}`);
  }
  const accepted = results.filter((result) => result.accepted);
  if (accepted.length > 0) {
    lines.push('', '通过校验的项（key 是这一项 Intent 的标识，提交查询时原样带回）：');
    for (const result of accepted) lines.push(`  ${result.name}  key=${result.key}`);
  }
  for (const result of results) {
    if (result.accepted) continue;
    const item = items.find((candidate) => candidate.name === result.name);
    lines.push('', `── ${result.name} — 被拒绝 ──`);
    lines.push(`intent:   ${capLine(JSON.stringify(item?.intent), 600)}`);
    for (const diagnostic of result.diagnostics) {
      lines.push(`诊断:     ${diagnostic?.diagnostic?.severity ?? '?'} — ${diagnostic?.diagnostic?.message ?? JSON.stringify(diagnostic)}`);
    }
  }
  const runnable = value?.queryCount ?? 0;
  lines.push('', results.length > 0 && accepted.length === results.length
    ? `校验结论：${results.length} 个 Intent 全部可用（${runnable} 个查询可执行）。用 oks_query 带同一批名字与各自的 key 提交就能拿到结果。`
    : `校验结论：${accepted.length}/${results.length} 可用（${runnable} 个查询可执行）。用 oks_info 按服务给出的 key 读它声明的词汇再修，保持业务含义不变。`);
  return [{ type: 'text', text: `${lines.join('\n')}\n` }];
}

/** 一个单元格的文本：整表渲染与「按预算装页」共用，两边算出的长度必须一致。 */
function cellText(value: unknown): string {
  const text = value === null || value === undefined ? 'NULL'
    : typeof value === 'bigint' ? value.toString()
      : typeof value === 'object' ? JSON.stringify(value)
        : String(value);
  return (text.length > RESULT_MAX_CELL_CHARS ? `${text.slice(0, RESULT_MAX_CELL_CHARS)}…` : text)
    .replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

/** 一行表格的文本（整表与读取页共用）。 */
const tableLine = (row: Row, columns: readonly string[]): string =>
  `| ${columns.map((column) => cellText(row[column])).join(' | ')} |`;

/** 一张有预算的表：列数、单元格长度、行数都受限，截断要写明。 */
function renderTable(rows: readonly Row[] | null | undefined, budget: number): Table {
  if (!Array.isArray(rows) || rows.length === 0) return { lines: ['结果：0 行'], truncated: false };
  const allColumns = Object.keys(rows[0] ?? {});
  const columns = allColumns.slice(0, RESULT_MAX_COLUMNS);
  const lines = [`| ${columns.join(' | ')} |`, `| ${columns.map(() => '---').join(' | ')} |`];
  let used = lines.reduce((total, line) => total + line.length + 1, 0);
  let shown = 0;
  let truncated = false;
  for (const row of rows) {
    const line = tableLine(row, columns);
    if (used + line.length > budget) { truncated = true; break; }
    lines.push(line);
    used += line.length + 1;
    shown += 1;
  }
  const notes: string[] = [];
  if (allColumns.length > columns.length) notes.push(`只显示前 ${columns.length} 列（共 ${allColumns.length} 列）`);
  if (truncated) notes.push(`只显示前 ${shown} 行（共 ${rows.length} 行）`);
  return { lines, truncated, notes };
}

/** oks_query 的模型可见渲染：轨迹 → 诊断 → 每项的**结构回执**（没有数据行，也没有语句）。
 *  数据行只在结果文件里；SQL 与 bindings 只在宿主呈现记录（presentationMeta）与调用记录里，
 *  不重复进这段对话。 */
export function renderQuery(_args: unknown, value: QueryValue | null | undefined): RenderBlock[] {
  const lines = renderTrace(value?.trace);
  for (const line of diagnosticLines(value?.diagnostics)) lines.push(line);
  const items = value?.intents ?? [];
  for (const result of value?.results ?? []) {
    lines.push('', `── ${result.name}（intent #${result.index + 1}）──`);
    if (result.status === 'saved') {
      lines.push(`status:   saved · ${result.rowCount} 行 · ${result.ms} ms`
        + `${result.truncated ? `（已到行数上限 ${value!.queryMaxRows}，结果还有更多）` : ''}`);
      lines.push(`dataSrc:  ${result.dataSrc}`);
      lines.push(`columns:  ${result.columns.map((column) => `${column.name}:${column.types.join('|')}`).join(', ')}`);
      lines.push('（数据行与语句都不在回执里：数据按需用 oks_jaq_result 取，语句在执行记录里）');
      if (result.rowCount === 0 && value?.window) {
        lines.push(`提示：这份数据的窗口是 [${value.window.start}, ${value.window.endExclusive})，被过滤掉的可能是时间落在窗口之外。`);
      }
      continue;
    }
    if (result.error !== null && result.error !== undefined) {
      lines.push(`status:   ${result.status} — ${result.error}`);
      continue;
    }
    lines.push(`status:   ${result.status}`);
    if (result.status === 'rejected') {
      const item = items.find((candidate) => candidate.name === result.name);
      lines.push(`intent:   ${capLine(JSON.stringify(item?.intent), 600)}`);
    }
  }
  const results = value?.results ?? [];
  if (results.length === 0) {
    lines.push('', '没有可执行的查询。');
  } else if (results.every((result) => result.status !== 'saved')) {
    lines.push('', '没有任何 Intent 执行成功。按上面的原因修好后再提交。');
  }
  return [{ type: 'text', text: `${lines.join('\n')}\n` }];
}

/** oks_chart 渲染读到的值。 */
export interface ChartValue {
  ok?: boolean;
  kind?: string;
  title?: string | null;
  source?: string;
  src?: string | null;
  svgSrc?: string;
  markdown?: string;
  at?: string;
  note?: string | null;
  rowCount?: number;
  columns?: readonly string[];
}

/** oks_chart 的模型可见回执：图已经落成 SVG，这里把「可以直接粘进回答的那一行」交给 agent。
 *  回执本身不带数据行、也不带图。 */
export function renderChart(_args: unknown, value: ChartValue | null | undefined): RenderBlock[] {
  if (value?.ok !== true) return [{ type: 'text', text: '图表没有生成。\n' }];
  const lines = [
    `图表：${value.kind ?? '?'}${value.title === null || value.title === undefined ? '' : ` · ${value.title}`}`,
    `来源：${value.source === 'query' ? '基于查询结果' : 'agent 自主填写'}`,
    `数据：${value.rowCount ?? 0} 行 · 列 ${(value.columns ?? []).join(', ')}`,
    `文件：${value.svgSrc ?? ''}`,
  ];
  if (value.src !== null && value.src !== undefined) lines.push(`来自：${value.src}`);
  if (value.note !== null && value.note !== undefined) lines.push(`说明：${value.note}`);
  lines.push(
    '',
    '把下面这一行原样放进你的回答，图就会显示在那里（不要改写路径）：',
    '',
    value.markdown ?? '',
  );
  return [{ type: 'text', text: `${lines.join('\n')}\n` }];
}

/** 一个值的一行紧凑渲染：字符串原样，其余交给 JSON。 */
function compact(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string') return value;
  if (typeof value === 'bigint') return value.toString();
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/** oks_jaq_result 的模型可见渲染：一条摘要 + 逐值紧凑渲染，整体落在文本预算内。
 *  值本身是 agent 用表达式选出来的，所以这一页不需要再约定列与分页。 */
export function renderJaq(_args: unknown, value: JaqValue | null | undefined): RenderBlock[] {
  const result = value?.result ?? [];
  const lines = [
    `${value?.name ?? '结果'}：输入 ${value?.totalRows ?? 0} 行 · 表达式产出 ${value?.returned ?? 0} 个值`
    + `${value?.truncated === true ? '（到达输出上限，已截断）' : ''}`,
    `src:      ${value?.src ?? ''}`,
  ];
  let used = lines.reduce((sum, line) => sum + line.length + 1, 0);
  let shown = 0;
  for (const item of result) {
    const text = compact(item);
    if (used + text.length + 1 > RESULT_BUDGET_CHARS) break;
    lines.push(text);
    used += text.length + 1;
    shown += 1;
  }
  if (result.length === 0) lines.push('（表达式没有产出值。）');
  else if (shown < result.length) {
    lines.push(`（还有 ${result.length - shown} 个值没放进这段回执：用更精确的表达式或投影缩小结果。）`);
  }
  return [{ type: 'text', text: `${lines.join('\n')}\n` }];
}
