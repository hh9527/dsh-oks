import { basename } from 'node:path';
import { capLine } from './text.ts';
import { windowText } from './config.ts';
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

/** create_data 渲染读到的值（把 agent 自己给的数据落成封装）。 */
export interface CreateDataValue {
  dataSrc: string;
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
  dataSrc: string;
  name: string;
  bytes: number;
  ms: number;
  data: unknown;
}

export function renderCurrentCtx(_args: unknown, value: CurrentCtxValue | null | undefined): RenderBlock[] {
  const lines = [
    `dataSrc:  ${value?.dataSrc ?? ''}`,
    `这份时间上下文：${((value?.bytes ?? 0) / 1024).toFixed(1)} KB · ${value?.ms ?? 0} ms`,
    '把它当具名输入交给 jq_transform，边界就在程序里算（tzadd / tzfloor / tzceil，时区显式传）。',
    '',
    JSON.stringify(value?.data ?? null, null, 2),
  ];
  return [{ type: 'text', text: `${lines.join('\n')}\n` }];
}

/** create_data 的模型可见渲染：落点、形状与尺寸。数据本身不重复——要看就再读一次。 */
export function renderCreateData(_args: unknown, value: CreateDataValue | null | undefined): RenderBlock[] {
  const lines = [
    `dataSrc:  ${value?.dataSrc ?? ''}`,
    `${value?.name ?? '输入数据'}：${value?.shape ?? ''}`
    + ` · ${((value?.bytes ?? 0) / 1024).toFixed(1)} KB · ${value?.ms ?? 0} ms`,
    '来源链里记着这份数据是给定的，动机与它放在一起。',
  ];
  return [{ type: 'text', text: `${lines.join('\n')}\n` }];
}

/** oks_view 渲染读到的值（表格这类展示件）。 */
export interface ViewValue {
  ok?: boolean;
  kind?: string;
  title?: string | null;
  src?: string;
  viewSrc?: string;
  /** 报表正文里用的那一行 `![表注](路径)`。 */
  markdown?: string;
  /** 表本体（表不大时给；大表为 null，只说引用）。 */
  table?: string | null;
  rowCount?: number;
  columns?: readonly string[];
  bytes?: number;
  note?: string | null;
}

/** oks_view 的模型可见回执：先说清"哪一行进报表、哪一段进回答"，再把表本体交出来。 */
export function renderView(_args: unknown, value: ViewValue | null | undefined): RenderBlock[] {
  if (value?.ok !== true) return [{ type: 'text', text: '展示件没有生成。\n' }];
  const lines = [
    `表格：${value.title ?? ''} · ${value.rowCount ?? 0} 行 · 列 ${(value.columns ?? []).join(', ')}`,
    `来自：${value.src ?? ''}`,
    `文件：${value.viewSrc ?? ''}`,
    '',
    '这一行**放进报告正文**（`oks_report` 的 markdown，独占一行）；它不会被渲染成图片，别粘进回答：',
    '',
    value.markdown ?? '',
  ];
  if (typeof value.table === 'string' && value.table !== '') {
    lines.push('', '要在这段回答里显示这张表，直接粘下面这一段：', '', value.table.replace(/\n$/, ''));
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

/** jq_transform 渲染读到的值（探索：只看，不落盘）。 */
export interface TransformValue {
  ok?: boolean;
  snip: string;
  /** 从结果里取回的那一段（jq 点路径）；没给就整个结果都是。 */
  pick?: string;
  /** 这段程序来自哪份代码文件（`byFile` 给出的那一份）。 */
  snipFile?: string;
  /** 省略 `byFile` 时程序是恒等投影：结果是「名字 → 各输入那一段」的对象。 */
  generated?: boolean;
  inputs: ReadonlyArray<{ name: string; src: string; root?: string; shape: string }>;
  /** 表达式产出了几个值。 */
  outputs: number;
  /** 结果本身：恰好一个输出时是那个值，多个输出时是值的数组，零输出时是空数组。 */
  data: unknown;
  truncated: boolean;
  ms: number;
}

/** collect 渲染清理材料的结果。 */
export interface CollectValue {
  ok?: boolean;
  ttlSeconds: number;
  removed: string[];
  removedCount: number;
  freedBytes: number;
  remaining: number;
  kept: number;
}

export function renderCollect(_args: unknown, value: CollectValue | null | undefined): RenderBlock[] {
  if (value?.ok !== true) {
    return textBlock([JSON.stringify(value ?? { ok: false, error: { code: 'collect_failed' } })]);
  }
  const shown = value.removed.slice(0, 20);
  const lines = [
    `清理窗口 ${windowText(value.ttlSeconds / 60)} · 清掉 ${value.removedCount} 份材料`
    + ` · 释放 ${(value.freedBytes / 1024).toFixed(1)} KB · 还剩 ${value.remaining} 份`
    + `（窗口内保留 ${value.kept} 份）`,
    ...shown.map((file) => `  ${file}`),
    value.removed.length > shown.length ? `  …（另有 ${value.removed.length - shown.length} 份）` : '',
    '之前回执里的 dataSrc 若指向被清掉的材料，已经失效——需要时重新取数。',
  ].filter((line) => line !== '');
  return textBlock([lines.join('\n')]);
}

/** work_delete 渲染删除结果。 */
export function renderWorkDelete(_args: unknown, value: { ok?: boolean; file?: string; remaining?: number } | null | undefined): RenderBlock[] {
  if (value?.ok !== true) {
    return textBlock([JSON.stringify(value ?? { ok: false, error: { code: 'work_unwritable' } })]);
  }
  return textBlock([`${value.file ?? ''} · 已删除 · 代码区还剩 ${value.remaining ?? 0} 个文件`]);
}

/** jq_transform_into 渲染读到的值（物化：结果写进 .oks/data/）。 */
export interface IntoValue {
  dataSrc: string;
  name: string;
  outputs: number;
  /** 结果的一行形状描述。 */
  shape: string;
  bytes: number;
  ms: number;
  /** 本次操作与全部上游，按依赖顺序摊开（输入在前）。 */
  chain: readonly string[];
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
      lines.push('（数据行与语句都不在回执里：数据按需用 jq_transform 取，语句在执行记录里）');
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

/** 表达式产出的值，按"一个值还是一个流"摊平：探索与物化共用这一条约定。 */
const streamOf = (value: { outputs?: number; data?: unknown } | null | undefined): unknown[] => {
  if (value === null || value === undefined) return [];
  if (value.outputs === 1) return [value.data];
  return Array.isArray(value.data) ? value.data : [value.data];
};

/** jq_transform 的模型可见渲染：输入、形状、以及按文本预算截断的采样值。
 *  值本身是 agent 用表达式选出来的，所以这一页不需要再约定列与分页。 */
export function renderJqTransform(_args: unknown, value: TransformValue | null | undefined): RenderBlock[] {
  if (value?.ok === false) return textBlock([JSON.stringify(value)]);
  const inputs = value?.inputs ?? [];
  const picked = value?.pick === undefined ? '' : ` · pick ${value.pick}`;
  const from = value?.snipFile === undefined ? '' : ` · 程序来自 ${value.snipFile}`;
  const lines = [
    `表达式产出 ${value?.outputs ?? 0} 个值`
    + `${value?.truncated === true ? '（到达输出上限，已截断）' : ''}${picked}${from} · ${value?.ms ?? 0} ms`,
    // 绑定写清：程序里的名字**就是**那个文件按 root 取出来的那一段（不是"文件在那儿"）。
    ...inputs.map((input) => `输入 ${input.name} ← ${input.src}（取 ${input.root ?? DEFAULT_ROOT}）`
      + ` → 程序里的 ${input.name} 就是这一份：${input.shape}`),
    value?.generated === true
      ? `无程序：结果是「名字 → 各输入那一段」的对象${value.pick === undefined ? '' : `，再取 ${value.pick}`}`
        + `（等价 jq：${value.pick ?? '.'}）`
      : '',
    inputs.length === 0 ? '输入：（无：表达式看到的是 {}）' : '',
    `形状：${shapeOf(value?.data)}`,
  ].filter((line) => line !== '');
  const stream = streamOf(value);
  // 数据接口不截断：值要么完整给出，要么在工具层就报错（见 tools.ts 的 payloadGuard）。
  for (const item of stream) lines.push(compact(item));
  if (stream.length === 0) lines.push('（表达式没有产出值。）');
  return [{ type: 'text', text: `${lines.join('\n')}\n` }];
}

/** jq_transform_into 的模型可见渲染：落点、形状、尺寸，以及完整的来源链。
 *  值不在这里重复——它已经落在文件里，要看就再探索一次（jq_transform）。 */
export function renderJqInto(_args: unknown, value: IntoValue | null | undefined): RenderBlock[] {
  const lines = [
    `dataSrc:  ${value?.dataSrc ?? ''}`,
    `${value?.name ?? '加工结果'}：表达式产出 ${value?.outputs ?? 0} 个值 · ${value?.shape ?? ''}`
    + ` · ${((value?.bytes ?? 0) / 1024).toFixed(1)} KB · ${value?.ms ?? 0} ms`,
    '来源链（输入在前，本次操作在最后）：',
    ...(value?.chain ?? []).map((line) => `  ${line}`),
  ];
  return [{ type: 'text', text: `${lines.join('\n')}\n` }];
}
