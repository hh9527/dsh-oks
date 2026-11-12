import {ENABLE_OKS_SEARCH} from './features.ts';
import search from './help/search.md';
import workflow from './help/workflow.md';
import dari from './help/dari.md';
import figures from './help/dari-figures.md';
import rules from './help/rules.md';

/** Readable manuals and the stable main-agent prefix are generated from the same text. */
export const helpFiles:Record<string,string> = {
  'oks://help/workflow.md':workflow+(ENABLE_OKS_SEARCH?'\n\n## 定域搜索\n\n'+search:''),
  'oks://help/dari.md':dari,
  'oks://help/rules.md':rules,
  'oks://help/dari-figures.md':figures,
};
export const PRELOADED_MANUALS=['oks://help/workflow.md','oks://help/dari.md','oks://help/rules.md'] as const;
export const manualPrompt = [
  '以下 workflow.md、dari.md、rules.md 三段已完整载入，无需 oks_read。仅在逐字引用或上下文被压缩后重读；dari-figures.md 未载入，选定图表后按需读取。',
  ...PRELOADED_MANUALS.map(uri=>'<!-- '+uri+' -->\n'+helpFiles[uri].trimEnd()),
].join('\n\n');
export function helpEntries(files:Record<string,string> = helpFiles) {return Object.entries(files).map(([name,text])=>({name,bytes:Buffer.byteLength(text),modifiedAt:''}));}
