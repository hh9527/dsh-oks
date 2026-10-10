/** 报告生成：把一份 markdown 拼成自足的 HTML。
 *
 *  「自足」是硬要求：图以 `<svg>` 元素内联、样式写在页面里、没有任何外链。原因是侧栏的
 *  **静态 HTML 模式不读取关联文件**（它只放行行内样式与 data 图片），而且自足的文件
 *  发给别人也能直接打开。
 *
 *  安全上只有一条规矩：**这份 HTML 全部由这里生成**。markdown 经白名单解析器转义后进入页面，
 *  内嵌 HTML 不被解释；图的规格交给调用方校验并渲染。脚本、样式、结构都是本文件里的常量。
 */
import { escapeHtml, parseChartFence, renderMarkdown, safeLanguage } from './markdown.ts';

/** 把 chart 块变成 HTML：返回 figure 元素（与图注），或一段说明（出错时不整份失败）。 */
export type FigureRenderer = (
  json: Record<string, unknown>,
  index: number,
) => { html: string; caption: string | null } | { error: string };

/** 一份报告的素材。 */
export interface ReportInput {
  title: string;
  /** 副标题：通常是时间窗。 */
  subtitle: string | null;
  /** 生成时间（UTC ISO 字符串），由调用方给，便于测试。 */
  generatedAt: string;
  /** 正文 markdown：章节、叙述与图的落点都在这里。 */
  markdown: string;
  /** 画图：由调用方负责取数与校验。 */
  figure: FigureRenderer;
}

/**
 * 把一张 SVG 包成报告里的图。图以 `<svg>` 元素内联而不是 `<img src="data:...">`：
 * base64 会把体积撑大三分之一，内联后图里的文字还能被选中、页面样式也能作用到图内。
 *
 * 代价是**内联的 `<svg>` 会执行其中的脚本**（`<img>` 里的不会），所以这里自己剥一遍：
 * 脚本、`on*` 事件属性、指向外部的 `href`。安全性由这一段保证，而不是"依赖我们的图恰好干净"。
 *
 * 同时把根元素的固定宽高换掉——echarts 给的是像素值，而报告里应当随栏宽自适应；
 * `viewBox` 保留，所以比例不变。
 */
export const buildFigureHtml = (svg: string, caption: string | null): string => {
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
  return `<figure>${cleaned}${caption === null || caption === '' ? '' : `<figcaption>${escapeHtml(caption)}</figcaption>`}</figure>`;
};

/** 报告的样式：全部写在页面里。 */
const STYLE = `
:root { color-scheme: light; }
* { box-sizing: border-box; }
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif;
       max-width: 880px; margin: 0 auto; padding: 36px 30px 72px; color: #1c2b3a; line-height: 1.75; background: #fff; }
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
figure svg.chart { display: block; width: 100%; height: auto; border: 1px solid #e9eef5; border-radius: 10px; background: #fff; }
figcaption { color: #6b7b8c; font-size: 12.5px; margin-top: 8px; }
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
}
`.trim();

/** 从 markdown 里抽出章节标题，生成目录。 */
const outline = (markdown: string): Array<{ level: number; text: string; id: string }> => {
  const found: Array<{ level: number; text: string; id: string }> = [];
  for (const line of markdown.split('\n')) {
    const heading = line.match(/^(#{1,3})\s+(.*)$/);
    if (heading === null) continue;
    const level = heading[1].length;
    const text = heading[2].trim();
    if (text === '') continue;
    found.push({ level, text, id: `section-${found.length + 1}` });
  }
  return found;
};

/** 给标题元素补上 id，让目录锚点能跳到它。 */
const anchorHeadings = (body: string, headings: Array<{ level: number; text: string; id: string }>): string => {
  let index = 0;
  return body.replace(/<h([1-3])>(.*?)<\/h\1>/g, (match, level: string, inner: string) => {
    const target = headings[index];
    index += 1;
    if (target === undefined || target.level !== Number(level)) return match;
    return `<h${level} id="${target.id}">${inner}</h${level}>`;
  });
};

/** 生成一份自足的 HTML 报告。 */
export const renderReportHtml = (input: ReportInput): string => {
  let figureIndex = 0;
  const body = renderMarkdown(input.markdown, (info, text, blockIndex) => {
    // 只有 chart 块会被画成图；其它围栏（json / sql / text 之类）按代码块呈现，内容转义不解释。
    if (info !== 'chart') {
      return `<pre><code${safeLanguage(info)}>${escapeHtml(text)}</code></pre>`;
    }
    const parsed = parseChartFence(text);
    if ('error' in parsed) return `<div class="figure-error">图表 ${blockIndex + 1}：${escapeHtml(parsed.error)}</div>`;
    const rendered = input.figure(parsed.fence.json, figureIndex);
    if ('error' in rendered) return `<div class="figure-error">${escapeHtml(rendered.error)}</div>`;
    figureIndex += 1;
    // 图注编号由这里统一给，agent 只需要写文字。
    if (rendered.caption === null || rendered.caption === '') return rendered.html;
    return rendered.html.replace(
      '</figure>',
      `<figcaption>图 ${figureIndex}　${escapeHtml(rendered.caption)}</figcaption></figure>`,
    );
  });

  const headings = outline(input.markdown);
  const anchored = anchorHeadings(body, headings);
  const nav = headings
    .filter((heading) => heading.level <= 2)
    .map((heading) => `<a href="#${heading.id}">${escapeHtml(heading.text)}</a>`)
    .join('');

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(input.title)}</title>
<style>
${STYLE}
</style>
</head>
<body>
<header>
<h1>${escapeHtml(input.title)}</h1>
${input.subtitle === null ? '' : `<p class="subtitle">${escapeHtml(input.subtitle)}</p>`}
<p class="meta">生成于 ${escapeHtml(input.generatedAt)} · 各图数据来源见图内标注</p>
</header>
${nav === '' ? '' : `<nav><span class="nav-title">目录</span>${nav}</nav>`}
${anchored}
<footer>本报告由 oks 插件生成 · 图以内联 SVG 嵌在页面里，单文件自足</footer>
</body>
</html>
`;
};
