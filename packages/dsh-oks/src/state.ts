// 产出层的账本：清单与保留。
//
// **清单的权威在账本**：`SELECT` 就是清单，读路径不依赖文件系统；文件是账本指向的 payload。
// 写路径做三件事——产出时记账（`recordArtifact`，用产出方手里的 meta，不解析文件）、
// 写产物之前的懒惰清理（`pruneArtifacts` 遍历行 + `reconcileArtifacts` 补登与清悬挂）、
// 以及用户点 `✕`（`deleteArtifact`）。读路径只做一次**只补登、不删除**的对账
// （`adoptArtifacts`），于是"文件在、账本上没有"这一类一次读就自愈。
//
// 为什么这样分：pin 是**唯一不能从产物重建**的东西（文件里只有自述，pin 是人的动作），
// 所以账本必须活着；而账本丢了也能重建——目录里每份产物都自述齐全，一次补登就都回来了
// （只丢 pin）。状态住在工作区的 .oks/state.db（node:sqlite，零新依赖）：artifacts/ 会被
// 保活清理，账本不能被清，所以两者分开放。
//
// 清理只碰**账本上的行**；没登记的文件一概不动——工作区里可能有用户自己放的东西，
// 我们不替人做删除决定。

import { DatabaseSync } from 'node:sqlite';
import { closeSync, existsSync, mkdirSync, openSync, readSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { ARTIFACT_DIR, artifactFileName, DATA_DIR, FIGURE_DIR, readArtifactMeta, WORK_DIR } from './results.ts';
import { CHART_KINDS } from './chart/shared.ts';
import type { ArtifactMeta } from './results.ts';

/** 状态目录（相对工作区根）。 */
export const STATE_DIR = '.oks';

/** 保活下限（分钟）：未保留的产物在**产生**之后这么久内保证存在。
 *  MVP 用固定值；配置项（`oks.json` 的 `data.keepAliveMinutes`）留到需要时再加。 */
export const KEEP_ALIVE_MINUTES = 60;

/** 内部材料（`.oks/data/`、`.oks/figures/`）的保活窗口：**比报表多 2 分钟**。
 *  **这只是一个常数差，不构成时序保证**，而且两类用的**不是同一个时钟**：
 *  报表按**文件名里的生成时刻**判龄（见 `pruneArtifacts`），内部材料按**文件 mtime** 判龄。
 *  所以一张早先画好的图晚些被新报表引用时，仍可能比那份报表先过期。材料是可回收的中间件，
 *  这样即可——报表在生成时已把图内联成 SVG，显示不受影响；若将来真要"被引用的材料不先回收"，
 *  那要另立机制，不靠这个差值。 */
export const MATERIAL_KEEP_ALIVE_MINUTES = KEEP_ALIVE_MINUTES + 2;

/** 可见产物（界面会呈现的那些）：报表。图是报表里的材料，数据材料不进清单。 */
export const VISIBLE = /\.report\.html$/;

/** 我们写的几类产物的名字形状：`<时间>-<名字>[-<内容哈希>].<类别><扩展名>`。
 *  只有认得出的才可能被清理；`~` 是超长名字被截过的记号。 */
// "是不是我们的文件"只此一处：材料取短名（qres / tr / def），图按图元（`pie.svg` 等，取自
//  `CHART_KINDS` 以免加图元时漏一处），表与报表原样（rfc/0007）。老名字不再认。
const OURS = new RegExp('^(\\d{8}T\\d{6}Z)-[0-9a-z_~]+(?:-[0-9a-f]{8})?\\.('
  + `qres\\.json|tr\\.json|def\\.json|ctx\\.json|table\\.md|report\\.html|(?:${CHART_KINDS.join('|')})\\.svg`
  + ')$');

/** 清单里的一条制品：文件自述 + 只有状态才知道的 pin。 */
export interface ArtifactEntry {
  asset: string;
  name: string;
  kind: 'chart' | 'report';
  at: string;
  title: string;
  /** 更精确的分类（周报、月报、即时分析…）；自述里没有就不写这一项。 */
  category?: string;
  pinned: boolean;
}

export interface State {
  db: DatabaseSync;
  close(): void;
}

/** `20261012T083401Z` → 毫秒。名字里的时间是权威：它免疫 `touch`，也是清单排序的依据。 */
const stampMs = (stamp: string): number => Date.UTC(
  Number(stamp.slice(0, 4)), Number(stamp.slice(4, 6)) - 1, Number(stamp.slice(6, 8)),
  Number(stamp.slice(9, 11)), Number(stamp.slice(11, 13)), Number(stamp.slice(13, 15)),
);

/** 只读文件开头一段：自述按契约写在最前面，读几百字节就够（产物本身可能有几 MB）。 */
const readHead = (path: string, bytes = 4096): string => {
  const fd = openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(bytes);
    const read = readSync(fd, buffer, 0, bytes, 0);
    return buffer.subarray(0, read).toString('utf8');
  } finally {
    closeSync(fd);
  }
};

/** 打开（必要时建）工作区的状态库。每次工具调用开一次、用完关掉：状态是磁盘上的事实，
 *  不持有跨调用的句柄，也就没有"工作区换了、句柄还是旧的"这类问题。 */
export function openState(root: string): State {
  const directory = join(root, STATE_DIR);
  mkdirSync(directory, { recursive: true });
  const db = new DatabaseSync(join(directory, 'state.db'));
  // 清单端点与工具调用各开一次库，撞上写锁是常态（一次刷新不该因为 SQLITE_BUSY 变成"读不到清单"）。
  db.exec('pragma busy_timeout = 2000');
  db.exec(`create table if not exists artifacts (
    file text primary key,
    name text not null,
    kind text not null,
    at text not null,
    title text not null,
    category text,
    pinned integer not null default 0,
    pinned_at text
  )`);
  // 工作区级的少量元信息（当前只有"最后一次清理"）。键值表，单行写入。
  db.exec('create table if not exists meta (key text primary key, value text not null)');
  // 老库（还没这一列）补上：状态库是插件自己的，迁移放在打开时做一次就够。
  const columns = db.prepare('pragma table_info(artifacts)').all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === 'category')) {
    db.exec('alter table artifacts add column category text');
  }
  return { db, close: () => db.close() };
}

/** 读一份可见产物的自述；读不出（正被写入、形状不符、老产物）就是 null。 */
const metaOf = (directory: string, file: string): ArtifactMeta | null => {
  try {
    return readArtifactMeta(readHead(join(directory, file)));
  } catch {
    return null;   // 读的这一刻文件没了、或被别的东西占着：这一次跳过，下一次再说
  }
};

const UPSERT = `insert into artifacts (file, name, kind, at, title, category)
  values (?, ?, ?, ?, ?, ?)
  on conflict(file) do update set name = excluded.name, kind = excluded.kind,
    at = excluded.at, title = excluded.title, category = excluded.category`;

/** 记一行产出。**产出方手里就有 meta**（`saveArtifact` 先造它、再嵌进文件），所以这一步不读文件
 *  ——读回来还要解一遍 XML 转义、还要赌文件的形状，而两件事都会以"清单里少一条"收场。
 *  与落盘在同一次工具调用里完成，这就是"有文件必有账"。 */
export function recordArtifact(state: State, file: string, meta: ArtifactMeta): void {
  state.db.prepare(UPSERT).run(file, meta.name, meta.kind, meta.at, meta.title, meta.category ?? null);
}

/** 读路径的**补登**：目录里有、账本上没有的可读产物，就地登记。
 *  只补登、**不删除**——所以"目录一时看不见"或"某个文件读不出来"都不会让清单少一条。
 *  一行都不用补时（正常情况）连事务都不开：读路径照旧是纯读。
 *  代价是每次读多一次 readdir（几十个名字，可忽略）；换来的是"文件在、账上没有"这一类
 *  （过渡期的产物、写完文件就崩、人工放进来的、库被换过）**一次读就自愈**，不必等下一次写操作。
 *  库被删的情形自然也在这里：表空，于是目录里的每一份都是"没有行的"。 */
export function adoptArtifacts(state: State, root: string): { adopted: number; unreadable: string[] } {
  const directory = join(root, ARTIFACT_DIR);
  if (!existsSync(directory)) return { adopted: 0, unreadable: [] };
  const known = new Set((state.db.prepare('select file from artifacts').all() as Array<{ file: string }>)
    .map((row) => row.file));
  const pending = readdirSync(directory)
    .filter((file) => VISIBLE.test(file) && !known.has(file));
  if (pending.length === 0) return { adopted: 0, unreadable: [] };
  let adopted = 0;
  const unreadable: string[] = [];
  state.db.exec('begin');
  try {
    for (const file of pending) {
      const meta = metaOf(directory, file);
      if (meta === null) {
        unreadable.push(file);   // 正被写入、形状不符、老产物：这一次不登记，下一次读再试
        continue;
      }
      recordArtifact(state, file, meta);
      adopted += 1;
    }
    state.db.exec('commit');
  } catch (cause) {
    state.db.exec('rollback');
    throw cause;
  }
  return { adopted, unreadable };
}

/** 把账本对齐到目录。**只在写路径调用**（写产物之前的那次懒惰清理、以及保留动作）：
 *   - 补登还没有行的可读产物（半份刚写完、人工放进来的、收养那一刻读不出的）；
 *   - 删掉行在而文件已经不在的条目（人工 `rm`、别处删掉）。
 *  两种"读不到"照旧分开：读不出 = 只跳过（行留着，标题还是旧的那份）；文件不在 = 删行。
 *  **保留不在这一步里动**——它只由 `pin` / `unpin` 改。 */
export function reconcileArtifacts(state: State, root: string): { adopted: number; removed: string[]; unreadable: string[] } {
  const directory = join(root, ARTIFACT_DIR);
  // 目录不在时什么都不做：还没写过产物是常态，"这一次看不见目录"不该把库里的行清光。
  if (!existsSync(directory)) return { adopted: 0, removed: [], unreadable: [] };
  const files = readdirSync(directory).filter((file) => VISIBLE.test(file));
  const present = new Set(files);
  const known = new Set((state.db.prepare('select file from artifacts').all() as Array<{ file: string }>)
    .map((row) => row.file));
  let adopted = 0;
  const unreadable: string[] = [];
  state.db.exec('begin');
  try {
    for (const file of files) {
      if (known.has(file)) continue;   // 有行的以行为准：不重新解析它，也就不覆盖它原来的标题
      const meta = metaOf(directory, file);
      if (meta === null) {
        unreadable.push(file);
        continue;
      }
      recordArtifact(state, file, meta);
      adopted += 1;
    }
    const removed: string[] = [];
    for (const file of known) {
      if (present.has(file)) continue;
      state.db.prepare('delete from artifacts where file = ?').run(file);
      removed.push(file);
    }
    state.db.exec('commit');
    return { adopted, removed, unreadable };
  } catch (cause) {
    state.db.exec('rollback');
    throw cause;
  }
}

/** 清单，最新在前。 */
export function listArtifacts(state: State): ArtifactEntry[] {
  const rows = state.db.prepare('select file, name, kind, at, title, category, pinned from artifacts'
    + ' order by at desc, file desc').all() as Array<{
      file: string; name: string; kind: 'chart' | 'report'; at: string;
      title: string; category: string | null; pinned: number;
    }>;
  return rows.map((row) => ({
    asset: row.file,
    name: row.name,
    kind: row.kind,
    at: row.at,
    title: row.title,
    ...(row.category === null ? {} : { category: row.category }),
    pinned: row.pinned === 1,
  }));
}

/** 记下"最后一次清理"：手工（页签按钮、`collect`）还是自动（写路径的保活清理）。
 *  只在**确实清了东西**时记——每次写操作都刷一遍时间，这行就没意义了。 */
export function recordCleanup(state: State, kind: 'manual' | 'auto', at: number = Date.now()): void {
  state.db.prepare('insert into meta (key, value) values (?, ?) '
    + 'on conflict(key) do update set value = excluded.value')
    .run('lastCleanup', JSON.stringify({ kind, at }));
}

/** 读"最后一次清理"：重启之后还在（它记在账本里，不在内存里）。 */
export function readLastCleanup(state: State): { kind: 'manual' | 'auto'; at: number } | undefined {
  const row = state.db.prepare('select value from meta where key = ?').get('lastCleanup') as
    | { value?: unknown }
    | undefined;
  if (typeof row?.value !== 'string') return undefined;
  try {
    const parsed = JSON.parse(row.value) as { kind?: unknown; at?: unknown };
    if ((parsed.kind === 'manual' || parsed.kind === 'auto') && typeof parsed.at === 'number') {
      return { kind: parsed.kind, at: parsed.at };
    }
  } catch {
    // 坏了就当作没有：这一行不值得让页签读不出来。
  }
  return undefined;
}

/** 工作区里各类占用：材料分数据 / 图表（图表与表格合并算一类）、代码区、交付的报表。 */
export interface Usage {
  data: { files: number; bytes: number };
  charts: { files: number; bytes: number };
  work: { files: number; bytes: number };
  artifacts: { files: number; bytes: number; pinned: number };
}

/** 一个目录里"我们命名的"文件的份数与字节。 */
function usageOf(base: string, match: (file: string) => boolean): { files: number; bytes: number } {
  let files = 0;
  let bytes = 0;
  let names: string[];
  try {
    names = readdirSync(base);
  } catch {
    // 目录看不见（被清理、被换成同名文件、权限不对）：这一类按零算，别把整次清单读带坏。
    return { files, bytes };
  }
  for (const file of names) {
    if (!match(file)) continue;
    try {
      files += 1;
      bytes += statSync(join(base, file)).size;
    } catch {
      // 读不了就不算，别让一块统计把整次读取带坏。
    }
  }
  return { files, bytes };
}

/** 确实清了东西时记一笔"最后一次清理"（自己开一次库，调用方不必持有状态句柄）。 */
export function markCleanup(root: string, kind: 'manual' | 'auto', removed: number): void {
  if (removed <= 0) return;
  const state = openState(root);
  try {
    recordCleanup(state, kind);
  } finally {
    state.close();
  }
}

/** 页签那块概览要的四类占用：材料分"数据"与"图表"（图表与表格合并算一类）、代码区、报表。
 *  报表的份数与保留数来自账本（调用方传进来，与清单显示的是同一批行），字节按磁盘现算。 */
export function usageByKind(root: string, entries: Array<{ asset: string; pinned: boolean }>): Usage {
  const data = usageOf(join(root, DATA_DIR), (file) => OURS.test(file));
  const charts = usageOf(join(root, FIGURE_DIR), (file) => OURS.test(file));
  const reports = usageOf(join(root, ARTIFACT_DIR), (file) => OURS.test(file));
  return {
    data,
    charts,
    work: workUsage(root),
    artifacts: { files: entries.length, bytes: reports.bytes, pinned: entries.filter((e) => e.pinned).length },
  };
}

/** 材料还剩几份（只数我们命名的），给回执用。 */
export function materialCount(root: string): number {
  let count = 0;
  for (const directory of [DATA_DIR, FIGURE_DIR]) {
    const base = join(root, directory);
    if (!existsSync(base)) continue;
    count += readdirSync(base).filter((file) => OURS.test(file)).length;
  }
  return count;
}

/** 清一次材料（`.oks/data` `.oks/figures`）：删掉超过窗口的、**我们命名的**文件；
 *  别的一概不碰。`minutes` 由调用方给——自动路径来自 `retention.auto.materials`，
 *  显式触发来自 `collect` 的 `ttl` 或 `retention.manual.materials`。
 *  判据是 mtime＝**产生时刻**（读不算使用）。 */
export function collectMaterials(root: string, minutes: number): {
  removed: string[]; freedBytes: number; kept: number; untouched: number; remaining: number;
} {
  const cutoff = Date.now() - minutes * 60_000;
  const removed: string[] = [];
  let freedBytes = 0;
  let kept = 0;
  let untouched = 0;
  for (const directory of [DATA_DIR, FIGURE_DIR]) {
    const base = join(root, directory);
    if (!existsSync(base)) continue;
    for (const file of readdirSync(base)) {
      if (!OURS.test(file)) { untouched += 1; continue; }
      const target = join(base, file);
      try {
        const info = statSync(target);
        if (info.mtimeMs >= cutoff) { kept += 1; continue; }
        unlinkSync(target);
        removed.push(`${directory}/${file}`);
        freedBytes += info.size;
      } catch {
        untouched += 1;   // 读不了、删不掉：留着，不动它
      }
    }
  }
  return { removed, freedBytes, kept, untouched, remaining: materialCount(root) };
}

/** 清一次代码区（`.work/`）：删掉超过窗口的文件，子目录不参与。
 *  它只在窗口被显式给出时才被调用——auto 默认不给（`.work/` 不参与自动清理）。 */
export function collectWork(root: string, minutes: number): {
  removed: string[]; freedBytes: number; kept: number;
} {
  const base = join(root, WORK_DIR);
  const removed: string[] = [];
  let freedBytes = 0;
  let kept = 0;
  if (!existsSync(base)) return { removed, freedBytes, kept };
  const cutoff = Date.now() - minutes * 60_000;
  for (const file of readdirSync(base)) {
    const target = join(base, file);
    try {
      const info = statSync(target);
      if (!info.isFile() || info.mtimeMs >= cutoff) { kept += 1; continue; }
      unlinkSync(target);
      removed.push(`${WORK_DIR}/${file}`);
      freedBytes += info.size;
    } catch {
      kept += 1;
    }
  }
  return { removed, freedBytes, kept };
}

/** 材料（`.oks/data|figures` 里我们命名的文件）的文件数与总字节。 */
export function materialUsage(root: string): { files: number; bytes: number } {
  let files = 0;
  let bytes = 0;
  for (const directory of [DATA_DIR, FIGURE_DIR]) {
    const base = join(root, directory);
    if (!existsSync(base)) continue;
    for (const file of readdirSync(base)) {
      if (!OURS.test(file)) continue;
      try { files += 1; bytes += statSync(join(base, file)).size; } catch { /* 读不了就不算 */ }
    }
  }
  return { files, bytes };
}

/** 代码区（`.work/` 下的文件）的文件数与总字节。 */
export function workUsage(root: string): { files: number; bytes: number } {
  const base = join(root, WORK_DIR);
  let files = 0;
  let bytes = 0;
  let names: string[];
  try {
    names = readdirSync(base);
  } catch {
    return { files, bytes };
  }
  for (const file of names) {
    const target = join(base, file);
    try {
      const info = statSync(target);
      if (!info.isFile()) continue;
      files += 1;
      bytes += info.size;
    } catch { /* 读不了就不算 */ }
  }
  return { files, bytes };
}

/** 按一套窗口清一次：材料 + （给了窗口才）代码区。写路径的自动清理与人的按钮都走它，
 *  于是"清哪些、按什么窗口清"只有一个出处。 */
export function collectWithWindows(root: string, windows: { materials: number; work: number | null }): {
  windowSeconds: number;
  cutoffMs: number;
  removedMaterials: number;
  removedWork: number;
  freedBytes: number;
  remainingMaterials: number;
  remainingMaterialBytes: number;
  remainingWork: number;
  remainingWorkBytes: number;
} {
  // 截止时刻按材料窗口算：它就是要显示给人看的"清理了 <这个时刻> 之前的文件"。
  const cutoffMs = Date.now() - Math.round(windows.materials * 60_000);
  const materials = collectMaterials(root, windows.materials);
  const work = windows.work === null
    ? { removed: [] as string[], freedBytes: 0, kept: 0 }
    : collectWork(root, windows.work);
  const materialLeft = materialUsage(root);
  const workLeft = workUsage(root);
  // 回执只给数量与大小，不给路径：界面据此写一句话，路径留在日志与工具回执里。
  return {
    windowSeconds: Math.round(windows.materials * 60),
    cutoffMs,
    removedMaterials: materials.removed.length,
    removedWork: work.removed.length,
    freedBytes: materials.freedBytes + work.freedBytes,
    remainingMaterials: materialLeft.files,
    remainingMaterialBytes: materialLeft.bytes,
    remainingWork: workLeft.files,
    remainingWorkBytes: workLeft.bytes,
  };
}

/** 被保留的文件名集合——清理靠它跳过。 */
export function pinnedFiles(state: State): Set<string> {
  const rows = state.db.prepare('select file from artifacts where pinned = 1').all() as Array<{ file: string }>;
  return new Set(rows.map((row) => row.file));
}

/** 改一条的 pin；返回是否命中了清单里的一行。没命中说明它没有自述、进不了清单。 */
export function setPinned(state: State, file: string, pinned: boolean): boolean {
  const info = state.db.prepare('update artifacts set pinned = ?, pinned_at = ? where file = ?')
    .run(pinned ? 1 : 0, pinned ? new Date().toISOString() : null, file);
  return Number(info.changes) > 0;
}

/** 保活清理：删掉"过了保活 + 没有 pin"的产物——**遍历账本的行**，不遍历目录。
 *  登记过才知道哪些是我们的，于是不再需要 `OURS` 正则去猜；过期就把文件与那一行一起去掉，
 *  文件已经不在的（人工删过）顺手把行清掉。认不出的文件根本不在账本里，自然不碰。
 *  目录看不见时什么都不做：那一次"看不见"不该被当成"产物都没了"。 */
export function pruneArtifacts(
  state: State,
  root: string,
  keepAliveMinutes: number = KEEP_ALIVE_MINUTES,
): { removed: string[]; kept: number; missing: number } {
  if (!existsSync(join(root, ARTIFACT_DIR))) return { removed: [], kept: 0, missing: 0 };
  const pinned = pinnedFiles(state);
  const cutoff = Date.now() - keepAliveMinutes * 60_000;
  const rows = state.db.prepare('select file, at from artifacts').all() as Array<{ file: string; at: string }>;
  const removed: string[] = [];
  let kept = 0;
  let missing = 0;
  state.db.exec('begin');
  try {
    for (const row of rows) {
      if (pinned.has(row.file) || stampMs(row.at) > cutoff) {
        kept += 1;
        continue;
      }
      try {
        unlinkSync(join(root, ARTIFACT_DIR, row.file));
      } catch {
        missing += 1;   // 文件已经不在：行照样清掉
      }
      state.db.prepare('delete from artifacts where file = ?').run(row.file);
      removed.push(row.file);
    }
    state.db.exec('commit');
  } catch (cause) {
    state.db.exec('rollback');
    throw cause;
  }
  return { removed, kept, missing };
}

/** `pin` / `unpin` 的入口：把 asset 解析成文件名、核对它是可见产物、再落状态。
 *  越界、不存在、不是图或报告，都在解析这一步报错。 */
export function pinByAsset(root: string, asset: unknown, pinned: boolean): { asset: string; pinned: boolean } {
  const file = artifactFileName(root, asset);
  if (!VISIBLE.test(file)) {
    throw new Error(`只有报表可以保留（${VISIBLE.source}）：${JSON.stringify(asset)}`);
  }
  const state = openState(root);
  try {
    // 保留是写路径：顺手把账本对齐一次（人工放进 artifacts/ 的报告也能就此被保留）。
    reconcileArtifacts(state, root);
    if (!setPinned(state, file, pinned)) {
      throw new Error(`这份产物没有自述、进不了清单，因此无法保留：${JSON.stringify(asset)}`);
    }
    return { asset: file, pinned };
  } finally {
    state.close();
  }
}

/** 主动删除一份产物（界面每行那个 x）。两条口径：
 *   - **只有未保留的能删**：保留是保护、删除是销毁，两者不重叠，于是不存在"手滑毁掉想留的东西"；
 *   - **先 unlink 再删行**：反过来的话，unlink 失败会留下"行没了、文件还在"，下一次收养会把它
 *     补登回来，用户的删除看起来被撤销了；这个顺序下最坏只是"文件没了、行还在"，下一次清理顺手删行。
 *  文件已经不在也照样把行删掉——用户点的是清单上的那一行，而清单是权威。
 *  校验只看"路径在 `artifacts/` 内 + 是可见产物 + 登记过"：**不要求文件存在**（上面那条）。
 *  材料不级联删：同一张图可能被别的报表引用，它们由保活按龄回收。 */
export function deleteArtifact(root: string, asset: unknown): { asset: string } {
  const text = typeof asset === 'string' ? asset : '';
  const inside = relative(resolve(root, ARTIFACT_DIR), resolve(root, text));
  if (inside.length === 0 || inside.startsWith('..') || isAbsolute(inside)) {
    throw new Error(`只能删除工作区 ${ARTIFACT_DIR}/ 里的产物：${JSON.stringify(asset)}`);
  }
  if (!VISIBLE.test(inside)) {
    throw new Error(`只有报表可以删除（${VISIBLE.source}）：${JSON.stringify(asset)}`);
  }
  const file = inside;
  const state = openState(root);
  try {
    const row = state.db.prepare('select pinned from artifacts where file = ?').get(file) as { pinned: number } | undefined;
    if (row === undefined) throw new Error(`这份产物没有登记，删不了：${JSON.stringify(asset)}`);
    if (row.pinned === 1) throw new Error(`这份产物已经保留，先取消保留再删除：${JSON.stringify(asset)}`);
    try {
      unlinkSync(join(root, ARTIFACT_DIR, file));
    } catch {
      // 已经不在磁盘上了：这一行仍然要清掉。
    }
    state.db.prepare('delete from artifacts where file = ?').run(file);
    return { asset: file };
  } finally {
    state.close();
  }
}
