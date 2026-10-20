import { parseDraft } from './src/draft/document.ts';
import { parseMarkdownFixture } from './test-markdown.ts';
// Real snapshot + read-only SQLite integration; all generated files stay in a fresh /tmp workspace.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createJaqEngine } from './src/jaq.ts';
import { resolveSettings } from './src/config.ts';
import { createRunner, createExecutor } from './src/runners.ts';
import { createDraftBackend } from './src/draft/backend.ts';
import { DraftRuntime } from './src/draft/runtime.ts';
class FixtureRuntime extends DraftRuntime { constructor(backend:ConstructorParameters<typeof DraftRuntime>[0], options:ConstructorParameters<typeof DraftRuntime>[1]={}) { super(backend,{...options,parse:(source,file)=>source.trimStart().startsWith('<Dari')?parseDraft(source,file):parseMarkdownFixture(source)}); } }
import type { WorkspaceEntry } from './src/knowledge.ts';

const [wasm, model, database] = process.argv.slice(2);
assert.ok(wasm && model && database, '需要 engine wasm、模型和只读数据库绝对路径');
const root = mkdtempSync(join(tmpdir(), 'oks-draft-real-'));
writeFileSync(join(root, 'oks.json'), JSON.stringify({ version: 1, domain: 'ic', model, dataFile: database }));
const settings = resolveSettings(root, undefined);
const modelBytes = readFileSync(model);
const runner = createRunner(settings, () => {}, modelBytes);
const executor = createExecutor(settings, () => {});
const jq = createJaqEngine(wasm);
const entry: WorkspaceEntry = { root, from: 'test', settings, runner, index: null, modelHash: createHash('sha256').update(modelBytes).digest('hex') };
let queries = 0;
let checks = 0;
const backend = createDraftBackend({ entry, file: '.work/real.md', contextZone: () => ({ kind: 'resolved', timeZone: 'Asia/Shanghai' }), jq,
  knowledge: { executorFor: () => ({ manifest: null, executor: { dispose() {}, async send(...args) { queries++; return executor.send(...args); } } }) },
});
const runtime = new FixtureRuntime({ ...backend, preflight: async (...args) => { checks++; return backend.preflight(...args); } });
const source = [
  '# Current alarm count', '## pipeline', '```js',
  'let ctx = context();',
  'let facts = exec_query(query({op: "Graph", root: "a", nodes: [{id:"a", entity:"current_alarm"}], edges:[], select:[], count:"a", limit:5}));',
  'let total = jq("total.jq", {facts});', 'debug(total);',
  'let answer = render_html("answer.xhtml", {total});', '```',
  '## assets', '```jq name="total.jq"', '.facts.rows[0] | to_entries[0].value', '```',
  '```xhtml name="answer.xhtml"', '<article><p>当前告警数：<span data-oks-ref="total" /></p></article>', '```',
].join('\n');
try {
  const planOnly='<Dari><Pipeline>let plan=query({op:"Graph",root:"a",nodes:[{id:"a",entity:"current_alarm"}],edges:[],select:[],count:"a",limit:5}); debug(plan.columns);</Pipeline></Dari>';
  let run=await runtime.run(planOnly);
  assert.equal(run.status,'complete',run.error);
  assert.equal(queries,0,'real model plan validation must not access SQLite');
  assert.deepEqual(runtime.read('plan',planOnly).value.data,{columns:[{name:'a_count',type:'Int',nullable:false}]});
  run = await runtime.run(source);
  assert.equal(run.status, 'complete', run.error);
  for (const [name, output] of run.outputs) assert.ok(output.value, `${name}: ${output.error}`);
  const total = runtime.read('total', source).value.data;
  assert.equal(typeof total, 'number');
  assert.ok((total as number) > 0);
  assert.equal(queries, 1);
  const originalBatch = run.batch;
  const answer = runtime.read('answer', source).value;
  assert.match(answer.sources[0].delivery!.html, /当前告警数/);
  const queryNode = Object.values(answer.sources[0].origin.nodes).find(node => node.kind === 'query')!;
  assert.equal((queryNode.source as {model:string}).model, entry.modelHash);
  assert.equal((queryNode.source as {dataFile:string}).dataFile, database);
  assert.equal(typeof (queryNode.source as {acquiredAt:string}).acquiredAt, 'string');
  run = await runtime.run(source.replace('当前告警数：', '当前告警总数：'));
  assert.equal(run.batch, originalBatch);
  assert.equal(queries, 1, '只改模板不重查');
  assert.match(runtime.read('answer', source).value.sources[0].delivery!.html, /当前告警总数/);
  run = await runtime.run(source, { refresh: true });
  assert.notEqual(run.batch, originalBatch);
  assert.equal(queries, 2);
  const invalid = source.replace('entity:"current_alarm"', 'entity:"nonexistent_rfc_0013_dataset"');
  run = await runtime.run(invalid, { refresh: true });
  assert.equal(run.status, 'invalid');
  assert.equal(queries, 2, '真实模型拒绝 Intent 时不访问 SQLite');
  assert.ok(run.errorSpan);
  assert.throws(() => runtime.read('facts', invalid), /invalid/);
  console.log(JSON.stringify({ ok: true, total, sqliteQueries: queries, wholeDocumentChecks: checks, model: entry.modelHash, sourceDataReadOnly: true }));
} finally {
  runtime.dispose(); runner.dispose(); executor.dispose(); jq.dispose(); rmSync(root, { recursive: true, force: true });
}
