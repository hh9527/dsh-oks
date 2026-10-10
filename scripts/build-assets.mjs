// 把出图需要的静态资产放进 dist/，让"部署一个插件"等于"拿到一个 dist 目录"。
//
// 三样东西：
//   1) typst 的两份 WASM（编译器 + 渲染器）—— 从 node_modules 复制；
//   2) 中文字体与 typst 的默认字体集 —— 从 assets/fonts 复制（将来加字重就是多放文件）；
//   3) typst 的 @preview 包缓存 —— 由 typst binary 按 offline-all-widgets.typ 拉取，再复制。
//
// 包缓存只在缺失时才去拉：依赖树的解析（多层、同包多版本）交给 typst 自己，
// 我们只把结果搬进 dist/。所以本机要装 typst（mise 里就有），CI 也一样。

import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const dist = join(root, 'dist');
const cache = join(root, '.typst-cache');

/** 从 node_modules 里找某个包的目录（pnpm 会把真实目录放在 .pnpm 下）。 */
const packageDir = (name) => {
  const path = join(root, 'node_modules', name);
  if (!existsSync(path)) throw new Error(`缺少依赖 ${name}：先跑 pnpm install`);
  return path;
};

const copyInto = (from, to) => {
  mkdirSync(to, { recursive: true });
  cpSync(from, to, { recursive: true });
};

// 1) typst 的两份 WASM
for (const [pkg, file] of [
  ['@myriaddreamin/typst-ts-web-compiler', 'typst_ts_web_compiler_bg.wasm'],
  ['@myriaddreamin/typst-ts-renderer', 'typst_ts_renderer_bg.wasm'],
]) {
  const from = join(packageDir(pkg), 'pkg', file);
  if (!existsSync(from)) throw new Error(`缺少 ${pkg}/pkg/${file}`);
  mkdirSync(dist, { recursive: true });
  cpSync(from, join(dist, file));
  console.log(`  ${file}`);
}

// 2) 字体
const fonts = join(root, 'assets', 'fonts');
if (!existsSync(fonts)) throw new Error('缺少 assets/fonts：出图需要中文字体与 typst 的默认字体集');
copyInto(fonts, join(dist, 'fonts'));
console.log(`  fonts/（${readdirSync(fonts).length} 个字体）`);

// 3) typst 包缓存：缺失时才拉，随后复制进 dist/typst-pkgs/
if (!existsSync(join(cache, 'preview'))) {
  console.log('  拉取 typst 包（由 offline-all-widgets.typ 展开依赖树）…');
  try {
    execFileSync('typst', [
      'compile',
      '--package-cache-path', cache,
      join(root, 'offline-all-widgets.typ'),
      join(cache, 'offline-all-widgets.pdf'),
    ], { stdio: 'inherit', cwd: root });
  } catch (cause) {
    throw new Error(
      '拉取 typst 包失败：这一步需要本机有 typst 命令（依赖树的解析交给它）。\n'
      + '装好后重跑，或者把已有的 .typst-cache/preview 目录放到仓库根再重跑。\n'
      + `原始错误：${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
}
copyInto(join(cache, 'preview'), join(dist, 'typst-pkgs', 'preview'));
console.log(`  typst-pkgs/（${readdirSync(join(cache, 'preview')).length} 个包）`);
