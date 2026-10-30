import assert from 'node:assert/strict';
import { createSelector } from './src/select.ts';
import { knowledgeBranches, renderKnowledgeHelp, installKnowledgeNavigation } from './src/knowledge-navigation.ts';
import { createTools } from './src/tools.ts';
import { helpFiles } from './src/help-files.ts';
import type { Knowledge, WorkspaceEntry } from './src/knowledge.ts';
import type { PluginContext, ToolExec, PromptAssembly, AgentLike } from './src/host.ts';

const graphs = {
  alpha: Object.freeze({ entities: { a: {}, b: {} }, datasets: {}, experimental_branch: { new: {} }, 'odd.key': { x: {} }, scalar: 42, empty: null, items: [] }),
  beta: Object.freeze({ datasets: { only: {} }, items: [{ key: 'datasets/only', names: [], doc: '' }] }),
};
const original = JSON.stringify(graphs);
const branches = knowledgeBranches(graphs.alpha);
assert.deepEqual(branches.map(b => b.key), Object.keys(graphs.alpha));
assert.equal(branches.find(b => b.key === 'entities')?.count, 2);
assert.equal(branches.find(b => b.key === 'datasets')?.count, 0);
assert.equal(branches.find(b => b.key === 'items')?.shape, 'array');
assert.equal(branches.find(b => b.key === 'empty')?.shape, 'null');
assert.equal(branches.find(b => b.key === 'scalar')?.shape, 'number');
assert.equal(branches.find(b => b.key === 'experimental_branch')?.meaning, undefined);
for (const b of branches) createSelector(b.select)(graphs.alpha);

let loads = 0;
const logs: string[] = [];
const knowledge = {
  ensureWorkspace(exec: ToolExec) {
    loads++;
    const domain = exec.agent?.session?.header?.cwd;
    if (domain !== 'alpha' && domain !== 'beta') throw new Error('model unavailable');
    return { root: domain, settings: { domain } } as WorkspaceEntry;
  },
  async ensureIndex(entry: WorkspaceEntry) { return { knowledge: graphs[entry.root as keyof typeof graphs] }; },
} as unknown as Knowledge;
let assemble: ((assembly: PromptAssembly, context: { agent?: AgentLike; signal?: AbortSignal }, next: () => Promise<PromptAssembly>) => Promise<PromptAssembly>) | undefined;
const disposers: (() => void)[] = [];
const ctx = { systemPrompt: {}, on(name: string, handler: typeof assemble) { assert.equal(name, 'system-prompt/assemble'); assemble = handler; return () => {}; }, effect(fn: () => () => void) { disposers.push(fn()); } } as unknown as PluginContext;
installKnowledgeNavigation({ ctx, knowledge, log: text => logs.push(text) });
const exec = (domain: string) => ({ agent: { session: { header: { cwd: domain } } } }) as ToolExec;
const base = { sections: [{ name: 'original', text: 'preserve' }, { name: 'oks:knowledge-navigation', text: 'stale' }] };
const summary = (text: string) => JSON.parse(text.match(/```json\n([\s\S]*?)\n```/)![1]);
const resultA = await assemble!(base, exec('alpha'), async () => base);
const resultB = await assemble!(base, exec('beta'), async () => base);
assert.equal(resultA.sections.length, 2);
assert.equal(resultA.sections[0].text, 'preserve');
assert(resultA.sections[1].text.includes('领域：` alpha `'));
assert(resultA.sections[1].text.includes('- ` a `'));
assert(!resultA.sections[1].text.includes('oks_project'));
assert(resultB.sections[1].text.includes('领域：` beta `'));
assert(resultB.sections[1].text.includes('- ` only `'));
assert.equal(resultA.sections[1].interpolate, false);
assert.equal(base.sections[1].text, 'stale', 'No process-wide prompt mutation');
const missing = await assemble!(base, exec('missing'), async () => base);
assert.deepEqual(missing.sections, [base.sections[0]], 'Failure does not preserve another model’s navigation');
const before = loads;
await assemble!(base, {}, async () => base);
assert.equal(loads, before, 'Diagnostic assembly does not load a workspace');
const abort = new AbortController(); abort.abort();
await assert.rejects(assemble!(base, { ...exec('alpha'), signal: abort.signal }, async () => base), /abort/i);
const tools = createTools({ knowledge, log: text => logs.push(text), config: {}, va: { ask: async () => { throw new Error('unused'); } }, timeContext: { zones: new Map(), install() {} } });
const tool = (name: string) => tools.find(t => t.name === name)!;
try {
  const read = await tool('oks_read').execute({ path: 'oks://help/knowledge.md' } as never, exec('alpha')) as { lines: { text: string }[] };
  const text = read.lines.map(line => line.text).join('\n');
  assert.deepEqual(summary(text).map((b: { key: string }) => b.key), Object.keys(graphs.alpha));
  const listed = await tool('oks_list').execute({ path: 'oks://help/' } as never, exec('alpha')) as { files: { name: string; bytes: number }[] };
  assert.equal(listed.files.find(f => f.name === 'oks://help/knowledge.md')?.bytes, Buffer.byteLength(renderKnowledgeHelp(helpFiles['oks://help/knowledge.md'], graphs.alpha, 'alpha')));
  const second = await tool('oks_read').execute({ path: 'oks://help/knowledge.md' } as never, exec('beta')) as { lines: { text: string }[] };
  assert.deepEqual(summary(second.lines.map(line => line.text).join('\n')).map((b: { key: string }) => b.key), Object.keys(graphs.beta));
  const fallback = await tool('oks_read').execute({ path: 'oks://help/knowledge.md' } as never, exec('missing')) as { lines: { text: string }[] };
  assert(!fallback.lines.some(line => line.text.includes('domain="alpha"')));
  assert(logs.some(line => line.includes('unavailable')));
  assert.equal(JSON.stringify(graphs), original, 'Navigation does not modify knowledge facts');
  console.log('Adaptive navigation: unknown/empty roots, selectors, session isolation, cancellation, dynamic help and exact listing sizes passed');
} finally { tools.dispose(); disposers.forEach(fn => fn()); }
