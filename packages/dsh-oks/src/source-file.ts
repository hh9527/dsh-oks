import {existsSync,realpathSync,statSync,readFileSync} from 'node:fs';
import {dirname,isAbsolute,relative,resolve} from 'node:path';

export const DARI_MAX_BYTES = 256 * 1024;

/** 检查现有路径及其父目录的真实位置，拒绝符号链接越出工作区。 */
function checkRealBoundary(root: string, target: string): void {
  const workspace = realpathSync(root);
  let candidate = target;
  while (!existsSync(candidate)) candidate = dirname(candidate);
  const actual = realpathSync(candidate);
  const inside = relative(workspace, actual);
  if (inside === '..' || inside.startsWith('../') || isAbsolute(inside)) throw new Error('路径经符号链接越出工作区。');
}

/** Read a DARI source using the same local paths as host file tools.
 * Canonical identity keeps relative, absolute and symlink aliases in one cache.
 */
export function readDariSource(root:string, raw:unknown, tool:string): {file:string;text:string} {
  if(typeof raw!=='string'||!raw.trim()||raw.includes('://')||raw.includes('\0')||!raw.endsWith('.dari')) {
    throw new Error(`${tool}: src must be a local .dari file path, relative to the workspace or absolute`);
  }
  const target=resolve(root,raw);
  const inside=relative(resolve(root),target);
  if(inside==='..'||inside.startsWith('../')||isAbsolute(inside))throw new Error('DARI source must be inside the workspace');
  checkRealBoundary(root,target);
  const full=realpathSync(target);
  if(!statSync(full).isFile())throw new Error('DARI source must be a regular file');
  if(statSync(full).size>DARI_MAX_BYTES)throw new Error('DARI source exceeds 256 KiB');
  return {file:relative(realpathSync(root),full).split('\\').join('/'),text:readFileSync(full,'utf8')};
}
