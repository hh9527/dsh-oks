import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { errorText } from './host.ts';
import type { WorkspaceProbe } from './host.ts';

// 与机器、模型无关的默认值：路径、领域名、模型一律来自工作区声明。
export const DEFAULTS = {
  // 墙钟上限：死循环只能靠它兜住——到点 terminate 整个 worker 代并拒掉排队请求，下次请求
  // 再拉起。正常单次请求约 2.5 ms。
  requestTimeoutMs: 60000,
  // 服务只在整批 Intent 通过时才返回 queries；开启后会把没有 Error 的子集再降一次。
  retryAcceptedSubset: true,
  // 只读查询的墙钟上限与被取回的最大行数（node:sqlite 是同步 API，卡住只能靠 terminate）。
  queryTimeoutMs: 30000,
  queryMaxRows: 200,
};

/** 工作区 oks.json 里插件认得的声明。 */
export interface OksDeclaration {
  domain?: string;
  artifact?: string;
  dataFile?: string;
  requestTimeoutMs?: number;
  retryAcceptedSubset?: boolean;
  queryTimeoutMs?: number;
  queryMaxRows?: number;
}

/** 插件行 config 里可以覆盖的键（va 相关的三项见 src/va.ts）。 */
export interface PluginConfig extends OksDeclaration {
  vaPreset?: string;
  vaAskTimeoutMs?: number;
  vaReasoningEffort?: string;
}

/** 解析后的运行设置：domain / artifact 是必需非空字符串，其余都有落点。 */
export interface Settings {
  domain: string;
  artifact: string;
  dataFile: string | undefined;
  requestTimeoutMs: number;
  retryAcceptedSubset: boolean;
  queryTimeoutMs: number;
  queryMaxRows: number;
  workspaceRoot: string;
  workspaceFile: string;
}

interface WorkspaceConfigResult {
  root: string;
  file: string;
  oks: OksDeclaration;
  artifact: string | undefined;
  dataFile: string | undefined;
}

/** 读工作区的 oks.json：**"哪个模型、哪份数据"由工作区声明**。
 *  `artifact` 与 `dataFile` 都相对 oks.json 所在目录解析（绝对路径原样用）。 */
export function loadWorkspaceConfig(root: string): WorkspaceConfigResult {
  const file = join(root, 'oks.json');
  let oks: OksDeclaration;
  try {
    oks = JSON.parse(readFileSync(file, 'utf8')) as OksDeclaration;
  } catch (cause) {
    throw new Error(
      `dsh-oks: 这个会话的工作区里没有可用的 ${file}（${errorText(cause)}）。`
      + '在工作区根目录放一份 oks.json 即可开放模型，例如 '
      + '{"domain":"<知识服务领域名>","artifact":"<相对 oks.json 的 .wasm 路径>"}。'
      + '插件不提供默认模型——用错模型比报错贵。',
    );
  }
  const resolve = (value: unknown): string | undefined => (typeof value === 'string' && value.length > 0
    ? (value.startsWith('/') ? value : join(root, value))
    : undefined);
  return { root, file, oks, artifact: resolve(oks?.artifact), dataFile: resolve(oks?.dataFile) };
}

/** 会话 → 工作区目录。工作区是**会话属性**（会话头里的 cwd），不是进程属性；
 *  取不到就报错，让会话把 cwd 带上。 */
export function workspaceRootFor(exec: WorkspaceProbe | undefined): { root: string; from: string } {
  const session = exec?.agent?.session;
  const probes: Array<[string, () => unknown]> = [
    ['session.meta.cwd', () => session?.meta?.cwd],
    ['session.header.cwd', () => session?.header?.cwd],
    ['session.cwd', () => session?.cwd],
  ];
  for (const [where, pick] of probes) {
    try {
      const value = pick();
      if (typeof value === 'string' && value.length > 0) return { root: value, from: where };
    } catch { /* 这一层取不到，试下一层 */ }
  }
  throw new Error(
    'dsh-oks: 无法确定当前会话的工作区目录（会话头里没有 cwd），因此不知道用哪个模型。'
    + '工作区是会话属性，来源是会话头的 cwd——请让会话带上它。',
  );
}

/** 把一个工作区解析成一份运行设置。缺 domain / artifact 时报错并给出补法。 */
export function resolveSettings(root: string, config: PluginConfig | undefined): Settings {
  const workspace = loadWorkspaceConfig(root);
  // 优先级：插件行的显式 config > 工作区的 oks.json > 与机器/模型无关的 DEFAULTS。
  // domain / artifact 缺失时先落成空串：下面的 missing 检查对"undefined"和"空串"给的是同一条报错。
  const fromWorkspace: Settings = {
    domain: workspace.oks.domain ?? '',
    artifact: workspace.artifact ?? '',
    dataFile: workspace.dataFile,
    requestTimeoutMs: workspace.oks.requestTimeoutMs ?? DEFAULTS.requestTimeoutMs,
    retryAcceptedSubset: workspace.oks.retryAcceptedSubset ?? DEFAULTS.retryAcceptedSubset,
    queryTimeoutMs: workspace.oks.queryTimeoutMs ?? DEFAULTS.queryTimeoutMs,
    queryMaxRows: workspace.oks.queryMaxRows ?? DEFAULTS.queryMaxRows,
    workspaceRoot: workspace.root,
    workspaceFile: workspace.file,
  };
  // 设置有三个来源：与机器无关的默认值、工作区的 oks.json、插件行 config 里的这几个覆盖键。
  const settings: Settings = { ...DEFAULTS, ...fromWorkspace };
  if (config?.domain !== undefined) settings.domain = config.domain;
  if (config?.artifact !== undefined) settings.artifact = config.artifact;
  if (config?.dataFile !== undefined) settings.dataFile = config.dataFile;
  if (config?.requestTimeoutMs !== undefined) settings.requestTimeoutMs = config.requestTimeoutMs;
  if (config?.retryAcceptedSubset !== undefined) settings.retryAcceptedSubset = config.retryAcceptedSubset;
  if (config?.queryTimeoutMs !== undefined) settings.queryTimeoutMs = config.queryTimeoutMs;
  if (config?.queryMaxRows !== undefined) settings.queryMaxRows = config.queryMaxRows;
  const missing: string[] = [];
  if (typeof settings.domain !== 'string' || settings.domain.length === 0) missing.push('domain');
  if (typeof settings.artifact !== 'string' || settings.artifact.length === 0) missing.push('artifact');
  if (missing.length > 0) {
    throw new Error(
      `dsh-oks: ${workspace.file} 缺少必要声明: ${missing.join(', ')}。`
      + '需要 {"domain":"<知识服务领域名>","artifact":"<相对 oks.json 的 .wasm 路径>"}，'
      + '也可以在插件行的 config 里覆盖。',
    );
  }
  return settings;
}

/** 产物里有没有可直接导入的服务快照。 */
export function hasSnapshot(artifactPath: string): boolean {
  try {
    const module = new WebAssembly.Module(readFileSync(artifactPath));
    return WebAssembly.Module.customSections(module, 'telora.snapshot').length > 0;
  } catch (cause) {
    throw new Error(`cannot read telora artifact ${artifactPath}: ${errorText(cause)}`);
  }
}
