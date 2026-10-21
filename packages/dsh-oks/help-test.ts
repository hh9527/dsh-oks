import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { helpFiles,helpEntries } from './src/help-files.ts';
import { modelContracts } from './src/contracts.ts';

// 帮助直接以源码文本暴露，保留正常 Markdown 排版和代码围栏。
for (const name of ['knowledge','project','query','draft','time','figures']) {
  const path=`oks://help/${name}.md`;
  const source=readFileSync(new URL(`./src/help/${name}.md`,import.meta.url),'utf8');
  assert.equal(helpFiles[path],name==='query'?source.replaceAll('{{intentContract}}',modelContracts.intent):source);
  assert.ok(helpFiles[path].startsWith('# '));
  assert.equal(helpEntries().find(entry=>entry.name===path)?.bytes,Buffer.byteLength(helpFiles[path]));
}
assert.match(helpFiles['oks://help/query.md'],/ontology-intent-v1/);
assert.ok(!helpFiles['oks://help/query.md'].includes('{{intentContract}}'));
assert.ok(!Object.hasOwn(helpFiles,'oks://help/README.md'));
console.log('文本帮助：六个主题保留源码原文、查询契约替换及文件清单通过');
