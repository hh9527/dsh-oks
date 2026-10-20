// 表格展示件：把「行对象数组」渲染成一段 markdown 表格。
//
// 为什么是 markdown：它是**两处都能渲染**的那一种格式——回答里原生显示，报表里走同一套
// markdown 管道变成真 `<table>`（可选中、可搜索、可复制），文件本身打开也是张表。
// 绑定值与来源由运行器携带，表格内容用于呈现。

/** 表的上限：超过就明确失败，让调用方先聚合或投影（表是给人看的，不是导出通道）。 */
export const TABLE_MAX_ROWS = 200;
export const TABLE_MAX_COLUMNS = 12;
/** 单元格文本上限：超了截断并留 `…`（完整值在来源块的 data 里）。 */
const CELL_MAX_CHARS = 60;

export interface TableSpec {
  /** 展示的列与顺序；省略就按数据里出现的列顺序。 */
  columns?: string[];
  /** 表注（进 `![表注](路径)`，也进报表的表号）。 */
  title?: string;
}

/** 一个单元格的文本：字符串原样，null/undefined 留空，其余交给 JSON。 */
const cellText = (value: unknown): string => {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'bigint') return value.toString();
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
};

/** markdown 单元格里要挡住的字符：`|` 会切列，换行会断行。 */
const escapeCell = (text: string): string => {
  const flat = text.replace(/\s*\n\s*/g, ' ').replace(/\|/g, '\\|');
  return flat.length <= CELL_MAX_CHARS ? flat : `${flat.slice(0, CELL_MAX_CHARS - 1)}…`;
};

/** 一列里的值是不是都是数字：是就右对齐（数字右对齐才读得出量级）。 */
const isNumericColumn = (rows: readonly Record<string, unknown>[], name: string): boolean => {
  let seen = 0;
  for (const row of rows) {
    const value = row[name];
    if (value === null || value === undefined) continue;
    if (typeof value !== 'number' || !Number.isFinite(value)) return false;
    seen += 1;
  }
  return seen > 0;
};

/** 渲染一张表：表头 + 对齐行 + 数据行。列按 `spec.columns` 或数据里出现过的键的先后来定。 */
export function tableMarkdown(
  rows: readonly Record<string, unknown>[],
  spec: TableSpec,
): { embedded: string; columns: string[] } | { error: string } {
  if (rows.length === 0) return { error: '这份数据没有行：空表不落盘——先查清楚为什么没有数据。' };
  if (rows.length > TABLE_MAX_ROWS) {
    return { error: `表最多 ${TABLE_MAX_ROWS} 行（收到 ${rows.length} 行）：先聚合或投影，再出表；`
      + '要展示完整明细，用图或报表里的其他表达。' };
  }
  const available = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  const columns = spec.columns === undefined || spec.columns.length === 0 ? available : spec.columns;
  const unknown = columns.filter((name) => !available.includes(name));
  if (unknown.length > 0) {
    return { error: `这些列不在数据里：${unknown.join(', ')}。可用的列：${available.join(', ') || '(没有列)'}` };
  }
  if (columns.length === 0) return { error: '这份数据没有任何列：出不了表。' };
  if (columns.length > TABLE_MAX_COLUMNS) {
    return { error: `表最多 ${TABLE_MAX_COLUMNS} 列（收到 ${columns.length} 列）：用 spec.columns 选要展示的那几列。` };
  }
  const align = columns.map((name) => (isNumericColumn(rows, name) ? '---:' : '---'));
  const lines = [
    `| ${columns.map((name) => escapeCell(name)).join(' | ')} |`,
    `| ${align.join(' | ')} |`,
  ];
  for (const row of rows) {
    lines.push(`| ${columns.map((name) => escapeCell(cellText(row[name]))).join(' | ')} |`);
  }
  return { embedded: `${lines.join('\n')}\n`, columns };
}
