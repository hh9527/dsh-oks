import { defineConfig } from 'tsdown';

// 两个入口、两种目标：宿主侧空插件与浏览器端自注册脚本。
// 客户端入口通过 factory 的 require 取宿主注入的模块，不产生顶层 import。
export default defineConfig([
  {
    entry: ['src/index.ts'],
    format: 'esm',
    platform: 'node',
    target: 'node22',
    outDir: '../../dist/dsh-push-to-user/lib',
    clean: true,
    dts: false,
    hash: false,
    minify: false,
    outExtensions: () => ({ js: '.mjs' }),
  },
  {
    entry: ['src/client.ts'],
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    outDir: '../../dist/dsh-push-to-user/lib',
    clean: false,
    dts: false,
    hash: false,
    minify: false,
    outExtensions: () => ({ js: '.js' }),
  },
]);
