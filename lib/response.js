import { basename } from 'node:path';
import { capLine } from './text.js';

// 模型可见文本的预算：留在宿主 tool-result pruner 的阈值（8192 字符）以下，否则结果会被
// 从**中间**截掉，反而同时丢掉 SQL 和一部分行。
const RESULT_BUDGET_CHARS = 6000;
const RESULT_MAX_COLUMNS = 32;
const RESULT_MAX_CELL_CHARS = 200;
const SQL_DISPLAY_CHARS = 1200;
const BINDINGS_DISPLAY_CHARS = 400;
const REQUEST_DISPLAY_CHARS = 300;

export const OBJECT_OUTPUT = { type: 'object', additionalProperties: true };

function summarize(response) {
  if (response?.error === true) {
    const count = Array.isArray(response.diagnostics) ? response.diagnostics.length : 0;
    return `error=true · ${count} diagnostic(s)`;
  }
  const ok = response?.ok ?? {};
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
    const diagnostics = Array.isArray(ok.diagnostics) ? ok.diagnostics : [];
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
export function withoutQueries(response) {
  const ok = response?.ok;
  if (ok === null || typeof ok !== 'object') return response;
  const { queries: _queries, ...rest } = ok;
  return { ...response, ok: rest };
}

/** 过程轨迹：让工具卡自己呈现「发了什么、收回了什么」。
 *  请求回显只留一小段——Intent 批次可能很长，而写它的人正是读它的模型。 */
function renderTrace(trace) {
  const lines = [];
  for (const step of trace ?? []) {
    const note = step.note ? `  （${step.note}）` : '';
    lines.push(`▸ OKS ${step.method}${note}`);
    lines.push(`  请求 ${capLine(JSON.stringify(step.request), REQUEST_DISPLAY_CHARS)}`);
    lines.push(`◂ OKS ${step.method}  ${summarize(step.response)}`);
  }
  return lines;
}

/** 纯计算类工具（不经过 OKS）的渲染：直接给结构化结果。 */
export function renderValue(_args, value) {
  return [{ type: 'text', text: `${JSON.stringify(value, null, 2)}\n` }];
}

/** 渲染不做形状分类：同一套 JSON 通道对任何节点都成立。 */
export function renderJson(_args, value) {
  const lines = renderTrace(value?.trace);
  lines.push('', JSON.stringify(value?.trace?.[0]?.response ?? value, null, 2));
  return [{ type: 'text', text: `${lines.join('\n')}\n` }];
}

/** 诊断段：批次级诊断必须全列——成功的 Intent 也可能带 Warning。 */
function diagnosticLines(diagnostics) {
  const lines = [];
  if (!Array.isArray(diagnostics) || diagnostics.length === 0) return lines;
  lines.push('', '诊断（批次级；成功的 Intent 也可能带 Warning）');
  for (const item of diagnostics) {
    const severity = item?.diagnostic?.severity ?? '?';
    const mark = severity === 'Error' ? '✕' : severity === 'Warning' ? '⚠' : '·';
    lines.push(`  #${(item?.index ?? 0) + 1}  ${mark} ${severity} — ${item?.diagnostic?.message ?? JSON.stringify(item)}`);
  }
  return lines;
}

const rejectedIndexes = (diagnostics) => [...new Set((diagnostics ?? [])
  .filter((item) => item?.diagnostic?.severity === 'Error')
  .map((item) => item.index))].sort((left, right) => left - right);

/** oks_check_intent 的模型可见渲染：只有校验结论与诊断，**没有 SQL**。 */
export function renderCheck(_args, value) {
  const lines = renderTrace(value?.trace);
  const intents = value?.intents ?? [];
  lines.push(...diagnosticLines(value?.diagnostics));
  if (value?.subset) {
    lines.push('', `再校验一次（把没有报 Error 的 ${value.subset.indexes.length} 个 Intent 单独提交）：`
      + `${value.subset.accepted ? '通过' : '仍被拒'}`);
  }
  for (const index of rejectedIndexes(value?.diagnostics)) {
    lines.push('', `── intent #${index + 1} — 被拒绝 ──`);
    lines.push(`intent:   ${capLine(JSON.stringify(intents[index]), 600)}`);
  }
  const passed = intents.length - rejectedIndexes(value?.diagnostics).length;
  const runnable = value?.queryCount ?? 0;
  lines.push('', passed === intents.length
    ? `校验结论：${intents.length} 个 Intent 全部可用（${runnable} 个查询可执行）。用 oks_query 提交同一批就能拿到结果。`
    : `校验结论：${passed}/${intents.length} 可用（${runnable} 个查询可执行）。用 oks_info 按服务给出的 key 读它声明的词汇再修，保持业务含义不变。`);
  return [{ type: 'text', text: `${lines.join('\n')}\n` }];
}

/** 一张有预算的表：列数、单元格长度、行数都受限，截断要写明。 */
function renderTable(rows, budget) {
  if (!Array.isArray(rows) || rows.length === 0) return { lines: ['结果：0 行'], truncated: false };
  const allColumns = Object.keys(rows[0] ?? {});
  const columns = allColumns.slice(0, RESULT_MAX_COLUMNS);
  const cell = (value) => {
    const text = value === null || value === undefined ? 'NULL'
      : typeof value === 'bigint' ? value.toString()
        : typeof value === 'object' ? JSON.stringify(value)
          : String(value);
    return (text.length > RESULT_MAX_CELL_CHARS ? `${text.slice(0, RESULT_MAX_CELL_CHARS)}…` : text)
      .replace(/\|/g, '\\|').replace(/\n/g, ' ');
  };
  const lines = [`| ${columns.join(' | ')} |`, `| ${columns.map(() => '---').join(' | ')} |`];
  let used = lines.reduce((total, line) => total + line.length + 1, 0);
  let shown = 0;
  let truncated = false;
  for (const row of rows) {
    const line = `| ${columns.map((column) => cell(row[column])).join(' | ')} |`;
    if (used + line.length > budget) { truncated = true; break; }
    lines.push(line);
    used += line.length + 1;
    shown += 1;
  }
  const notes = [];
  if (allColumns.length > columns.length) notes.push(`只显示前 ${columns.length} 列（共 ${allColumns.length} 列）`);
  if (truncated) notes.push(`只显示前 ${shown} 行（共 ${rows.length} 行）`);
  return { lines, truncated, notes };
}

/** oks_query 的模型可见渲染：轨迹 → 诊断 → 每个结果的 SQL/bindings 与行。 */
export function renderQuery(_args, value) {
  const lines = renderTrace(value?.trace);
  let used = lines.reduce((total, line) => total + line.length + 1, 0);
  const push = (line) => { lines.push(line); used += line.length + 1; };
  for (const line of diagnosticLines(value?.diagnostics)) push(line);

  (value?.results ?? []).forEach((result, at) => {
    push('');
    push(`── 结果 #${at + 1}（来自 intent #${result.index + 1}）──`);
    push(`sql:      ${capLine(String(result.sql).replace(/\s+/g, ' '), SQL_DISPLAY_CHARS)}`);
    push(`bindings: ${capLine(JSON.stringify(result.bindings), BINDINGS_DISPLAY_CHARS)}`);
    if (result.error !== null && result.error !== undefined) {
      push(`执行失败（数据文件 ${basename(value.dataFile)}）：${result.error}`);
      return;
    }
    push(`执行：${result.rows.length} 行 · ${result.ms} ms`
      + `${result.truncated ? `（已到行数上限 ${value.queryMaxRows}，结果还有更多）` : ''}`);
    const table = renderTable(result.rows, Math.max(240, RESULT_BUDGET_CHARS - used));
    for (const line of table.lines) push(line);
    for (const note of table.notes ?? []) push(`（${note}）`);
    if (result.rows.length === 0 && value?.window) {
      push(`提示：这份数据的窗口是 [${value.window.start}, ${value.window.endExclusive})，被过滤掉的可能是时间落在窗口之外。`);
    }
  });

  const rejected = rejectedIndexes(value?.diagnostics);
  for (const index of rejected) {
    push('');
    push(`── intent #${index + 1} — 被拒绝 ──`);
    push(`intent:   ${capLine(JSON.stringify((value?.intents ?? [])[index]), 600)}`);
  }
  if ((value?.results ?? []).length === 0) {
    push('', rejected.length === 0
      ? '没有可执行的查询。'
      : '没有任何 Intent 通过校验，所以没有执行。修 Intent 后再提交。');
  }
  return [{ type: 'text', text: `${lines.join('\n')}\n` }];
}
