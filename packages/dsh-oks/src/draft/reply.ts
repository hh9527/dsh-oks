import { SaxesParser } from 'saxes';
import { extractStructure, escapeAttribute, escapeText } from '../report/xhtml.ts';

type Element = { tag: string; attrs: Record<string, string>; children: Node[] };
type Node = string | Element;
const text = (node: Node): string => typeof node === 'string' ? node : node.children.map(text).join('');
const escapeMd = (value: string) => value.replace(/([\\`*_{}\[\]()#+.!|>~])/g, '\\$1');
const serialize = (node: Node): string => typeof node === 'string' ? escapeText(node)
  : `<${node.tag}${Object.entries(node.attrs).map(([key, value]) => ` ${key}="${escapeAttribute(value)}"`).join('')}>${node.children.map(serialize).join('')}</${node.tag}>`;

/** Convert only the supported XHTML subset to native reply Markdown; never hand raw XHTML to the host. */
export function renderDraftReply(page: string, saveFigure: (svg: string, ref: string) => string): string {
  const structure = extractStructure(page, false);
  if (structure.errors.length) throw new Error(structure.errors[0].message);
  const root: Element = { tag: 'root', attrs: {}, children: [] };
  const stack = [root];
  const parser = new SaxesParser({ xmlns: false });
  parser.on('error', error => { throw error; });
  parser.on('opentag', tag => {
    const node: Element = { tag: tag.name, attrs: tag.attributes, children: [] };
    stack.at(-1)!.children.push(node);
    stack.push(node);
  });
  parser.on('closetag', () => { stack.pop(); });
  parser.on('text', value => { stack.at(-1)!.children.push(value); });
  parser.on('cdata', value => { stack.at(-1)!.children.push(value); });
  parser.write(structure.xml).close();
  const render = (node: Node): string => {
    if (typeof node === 'string') return escapeMd(node.replace(/\s+/g, ' '));
    const content = () => node.children.map(render).join('');
    switch (node.tag) {
      case 'root': case 'article': case 'section': case 'div': return `${content()}\n\n`;
      case 'h1': case 'h2': case 'h3': return `\n\n${'#'.repeat(Number(node.tag[1]))} ${content().trim()}\n\n`;
      case 'p': case 'figcaption': return `${content().trim()}\n\n`;
      case 'span': return content();
      case 'strong': return `**${content()}**`;
      case 'em': return `*${content()}*`;
      case 'br': return '  \n';
      case 'hr': return '\n\n---\n\n';
      case 'a': return `[${content()}](${(node.attrs.href ?? '').replaceAll('(', '%28').replaceAll(')', '%29')})`;
      case 'code': {
        const raw = text(node);
        const marker = '`'.repeat(Math.max(1, ...[...raw.matchAll(/`+/g)].map(match => match[0].length + 1)));
        return `${marker} ${raw} ${marker}`;
      }
      case 'pre': {
        const raw = text(node);
        const fence = '`'.repeat(Math.max(3, ...[...raw.matchAll(/`+/g)].map(match => match[0].length + 1)));
        return `\n\n${fence}\n${raw}\n${fence}\n\n`;
      }
      case 'blockquote': return `\n\n${content().trim().split('\n').map(line => `> ${line}`).join('\n')}\n\n`;
      case 'ul': case 'ol': {
        let index = 0;
        const lines = node.children.filter(child => typeof child !== 'string' || child.trim()).map(child => {
          if (typeof child === 'string' || child.tag !== 'li') throw new Error('Reply lists require li children');
          const marker = node.tag === 'ul' ? '- ' : `${++index}. `;
          return marker + child.children.map(render).join('').trim().replaceAll('\n', '\n' + ' '.repeat(marker.length));
        });
        return '\n\n' + lines.join('\n') + '\n\n';
      }
      case 'table': {
        const rows: string[][] = [];
        const collect = (parent: Element) => {
          for (const child of parent.children) {
            if (typeof child === 'string') { if (child.trim()) throw new Error('Unsupported text in reply table'); continue; }
            if (child.tag === 'thead' || child.tag === 'tbody' || child.tag === 'tfoot') collect(child);
            else if (child.tag === 'tr') {
              const cells = child.children.filter(item => typeof item !== 'string' || item.trim()).map(cell => {
                if (typeof cell === 'string' || !['td', 'th'].includes(cell.tag)) throw new Error('Reply table requires td/th cells');
                if ((cell.attrs.colspan && cell.attrs.colspan !== '1') || (cell.attrs.rowspan && cell.attrs.rowspan !== '1')) throw new Error('Reply tables do not support merged cells; use artifact delivery');
                return cell.children.map(render).join('').trim().replace(/\n+/g, ' ');
              });
              rows.push(cells);
            } else if (child.tag !== 'caption') throw new Error(`Unsupported reply table element ${child.tag}`);
          }
        };
        collect(node);
        if (!rows.length) return '';
        const width = rows[0].length;
        if (!width || rows.some(row => row.length !== width)) throw new Error('Reply table must be rectangular; use artifact delivery');
        const caption = node.children.find(child => typeof child !== 'string' && child.tag === 'caption');
        const format = (row: string[]) => `| ${row.join(' | ')} |`;
        return '\n\n' + (caption ? render(caption) : '') + [format(rows[0]), format(rows[0].map(() => '---')), ...rows.slice(1).map(format)].join('\n') + '\n\n';
      }
      case 'caption': return content().trim() + '\n\n';
      case 'figure': {
        const svg = node.children.find(child => typeof child !== 'string' && child.tag === 'svg');
        const caption = node.children.filter(child => typeof child !== 'string' && child.tag === 'figcaption').map(render).join('');
        if (svg && typeof svg !== 'string') {
          const ref = node.attrs['data-oks-ref'];
          if (!ref) throw new Error('Reply figure has no source reference');
          return `\n\n${caption}![${escapeMd('图')}](${saveFigure(serialize(svg), ref)})\n\n`;
        }
        return '\n\n' + content() + '\n\n';
      }
      default: throw new Error(`Unsupported reply element ${node.tag}; use artifact delivery`);
    }
  };
  return render(root).trim();
}
