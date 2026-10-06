import { defineConfig } from 'tsdown';

// 单一文件插件：入口只有 src/index.ts，产物是 dist/index.mjs。打包后没有任何相对导入、
// 也不读任何旁文件（提示词已内联），所以放哪个目录都行——dist/ 只是让"源码 / 产物"分开。
// 私有插件，不产出 .d.mts。
export default defineConfig({
  entry: ['src/index.ts'],
  format: 'esm',
  platform: 'node',
  target: 'node22',
  outDir: 'dist',
  clean: false,
  // 私有插件：只被 DSH 加载，没人把它当库 import，所以不产出类型声明（dts）
  dts: false,
  hash: false,
  minify: false,
  unbundle: false,
  // 提示词是源码（src/skill.md、src/va-prompt-tpl.md），由打包器在构建期内联成字符串常量——
  // 产物因此不需要任何旁文件。
  loader: { '.md': 'text' },
  outExtensions: () => ({ js: '.mjs' }),
});
