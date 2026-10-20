/** Explicit one-shot migration. Original source is never overwritten. */
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { parseMarkdownDraft } from './markdown-source.ts';
import { splitQueryCalls } from './split-query.ts';
import { parseDraft } from '../src/draft/document.ts';
export function migrateDraft(source:string):string {
 const parsed=parseMarkdownDraft(source);
 const tree=fromMarkdown(source);
 let region:string|undefined;let pipeline='';const prose:string[]=[];
 for(const block of tree.children){
  if(block.type==='heading'&&block.depth<=2){
   const text=block.children.map(child=>'value' in child?child.value:'').join('');
   region=block.depth===2&&['pipeline','assets'].includes(text)?text:undefined;
   if(region)continue;
  }
  if(block.type==='code'&&region){
   if(region==='pipeline')pipeline=block.value;
   continue;
  }
  if(block.position)prose.push(source.slice(block.position.start.offset!,block.position.end.offset!));
 }
 const notes=prose.join('\n\n');
 if(notes.includes('</Notes>'))throw new Error('Notes contain reserved </Notes>; migrate this text manually');
 const title=(parsed.title??'Report').replaceAll('&','&amp;').replaceAll('"','&quot;');
 const assets=[...parsed.assets.values()].map(asset=>`<Asset language="${asset.language}" name="${asset.name}">${asset.source}</Asset>`);
 const result=`<Dari title="${title}">\n<Notes>${notes}</Notes>\n<Pipeline>\n${pipeline}\n</Pipeline>\n${assets.join('\n')}\n</Dari>\n`;
 parseDraft(result,'migrated.dari');
 return splitQueryCalls(result);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const [src,dst]=process.argv.slice(2);
 if(!src?.endsWith('.md')||!dst?.endsWith('.dari'))throw new Error('Usage: node scripts/migrate-draft.ts source.md destination.dari');
 const content=migrateDraft(readFileSync(src,'utf8'));
 writeFileSync(dst,content,{flag:'wx'});
 console.log(`Created ${dst}; original preserved`);
}
