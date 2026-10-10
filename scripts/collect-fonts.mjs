// 收集 typst.ts 初始化时需要的默认字体 URL，并下载到 assets/fonts/。
//
// 为什么需要它：typst.ts 默认会去 jsdelivr 拉它自带的那套默认字体（DejaVu / Libertinus / NewCM），
// 而我们的运行时要完全离线——这个脚本把那些字体一次性落到仓库里，与中文字体放在一起，
// 于是运行时可以用 loadFonts(..., { assets: false }) 彻底关掉远程。
//
// 它通过加载 dist/ 里的产物来触发 typst.ts 的字体请求，所以先 pnpm run build 再跑。
// 只在字体需要更新时手工跑一次，不参与日常构建。
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';

const urls = new Set();
const original = globalThis.fetch;
globalThis.fetch = (input, ...rest) => {
  const url = String(input);
  if (url.includes('/fonts/')) urls.add(url);
  return original(input, ...rest);
};

const { renderTypstSvg } = await import('../dist/chart-typst.mjs');
try {
  await renderTypstSvg('#import "@preview/lilaq:0.6.0" as lq\n#lq.diagram(lq.bar((0,1),(1,2)))');
} catch (cause) {
  console.log('（编译本身报错也没关系，先把字体清单收全）', String(cause?.message ?? cause).slice(0, 120));
}
console.log('收集到', urls.size, '个字体 URL');

mkdirSync('assets/fonts', { recursive: true });
let saved = 0;
for (const url of urls) {
  const name = url.split('/').pop();
  if (name === undefined) continue;
  if (existsSync(`assets/fonts/${name}`)) { saved += 1; continue; }
  const res = await original(url);
  if (!res.ok) { console.log('  下载失败', name, res.status); continue; }
  writeFileSync(`assets/fonts/${name}`, Buffer.from(await res.arrayBuffer()));
  saved += 1;
}
console.log('已落地', saved, '个字体到 assets/fonts/');
