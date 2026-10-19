import type { XhtmlError } from './report/xhtml.ts';
import { basename } from 'node:path';
import { capLine } from './text.ts';
import { DEFAULT_ROOT } from './results.ts';
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

/** oks_check_query_intent 渲染读到的值。 */
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

/** 渲染层看到的 oks_exec_query_intent 一项：只有结构，没有数据行。 */
export interface QueryResult {
  name: string;
  index: number;
  status: string;
  asset: string | null;
  columns: ReadonlyArray<{ name: string; types: string[]; nullable: boolean }>;
  rowCount: number | null;
  sql: unknown;
  bindings: unknown;
  truncated: boolean;
  ms: number | null;
  error: unknown;
}

/** oks_exec_query_intent 渲染读到的值。 */
export interface QueryValue {
  trace?: readonly TraceStep[] | null;
  intents?: readonly NamedIntentView[] | null;
  diagnostics?: readonly DiagnosticEntry[] | null;
  results?: readonly QueryResult[] | null;
  dataFile: string;
  queryMaxRows: number;
  window?: { start: string; endExclusive: string } | null;
}

/** create_data 渲染读到的值（把 agent 自己给的数据落成封装）。 */
export interface CreateDataValue {
  asset: string;
  name: string;
  shape: string;
  bytes: number;
  ms: number;
}

/**
 * create_current_ctx_data 的模型可见渲染：落点 + 这份上下文**本身**。
 * 时间基准就是要一眼看得见（现在几点、哪个时区、来源是哪一层），否则每写一个边界都得再读一次文件。
 */
export interface CurrentCtxValue {
  asset: string;
  name: string;
  bytes: number;
  ms: number;
  data: unknown;
}

export function renderCurrentCtx(_args: unknown, value: CurrentCtxValue | null | undefined): RenderBlock[] {
  const lines = [
    `asset:  ${value?.asset ?? ''}`,
    `这份时间上下文：${((value?.bytes ?? 0) / 1024).toFixed(1)} KB · ${value?.ms ?? 0} ms`,
    '把它以 ctx 加载到 oks_data，用 builtin://time/windows.jq 计算带毫秒值与 RFC3339 的窗口；参数与示例见 oks://help/time。',
    '',
    JSON.stringify(value?.data ?? null, null, 2),
  ];
  return [{ type: 'text', text: `${lines.join('\n')}\n` }];
}

/** create_data 的模型可见渲染：落点、形状与尺寸。数据本身不重复——要看就再读一次。 */
export function renderCreateData(_args: unknown, value: CreateDataValue | null | undefined): RenderBlock[] {
  const lines = [
    `asset:  ${value?.asset ?? ''}`,
    `${value?.name ?? '输入数据'}：${value?.shape ?? ''}`
    + ` · ${((value?.bytes ?? 0) / 1024).toFixed(1)} KB · ${value?.ms ?? 0} ms`,
    '来源链里记着这份数据是给定的，动机与它放在一起。',
  ];
  return [{ type: 'text', text: `${lines.join('\n')}\n` }];
}

/** oks_render_figure 渲染读到的表格值。 */
export interface ViewValue {
  ok?: boolean;
  kind?: string;
  title?: string | null;
  /** 这份表读的那份封装数据（引用）。 */
  src?: string;
  /** 产出位置：可当输入被引用，也可被 present（与 `embedded` 平行的一对）。 */
  asset?: string;
  /** 粘进回答就显示的那一段：图是一条图片行，表是 markdown 表本体（大表为 null）。 */
  embedded?: string | null;
  rowCount?: number;
  columns?: readonly string[];
  bytes?: number;
  note?: string | null;
}

/** 表格的模型可见回执：交回落成的那份表，以及可以直接粘进回答的表本体。 */
export function renderView(_args: unknown, value: ViewValue | null | undefined): RenderBlock[] {
  if (value?.ok !== true) return [{ type: 'text', text: '展示件没有生成。\n' }];
  const lines = [
    `表格：${value.title ?? ''} · ${value.rowCount ?? 0} 行 · 列 ${(value.columns ?? []).join(', ')}`,
    `文件：${value.asset ?? ''}`,
    `来自：${value.src ?? ''}`,
  ];
  if (typeof value.embedded === 'string' && value.embedded !== '') {
    lines.push('', '要在这段回答里显示这张表，把下面这一段粘进回答：', '', value.embedded.replace(/\n$/, ''));
  } else {
    lines.push('', `（表有 ${value.rowCount ?? 0} 行，正文形式没有放进这段回执：`
      + '要在这里显示就先聚合或缩小范围，再出一张更小的表。）');
  }
  if (value.note !== null && value.note !== undefined) lines.push('', `说明：${value.note}`);
  return [{ type: 'text', text: `${lines.join('\n')}\n` }];
}

const textBlock = (lines: readonly string[]): RenderBlock[] => [{ type: 'text', text: `${lines.join('\n')}\n` }];

/** work_read：`.work/` 下的文件正文（带行号）或目录清单。
 *  分页是明说的：给出"共 N 行、这是第 from 行起"，不是悄悄截断。 */
export interface WorkReadValue {
  ok?: boolean;
  file?: string;
  entries?: ReadonlyArray<{ name: string; bytes: number; modifiedAt: string }>;
  lines?: readonly string[];
  from?: number;
  total?: number;
  bytes?: number;
}

export function renderWorkRead(_args: unknown, value: WorkReadValue | null | undefined): RenderBlock[] {
  if (value?.ok !== true) return textBlock([JSON.stringify(value ?? { ok: false, error: { code: 'work_unreadable' } })]);
  const entries = value.entries ?? [];
  if (entries.length > 0 || (value.lines ?? []).length === 0) {
    const lines = [`${value.file ?? ''}：${entries.length} 个文件`];
    for (const entry of entries) lines.push(`  ${entry.name} · ${entry.bytes} B · ${entry.modifiedAt}`);
    if (entries.length === 0) lines.push(`（${value.file ?? ''} 里还没有文件：用 work_write 建一份。）`);
    return textBlock(lines);
  }
  const from = value.from ?? 1;
  const shown = value.lines ?? [];
  const total = value.total ?? 0;
  const width = String(from + shown.length - 1).length;
  const lines = [
    `${value.file ?? ''} · 共 ${total} 行 · ${((value.bytes ?? 0) / 1024).toFixed(1)} KB`
    + `（这里是第 ${from}–${from + shown.length - 1} 行）`,
    ...shown.map((line, at) => `${String(from + at).padStart(width, ' ')}  ${line}`),
  ];
  if (from + shown.length - 1 < total) {
    lines.push(`…（还有 ${total - (from + shown.length - 1)} 行：用 offset 从第 ${from + shown.length} 行继续）`);
  }
  return textBlock(lines);
}

/** work_write / work_edit：落点与尺寸。 */
export interface WorkWriteValue {
  ok?: boolean;
  file?: string;
  bytes?: number;
  created?: boolean;
  replaced?: number;
}

export function renderWorkWrite(_args: unknown, value: WorkWriteValue | null | undefined): RenderBlock[] {
  if (value?.ok !== true) return textBlock([JSON.stringify(value ?? { ok: false, error: { code: 'work_unwritable' } })]);
  return textBlock([`${value.file ?? ''} · ${value.created === true ? '已创建' : '已覆盖'} · ${value.bytes ?? 0} B`]);
}

export function renderWorkEdit(_args: unknown, value: WorkWriteValue | null | undefined): RenderBlock[] {
  if (value?.ok !== true) return textBlock([JSON.stringify(value ?? { ok: false, error: { code: 'work_unwritable' } })]);
  return textBlock([`${value.file ?? ''} · 已替换 ${value.replaced ?? 0} 处 · 现在 ${value.bytes ?? 0} B`]);
}

/** 加工读取回执。 */
export interface TransformValue {
  ok?: boolean;
  data: unknown;
}

/** work_delete 渲染删除结果。 */
export function renderWorkDelete(_args: unknown, value: { ok?: boolean; file?: string; remaining?: number } | null | undefined): RenderBlock[] {
  if (value?.ok !== true) {
    return textBlock([JSON.stringify(value ?? { ok: false, error: { code: 'work_unwritable' } })]);
  }
  return textBlock([`${value.file ?? ''} · 已删除 · 代码区还剩 ${value.remaining ?? 0} 个文件`]);
}

/** oks_data（save 那条路）渲染读到的值：结果写进 .oks/data/。 */
/** 物化回执包含落点、大小与执行方式；值和来源链保存在文件里。 */
export interface IntoValue {
  asset: string;
  bytes: number;
  execution?: { method: 'jq' | 'project' | 'identity'; src?: string };
}

/** 将结构化值渲染成 JSON。 */
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

/** 校验路径的响应：**摘掉 queries**。SQL/bindings 只在 oks_exec_query_intent 的结果里出现，
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

/** oks_artifacts 的回执：清单本身（最新在前）。界面里是双行块，这里一行一条就够。 */
export interface ArtifactsValue {
  ok?: boolean;
  keepAliveMinutes?: number;
  entries?: Array<{ title?: string; kind?: string; at?: string; file?: string; pinned?: boolean }>;
}

export function renderArtifacts(_args: unknown, value: ArtifactsValue | null | undefined): RenderBlock[] {
  if (value?.ok !== true) return [{ type: 'text', text: '拿不到清单。\n' }];
  const entries = value.entries ?? [];
  if (entries.length === 0) return [{ type: 'text', text: '这个工作区还没有图或报告。\n' }];
  const pinned = entries.filter((entry) => entry.pinned === true).length;
  const lines = [`${entries.length} 条产物（最新在前，其中保留 ${pinned} 条）：`, ''];
  for (const entry of entries.slice(0, 40)) {
    lines.push(`${entry.pinned === true ? '★' : '·'} ${entry.title ?? ''}`);
    lines.push(`    ${entry.kind === 'report' ? '报告' : '图表'} · ${entry.at ?? ''} · ${entry.file ?? ''}`);
  }
  if (entries.length > 40) lines.push(`… 还有 ${entries.length - 40} 条（界面里能看全）`);
  return [{ type: 'text', text: `${lines.join('\n')}\n` }];
}

export function renderValue(_args: unknown, value: unknown): RenderBlock[] {
  return [{ type: 'text', text: `${JSON.stringify(value, null, 2)}\n` }];
}

/** 同类报表错误集中展示，保留每个出错元素的位置。 */
export function renderReportCheck(_args: unknown, value: { errors: XhtmlError[]; [key: string]: unknown }): RenderBlock[] {
  const groups = new Map<string, { code: string; message: string; locations: Array<{ line: number; column: number; element: string | null }> }>();
  for (const { code, message, line, column, element } of value.errors) {
    const key = JSON.stringify([code, message]);
    let group = groups.get(key);
    if (!group) {
      group = { code, message, locations: [] };
      groups.set(key, group);
    }
    group.locations.push({ line, column, element });
  }
  return renderValue(_args, { ...value, errors: [...groups.values()] });
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

/** oks_check_query_intent 的模型可见渲染：结论按名字给，通过项带 key，**没有 SQL**。 */
export function renderCheck(_args: unknown, value: CheckValue | null | undefined): RenderBlock[] {
  const items = value?.intents ?? [];
  const results = value?.results ?? [];
  const passed = results.filter((result) => result.accepted).map((result) => result.name);
  const failed = results.filter((result) => !result.accepted).map((result) => result.name);
  const lines = [`校验摘要：通过 ${passed.length} 项（${passed.join(', ') || '无'}）；未通过 ${failed.length} 项（${failed.join(', ') || '无'}）。`,
    ...renderTrace(value?.trace)];
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
    ? `校验结论：${results.length} 个 Intent 全部可用（${runnable} 个查询可执行）。用 oks_exec_query_intent 带同一批名字与各自的 key 提交就能拿到结果。`
    : `校验结论：${accepted.length}/${results.length} 可用（${runnable} 个查询可执行）。用 oks_data 以 load={knowledge:"knowledge://"} 加载，在 .knowledge 下按返回的 key 读声明再修；查询语法通过 oks://help/query 读取，保持业务含义不变。`);
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

/** oks_exec_query_intent 的模型可见渲染：轨迹 → 诊断 → 每项的**结构回执**（没有数据行，也没有语句）。
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
      lines.push(`asset:  ${result.asset}`);
      lines.push(`columns:  ${result.columns.map((column) => `${column.name}:${column.types.join('|')}`).join(', ')}`);
      lines.push('（数据行与语句都不在回执里：数据按需用 oks_data 取，语句在执行记录里）');
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

/** oks_render_figure 渲染读到的值（图这一路）。 */
export interface ChartValue {
  ok?: boolean;
  kind?: string;
  title?: string | null;
  /** 这份图读的那份封装数据（引用）。 */
  src?: string | null;
  /** 产出位置：可当输入被引用，也可被 present（与 `embedded` 平行的一对）。 */
  asset?: string;
  /** 可直接粘进回答的那一段。 */
  embedded?: string;
  at?: string;
  note?: string | null;
  rowCount?: number;
  columns?: readonly string[];
}

/** 图的模型可见回执：图已经落成 SVG，这里把「可以直接粘进回答的那一行」交给 agent。
 *  回执本身不带数据行、也不带图。 */
export function renderChart(_args: unknown, value: ChartValue | null | undefined): RenderBlock[] {
  if (value?.ok !== true) return [{ type: 'text', text: '图表没有生成。\n' }];
  const lines = [
    `图表：${value.kind ?? '?'}${value.title === null || value.title === undefined ? '' : ` · ${value.title}`}`,
    `数据：${value.rowCount ?? 0} 行 · 列 ${(value.columns ?? []).join(', ')}`,
    `文件：${value.asset ?? ''}`,
    `来自：${value.src ?? ''}`,
  ];
  if (value.note !== null && value.note !== undefined) lines.push(`说明：${value.note}`);
  lines.push(
    '',
    '要在这段回答里显示这张图，把下面这一行粘进回答（路径不要改写）：',
    '',
    value.embedded ?? '',
  );
  return [{ type: 'text', text: `${lines.join('\n')}\n` }];
}

/** oks_render_figure 的模型可见回执：表格与图各自的说辞不一样，按实际产出的是哪一种分派。 */
export function renderFigure(args: unknown, value: unknown): RenderBlock[] {
  const kind = (value as { kind?: unknown } | null | undefined)?.kind;
  return kind === 'table'
    ? renderView(args, value as ViewValue | null | undefined)
    : renderChart(args, value as ChartValue | null | undefined);
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

/** 一个 JSON 值的一行形状描述：先让 agent 认出"这是什么形状"，值本身另有采样。
 *  深层的细节不去猜——它由那段程序决定，要看就读一次。 */
export function shapeOf(value: unknown): string {
  if (Array.isArray(value)) {
    const keys = [...new Set(value.flatMap((item) => (
      item !== null && typeof item === 'object' && !Array.isArray(item) ? Object.keys(item) : []
    )))];
    const fields = keys.slice(0, 12).join(', ');
    return `数组 ${value.length} 项`
      + (keys.length === 0 ? '' : ` · 每项字段 ${fields}${keys.length > 12 ? ' …' : ''}`);
  }
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value);
    return `对象 · 字段 ${keys.slice(0, 12).join(', ')}${keys.length > 12 ? ' …' : ''}`;
  }
  if (value === null) return 'null';
  if (typeof value === 'string') return `字符串（${value.length} 字符）`;
  return `标量（${typeof value}）`;
}

/** 加工查看结果完整输出 JSON；预算由工具与宿主统一约束。 */
export function renderJqTransform(args: unknown, value: TransformValue | null | undefined): RenderBlock[] {
  return renderValue(args, value);
}

/** oks_data：失败保留完整错误；成功时按查看或保存模式渲染。 */
export function renderJqResult(args: unknown, value: unknown): RenderBlock[] {
  if ((value as { ok?: unknown } | null | undefined)?.ok === false) return renderValue(args, value);
  const saved = (args as { save?: unknown } | null | undefined)?.save !== undefined;
  return saved
    ? renderJqInto(args, value as IntoValue | null | undefined)
    : renderJqTransform(args, value as TransformValue | null | undefined);
}

/** 物化（save）的模型可见回执：落点、大小与执行方式。
 *  值与来源链通过 oks_data 普通资源和 #meta 读取。 */
export function renderJqInto(args: unknown, value: IntoValue | null | undefined): RenderBlock[] {
  if (typeof value?.asset !== 'string' || value.asset === '' || typeof value.bytes !== 'number') {
    return renderValue(args, value);
  }
  const size = `${(value.bytes / 1024).toFixed(1)} KB`;
  const execution = value.execution;
  const detail = execution === undefined ? ''
    : `execution: ${execution.method}${execution.src === undefined ? '' : ` · ${execution.src}`}\n`;
  return [{ type: 'text', text: `asset:  ${value.asset} · ${size}\n${detail}` }];
}
