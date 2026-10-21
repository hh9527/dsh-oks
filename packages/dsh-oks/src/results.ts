import {readWindow,readArgs,READ_STREAM_MIN_SIZE} from './read.ts';
import { sourcePath, LIBRARY_PATH } from './resource-path.ts';
import { KTOOLS_FILE, KTOOLS_INITIAL_SOURCE } from './ktools-path.ts';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, unlinkSync,
  writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { errorText, isRecord } from './host.ts';
import { capLine } from './text.ts';

// DARI 运行数据类型、来源链、附件内容编码与源码文件管理。
export const WORK_DIR = '.work';

/** 模型声明的结果列：逻辑类型和可空性来自静态投影，与实际返回行无关。 */
export const RESULT_TYPES = ['Int', 'Float', 'Bool', 'String', 'DatetimeUtc', 'EpochMillis', 'LocalDateTime'] as const;
export interface ResultColumn {
  name: string;
  type: typeof RESULT_TYPES[number];
  nullable: boolean;
}
export function isResultColumn(value: unknown): value is ResultColumn {
  return isRecord(value) && typeof value.name === 'string' && value.name.trim() !== ''
    && typeof value.type === 'string' && (RESULT_TYPES as readonly string[]).includes(value.type)
    && typeof value.nullable === 'boolean';
}

/** 一列的观察结果：列名取自 SQL 元数据，类型按返回值观察。 */
export interface ColumnInfo {
  name: string;
  /** 观察到的值类型；没有任何数据行时记为 unknown。 */
  types: string[];
  nullable: boolean;
}

/** 来源链里的一个节点：一次操作的记录。查询与加工各用其中一部分字段。 */
export interface OriginNode {
  /** Draft source snapshot associated with this operation; retained code does not depend on that file surviving. */
  draft?: { file: string; hash: string; line: number; column: number; asset?: string };
  nature?: 'given' | 'parameter' | 'assumption' | 'example';
  /** Constructor routing: input identity, original upstream path, and destination within the constructed value. */
  construction?: Array<{ input: string; path: (string | number)[]; at: (string | number)[] }>;

  /** 产生这份数据的操作：查询、加工、agent 给定、读到的当轮上下文、把若干材料合成一份展示件、
   *  组装报告，或（早期版本的）派生视图。`extract` 与 `derive` 都已经不再产生，读取时仍认——
   *  旧文件是可回收的内部材料，随保活消失。 */
  kind: 'knowledge' | 'query' | 'transform' | 'input' | 'context' | 'display' | 'extract' | 'derive' | 'report';
  /** query：实际提交并通过校验的意图（相对时间已解析成绝对边界）。 */
  intent?: unknown;
  /** transform：实际执行的加工方式。 */
  method?: 'jq' | 'project' | 'identity';
  /** project：完整的纯 JSON 规则。 */
  project?: unknown;
  /** 程序实际看到的输入形状；单输入的 `$` 绑定键仅用于来源链。 */
  inputShape?: 'single' | 'named' | 'empty';
  /** 来源绑定键 → 实际资源原文，包含 #meta 选择符。 */
  inputResources?: Record<string, string>;
  /** 这次操作的动机：一句自然语言，写给人读。 */
  motivation?: string;
  /** query / knowledge：执行时**实际**用的数据来源（与 intent 的"请求什么"形成对照）。 */
  source?: unknown;
  /** input：这份给定数据的**内容**（`create_data` 的 payload）；context：读到的当轮上下文
   *  （时刻 + 时区）。两者都不是可重算的，所以内容随链走——**链就是配方**，于是只留产物本身
   *  也能重放整条链。查询相反：它靠 `intent` 重跑，数据不进链。 */
  data?: unknown;
  /** display：这次合成用的绘图规格（重放时照它把数据块重建出来）。 */
  spec?: unknown;
  /** transform：实际执行的 snip（**程序正文**；来自文件的也记正文，`.work/` 被清掉也不影响来路）。
   *  仅 jq 加工记录此字段。 */
  snip?: string;
  /** transform：这段程序来自哪份代码文件（`jq.src` 指向的那一份）。 */
  snipFile?: string;
  /** 报告序列化形态：源码集中放在报告的 `assets` 里，节点用 `src://<key>` 引用它。
   *  报告是唯一使用这种引用形态的地方——普通材料照旧把程序正文内嵌在 `snip` 里。 */
  byFile?: string;
  /** transform：从结果里取回的那一段（jq 点路径，`snip` 是 `.` 时它就是这次操作的全部内容）。 */
  pick?: string;
  /** transform：表达式产出了几个值。它把"恰好一个数组值"与"多个输出"分开，
   *  于是 `data: []` 是"一个空数组"还是"没有输出"有据可查。 */
  outputs?: number;
  /** transform / extract：输入名 → 上游操作在**本文件内**的节点 ID。 */
  inputs?: Record<string, string>;
  /** 与 inputs 配套：加工节点记录 `.data` / `#meta` 资源视图；展示与报告节点记录封装点路径。 */
  inputPaths?: Record<string, string>;
  /** extract：从哪份报告取的（文件名，不含目录）与报告内的第几项。 */
  report?: string;
  item?: number;
  /** derive：派生自哪份产物（文件名，不含目录）。早期版本写下的派生封装仍可读，不再产生。 */
  from?: string;
}

/** 来源链：`root` 指向产生当前 data 的那个操作，`nodes` 是这条链上的全部操作。
 *  多输入会共享上游，所以结构上是有向图；共享祖先按记录身份只留一个节点。 */
export interface DataOrigin {
  root: string;
  nodes: Record<string, OriginNode>;
}

/** 附件中随内容携带的来源链与数据。 */
export interface EnvelopeParts<T = unknown> {
  origin: DataOrigin;
  data: T;
}

/** 封装数据区的点路径，供图表与报告绑定使用。 */
export const DEFAULT_ROOT = '.data';

/** at：该项成功执行结束的 UTC 时间，格式 YYYYMMDDTHHmmssZ（到秒）。它是文件名最前面那一段；
 *  图与报告的自述里也带着同一个值，于是名字和文件内容对得起来（结果文件没有自述那一层）。 */
export const resultStamp = (when: Date = new Date()): string =>
  when.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');

/** 在文件里带自述的类别：图与报告各用一种原生写法，数据材料没有自述那一层。 */
export type SelfDescribingKind = 'chart' | 'report';

/** 名字的长度上限（字符）。字符集限定为 ASCII，所以字符数就是字节数。 */
export const NAME_MAX = 60;

/** 文本的 sha256 前 length 位十六进制。 */
const digest = (text: string, length: number): string =>
  createHash('sha256').update(text).digest('hex').slice(0, length);

/** 内容哈希：sha256(文件字节) 的前 8 位。放进文件名之后，`sha256sum` 一下就能核对。 */
const contentHash = (content: string): string => digest(content, 8);

/** 规范化 JSON：对象按键排序。用它把一份操作定义算成稳定的哈希；
 *  `undefined` 的字段不参与——这也正是写文件时省略可选字段的写法。 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).filter((key) => record[key] !== undefined).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

/** 记录身份：**一次操作的完整记录**——操作定义 + 它实际产出的内容——的 sha256 前 12 位。
 *
 *  为什么不是"操作定义的哈希"：那样区分不了同定义的不同执行。同一句动机下的两次
 *  `create_data`（或同一条 snip 跑在两份不同输入上）会算出同一个 ID，两份不同的数据
 *  就被合并成一个节点，链上再也看不出来。把产出的内容也算进身份之后：
 *  定义相同而数据不同 → 两个节点；同一份封装在别的文件里被再次引用 → 还是同一个 ID
 *  （于是共享祖先只留一份）。完全相同的记录（同定义、同输入、同结果）在任何文件里逐字相同，
 *  它们本来就是同一份材料，链上合成一个节点；文件本身仍旧各写一份。
 *  身份只由记录内容决定，所以它不依赖文件名，也不依赖上游文件是否还在。 */
export const recordId = (node: OriginNode, data: unknown): string =>
  digest(`${canonicalJson(node)}\n${canonicalJson(data)}`, 12);

/** 一份只含本次操作的来源链：查询、给定数据与无输入的加工都从这里开始。 */
export function originOf(node: OriginNode, data: unknown): DataOrigin {
  const id = recordId(node, data);
  return { root: id, nodes: { [id]: node } };
}

/** 来源链的易读视图：按依赖顺序（输入在前、用到它的操作在后）摊成几行。
 *  节点表省体积，代价是读的时候要沿 ID 查——这一层就是那个"沿 ID 查"，供回执使用。 */
export function chainLines(origin: DataOrigin, limit = 24): string[] {
  const lines: string[] = [];
  const seen = new Set<string>();
  /** 按实际加工方式展示规则或程序。 */
  const program = (node: OriginNode): string => {
    if (node.method === 'project') return canonicalJson(node.project);
    if (node.method === 'identity') return 'identity';
    return node.snip === undefined || node.snip === '.' ? node.pick ?? node.snip ?? '' : node.snip;
  };
  const detail = (node: OriginNode): string => (node.kind === 'query'
    ? `query ${node.intent === undefined ? '' : capLine(canonicalJson(node.intent), 96)}`
    : node.kind === 'knowledge' ? `知识 ${capLine(canonicalJson(node.source), 160)}`
    : node.kind === 'input' ? '输入数据（agent 给定）'
      : node.kind === 'context' ? '读到的当轮上下文（时刻与时区）'
        : node.kind === 'extract'
          ? `从报告 ${node.report ?? '(未知)'} 的第 ${node.item ?? '?'} 项取出`
          : node.kind === 'derive'
            ? `派生自 ${node.from ?? '(未知)'}`
            : node.kind === 'display'
              ? `合成展示件（${Object.keys(node.inputs ?? {}).join(' + ')}）`
              : node.kind === 'report'
                ? `组装这份报告（${Object.keys(node.inputs ?? {}).length} 项）`
                : `transform ${capLine(program(node), 96)}`);
  const visit = (id: string): void => {
    if (seen.has(id)) return;
    seen.add(id);
    const node = origin.nodes[id];
    if (node === undefined) return;
    for (const upstream of Object.values(node.inputs ?? {})) visit(upstream);
    lines.push(`[${id}]${id === origin.root ? '（本次操作）' : ''} ${detail(node)}`);
    if (node.motivation !== undefined) lines.push(`      动机：${capLine(node.motivation, 160)}`);
    const inputs = Object.entries(node.inputs ?? {});
    if (inputs.length > 0) {
      lines.push(`      输入：${inputs.map(([name, at]) => `${name}=[${at}]`).join('、')}`);
    }
  };
  visit(origin.root);
  return lines.length <= limit
    ? lines
    : [...lines.slice(0, limit), `…（还有 ${lines.length - limit} 行没列出：完整来源链在文件里）`];
}

/** 把各输入的来源链并成一张表：节点 ID 由记录内容算出，所以同一个上游只留一份。
 *  ID 相同而内容不同只可能是哈希碰撞或文件被改过——报错，不静默合并。 */
export function mergeChains(chains: readonly DataOrigin[]): Record<string, OriginNode> {
  const nodes: Record<string, OriginNode> = {};
  for (const chain of chains) {
    for (const [id, node] of Object.entries(chain.nodes)) {
      const existing = nodes[id];
      if (existing === undefined) { nodes[id] = node; continue; }
      if (canonicalJson(existing) !== canonicalJson(node)) {
        throw new Error(`来源链里的节点 ID 冲突（${id}）：同一个 ID 对应两份不同的记录`);
      }
    }
  }
  return nodes;
}

/** 组装一次加工的来源链：合并各输入的链、加入本次操作，根指向本次操作。
 *  `node.inputs` 里存的是各输入的**根节点 ID**——那个节点代表"产出那份 data 的记录"。 */
export function appendNode(
  inputs: readonly DataOrigin[],
  node: OriginNode,
  data: unknown,
): DataOrigin {
  const nodes = mergeChains(inputs);
  const id = recordId(node, data);
  nodes[id] = node;
  return { root: id, nodes };
}

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
 *  时间在最前面，`ls artifacts/` 出来就是时间序；名字是给人看的那一半；哈希是给核对的那一半
 *  ——它等于文件内容的 sha256 前 8 位，于是**同名 ⟺ 同内容**，撞名不再需要"加序号"这套补丁；
 *  类别与扩展名各管一件事：类别用来取同类清单（`artifacts/*.chart.*`），扩展名给工具看。
 *  内容不是一次拿到的（流式写）时哈希那一段省略，那时才退回按序号消歧。 */
export const artifactName = (options: {
  at: string;
  name: string;
  /** 文件名中间那个**文件类别**（材料短名 / 图元 / table / report）——不是语义类别。 */
  kind: string;
  extension: string;
  content?: string;
}): string => {
  const hash = options.content === undefined ? '' : `-${contentHash(options.content)}`;
  return `${options.at}-${shortName(options.name)}${hash}.${options.kind}${options.extension}`;
};

/** 图表与报告的自述元数据，以原生元素嵌入内容。 */
export interface ArtifactMeta {
  /** 文件名里的名字段（标识）。 */
  name: string;
  kind: SelfDescribingKind;
  /** 与文件名最前面那段逐字相同的 UTC 时间。 */
  at: string;
  /** 给人看的标题——**永不为空**：agent 没给时由工具造一个。 */
  title: string;
  /** 更精确的分类（周报、月报、即时分析…）。大类由 `kind` 表达、用图标呈现，这一项是文字。 */
  category?: string;
}

/** 自述在文件里的标记名。两种产物各用一种原生写法：报告的 `<meta>`、图的 `<metadata>`。 */
const META_KEY = 'dsh-oks-artifact';

/** XML 文本与属性值的转义（只做必须的那几个字符）。 */
const escapeXmlText = (value: string): string => value
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeXmlAttr = (value: string): string => escapeXmlText(value).replace(/"/g, '&quot;');

/** 把自述嵌进产物内容：报告插在 `<head>` 之后，图插在根 `<svg>` 之后。
 *
 *  位置是契约的一部分——**两者都在文件最前面**，所以读的人只读开头的有限字节就够；
 *  图那两个元素借的是 SVG 原生件（`<title>` 与 `<metadata>`），都不参与绘制。
 *  形状不认识时报错，而不是原样返回：那说明渲染层的形状变了，静默写出一份没有自述的产物更糟。 */
export function embedArtifactMeta(content: string, meta: ArtifactMeta): string {
  const json = JSON.stringify(meta);
  if (meta.kind === 'report') {
    const head = '<head>';
    const at = content.indexOf(head);
    if (at < 0) throw new Error('报告里没有 <head>，自述写不进去（渲染层的形状变了？）');
    const insert = `${head}\n<meta name="${META_KEY}" content="${escapeXmlAttr(json)}" />`;
    return content.slice(0, at) + insert + content.slice(at + head.length);
  }
  const open = /<svg[^>]*>/.exec(content);
  if (open === null) throw new Error('图里没有根 <svg>，自述写不进去（渲染层的形状变了？）');
  const insert = `<title>${escapeXmlText(meta.title)}</title>`
    + `<metadata id="${META_KEY}">${escapeXmlText(json)}</metadata>`;
  const end = open.index + open[0].length;
  return content.slice(0, end) + insert + content.slice(end);
}

/** 从产物内容里读回自述；读不到（老产物、形状不符、标题为空）就是 null。
 *  两个正则都只匹配"文件最前面那一段"，不解析整个文档。 */
export function readArtifactMeta(content: string): ArtifactMeta | null {
  // 两种写法都认：报告页面的自述按 XHTML 写成自闭合，图的仍是 HTML 写法。
  const html = new RegExp(`<meta name="${META_KEY}" content="([^"]*)"\\s*/?>`).exec(content);
  const svg = new RegExp(`<metadata id="${META_KEY}">([^<]*)</metadata>`).exec(content);
  const raw = html?.[1] ?? svg?.[1];
  if (raw === undefined) return null;
  const json = raw.replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&amp;/g, '&');
  try {
    const value = JSON.parse(json) as ArtifactMeta;
    return typeof value?.title === 'string' && value.title.length > 0 ? value : null;
  } catch {
    return null;
  }
}

/** 图与表的 data：画出来的行 + 它们的展示规格。两者同形——图与表各自该怎么看，
 *  由 `spec` 说；那一份行数据本身是通用表格。 */
export interface DisplayData {
  rows: Array<Record<string, unknown>>;
  spec: unknown;
}

/** 图里的绘图材料：**画出来的行**、绘图规格，以及这份数据的完整来源链。
 *  它和图的自述分开放：自述回答"这是什么"，这一块回答"这些数字从哪来"。 */
export type ChartInput = EnvelopeParts<DisplayData>;

/** 绘图材料在 SVG 里的标记名。 */
const CHART_INPUT_KEY = 'dsh-oks-chart-input';

/** 把绘图材料嵌进 SVG：与自述一样放在文件最前面，读的人只读开头就够。
 *  它是**复制**而不是引用——工作区可回收，图要能自己说清来路（见 rfc/0005 决策 6）。 */
export function embedChartInput(content: string, input: ChartInput): string {
  const open = /<svg[^>]*>/.exec(content);
  if (open === null) throw new Error('图里没有根 <svg>，绘图材料写不进去（渲染层的形状变了？）');
  const insert = `<metadata id="${CHART_INPUT_KEY}">${escapeXmlText(JSON.stringify(input))}</metadata>`;
  const end = open.index + open[0].length;
  return content.slice(0, end) + insert + content.slice(end);
}

/** 从图里读回绘图材料；读不到（老图、形状不符）就是 null。 */
export function readChartInput(content: string): ChartInput | null {
  const raw = new RegExp(`<metadata id="${CHART_INPUT_KEY}">([^<]*)</metadata>`).exec(content)?.[1];
  if (raw === undefined) return null;
  const json = raw.replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&amp;/g, '&');
  try {
    const value = JSON.parse(json) as ChartInput;
    return value?.origin === undefined ? null : value;
  } catch {
    return null;
  }
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

/** 单份代码文件的字节上限：它是**能被 `jq.src` 引用为程序**的上限——一份这么大的程序说明该拆开。 */
export const CODE_MAX_BYTES = 64 * 1024;

/** `.work/` 里单份文本文件的上限（存得住的上限，比"能当程序引用的上限"宽）。 */
export const WORK_MAX_BYTES = 256 * 1024;

/** 校验工作区相对完整路径，原样使用调用方给定的名称。 */
function validateFilePath(raw: unknown): asserts raw is string {
  if (typeof raw !== 'string' || raw === '' || raw !== raw.trim() || isAbsolute(raw)
    || raw.includes('\\') || raw.includes('#') || raw.includes('\0')
    || raw.split('/').some(part => part === '' || part === '.' || part === '..')) {
    throw new Error(`需要工作区相对完整文件路径：${JSON.stringify(raw)}`);
  }
}

/** 校验最近的现有父目录，创建目录前也要挡住符号链接逃逸。 */
function checkRealBoundary(root: string, target: string): void {
  const workspace = realpathSync(root);
  let candidate = target;
  while (!existsSync(candidate)) candidate = dirname(candidate);
  const actual = realpathSync(candidate);
  const inside = relative(workspace, actual);
  if (inside.startsWith('..') || isAbsolute(inside)) throw new Error('路径经符号链接越出工作区。');
}

/** 完整文件名称的共同边界：词法与真实路径均留在工作区内。 */
export function workspaceFilePath(root: string, raw: unknown): string {
  validateFilePath(raw);
  const target = resolve(root, raw);
  checkRealBoundary(root, target);
  return target;
}

/** 工作文件与唯一持久库均使用完整相对路径，并逐次验证真实边界。 */
export function workPath(root: string, raw: unknown, tool: string): { rel: string; full: string } {
  const given=raw;
  raw=sourcePath(raw);
  validateFilePath(raw);
  if (raw === LIBRARY_PATH) {
    if(given!==KTOOLS_FILE)throw new Error(`Use ${KTOOLS_FILE} for the persistent library`);
    for (const part of ['memory','memory/oks','memory/oks/tools',LIBRARY_PATH]) {
      try { if(lstatSync(resolve(root,part)).isSymbolicLink()) throw new Error(`${tool}: library symlinks are not allowed`); }
      catch(error) { if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error; }
    }
    return {rel:given as string,full:workspaceFilePath(root,raw)};
  }
  if (!raw.startsWith(`${WORK_DIR}/`)) throw new Error(`${tool} 需要 oks://work/ 下的完整文件地址，例如 oks://work/analysis.jq`);
  const full = workspaceFilePath(root, raw);
  const base = resolve(root, WORK_DIR);
  if (existsSync(base)) {
    const realBase = realpathSync(base);
    let candidate = full;
    while (!existsSync(candidate)) candidate = dirname(candidate);
    const inside = relative(realBase, realpathSync(candidate));
    if (inside.startsWith('..') || isAbsolute(inside)) throw new Error(`${tool} 路径经符号链接越出 ${WORK_DIR}/。`);
  }
  return { rel: given as string, full };
}

/** `.work/` 里的现有文件（按名字排序）：agent 换会话回来时先看这个。 */
export function listWorkFiles(root: string): Array<{ name: string; bytes: number; modifiedAt: string }> {
  const base = join(root, WORK_DIR);
  checkRealBoundary(root, base);
  let entries: string[];
  try {
    entries = readdirSync(base, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .sort();
  } catch {
    entries=[];
  }
  const files=entries.map((name) => {
    const info = statSync(join(base, name));
    return {
      name: `${WORK_DIR}/${name}`,
      bytes: info.size,
      modifiedAt: new Date(info.mtimeMs).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    };
  });
  const library=workPath(root,KTOOLS_FILE,'oks_list');
  if(existsSync(library.full)) {
    const info=statSync(library.full);
    files.push({name:KTOOLS_FILE,bytes:info.size,modifiedAt:info.mtime.toISOString().replace(/\.\d{3}Z$/, 'Z')});
  }
  return files;
}

/** 把父目录建出来，再做一次真实路径复核（父目录若是符号链接指向 `.work/` 外面，这里就挡住）。 */
function ensureInsideWork(root: string, target: string): void {
  mkdirSync(dirname(target), { recursive: true });
  const base = realpathSync(resolve(root, relative(root,target)===LIBRARY_PATH?dirname(LIBRARY_PATH):WORK_DIR));
  const real = realpathSync(dirname(target));
  const inside = relative(base, real);
  if (inside.length > 0 && (inside.startsWith('..') || isAbsolute(inside))) {
    throw new Error(`${WORK_DIR}/ 里的父目录指向了外面，拒绝写入：${JSON.stringify(target)}`);
  }
  const targetInside = existsSync(target) ? relative(base, realpathSync(target)) : '';
  if (targetInside.startsWith('..') || isAbsolute(targetInside)) {
    throw new Error(`${WORK_DIR}/ 里的这个文件指向了外面，拒绝写入`);
  }
}

/** 写一份 `.work/` 下的文本文件：父目录按需创建，已存在就覆盖（它是 agent 自己的工作区，
 *  没有"独占创建"这条规矩——`edit` 与重写是它迭代代码的方式）。 */
/** 删一份 `.work/` 下的文件。只删文件——目录要先把它里面的文件删掉。 */
export function deleteWorkFile(root: string, raw: unknown): { file: string; remaining: number } {
  const { rel, full } = workPath(root, raw, 'oks_delete');
  let info: ReturnType<typeof statSync>;
  try {
    info = statSync(full);
  } catch {
    throw new Error(`oks_delete 找不到 ${rel}。`);
  }
  if (!info.isFile()) {
    throw new Error(`oks_delete 只能删文件：${rel} 是一个目录（先删它里面的文件）。`);
  }
  unlinkSync(full);
  return { file: rel, remaining: listWorkFiles(root).length };
}

export function writeWorkFile(root: string, path: unknown, content: unknown, tool: string): {
  file: string; bytes: number; created: boolean;
} {
  const { rel, full } = workPath(root, path, tool);
  if (typeof content !== 'string') throw new Error(`${tool} 需要 content（要写入的文本）`);
  const bytes = Buffer.byteLength(content);
  if (bytes > WORK_MAX_BYTES) {
    throw new Error(`这份内容 ${(bytes / 1024).toFixed(0)} KB，超过 ${WORK_DIR}/ 单份文件的上限 `
      + `${WORK_MAX_BYTES / 1024} KB：拆成几份。`);
  }
  const created = !existsSync(full);
  ensureInsideWork(root, full);
  writeFileSync(full, content);
  return { file: rel, bytes, created };
}

/** 改一份 `.work/` 下的文本文件：字面替换。`old` 必须原样出现——找不到、或出现多次而没开
 *  `replaceAll`，都报出来（改错地方的代价比多问一句高）。 */
/** 读 `.work/` 下**一整份文本文件**（不限扩展名）：报告正文这类"内容文件"走它。
 *  与 `readCodeFile` 的分工：那个只认 `.jq`（程序），这个认内容。 */
export function readWorkText(root: string, raw: unknown, tool: string): { text: string; file: string } {
  const { rel, text } = readWorkTextWhole(root, raw, tool);
  return { text, file: rel };
}

export function prepareWorkEdit(root: string, path: unknown, old: unknown, next: unknown, replaceAll: unknown, tool: string): {
  file: string; replaced: number; bytes: number; body:string; original:string;
} {
  const { rel } = workPath(root, path, tool);
  if (typeof old !== 'string' || old === '') throw new Error(`${tool} 需要 old：要替换掉的原样文本`);
  if (typeof next !== 'string') throw new Error(`${tool} 需要 new：替换成什么`);
  const {text}=readWorkTextWhole(root,path,tool);
  const parts = text.split(old);
  const replaced = parts.length - 1;
  if (replaced === 0) {
    throw new Error(`${rel} 里没有出现要替换的那段文本（${JSON.stringify(capLine(old, 60))}）：`
      + 'old 必须与文件里的内容逐字相同（含空格与缩进）。');
  }
  if (replaced > 1 && replaceAll !== true) {
    throw new Error(`${rel} 里出现了 ${replaced} 次：要么把 old 写得更长以唯一定位，要么传 replaceAll: true 全部替换。`);
  }
  const body = parts.join(next);
  const bytes = Buffer.byteLength(body);
  if (bytes > WORK_MAX_BYTES) {
    throw new Error(`改完是 ${(bytes / 1024).toFixed(0)} KB，超过 ${WORK_DIR}/ 单份文件的上限。`);
  }
  return { file: rel, replaced, bytes, body, original:text };
}

export function editWorkFile(root:string,path:unknown,old:unknown,next:unknown,replaceAll:unknown,tool:string) {
  const prepared=prepareWorkEdit(root,path,old,next,replaceAll,tool);
  writeWorkFile(root,prepared.file,prepared.body,tool);
  return {file:prepared.file,replaced:prepared.replaced,bytes:prepared.bytes};
}

/** 读 `.work/` 下**一整份文本文件**：`readWorkFile`（给 agent 看的行窗口）与报告正文都用它。
 *  路径校验、文件不存在时的提示、单份文件上限都在这里，只有这一处。 */
function readWorkTextWhole(root: string, path: unknown, tool: string): { rel: string; text: string } {
  const { rel, full } = workPath(root, path, tool);
  let text: string;
  try {
    text = rel===KTOOLS_FILE&&!existsSync(full)?KTOOLS_INITIAL_SOURCE:readFileSync(full, 'utf8');
  } catch {
    throw new Error(`读不到 ${rel}`
      + `。材料、图表件与报告不在 ${WORK_DIR}/ 下：要读它们用 oks_project（用 select 选择或 transform 处理）；`
      + `${WORK_DIR}/ 只装你自己写的文件。`);
  }
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > WORK_MAX_BYTES) {
    throw new Error(`${rel} ${(bytes / 1024).toFixed(0)} KB，超过 ${WORK_DIR}/ 单份文件的上限：拆成几份。`);
  }
  return { rel, text };
}

/** Bounded source read; large files stream while the full line count remains exact. */
export async function readWorkFile(root:string,path:unknown,offset:unknown,limit:unknown,tool:string) {
  readArgs(offset,limit);
  const {rel,full}=workPath(root,path,tool);
  if(rel===KTOOLS_FILE&&!existsSync(full))return readTextLines(KTOOLS_INITIAL_SOURCE,rel,offset,limit,tool);
  const stat=statSync(full);
  if(!stat.isFile())throw new Error(`Not a regular file: ${rel}`);
  const chunks=stat.size>=READ_STREAM_MIN_SIZE?createReadStream(full,{encoding:'utf8'}):[readFileSync(full,'utf8')];
  return readWindow(chunks,rel,offset,limit);
}

export function readTextLines(text:string,rel:string,offset:unknown,limit:unknown,_tool:string) {
  return readWindow([text],rel,offset,limit);
}

/** `.work/` 里现有的代码文件（报错时列给 agent 看，免得它反复猜文件名）。 */
function codeFiles(root: string): string {
  try {
    const names = readdirSync(join(root, WORK_DIR)).filter((name) => name.endsWith('.jq')).sort();
    return names.length === 0 ? `（${WORK_DIR}/ 里还没有 .jq 文件）` : names.map((name) => `${WORK_DIR}/${name}`).join('、');
  } catch {
    return `（还没有 ${WORK_DIR}/ 目录）`;
  }
}

export const isCodeFile = (name: string): boolean => name.endsWith('.jq');

/** 读一份代码文件：`.work/` 下的 `.jq`，`oks_project` 的 `jq.src` 指向它。
 *
 *  为什么代码只走文件、不进参数：内层语言（jq）与外层序列化（JSON）的语法长得像，模型一进
 *  "代码模式"就会把 jq 的 `{a: b}` 直接写成 JSON 值（实测 13 次整轮失败里有 3 次是这样）。
 *  参数里只留一个文件名，两侧语法就不再相邻；程序本身用 `oks_write` 写、`oks_edit` 增量改，
 *  还能回读、报错能带上下文。 */
export function readCodeFile(root: string, raw: unknown): { text: string; file: string } {
  const { rel, full } = workPath(root, raw, 'jq.src');
  if (!isCodeFile(rel)) {
    throw new Error(`jq.src 指向的是一段 jq 程序：文件名要以 .jq 结尾（收到 ${JSON.stringify(rel)}）`);
  }
  let text: string;
  try {
    text = readFileSync(full, 'utf8');
  } catch {
    throw new Error(`读不到 ${rel}`
      + `。jq.src 只认 ${WORK_DIR}/ 下的 .jq：先用 oks_write 写出这个程序。`);
  }
  const bytes = Buffer.byteLength(text);
  if (bytes > CODE_MAX_BYTES) {
    throw new Error(`${rel} 有 ${(bytes / 1024).toFixed(0)} KB，超过单份代码的上限 `
      + `${CODE_MAX_BYTES / 1024} KB：把它拆成几份，或改用别的办法。`);
  }
  return { text, file: rel };
}

/** 从一份 data 里取行对象数组：`{ rows, … }` 与"data 直接就是数组"两种形状都认。
 *  标量、对象、嵌套是加工结果的常态，直接读取绑定值；这里明确拒绝，
 *  免得形状不对的数据一路走到绘图那层才报出一句看不懂的错。 */
export function rowsOf(data: unknown, asset: unknown): Array<Record<string, unknown>> {
  const rows = isRecord(data) ? data.rows : data;
  if (!Array.isArray(rows)) {
    throw new Error(`这份数据的 data 不是行对象数组：${JSON.stringify(asset)}。`
      + '要画图就先在稿件中把它加工成行对象数组。');
  }
  if (isRecord(data) && data.columns !== undefined) {
    if (!Array.isArray(data.columns)) throw new Error('data.columns 需要列声明数组。');
    for (const [index, column] of data.columns.entries()) {
      if (!isRecord(column) || typeof column.name !== 'string' || column.name.trim() === ''
          || (!isResultColumn(column) && (!Array.isArray(column.types) || !column.types.every((type: unknown) => typeof type === 'string')))
          || typeof column.nullable !== 'boolean') {
        throw new Error(`data.columns[${index}] 列声明无效：需要 {"name":"count","type":"Int","nullable":false} 或带 types 数组的列对象；行对象数组或仅带 rows 的对象也可直接用于表格与图表。`);
      }
    }
  }
  return rows as Array<Record<string, unknown>>;
}
