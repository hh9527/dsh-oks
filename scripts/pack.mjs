// 把构建产物整理成发布目录：dist/<dir>/{package.json,lib,...}。
// 发布清单只保留运行期字段；脚本与开发依赖不进入安装目录。
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
// 客户端插件只能 require 宿主模块图注入的包；其余依赖必须在构建期打进来。
// 这份清单对应 dsh-web-frontend 暴露给浏览器模块系统的模块表。
const INJECTED_CLIENT_MODULES = new Set([
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client',
  '@deepseek-ai/cordis', 'zod', '@tanstack/react-virtual',
  '@deepseek-ai/dsh-client-store', '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives', '@deepseek-ai/dsh-client-ui-dockkit',
]);
const packages = [
  { dir: 'dsh-oks', source: 'packages/dsh-oks', extra: ['locale', 'icon.svg', 'cordis.patch.yml'] },
  { dir: 'dsh-push-to-user', source: 'packages/dsh-push-to-user', extra: ['cordis.patch.yml'] },
];

for (const { dir, source, extra } of packages) {
  const target = join(root, 'dist', dir);
  const lib = join(target, 'lib');
  if (!existsSync(join(lib, 'index.mjs'))) throw new Error(`missing ${dir} build output; run pnpm run build first`);
  const manifest = JSON.parse(readFileSync(join(root, source, 'package.json'), 'utf8'));
  delete manifest.scripts;
  delete manifest.devDependencies;
  delete manifest.dependencies;
  // 发布产物自包含：清单不携带依赖，构建产物不引用外部裸模块。
  for (const key of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    if (key in manifest) throw new Error(`release manifest for ${dir} must not declare ${key}`);
  }
  for (const entry of ['lib/index.mjs', 'lib/client.js']) {
    const file = join(lib, entry.split('/')[1]);
    if (!existsSync(file)) continue;
    const external = [...readFileSync(file, 'utf8').matchAll(/^\s*import[^;]*?from\s*["']([^"']+)["']/gm)]
      .map((match) => match[1]).filter((specifier) => !specifier.startsWith('node:') && !specifier.startsWith('.'));
    if (external.length) throw new Error(`${dir}/${entry} imports external modules: ${external.join(', ')}`);
    if (entry === 'lib/client.js') {
      const injected = [...readFileSync(file, 'utf8').matchAll(/require\(["']([^"']+)["']\)/g)].map((match) => match[1]);
      const unknown = [...new Set(injected)].filter((specifier) => !INJECTED_CLIENT_MODULES.has(specifier));
      if (unknown.length) throw new Error(`${dir}/${entry} requires modules the host does not inject: ${unknown.join(', ')}`);
    }
  }
  writeFileSync(join(target, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  for (const name of extra) {
    const from = join(root, source, name);
    if (!existsSync(from)) throw new Error(`missing runtime file ${source}/${name}`);
    cpSync(from, join(target, name), { recursive: true });
  }
  console.log(`packed dist/${dir}`);
}
