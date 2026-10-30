import { fromMarkdown } from 'mdast-util-from-markdown';
export { parseMarkdownDraft as parseMarkdownFixture } from './scripts/markdown-source.ts';
/** 仅供历史测试夹具转换；产品只编译 DARI。 */
export function asDari(source:string):string {
  if(source.trimStart().startsWith('<Dari'))return source;
  const tree=fromMarkdown(source);let pipeline='';const assets:string[]=[];
  for(const block of tree.children)if(block.type==='code'){
    if(block.lang==='js')pipeline+=block.value+'\n';
    else if(block.lang==='sql'&&block.meta){const match=/^name="([^"]+)"$/.exec(block.meta);if(match)assets.push(`<Asset language="sql" name="${match[1]}">\n${block.value}\n</Asset>`);}
  }
  const title=/^# (.+)$/m.exec(source)?.[1]?.replaceAll('&','&amp;').replaceAll('"','&quot;')??'Report';
  return `<Dari title="${title}">\n<Pipeline>\n${pipeline}</Pipeline>\n${assets.join('\n')}\n</Dari>`+(source.match(/\s*$/)?.[0]??'');
}
