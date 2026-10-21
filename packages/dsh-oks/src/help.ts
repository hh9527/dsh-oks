import { fromMarkdown } from 'mdast-util-from-markdown';

/** Markdown 的标题层级对应知识字段；正文保留 Markdown，JSON 代码块承载结构化示例。 */
export function readHelpMarkdown(source: string): Record<string, any> {
  const headings = fromMarkdown(source).children.filter(node => node.type === 'heading' && node.depth >= 2);
  const root: Record<string, any> = {};
  const stack: {depth: number; value: Record<string, any>}[] = [{depth: 1, value: root}];
  for (let index = 0; index < headings.length; index++) {
    const heading = headings[index];
    if (heading.type !== 'heading') continue;
    const key = source.slice(heading.position!.start.offset!, heading.position!.end.offset!).replace(/^#+\s+/, '').trim();
    while (stack.at(-1)!.depth >= heading.depth) stack.pop();
    if (heading.depth !== stack.at(-1)!.depth + 1) throw new Error(`Skipped help heading level: ${key}`);
    const parent = stack.at(-1)!.value;
    if (Object.hasOwn(parent, key)) throw new Error(`Duplicate help heading: ${key}`);
    const next = headings[index + 1];
    const body = source.slice(heading.position!.end.offset!, next?.position?.start.offset ?? source.length).trim();
    let value: unknown;
    if (next?.type === 'heading' && next.depth > heading.depth) {
      if (body) throw new Error(`Help branch must contain field headings: ${key}`);
      value = {};
      stack.push({depth: heading.depth, value: value as Record<string, any>});
    } else {
      const nodes = fromMarkdown(body).children;
      const code = nodes.length === 1 && nodes[0].type === 'code' ? nodes[0] : undefined;
      value = code?.lang === 'json' ? JSON.parse(code.value) : code?.lang === 'source' ? code.value : body;
    }
    Object.defineProperty(parent, key, {value, enumerable: true, writable: true, configurable: true});
  }
  return root;
}
