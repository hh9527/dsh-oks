import { parseDraft } from './src/draft/document.ts';
import { parseMarkdownFixture } from './test-markdown.ts';
import assert from 'node:assert/strict';
import { DraftRuntime } from './src/draft/runtime.ts';
class FixtureRuntime extends DraftRuntime { constructor(backend:ConstructorParameters<typeof DraftRuntime>[0], options:ConstructorParameters<typeof DraftRuntime>[1]={}) { super(backend,{...options,parse:(source,file)=>source.trimStart().startsWith('<Dari')?parseDraft(source,file):parseMarkdownFixture(source)}); } }
import type { DraftBackend, CallContext, Computed } from './src/draft/runtime.ts';
import { appendNode } from './src/results.ts';

const counts = new Map<string, number>();
let model = 'model-1';
let preflightFailure = false;
let clock = 1000;
let gate: Promise<void> | undefined;
const backend: DraftBackend = {
  async preflight() { if (preflightFailure) throw new Error('static validation failed'); },
  environment(operator) { return operator === 'exec_query' ? model : 'pure-v1'; },
  async execute(ctx) {
    counts.set(ctx.operator, (counts.get(ctx.operator) ?? 0) + 1);
    if (gate) await gate;
    if (ctx.operator === 'data') return { data: ctx.args[0].data };
    if (ctx.operator === 'context') return { data: { now: clock } };
    if (ctx.operator === 'exec_query') return { data: { rows: [{ n: counts.get('exec_query') }] }, evidence: { acquiredAt: clock, model } };
    if (ctx.operator === 'sql') {
      if (ctx.asset!.source.includes('fail')) throw new Error('runtime sql failure');
      return { data: (ctx.args[1]?.data as { value?: unknown } | undefined)?.value ?? null };
    }
    return { data: { rendered: ctx.args[1].data } };
  },
  assemble(ctx: CallContext, computed: Computed) {
    const sources = ctx.args.flatMap(arg => arg.sources);
    const inputs = Object.fromEntries(sources.map((source, i) => [String(i), source.origin.root]));
    const origin = appendNode(sources.map(source => source.origin), {
      kind: ctx.operator === 'exec_query' ? 'exec_query' : ctx.operator === 'data' ? 'input' : 'transform',
      motivation: ctx.statement.motivation,
      source: computed.evidence,
      inputs,
    }, computed.data);
    return { data: computed.data, sources: [{ origin, at: [], path: [] }] };
  },
};
const wrap = (pipeline: string, asset = '.value') => `## pipeline\n\`\`\`js\n${pipeline}\n\`\`\`\n## assets\n\`\`\`sql name="value.sql"\n${asset}\n\`\`\``;
const runtime = new FixtureRuntime(backend, { now: () => clock, retentionMs: 10000 });
const source = wrap('facts <- exec_query({limit: 1}); summary <- sql("value.sql", {value: facts.rows[0].n}); peek <- summary;');
let run = await runtime.run(source);
assert.equal(run.status, 'complete');
assert.equal(run.outputs.get('facts')!.status, 'executed');
assert.equal(run.outputs.get('summary')!.value!.data, 1);
assert.equal(runtime.read('peek', source).value.data, 1);
assert.equal(runtime.read('summary', source + '\n').stale, true);
const batch = run.batch;
const firstAcquisition = run.acquisitions[0];
assert.equal(firstAcquisition.reason, 'no-retained-acquisition');
assert.equal(firstAcquisition.fromRun, run.id);
assert.equal(firstAcquisition.fromBatch, batch);
assert.ok(Number.isFinite(Date.parse(firstAcquisition.acquiredAt)));
clock++;
run = await runtime.run(source);
assert.equal(run.batch, batch);
assert.equal(counts.get('exec_query'), 1);
assert.equal(counts.get('sql'), 1);
assert.equal(run.outputs.get('facts')!.status, 'cached');
assert.equal(run.outputs.get('summary')!.status, 'cached');
assert.equal(run.acquisitions[0].reason, 'reused');
assert.equal(run.acquisitions[0].acquiredAt, firstAcquisition.acquiredAt);
assert.equal(run.acquisitions[0].fromRun, firstAcquisition.fromRun);
const moved = source.replaceAll('facts', 'renamed').replaceAll('value.sql', 'renamed.sql');
run = await runtime.run(moved);
assert.equal(counts.get('exec_query'), 1);
assert.equal(counts.get('sql'), 1);
assert.equal(runtime.read('renamed', moved).value.data !== undefined, true);
assert.throws(() => runtime.read('facts', moved), /not defined/);
run = await runtime.run(source, { refresh: true });
assert.notEqual(run.batch, batch);
assert.equal(run.acquisitions[0].reason, 'refresh');
assert.equal(run.acquisitions[0].fromRun, run.id);
assert.equal(counts.get('exec_query'), 2);
assert.equal(run.outputs.get('summary')!.value!.data, 2);
model = 'model-2';
run = await runtime.run(source);
assert.equal(run.acquisitions[0].reason, 'environment-changed');
assert.equal(counts.get('exec_query'), 3, '模型变化使查询失效');
const countBeforeInvalid = counts.get('exec_query');
run = await runtime.run(source.replace('facts <-', 'let facts ='));
assert.equal(run.status, 'invalid');
assert.equal(counts.get('exec_query'), countBeforeInvalid);
assert.throws(() => runtime.read('summary', source), /invalid/);
preflightFailure = true;
assert.equal((await runtime.run(source)).status, 'invalid');
assert.equal(counts.get('exec_query'), countBeforeInvalid);
preflightFailure = false;
const failed = wrap('bad <- sql("value.sql", {}); blocked <- data(bad); good <- data(3); peek <- good;', 'fail');
run = await runtime.run(failed);
assert.equal(run.outputs.get('bad')!.status, 'failed');
assert.equal(run.outputs.get('blocked')!.status, 'blocked');
assert.equal(run.outputs.get('good')!.value!.data, 3);
assert.throws(() => runtime.read('bad', failed), /failed/);
assert.throws(() => runtime.read('blocked', failed), /blocked/);
const failureCount = counts.get('sql')!;
await runtime.run(failed);
assert.equal(counts.get('sql'), failureCount + 1, '运行失败不产生成功缓存');
const projection = wrap('a <- data({nested: {n: 7}, other: 1}); b <- sql("value.sql", {value: a.nested.n});');
await runtime.run(projection);
const beforeProject = counts.get('sql');
await runtime.run(projection.replace('other: 1', 'other: 2'));
assert.equal(counts.get('sql'), beforeProject, '未选中的字段变化不重算纯计算');
const badProjection = wrap('a <- data({rows: [1]}); peek <- a.rows[2]; peek2 <- a.toString; peek3 <- a.rows["0"];');
run = await runtime.run(badProjection);
for (const name of ['peek', 'peek2', 'peek3']) assert.equal(run.outputs.get(name)!.status, 'failed');

// Same bytes and program, different true input origin: calculation can hit; lineage must change.
const originA = wrap('// Source A\na <- data(7); result <- sql("value.sql", {value: a});');
const originB = originA.replace('Source A', 'Source B');
await runtime.run(originA);
const valueA = runtime.read('result', originA).value;
const beforeOrigin = counts.get('sql');
await runtime.run(originB);
const valueB = runtime.read('result', originB).value;
assert.equal(counts.get('sql'), beforeOrigin);
assert.notEqual(valueA.sources[0].origin.root, valueB.sources[0].origin.root);
assert.ok(Object.values(valueB.sources[0].origin.nodes).some(node => node.motivation === 'Source B'));
assert.ok(!Object.values(valueB.sources[0].origin.nodes).some(node => node.motivation === 'Source A'));
(valueB.data as unknown) = 999;
assert.equal(runtime.read('result', originB).value.data, 7, '读取不泄露可变运行状态');

let release!: () => void;
gate = new Promise<void>(resolve => { release = resolve; });
const inFlight = runtime.run(wrap('a <- data(1000);'));
await assert.rejects(runtime.run(source), /already running/);
assert.throws(()=>runtime.renew(),/already running/);
assert.throws(() => runtime.read('result', source), /running/);
release();
await inFlight;
gate = undefined;
const controller = new AbortController();
controller.abort();
assert.equal((await runtime.run(source, { signal: controller.signal })).status, 'cancelled');
assert.throws(() => runtime.read('summary', source), /not defined/);
clock += 10001;
assert.throws(() => runtime.read('a', source), /No retained/);
const beforeExpiry = counts.get('exec_query')!;
run=await runtime.run(source);
assert.equal(run.outputs.get('facts')!.status,'failed');
assert.match(run.outputs.get('facts')!.error!,/snapshot was reclaimed/);
assert.equal(counts.get('exec_query'),beforeExpiry);
runtime.renew();
await runtime.run(source);
assert.equal(counts.get('exec_query'),beforeExpiry+1);
runtime.dispose();
assert.throws(() => runtime.read('facts', source), /No retained/);

// A reclaimed acquisition requires explicit renewal instead of silently rereading data.
const uncached = new FixtureRuntime(backend, { maxCacheEntries: 0 });
await uncached.run(source);
const noCacheCount = counts.get('exec_query')!;
const uncachedAgain = await uncached.run(source);
assert.equal(uncachedAgain.outputs.get('facts')!.status,'failed');
assert.equal(counts.get('exec_query'),noCacheCount);
uncached.renew();
await uncached.run(source);
assert.equal(counts.get('exec_query'),noCacheCount+1);
uncached.dispose();
console.log('draft runtime: batches, current provenance, failures, projections, cancellation and readonly lifecycle passed');

const bounded = new FixtureRuntime(backend, { maxCacheBytes: 100, maxOutputBytes: 0 });
const boundedRun = await bounded.run(wrap('large <- data("payload"); dependent <- data(large);'));
assert.equal(boundedRun.outputs.get('large')!.status, 'failed');
assert.match(boundedRun.outputs.get('large')!.error!, /storage budget/);
assert.equal(boundedRun.outputs.get('dependent')!.status, 'blocked');
assert.throws(() => bounded.read('large', ''), /failed/);
bounded.dispose();
assert.throws(() => new FixtureRuntime(backend, { maxCacheEntries: NaN }), /Invalid/);
console.log('draft runtime: retained-output budget enforced without partial successful outputs');
