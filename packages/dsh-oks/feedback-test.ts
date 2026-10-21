// Agent 反馈涉及的消费边界与诊断回归；直接测试源码，无模型或服务依赖。
import assert from 'node:assert/strict';
import { limitProblem } from './src/intent-limit.ts';
import { rowsOf } from './src/results.ts';
import { parseDraftForValidation } from './src/draft/document.ts';
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
  const error = { ok: false, error: { code, tool: 'oks_project', limitBytes: 1024, actualBytes: null },
    shape: { type: 'array', size: 100000 } };
  for (const args of [{}]) {
    assert.deepEqual(JSON.parse((renderJqResult(args, error)[0] as { text: string }).text), error);
  }
}
for (const value of [null, undefined, {}, { error: { code: 'failure' } }]) {
  const text = (renderJqResult({}, value)[0] as { text: string }).text;
  assert.doesNotMatch(text, /asset:.*0\.0 KB/);
}

console.log('✓ oks_project 读取错误与 shape 完整可见');
