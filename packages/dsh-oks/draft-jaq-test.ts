import assert from 'node:assert/strict';
import { createJaqEngine } from './src/jaq.ts';

const wasm = process.argv[2];
assert.ok(wasm, '需要隔离构建的 wasm 路径');
const engine = createJaqEngine(wasm);
const options = { timeoutMs: 5000, programFile: 'first.jq' };
try {
  // These valid programs fail or never finish if executed against any test input.
  for (const program of ['error("must not execute")', 'def f: f; f', 'empty', '1, 2', '.rows | map(.n)']) {
    assert.deepEqual(await engine.check(program, options), { cached: false });
    assert.deepEqual(await engine.check(program, { ...options, programFile: 'moved.jq' }), { cached: true });
  }
  for (const program of ['. |', 'nonexistent_function', 'include "external"; .', 'import "external" as x; .', 'now']) {
    await assert.rejects(engine.check(program, options), /first\.jq/);
    await assert.rejects(engine.check(program, { ...options, programFile: 'current.jq' }), error => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /current\.jq/);
      assert.doesNotMatch(error.message, /first\.jq/);
      return true;
    });
  }
  assert.deepEqual(await engine.check('.n + 21', options), { cached: false });
  assert.deepEqual(await engine.run('.n + 21', { ...options, input: { n: 21 }, maxBytes: 100 }), { ok: true, data: 42 });
  assert.deepEqual(await engine.check('.n + 21', options), { cached: true });
  assert.deepEqual(await engine.run('100 + .', { ...options, input: 23, maxBytes: 100 }), { ok: true, data: 123 });
  assert.deepEqual(await engine.check('100 + .', options), { cached: true }, 'run 与 check 共用真实编译产物');
  for (let n = 0; n < 33; n++) await engine.check(`${n} # unique program`, options);
  assert.deepEqual(await engine.check('.n + 21', options), { cached: false }, '编译缓存达到容量时回收旧项');
  const largeProgram = `1 #${'x'.repeat(256 * 1024)}`;
  assert.deepEqual(await engine.check(largeProgram, options), { cached: false });
  assert.deepEqual(await engine.check(largeProgram, options), { cached: false }, '超过缓存正文预算时编译但不驻留');
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(engine.check('.', { ...options, signal: controller.signal }), /aborted/);
  engine.dispose();
  assert.deepEqual(await engine.check('.n + 21', options), { cached: false }, 'worker 生命周期隔离编译产物');
  console.log('draft jq: nonexecuting validation, real compiler reuse, diagnostics and eviction passed');
} finally {
  engine.dispose();
}
