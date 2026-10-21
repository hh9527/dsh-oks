import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { readHelpMarkdown } from './src/help.ts';
import { createSelector } from './src/select.ts';
import { helpFiles } from './src/help-files.ts';
const help=(name:string)=>readHelpMarkdown(helpFiles[`oks://help/${name}.md`]);

const source = '# 帮助\n\n## nested\n\n### prose\n\n说明 `value`。\n\n### sample\n\n```json\n{"x":[1,true]}\n```\n\n## code\n\n```source\n## this is source, not a heading\n```\n';
assert.deepEqual(readHelpMarkdown(source), {nested:{prose:'说明 `value`。',sample:{x:[1,true]}},code:'## this is source, not a heading'});
assert.throws(() => readHelpMarkdown('# H\n## a\nx\n## a\ny'), /Duplicate help heading/);
assert.throws(() => readHelpMarkdown('# H\n### a\nx'), /Skipped help heading/);
assert.throws(() => readHelpMarkdown('# H\n## a\ntext\n### b\nx'), /Help branch/);
assert.throws(() => readHelpMarkdown('# H\n## a\n```json\n{broken}\n```'), SyntaxError);
const proto = readHelpMarkdown('# H\n## __proto__\nx');
assert.equal(Object.getPrototypeOf(proto), Object.prototype);
assert.equal(Object.hasOwn(proto,'__proto__'),true);
for (const file of readdirSync(new URL('./src/help/', import.meta.url)).filter(file => file.endsWith('.md') && file !== 'README.md')) {
  assert.ok(Object.keys(readHelpMarkdown(readFileSync(new URL(`./src/help/${file}`,import.meta.url),'utf8'))).length);
}
for (const name of ['knowledge','project','query','draft','time','figures']) assert.ok(helpFiles[`oks://help/${name}.md`]);
assert.match(helpFiles['oks://help/query.md'], /ontology-intent-v1/);
assert.ok(!helpFiles['oks://help/query.md'].includes('{{intentContract}}'));
console.log('Markdown help: nested prose, structured examples, source fences, invalid headings, safe keys and all help roots passed');

// Documented selectors operate on the documented graph.
const graph=help('knowledge').overview.shape;
const sample=help('knowledge').understanding.example;
createSelector(sample.select)(graph);
const values=createSelector('types.Severity.values')(graph) as any;
assert.deepEqual(values,{types:{Severity:{values:{major:{}}}}});
assert.equal(values.types.Severity.fields,undefined);
const projectHelp=help('project').overview;
createSelector(projectHelp.examples.select.select)(graph);
const rowPreview=createSelector('rows[0..5],truncated')({rows:Array.from({length:9},(_,n)=>({n})),truncated:false}) as any;
assert.equal(rowPreview['rows[0..5]'].length,5);
assert.equal(rowPreview.truncated,false);
