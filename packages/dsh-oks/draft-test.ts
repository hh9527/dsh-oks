import assert from 'node:assert/strict';
import { DraftSyntaxError, parsePipeline } from './src/draft/pipeline.ts';

const nodes = parsePipeline(`// analyst supplied threshold
let threshold = data({ warningRows: 100 });
let facts = query({op: "Graph", nodes: [{id: "d"}], limit: 500});
debug(jq("peek.jq", { facts }));
let summary = jq("summary.jq", { rows: facts.rows[0]["count"], threshold });
`, { offset: 40, line: 7, column: 1 });
assert.equal(nodes.length, 4);
assert.equal(nodes[0].statement.motivation, 'analyst supplied threshold');
assert.equal(nodes[0].statement.span.start.line, 8);
assert.equal(nodes[0].statement.span.start.offset, 70);
assert.deepEqual(nodes[2].bindings, ['facts']);
assert.deepEqual(nodes[3].bindings, ['facts', 'threshold']);
assert.equal(nodes[3].assets[0].name, 'summary.jq');
assert.equal(nodes[3].assets[0].span.start.line, 11);
assert.equal(nodes[2].statement.kind, 'debug');
assert.equal(parsePipeline('let a = data({"__proto__": 1, constructor: 2});').length, 1);
assert.equal(parsePipeline('let a = data([null, true, false, -1.5e2, "\\u4f60\\n"]);')[0].statement.value.kind, 'call');
assert.equal(parsePipeline('let a = context(); // comment\r\n\r\nlet b = data(1);')[1].statement.motivation, '');
assert.equal(parsePipeline('let a = data({a: 1,}); debug(a.a);').length, 2);
assert.equal(parsePipeline('let a = data(1); // trailing comment\nlet b = data(2);')[1].statement.motivation, '');
assert.equal(parsePipeline('// not adjacent\n   \nlet a = data(1);')[0].statement.motivation, '');
assert.equal(parsePipeline('// first\n// second\nlet a = data(1);')[0].statement.motivation, 'first\nsecond');

for (const [source, pattern] of [
  ['let x = x;', /Undefined or forward/],
  ['let x = y; let y = data(1);', /Undefined or forward/],
  ['let a = data(1); let a = data(2);', /Duplicate binding/],
  ['let query = data(1);', /Reserved binding/],
  ['let a = unknown();', /Unknown operator/],
  ['let a = query();', /argument count/],
  ['let a = jq("../peek.jq", {});', /single-file/],
  ['let a = jq("a.xhtml", {});', /single-file/],
  ['let p = data("a.jq"); let a = jq(p, {});', /literal/],
  ['let a = data({a: 1, "a": 2});', /Duplicate object key/],
  ['let a = data(1); debug(a[-1]);', /static string/],
  ['let a = data(1); debug(a[1e0]);', /static string/],
  ['let a = data(1); debug(a[a]);', /static string/],
  ['let a = data(1); debug(a.fn());', /Expected/],
  ['let a = data(1 + 2);', /Unsupported character/],
  ['let a = data(`text`);', /Unsupported character/],
  ["let a = data('text');", /Unsupported character/],
  ['let a = data(01);', /Expected/],
  ['let a = data(1e999);', /finite/],
  ['let a = data("\\x20");', /JSON string/],
  ['let a = data(1)', /Expected/],
  ['let a = data(1); a = data(2);', /Only let/],
  ['if (true) {}', /Only let/],
  ['debug(debug(1));', /Unknown operator/],
  ['/* never closed', /Unterminated/],
  ['debug(1);'.repeat(513), /512 statements/],
  ['let ' + 'a'.repeat(129) + ' = data(1);', /128 characters/],
  [`let a = data(${ '['.repeat(140) }0${ ']'.repeat(140) });`, /nesting/],
] as const) {
  assert.throws(() => parsePipeline(source), error => error instanceof DraftSyntaxError && pattern.test(error.message), source);
}
try {
  parsePipeline('let a = data(1);\r\nlet b = absent;', { offset: 100, line: 20, column: 5 });
  assert.fail('expected undefined binding');
} catch (error) {
  assert.ok(error instanceof DraftSyntaxError);
  assert.equal(error.span.start.line, 21);
  assert.equal(error.span.start.column, 9);
  assert.equal(error.span.start.offset, 126);
}
console.log('draft pipeline: dependency, source mapping and rejected-language checks passed');

const { parseDraft } = await import('./src/draft/document.ts');
const draft = [
  '# Analysis', '',
  '```md', '## pipeline', '```', '',
  '> ## pipeline', '> ```js', '> let fake = unknown();', '> ```', '',
  '## pipeline', '```js', '// Actual material', 'let facts = data({rows: [1]});',
  'debug(jq("peek.jq", {facts}));', '```', '',
  '## assets', '### Peek', '````jq name="peek.jq"', '.facts.rows', '# ```', '````', '',
  '## Appendix', '```js', 'unknown();', '```',
].join('\n');
const parsed = parseDraft(draft);
assert.equal(parsed.nodes.length, 2);
assert.equal(parsed.nodes[0].statement.span.start.line, 15);
assert.equal(parsed.assets.get('peek.jq')!.source, '.facts.rows\n# ```\n');
assert.equal(parsed.assets.get('peek.jq')!.body.line, 22);
const crlf = parseDraft(draft.replaceAll('\n', '\r\n'));
assert.equal(crlf.nodes[0].statement.span.start.line, 15);
assert.equal(crlf.nodes[0].statement.span.start.offset, draft.replaceAll('\n', '\r\n').indexOf('let facts'));
assert.equal(crlf.assets.get('peek.jq')!.source, '.facts.rows\r\n# ```\r\n');
const minimal = '## pipeline\n```js\nlet a = data(1);\n```';
assert.equal(parseDraft(minimal).nodes.length, 1);
assert.equal(parseDraft(minimal.replaceAll('```', '~~~')).nodes.length, 1);
for (const [source, pattern] of [
  ['```md\n## pipeline\n```', /pipeline section/],
  ['> ## pipeline\n> ```js\n> let a = data(1);\n> ```', /pipeline section/],
  [minimal + '\n## pipeline\n```js\n```', /Duplicate pipeline/],
  [minimal + '\n```js\n```', /exactly one/],
  [minimal.replace('```js', '```json'), /tagged js/],
  [minimal.slice(0, -3), /not closed/],
  [minimal.replaceAll('```', ' ```'), /column 1/],
  [minimal.replace('data(1)', 'jq("missing.jq", {})'), /Missing asset/],
  [minimal + '\n## assets\n```jq name="a.jq"\n.\n```\n```jq name="a.jq"\n.\n```', /Duplicate asset/],
  [minimal + '\n## assets\n```xhtml name="a.jq"\n<article/>\n```', /language and extension/],
  [minimal + '\n## assets\n```jq name="a.jq" extra="x"\n.\n```', /attributes/],
  ['x'.repeat(256 * 1024 + 1), /budget/],
] as const) {
  assert.throws(() => parseDraft(source), error => error instanceof DraftSyntaxError && pattern.test(error.message), source.slice(0, 200));
}
console.log('draft Markdown: CommonMark regions, fences, assets and source mapping passed');
