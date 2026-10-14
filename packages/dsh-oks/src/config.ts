import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { errorText } from './host.ts';
import { KEEP_ALIVE_MINUTES, MATERIAL_KEEP_ALIVE_MINUTES } from './state.ts';
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

/** auto 窗口的下限（分钟）：它由写路径无人值守地执行，脚滑的余地留大一点。 */
export const RETENTION_FLOOR_MINUTES = 5;

/** manual 窗口与 `collect` 的 ttl 的下限（秒）：这两种都要人/agent 显式触发，秒级也认。 */
export const RETENTION_FLOOR_SECONDS = 5;

/** auto 的窗口：由写路径自动执行，必做（材料与报表各自有窗口，`.work/` 默认不参与）。 */
export interface AutoRetention {
  materials: number;
  artifacts: number;
  work: number | null;
}

/** manual 的窗口：只在显式触发（agent 的 `collect`、人的按钮）时使用。 */
export interface ManualRetention {
  materials: number;
  work: number | null;
}

/** 两套窗口：auto 保守（自动跑），manual 稍激进（显式触发才用）。 */
export interface RetentionSettings {
  auto: AutoRetention;
  manual: ManualRetention;
}

const RETENTION_DEFAULTS: RetentionSettings = {
  auto: { materials: MATERIAL_KEEP_ALIVE_MINUTES, artifacts: KEEP_ALIVE_MINUTES, work: null },
  manual: { materials: 5, work: 5 },
};

/** 把窗口（分钟）写成一句人话：`0.25` → "15 秒"，`5` → "5 分钟"，`120` → "2 小时"。 */
export function windowText(minutes: number): string {
  const seconds = Math.round(minutes * 60);
  if (seconds < 60) return `${seconds} 秒`;
  if (seconds % 3600 === 0) return `${seconds / 3600} 小时`;
  if (seconds % 60 === 0) return `${seconds / 60} 分钟`;
  return `${(seconds / 60).toFixed(1)} 分钟`;
}

/** 解析一个窗口，返回**分钟**（可以是小数：`"15s"` → 0.25）。
 *  数字＝分钟；字符串带单位 `"15s"` / `"62m"` / `"2h"` / `"7d"`（不带单位＝分钟）。
 *  `floorSeconds` 由调用方按"谁触发"给：auto 守 5 分钟，manual 与 `collect` 的 ttl 到 5 秒。 */
export function retentionMinutes(value: unknown, where: string, floorSeconds: number = RETENTION_FLOOR_SECONDS): number {
  let seconds: number;
  if (typeof value === 'number') {
    seconds = value * 60;
  } else if (typeof value === 'string') {
    const matched = /^(\d+(?:\.\d+)?)\s*([smhd])?$/i.exec(value.trim());
    if (matched === null) {
      throw new Error(`${where} 要写成"数字 + 单位"：收到 ${JSON.stringify(value)}，`
        + '例如 "15s" / "62m" / "2h" / "7d"（纯数字＝分钟）。');
    }
    const n = Number(matched[1]);
    const unit = (matched[2] ?? 'm').toLowerCase();
    seconds = unit === 's' ? n : unit === 'm' ? n * 60 : unit === 'h' ? n * 3600 : n * 86400;
  } else {
    throw new Error(`${where} 要写成"数字 + 单位"：收到 ${JSON.stringify(value)}，`
      + '例如 "15s" / "62m" / "2h" / "7d"（纯数字＝分钟）。');
  }
  if (!Number.isFinite(seconds) || seconds < floorSeconds) {
    throw new Error(`${where} 的下限是 ${windowText(floorSeconds / 60)}：收到 ${JSON.stringify(value)}。`
      + '清理会删文件，留出余量。');
  }
  return seconds / 60;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** 一次显式清理用哪套窗口：给了 `ttl`（页签下拉那两个菜单项）就按它，否则用工作区的 manual 策略。
 *  这是"按钮/工具给的窗口"唯一的解释处，别再在装配处或测试桩里各写一遍。 */
export function collectWindows(manual: ManualRetention, ttl: unknown): { materials: number; work: number | null } {
  if (ttl === undefined || ttl === null) return manual;
  const minutes = retentionMinutes(ttl, '清理的 ttl');
  return { materials: minutes, work: minutes };
}

/** 解析 oks.json 里的 `retention`：只认文档里写出的键，写错的键当场报错（免得静默用默认值）。 */
function parseRetention(raw: unknown, where: string): RetentionSettings {
  if (raw === undefined || raw === null) return RETENTION_DEFAULTS;
  if (!isRecord(raw)) {
    throw new Error(`${where} 的 retention 要写成对象：{"auto":{"materials":"62m","artifacts":"60m"},"manual":{"materials":"5m","work":"5m"}}`);
  }
  const extra = Object.keys(raw).filter((key) => key !== 'auto' && key !== 'manual');
  if (extra.length > 0) throw new Error(`${where} 的 retention 只认 auto 与 manual，多了 ${extra.join(' / ')}`);
  const autoRaw = raw.auto;
  const manualRaw = raw.manual;
  const auto: AutoRetention = { ...RETENTION_DEFAULTS.auto };
  const manual: ManualRetention = { ...RETENTION_DEFAULTS.manual };

  if (autoRaw !== undefined && autoRaw !== null) {
    if (!isRecord(autoRaw)) throw new Error(`${where} 的 retention.auto 要写成对象`);
    const keys = Object.keys(autoRaw).filter((key) => !['materials', 'artifacts', 'work'].includes(key));
    if (keys.length > 0) {
      throw new Error(`${where} 的 retention.auto 只认 materials / artifacts / work，多了 ${keys.join(' / ')}`
        + '（自动清理是必做，没有开关）');
    }
    if (autoRaw.materials !== undefined) auto.materials = retentionMinutes(autoRaw.materials, `${where} 的 retention.auto.materials`, RETENTION_FLOOR_MINUTES * 60);
    if (autoRaw.artifacts !== undefined) auto.artifacts = retentionMinutes(autoRaw.artifacts, `${where} 的 retention.auto.artifacts`, RETENTION_FLOOR_MINUTES * 60);
    if (autoRaw.work === null || autoRaw.work === undefined) auto.work = null;
    else auto.work = retentionMinutes(autoRaw.work, `${where} 的 retention.auto.work`, RETENTION_FLOOR_MINUTES * 60);
  }

  if (manualRaw !== undefined && manualRaw !== null) {
    if (!isRecord(manualRaw)) throw new Error(`${where} 的 retention.manual 要写成对象`);
    const keys = Object.keys(manualRaw).filter((key) => !['materials', 'work'].includes(key));
    if (keys.length > 0) {
      throw new Error(`${where} 的 retention.manual 只认 materials / work，多了 ${keys.join(' / ')}`
        + '（报表的显式清理走产出页签里逐条的删除）');
    }
    if (manualRaw.materials !== undefined) manual.materials = retentionMinutes(manualRaw.materials, `${where} 的 retention.manual.materials`);
    if (manualRaw.work === null || manualRaw.work === undefined) manual.work = null;
    else manual.work = retentionMinutes(manualRaw.work, `${where} 的 retention.manual.work`);
  }

  return { auto, manual };
}

/** 工作区 oks.json 里插件认得的声明。 */
export interface OksDeclaration {
  domain?: string;
  model?: string;
  dataFile?: string;
  requestTimeoutMs?: number;
  retryAcceptedSubset?: boolean;
  queryTimeoutMs?: number;
  queryMaxRows?: number;
  /** 清理窗口：auto 由写路径自动执行，manual 供显式触发使用。 */
  retention?: unknown;
}

/** 插件行 config 里可以覆盖的键（va 相关的三项见 src/va.ts）。 */
export interface PluginConfig extends OksDeclaration {
  vaPreset?: string;
  vaAskTimeoutMs?: number;
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
  /** 清理窗口：auto 由写路径自动执行，manual 供显式触发（agent 的 collect、人的按钮）使用。 */
  retention: RetentionSettings;
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

/** 读工作区的 oks.json：**"哪个模型、哪份数据"由工作区声明**。
 *  `model` 与 `dataFile` 都相对 oks.json 所在目录解析（绝对路径原样用）。 */
export function loadWorkspaceConfig(root: string): WorkspaceConfigResult {
  const file = join(root, 'oks.json');
  let oks: OksDeclaration;
  try {
    oks = JSON.parse(readFileSync(file, 'utf8')) as OksDeclaration;
  } catch (cause) {
    throw new Error(
      `dsh-oks: 这个会话的工作区里没有可用的 ${file}（${errorText(cause)}）。`
      + '在工作区根目录放一份 oks.json 即可开放模型，例如 '
      + '{"domain":"<知识服务领域名>","model":"<相对 oks.json 的 .wasm 路径>"}。'
      + '插件不提供默认模型——用错模型比报错贵。',
    );
  }
  const resolve = (value: unknown): string | undefined => (typeof value === 'string' && value.length > 0
    ? (value.startsWith('/') ? value : join(root, value))
    : undefined);
  return { root, file, oks, model: resolve(oks?.model), dataFile: resolve(oks?.dataFile) };
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
  // 优先级：插件行的显式 config > 工作区的 oks.json > 与机器/模型无关的 DEFAULTS。
  // domain / model 缺失时先落成空串：下面的 missing 检查对"undefined"和"空串"给的是同一条报错。
  const fromWorkspace: Settings = {
    domain: workspace.oks.domain ?? '',
    model: workspace.model ?? '',
    dataFile: workspace.dataFile,
    requestTimeoutMs: workspace.oks.requestTimeoutMs ?? DEFAULTS.requestTimeoutMs,
    retryAcceptedSubset: workspace.oks.retryAcceptedSubset ?? DEFAULTS.retryAcceptedSubset,
    queryTimeoutMs: workspace.oks.queryTimeoutMs ?? DEFAULTS.queryTimeoutMs,
    queryMaxRows: workspace.oks.queryMaxRows ?? DEFAULTS.queryMaxRows,
    retention: parseRetention(workspace.oks.retention, workspace.file),
    workspaceRoot: workspace.root,
    workspaceFile: workspace.file,
  };
  // 设置有三个来源：与机器无关的默认值、工作区的 oks.json、插件行 config 里的这几个覆盖键。
  const settings: Settings = { ...DEFAULTS, ...fromWorkspace };
  if (config?.domain !== undefined) settings.domain = config.domain;
  if (config?.model !== undefined) settings.model = config.model;
  if (config?.dataFile !== undefined) settings.dataFile = config.dataFile;
  if (config?.requestTimeoutMs !== undefined) settings.requestTimeoutMs = config.requestTimeoutMs;
  if (config?.retryAcceptedSubset !== undefined) settings.retryAcceptedSubset = config.retryAcceptedSubset;
  if (config?.queryTimeoutMs !== undefined) settings.queryTimeoutMs = config.queryTimeoutMs;
  if (config?.queryMaxRows !== undefined) settings.queryMaxRows = config.queryMaxRows;
  if (config?.retention !== undefined) settings.retention = parseRetention(config.retention, '插件行的 config');
  const missing: string[] = [];
  if (typeof settings.domain !== 'string' || settings.domain.length === 0) missing.push('domain');
  if (typeof settings.model !== 'string' || settings.model.length === 0) missing.push('model');
  if (missing.length > 0) {
    throw new Error(
      `dsh-oks: ${workspace.file} 缺少必要声明: ${missing.join(', ')}。`
      + '需要 {"domain":"<知识服务领域名>","model":"<相对 oks.json 的 .wasm 路径>"}，'
      + '也可以在插件行的 config 里覆盖。',
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
