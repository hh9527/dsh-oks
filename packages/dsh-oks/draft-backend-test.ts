import { parseDraft } from './src/draft/document.ts';
import { parseMarkdownFixture } from './test-markdown.ts';
import assert from 'node:assert/strict';
import { createJaqEngine } from './src/jaq.ts';
import { createDraftBackend } from './src/draft/backend.ts';
import { DraftRuntime } from './src/draft/runtime.ts';
class FixtureRuntime extends DraftRuntime { constructor(backend:ConstructorParameters<typeof DraftRuntime>[0], options:ConstructorParameters<typeof DraftRuntime>[1]={}) { super(backend,{...options,parse:(source,file)=>source.trimStart().startsWith('<Dari')?parseDraft(source,file):parseMarkdownFixture(source)}); } }
import type { WorkspaceEntry } from './src/knowledge.ts';
import type { ContextTimeZone } from './src/time.ts';
import { checkWellFormed } from './src/report/xhtml.ts';

const wasm = process.argv[2];
assert.ok(wasm, '需要隔离引擎路径');
const jq = createJaqEngine(wasm);
let executions = 0;
let validations = 0;
let checks = 0;
const entry = {
  modelHash: 'model-sha', settings: { domain: 'test', dataFile: '/tmp/fixture.sqlite', queryMaxRows: 200 },
  runner: { async send(_method: string, { intents }: { intents: unknown[] }) { validations++; return { ok: { accepted: true, queries: intents.map((intent) => ({ sql: 'SELECT n FROM fixture LIMIT ?1', bindings: [(intent as {limit:number}).limit], limit_slot: 0, columns:[{name:'n',type:'Int',nullable:false}] })) } }; } },
} as unknown as WorkspaceEntry;
const backend = createDraftBackend({ entry, file: '.work/draft.md', contextZone: () => ({ kind: 'resolved', timeZone: 'Asia/Shanghai' } satisfies ContextTimeZone),
  knowledge: { executorFor: () => ({ manifest: null, executor: { async send() { executions++; return { rows: [{ n: 42 }], columns: ['n'], truncated: false }; }, dispose() {} } }) },
  jq: { run: jq.run, check: async (...args) => { checks++; return jq.check(...args); } },
});
const runtime = new FixtureRuntime(backend);
const source = [
  '# Example', '## pipeline', '```js',
  'facts <- exec_query(query({op: "Graph", limit: 5}));',
  'summary <- jq("summary.jq", { facts });',
  'chart <- render_figure({kind: "column", x: "label", value: "n"}, {data: summary.rows});',
  'table <- render_figure({kind: "table", columns: ["label", "n"]}, {data: summary.rows});',
  'peek <- summary;',
  'answer <- render_html("answer.xhtml", {summary, chart, table});', '```',
  '## assets', '```jq name="summary.jq"', '{rows: [.facts.rows[] | {label: "observed", n}], total: (.facts.rows | map(.n) | add)}', '```',
  '```xhtml name="answer.xhtml"', '<article><h1>Observed</h1><p>Total: <span data-oks-ref="summary" data-oks-pick=".total" /></p><figure data-oks-ref="chart"><figcaption>Values</figcaption></figure><figure data-oks-ref="table"><figcaption>Rows</figcaption></figure></article>', '```',
].join('\n');
try {
  let run = await runtime.run(source);
  assert.equal(run.status, 'complete', run.error);
  for (const [name, output] of run.outputs) assert.ok(output.value, `${name}: ${output.error}`);
  const firstCapture = run.acquisitions[0];
  assert.equal(firstCapture.operator, 'exec_query');
  assert.equal(firstCapture.acquiredAt, (Object.values(runtime.read('facts', source).value.sources[0].origin.nodes).find(node => node.kind === 'query')!.source as {acquiredAt:string}).acquiredAt);
  assert.equal(executions, 1);
  assert.equal(validations, 1);
  const answer = runtime.read('answer', source).value;
  const html = answer.sources[0].delivery!.html;
  assert.match(html, /Total:/);
  assert.match(html, />42<\/span>/);
  assert.match(html, /<svg/);
  assert.match(html, /<table>/);
  assert.ok(Object.values(answer.sources[0].origin.nodes).some(node=>node.snipFile?.endsWith('#summary.jq')));
  assert.equal(checkWellFormed(html).length, 0);
  const node = answer.sources[0].origin.nodes[answer.sources[0].origin.root];
  assert.equal((node.spec as { xhtml: string }).xhtml.includes('<article>'), true);
  assert.equal(node.draft!.hash, run.sourceHash);
  const summary = runtime.read('summary', source).value;
  const jqNode = summary.sources[0].origin.nodes[summary.sources[0].origin.root];
  assert.equal(jqNode.snip!.startsWith('{rows:'), true);
  assert.deepEqual(Object.keys(jqNode.inputs!), ['facts']);
  assert.ok(Object.values(summary.sources[0].origin.nodes).some(node => node.kind === 'query' && (node.source as {model:string}).model === entry.modelHash));
  const checkCount = checks;
  run = await runtime.run(source);
  assert.equal(executions, 1);
  assert.equal(validations, 1);
  assert.equal(checks, checkCount, 'asset 合法性检查由校验层缓存');
  assert.equal(run.outputs.get('answer')!.status, 'cached');
  assert.equal(runtime.read('answer', source).value.sources[0].origin.nodes[runtime.read('answer', source).value.sources[0].origin.root].draft!.hash, run.sourceHash);
  await runtime.run(source, { refresh: true });
  assert.equal(executions, 2);
  assert.equal(validations, 1);

  // A referenced jq syntax failure must prevent a fresh business acquisition.
  const invalid = source.replace('{rows: [.facts.rows[]', '{rows: [INVALID_FUNCTION[]');
  const previousExec = executions;
  run = await runtime.run(invalid, { refresh: true });
  assert.equal(run.status, 'invalid');
  assert.equal(executions, previousExec);
  assert.ok(run.errorSpan);
  const beforeInvalidCheck = checks;
  run = await runtime.run('\n\n' + invalid);
  assert.equal(checks, beforeInvalidCheck, '确定性错误缓存');
  assert.ok(run.errorSpan!.start.line > 2, '错误关联本轮原始 Markdown');
  assert.throws(() => runtime.read('summary', invalid), /invalid/);
  run = await runtime.run(source.replace('{summary, chart, table}', '{summary, chart}'));
  assert.equal(run.status, 'invalid');
  assert.match(run.error!, /bindings mismatch/);
  assert.equal(executions, previousExec);
  run = await runtime.run(source.replace('kind: "column"', 'kind: "unknown"'));
  assert.equal(run.status, 'invalid');
  assert.equal(executions, previousExec);
  run = await runtime.run(source.replace('jq("summary.jq", { facts })', 'jq("summary.jq", [])'));
  assert.equal(run.status, 'invalid');
  assert.equal(executions, previousExec, '静态算子输入类型错误在新查询前返回');
  const timeSource = '## pipeline\n```js\nctx <- context(); peek <- ctx.utc.epochSeconds;\n```';
  run = await runtime.run(timeSource);
  assert.equal(run.outputs.get('ctx')!.status, 'executed');
  const time = runtime.read('ctx', timeSource).value.data as {utc:{epochMillis:number;epochSeconds:number;rfc3339:string}};
  assert.equal(time.utc.epochSeconds, Math.floor(time.utc.epochMillis / 1000));
  assert.equal(Date.parse(time.utc.rfc3339), time.utc.epochMillis);
  run = await runtime.run(timeSource);
  assert.equal(run.outputs.get('ctx')!.status, 'cached');
  assert.deepEqual(runtime.read('ctx', timeSource).value.data, time);
  // Calendar boundaries use the explicit context, retain readable instants and provenance.
  const windowsSource = '## pipeline\n```js\nctx <-data({utc:{epochMillis:1790854863000},tz:{client:{id:"Asia/Shanghai"}}}); months <-time_windows(ctx,{unit:"month",count:2,mode:"complete"}); peek <- months;\n```';
  run = await runtime.run(windowsSource);
  assert.equal(run.status, 'complete', run.error);
  const windowsValue = runtime.read('months', windowsSource).value;
  const windows = windowsValue.data as {label:string;start:{epochMillis:number;rfc3339:string};end:{epochMillis:number;rfc3339:string}}[];
  assert.deepEqual(windows.map(w => w.label), ['2026-08', '2026-09']);
  assert.equal(windows[1].end.rfc3339, '2026-10-01T00:00:00+08:00');
  for (const window of windows) {
    assert.equal(Date.parse(window.start.rfc3339), window.start.epochMillis);
    assert.equal(Date.parse(window.end.rfc3339), window.end.epochMillis);
  }
  const windowsNode = windowsValue.sources[0].origin.nodes[windowsValue.sources[0].origin.root];
  assert.equal(windowsNode.snipFile, 'builtin://time/windows.jq');
  assert.match(windowsNode.snip!, /tzfloor/);
  assert.deepEqual(Object.keys(windowsNode.inputs!), ['ctx']);
  run = await runtime.run(windowsSource);
  assert.equal(run.outputs.get('months')!.status, 'cached');
  const beforeInvalidWindows = executions;
  run = await runtime.run(source.replace('peek <- summary;', 'bad <-time_windows({}, {unit:"month",count:0,mode:"complete"});'), {refresh:true});
  assert.equal(run.status, 'invalid');
  assert.equal(executions, beforeInvalidWindows, '非法静态窗口参数阻止新查询');
  console.log('draft backend: real jq, figures, XHTML, static gating, cache and provenance passed');
} finally { runtime.dispose(); jq.dispose(); }
