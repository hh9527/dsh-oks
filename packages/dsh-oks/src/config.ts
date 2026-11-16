import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { errorText } from './host.ts';
import type { WorkspaceProbe } from './host.ts';

// 与机器、模型无关的默认值：部署配置提供默认模型，工作区可覆盖。
export const DEFAULTS = {
  // 墙钟上限：死循环只能靠它兜住——到点 terminate 整个 worker 代并拒掉排队请求，下次请求
  // 再拉起。正常单次请求约 2.5 ms。
  requestTimeoutMs: 60000,
  // 服务只在整批 Intent 通过时才返回 queries；开启后会把没有 Error 的子集再降一次。
  retryAcceptedSubset: true,
  // 只读查询的墙钟上限与被取回的最大行数（node:sqlite 是同步 API，卡住只能靠 terminate）。
  queryTimeoutMs: 30000,
  queryMaxRows: 200,
  requireRunApproval: false,
};

/** 工作区 oks.json 里插件认得的声明。 */
export interface OksDeclaration {
  domain?: string;
  model?: string;
  dataFile?: string;
  requestTimeoutMs?: number;
  retryAcceptedSubset?: boolean;
  queryTimeoutMs?: number;
  queryMaxRows?: number;
  requireRunApproval?: boolean;
}

/** 部署 profile 的默认设置与宿主集成配置（VA 配置见 src/va.ts）。 */
export interface PluginConfig extends OksDeclaration {
  dari?: { service?:string; integration?:string };
  vocabularyHelper?: boolean;
  vaPreset?: string;
  vaReasoningEffort?: string;
}

/** 解析后的运行设置：domain / model 是必需非空字符串，其余都有落点。 */
export interface Settings {
  domain: string;
  model: string;
  dataFile: string | undefined;
  requestTimeoutMs: number;
  retryAcceptedSubset: boolean;
  queryTimeoutMs: number;
  queryMaxRows: number;
  requireRunApproval: boolean;
  workspaceRoot: string;
  workspaceFile: string;
}

interface WorkspaceConfigResult {
  root: string;
  file: string;
  oks: OksDeclaration;
  model: string | undefined;
  dataFile: string | undefined;
}

/** 工作区配置可省略；其中的相对路径以工作区为基准。 */
export function loadWorkspaceConfig(root: string): WorkspaceConfigResult {
  const file = join(root, 'oks.json');
  let oks: OksDeclaration = {};
  try {
    oks = JSON.parse(readFileSync(file, 'utf8')) as OksDeclaration;
    if (!oks || typeof oks !== 'object' || Array.isArray(oks)) throw new Error('配置必须为对象');
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error(`dsh-oks: 无法读取工作区配置 ${file}（${errorText(cause)}）。请修正该配置。`);
    }
  }
  const resolve = (value: unknown): string | undefined => (typeof value === 'string' && value.length > 0
    ? (value.startsWith('/') ? value : join(root, value))
    : undefined);
  return { root, file, oks, model: resolve(oks.model), dataFile: resolve(oks.dataFile) };
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

/** 把一个工作区解析成一份运行设置。缺 domain / model 时报错并给出补法。 */
export function resolveSettings(root: string, config: PluginConfig | undefined): Settings {
  const workspace = loadWorkspaceConfig(root);
  // 工作区显式声明 > 部署 profile 默认配置 > 通用默认值。
  const declared = Object.fromEntries(Object.entries(workspace.oks).filter(([key, value]) =>
    Object.hasOwn(DEFAULTS, key) && value !== undefined));
  const settings: Settings = {
    ...DEFAULTS,
    ...Object.fromEntries(Object.entries(config ?? {}).filter(([key, value]) => Object.hasOwn(DEFAULTS, key) && value !== undefined)),
    ...declared,
    domain: workspace.oks.domain ?? config?.domain ?? '',
    model: workspace.model ?? config?.model ?? '',
    dataFile: workspace.dataFile ?? config?.dataFile,
    workspaceRoot: root,
    workspaceFile: workspace.file,
  };
  // 部署的执行审批策略由管理员控制。
  if(config?.requireRunApproval!==undefined)settings.requireRunApproval=config.requireRunApproval;
  if(typeof settings.requireRunApproval!=='boolean')throw new Error('requireRunApproval must be boolean');
  const missing: string[] = [];
  if (typeof settings.domain !== 'string' || settings.domain.length === 0) missing.push('domain');
  if (typeof settings.model !== 'string' || settings.model.length === 0) missing.push('model');
  if (missing.length > 0) {
    throw new Error(
      `dsh-oks: 当前部署及工作区未配置必要声明: ${missing.join(', ')}。`
      + '请由用户在部署 profile 配置，或在 '+workspace.file+' 声明 { "domain":"<知识服务领域名>","model":"<相对 oks.json 的 .wasm 路径>"}，'
      + '请用户指定模型，不要搜索历史目录或猜选模型。',
    );
  }
  return settings;
}

/** 产物里有没有可直接导入的服务快照。 */
export function hasSnapshot(modelPath: string): boolean {
  try {
    const module = new WebAssembly.Module(readFileSync(modelPath));
    return WebAssembly.Module.customSections(module, 'telora.snapshot').length > 0;
  } catch (cause) {
    throw new Error(`cannot read the knowledge model ${modelPath}: ${errorText(cause)}`);
  }
}
