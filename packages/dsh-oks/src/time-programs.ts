import timeWindowsSource from './builtin/time-windows.jq';
import timeHelpSource from './help/time.md';
import { readHelpMarkdown } from './help.ts';
export const timeHelp = readHelpMarkdown(timeHelpSource);

// 工具侧的日历方法：与自定义程序共用 Wasm 引擎，计算正文及参数进入来源链。
export const timeWindows = {
  description: timeHelp.description,
  args: ['input', 'unit', 'count', 'mode'],
  source: timeWindowsSource,
};

export function timeWindowCode(src: string, rawArgs: unknown): {file:string;text:string} {
  if (rawArgs === null || (rawArgs !== undefined && (typeof rawArgs !== 'object' || Array.isArray(rawArgs)))) throw new Error('jq.args must be an object');
  const args: Record<string, unknown> = {input:'ctx', ...rawArgs as Record<string, unknown>};
  for (const key of Object.keys(args)) if (!timeWindows.args.includes(key)) throw new Error(`Unknown time window argument: ${key}`);
  if (typeof args.input !== 'string' || args.input === '') throw new Error('time windows input must be a load name');
  if (typeof args.unit !== 'string' || !['year','quarter','month','week','day'].includes(args.unit)) throw new Error('time windows unit must be year/quarter/month/week/day');
  if (!Number.isSafeInteger(args.count) || Number(args.count) < 1 || Number(args.count) > 50) throw new Error('time windows count must be 1..50');
  if (typeof args.mode !== 'string' || !['complete','current','rolling'].includes(args.mode)) throw new Error('time windows mode must be complete/current/rolling');
  return {file:src,text:`${JSON.stringify(args)} as $args | ${timeWindows.source}`};
}
