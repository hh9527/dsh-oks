import { createHash } from 'node:crypto';
import { existsSync, linkSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, unlinkSync,
  writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { errorText, isRecord } from './host.ts';
import { capLine } from './text.ts';
import { CHART_KINDS } from './chart/shared.ts';

// 查询结果与产物的落盘与读取（见 rfc/0001 的「查询结果保存」，封装与来源链见 rfc/0005）。
// 一份**文件**是 { meta, origin, data }：meta 说这是什么，origin 是产生这份数据的操作及它的
// **完整上游来源链**，data 就是那次操作的结果本身（jq 的默认输入）。来源链整份以**节点表**写在
// 文件里（每次物化是一条记录：操作 + 它产出的内容，算一个节点；共享祖先只存一份，引用是文件内的
// 节点 ID）——于是文件离开工作区也能解释自己的来路。
// 图与报告已经有原生自述元素（`<metadata>`、`<meta>`），meta 就写在那里，材料块里只有 origin 与 data；
// 其余文件三段一起写在 JSON 里。
// 每个成功 Intent 一个 JSON 文件、每张图与每份报告各一个文件，名字统一是
// <时间>-<名字>[-<内容哈希>].<类别><扩展名>（见 artifactName）。
// 结果文件里带着完整数据行与列信息——于是数据行可以只被「引用」，不必默认进入模型上下文。

/** 结果文件所在的目录（相对工作区根）。 */
export const ARTIFACT_DIR = 'artifacts';

// 内部材料与交付物分开放（rfc/0005 决策 1，命名见 rfc/0007）：
//   - 查询、加工与自填的**封装数据** → `.oks/data/`（可回收的内部材料）
//   - **图表件**（图 `<名>.<图元>.svg`、表 `<名>.table.md`）→ `.oks/figures/`（报表的组成材料）
//   - **报表** → `artifacts/`（交付物：按保活清理，可显式保留）
export const DATA_DIR = '.oks/data';
export const FIGURE_DIR = '.oks/figures';
/** agent 的**代码**工作区：jq 程序这类"内容"放这里，工具按引用读——见 readCodeFile。 */
export const WORK_DIR = '.work';

/** 一类产物落在哪个目录。图与表同住图表件目录；加工结果与查询结果同属数据材料。 */
export const dirForKind = (kind: ArtifactKind): string =>
  kind === 'chart' || kind === 'table' ? FIGURE_DIR
    : kind === 'report' ? ARTIFACT_DIR : DATA_DIR;

/** 可以被引用与读取的目录（校验按它来；其余路径一律拒绝）。 */
export const READABLE_DIRS = [DATA_DIR, FIGURE_DIR, ARTIFACT_DIR];

/** 落盘时写在名字中间的那个"文件类别"：材料取短名，**图直接写图元**（`pie.svg` 而不是
 *  `chart.svg`）——文件名自己说清是什么图（rfc/0007）。 */
export const fileKindOf = (kind: ArtifactKind, chartKind?: string): string => {
  if (kind === 'query') return 'qres';
  if (kind === 'transform') return 'tr';
  if (kind === 'data') return 'def';
  if (kind === 'chart') return chartKind ?? 'chart';
  return kind;   // table / report 原样
};

/** 文件名里的类别 → 语义类别：读路径反过来认（账本、清单与来源链仍按语义类别）。 */
export const kindOfFile = (fileKind: string): ArtifactKind | undefined => {
  if (fileKind === 'qres') return 'query';
  if (fileKind === 'tr') return 'transform';
  if (fileKind === 'def') return 'data';
  if (fileKind === 'table') return 'table';
  if (fileKind === 'report') return 'report';
  return (CHART_KINDS as readonly string[]).includes(fileKind) ? 'chart' : undefined;
};

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

/** 来源链里的一个节点：一次操作的记录。查询与加工各用其中一部分字段。 */
export interface OriginNode {
  /** 产生这份数据的操作：查询、加工、agent 给定、从报告取出，或（早期版本的）派生视图。
   *  `extract` 与 `derive` 都已经不再产生，读取时仍认——旧文件是可回收的内部材料，随保活消失。 */
  kind: 'query' | 'transform' | 'input' | 'extract' | 'derive' | 'report';
  /** query：实际提交并通过校验的意图（相对时间已解析成绝对边界）。 */
  intent?: unknown;
  /** 这次操作的动机：一句自然语言，写给人读。 */
  motivation?: string;
  /** query：执行时**实际**用的数据来源（与 intent 的"请求什么"形成对照）。 */
  source?: unknown;
  /** transform：实际执行的 snip（**程序正文**；来自文件的也记正文，`.work/` 被清掉也不影响来路）。
   *  省略 `byFile` 时它是恒等投影 `.`。 */
  snip?: string;
  /** transform：这段程序来自哪份代码文件（`byFile` 给出的那一份）。 */
  snipFile?: string;
  /** 报告序列化形态：源码集中放在报告的 `assets` 里，节点用 `asset://<key>` 引用它。
   *  报告是唯一使用这种引用形态的地方——普通材料照旧把程序正文内嵌在 `snip` 里。 */
  byFile?: string;
  /** transform：从结果里取回的那一段（jq 点路径，`snip` 是 `.` 时它就是这次操作的全部内容）。 */
  pick?: string;
  /** transform：表达式产出了几个值。它把"恰好一个数组值"与"多个输出"分开，
   *  于是 `data: []` 是"一个空数组"还是"没有输出"有据可查。 */
  outputs?: number;
  /** transform / extract：输入名 → 上游操作在**本文件内**的节点 ID。 */
  inputs?: Record<string, string>;
  /** 与 `inputs` 配套：输入名 → 从那份产物里选取数据用的点路径（RFC 0008 §4）。
   *  以前只记"用了哪个输入"，这一项把"切了哪一段"也记下来。 */
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

/** 一份文件开头的那段自述：它是什么、叫什么、什么时候落的。
 *  它就是图与报告那个原生自述元素里的内容（`<metadata id="dsh-oks-artifact">` /
 *  `<meta name="dsh-oks-artifact">`）——清单、页签与转发出去的单文件都靠它认出自己是什么。 */
export interface EnvelopeMeta {
  kind: ArtifactKind;
  /** 文件名里的名字段（标识，不是标题）。 */
  name: string;
  /** 落盘时刻，UTC；与文件名最前面那一段逐字相同。 */
  at: string;
  /** 给人看的标题。图、表、报告里永不为空；数据材料没有标题。 */
  title?: string;
  /** 更精确的分类（周报、月报、即时分析…）。大类由 `kind` 表达、用图标呈现，这一项是文字。 */
  category?: string;
}

/** 一份文件的完整形态：自述 + 来源链 + 数据。三段各回答一件事——
 *  `meta`：这是什么；`origin`：这些数据从哪来；`data`：数据本身（jq 的默认输入就是它）。
 *
 *  已经有原生自述元素的那两种产物（图、报告）把 `meta` 写在那个元素里——那个位置读文件开头几个
 *  字节就够，材料块里于是只有 `origin` 与 `data`（见 `EnvelopeParts`）；其余文件三段一起写。
 *  形状靠结构认，**没有版本号**：认不出的结构直接报错，不猜。 */
export interface Envelope<T = unknown> {
  meta: EnvelopeMeta;
  origin: DataOrigin;
  data: T;
}

/** 自述写在原生元素里的那两种产物（图、报告）的材料块：只剩来源与数据。 */
export type EnvelopeParts<T = unknown> = Pick<Envelope<T>, 'origin' | 'data'>;

/** 读一份文件时默认取的那一段：`data` 本身。jq 的具名输入没有特别指定 `root` 时就是它。 */
export const DEFAULT_ROOT = '.data';

/** 查询结果的 data：行与列一起表达——"有哪些列"是这份数据的一部分，不是它的同级描述。 */
export interface RowsData {
  rows: Array<Record<string, unknown>>;
  columns: ColumnInfo[];
}

export type ResultFile = Envelope<RowsData>;

/** 单份封装的大小上限（字节）。超限时明确失败，让调用方先收窄 snip——
 *  写出一份读不动的封装，比当场报错更糟。 */
export const ENVELOPE_MAX_BYTES = 8 * 1024 * 1024;

/** at：该项成功执行结束的 UTC 时间，格式 YYYYMMDDTHHmmssZ（到秒）。它是文件名最前面那一段；
 *  图与报告的自述里也带着同一个值，于是名字和文件内容对得起来（结果文件没有自述那一层）。 */
export const resultStamp = (when: Date = new Date()): string =>
  when.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');

/** artifacts/ 里的产物类别。它进文件名，与扩展名各管一件事。
 *  query / transform / data 都是数据材料（落在 .oks/data/），只有图与报告在文件里自述。 */
export type ArtifactKind = 'query' | 'transform' | 'data' | 'chart' | 'table' | 'report';

/** 在文件里带自述的类别：图与报告各用一种原生写法，数据材料没有自述那一层。 */
export type SelfDescribingKind = 'chart' | 'report';

/** 类别的中文名，只用在报错里。 */
const KIND_LABEL: Record<ArtifactKind, string> = {
  query: '结果', transform: '加工结果', data: '输入数据',
  chart: '图表', table: '表格', report: '报告',
};

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
  /** 一次 transform 实际做了什么：恒等投影时全部内容都在 `pick` 上，所以那份程序先亮出来。 */
  const program = (node: OriginNode): string =>
    (node.snip === undefined || node.snip === '.' ? node.pick ?? node.snip ?? '' : node.snip);
  const detail = (node: OriginNode): string => (node.kind === 'query'
    ? `query ${node.intent === undefined ? '' : capLine(canonicalJson(node.intent), 96)}`
    : node.kind === 'input' ? '输入数据（agent 给定）'
      : node.kind === 'extract'
        ? `从报告 ${node.report ?? '(未知)'} 的第 ${node.item ?? '?'} 项取出`
        : node.kind === 'derive'
          ? `派生自 ${node.from ?? '(未知)'}`
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

/** 产物自述：写进文件里的一份元数据。清单、页签与转发出去的单文件都靠它认出自己是什么。
 *  它和图的材料块是同一份 `Envelope` 的自述那一段（见 `EnvelopeMeta`），只是这两处写成原生元素。 */
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

/** 独占写一个产物文件。
 *
 *  名字里带着内容哈希时，"撞名"就是**同样的内容**，直接当去重（返回同一个路径）是安全的；
 *  查询结果那段是文件名前缀而不是内容哈希，所以撞名必须读出来核一遍——一致才认作同一份，
 *  不一致就报错。两条路都不覆盖任何已有的文件。 */
const writeExclusive = (target: string, content: string, kind: ArtifactKind): void => {
  const problem = (cause: unknown): Error => new Error(`保存${KIND_LABEL[kind]}失败：${errorText(cause)}`);
  const sameContent = (): boolean => {
    try {
      return contentHash(readFileSync(target, 'utf8')) === contentHash(content);
    } catch {
      return false;   // 读不到（正好被删掉）就不认作同一份
    }
  };
  // 先写成同目录下的**临时文件**，再用 link 原子地认领目标名：读者要么看到完整的旧文件、
  // 要么看到完整的新文件，不会看到半份（报告几 MB，直接写目标文件会留下一段可读的残片）。
  // link 在目标已存在时失败，正好就是"不覆盖任何已有文件"那条规则。
  const temp = `${target}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.part`;
  try {
    try {
      writeFileSync(temp, content, { flag: 'wx' });
    } catch (cause) {
      throw problem(cause);
    }
    try {
      linkSync(temp, target);
      return;
    } catch (cause) {
      const code = (cause as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') {
        if (!sameContent()) throw new Error(`保存${KIND_LABEL[kind]}失败：${target} 已存在且内容不同`);
        return;
      }
      if (code !== 'EPERM' && code !== 'EOPNOTSUPP' && code !== 'ENOSYS') throw problem(cause);
    }
    // 文件系统不支持硬链接：退回独占创建（语义一样，只是少了"半份不可见"这一层）。
    try {
      writeFileSync(target, content, { flag: 'wx' });
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'EEXIST' && sameContent()) return;
      throw problem(cause);
    }
  } finally {
    try { unlinkSync(temp); } catch { /* 已经不在就算了 */ }
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
  intent: unknown;
  rows: readonly Record<string, unknown>[];
  sqlColumns: readonly string[];
  /** 这次查询的动机（可缺）。 */
  motivation?: string;
  /** 执行时实际用的数据来源（可缺；只写观察到的，未知就不写）。 */
  source?: unknown;
}): SavedResult {
  const problem = nameProblem(options.name);
  if (problem !== null) throw new Error(`结果文件名不合法：${problem}`);
  const directory = join(options.root, DATA_DIR);
  mkdirSync(directory, { recursive: true });
  const at = resultStamp();
  const { columns, rows } = describeRows(options.sqlColumns, options.rows);
  const data: RowsData = { rows, columns };
  const payload: ResultFile = {
    meta: { kind: 'query', name: options.name, at },
    origin: originOf({
      kind: 'query',
      intent: options.intent,
      ...(options.motivation === undefined || options.motivation.trim() === ''
        ? {} : { motivation: options.motivation.trim() }),
      ...(options.source === undefined ? {} : { source: options.source }),
    }, data),
    data,
  };
  const body = `${JSON.stringify(payload, null, 2)}\n`;
  const fileName = artifactName({ at, name: options.name, kind: 'qres', extension: '.json', content: body });
  writeExclusive(join(directory, fileName), body, 'query');
  return { dataSrc: `${DATA_DIR}/${fileName}`, columns, rowCount: rows.length };
}

/** 物化一次加工：来源链由这一层组装——合并各输入的链、加入本次操作、把根指向它。
 *  `node` 是本次操作的记录（snip、动机、输出个数、各输入名指向的根节点 ID），
 *  身份由它与产出内容共同决定。
 *  与查询结果同一套命名、独占创建与"不留半个文件"的规则；超过上限时报错，不落半份。 */
export function saveTransform(options: {
  root: string;
  name: string;
  node: OriginNode;
  inputs: readonly DataOrigin[];
  data: unknown;
}): { dataSrc: string; bytes: number; origin: DataOrigin } {
  const problem = nameProblem(options.name);
  if (problem !== null) throw new Error(`加工结果名不合法：${problem}`);
  const at = resultStamp();
  const origin = appendNode(options.inputs, options.node, options.data);
  const payload: Envelope = {
    meta: { kind: 'transform', name: options.name, at },
    origin,
    data: options.data,
  };
  const body = `${JSON.stringify(payload, null, 2)}\n`;
  const bytes = Buffer.byteLength(body);
  if (bytes > ENVELOPE_MAX_BYTES) {
    throw new Error(`这份加工结果 ${(bytes / 1024 / 1024).toFixed(1)} MB，超过单份封装的上限 `
      + `${ENVELOPE_MAX_BYTES / 1024 / 1024} MB：先在 snip 里聚合或投影，再物化。`);
  }
  const directory = join(options.root, DATA_DIR);
  mkdirSync(directory, { recursive: true });
  const fileName = artifactName({ at, name: options.name, kind: 'tr', extension: '.json', content: body });
  writeExclusive(join(directory, fileName), body, 'transform');
  return { dataSrc: `${DATA_DIR}/${fileName}`, bytes, origin };
}

/** 把 agent 自己给的一份数据落成封装：这是"给定数据"进入工作区的唯一入口。
 *  它和查询结果、加工结果平级——同样的独占创建、同样的上限，于是图与后续加工都能引用它，
 *  而它就带着自己的动机与"这份数据是给定的"这条事实。 */
export function saveInputData(options: {
  root: string;
  name: string;
  motivation: string;
  data: unknown;
}): { dataSrc: string; bytes: number } {
  const problem = nameProblem(options.name);
  if (problem !== null) throw new Error(`输入数据名不合法：${problem}`);
  const at = resultStamp();
  const payload: Envelope = {
    meta: { kind: 'data', name: options.name, at },
    origin: originOf({ kind: 'input', motivation: options.motivation }, options.data),
    data: options.data,
  };
  const body = `${JSON.stringify(payload, null, 2)}\n`;
  const bytes = Buffer.byteLength(body);
  if (bytes > ENVELOPE_MAX_BYTES) {
    throw new Error(`这份数据 ${(bytes / 1024 / 1024).toFixed(1)} MB，超过单份封装的上限 `
      + `${ENVELOPE_MAX_BYTES / 1024 / 1024} MB：先缩小范围，再落成封装。`);
  }
  const directory = join(options.root, DATA_DIR);
  mkdirSync(directory, { recursive: true });
  const fileName = artifactName({ at, name: options.name, kind: 'def', extension: '.json', content: body });
  writeExclusive(join(directory, fileName), body, 'data');
  return { dataSrc: `${DATA_DIR}/${fileName}`, bytes };
}

/** 表展示件里的材料：来源链 + 展示数据（与它自己的自述一起）。表没有原生自述元素，
 *  于是自述也写在这个文件头的注释里——形状和 `.oks/data/` 里那些封装完全一样。 */
export type ViewMaterial = Envelope<DisplayData>;

/** 材料在 markdown 文件里的写法：文件最前面的一个 HTML 注释（markdown 渲染时不可见）。 */
const VIEW_MARKER = 'dsh-oks-table-input';

/** 把材料写成 markdown 文件头的那一行注释。 */
const viewComment = (material: ViewMaterial): string =>
  `<!-- ${VIEW_MARKER} ${JSON.stringify(material)} -->\n`;

/** 读一份表展示件：材料（从注释里抓）与 markdown 本体（注释之后的部分）。
 *  注释不在，说明这不是我们写的表——报 null，让调用方明确失败。 */
export function readTableView(content: string): { material: ViewMaterial; markdown: string } | null {
  const match = new RegExp(`^<!-- ${VIEW_MARKER} (.*?) -->\n`).exec(content);
  if (match === null) return null;
  try {
    const material = JSON.parse(match[1]) as ViewMaterial;
    if (material?.origin === undefined || material?.data === undefined) return null;
    return { material, markdown: content.slice(match[0].length) };
  } catch {
    return null;
  }
}

/** 落一份表展示件：`markdown` 是表本体（人在工作区里直接读得懂），材料与自述附在文件头。 */
export function saveTableView(options: {
  root: string;
  name: string;
  /** 给人看的表注；给了就写进自述。 */
  title?: string;
  origin: DataOrigin;
  data: DisplayData;
  markdown: string;
}): { src: string; bytes: number } {
  const problem = nameProblem(options.name);
  if (problem !== null) throw new Error(`表格名不合法：${problem}`);
  const at = resultStamp();
  const material: ViewMaterial = {
    meta: {
      kind: 'table',
      name: options.name,
      at,
      ...(options.title === undefined || options.title === '' ? {} : { title: options.title }),
    },
    origin: options.origin,
    data: options.data,
  };
  const body = `${viewComment(material)}${options.markdown}`;
  const bytes = Buffer.byteLength(body);
  if (bytes > ENVELOPE_MAX_BYTES) {
    throw new Error(`这张表 ${(bytes / 1024 / 1024).toFixed(1)} MB，超过单份展示件上限 `
      + `${ENVELOPE_MAX_BYTES / 1024 / 1024} MB：先把数据聚合或投影，再出表。`);
  }
  const directory = join(options.root, FIGURE_DIR);
  mkdirSync(directory, { recursive: true });
  const fileName = artifactName({ at, name: options.name, kind: 'table', extension: '.md', content: body });
  writeExclusive(join(directory, fileName), body, 'table');
  return { src: `${FIGURE_DIR}/${fileName}`, bytes };
}

/** 把一份产物（图、报告）写成文件：与结果文件同一套命名与独占创建规则。
 *  返回的 src 是相对工作区根的路径，交给 agent 粘进回答引用。 */
export interface SaveArtifactOptions {
  root: string;
  name: string;
  content: string;
  extension: string;
  kind: SelfDescribingKind;
  /** 文件名中间那个类别；不写就用语义类别。图传它的图元（`pie` → `<名>.pie.svg`）。 */
  fileKind?: string;
  /** 给人看的标题。**永不为空**：调用方在 agent 没给时负责造一个，这里只守门。 */
  title: string;
  /** 更精确的分类（周报、月报、即时分析…）；没给就不写这一项。 */
  category?: string;
  /** 落盘时刻；不写就用当前时刻。报告要把同一个时刻嵌进页面，所以由调用方先定。 */
  at?: string;
  /** 内容里已经嵌好自述（报告页面在写入自校验时就在里面了），保存这一层不再插一次。 */
  contentHasMeta?: boolean;
}

export function saveArtifact(options: SaveArtifactOptions): { src: string; at: string; meta: ArtifactMeta } {
  const problem = nameProblem(options.name);
  if (problem !== null) {
    throw new Error(`${KIND_LABEL[options.kind]}名不合法（${JSON.stringify(options.name)}）：${problem}`);
  }
  if (typeof options.title !== 'string' || options.title.trim() === '') {
    throw new Error(`${KIND_LABEL[options.kind]}的标题不能为空：产物自述里那一行永远有值，`
      + 'agent 没给标题时由工具按维度与度量造一个。');
  }
  const at = options.at ?? resultStamp();
  const meta: ArtifactMeta = {
    name: options.name,
    kind: options.kind,
    at,
    title: options.title,
    ...(options.category === undefined ? {} : { category: options.category }),
  };
  // 先嵌自述、再算名字：文件名里的内容哈希必须等于**最终字节**的哈希。
  const content = options.contentHasMeta === true ? options.content : embedArtifactMeta(options.content, meta);
  const directory = dirForKind(options.kind);
  mkdirSync(join(options.root, directory), { recursive: true });
  const fileName = artifactName({
    at,
    name: options.name,
    kind: options.fileKind ?? options.kind,
    extension: options.extension,
    content,
  });
  writeExclusive(join(options.root, directory, fileName), content, options.kind);
  // 把**同一个 meta 对象**交回调用方去记账：产出方手里本来就有它，不必再从文件里读回来
  // （读回来还要解一遍 XML 转义、还要赌文件形状，而这两件事都会以"清单里少一条"收场）。
  return { src: `${directory}/${fileName}`, at, meta };
}

/** 定位一个引用：它必须落在某个可读目录里（内部材料或交付物），并返回那个目录。
 *  越界与"不在任何目录里"是同一类错误：修法都是换一个引用。 */
function locate(root: string, src: unknown): { directory: string; target: string } {
  if (typeof src !== 'string' || src.length === 0) {
    throw new Error('需要一个 src（工具回执里给的那个相对路径）');
  }
  const target = resolve(root, src);
  for (const directory of READABLE_DIRS) {
    const base = resolve(root, directory);
    const inside = relative(base, target);
    if (inside.length > 0 && !inside.startsWith('..') && !isAbsolute(inside)) {
      return { directory, target };
    }
  }
  throw new Error(`引用只能指向工作区里的 ${READABLE_DIRS.join(' / ')}：${JSON.stringify(src)}`);
}

/** dataSrc 的语法范围：只接受能在工作区可读目录里落位的相对路径。 */
export function resolveDataSrc(root: string, dataSrc: unknown): string {
  return locate(root, dataSrc).target;
}

/** 把一个 artifacts/ 里的产物定位到真实路径：先按前缀收窄，再用真实路径复核（挡住符号链接逃逸）。
 *  "找不到"与"越界"要分开报——这两种错，修法完全不同。 */
function artifactPath(root: string, src: unknown): string {
  const { directory, target } = locate(root, src);
  let real: string;
  try {
    real = realpathSync(target);
  } catch {
    throw new Error(`找不到 ${JSON.stringify(src)}`);
  }
  const realDirectory = realpathSync(resolve(root, directory));
  const inside = relative(realDirectory, real);
  if (inside.length === 0 || inside.startsWith('..') || isAbsolute(inside)) {
    throw new Error(`引用指向的路径不在工作区 ${directory}/ 里：${JSON.stringify(src)}`);
  }
  return real;
}

/** 单份代码文件的字节上限：它是**能被 `snip` 引用为程序**的上限——一份这么大的程序说明该拆开。 */
export const CODE_MAX_BYTES = 64 * 1024;

/** `.work/` 里单份文本文件的上限（存得住的上限，比"能当程序引用的上限"宽）。 */
export const WORK_MAX_BYTES = 256 * 1024;

/** `.work/` 下的路径解析：接受 `x.jq` 与 `.work/x.jq` 两种写法，并保证落在 `.work/` 内。
 *
 *  它是**执行层面的约束**：不看提示词、不猜意图，越界一律拒绝。`..` 与绝对路径在词法上就被挡下；
 *  目标或其父目录若是符号链接，再用真实路径复核一遍（挡住"链接指向外面"这种绕法）。 */
export function workPath(root: string, raw: unknown, tool: string): { rel: string; full: string } {
  const given = typeof raw === 'string' ? raw.trim() : '';
  if (given === '') throw new Error(`${tool} 需要 path：${WORK_DIR}/ 下的相对路径，例如 analysis.jq`);
  const rel = given.startsWith(`${WORK_DIR}/`) ? given.slice(WORK_DIR.length + 1) : given;
  if (rel === '' || rel.endsWith('/')) {
    throw new Error(`${tool} 的 path 要指向一个文件：收到 ${JSON.stringify(raw)}`);
  }
  if (isAbsolute(given) || isAbsolute(rel)) {
    throw new Error(`${tool} 的 path 是 ${WORK_DIR}/ 下的相对路径，不能是绝对路径：${JSON.stringify(raw)}`);
  }
  const base = resolve(root, WORK_DIR);
  const full = resolve(base, rel);
  const inside = relative(base, full);
  if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) {
    throw new Error(`${tool} 只能读写工作区 ${WORK_DIR}/ 下的文件（不能越出这一层）：${JSON.stringify(raw)}`);
  }
  return { rel: `${WORK_DIR}/${rel}`, full };
}

/** `.work/` 里的现有文件（按名字排序）：agent 换会话回来时先看这个。 */
export function listWorkFiles(root: string): Array<{ name: string; bytes: number; modifiedAt: string }> {
  const base = join(root, WORK_DIR);
  let entries: string[];
  try {
    entries = readdirSync(base, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
  return entries.map((name) => {
    const info = statSync(join(base, name));
    return {
      name: `${WORK_DIR}/${name}`,
      bytes: info.size,
      modifiedAt: new Date(info.mtimeMs).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    };
  });
}

/** 把父目录建出来，再做一次真实路径复核（父目录若是符号链接指向 `.work/` 外面，这里就挡住）。 */
function ensureInsideWork(root: string, target: string): void {
  mkdirSync(dirname(target), { recursive: true });
  const base = realpathSync(resolve(root, WORK_DIR));
  const real = realpathSync(dirname(target));
  const inside = relative(base, real);
  if (inside.length > 0 && (inside.startsWith('..') || isAbsolute(inside))) {
    throw new Error(`${WORK_DIR}/ 里的父目录指向了外面，拒绝写入：${JSON.stringify(target)}`);
  }
  if (existsSync(target) && !realpathSync(target).startsWith(base)) {
    throw new Error(`${WORK_DIR}/ 里的这个文件指向了外面，拒绝写入`);
  }
}

/** 写一份 `.work/` 下的文本文件：父目录按需创建，已存在就覆盖（它是 agent 自己的工作区，
 *  没有"独占创建"这条规矩——`edit` 与重写是它迭代代码的方式）。 */
/** 删一份 `.work/` 下的文件。只删文件——目录要先把它里面的文件删掉。 */
export function deleteWorkFile(root: string, raw: unknown): { file: string; remaining: number } {
  const { rel, full } = workPath(root, raw, 'work_delete');
  let info: ReturnType<typeof statSync>;
  try {
    info = statSync(full);
  } catch {
    throw new Error(`work_delete 找不到 ${rel}。`);
  }
  if (!info.isFile()) {
    throw new Error(`work_delete 只能删文件：${rel} 是一个目录（先删它里面的文件）。`);
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

export function editWorkFile(root: string, path: unknown, old: unknown, next: unknown, replaceAll: unknown, tool: string): {
  file: string; replaced: number; bytes: number;
} {
  const { rel, full } = workPath(root, path, tool);
  if (typeof old !== 'string' || old === '') throw new Error(`${tool} 需要 old：要替换掉的原样文本`);
  if (typeof next !== 'string') throw new Error(`${tool} 需要 new：替换成什么`);
  let text: string;
  try {
    text = readFileSync(full, 'utf8');
  } catch {
    throw new Error(`读不到 ${rel}`
      + `。要改它先 work_write 写出这个文件；材料、图表件与报告由工具生成，不在 ${WORK_DIR}/ 下。`);
  }
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
  writeFileSync(full, body);
  return { file: rel, replaced, bytes };
}

/** 读 `.work/` 下**一整份文本文件**：`readWorkFile`（给 agent 看的行窗口）与报告正文都用它。
 *  路径校验、文件不存在时的提示、单份文件上限都在这里，只有这一处。 */
function readWorkTextWhole(root: string, path: unknown, tool: string): { rel: string; text: string } {
  const { rel, full } = workPath(root, path, tool);
  let text: string;
  try {
    text = readFileSync(full, 'utf8');
  } catch {
    throw new Error(`读不到 ${rel}`
      + `。材料、图表件与报告不在 ${WORK_DIR}/ 下：要读它们用 jq_transform（可按 root 取一段）；`
      + `${WORK_DIR}/ 只装你自己写的文件。`);
  }
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > WORK_MAX_BYTES) {
    throw new Error(`${rel} ${(bytes / 1024).toFixed(0)} KB，超过 ${WORK_DIR}/ 单份文件的上限：拆成几份。`);
  }
  return { rel, text };
}

/** 读一份 `.work/` 下的文本文件：按行给（带行号），可以分页——这是"代码看得见"的那一半。 */
export function readWorkFile(root: string, path: unknown, offset: unknown, limit: unknown, tool: string): {
  file: string; lines: string[]; from: number; total: number; bytes: number;
} {
  const { rel, text } = readWorkTextWhole(root, path, tool);
  const all = text.replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n');
  const from = offset === undefined ? 1 : offset;
  if (typeof from !== 'number' || !Number.isInteger(from) || from < 1) {
    throw new Error(`${tool} 的 offset 是起始行号（从 1 开始），收到 ${JSON.stringify(offset)}`);
  }
  const count = limit === undefined ? 400 : limit;
  if (typeof count !== 'number' || !Number.isInteger(count) || count < 1 || count > 2000) {
    throw new Error(`${tool} 的 limit 是一次给多少行（1..2000），收到 ${JSON.stringify(limit)}`);
  }
  return {
    file: rel,
    lines: all.slice(from - 1, from - 1 + count),
    from,
    total: all.length,
    bytes: Buffer.byteLength(text),
  };
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

/** 读一份代码文件：`.work/` 下的 `.jq`，`jq_transform` 的 `by` 指向它。
 *
 *  为什么代码只走文件、不进参数：内层语言（jq）与外层序列化（JSON）的语法长得像，模型一进
 *  "代码模式"就会把 jq 的 `{a: b}` 直接写成 JSON 值（实测 13 次整轮失败里有 3 次是这样）。
 *  参数里只留一个文件名，两侧语法就不再相邻；程序本身用 `work_write` 写、`work_edit` 增量改，
 *  还能回读、报错能带上下文。 */
export function readCodeFile(root: string, raw: unknown): { text: string; file: string } {
  const { rel, full } = workPath(root, raw, 'by');
  if (!isCodeFile(rel)) {
    throw new Error(`by 指向的是一段 jq 程序：文件名要以 .jq 结尾（收到 ${JSON.stringify(rel)}）`);
  }
  let text: string;
  try {
    text = readFileSync(full, 'utf8');
  } catch {
    throw new Error(`读不到 ${rel}`
      + `。byFile 只认 ${WORK_DIR}/ 下的 .jq：先用 work_write 写出这个程序。`);
  }
  const bytes = Buffer.byteLength(text);
  if (bytes > CODE_MAX_BYTES) {
    throw new Error(`${rel} 有 ${(bytes / 1024).toFixed(0)} KB，超过单份代码的上限 `
      + `${CODE_MAX_BYTES / 1024} KB：把它拆成几份，或改用别的办法。`);
  }
  return { text, file: rel };
}

/** 文件名的三段：时间、类别、名字。它与 `artifactName` 互为反函数——
 *  自述缺失时（老文件、外部写下的文件）自述就从名字里现造一份，于是读的人不必面对"没有自述"。 */
export function nameParts(src: unknown): { at: string; name: string; kind: ArtifactKind } {
  const file = String(src).split('/').pop() ?? '';
  const at = /^\d{8}T\d{6}Z/.exec(file)?.[0] ?? '';
  const rest = at === '' ? file : file.slice(at.length + 1);
  const fileKind = /\.([a-z_]+)\.[a-z]+$/.exec(rest)?.[1] ?? '';
  const name = rest.replace(/\.([a-z_]+)\.[a-z]+$/, '').replace(/-[0-9a-f]{8}$/, '');
  return {
    at: at === '' ? resultStamp() : at,
    name: name === '' ? 'unnamed' : name,
    // 老名字（query / transform / data / chart）这一版之后不再认：认不出来的一律当数据材料，
    // 与"认不出文件名就不是我们的东西"这条口径一致（rfc/0007）。
    kind: kindOfFile(fileKind) ?? 'data',
  };
}

/** 自述的读取归一：写着的就用写着的，没写（老文件）就按文件名现造一份。
 *  形状对不上时报错而不是猜——认不出的结构说明这不是本插件写下的文件。 */
export function envelopeMetaOf(raw: unknown, src: unknown): EnvelopeMeta {
  if (raw === undefined || raw === null) return nameParts(src);
  if (!isRecord(raw) || typeof raw.name !== 'string' || typeof raw.at !== 'string') {
    throw new Error(`自述结构不完整（要 { kind, name, at }）：${JSON.stringify(src)}`);
  }
  return raw as unknown as EnvelopeMeta;
}

/** 来源链的读取校验：根节点、节点形状，以及**引用必须在文件内闭合**。
 *  早期写下的文件里 origin 是平面的（没有节点表），这里归一成单节点链：
 *  它们是可回收的内部材料，清理时自然消失，不专门迁移。 */
function normalizeOrigin(raw: unknown, data: unknown, src: unknown): DataOrigin {
  if (!isRecord(raw)) throw new Error(`封装里没有来源信息（origin）：${JSON.stringify(src)}`);
  // 平面形状（早期写下的）：一个操作，直接当单节点链——身份按同一套规则现算。
  if (typeof raw.kind === 'string') return originOf(raw as unknown as OriginNode, data);
  if (!isRecord(raw.nodes) || typeof raw.root !== 'string') {
    throw new Error(`来源链结构不完整（要 { root, nodes }）：${JSON.stringify(src)}`);
  }
  const nodes = raw.nodes as Record<string, OriginNode>;
  for (const [id, node] of Object.entries(nodes)) {
    const kinds = ['query', 'transform', 'input', 'extract', 'derive', 'report'];
    if (!isRecord(node) || !kinds.includes(String(node.kind))) {
      throw new Error(`来源链里的节点不是一次操作（${id}）：${JSON.stringify(src)}`);
    }
    for (const [name, upstream] of Object.entries(node.inputs ?? {})) {
      if (typeof upstream !== 'string' || !(upstream in nodes)) {
        throw new Error(`来源链里 ${id} 的输入 ${name} 指向的节点不在这个文件里（${String(upstream)}）：`
          + `引用必须在文件内闭合，${JSON.stringify(src)} 已经缺了上游`);
      }
    }
  }
  if (!(raw.root in nodes)) throw new Error(`来源链的根节点不在节点表里（${raw.root}）：${JSON.stringify(src)}`);
  return { root: raw.root, nodes };
}

/** 读一份封装（`.oks/data/` 里的那些 JSON）：校验 `{ meta, origin, data }` 并归一化来源链。
 *  data 的形状不在这里约束——那是消费者入口的事。 */
export function readEnvelope(root: string, src: unknown): Envelope {
  return parseEnvelope(readFileSync(artifactPath(root, src), 'utf8'), src);
}

/** 与 `readEnvelope` 同一套校验，只是内容已经读进来了（调用方负责路径约束与读文件）。
 *  图、表、报告的读取层拿到的是文件内容，所以校验与读取分在两处。 */
export function parseEnvelope(content: string, src: unknown): Envelope {
  const parsed: unknown = JSON.parse(content);
  if (!isRecord(parsed) || !('data' in parsed)) {
    throw new Error(`封装结构不完整（要 { meta, origin, data }）：${JSON.stringify(src)}`);
  }
  return {
    meta: envelopeMetaOf(parsed.meta, src),
    origin: normalizeOrigin(parsed.origin, parsed.data, src),
    data: parsed.data,
  };
}

/** 从一份 data 里取行对象数组：`{ rows, … }` 与"data 直接就是数组"两种形状都认。
 *  标量、对象、嵌套是加工结果的常态，读它们用 readEnvelope；这里明确拒绝，
 *  免得形状不对的数据一路走到绘图那层才报出一句看不懂的错。 */
export function rowsOf(data: unknown, src: unknown): Array<Record<string, unknown>> {
  const rows = isRecord(data) ? data.rows : data;
  if (!Array.isArray(rows)) {
    throw new Error(`这份数据的 data 不是行对象数组：${JSON.stringify(src)}。`
      + '要画图就先把它加工成行对象数组再保存。');
  }
  return rows as Array<Record<string, unknown>>;
}

/** 把一个 src 解析成 artifacts/ 里的**文件名**（越界与不存在都在这里报错）。
 *  状态层只记文件名——路径是工作区属性，换个工作区（同一份产物被拷过去）就该重新解析。 */
export function artifactFileName(root: string, src: unknown): string {
  const real = artifactPath(root, src);
  return real.slice(real.lastIndexOf(sep) + 1);
}

/** 读一份已经落盘的产物（报告里引用的图）：路径约束与结果文件相同，另加一条扩展名核对。 */
export function readArtifact(root: string, src: string, extension: string): string {
  if (!src.endsWith(extension)) throw new Error(`只认 ${extension} 产物：${JSON.stringify(src)}`);
  return readFileSync(artifactPath(root, src), 'utf8');
}
