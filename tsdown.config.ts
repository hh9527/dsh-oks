import { defineConfig } from 'tsdown';

// 单一入口：src/index.ts → dist/index.mjs（profile 里 link: 装的插件加载的就是它）。
//
// 打包成单一文件：没有任何相对导入、也不读任何旁文件（提示词已内联），所以放哪个目录都行——
// dist/ 只是让"源码 / 产物"分开。私有插件，不产出类型声明（dts）。
//
// 图在服务端画成 SVG 文本（src/svg.ts），所以产物依旧零运行时依赖。
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
    // d3 的纯计算包必须打进产物：产物要自包含（单独放进空目录也能加载，见冒烟最后一段）。
    // 默认情况下 tsdown 把 dependencies 视为外部依赖，正好是这里不想要的。
    deps: { alwaysBundle: [/^d3-/] },
    // 提示词是源码（src/skill.md、src/va-prompt-tpl.md），由打包器在构建期内联成字符串常量——
    // 产物因此不需要任何旁文件。
    loader: { '.md': 'text' },
    outExtensions: () => ({ js: '.mjs' }),
  },
]);
