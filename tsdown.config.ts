import { defineConfig } from 'tsdown';

// 单一文件插件：入口只有 src/index.ts，产物就落在包根 index.mjs，打包后没有任何相对导入
// ——profile 里 link: 装的插件因此不依赖模块解析。私有插件，不产出 .d.mts。
export default defineConfig({
  entry: ['src/index.ts'],
  format: 'esm',
  platform: 'node',
  target: 'node22',
  outDir: '.',
  clean: false,
  // 私有插件：只被 DSH 加载，没人把它当库 import，所以不产出类型声明（dts）
  dts: false,
  hash: false,
  minify: false,
  unbundle: false,
  outExtensions: () => ({ js: '.mjs' }),
});
