/**
 * 出图与报告共用的两样东西：**图表 SVG 的收拾**与**报告的样式表**。
 *
 *  「自足」是硬要求：图以 `<svg>` 元素内联、样式写在页面里、没有任何外链——侧栏的静态 HTML 模式
 *  不读取关联文件，自足的文件发给别人也能直接打开。
 *
 *  安全上只有一条规矩：**页面全部由我们生成**。SVG 的清理（脚本、事件属性、外链）在这一层保证；
 *  报告正文的严格性由 `src/report/` 那套校验负责。
 */
import type { DataOrigin } from '../results.ts';

export type DisplaySource =
  | { kind: 'chart'; svg: string; origin: DataOrigin; data: unknown; spec: unknown }
  | { kind: 'table'; embedded: string; origin: DataOrigin; data: unknown; spec: unknown };

/** 收拾一张图表 SVG：去掉外壳与可执行内容、尺寸交给栏宽。内联与单独成件都走这里。 */
export const cleanChartSvg = (svg: string): string => {
  const cleaned = svg
    .replace(/<\?xml[\s\S]*?\?>/gi, '')
    .replace(/<!DOCTYPE[\s\S]*?>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, '')
    .replace(/\son[a-z]+\s*=\s*'[^']*'/gi, '')
    .replace(/(href|xlink:href)\s*=\s*"(?!#)[^"]*"/gi, '')
    .replace(/(href|xlink:href)\s*=\s*'(?!#)[^']*'/gi, '')
    .replace(/<svg([^>]*?)\swidth="[^"]*"/i, '<svg$1')
    .replace(/<svg([^>]*?)\sheight="[^"]*"/i, '<svg$1')
    .replace('<svg', '<svg class="chart" preserveAspectRatio="xMidYMid meet"');
  return cleaned;
};

/** 报告的样式：全部写在页面里。 */
export const REPORT_STYLE = `
:root { color-scheme: light; }
* { box-sizing: border-box; }
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif;
       max-width: 880px; margin: 0 auto; padding: 36px 30px 72px; color: #1c2b3a; line-height: 1.75;
       font-weight: 500; background: #fff; }
header { border-bottom: 2px solid #1c2b3a; padding-bottom: 16px; margin-bottom: 10px; }
h1 { font-size: 27px; margin: 0 0 8px; letter-spacing: .2px; }
.subtitle { font-size: 14px; color: #3d4d5c; margin: 0 0 6px; }
.meta { color: #8494a5; font-size: 12.5px; }
nav { background: #f6f9fc; border: 1px solid #e5eaf1; border-radius: 10px; padding: 14px 20px; margin: 26px 0 8px; font-size: 14px; }
nav .nav-title { font-weight: 600; margin-right: 12px; color: #3d4d5c; }
nav a { color: #2b6cb0; text-decoration: none; margin-right: 16px; }
nav a:hover { text-decoration: underline; }
h2 { font-size: 19px; margin: 40px 0 12px; padding-left: 11px; border-left: 4px solid #5a8cf0; }
h3 { font-size: 16px; margin: 26px 0 10px; color: #2b3b4a; }
p { margin: 0 0 12px; }
ul, ol { margin: 0 0 14px; padding-left: 26px; }
li { margin: 4px 0; }
blockquote { margin: 0 0 16px; padding: 2px 16px; border-left: 3px solid #d8e0ea; color: #4a5b6c; }
blockquote p:last-child { margin-bottom: 0; }
hr { border: none; border-top: 1px solid #e5eaf1; margin: 26px 0; }
code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px;
       background: #f2f5f9; border: 1px solid #e5eaf1; border-radius: 4px; padding: 1px 5px; }
pre { margin: 0 0 16px; padding: 12px 14px; overflow-x: auto; background: #f6f9fc;
      border: 1px solid #e5eaf1; border-radius: 8px; }
pre code { background: none; border: none; border-radius: 0; padding: 0; font-size: 12.5px; line-height: 1.65; }
table { border-collapse: collapse; width: 100%; margin: 6px 0 16px; font-size: 13px; }
th, td { border: 1px solid #e5eaf1; padding: 6px 10px; text-align: left; vertical-align: top; }
th { background: #f6f9fc; font-weight: 600; }
figure { margin: 20px 0 8px; }
.table-block { margin: 18px 0 22px; }
.table-block .table-scroll { overflow-x: auto; }
figure svg.chart { display: block; width: 100%; height: auto; border: 1px solid #e9eef5; border-radius: 10px; background: #fff; }
figcaption { color: #6b7b8c; font-size: 12.5px; margin-top: 8px; }
/* 有来源的展示项才戴这枚编号 chip：手打的表没有编号，于是"有没有 chip"就是
   "这段数字有没有来路"的视觉信号。 */
.item-no { display: inline-block; padding: 1px 9px; margin-right: 8px; border-radius: 999px;
           background: #edf3fc; color: #3f5d8f; font-weight: 600; font-size: 12px; letter-spacing: .3px; }
/* 有来源的数字：正文里带 data-oks-ref 的 span。半透明浅绿标出"这个数字有来路"，悬停加深并给出
   引用键与取值路径（title）。背景色在纸上不一定印出来，所以打印样式里补一条下划线兜底。 */
span[data-oks-ref] { background: rgba(96, 176, 112, .11); border-radius: 3px; padding: 0 3px; }
span[data-oks-ref]:hover { background: rgba(96, 176, 112, .2); }
.figure-error { border: 1px dashed #e0b4b4; background: #fdf6f6; color: #8a4b4b; border-radius: 8px;
                padding: 10px 14px; font-size: 13px; margin: 16px 0; }
footer { margin-top: 52px; padding-top: 16px; border-top: 1px solid #e5eaf1; color: #93a3b4; font-size: 12px; }

/* 打印：报告的"稳定排版"就靠这一段——图与表不跨页、标题不落在页尾、纸上的链接退回普通文字。 */
@media print {
  body { max-width: none; padding: 0; color: #000; }
  nav { display: none; }
  h2, h3 { break-after: avoid; }
  figure, table, pre, blockquote { break-inside: avoid; }
  a { color: inherit; text-decoration: none; }
  figure svg.chart { border-color: #ccc; }
  /* 纸上不保证印背景色，给 chip 一条描边，别让它变成看不见的空白。 */
  .item-no { background: none; border: 1px solid #b9c6d8; }
  /* 纸上默认不印背景色：给有来源的数字留一条下划线，标记照样看得见，颜色压淡别抢正文。 */
  span[data-oks-ref] { background: none; padding: 0; border-bottom: 1px solid #b9c6d8; }
}
`.trim();
