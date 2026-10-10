/** 一个极小的 markdown 子集 → HTML 转换器。
 *
 *  为什么不用现成的解析器：报告是**我们**的产物，而 markdown 默认允许内嵌 HTML——那等于把
 *  "代码来自我们"这条边界交给一个通用解析器的选项去守。这里的子集是自己写的，只认白名单语法，
 *  其余一律按文本转义，行为完全可控、也没有新增依赖。
 *
 *  支持的语法：`#`/`##`/`###` 标题、段落、无序与有序列表、表格、围栏代码块、
 *  以及行内的加粗、斜体、行内代码与链接。**内嵌 HTML 不在其中**。
 *
 *  围栏代码块不在这里渲染：它交给调用方（`onFence`），因为 `chart` 块要画成图。 */
import type { Row } from './shared.ts';

/** 围栏的语言标注：只保留字母数字与少数符号，其余丢弃。
 *  它来自 agent，而 class 属性是要进 HTML 的——所以在这里白名单化，不直接透传。 */
export const safeLanguage = (info: string): string => {
  const match = info.trim().match(/^[A-Za-z0-9+#.-]{1,20}$/);
  return match === null ? '' : ` class="language-${match[0].toLowerCase()}"`;
};

/** 围栏块交给调用方处理：返回要插进 HTML 的内容。 */
export type FenceHandler = (info: string, body: string, index: number) => string;

/** HTML 转义——所有文本都从这里过。 */
export const escapeHtml = (value: string): string => value
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

/** 链接地址的白名单：页面内锚点与 http(s)。其余（比如 javascript:）一律不认，退回纯文本。 */
const safeHref = (href: string): string | null => {
  const trimmed = href.trim();
  if (trimmed.startsWith('#')) return trimmed;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return null;
};

/** 行内语法：先转义，再逐段替换受支持的标记。 */
export const renderInline = (text: string): string => {
  let html = escapeHtml(text);
  // 只放行 `<br>` 这一个标签：换行在报告里太常见，而它没有行为、也无法用别的语法表达。
  // 其余标签照旧是转义后的文本——"不开放内嵌 HTML"这条边界不变。
  html = html.replace(/&lt;br\s*\/?&gt;/gi, '<br>');
  // 行内代码优先，它的内容不该再被其它规则解释。
  const codes: string[] = [];
  html = html.replace(/`([^`]+)`/g, (_match, code: string) => {
    codes.push(`<code>${code}</code>`);
    return `\u0000${codes.length - 1}\u0000`;
  });
  // 链接：只认白名单地址，否则保留原样（记 `!` 让图片语法也走这条，虽然我们不支持图片）。
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (match, label: string, href: string) => {
    const safe = safeHref(href);
    return safe === null ? match : `<a href="${safe}">${label}</a>`;
  });
  html = html
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
  // 还原行内代码。
  html = html.replace(/\u0000(\d+)\u0000/g, (_match, index: string) => codes[Number(index)] ?? '');
  return html;
};

/** 一行是不是表格的分隔行（`| --- | --- |`）。 */
const isTableDivider = (line: string): boolean => /^\|?[\s:|-]+\|[\s:|-]*$/.test(line) && line.includes('-');

/** 把 `| a | b |` 拆成单元格。 */
const tableCells = (line: string): string[] => line
  .replace(/^\||\|$/g, '')
  .split('|')
  .map((cell) => cell.trim());

/** 段落的结尾：空行、标题、列表、表格、引用、分隔线、围栏都算。 */
const startsBlock = (line: string): boolean =>
  /^#{1,6}\s/.test(line)
  || /^```/.test(line)
  || /^\s*[-*]\s+/.test(line)
  || /^\s*\d+\.\s+/.test(line)
  || /^\s*>\s?/.test(line)
  || /^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)
  || line.trimStart().startsWith('|');

/**
 * 把 markdown 子集渲染成 HTML 片段。
 * `onFence` 处理围栏代码块；未识别的语法按普通文本输出，不会穿透成标记。
 */
export const renderMarkdown = (source: string, onFence: FenceHandler): string => {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let fenceIndex = 0;
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];

    // 围栏代码块：整段交给调用方。
    const fence = line.match(/^```(\S*)\s*$/);
    if (fence !== null) {
      const info = fence[1];
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !/^```\s*$/.test(lines[index])) {
        body.push(lines[index]);
        index += 1;
      }
      index += 1; // 吃掉收尾的 ```
      out.push(onFence(info, body.join('\n'), fenceIndex));
      fenceIndex += 1;
      continue;
    }

    if (line.trim() === '') {
      index += 1;
      continue;
    }

    // 分隔线。
    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      out.push('<hr>');
      index += 1;
      continue;
    }

    // 引用：连续的 `> ` 行合成一段，内部允许再走一遍解析（引用里也会有列表、加粗）。
    if (/^\s*>\s?/.test(line)) {
      const quoted: string[] = [];
      while (index < lines.length && /^\s*>\s?/.test(lines[index])) {
        quoted.push(lines[index].replace(/^\s*>\s?/, ''));
        index += 1;
      }
      out.push(`<blockquote>${renderMarkdown(quoted.join('\n'), onFence)}</blockquote>`);
      continue;
    }

    // 标题：`#` 与 `##` 都是章节级，`###` 及更深是子标题。
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading !== null) {
      const level = Math.min(3, heading[1].length);
      out.push(`<h${level}>${renderInline(heading[2].trim())}</h${level}>`);
      index += 1;
      continue;
    }

    // 表格：连续的 `|` 行，第二行是分隔行。
    if (line.trimStart().startsWith('|')) {
      const rows: string[][] = [];
      while (index < lines.length && lines[index].trimStart().startsWith('|')) {
        if (!isTableDivider(lines[index])) rows.push(tableCells(lines[index]));
        index += 1;
      }
      if (rows.length > 0) {
        const [head, ...body] = rows;
        const headHtml = head.map((cell) => `<th>${renderInline(cell)}</th>`).join('');
        const bodyHtml = body
          .map((cells) => `<tr>${cells.map((cell) => `<td>${renderInline(cell)}</td>`).join('')}</tr>`)
          .join('');
        out.push(`<table><thead><tr>${headHtml}</tr></thead><tbody>${bodyHtml}</tbody></table>`);
      }
      continue;
    }

    // 列表：连续的同种标记算一个列表。
    const bullet = line.match(/^\s*([-*]|\d+\.)\s+(.*)$/);
    if (bullet !== null) {
      const ordered = /\d+\./.test(bullet[1]);
      const tag = ordered ? 'ol' : 'ul';
      const items: string[] = [];
      while (index < lines.length) {
        const next = lines[index].match(/^\s*([-*]|\d+\.)\s+(.*)$/);
        if (next === null || /\d+\./.test(next[1]) !== ordered) break;
        items.push(`<li>${renderInline(next[2].trim())}</li>`);
        index += 1;
      }
      out.push(`<${tag}>${items.join('')}</${tag}>`);
      continue;
    }

    // 段落：一直到下一个块的开头或空行。段内的换行按 markdown 的规矩处理——
    // 行尾两个空格或一个反斜杠表示硬换行，其余的单换行合并成空格。
    // 硬换行先用哨兵占位，等行内渲染完再换成 <br>，免得它被当成普通文本转义掉。
    const paragraph: string[] = [];
    while (index < lines.length && lines[index].trim() !== '' && !startsBlock(lines[index])) {
      const raw = lines[index];
      // 硬换行要在 trim 之前判断——行尾的两个空格正是它的标记。
      const hard = / {2,}$/.test(raw) || /\\$/.test(raw);
      const text = raw.trim().replace(/\\$/, '');
      paragraph.push(hard ? `${text}\u0002` : text);
      index += 1;
    }
    if (paragraph.length > 0) {
      // 哨兵连同它后面那个连接空格一起换成 <br>，免得行首多出空白。
      out.push(`<p>${renderInline(paragraph.join(' ')).replace(/\u0002 ?/g, '<br>')}</p>`);
    } else index += 1; // 理论上到不了这里，防死循环。
  }

  return out.join('\n');
};

/** 围栏 `chart` 块的 JSON 解析结果。 */
export interface ChartFence {
  json: Record<string, unknown>;
}

/** 解析 `chart` 围栏块的内容：必须是 JSON 对象。 */
export const parseChartFence = (body: string): { fence: ChartFence } | { error: string } => {
  const text = body.trim();
  if (text === '') return { error: 'chart 块是空的' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    return { error: `chart 块里的 JSON 解析失败：${cause instanceof Error ? cause.message : String(cause)}` };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { error: 'chart 块里应当是一个 JSON 对象' };
  }
  return { fence: { json: parsed as Record<string, unknown> } };
};

/** 供类型使用：报告里的图最终要拿到的行。 */
export type FenceRows = readonly Row[];
