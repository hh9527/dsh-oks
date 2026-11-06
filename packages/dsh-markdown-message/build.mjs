// 源码是 TypeScript，产物是纯 JS；lib/ 不进入版本控制。
// Node 的类型剥离只去掉注解，不改变语义，因此不需要额外的编译依赖。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';

mkdirSync('lib', { recursive: true });
for (const [from, to] of [['src/index.ts', 'lib/index.mjs'], ['src/client.ts', 'lib/client.js']]) {
  writeFileSync(to, stripTypeScriptTypes(readFileSync(from, 'utf8'), { mode: 'strip' }));
}
