// Agent 反馈涉及的消费边界与诊断回归；直接测试源码，无模型或服务依赖。
import assert from 'node:assert/strict';
import { limitProblem } from './src/intent-limit.ts';
import { rowsOf } from './src/results.ts';
import { checkAuthorXhtml, checkWellFormed, extractStructure, shrinkStructure } from './src/report/xhtml.ts';
import { renderCheck, renderJqResult, renderReportCheck } from './src/response.ts';

const rows = [{ tenant: 'A', count: 2 }];
assert.equal(rowsOf(rows, 'sample'), rows);
assert.equal(rowsOf({ rows }, 'sample'), rows);
assert.equal(rowsOf({ rows, columns: [
  { name: 'tenant', types: ['string'], nullable: false },
  { name: 'count', types: ['number'], nullable: false },
] }, 'sample'), rows);
for (const columns of [['tenant', 'count'], ['tenant:string'], [{ name: '' }], [{ name: 'count', types: 'number', nullable: false }], null]) {
  assert.throws(() => rowsOf({ rows, columns }, 'sample'), /data.columns/);
}
const valid = checkAuthorXhtml('<article><p><span data-oks-ref="fact" data-oks-pick=".rows.0.label" /></p></article>');
assert.deepEqual(valid.errors, []);
const invalid = checkAuthorXhtml('<article>\n<p><span data-oks-ref="fact" data-oks-pick=".rows[0].label" /></p>\n<p><span data-oks-ref="fact" data-oks-pick=".rows[0].label" /></p>\n</article>');
assert.equal(invalid.errors.length, 2);
assert.match(invalid.errors[0].message, /建议路径：.rows.0.label/);
const grouped = JSON.parse((renderReportCheck({}, { valid: false, errors: invalid.errors })[0] as {text:string}).text);
assert.equal(grouped.valid, false);
assert.equal(grouped.errors.length, 1);
assert.deepEqual(grouped.errors[0].locations.map((at: {line:number}) => at.line), [2, 3]);
const check = renderCheck({}, { intents: [{name:'good',intent:{}},{name:'bad',intent:{}}], results: [
  { name: 'good', accepted: true, key: 'key', diagnostics: [] },
  { name: 'bad', accepted: false, key: null, diagnostics: [] },
] });
const text = (check[0] as {text:string}).text;
assert.match(text.split('\n')[0], /通过 1 项（good）；未通过 1 项（bad）/);
assert.match(text, /good  key=key/);
console.log('✓ 列声明入口校验、共用行数据、pick 修正建议与聚合位置、批次首行摘要');

for (const limit of [1, 100, 101, 500]) {
  assert.equal(limitProblem({limit}), null, `limit=${limit} 应当通过插件校验`);
}
for (const limit of [undefined, null, 0, 1.5, 501, '500']) {
  assert.match(limitProblem({limit})!, /limit.*(?:500|整数)/);
}
assert.match(limitProblem(null)!, /Intent 必须是一个对象/);
console.log('✓ 查询 limit 允许 1..500，501 及非法值被拒绝');

for (const code of ['evaluation_truncated', 'payload_too_large']) {
  const error = { ok: false, error: { code, tool: 'oks_data', limitBytes: 1024, actualBytes: null },
    shape: { type: 'array', size: 100000 } };
  for (const args of [{}]) {
    assert.deepEqual(JSON.parse((renderJqResult(args, error)[0] as { text: string }).text), error);
  }
}
for (const value of [null, undefined, {}, { error: { code: 'failure' } }]) {
  const text = (renderJqResult({}, value)[0] as { text: string }).text;
  assert.doesNotMatch(text, /asset:.*0\.0 KB/);
}

console.log('✓ oks_data 读取错误与 shape 完整可见');

// 读回结构是注释摘要，最终报告的正文另由渲染路径完整保留。
const summaryOf = (content: string, attributes = 'data-oks-shrink=""') => {
  const result = shrinkStructure(`<article><div ${attributes}>${content}</div></article>`);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(checkWellFormed(result.xml), []);
  assert.equal(shrinkStructure(result.xml).xml, result.xml, '重复读取摘要稳定');
  return result.xml;
};
assert.match(summaryOf('甲'.repeat(30)), /<!-- 甲{30} -->/);
assert.match(summaryOf('甲'.repeat(31)), /<!-- 甲{30}\.\.\. -->/);
assert.match(summaryOf('😀'.repeat(31)), /<!-- 😀{30}\.\.\. -->/u);
assert.match(summaryOf('<p>第一<strong>条</strong></p><p>第二条</p>'), /<!-- 第一条 第二条 -->/);
assert.match(summaryOf('a &lt; b &amp; c <![CDATA[<d>]]>'), /<!-- a < b & c <d> -->/);
assert.match(summaryOf('a--b-'), /<!-- a- -b- -->/);
summaryOf('-'.repeat(30));
assert.match(summaryOf('-'.repeat(31)), /\.\.\. -->/);
summaryOf('前'.repeat(29) + ' 后');
assert.match(summaryOf('甲'.repeat(30) + '  '), /<!-- 甲{30} -->/);
assert.match(summaryOf('甲'.repeat(31), 'data-oks-shrink="" data-oks-ref="x"'), /<!-- 甲{30}\.\.\. -->/);
assert.match(summaryOf(''), /<!--  -->/);
assert.match(summaryOf('<figure data-oks-ref="chart"><svg><text>图表文字</text></svg></figure>结论'), /<!-- 结论 -->/);
assert.match(summaryOf('<span data-oks-ref="x">87.5%</span> 结论'), /<!-- 87.5% 结论 -->/);
const span = shrinkStructure('<article><span data-oks-ref="kpi" data-oks-pick=".rate">87.5%</span></article>');
assert.equal(span.xml, '<article><span data-oks-ref="kpi" data-oks-pick=".rate"><!-- 87.5% --></span></article>');
assert.equal(shrinkStructure(span.xml).xml, span.xml);
const longSpan = shrinkStructure(`<article><span data-oks-ref="x">${'值'.repeat(40)}</span></article>`).xml;
assert.ok(longSpan.includes(`<!-- ${'值'.repeat(40)} -->`), '引用值完整保留');
assert.equal(shrinkStructure('<article><span data-oks-ref="x" /><p data-oks-shrink="" /></article>').xml,
  '<article><span data-oks-ref="x"><!--  --></span><p data-oks-shrink=""><!--  --></p></article>');
const readBody = '<article><!-- 结构意图 --><p data-oks-shrink="">结论</p><figure data-oks-ref="f"><svg /></figure></article>';
assert.equal(extractStructure(`<html><body>${readBody}</body></html>`, false).xml, readBody);
assert.equal(extractStructure(`<html><body>${readBody}</body></html>`, true).xml,
  '<article><!-- 结构意图 --><p data-oks-shrink=""><!-- 结论 --></p><figure data-oks-ref="f"><!-- omitted --></figure></article>');
console.log('✓ 报告读回以注释保留引用值和 30 字摘要，截断、省略、Unicode、XML 安全及重复读取');
