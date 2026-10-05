import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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

/** 读工作区的 oks.json：**"哪个模型、哪份数据"由工作区声明**。
 *  `artifact` 与 `dataFile` 都相对 oks.json 所在目录解析（绝对路径原样用）。 */
export function loadWorkspaceConfig(root) {
  const file = join(root, 'oks.json');
  let oks;
  try {
    oks = JSON.parse(readFileSync(file, 'utf8'));
  } catch (cause) {
    throw new Error(
      `dsh-oks: 这个会话的工作区里没有可用的 ${file}（${cause?.message ?? cause}）。`
      + '在工作区根目录放一份 oks.json 即可开放模型，例如 '
      + '{"domain":"<知识服务领域名>","artifact":"<相对 oks.json 的 .wasm 路径>"}。'
      + '插件不提供默认模型——用错模型比报错贵。',
    );
  }
  const resolve = (value) => (typeof value === 'string' && value.length > 0
    ? (value.startsWith('/') ? value : join(root, value))
    : undefined);
  return { root, file, oks, artifact: resolve(oks?.artifact), dataFile: resolve(oks?.dataFile) };
}

/** 会话 → 工作区目录。工作区是**会话属性**（会话头里的 cwd），不是进程属性；
 *  取不到就报错，让会话把 cwd 带上。 */
export function workspaceRootFor(exec) {
  const session = exec?.agent?.session;
  const probes = [
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
export function resolveSettings(root, config) {
  const workspace = loadWorkspaceConfig(root);
  // 优先级：插件行的显式 config > 工作区的 oks.json > 与机器/模型无关的 DEFAULTS。
  const fromWorkspace = {
    domain: workspace.oks.domain,
    artifact: workspace.artifact,
    dataFile: workspace.dataFile,
    requestTimeoutMs: workspace.oks.requestTimeoutMs ?? DEFAULTS.requestTimeoutMs,
    retryAcceptedSubset: workspace.oks.retryAcceptedSubset ?? DEFAULTS.retryAcceptedSubset,
    queryTimeoutMs: workspace.oks.queryTimeoutMs ?? DEFAULTS.queryTimeoutMs,
    queryMaxRows: workspace.oks.queryMaxRows ?? DEFAULTS.queryMaxRows,
    workspaceRoot: workspace.root,
    workspaceFile: workspace.file,
  };
  // 设置有三个来源：与机器无关的默认值、工作区的 oks.json、插件行 config 里的这几个覆盖键。
  const overrides = {};
  for (const key of ['domain', 'artifact', 'dataFile', 'requestTimeoutMs',
    'retryAcceptedSubset', 'queryTimeoutMs', 'queryMaxRows']) {
    if (config?.[key] !== undefined) overrides[key] = config[key];
  }
  const settings = { ...DEFAULTS, ...fromWorkspace, ...overrides };
  const missing = ['domain', 'artifact']
    .filter((key) => typeof settings[key] !== 'string' || settings[key].length === 0);
  if (missing.length > 0) {
    throw new Error(
      `dsh-oks: ${workspace.file} 缺少必要声明: ${missing.join(', ')}。`
      + '需要 {"domain":"<知识服务领域名>","artifact":"<相对 oks.json 的 .wasm 路径>"}，'
      + '也可以在插件行的 config 里覆盖。',
    );
  }
  return settings;
}

/** 自带的引导技能：注册进 ctx.skills 的 runtime 层，对所有工作区可见；正文在 skill.md。
 *  rank 250：工作区自己的 skill(100/200) 能覆盖它，用户级(400/500) 不能。 */
export const SKILL = {
  name: 'oks-query',
  description: 'Use when a business question must be answered from domain data: discover the domain model with oks_info, validate structured intents with oks_check_intent, and get actual rows with oks_query. Resolve relative time into absolute boundaries first — time_now and time_calc do that without knowing any domain format.',
  source: 'runtime',
};

export function readSkillContent() {
  return readFileSync(new URL('../skill.md', import.meta.url), 'utf8');
}

/** 产物里有没有可直接导入的服务快照。 */
export function hasSnapshot(artifactPath) {
  try {
    const module = new WebAssembly.Module(readFileSync(artifactPath));
    return WebAssembly.Module.customSections(module, 'telora.snapshot').length > 0;
  } catch (cause) {
    throw new Error(`cannot read telora artifact ${artifactPath}: ${cause?.message ?? cause}`);
  }
}
