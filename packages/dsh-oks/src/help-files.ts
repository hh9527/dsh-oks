import workflow from './help/workflow.md';
import dari from './help/dari.md';
import rules from './help/rules.md';
import {modelContracts} from './contracts.ts';
import {presentationOverview} from './presentation-guide.ts';

/** Readable manuals and the stable main-agent prefix are generated from the same text. */
export const helpFiles:Record<string,string> = {
  'oks://help/workflow.md':workflow,
  'oks://help/dari.md':dari.replaceAll('{{intentContract}}',modelContracts.intent).replace('{{figureIndex}}',presentationOverview().join('\n')),
  'oks://help/rules.md':rules,
};
export const PRELOADED_MANUALS=['oks://help/workflow.md','oks://help/dari.md','oks://help/rules.md'] as const;
export const manualPrompt = [
  '以下 workflow.md、dari.md、rules.md 三段已完整载入，无需 oks_read。仅在逐字引用或上下文被压缩后重读；figure-*.md 未载入，选定图表后按需读取。',
  ...PRELOADED_MANUALS.map(uri=>'<!-- '+uri+' -->\n'+helpFiles[uri].trimEnd()),
].join('\n\n');
export function helpEntries(files:Record<string,string> = helpFiles) {return Object.entries(files).map(([name,text])=>({name,bytes:Buffer.byteLength(text),modifiedAt:''}));}
