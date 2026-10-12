import { defineConfig } from 'tsdown';

// 这个包只有浏览器半边：`lib/client.mjs` 由宿主侧的 `dsh-client-modules` 按 `dsh.client`
// 声明打成浏览器 bundle（我们不自己出 bundle）。宿主侧那个入口是空的——它存在的意义是让
// profile 能挂上这一条、从而让页面加载器扫到 `dsh.client`。
export default defineConfig([
  {
    entry: ['src/index.ts'],
    format: 'esm',
    platform: 'node',
    target: 'node22',
    outDir: 'lib',
    clean: false,
    dts: false,
    hash: false,
    minify: false,
    unbundle: false,
    outExtensions: () => ({ js: '.mjs' }),
  },
  {
    entry: ['src/client.ts'],
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    outDir: 'lib',
    clean: false,
    dts: false,
    hash: false,
    minify: false,
    unbundle: false,
    // 产物是**经典脚本**（宿主模块加载器协议），所以这里不保留任何外部依赖：
    // 依赖在工厂里用 require("<包名>") 取，源码里没有 ESM import/export。
    external: [],
    outExtensions: () => ({ js: '.mjs' }),
  },
]);
