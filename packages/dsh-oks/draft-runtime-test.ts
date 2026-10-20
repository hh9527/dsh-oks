import assert from 'node:assert/strict';
import { DraftRuntime } from './src/draft/runtime.ts';
import type { DraftBackend, CallContext, Computed } from './src/draft/runtime.ts';
import { appendNode } from './src/results.ts';

const counts = new Map<string, number>();
let model = 'model-1';
let preflightFailure = false;
let clock = 1000;
let gate: Promise<void> | undefined;
const backend: DraftBackend = {
  async preflight() { if (preflightFailure) throw new Error('static validation failed'); },
  environment(operator) { return operator === 'query' ? model : 'pure-v1'; },
  async execute(ctx) {
    counts.set(ctx.operator, (counts.get(ctx.operator) ?? 0) + 1);
    if (gate) await gate;
    if (ctx.operator === 'data') return { data: ctx.args[0].data };
    if (ctx.operator === 'context') return { data: { now: clock } };
    if (ctx.operator === 'query') return { data: { rows: [{ n: counts.get('query') }] }, evidence: { acquiredAt: clock, model } };
    if (ctx.operator === 'jq') {
      if (ctx.asset!.source.includes('fail')) throw new Error('runtime jq failure');
      return { data: (ctx.args[1]?.data as { value?: unknown } | undefined)?.value ?? null };
    }
    return { data: { rendered: ctx.args[1].data } };
  },
  assemble(ctx: CallContext, computed: Computed) {
    const sources = ctx.args.flatMap(arg => arg.sources);
    const inputs = Object.fromEntries(sources.map((source, i) => [String(i), source.origin.root]));
    const origin = appendNode(sources.map(source => source.origin), {
      kind: ctx.operator === 'query' ? 'query' : ctx.operator === 'data' ? 'input' : 'transform',
      motivation: ctx.statement.motivation,
      source: computed.evidence,
      inputs,
    }, computed.data);
    return { data: computed.data, sources: [{ origin, at: [], path: [] }] };
  },
};
const wrap = (pipeline: string, asset = '.value') => `## pipeline\n\`\`\`js\n${pipeline}\n\`\`\`\n## assets\n\`\`\`jq name="value.jq"\n${asset}\n\`\`\``;
const runtime = new DraftRuntime(backend, { now: () => clock, retentionMs: 10000 });
const source = wrap('let facts = query({limit: 1}); let summary = jq("value.jq", {value: facts.rows[0].n}); debug(summary);');
let run = await runtime.run(source);
assert.equal(run.status, 'complete');
assert.equal(run.outputs.get('facts')!.status, 'executed');
assert.equal(run.outputs.get('summary')!.value!.data, 1);
assert.equal(runtime.read('debug/1', source).value.data, 1);
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
assert.equal(counts.get('query'), 1);
assert.equal(counts.get('jq'), 1);
assert.equal(run.outputs.get('facts')!.status, 'cached');
assert.equal(run.outputs.get('summary')!.status, 'cached');
assert.equal(run.acquisitions[0].reason, 'reused');
assert.equal(run.acquisitions[0].acquiredAt, firstAcquisition.acquiredAt);
assert.equal(run.acquisitions[0].fromRun, firstAcquisition.fromRun);
const moved = source.replaceAll('facts', 'renamed').replaceAll('value.jq', 'renamed.jq');
run = await runtime.run(moved);
assert.equal(counts.get('query'), 1);
assert.equal(counts.get('jq'), 1);
assert.equal(runtime.read('renamed', moved).value.data !== undefined, true);
assert.throws(() => runtime.read('facts', moved), /not defined/);
run = await runtime.run(source, { refresh: true });
assert.notEqual(run.batch, batch);
assert.equal(run.acquisitions[0].reason, 'refresh');
assert.equal(run.acquisitions[0].fromRun, run.id);
assert.equal(counts.get('query'), 2);
assert.equal(run.outputs.get('summary')!.value!.data, 2);
model = 'model-2';
run = await runtime.run(source);
assert.equal(run.acquisitions[0].reason, 'environment-changed');
assert.equal(counts.get('query'), 3, '模型变化使查询失效');
const countBeforeInvalid = counts.get('query');
run = await runtime.run(source.replace('let facts', 'const facts'));
assert.equal(run.status, 'invalid');
assert.equal(counts.get('query'), countBeforeInvalid);
assert.throws(() => runtime.read('summary', source), /invalid/);
preflightFailure = true;
assert.equal((await runtime.run(source)).status, 'invalid');
assert.equal(counts.get('query'), countBeforeInvalid);
preflightFailure = false;
const failed = wrap('let bad = jq("value.jq", {}); let blocked = data(bad); let good = data(3); debug(good);', 'fail');
run = await runtime.run(failed);
assert.equal(run.outputs.get('bad')!.status, 'failed');
assert.equal(run.outputs.get('blocked')!.status, 'blocked');
assert.equal(run.outputs.get('good')!.value!.data, 3);
assert.throws(() => runtime.read('bad', failed), /failed/);
assert.throws(() => runtime.read('blocked', failed), /blocked/);
const failureCount = counts.get('jq')!;
await runtime.run(failed);
assert.equal(counts.get('jq'), failureCount + 1, '运行失败不产生成功缓存');
const projection = wrap('let a = data({nested: {n: 7}, other: 1}); let b = jq("value.jq", {value: a.nested.n});');
await runtime.run(projection);
const beforeProject = counts.get('jq');
await runtime.run(projection.replace('other: 1', 'other: 2'));
assert.equal(counts.get('jq'), beforeProject, '未选中的字段变化不重算纯计算');
const badProjection = wrap('let a = data({rows: [1]}); debug(a.rows[2]); debug(a.toString); debug(a.rows["0"]);');
run = await runtime.run(badProjection);
for (const name of ['debug/1', 'debug/2', 'debug/3']) assert.equal(run.outputs.get(name)!.status, 'failed');

// Same bytes and program, different true input origin: calculation can hit; lineage must change.
const originA = wrap('// Source A\nlet a = data(7); let result = jq("value.jq", {value: a});');
const originB = originA.replace('Source A', 'Source B');
await runtime.run(originA);
const valueA = runtime.read('result', originA).value;
const beforeOrigin = counts.get('jq');
await runtime.run(originB);
const valueB = runtime.read('result', originB).value;
assert.equal(counts.get('jq'), beforeOrigin);
assert.notEqual(valueA.sources[0].origin.root, valueB.sources[0].origin.root);
assert.ok(Object.values(valueB.sources[0].origin.nodes).some(node => node.motivation === 'Source B'));
assert.ok(!Object.values(valueB.sources[0].origin.nodes).some(node => node.motivation === 'Source A'));
(valueB.data as unknown) = 999;
assert.equal(runtime.read('result', originB).value.data, 7, '读取不泄露可变运行状态');

let release!: () => void;
gate = new Promise<void>(resolve => { release = resolve; });
const inFlight = runtime.run(wrap('let a = data(1000);'));
await assert.rejects(runtime.run(source), /already running/);
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
const beforeExpiry = counts.get('query')!;
await runtime.run(source);
assert.equal(counts.get('query'), beforeExpiry + 1, '回收后运行可重新采集，读取不恢复');
runtime.dispose();
assert.throws(() => runtime.read('facts', source), /No retained/);

// A zero-capacity cache still permits successful runs without claiming reuse.
const uncached = new DraftRuntime(backend, { maxCacheEntries: 0 });
await uncached.run(source);
const noCacheCount = counts.get('query')!;
const uncachedAgain = await uncached.run(source);
assert.equal(uncachedAgain.acquisitions[0].reason, 'cache-reclaimed');
assert.equal(counts.get('query'), noCacheCount + 1);
uncached.dispose();
console.log('draft runtime: batches, current provenance, failures, projections, cancellation and readonly lifecycle passed');

const bounded = new DraftRuntime(backend, { maxCacheBytes: 100, maxOutputBytes: 0 });
const boundedRun = await bounded.run(wrap('let large = data("payload"); let dependent = data(large);'));
assert.equal(boundedRun.outputs.get('large')!.status, 'failed');
assert.match(boundedRun.outputs.get('large')!.error!, /storage budget/);
assert.equal(boundedRun.outputs.get('dependent')!.status, 'blocked');
assert.throws(() => bounded.read('large', ''), /failed/);
bounded.dispose();
assert.throws(() => new DraftRuntime(backend, { maxCacheEntries: NaN }), /Invalid/);
console.log('draft runtime: retained-output budget enforced without partial successful outputs');
