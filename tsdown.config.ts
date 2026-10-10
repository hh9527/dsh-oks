import { defineConfig } from 'tsdown';

// 单一入口：src/index.ts → dist/index.mjs（profile 里 link: 装的插件加载的就是它）。
//
// 单入口是有意的：多入口会让打包器把共享代码拆成 chunk，index.mjs 就不再自包含。
// 出图的渲染层（src/chart/）由 index.ts 直接引用并一并导出，所以它们都在这个文件里。
//
// 运行时资产（WASM、字体、typst 包）放在 dist/ 下与它同级，由渲染层用 import.meta.url 定位。
//
// 私有插件，不产出类型声明（dts）。
export default defineConfig([
  {
    entry: ['src/index.ts'],
    format: 'esm',
    platform: 'node',
    target: 'node22',
    outDir: 'dist',
    clean: false,
    dts: false,
    hash: false,
    minify: false,
    unbundle: false,
    // typst 的 JS 胶水打进产物：产物要自包含（把 dist/ 搬进空目录也能加载，见冒烟最后一段）。
    // WASM 不走这条路径，由渲染层的 getModule 显式指向 dist/ 里的文件。
    // 默认情况下 tsdown 把 dependencies 视为外部依赖，正好是这里不想要的。
    deps: { alwaysBundle: [/^@myriaddreamin\//] },
    // 提示词是源码（src/skill.md、src/va-prompt-tpl.md），由打包器在构建期内联成字符串常量——
    // 产物因此不需要任何旁文件。
    loader: { '.md': 'text' },
    outExtensions: () => ({ js: '.mjs' }),
  },
]);
