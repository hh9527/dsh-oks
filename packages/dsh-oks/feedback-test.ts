// Agent 反馈涉及的消费边界与诊断回归；直接测试源码，无模型或服务依赖。
import assert from 'node:assert/strict';
import { limitProblem } from './src/intent-limit.ts';
import { rowsOf } from './src/results.ts';

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
console.log('✓ 列声明入口校验与共用行数据');

for (const limit of [1, 100, 101, 500]) {
  assert.equal(limitProblem({limit}), null, `limit=${limit} 应当通过插件校验`);
}
for (const limit of [undefined, null, 0, 1.5, 501, '500']) {
  assert.match(limitProblem({limit})!, /limit.*(?:500|整数)/);
}
assert.match(limitProblem(null)!, /Intent 必须是一个对象/);
console.log('✓ 查询 limit 允许 1..500，501 及非法值被拒绝');
