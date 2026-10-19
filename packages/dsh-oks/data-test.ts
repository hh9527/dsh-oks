// 工具边界单元检查：临时工作区与固定知识夹具，使用现有 WASM，无领域模型或服务依赖。
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJaqEngine } from './src/jaq.ts';
import { saveInputData } from './src/results.ts';
import { readReportPage } from './src/report/page.ts';
import { withOutputLimit } from './src/payload.ts';
import type { Knowledge, WorkspaceEntry } from './src/knowledge.ts';
import type { ToolExec } from './src/host.ts';

// 源码的文本资源与打包产物采用相同的字符串导入语义。
const textImports = registerHooks({
  load(url, context, nextLoad) {
    return url.endsWith('.md')
      ? { format: 'module', source: `export default ${JSON.stringify(readFileSync(new URL(url), 'utf8'))}`, shortCircuit: true }
      : nextLoad(url, context);
  },
});
const { createTools } = await import('./src/tools.ts');
textImports.deregister();

const root = mkdtempSync(join(tmpdir(), 'oks-data-test-'));
const engine = createJaqEngine(fileURLToPath(new URL('./lib/oks-wti.wasm', import.meta.url)));
const document = { guide: { label: '入口' } };
const entry = { settings: { workspaceRoot: root, domain: 'test', queryTimeoutMs: 5000,
  retention: { auto: { materials: 60, artifacts: 60, work: null } } }, modelHash: 'fixture' } as WorkspaceEntry;
let loads = 0;
let beforeLoad = () => {};
const knowledge = {
  ensureWorkspace: () => entry,
  ensureIndex: async () => {
    loads++;
    beforeLoad();
    return { revision: 'test', knowledge: document };
  },
  queryKnowledge: (_entry, program, options) => engine.runDocument(program, document, options),
} as Knowledge;
const logs: string[] = [];
const tools = createTools({
  knowledge, log: (line) => logs.push(line), config: undefined,
  va: { ask: async () => { throw new Error('本测试仅调用数据工具'); } },
  timeContext: { zones: new Map(), install() {} },
}).map(withOutputLimit);
const tool = tools.find(tool => tool.name === 'oks_data')!;
const callTool = (name: string, args: unknown) => tools.find(tool => tool.name === name)!
  .execute(args as never, {} as ToolExec) as Promise<any>;
const call = (args: unknown) => callTool('oks_data', args);
const render = (args: unknown, value: unknown) => tool.output.render(args as never, value as never)
  .map(block => (block as { text: string }).text).join('');
const load = { knowledge: 'knowledge://' };
const program = (name: string, code: string) => {
  const src = `.work/${name}.jq`;
  writeFileSync(join(root, src), code);
  return { src };
};
try {
  mkdirSync(join(root, '.work'));
  // 即使知识加载本身会失败，程序文件错误也先于它报告。
  beforeLoad = () => { throw new Error('知识加载失败'); };
  for (const save of [undefined, { name: 'missing', motivation: '缺失程序检查' }]) {
    await assert.rejects(call({ load, jq: { src: '.work/missing.jq' }, ...(save ? { save } : {}) }),
      /读不到 \.work\/missing.jq/);
  }
  await assert.rejects(call({ load, jq: { src: '.work/program.txt' } }), /以 \.jq 结尾/);
  await assert.rejects(call({ load, jq: { src: '../outside.jq' } }), /完整文件路径/);
  assert.equal(loads, 0);
  beforeLoad = () => {};

  assert.deepEqual(await call({ load }), { ok: true, execution: { method: 'identity' }, data: { knowledge: document } });
  assert.deepEqual(await call({ load, project: { knowledge: { guide: 'Value' } } }),
    { ok: true, execution: { method: 'project' }, data: { knowledge: { guide: document.guide } } });
  assert.deepEqual(await call({}), { ok: true, execution: { method: 'identity' }, data: {} });

  // 加载期间文件被改写时，本次仍执行已读取的源码。
  const jq = program('frozen', 'null');
  beforeLoad = () => writeFileSync(join(root, jq.src), '"later version"');
  const value = await call({ load, jq });
  assert.deepEqual(value, { ok: true, execution: { method: 'jq', src: jq.src }, data: null });
  assert.match(render({ load, jq }, value), /"src": "\.work\/frozen.jq"/);
  beforeLoad = () => {};
  await assert.rejects(call({ load, jq: program('broken', '. |') }), /broken\.jq/);
  assert.deepEqual((await call({ load, jq: program('named_root', 'keys') })).data, ['knowledge']);
  const iterated = await call({ load, jq: program('bound_root',
    '. as $in | [$in.knowledge.guide | {label: .label, outer: $in.knowledge.guide.label}]') });
  assert.deepEqual(iterated.data, [{ label: '入口', outer: '入口' }]);

  const save = { name: 'large', motivation: '超限失败必须可见' };
  const args = { load, jq: program('large', '[range(100000)]'), save };
  const error = await call(args);
  assert.equal(error.ok, false);
  assert.equal(error.error.code, 'evaluation_truncated');
  assert.deepEqual(error.shape, { type: 'array', size: 100000 });
  assert.deepEqual(JSON.parse(render(args, error)), error);
  assert.equal(readdirSync(root).includes('.oks'), false, '失败不创建保存目录或文件');

  const successful = { load, jq: program('saved', '.knowledge.guide'), save: { name: 'saved', motivation: '保存执行来源' } };
  const stored = await call(successful);
  assert.deepEqual(stored.execution, { method: 'jq', src: successful.jq.src });
  assert.match(render(successful, stored), /execution: jq · \.work\/saved.jq/);
  const product = JSON.parse(readFileSync(join(root, stored.asset), 'utf8'));
  assert.deepEqual(product.data, document.guide);
  assert.equal(product.origin.nodes[product.origin.root].method, 'jq');
  assert.equal(product.origin.nodes[product.origin.root].snipFile, successful.jq.src);
  assert.equal(product.origin.nodes[product.origin.root].snip, '.knowledge.guide');
  for (const method of ['identity', 'project', 'jq']) assert.ok(logs.some(line => line.includes(`oks_data · ${method}`)));
  assert.ok(logs.some(line => line.includes('jq .work/frozen.jq')));
  console.log('✓ oks_data 提前校验与固定程序、执行回执、合法 null、保存超限诊断及来源链');

  // 业务数据在 execute 中完整保留，进入上下文的最终回执才应用 16 KiB 预算。
  const manyRows = Array.from({ length: 104 }, (_, i) => ({ tenant: `tenant_${i}`, count: i, label: 'x'.repeat(80) }));
  const first = saveInputData({ root, name: 'large_first', motivation: '容量诊断夹具', data: manyRows });
  const second = saveInputData({ root, name: 'small_second', motivation: '容量诊断夹具', data: [1, 2, 3, 4, 5] });
  const combinedArgs = { load: { fact: first.asset, summary: second.asset } };
  for (const args of [combinedArgs, { ...combinedArgs, project: { fact: 'Value', summary: 'Value' } },
    { load, jq: program('combined', JSON.stringify({ fact: manyRows, summary: [1, 2, 3, 4, 5] })) }]) {
    const value = await call(args);
    assert.equal(value.ok, true);
    const error = JSON.parse(render(args, value));
    assert.equal(error.error.code, 'payload_too_large');
    assert.deepEqual(error.shape.keys, ['fact', 'summary']);
    assert.equal(error.fields[0].key, 'fact');
    assert.deepEqual(error.fields[0].shape, { type: 'array', size: 104 });
  }
  const limitedArgs = { ...combinedArgs, project: { fact: ['TruncateThen', 1, 'Value'] } };
  assert.deepEqual(JSON.parse(render(limitedArgs, await call(limitedArgs))).data, { fact: manyRows.slice(0, 1) });
  const storedCombinedArgs = { ...combinedArgs, save: { name: 'combined', motivation: '保存大值但只返回落点' } };
  const storedCombined = await call(storedCombinedArgs);
  assert.match(render(storedCombinedArgs, storedCombined), /asset:/);
  assert.deepEqual(JSON.parse(readFileSync(join(root, storedCombined.asset), 'utf8')).data,
    { fact: manyRows, summary: [1, 2, 3, 4, 5] });
  console.log('✓ 恒等、project、jq 共用最终上下文预算，收窄查看与保存大值均正常');

  const payload = { rowCount: 1, rows: [{ name: 'A', count: 7 }] };
  const source = saveInputData({ root, name: 'report_source', motivation: '核对统一负荷视图', data: payload });
  const envelope = JSON.parse(readFileSync(join(root, source.asset), 'utf8'));
  const report = async (name: string, inputs: unknown, xhtml: string) => {
    writeFileSync(join(root, '.work/report.xhtml'), xhtml);
    return callTool('oks_render_report', { name, spec: { title: '负荷视图', articleFile: '.work/report.xhtml', inputs } });
  };
  const readReport = (asset: string) => {
    const result = readReportPage(readFileSync(join(root, asset), 'utf8'));
    assert.ok(!('error' in result));
    return result;
  };
  const countBody = '<article><p>总数 <span data-oks-ref="fact" data-oks-pick=".rowCount" /></p></article>';
  const visible = await call({ load: { fact: source.asset } });
  for (const [i, input] of [source.asset, { src: source.asset }, { src: source.asset, root: '.' }].entries()) {
    const rendered = await report(`payload_default_${i}`, { fact: input }, countBody);
    const page = readReport(rendered.asset);
    assert.deepEqual(page.items.fact, visible.data.fact, '报告和 load 默认暴露同一负荷');
    const node = page.origin.nodes[page.origin.root];
    assert.equal(node.inputPaths!.fact, '.data');
    assert.equal(node.inputs!.fact, envelope.origin.root);
    assert.deepEqual(page.origin.nodes[envelope.origin.root], envelope.origin.nodes[envelope.origin.root]);
    assert.match(readFileSync(join(root, rendered.asset), 'utf8'), />1<\/span>/);
  }
  const conclusion = '这是完整保留在最终报告中的结论内容，用于确认读取视图仅保留摘要而页面完整展示。';
  const summaryReport = await report('report_summary', { fact: source.asset },
    `<article><p>总数 <span data-oks-ref="fact" data-oks-pick=".rowCount" /></p>`
    + `<div data-oks-shrink=""><p>${conclusion}</p><p>下一条结论。</p></div></article>`);
  const finalHtml = readFileSync(join(root, summaryReport.asset), 'utf8');
  assert.ok(finalHtml.includes(`<p>${conclusion}</p><p>下一条结论。</p>`), '最终页面完整显示结论');
  assert.match(finalHtml, />1<\/span>/);
  const summaryView = await call({ load: { report: summaryReport.asset } });
  assert.ok(summaryView.data.report.structure.includes('<!-- 1 --></span>'));
  assert.ok(summaryView.data.report.structure.includes(`<!-- ${Array.from(conclusion).slice(0, 30).join('')}... -->`));
  assert.ok(!summaryView.data.report.structure.includes('下一条结论。'));
  assert.deepEqual(summaryView.data.report.items.fact, payload, '摘要保留完整数据材料');
  const arrayBody = '<article><p>数量 <span data-oks-ref="fact" data-oks-pick=".0.count" /></p></article>';
  const selected = await report('payload_rows', { fact: { src: source.asset, root: '.rows' } }, arrayBody);
  const selectedPage = readReport(selected.asset);
  assert.deepEqual(selectedPage.items.fact, payload.rows);
  assert.equal(selectedPage.origin.nodes[selectedPage.origin.root].inputPaths!.fact, '.data.rows');
  const scalarBody = '<article><p>数量 <span data-oks-ref="fact" /></p></article>';
  const scalar = readReport((await report('payload_scalar',
    { fact: { src: source.asset, root: '.rows.0.count' } }, scalarBody)).asset);
  assert.equal(scalar.items.fact, 7);
  assert.equal(scalar.origin.nodes[scalar.origin.root].inputPaths!.fact, '.data.rows.0.count');

  const arraySource = saveInputData({ root, name: 'array_source', motivation: '数组负荷直接读取', data: payload.rows });
  await assert.rejects(call({ load: { fact: arraySource.asset }, project: { fact: { data: 'Value' } } }),
    (error: Error) => {
      assert.match(error.message, /实际为 array/);
      assert.match(error.message, /输入根 \. 是具名对象/);
      assert.match(error.message, /已读取封装的 \.data 负荷.*数组 1 项/);
      return true;
    });
  await assert.rejects(call({ load, jq: program('runtime_error', '.knowledge.guide.label | .m') }),
    (error: Error) => {
      assert.match(error.message, /cannot index/);
      assert.match(error.message, /输入根 \. 是具名对象/);
      assert.match(error.message, /输入 knowledge ← knowledge:\/\/（知识图/);
      return true;
    });
  const preview = await call({ load: { fact: arraySource.asset },
    project: { fact: ['TruncateThen', 1, ['Map', { count: 'Value' }]] } });
  assert.deepEqual(preview.data, { fact: [{ count: 7 }] });
  const arrayReport = readReport((await report('payload_array', { fact: arraySource.asset }, arrayBody)).asset);
  assert.deepEqual(arrayReport.items.fact, (await call({ load: { fact: arraySource.asset } })).data.fact);
  for (const path of ['.meta', '.origin', '.data']) {
    await assert.rejects(report('envelope_path', { fact: { src: source.asset, root: path } }, scalarBody), /可见视图里.*没有/);
  }
  const businessFields = saveInputData({ root, name: 'business_fields', motivation: '负荷字段按字面读取',
    data: { meta: { kind: '业务字段' }, origin: '业务来源', data: 9 } });
  const businessReport = readReport((await report('business_meta',
    { fact: { src: businessFields.asset, root: '.meta.kind' } }, scalarBody)).asset);
  assert.equal(businessReport.items.fact, '业务字段');

  const metaBody = '<article><p>材料类别 <span data-oks-ref="fact" data-oks-pick=".meta.kind" /></p></article>';
  const metaPage = readReport((await report('explicit_meta', { fact: `${source.asset}#meta` }, metaBody)).asset);
  assert.deepEqual(metaPage.items.fact, { meta: envelope.meta, origin: envelope.origin });
  assert.equal(metaPage.origin.nodes[metaPage.origin.root].inputPaths!.fact, '#meta');
  const originPage = readReport((await report('explicit_origin',
    { fact: { src: `${source.asset}#meta`, root: '.origin.root' } }, scalarBody)).asset);
  assert.equal(originPage.items.fact, envelope.origin.root);
  assert.equal(originPage.origin.nodes[originPage.origin.root].inputPaths!.fact, '#meta.origin.root');
  for (const fragment of ['#data', '#meta#meta']) {
    await assert.rejects(report('invalid_view', { fact: `${source.asset}${fragment}` }, scalarBody), /资源选择符错误/);
  }

  for (const kind of ['table', 'bar']) {
    const figure = await callTool('oks_render_figure', { name: `payload_${kind}`, src: arraySource.asset,
      spec: kind === 'table' ? { kind } : { kind, x: 'name', value: 'count' } });
    const figureBody = '<article><figure data-oks-ref="fact" /></article>';
    const figurePage = readReport((await report(`report_${kind}`, { fact: figure.asset }, figureBody)).asset);
    assert.deepEqual(figurePage.items.fact.rows, payload.rows);
    assert.equal(figurePage.origin.nodes[figurePage.origin.root].inputPaths!.fact, '.data');
    await assert.rejects(report(`slice_${kind}`, { fact: { src: figure.asset, root: '.rows' } }, figureBody),
      /root 保持默认 "\."/);
  }

  // 再次引用报告里的负荷时，上游 jq 源码与完整来源继续随新报告携带。
  const labelBody = '<article><p><span data-oks-ref="fact" data-oks-pick=".label" /></p></article>';
  const firstReport = await report('report_with_code', { fact: stored.asset }, labelBody);
  const reusedReport = readReport((await report('report_reused',
    { fact: { src: firstReport.asset, root: '.items.fact' } }, labelBody)).asset);
  assert.deepEqual(reusedReport.items.fact, document.guide);
  assert.ok(Object.values(reusedReport.assets).includes('.knowledge.guide'));
  assert.equal(reusedReport.origin.nodes[reusedReport.origin.root].inputPaths!.fact, '.data.items.fact');
  assert.ok(Object.values(reusedReport.origin.nodes).some(node => node.kind === 'knowledge'));
  console.log('✓ 报告和 load 共用负荷视图、相对取值、显式 #meta、图表整件展示及完整来源继承');
} finally {
  engine.dispose();
  rmSync(root, { recursive: true, force: true });
}
