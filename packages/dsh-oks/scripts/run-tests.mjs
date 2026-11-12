// 依次运行 tests/*-test.ts，跑完所有用例后汇总失败并返回非零退出码。
// 需要外部工作区与模型的用例默认跳过，由 test:smoke / test:integration 显式运行。
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const optIn = new Set(['dari-adapter-test.ts']);
const tests = readdirSync(join(root, 'tests')).filter(name => name.endsWith('-test.ts') && !optIn.has(name)).sort();

const failed = [];
for (const name of tests) {
  console.log(`\n=== ${name}`);
  const result = spawnSync(process.execPath, ['--import', './scripts/markdown-loader.mjs', join('tests', name)], {
    cwd: root,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) failed.push(name);
}

console.log(`\n${tests.length - failed.length}/${tests.length} test files passed`);
if (failed.length > 0) {
  console.error('failed: ' + failed.join(', '));
  process.exit(1);
}
