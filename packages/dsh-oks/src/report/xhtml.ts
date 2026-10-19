/** 结构区的 XHTML：一个受控子集，三处输入共用这一个解析器。
 *
 *  三处输入各有各的严格度，但都只走这里：
 *  - **作者提交的 `spec.articleFile` 正文**：唯一不可信输入，白名单、显式自闭合、注释与实体规则都在
 *    `checkAuthorXhtml` 里查，报错带行列；
 *  - **图表件的 `.svg`**：echarts 生成、我们写的 `<metadata>` 夹在里面，按标记整段剥掉；
 *  - **我们生成的报告页面**：读回时提取 `article` 并按规则缩水。
 *
 *  为什么用 `xmlns: false`：我们要的是"名字原样进出"，不是"解释命名空间"。元素与属性名按词法
 *  处理，`xmlns`、`xmlns:xlink`、`xlink:href` 这些都当普通名字透传（内联 SVG 靠 `xmlns` 进外国语
 *  命名空间，浏览器自己认）。作者侧要不要允许带前缀的名字，是白名单的事，与解析无关。
 *
 *  为什么只需要"过滤式重写"：三个用途都只做一件事——把一棵树按规则重写成另一份文本。遇标记就
 *  进入抑制态、到配对结束标签退出，因此嵌套天然按最外层决定，也不需要 DOM 或第三方序列化器。
 *  输出规范化引号与实体（RFC 0008 §4 明确不要求字节级不变），注释按范围保留。
 */
import { SaxesParser } from 'saxes';

/** 一条结构化错误：机器可读的 `code` + 给人看的话 + 位置（行、列均从 1 起）。 */
export interface XhtmlError {
  code: string;
  message: string;
  line: number;
  column: number;
  /** 出错的元素名；与位置无关的错误（例如良构失败）为 null。 */
  element: string | null;
}

/** 作者正文允许的元素（RFC 0008 §4）。名字逐字比对，因此带前缀的名字不在其中。 */
export const AUTHOR_ELEMENTS: readonly string[] = [
  'article', 'section',
  'h1', 'h2', 'h3',
  'p', 'div', 'span',
  'figure', 'figcaption',
  'table', 'caption', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td',
  'ul', 'ol', 'li',
  'blockquote', 'pre', 'code',
  'strong', 'em', 'a', 'br', 'hr',
];

/** 作者正文允许的属性。`data-oks-ref` / `data-oks-pick` / `data-oks-shrink` 是仅有的专用语义。 */
export const AUTHOR_ATTRIBUTES: readonly string[] = [
  'id', 'class', 'title', 'lang',
  'data-oks-ref', 'data-oks-pick', 'data-oks-shrink', 'data-oks-lit',
  'href', 'colspan', 'rowspan', 'scope',
];

/** 图表件里我们自己的两段材料：内联进报告时整段剥掉，报告元数据是它们唯一的家。 */
const CHART_METADATA_IDS = new Set(['dsh-oks-artifact', 'dsh-oks-chart-input']);

/** 只能写成自闭合形式的空元素：正文里不许出现"靠标签名当闭合"的写法。 */
const VOID_ELEMENTS = new Set(['br', 'hr']);

/** 文本摘要里的块边界合并为空白，行内元素保持文字连接。 */
const PREVIEW_BLOCKS = new Set(['section', 'h1', 'h2', 'h3', 'p', 'div', 'ul', 'ol', 'li',
  'table', 'caption', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'blockquote', 'pre', 'br', 'hr']);
const PREVIEW_SKIP = new Set(['figure', 'svg', 'script', 'style', 'metadata']);

/** 表格 `scope` 的合法取值。 */
const SCOPES = new Set(['col', 'row', 'colgroup', 'rowgroup']);

/** 摘取路径的一段：对象字段名或数组下标。 */
const PICK_SEGMENT = /^(?:[A-Za-z_][A-Za-z0-9_]*|\d+)$/;

/** 一个开始标签的只读视图。 */
export interface TagView {
  name: string;
  attributes: Record<string, string>;
  selfClosing: boolean;
  /** 行号，从 1 起。 */
  line: number;
  /** 列号，从 1 起。 */
  column: number;
}

/** 对一个元素的处理方式——过滤式重写的全部策略。 */
export type ElementPolicy =
  /** 整个元素（开始标签、子节点、结束标签）都不要。 */
  | { kind: 'drop' }
  /** 保留元素与属性，清空全部子节点。 */
  | { kind: 'clear' }
  /** 保留元素与属性，子节点换成这段纯文本。 */
  | { kind: 'replace'; text: string }
  /** 保留元素与属性，子节点换成我们自己的标记注释（例如省略标记）。 */
  | { kind: 'comment'; text: string }
  /** 保留元素与属性，将后代正文文本限长后放入注释。 */
  | { kind: 'preview'; limit: number }
  /** 子节点照旧，可在开始标签之后、结束标签之前各追加一段（可信的）标记。 */
  | { kind: 'keep'; append?: string; prepend?: string };

export interface RewriteHooks {
  /** 每个元素问一次：返回 undefined 表示原样保留。 */
  policy?: (tag: TagView) => ElementPolicy | undefined;
  /** 生成侧用：改写出这个元素的属性；返回 undefined 表示按原样写。 */
  attributes?: (tag: TagView) => Record<string, string> | undefined;
  /** 读到的每段注释（含被抑制子树里的；缩水要按范围决定留不留）。 */
  comment?: (text: string) => void;
  /** 每个元素结束时报告一次名字：渲染侧靠它维护"当前在哪个 figure 里"这类状态。 */
  close?: (name: string) => void;
  /** 只输出这个元素（连同它的子节点）：页面读回时用来取 `article`。 */
  capture?: string;
}

export interface RewriteResult {
  xml: string;
  errors: XhtmlError[];
}

export const escapeText = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export const escapeAttribute = (value: string): string =>
  escapeText(value).replace(/"/g, '&quot;');

/** 注释中的连续连字符以空格分隔；两侧空格同时保护以连字符结尾的文本。 */
const commentText = (value: string): string =>
  `<!-- ${value.replace(/-(?=-)/g, '- ')} -->`;

/** 属性按读出顺序重新写一遍；引号统一成双引号，值里的 `&`、`<`、`"` 转义。 */
const attributeText = (attributes: Record<string, string>): string =>
  Object.entries(attributes).map(([name, value]) => ` ${name}="${escapeAttribute(value)}"`).join('');

interface Frame {
  name: string;
  /** 是否写出结束标签：被祖先抑制或整体丢弃时为 false。 */
  emitEnd: boolean;
  /** 结束标签前要追加的可信标记。 */
  append: string;
  /** 压栈时把抑制计数加了 1：出栈时要减回去。 */
  counted: boolean;
}

/** 把一份 XML 文本按策略重写成另一份文本。 */
export function rewriteXml(xml: string, hooks: RewriteHooks = {}): RewriteResult {
  const out: string[] = [];
  const errors: XhtmlError[] = [];
  const frames: Frame[] = [];
  const capture = hooks.capture;
  let capturing = capture === undefined;
  /** 捕获目标之上的帧数；回到这个高度说明目标已经结束。 */
  let captureFloor = 0;
  /** 处于抑制态的元素个数：大于 0 时子节点不输出。 */
  let muted = 0;
  // 最外层摘要控制整个子树；只收集限长前缀，内联图表及其元数据独立跳过。
  let preview: { depth: number; limit: number; chars: string[]; pendingSpace: boolean;
    clipped: boolean; comment?: string; commentCount: number; ignoredDepth?: number } | undefined;
  const previewText = (text: string): void => {
    if (preview === undefined || preview.clipped || preview.ignoredDepth !== undefined) return;
    for (const char of text) {
      if (/\s/u.test(char)) {
        preview.pendingSpace = preview.chars.length > 0;
        continue;
      }
      if (preview.pendingSpace) {
        if (preview.chars.length >= preview.limit) { preview.clipped = true; return; }
        preview.chars.push(' ');
        preview.pendingSpace = false;
      }
      if (preview.chars.length >= preview.limit) { preview.clipped = true; return; }
      preview.chars.push(char);
    }
  };
  const parser = new SaxesParser({ xmlns: false });
  const at = (): { line: number; column: number } => ({ line: parser.line, column: parser.column + 1 });
  const view = (tag: { name: string; attributes: Record<string, string>; isSelfClosing: boolean }): TagView => ({
    name: tag.name,
    attributes: tag.attributes,
    selfClosing: tag.isSelfClosing,
    ...at(),
  });
  /** 压入一帧；`muted: true` 表示这一帧的子节点不输出。 */
  const push = (name: string, frame: { muted: boolean; emitEnd: boolean; append?: string }): void => {
    if (frame.muted) muted += 1;
    frames.push({
      name,
      emitEnd: frame.emitEnd,
      append: frame.append ?? '',
      counted: frame.muted,
    });
  };

  parser.on('error', (error: Error) => {
    errors.push({ code: 'xhtml-not-well-formed', message: error.message, ...at(), element: null });
  });

  parser.on('opentag', (tag) => {
    const seen = view(tag);
    if (!capturing) {
      if (seen.name === capture) {
        capturing = true;
        captureFloor = frames.length;
      } else {
        // 捕获之前的元素只占位：不输出，也不改变抑制计数（`!capturing` 已经挡住了文本）。
        frames.push({ name: seen.name, emitEnd: false, append: '', counted: false });
        return;
      }
    }
    if (muted > 0) {
      if (preview !== undefined && preview.ignoredDepth === undefined) {
        if (PREVIEW_BLOCKS.has(seen.name) || PREVIEW_SKIP.has(seen.name)) previewText(' ');
        if (PREVIEW_SKIP.has(seen.name)) preview.ignoredDepth = frames.length + 1;
      }
      push(seen.name, { muted: true, emitEnd: false });
      return;
    }
    const policy = hooks.policy?.(seen);
    if (policy?.kind === 'drop') {
      push(seen.name, { muted: true, emitEnd: false });
      return;
    }
    // 要往里放内容的策略一律写成配对形式：作者写 `<span … />` 或 `<figure … />` 时，
    // 值/内联的图也要落在容器里，而不是被吐到容器外面。
    const addsContent = policy?.kind === 'replace' || policy?.kind === 'comment' || policy?.kind === 'preview'
      || (policy?.kind === 'keep' && ((policy.append ?? '') !== '' || (policy.prepend ?? '') !== ''));
    const selfClose = tag.isSelfClosing && !addsContent;
    const rewritten = hooks.attributes?.(seen);
    out.push(`<${seen.name}${attributeText(rewritten ?? seen.attributes)}${selfClose ? ' /' : ''}>`);
    if (policy?.kind === 'replace') {
      out.push(escapeText(policy.text));
      push(seen.name, { muted: true, emitEnd: true });
      return;
    }
    if (policy?.kind === 'comment') {
      out.push(commentText(policy.text));
      push(seen.name, { muted: true, emitEnd: true });
      return;
    }
    if (policy?.kind === 'preview') {
      preview = { depth: frames.length + 1, limit: policy.limit, chars: [], pendingSpace: false,
        clipped: false, commentCount: 0 };
      push(seen.name, { muted: true, emitEnd: !selfClose });
      return;
    }
    if (policy?.kind === 'clear' && !selfClose) {
      push(seen.name, { muted: true, emitEnd: true });
      return;
    }
    if (policy?.kind === 'keep' && policy.prepend !== undefined) out.push(policy.prepend);
    push(seen.name, {
      muted: false,
      emitEnd: !selfClose,
      append: policy?.kind === 'keep' ? policy.append : undefined,
    });
  });

  parser.on('closetag', (tag) => {
    const frame = frames.pop();
    if (frame === undefined) return;
    hooks.close?.(tag?.name ?? frame.name);
    if (frame.counted) muted -= 1;
    if (preview?.ignoredDepth === frames.length + 1) preview.ignoredDepth = undefined;
    if (preview?.depth === frames.length + 1) {
      // 只有一个直接注释且没有正文时，它已是阅读摘要；再次读取保持原样。
      if (preview.chars.length === 0 && preview.commentCount === 1 && preview.comment !== undefined) {
        const prior = preview.comment.trim();
        const max = preview.limit + (prior.endsWith('...') ? 3 : 0);
        let length = 0;
        // 注释安全处理插入的连字符间空格不计入原文长度。
        for (const _ of prior.replace(/- (?=-)/g, '-')) { if (++length > max) break; }
        if (length <= max) out.push(commentText(prior));
        else {
          previewText(prior);
          out.push(commentText(preview.chars.join('').trimEnd() + (preview.clipped ? '...' : '')));
        }
      } else {
        out.push(commentText(preview.chars.join('').trimEnd() + (preview.clipped ? '...' : '')));
      }
      preview = undefined;
    } else if (PREVIEW_BLOCKS.has(frame.name)) {
      previewText(' ');
    }
    if (frame.append !== '') out.push(frame.append);
    if (frame.emitEnd) out.push(`</${tag?.name ?? frame.name}>`);
    if (capturing && capture !== undefined && frames.length === captureFloor) capturing = false;
  });

  parser.on('text', (text) => {
    if (!capturing) return;
    if (preview !== undefined) { previewText(text); return; }
    if (muted > 0) return;
    out.push(escapeText(text));
  });

  parser.on('comment', (text) => {
    hooks.comment?.(text);
    if (preview !== undefined && preview.ignoredDepth === undefined && frames.length === preview.depth) {
      preview.commentCount += 1;
      if (preview.commentCount === 1) preview.comment = text;
      else preview.comment = undefined;
    }
    if (!capturing || muted > 0) return;
    out.push(`<!--${text}-->`);
  });

  parser.on('cdata', (text) => {
    if (!capturing) return;
    if (preview !== undefined) { previewText(text); return; }
    if (muted > 0) return;
    out.push(escapeText(text));
  });

  parser.write(xml).close();
  return { xml: out.join(''), errors };
}

/** 省略标记。读回的那一份是给人（与 agent）读的**来源**，不是渲染件，所以标记写成注释：
 *  既不装作一个值（`??` 会被读成「槽位没填上」），也不会在渲染时冒出来。 */
const OMITTED = 'omitted';
/** 读回结构区时，结论段保留的 Unicode 码点数（空白归一化后计数）。 */
export const SHRINK_PREVIEW_CHARS = 30;

/** 读回结构：shrink 段落为限长文本注释，引用 span 为完整值注释，其余 ref 省略内联内容。 */
const shrinkPolicy = (tag: TagView): ElementPolicy | undefined => {
  if (tag.attributes['data-oks-shrink'] !== undefined) return { kind: 'preview', limit: SHRINK_PREVIEW_CHARS };
  if (tag.attributes['data-oks-ref'] !== undefined) return tag.name === 'span'
    ? { kind: 'preview', limit: Infinity }
    : { kind: 'comment', text: OMITTED };
  return undefined;
};

/** 缩水一段结构区（用于已经单独取出来的结构）。 */
export const shrinkStructure = (xml: string): RewriteResult =>
  rewriteXml(xml, { policy: shrinkPolicy });

/** 从报告页面里取回结构区；`shrink` 为真时同时执行缩水（读模型要的就是缩水后那份）。 */
export const extractStructure = (page: string, shrink: boolean): RewriteResult =>
  rewriteXml(page, { capture: 'article', ...(shrink ? { policy: shrinkPolicy } : {}) });

/** 读一个元素里的文本，用于取元数据 `<script>` 的内容。 */
export function readElementText(xml: string, matches: (tag: TagView) => boolean): string | null {
  const parser = new SaxesParser({ xmlns: false });
  const parts: string[] = [];
  let depth = 0;
  let inside = false;
  let found = false;
  parser.on('error', () => undefined);
  parser.on('opentag', (tag) => {
    if (inside) {
      depth += 1;
      return;
    }
    const seen: TagView = {
      name: tag.name, attributes: tag.attributes, selfClosing: tag.isSelfClosing,
      line: parser.line, column: parser.column + 1,
    };
    if (matches(seen)) {
      inside = true;
      found = true;
    }
  });
  parser.on('text', (text) => {
    if (inside) parts.push(text);
  });
  parser.on('cdata', (text) => {
    if (inside) parts.push(text);
  });
  parser.on('closetag', () => {
    if (!inside) return;
    if (depth === 0) inside = false;
    else depth -= 1;
  });
  parser.write(xml).close();
  return found ? parts.join('') : null;
}

/** 内联一张图表件：按标记整段剥掉我们自己的两段 `<metadata>`，其余（含 `xmlns` 与 `<style>`）保留。 */
export const stripChartMetadata = (svg: string): RewriteResult =>
  rewriteXml(svg, {
    policy: (tag) => (tag.name === 'metadata' && CHART_METADATA_IDS.has(tag.attributes['id'] ?? '')
      ? { kind: 'drop' }
      : undefined),
  });

/** 只做良构检查（不产出文本）：页面写入时的自校验用它。 */
export function checkWellFormed(xml: string): XhtmlError[] {
  const errors: XhtmlError[] = [];
  const parser = new SaxesParser({ xmlns: false });
  parser.on('error', (error: Error) => {
    errors.push({
      code: 'xhtml-not-well-formed', message: error.message,
      line: parser.line, column: parser.column + 1, element: null,
    });
  });
  parser.write(xml).close();
  return errors;
}

/** 作者提交的结构区校验：良构、白名单、显式自闭合、引用与摘取规则。 */
export function checkAuthorXhtml(xhtml: string): {
  errors: XhtmlError[];
  /** 结构区引用到的 item key（含位于 `data-oks-shrink` 元素内部的引用）。 */
  refs: string[];
  /** 读到的全部注释文本，按出现顺序。 */
  comments: string[];
  /** 值注入只发生在 `span` 上：这里按出现顺序给出每个取值点。 */
  picks: Array<{ ref: string; pick: string | undefined }>;
  /** 正文里的 `figure` 引用，按出现顺序（注释里的示例不算，实体已还原）。 */
  figures: string[];
  /** 章节：层级、正文文字与作者写的 `id`（没写就是 null），按出现顺序。 */
  headings: Array<{ level: number; text: string; id: string | null }>;
  /** 正文里"既没有 ref、也没有用 lit 声明为文字"的数字——告警，不进 errors。 */
  NumWithoutSource: Array<{ line: number; column: number; snippet: string }>;
  /** `data-oks-lit` 写在 span 以外的元素上——它不生效，子树照旧扫。 */
  LitNotOnSpan: Array<{ line: number; column: number; tag: string }>;
} {
  const errors: XhtmlError[] = [];
  const refs: string[] = [];
  const comments: string[] = [];
  const picks: Array<{ ref: string; pick: string | undefined }> = [];
  const figures: string[] = [];
  const headings: Array<{ level: number; text: string; id: string | null }> = [];
  let heading: { level: number; text: string[]; id: string | null } | null = null;
  const ids = new Set<string>();
  const numWithoutSource: Array<{ line: number; column: number; snippet: string }> = [];
  const litNotOnSpan: Array<{ line: number; column: number; tag: string }> = [];
  /** 进到 ref span / lit span / pre / code 里就静音：代码与引用里的数字不算「没来源」。 */
  let quiet = 0;
  const quietStack: boolean[] = [];
  const parser = new SaxesParser({ xmlns: false });
  const elements = new Set(AUTHOR_ELEMENTS);
  const attributes = new Set(AUTHOR_ATTRIBUTES);
  let depth = 0;
  const at = (): { line: number; column: number } => ({ line: parser.line, column: parser.column + 1 });
  const fail = (code: string, message: string, element: string | null): void => {
    errors.push({ code, message, ...at(), element });
  };

  parser.on('error', (error: Error) => {
    fail('xhtml-not-well-formed', `结构区不是良构 XML：${error.message}`, null);
  });

  parser.on('opentag', (tag) => {
    const name = tag.name;
    const own = tag.attributes;
    depth += 1;
    if (depth === 1 && name !== 'article') {
      fail('author-root', `结构区的最外层元素是 <article>；这里是 <${name}>。`, name);
    }
    if (depth > 1 && !elements.has(name)) {
      fail('author-element', `<${name}> 不在作者元素白名单里：正文用白名单内的元素，`
        + '嵌入图表用 <figure data-oks-ref="…">。', name);
    }
    for (const [key, value] of Object.entries(own)) {
      if (!attributes.has(key)) {
        fail('author-attribute', `属性 ${key} 不在作者属性白名单里：去掉它，或改用白名单内的属性。`, name);
      }
      if (key === 'id') {
        if (value === '') {
          fail('author-id', 'id 不能为空：给它一个报告内唯一的名字。', name);
        } else if (ids.has(value)) {
          fail('author-id', `id "${value}" 在这份报告里出现了两次：每个对象的 id 在报告内唯一。`, name);
        } else {
          ids.add(value);
        }
      }
      if (key === 'href' && !/^#|^https?:\/\//.test(value)) {
        fail('author-link', `链接 ${value} 不在允许范围内：写文内锚点（#…）或 http/https 地址。`, name);
      }
      if ((key === 'colspan' || key === 'rowspan') && !/^\d+$/.test(value)) {
        fail('author-number', `${key} 要写正整数；这里是 "${value}"。`, name);
      }
      if (key === 'scope' && !SCOPES.has(value)) {
        fail('author-scope', `scope 的取值是 col / row / colgroup / rowgroup；这里是 "${value}"。`, name);
      }
      if (key === 'data-oks-ref') {
        if (value === '') {
          fail('author-ref', 'data-oks-ref 不能为空：填 spec.inputs 里的绑定名。', name);
        } else {
          refs.push(value);
        }
      }
      if (key === 'data-oks-pick') {
        if (name !== 'span') {
          fail('author-pick-element', `data-oks-pick 只写在 span 上；<${name}> 用 data-oks-ref 引用完整对象。`, name);
        }
        if (own['data-oks-ref'] === undefined) {
          fail('author-pick-ref', 'data-oks-pick 要和同一个元素上的 data-oks-ref 一起写。', name);
        }
        if (value === '' || !value.startsWith('.')) {
          fail('author-pick', `data-oks-pick 要以 "." 开头（"." 表示对象根值）；这里是 "${value}"。`, name);
        } else if (value !== '.') {
          for (const segment of value.slice(1).split('.')) {
            if (!PICK_SEGMENT.test(segment)) {
              const suggestion = value.replace(/\[(\d+)\]/g, '.$1');
              fail('author-pick', `data-oks-pick 的路径段 "${segment}" 不合法：对象字段与数组下标均用点分段，例如 .rows.0.label。${suggestion !== value ? `建议路径：${suggestion}。` : ''}`, name);
              break;
            }
          }
        }
      }
    }
    if (own['data-oks-lit'] !== undefined && name !== 'span') {
      litNotOnSpan.push({ ...at(), tag: name });
    }
    const isQuiet = name === 'pre' || name === 'code'
      || (name === 'span' && (own['data-oks-ref'] !== undefined || own['data-oks-lit'] !== undefined));
    if (isQuiet) quiet += 1;
    quietStack.push(isQuiet);
    if (VOID_ELEMENTS.has(name) && !tag.isSelfClosing) {
      fail('author-void', `<${name}> 是空元素：写成 <${name} />。`, name);
    }
    if (name === 'figure' && own['data-oks-ref'] === undefined) {
      fail('author-figure-ref', 'figure 要写 data-oks-ref：图表引用 spec.inputs 里的绑定名。', name);
    }
    if (name === 'span' && own['data-oks-ref'] !== undefined && own['data-oks-ref'] !== '') {
      picks.push({ ref: own['data-oks-ref'], pick: own['data-oks-pick'] });
    }
    // 正文里的引用一律由解析器给出：注释里的示例不是元素，实体也已经还原成真值。
    if (name === 'figure' && own['data-oks-ref'] !== undefined && own['data-oks-ref'] !== '') {
      figures.push(own['data-oks-ref']);
    }
    if (name === 'h1' || name === 'h2' || name === 'h3') {
      heading = { level: Number(name[1]), text: [], id: own['id'] ?? null };
    }
  });

  parser.on('text', (text) => {
    if (heading !== null) heading.text.push(text);
    if (quiet > 0) return;
    const end = at();
    // 记号 = 字母/数字/下划线/点/连字符/斜杠连成的一串。含字母的记号是标识符或术语；
    // 数字紧跟 `#` 的（#123）是引用编号。
    // （P95、K8s、A-123、A_123、A123、A.1.2.3、HTTP/2），里面的数字不是业务数字。
    for (const token of text.matchAll(/[A-Za-z0-9_.\-/]+/g)) {
      if (/[A-Za-z]/.test(token[0])) continue;
      for (const match of token[0].matchAll(/[+-]?\d+/g)) {
        const index = (token.index ?? 0) + (match.index ?? 0);
        // 引用编号也不是业务数字：#123、##1。
        if (index > 0 && text[index - 1] === '#') continue;
        const before = text.slice(0, index + match[0].length);
        const column = before.includes('\n') ? end.column : Math.max(1, end.column - text.length + index);
        numWithoutSource.push({
          line: end.line,
          column,
          snippet: text.slice(Math.max(0, index - 10), index + match[0].length + 10).replace(/\s+/g, ' ').trim(),
        });
      }
    }
  });

  parser.on('closetag', (tag) => {
    if (quietStack.pop()) quiet -= 1;
    if (heading !== null && tag?.name === `h${heading.level}`) {
      headings.push({ level: heading.level, text: heading.text.join('').trim(), id: heading.id });
      heading = null;
    }
    depth -= 1;
  });

  parser.on('comment', (text) => {
    comments.push(text);
  });

  parser.on('doctype', () => fail('author-prolog', '结构区不要 DOCTYPE：它只是一段正文。', null));
  parser.on('cdata', () => fail('author-cdata', '结构区不要 CDATA：正文直接写文本，& 写成 &amp;、< 写成 &lt;。', null));

  parser.write(xhtml).close();
  return { errors, refs, comments, picks, figures, headings, NumWithoutSource: numWithoutSource, LitNotOnSpan: litNotOnSpan };
}
