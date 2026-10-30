/** Logical source addresses; physical locations stay private to the plugin. */
export const WORK_URI = 'oks://work/';
export const MEMORY_URI = 'oks://memory/';
export function sourcePath(raw:unknown): string {
  if(typeof raw!=='string')throw new Error('Expected a source address');
  if(raw.startsWith(WORK_URI))return '.work/'+raw.slice(WORK_URI.length);
  if(raw.includes('://'))throw new Error(`Unknown or readonly source address: ${raw}`);
  return raw; // Internal file APIs also serve existing local drafts.
}
export function sourceUri(path:string):string {
  return path.startsWith('.work/')?WORK_URI+path.slice(6):path;
}
