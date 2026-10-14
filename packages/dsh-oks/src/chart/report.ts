/** 报告生成：把一份 markdown 拼成自足的 HTML。
 *
 *  「自足」是硬要求：图以 `<svg>` 元素内联、样式写在页面里、没有任何外链。原因是侧栏的
 *  **静态 HTML 模式不读取关联文件**（它只放行行内样式与 data 图片），而且自足的文件
 *  发给别人也能直接打开。
 *
 *  安全上只有一条规矩：**这份 HTML 全部由这里生成**。markdown 经白名单解析器转义后进入页面，
 *  内嵌 HTML 不被解释；图的规格交给调用方校验并渲染。脚本、样式、结构都是本文件里的常量。
 */
import { escapeHtml, renderMarkdown, safeLanguage } from './markdown.ts';
import type { DataOrigin, EnvelopeParts } from '../results.ts';

/** 报告里的一个**展示项**：图或表。报表级的来源结构里一条就是一项。 */
export interface DisplayItem {
  kind: 'chart' | 'table';
  /** 报表内的编号（图 N / 表 N，各自连续）。 */
  no: number;
  /** 图注 / 表注。 */
  caption: string;
  /** 这项展示的数据来源链（整份复制进报表级节点表）。 */
  origin: DataOrigin;
  /** 实际展示的数据（最终展示数据）。 */
  data: unknown;
  /** 绘图规格 / 展示规格。 */
  spec: unknown;
}

/** 一行 `![注解](路径)` 解析出来的东西：要内联的内容，加上它自带的材料。
 *  调用方负责解析路径、读文件；这里只管怎么放进页面。 */
export type DisplaySource =
  | { kind: 'chart'; svg: string; origin: DataOrigin; data: unknown; spec: unknown }
  | { kind: 'table'; markdown: string; origin: DataOrigin; data: unknown; spec: unknown };

/** 引用的解析器：路径不认识、文件不在、材料缺失都在这里报出来（报告整份失败）。 */
export type DisplayRenderer = (href: string) => { source: DisplaySource } | { error: string };

/** 报表级来源结构在文件里的标记名与容量上限。 */
export const PROVENANCE_KEY = 'dsh-oks-provenance';
export const REPORT_PROVENANCE_MAX_BYTES = 4 * 1024 * 1024;

/** 报表级的 data：章节骨架（`chapters`）+ 展示项（`items`，各自带着最终展示数据与规格）。
 *  骨架与数据都进文件，于是读结构、读数据都能用 jq 投影，不必再解析 HTML。 */
export interface ReportData {
  chapters: Array<{
    caption: string | null;
    level: string | null;
    figures: Array<{ ref: string; kind: string; caption: string }>;
    tables: Array<{ ref: string; caption: string }>;
  }>;
  /** 正文里手打的表（没有编号 chip、没有来源的那种）的个数。 */
  plainTables: number;
  items: Array<{ kind: string; no: number; caption: string; root: string; spec: unknown; data: unknown }>;
}

/** 报表级来源结构：**报表自己也是一个操作**——根指向"组装这份报告"那个节点，
 *  它的 `inputs` 是各展示项的根；于是"一件产物恰好一个 origin"对报告也成立。
 *  自述写在页面的 `<meta name="dsh-oks-artifact">` 里，这一块于是只有来源与数据。 */
export type ReportProvenance = EnvelopeParts<ReportData>;

/** 把来源结构包成页面里的一块：`type="application/json"` 不是脚本，浏览器不执行它。
 *
 *  `<` 必须写成 JSON 的 `\u003c` 转义，**不能**用 HTML 实体（`&lt;`）：`<script>` 是
 *  所谓 raw text 元素，元素里的内容是原样文本，HTML 实体在这里**不会被还原**——
 *  用 `&lt;` 会让 JSON 变成一段解不开的字符串。反过来，属性里（如产物自述的 `<meta content="…">`）
 *  就该用 `&lt;`，那里的实体由 HTML 解析器还原。两处的正确写法不同，别混。 */
export const provenanceBlockHtml = (payload: ReportProvenance): string =>
  `<script type="application/json" id="${PROVENANCE_KEY}">`
  + JSON.stringify(payload).replace(/</g, '\\u003c')
  + '</script>';

/** 从报告里读回来源结构；读不到就是 null。 */
export function readReportProvenance(html: string): ReportProvenance | null {
  const raw = new RegExp(`<script type="application/json" id="${PROVENANCE_KEY}">([\\s\\S]*?)</script>`).exec(html)?.[1];
  if (raw === undefined) return null;
  try {
    // 写进去时把 `<` 换成 JSON 的 `\u003c` 转义，JSON.parse 自己会还原成 `<`——
    // 不能再手工替换一遍：数据里真有一段字面量 `\u003c` 时，那会把 JSON 改坏。
    const value = JSON.parse(raw) as ReportProvenance;
    return value?.origin === undefined || value?.data === undefined ? null : value;
  } catch {
    return null;
  }
}

/** 一份报告的素材。 */
export interface ReportInput {
  title: string;
  /** 副标题：通常是时间窗。 */
  subtitle: string | null;
  /** 生成时间（UTC ISO 字符串），由调用方给，便于测试。 */
  generatedAt: string;
  /** 正文 markdown：章节、叙述与图表的落点都在这里。 */
  markdown: string;
  /** 引用已经落盘的展示件（图 / 表）：由调用方负责解析路径、读文件与取材料。 */
  display: DisplayRenderer;
  /** 正文渲染完之后，用收集到的展示项与渲染出的正文拼出要嵌进页面的来源结构。 */
  provenanceBlock: (items: readonly DisplayItem[], body: string) => string;
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
.table-block { margin: 18px 0 22px; }
.table-block .table-scroll { overflow-x: auto; }
figure svg.chart { display: block; width: 100%; height: auto; border: 1px solid #e9eef5; border-radius: 10px; background: #fff; }
figcaption { color: #6b7b8c; font-size: 12.5px; margin-top: 8px; }
/* 有来源的展示项才戴这枚编号 chip：手打的表没有编号，于是"有没有 chip"就是
   "这段数字有没有来路"的视觉信号。 */
.item-no { display: inline-block; padding: 1px 9px; margin-right: 8px; border-radius: 999px;
           background: #edf3fc; color: #3f5d8f; font-weight: 600; font-size: 12px; letter-spacing: .3px; }
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
  let tableIndex = 0;
  const items: DisplayItem[] = [];
  // 编号由这里统一给（图 N / 表 N 各自连续），agent 只写注解。
  // **取不到材料就让整份报告失败**：报表是交付物，缺一张图/一张表就不是完整交付，
  // 不能悄悄少一件——报错里带着是哪一行引用、该怎么写，调用方据此修。
  const place = (href: string, alt: string): string => {
    const rendered = input.display(href);
    if ('error' in rendered) throw new Error(rendered.error);
    const source = rendered.source;
    const caption = alt === '' ? '' : alt;
    const at = items.length + 1;
    if (source.kind === 'chart') {
      figureIndex += 1;
      items.push({ kind: 'chart', no: figureIndex, caption, origin: source.origin, data: source.data, spec: source.spec });
      const html = buildFigureHtml(source.svg, null)
        .replace('<figure>', `<figure data-oks-item="${at}" id="oks-item-${at}">`);
      return caption === '' ? html : html.replace(
        '</figure>',
        `<figcaption><span class="item-no">图 ${figureIndex}</span>${escapeHtml(caption)}</figcaption></figure>`,
      );
    }
    tableIndex += 1;
    items.push({ kind: 'table', no: tableIndex, caption, origin: source.origin, data: source.data, spec: source.spec });
    const captionHtml = caption === ''
      ? ''
      : `<figcaption><span class="item-no">表 ${tableIndex}</span>${escapeHtml(caption)}</figcaption>`;
    return `<figure class="table-block" data-oks-item="${at}" id="oks-item-${at}">`
      + `<div class="table-scroll">${renderMarkdown(source.markdown, (_info, text) => `<pre><code>${escapeHtml(text)}</code></pre>`)}</div>${captionHtml}</figure>`;
  };
  const body = renderMarkdown(
    input.markdown,
    (info, text) => {
      // 围栏按代码块呈现，内容转义不解释。`chart` 这条入口已经不接受——报告里的图只有一种来源：
      // 工作区里**已经画好**的 SVG。所以这里不是"解析失败"，而是明确指回去该怎么做。
      if (info === 'chart') {
        return '<div class="figure-error">报告里的图不再用 chart 块：先用 oks_chart 画一次，'
          + '再把回执给你的那一行 ![标题](.oks/figures/xxx.bar.svg) 独占一行放进正文。</div>';
      }
      return `<pre><code${safeLanguage(info)}>${escapeHtml(text)}</code></pre>`;
    },
    // 独占一行的图片：注解取 `alt`，内容由调用方从工作区里读出来内联（图或表）。
    (alt, href) => place(href, alt),
  );

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
${input.provenanceBlock(items, anchored)}
</head>
<body>
<header>
<h1>${escapeHtml(input.title)}</h1>
${input.subtitle === null ? '' : `<p class="subtitle">${escapeHtml(input.subtitle)}</p>`}
<p class="meta">生成于 ${escapeHtml(input.generatedAt)}</p>
</header>
${nav === '' ? '' : `<nav><span class="nav-title">目录</span>${nav}</nav>`}
${anchored}
<footer>本报告由 oks 插件生成 · 单文件自足；每个图表展示项的最终数据与完整来源链都在页面里（${PROVENANCE_KEY}）</footer>
</body>
</html>
`;
};
