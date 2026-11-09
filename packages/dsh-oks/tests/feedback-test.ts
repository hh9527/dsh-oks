// Agent 反馈涉及的消费边界与诊断回归；直接测试源码，无模型或服务依赖。
import assert from 'node:assert/strict';
import { rowsOf } from '../src/results.ts';

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
