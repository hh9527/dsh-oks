// 独立引擎生命周期验收：传入隔离构建的 wasm，不更新运行环境。
import assert from 'node:assert/strict';
import { createJaqEngine } from './src/jaq.ts';

const path = process.argv[2];
assert.ok(path, '需要 wasm 路径');
const knowledge = createJaqEngine(path);
const other = createJaqEngine(path);
const calculator = createJaqEngine(path);
const options = { input: null, timeoutMs: 5000, maxChars: 262144 };
let loads = 0;
const document = { toJSON() { loads++; return { index: 'guide', guide: '入口', rows: [{ n: 1 }] }; } };
const query = (program: string, extra = {}) => knowledge.runDocument(program, document, { ...options, ...extra });

try {
  const first = await Promise.all([query('.[.index]'), query('.rows[0].n')]);
  assert.deepEqual(first.map((r) => r.values), [['入口'], [1]]);
  assert.equal(loads, 1, '并发首次访问只序列化并装载一次');
  await query('.rows[0].n = 999');
  assert.deepEqual((await query('.rows[0].n')).values, [1]);
  assert.equal(loads, 1, '后续查询复用已解析值');
  for (const program of ['.', 'empty', 'range(3)', '[range(3)]', '.rows | map(.n + 1)']) {
    const value = document.toJSON();
    assert.deepEqual(await query(program), await calculator.run(program, { ...options, input: value }));
  }
  await assert.rejects(query('. |', { programFile: '.work/broken.jq' }), /broken\.jq/);
  const huge = Array.from({ length: 812 }, (_, n) => ({ n, text: '中文🙂'.repeat(100) }));
  for (const run of [
    () => calculator.run('.data', { ...options, input: huge }),
    () => other.runDocument('.data', huge, options),
    () => calculator.run('error(.)', { ...options, input: '错误🙂'.repeat(10000) }),
  ]) {
    await assert.rejects(run(), (error: Error) => {
      assert.ok(Buffer.byteLength(error.message) <= 4096 + Buffer.byteLength('jaq 表达式执行失败：\n'));
      assert.match(error.message, /错误信息已截断/);
      return true;
    });
  }
  await assert.rejects(calculator.run('.data', { ...options, input: 1 }), /cannot index 1 with "data"/);
  other.dispose(); // 大数组夹具随实例释放，后续隔离检查装载自己的文档。
  console.log('✓ 大数组与显式 error 的运行时诊断限长，短错误与编译定位保留');

  assert.deepEqual((await query('.rows[0].n')).values, [1]);
  assert.equal((await query('range(100)', { maxChars: 12 })).truncated, true);

  await other.runDocument('.', { n: 2 }, options);
  const beforeTimeout = loads;
  const timedOut = assert.rejects(query('def f: f; f', { timeoutMs: 100 }), /超过.*ms/);
  assert.deepEqual((await other.runDocument('.n', { n: 2 }, options)).values, [2]);
  assert.deepEqual((await calculator.run('1 + 2', options)).values, [3]);
  await timedOut;
  assert.deepEqual((await query('.rows[0].n')).values, [1]);
  assert.equal(loads, beforeTimeout + 1, '超时后重新装载一次');

  const beforeTrap = loads;
  await assert.rejects(query('def f: 1 + f; f'), /trap/);
  assert.deepEqual((await query('.rows[0].n')).values, [1]);
  assert.equal(loads, beforeTrap + 1, 'trap 后重新装载一次');
  assert.deepEqual((await other.runDocument('.n', { n: 2 }, options)).values, [2]);

  const controller = new AbortController();
  const cancelled = query('def f: f; f', { signal: controller.signal });
  controller.abort();
  await assert.rejects(cancelled, /aborted/);
  assert.deepEqual((await query('.rows[0].n')).values, [1]);
  knowledge.dispose();
  assert.deepEqual((await query('.[.index]')).values, ['入口']);
  console.log('✓ 知识装载复用、不可变输入、值流一致、超时/trap/取消恢复与实例隔离');
} finally {
  knowledge.dispose();
  other.dispose();
  calculator.dispose();
}
