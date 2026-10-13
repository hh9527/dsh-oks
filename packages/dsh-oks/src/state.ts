// 产出层的状态：谁被保留了（pin），以及一份可从目录重建的清单。
//
// 为什么单独一层：pin 是**唯一不能从产物重建**的东西——文件里只有自述，pin 是人的动作。
// 所以它是真状态；清单只是投影，随时能从 artifacts/ 与产物自述重建（删了库也不会丢东西，
// 只丢 pin）。状态住在工作区的 .oks/state.db（node:sqlite，零新依赖）：artifacts/ 会被保活
// 清理，状态不能被清，所以两者分开放。
//
// 清理只认"我们写的那三类产物"这个名字形状；**认不出的文件一概不碰**——工作区里可能有
// 用户自己放的东西，我们不替人做删除决定。

import { DatabaseSync } from 'node:sqlite';
import { closeSync, existsSync, mkdirSync, openSync, readSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ARTIFACT_DIR, artifactFileName, CHART_DIR, DATA_DIR, readArtifactMeta, VIEW_DIR } from './results.ts';

/** 状态目录（相对工作区根）。 */
export const STATE_DIR = '.oks';

/** 保活下限（分钟）：未保留的产物在**产生**之后这么久内保证存在。
 *  MVP 用固定值；配置项（`oks.json` 的 `data.keepAliveMinutes`）留到需要时再加。 */
export const KEEP_ALIVE_MINUTES = 60;

/** 内部材料（`.oks/data/`、`.oks/charts/`）的保活窗口：**比报表多 2 分钟**。
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
const OURS = /^(\d{8}T\d{6}Z)-[0-9a-z_~]+(?:-[0-9a-f]{8})?\.(query\.json|transform\.json|data\.json|chart\.svg|table\.md|report\.html)$/;

/** 清单里的一条制品：文件自述 + 只有状态才知道的 pin。 */
export interface ArtifactEntry {
  file: string;
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
  // 老库（还没这一列）补上：状态库是插件自己的，迁移放在打开时做一次就够。
  const columns = db.prepare('pragma table_info(artifacts)').all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === 'category')) {
    db.exec('alter table artifacts add column category text');
  }
  return { db, close: () => db.close() };
}

/** 把清单对齐到目录：读每个可见产物的自述写进库，删掉文件已经不在的行。
 *  **pin 不在这一步里动**——它只由 `pin` / `unpin` 改。
 *  返回这次从清单里移除的文件名（调用方爱记就记一行，便于事后自证）。 */
export function syncArtifacts(state: State, root: string): string[] {
  const directory = join(root, ARTIFACT_DIR);
  // 目录不在时**什么都不做**。还没写过产物是常态；而"这一次看不见目录"绝不该把库里的行清光
  // ——那样清单会凭空变空，得刷新页面（重新挂载、重新读）才回来。
  if (!existsSync(directory)) return [];
  const files = readdirSync(directory).filter((file) => VISIBLE.test(file));
  const upsert = state.db.prepare(`insert into artifacts (file, name, kind, at, title, category)
    values (?, ?, ?, ?, ?, ?)
    on conflict(file) do update set name = excluded.name, kind = excluded.kind,
      at = excluded.at, title = excluded.title, category = excluded.category`);
  state.db.exec('begin');
  try {
    const seen = new Set<string>();
    for (const file of files) {
      const meta = readArtifactMeta(readHead(join(directory, file)));
      if (meta === null) continue; // 没有自述的产物不进清单（老产物或形状不符）
      seen.add(file);
      upsert.run(file, meta.name, meta.kind, meta.at, meta.title, meta.category ?? null);
    }
    const removed: string[] = [];
    for (const row of state.db.prepare('select file from artifacts').all() as Array<{ file: string }>) {
      if (!seen.has(row.file)) {
        state.db.prepare('delete from artifacts where file = ?').run(row.file);
        removed.push(row.file);
      }
    }
    state.db.exec('commit');
    return removed;
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
    file: row.file,
    name: row.name,
    kind: row.kind,
    at: row.at,
    title: row.title,
    ...(row.category === null ? {} : { category: row.category }),
    pinned: row.pinned === 1,
  }));
}

/** 回收内部材料：按年龄丢，**不看保留**（保留只对报表有意义），认得清的才动。
 *  返回与 `pruneArtifacts` 同形状的结果，便于调用方统一记一行日志。 */
export function pruneMaterials(
  state: State,
  root: string,
  keepAliveMinutes: number = MATERIAL_KEEP_ALIVE_MINUTES,
): { removed: string[]; kept: number; untouched: number } {
  void state;   // 材料没有保留状态；参数保留是为了与 pruneArtifacts 同形，调用处一致。
  const removed: string[] = [];
  let untouched = 0;
  const cutoff = Date.now() - keepAliveMinutes * 60_000;
  for (const directory of [DATA_DIR, CHART_DIR, VIEW_DIR]) {
    const base = join(root, directory);
    if (!existsSync(base)) continue;
    for (const file of readdirSync(base)) {
      if (!OURS.test(file)) { untouched += 1; continue; }
      const target = join(base, file);
      try {
        if (statSync(target).mtimeMs >= cutoff) continue;
        unlinkSync(target);
        removed.push(`${directory}/${file}`);
      } catch {
        untouched += 1;   // 读不了、删不掉：留着，不动它
      }
    }
  }
  return { removed, kept: 0, untouched };
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

/** 保活清理：删掉"我们写的 + 过了保活 + 没有 pin"的产物。
 *  认不出的文件只统计、不碰；返回三组数字，好让调用方留痕。 */
export function pruneArtifacts(
  state: State,
  root: string,
  keepAliveMinutes: number = KEEP_ALIVE_MINUTES,
): { removed: string[]; kept: number; untouched: number } {
  const directory = join(root, ARTIFACT_DIR);
  if (!existsSync(directory)) return { removed: [], kept: 0, untouched: 0 };
  const pinned = pinnedFiles(state);
  const cutoff = Date.now() - keepAliveMinutes * 60_000;
  const removed: string[] = [];
  let kept = 0;
  let untouched = 0;
  for (const file of readdirSync(directory)) {
    if (!OURS.test(file)) { untouched += 1; continue; }
    if (pinned.has(file) || stampMs(file.slice(0, 16)) > cutoff) { kept += 1; continue; }
    unlinkSync(join(directory, file));
    removed.push(file);
  }
  return { removed, kept, untouched };
}

/** `pin` / `unpin` 的入口：把 src 解析成文件名、核对它是可见产物、再落状态。
 *  越界、不存在、不是图或报告，都在解析这一步报错。 */
export function pinBySrc(root: string, src: unknown, pinned: boolean): { file: string; pinned: boolean } {
  const file = artifactFileName(root, src);
  if (!VISIBLE.test(file)) {
    throw new Error(`只有报表可以保留（${VISIBLE.source}）：${JSON.stringify(src)}`);
  }
  const state = openState(root);
  try {
    syncArtifacts(state, root);
    if (!setPinned(state, file, pinned)) {
      throw new Error(`这份产物没有自述、进不了清单，因此无法保留：${JSON.stringify(src)}`);
    }
    return { file, pinned };
  } finally {
    state.close();
  }
}
