import { closeSync, mkdirSync, openSync, readFileSync, realpathSync, unlinkSync, writeSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { errorText, isRecord } from './host.ts';

// 查询结果的落盘与读取（见 rfc/0001 的「查询结果保存」）。
// 每个成功 Intent 一个 JSON 文件，放在工作区的 .data/ 下：<name>-<key>-<at>.json。
// 文件含原始 Intent、列信息、行数与完整数据行——于是数据行可以只被「引用」，
// 不必默认进入模型上下文；按需取数另走 oks_jaq_result。

/** 结果文件所在的目录（相对工作区根）。 */
export const DATA_DIR = '.data';

/** 一列的观察结果：列名取自 SQL 元数据，类型按返回值观察。 */
export interface ColumnInfo {
  name: string;
  /** 观察到的值类型；没有任何数据行时记为 unknown。 */
  types: string[];
  nullable: boolean;
}

/** 落盘成功后的回执信息。 */
export interface SavedResult {
  dataSrc: string;
  columns: ColumnInfo[];
  rowCount: number;
}

/** 结果文件的结构。 */
export interface ResultFile {
  name: string;
  key: string;
  at: string;
  intent: unknown;
  columns: ColumnInfo[];
  rowCount: number;
  rows: Array<Record<string, unknown>>;
}

/** at：该项成功执行结束的 UTC 时间，格式 YYYYMMDDTHHmmssSSSZ。 */
export const resultStamp = (when: Date = new Date()): string =>
  when.toISOString().replace(/[-:]/g, '').replace(/\.(\d{3})Z$/, '$1Z');

/** 名字作为文件名前缀：拒绝路径分隔符、控制字符、空白名，以及 . 与 .. */
export function nameProblem(name: unknown): string | null {
  if (typeof name !== 'string' || name.length === 0) return '名字必须是字符串';
  if (name === '.' || name === '..') return `名字不能是 ${name}`;
  if (name.includes('/') || name.includes('\\')) return '名字里不能有路径分隔符';
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) return '名字里不能有控制字符';
  return null;
}

/** 值编码：大整数转十进制字符串、二进制转 base64，并给出观察到的类型标签。 */
function encodeCell(value: unknown): { value: unknown; type: string } {
  if (value === null || value === undefined) return { value: null, type: 'null' };
  if (typeof value === 'bigint') return { value: value.toString(), type: 'integer-string' };
  if (value instanceof Uint8Array) return { value: Buffer.from(value).toString('base64'), type: 'binary-base64' };
  if (Array.isArray(value)) return { value, type: 'array' };
  if (typeof value === 'object') return { value, type: 'object' };
  return { value, type: typeof value };
}

/** 按行观察列：sqlColumns 是 SQL 元数据给的列名（保序），其余列名按出现顺序补进来。
 *  没有任何数据行时，类型记为 unknown。 */
export function describeRows(
  sqlColumns: readonly string[],
  rows: readonly Record<string, unknown>[],
): { columns: ColumnInfo[]; rows: Array<Record<string, unknown>> } {
  const observed = new Map<string, { types: Set<string>; nullable: boolean }>();
  const remember = (name: string): { types: Set<string>; nullable: boolean } => {
    const existing = observed.get(name);
    if (existing !== undefined) return existing;
    const created = { types: new Set<string>(), nullable: false };
    observed.set(name, created);
    return created;
  };
  for (const name of sqlColumns) remember(name);
  const encoded: Array<Record<string, unknown>> = [];
  for (const row of rows) {
    const out: Record<string, unknown> = {};
    for (const [name, raw] of Object.entries(row)) {
      const { value, type } = encodeCell(raw);
      const seen = remember(name);
      seen.types.add(type);
      if (type === 'null') seen.nullable = true;
      out[name] = value;
    }
    encoded.push(out);
  }
  const columns = [...observed.entries()].map(([name, seen]) => ({
    name,
    types: seen.types.size === 0 ? ['unknown'] : [...seen.types].sort(),
    nullable: seen.nullable,
  }));
  return { columns, rows: encoded };
}

/** 落盘一个 Intent 的结果，返回相对工作区根的 dataSrc。
 *  目标重名或写入失败都抛错，并且不留下半个文件。 */
export function saveResult(options: {
  root: string;
  name: string;
  key: string;
  intent: unknown;
  rows: readonly Record<string, unknown>[];
  sqlColumns: readonly string[];
}): SavedResult {
  const problem = nameProblem(options.name);
  if (problem !== null) throw new Error(`结果文件名不合法：${problem}`);
  const directory = join(options.root, DATA_DIR);
  mkdirSync(directory, { recursive: true });
  const at = resultStamp();
  const fileName = `${options.name}-${options.key}-${at}.json`;
  const target = join(directory, fileName);
  const { columns, rows } = describeRows(options.sqlColumns, options.rows);
  const payload: ResultFile = {
    name: options.name,
    key: options.key,
    at,
    intent: options.intent,
    columns,
    rowCount: rows.length,
    rows,
  };
  let handle: number | null = null;
  try {
    // wx：独占创建。重名（EEXIST）在这一步失败——那时**什么都没创建**，所以绝不能去动目标路径上
    // 已有的文件；只有 fd 确实由我们拿到，才在失败时清理这个不完整的文件。
    handle = openSync(target, 'wx');
    writeSync(handle, `${JSON.stringify(payload, null, 2)}\n`);
    closeSync(handle);
    handle = null;
  } catch (cause) {
    if (handle !== null) {
      try { closeSync(handle); } catch { /* 已经关掉就算了 */ }
      try { unlinkSync(target); } catch { /* 清理失败不掩盖真正的原因 */ }
    }
    throw new Error(`保存结果失败：${errorText(cause)}`);
  }
  return { dataSrc: `${DATA_DIR}/${fileName}`, columns, rowCount: rows.length };
}

/** 把一份产物（图、报告）写成文件：与结果文件同一套命名与独占创建规则，只是没有 key
 *  （产物不对应 Intent）。返回的 src 是相对工作区根的路径，交给 agent 粘进回答引用。
 *  `label` 只用于错误信息，比如「图表名」「报告名」。 */
export function saveArtifact(options: {
  root: string;
  name: string;
  content: string;
  extension: string;
  label: string;
}): { src: string; at: string } {
  const problem = nameProblem(options.name);
  if (problem !== null) throw new Error(`${options.label}不合法（${JSON.stringify(options.name)}）：${problem}`);
  const at = resultStamp();
  mkdirSync(join(options.root, DATA_DIR), { recursive: true });
  // 产物没有 key 可区分，而同一毫秒里可能连着产两份同名的，所以撞名时依次加序号，
  // 而不是覆盖已有的产物、也不是让调用失败。
  for (let attempt = 1; attempt <= 100; attempt += 1) {
    const fileName = attempt === 1
      ? `${options.name}-${at}${options.extension}`
      : `${options.name}-${at}-${attempt}${options.extension}`;
    const target = join(options.root, DATA_DIR, fileName);
    let handle: number | null = null;
    try {
      // 与结果文件同样的独占创建：只在确实由我们创建时才在失败时清理。
      handle = openSync(target, 'wx');
      writeSync(handle, options.content);
      closeSync(handle);
      handle = null;
      return { src: `${DATA_DIR}/${fileName}`, at };
    } catch (cause) {
      if (handle !== null) {
        try { closeSync(handle); } catch { /* 已经关掉就算了 */ }
        try { unlinkSync(target); } catch { /* 清理失败不掩盖真正的原因 */ }
      }
      // 撞名：换一个序号继续试；其它错误直接报出来。
      if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw new Error(`保存图表失败：${errorText(cause)}`);
      }
    }
  }
  throw new Error(`保存图表失败：同名文件太多（${options.name}）`);
}

/** dataSrc 的语法范围：只接受能在工作区 .data/ 里落位的相对路径。 */
export function resolveDataSrc(root: string, dataSrc: unknown): string {
  if (typeof dataSrc !== 'string' || dataSrc.length === 0) {
    throw new Error('需要一个 dataSrc（查询结果返回的那个相对路径）');
  }
  const directory = resolve(root, DATA_DIR);
  const target = resolve(root, dataSrc);
  const inside = relative(directory, target);
  if (inside.length === 0 || inside.startsWith('..') || isAbsolute(inside)) {
    throw new Error(`dataSrc 只能指向工作区 ${DATA_DIR}/ 里的结果文件：${JSON.stringify(dataSrc)}`);
  }
  return target;
}

/** 读回结果文件；真实路径也必须落在 .data/ 里（挡住符号链接逃逸）。 */
export function readResult(root: string, dataSrc: unknown): ResultFile {
  const target = resolveDataSrc(root, dataSrc);
  const realDirectory = realpathSync(resolve(root, DATA_DIR));
  const real = realpathSync(target);
  const inside = relative(realDirectory, real);
  if (inside.length === 0 || inside.startsWith('..') || isAbsolute(inside)) {
    throw new Error(`dataSrc 指向的路径不在工作区 ${DATA_DIR}/ 里：${JSON.stringify(dataSrc)}`);
  }
  const parsed: unknown = JSON.parse(readFileSync(real, 'utf8'));
  if (!isRecord(parsed) || !Array.isArray(parsed.rows) || !Array.isArray(parsed.columns)) {
    throw new Error(`结果文件结构不完整：${JSON.stringify(dataSrc)}`);
  }
  return parsed as unknown as ResultFile;
}
