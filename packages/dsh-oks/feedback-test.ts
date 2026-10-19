// Agent 反馈涉及的消费边界与诊断回归；直接测试源码，无模型或服务依赖。
import assert from 'node:assert/strict';
import { limitProblem } from './src/intent-limit.ts';
import { rowsOf } from './src/results.ts';
import { checkAuthorXhtml } from './src/report/xhtml.ts';
import { renderCheck, renderReportCheck } from './src/response.ts';

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
