import { createHash } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, realpathSync, unlinkSync, writeSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { errorText, isRecord } from './host.ts';

// 查询结果与产物的落盘与读取（见 rfc/0001 的「查询结果保存」）。
// 每个成功 Intent 一个 JSON 文件、每张图与每份报告各一个文件，都落在工作区的 .data/ 下，
// 名字统一是 <时间>-<名字>[-<内容哈希>].<类别><扩展名>（见 artifactName）。
// 结果文件含原始 Intent、列信息、行数与完整数据行——于是数据行可以只被「引用」，
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

/** at：该项成功执行结束的 UTC 时间，格式 YYYYMMDDTHHmmssZ（到秒）。
 *  它同时是文件名最前面那一段——两处逐字相同，名字与文件内容里的 at 对得起来。 */
export const resultStamp = (when: Date = new Date()): string =>
  when.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');

/** .data/ 里的三类产物。它进文件名，与扩展名各管一件事。 */
export type ArtifactKind = 'query' | 'chart' | 'report';

/** 类别的中文名，只用在报错里。 */
const KIND_LABEL: Record<ArtifactKind, string> = { query: '结果', chart: '图表', report: '报告' };

/** 名字的长度上限（字符）。字符集限定为 ASCII，所以字符数就是字节数。 */
export const NAME_MAX = 60;

/** 文本的 sha256 前 length 位十六进制。 */
const digest = (text: string, length: number): string =>
  createHash('sha256').update(text).digest('hex').slice(0, length);

/** 内容哈希：sha256(文件字节) 的前 8 位。放进文件名之后，`sha256sum` 一下就能核对。 */
const contentHash = (content: string): string => digest(content, 8);

/** 名字作为文件名里的标识：只用 0-9、_ 与 a-z。
 *
 *  字符集收得这么紧，是为了让 `-` 与 `.` 在文件名里成为**无歧义的分隔符**：
 *  名字里不可能出现它们，`<时间>-<名字>-<哈希>.<类别><扩展名>` 才解析得出来。
 *  名字是标识、不是标题——中文名没法"清洗"成 ASCII（音译是猜的），所以这里报错而不是改写；
 *  给人看的文字在 title / 列名 / 图注里。 */
export function nameProblem(name: unknown): string | null {
  if (typeof name !== 'string' || name.length === 0) return '名字必须是字符串';
  if (!/^[0-9a-z_]+$/.test(name)) {
    return '名字只能是 0-9、_ 与 a-z（它是标识，不是标题）：'
      + `收到 ${JSON.stringify(name)}，改成像 alarm_by_level 这样的名字`;
  }
  return null;
}

/** 超长名字的缩短：前 53 个字符 + `~` + 其余部分的 6 位哈希，总长仍 ≤ NAME_MAX。
 *  `~` 是允许字符集之外的唯一记号，见到它就知道这段名字被截过。 */
const shortName = (name: string): string => {
  if (name.length <= NAME_MAX) return name;
  const keep = name.slice(0, NAME_MAX - 7);
  return `${keep}~${digest(name.slice(keep.length), 6)}`;
};

/** 产物的统一命名：`<时间>-<名字>[-<内容哈希>].<类别><扩展名>`。
 *
 *  时间在最前面，`ls .data/` 出来就是时间序；名字是给人看的那一半；哈希是给核对的那一半
 *  ——它等于文件内容的 sha256 前 8 位，于是**同名 ⟺ 同内容**，撞名不再需要"加序号"这套补丁；
 *  类别与扩展名各管一件事：类别用来取同类清单（`.data/*.chart.*`），扩展名给工具看。
 *  内容不是一次拿到的（流式写）时哈希那一段省略，那时才退回按序号消歧。 */
export const artifactName = (options: {
  at: string;
  name: string;
  kind: ArtifactKind;
  extension: string;
  content?: string;
}): string => {
  const hash = options.content === undefined ? '' : `-${contentHash(options.content)}`;
  return `${options.at}-${shortName(options.name)}${hash}.${options.kind}${options.extension}`;
};

/** 独占写一个产物文件。
 *
 *  名字里带着内容哈希时，"撞名"就是**同样的内容**，直接当去重（返回同一个路径）是安全的；
 *  查询结果那段是文件名前缀而不是内容哈希，所以撞名必须读出来核一遍——一致才认作同一份，
 *  不一致就报错。两条路都不覆盖任何已有的文件。 */
const writeExclusive = (target: string, content: string, kind: ArtifactKind): void => {
  let handle: number | null = null;
  try {
    // wx：独占创建。只有 fd 确实由我们拿到，才在失败时清理这个不完整的文件。
    handle = openSync(target, 'wx');
    writeSync(handle, content);
    closeSync(handle);
    handle = null;
    return;
  } catch (cause) {
    if (handle !== null) {
      try { closeSync(handle); } catch { /* 已经关掉就算了 */ }
      try { unlinkSync(target); } catch { /* 清理失败不掩盖真正的原因 */ }
    }
    if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw new Error(`保存${KIND_LABEL[kind]}失败：${errorText(cause)}`);
    }
    if (contentHash(readFileSync(target, 'utf8')) !== contentHash(content)) {
      throw new Error(`保存${KIND_LABEL[kind]}失败：${target} 已存在且内容不同`);
    }
  }
};

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
  const { columns, rows } = describeRows(options.sqlColumns, options.rows);
  // 文件内容里的 name 是**原名全文**：文件名会按 60 字符截断，记录不截断。
  const payload: ResultFile = {
    name: options.name,
    key: options.key,
    at,
    intent: options.intent,
    columns,
    rowCount: rows.length,
    rows,
  };
  const body = `${JSON.stringify(payload, null, 2)}\n`;
  const fileName = artifactName({ at, name: options.name, kind: 'query', extension: '.json', content: body });
  writeExclusive(join(directory, fileName), body, 'query');
  return { dataSrc: `${DATA_DIR}/${fileName}`, columns, rowCount: rows.length };
}

/** 把一份产物（图、报告）写成文件：与结果文件同一套命名与独占创建规则。
 *  返回的 src 是相对工作区根的路径，交给 agent 粘进回答引用。 */
export function saveArtifact(options: {
  root: string;
  name: string;
  content: string;
  extension: string;
  kind: Exclude<ArtifactKind, 'query'>;
}): { src: string; at: string } {
  const problem = nameProblem(options.name);
  if (problem !== null) {
    throw new Error(`${KIND_LABEL[options.kind]}名不合法（${JSON.stringify(options.name)}）：${problem}`);
  }
  const at = resultStamp();
  mkdirSync(join(options.root, DATA_DIR), { recursive: true });
  const fileName = artifactName({
    at,
    name: options.name,
    kind: options.kind,
    extension: options.extension,
    content: options.content,
  });
  writeExclusive(join(options.root, DATA_DIR, fileName), options.content, options.kind);
  return { src: `${DATA_DIR}/${fileName}`, at };
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
    throw new Error(`dataSrc 只能指向工作区 ${DATA_DIR}/ 里的文件：${JSON.stringify(dataSrc)}`);
  }
  return target;
}

/** 把一个 .data/ 里的产物定位到真实路径：先按前缀收窄，再用真实路径复核（挡住符号链接逃逸）。
 *  "找不到"与"越界"要分开报——这两种错，修法完全不同。 */
function artifactPath(root: string, src: unknown): string {
  const target = resolveDataSrc(root, src);
  let real: string;
  try {
    real = realpathSync(target);
  } catch {
    throw new Error(`找不到 ${JSON.stringify(src)}`);
  }
  const realDirectory = realpathSync(resolve(root, DATA_DIR));
  const inside = relative(realDirectory, real);
  if (inside.length === 0 || inside.startsWith('..') || isAbsolute(inside)) {
    throw new Error(`引用指向的路径不在工作区 ${DATA_DIR}/ 里：${JSON.stringify(src)}`);
  }
  return real;
}

/** 读回结果文件；真实路径也必须落在 .data/ 里（挡住符号链接逃逸）。 */
export function readResult(root: string, dataSrc: unknown): ResultFile {
  const parsed: unknown = JSON.parse(readFileSync(artifactPath(root, dataSrc), 'utf8'));
  if (!isRecord(parsed) || !Array.isArray(parsed.rows) || !Array.isArray(parsed.columns)) {
    throw new Error(`结果文件结构不完整：${JSON.stringify(dataSrc)}`);
  }
  return parsed as unknown as ResultFile;
}

/** 读一份已经落盘的产物（报告里引用的图）：路径约束与结果文件相同，另加一条扩展名核对。 */
export function readArtifact(root: string, src: string, extension: string): string {
  if (!src.endsWith(extension)) throw new Error(`只认 ${extension} 产物：${JSON.stringify(src)}`);
  return readFileSync(artifactPath(root, src), 'utf8');
}
