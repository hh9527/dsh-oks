import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { readSkillContent, resolveSettings, SKILL, workspaceRootFor } from './config.js';
import { createExecutor, createRunner, readDataManifest } from './runners.js';
import { buildRetrievalIndex } from './retrieval.js';
import { singleFlight } from './single-flight.js';

/** 进程级的检索层缓存：artifact sha256 -> 词汇表 + 反向引用索引。
 *  词汇助手是另一个 agent 作用域里的实例，它和主 agent 共用这一份，不重爬引用图。 */
const INDEX_BY_ARTIFACT = new Map();

export function createKnowledge({ ctx, log, config }) {
  // 插件不认识模型：设置与 wasm 宿主都在**第一次用到某个工作区**时按那份 oks.json 惰性建立；
  // 一个进程里可以有任意多个工作区，互不影响。
  const workspaces = new Map(); // root -> entry
  // 执行器按**数据文件**持有：同一个数据文件被多个工作区声明时共享一个只读连接。
  const executors = new Map(); // dataFile -> { executor, manifest }

  const executorFor = (settings) => {
    if (typeof settings.dataFile !== 'string' || settings.dataFile.length === 0) {
      throw new Error(
        `dsh-oks: ${settings.workspaceFile} 没有声明 dataFile，oks_query 无处可查。`
        + '需要 {"dataFile":"<相对 oks.json 的 .sqlite 路径>"}；'
        + '只做校验可以用 oks_check_intent。',
      );
    }
    const existing = executors.get(settings.dataFile);
    if (existing !== undefined) return existing;
    if (!existsSync(settings.dataFile)) {
      throw new Error(
        `dsh-oks: ${settings.workspaceFile} 声明的 dataFile 不存在：${settings.dataFile}`,
      );
    }
    const manifest = readDataManifest(settings.dataFile);
    const entry = { executor: createExecutor(settings, log), manifest };
    executors.set(settings.dataFile, entry);
    log(`[oks] read-only executor for ${settings.dataFile}`
      + `${manifest?.revision ? ` · data revision=${manifest.revision}` : ''}`
      + `${manifest?.window ? ` · window=[${manifest.window.start}, ${manifest.window.endExclusive})` : ''}`);
    return entry;
  };

  // 技能服务是可选依赖（ctx.get 取），加载时它可能还没起来，所以第一次工具调用会再试一次。
  let skillRegistered = false;
  const registerSkill = () => {
    if (skillRegistered) return true;
    let content;
    try {
      content = readSkillContent();
    } catch (cause) {
      log(`[oks] skill body unreadable: ${cause?.message ?? cause}`);
      skillRegistered = true; // 部署缺文件，重试没有意义
      return true;
    }
    let skills = null;
    try {
      skills = ctx.get?.('skills') ?? null;
    } catch {
      skills = null;
    }
    if (typeof skills?.register !== 'function') return false;
    try {
      ctx.effect(() => skills.register({ ...SKILL, content }));
      skillRegistered = true;
      log(`[oks] skill "${SKILL.name}" registered (runtime) · ${Buffer.byteLength(content, "utf8")} bytes`);
    } catch (cause) {
      log(`[oks] cannot register skill "${SKILL.name}": ${cause?.message ?? cause}`);
      skillRegistered = true;
    }
    return skillRegistered;
  };
  registerSkill();

  /** 每个工具的入口动作：由**会话**定位工作区，再拿到（或惰性建立）它的运行环境。 */
  const ensureWorkspace = (exec) => {
    registerSkill(); // 加载时技能服务若还没起来，这里补上（已注册则是空操作）
    const { root, from } = workspaceRootFor(exec);
    const existing = workspaces.get(root);
    if (existing !== undefined) return existing;
    const settings = resolveSettings(root, config);
    const entry = {
      root,
      from,
      settings,
      runner: null,
      index: null, // 检索层：词汇表 + 反向引用索引
    };
    workspaces.set(root, entry);
    log(`[oks] workspace ${root} (cwd from ${from}) · domain=${settings.domain} · model=${settings.artifact}`);
    entry.runner = createRunner(settings, log);
    return entry;
  };

  // 词汇表与引用图按**产物**持有：同一份产物被多个工作区、多个会话声明时只派生一次。
  // 身份用 artifact_sha256（revision 字符串在两次不同构建之间可能不变，不能当身份）。
  // 缓存放在**模块级**：词汇助手是另一个 agent 作用域里的实例，它要用同一份数据模型，
  // 而不是把整棵引用图再爬一遍。
  const indexes = INDEX_BY_ARTIFACT;

  // 正在进行的索引派生：并发的首次检索共享同一次初始化，不会各爬一遍引用图。
  const indexFlights = new Map(); // artifact sha256 -> 在飞的 promise

  /** 惰性建立检索层：第一次检索时执行，之后按产物哈希复用；并发时 single flight。 */
  const ensureIndex = async (entry) => {
    if (entry.index !== null) return entry.index;
    const sha = createHash('sha256').update(readFileSync(entry.settings.artifact)).digest('hex');
    const shared = indexes.get(sha);
    if (shared !== undefined) {
      entry.index = shared;
      return shared;
    }
    const index = await singleFlight(indexFlights, sha, async () => {
      const built = await buildRetrievalIndex(entry, sha, log);
      indexes.set(sha, built);
      return built;
    });
    entry.index = index;
    return index;
  };

  // 卸载时把每个工作区的 wasm 宿主与每个数据文件的执行器都关掉。
  const dispose = () => {
    for (const entry of workspaces.values()) {
      try {
        entry.runner?.dispose();
      } catch { /* 尽量都关掉，不让一个失败挡住其余 */ }
    }
    workspaces.clear();
    for (const entry of executors.values()) {
      try {
        entry.executor?.dispose();
      } catch { /* 同上 */ }
    }
    executors.clear();
  };

  return { ensureWorkspace, ensureIndex, executorFor, dispose };
}
