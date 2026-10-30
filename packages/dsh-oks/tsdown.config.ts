import { defineConfig } from 'tsdown';

// 单一入口：src/index.ts → lib/index.mjs（profile 里 link: 装的插件加载的就是它）。
//
// 单入口是有意的：多入口会让打包器把共享代码拆成 chunk，index.mjs 就不再自包含。
// 出图的渲染层（src/chart/）由 index.ts 直接引用并一并导出，所以它们都在这个文件里。
//
// 出图的 JS 依赖一律打进产物：产物要自包含（把 lib/ 搬进空目录也能加载，见冒烟最后一段）。
// 图表与日历运算的 JS 依赖均内联到单文件产物。
// 默认情况下 tsdown 把 dependencies 视为外部依赖，正好是这里不想要的。
export default defineConfig([
  {
    entry: ['src/index.ts'],
    format: 'esm',
    platform: 'node',
    target: 'node22',
    outDir: 'lib',
    clean: true,
    dts: false,
    hash: false,
    minify: false,
    unbundle: false,
    deps: { alwaysBundle: [/^echarts/, /^zrender/, /^tslib$/, /^@js-temporal\//, /^jsbi$/] },
    // 提示词与 Markdown 帮助 由打包器在构建期内联成字符串常量——
    // 产物因此不需要任何旁文件。
    loader: { '.md': 'text' },
    outExtensions: () => ({ js: '.mjs' }),
  },
]);
