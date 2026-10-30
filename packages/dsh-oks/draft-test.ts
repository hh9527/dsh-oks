import assert from 'node:assert/strict';
import { DraftSyntaxError, parsePipeline } from './src/draft/pipeline.ts';

const nodes = parsePipeline(`// analyst supplied threshold
threshold <- data({ warningRows: 100 });
facts <- query({op: "Graph", nodes: [{id: "d"}], limit: 500});
peek <- sql("peek.sql", { facts });
summary <- sql("summary.sql", { rows: facts.rows[0]["count"], threshold });
`, { offset: 40, line: 7, column: 1 });
assert.equal(nodes.length, 4);
assert.equal(nodes[0].statement.motivation, 'analyst supplied threshold');
assert.equal(nodes[0].statement.span.start.line, 8);
assert.equal(nodes[0].statement.span.start.offset, 70);
assert.deepEqual(nodes[2].bindings, ['facts']);
assert.deepEqual(nodes[3].bindings, ['facts', 'threshold']);
assert.equal(nodes[3].assets[0].name, 'summary.sql');
assert.equal(nodes[3].assets[0].span.start.line, 11);
assert.equal(nodes[2].statement.kind, 'binding');
assert.equal(parsePipeline('a <- data({"__proto__": 1, constructor: 2});').length, 1);
assert.equal(parsePipeline('a <- data([null, true, false, -1.5e2, "\\u4f60\\n"]);')[0].statement.value.kind, 'call');
assert.equal(parsePipeline('a <- context(); // comment\r\n\r\nb <- data(1);')[1].statement.motivation, '');
assert.equal(parsePipeline('a <- data({a: 1,}); peek <- a.a;').length, 2);
assert.equal(parsePipeline('a <- data(1); // trailing comment\nb <- data(2);')[1].statement.motivation, '');
assert.equal(parsePipeline('// not adjacent\n   \na <- data(1);')[0].statement.motivation, '');
assert.equal(parsePipeline('// first\n// second\na <- data(1);')[0].statement.motivation, 'first\nsecond');

for (const [source, pattern] of [
  ['x <- x;', /Undefined or forward/],
  ['x <- y; y <- data(1);', /Undefined or forward/],
  ['a <- data(1); a <- data(2);', /Duplicate binding/],
  ['query <- data(1);', /Reserved binding/],
  ['a <- unknown();', /Unknown operator/],
  ['a <- query();', /argument count/],
  ['a <- exec_query();', /argument count/],
  ['a <- exec_query({},{});', /argument count/],
  ['a <- sql("../peek.sql", {});', /single-file/],
  ['a <- sql("a.xhtml", {});', /single-file/],
  ['p <- data("a.sql"); a <- sql(p, {});', /literal/],
  ['a <- data({a: 1, "a": 2});', /Duplicate object key/],
  ['a <- data(1); peek <- a[-1];', /static string/],
  ['a <- data(1); peek <- a[1e0];', /static string/],
  ['a <- data(1); peek <- a[a];', /static string/],
  ['a <- data(1); peek <- a.fn();', /Expected/],
  ['a <- data(`text`);', /Unsupported character/],
  ["a <- data('text');", /Unsupported character/],
  ['a <- data(01);', /Expected/],
  ['a <- data(1e999);', /finite/],
  ['a <- data("\\x20");', /JSON string/],
  ['a <- data(1)', /Expected/],
  ['a <- data(1); a = data(2);', /Duplicate/],
  ['if (true) {}', /Expected/],
  ['peek <- unknown(1);', /Unknown operator/],
  ['/* never closed', /Unterminated/],
  [Array.from({length:513},(_,i)=>`n${i} <- 1;`).join(''), /512 statements/],
  ['a'.repeat(129) + ' <- data(1);', /128 characters/],
  [`a <- data(${ '['.repeat(140) }0${ ']'.repeat(140) });`, /nesting/],
] as const) {
  assert.throws(() => parsePipeline(source), error => error instanceof DraftSyntaxError && pattern.test(error.message), source);
}
try {
  parsePipeline('a <- data(1);\r\nb <- absent;', { offset: 100, line: 20, column: 5 });
  assert.fail('expected undefined binding');
} catch (error) {
  assert.ok(error instanceof DraftSyntaxError);
  assert.equal(error.span.start.line, 21);
  assert.equal(error.span.start.column, 6);
  assert.equal(error.span.start.offset, 120);
}
console.log('draft pipeline: dependency, source mapping and rejected-language checks passed');

const { parseMarkdownFixture: parseDraft } = await import('./test-markdown.ts');
const draft = [
  '# Analysis', '',
  '```md', '## pipeline', '```', '',
  '> ## pipeline', '> ```js', '> fake <- unknown();', '> ```', '',
  '## pipeline', '```js', '// Actual material', 'facts <- data({rows: [1]});',
  'peek <- sql("peek.sql", {facts});', '```', '',
  '## assets', '### Peek', '````sql name="peek.sql"', '.facts.rows', '# ```', '````', '',
  '## Appendix', '```js', 'unknown();', '```',
].join('\n');
const parsed = parseDraft(draft);
assert.equal(parsed.nodes.length, 2);
assert.equal(parsed.nodes[0].statement.span.start.line, 15);
assert.equal(parsed.assets.get('peek.sql')!.source, '.facts.rows\n# ```\n');
assert.equal(parsed.assets.get('peek.sql')!.body.line, 22);
const crlf = parseDraft(draft.replaceAll('\n', '\r\n'));
assert.equal(crlf.nodes[0].statement.span.start.line, 15);
assert.equal(crlf.nodes[0].statement.span.start.offset, draft.replaceAll('\n', '\r\n').indexOf('facts <-'));
assert.equal(crlf.assets.get('peek.sql')!.source, '.facts.rows\r\n# ```\r\n');
const minimal = '## pipeline\n```js\na <- data(1);\n```';
assert.equal(parseDraft(minimal).nodes.length, 1);
assert.equal(parseDraft(minimal.replaceAll('```', '~~~')).nodes.length, 1);
for (const [source, pattern] of [
  ['```md\n## pipeline\n```', /pipeline section/],
  ['> ## pipeline\n> ```js\n> a <- data(1);\n> ```', /pipeline section/],
  [minimal + '\n## pipeline\n```js\n```', /Duplicate pipeline/],
  [minimal + '\n```js\n```', /exactly one/],
  [minimal.replace('```js', '```json'), /tagged js/],
  [minimal.slice(0, -3), /not closed/],
  [minimal.replaceAll('```', ' ```'), /column 1/],
  [minimal.replace('data(1)', 'sql("missing.sql", {})'), /Missing asset/],
  [minimal + '\n## assets\n```sql name="a.sql"\n.\n```\n```sql name="a.sql"\n.\n```', /Duplicate asset/],
  [minimal + '\n## assets\n```xhtml name="a.sql"\n<article/>\n```', /language and extension/],
  [minimal + '\n## assets\n```sql name="a.sql" extra="x"\n.\n```', /attributes/],
  ['x'.repeat(256 * 1024 + 1), /budget/],
] as const) {
  assert.throws(() => parseDraft(source), error => error instanceof DraftSyntaxError && pattern.test(error.message), source.slice(0, 200));
}
console.log('draft Markdown: CommonMark regions, fences, assets and source mapping passed');

assert.doesNotThrow(()=>parsePipeline("a <- data(1 + 2);"),"Typed scalar arithmetic is part of Pipeline");
