/** Original-document coordinates shared by independent language modules. */
import type { Position, Span } from './pipeline.ts';
export class SourceFile {
  readonly lines=[0];
  readonly path:string; readonly text:string;
  constructor(path:string,text:string){
    this.path=path;this.text=text;
    for(let i=0;i<text.length;i++)if(text[i]==='\n')this.lines.push(i+1);
  }
  position(offset:number):Position {
    if(!Number.isInteger(offset)||offset<0||offset>this.text.length)throw new Error('Invalid original source offset');
    let lo=0,hi=this.lines.length;
    while(lo+1<hi){const mid=(lo+hi)>>1;if(this.lines[mid]<=offset)lo=mid;else hi=mid;}
    return {offset,line:lo+1,column:offset-this.lines[lo]+1};
  }
  span(start:number,end:number):Span {
    if(end<start)throw new Error('Invalid original source range');
    return {start:this.position(start),end:this.position(end)};
  }
}

/** Bounded original-source excerpt; the column remains an exact UTF-16 coordinate. */
export function sourceExcerpt(source:SourceFile,span:Span) {
  const offset=Math.max(0,Math.min(source.text.length,span.start.offset));
  const position=source.position(offset),start=source.lines[position.line-1];
  const end=source.text.indexOf('\n',start),line=source.text.slice(start,end<0?undefined:end).replace(/\r$/,'');
  let left=Math.max(0,offset-start-80),right=Math.min(line.length,offset-start+160);
  // Keep surrogate pairs intact when clipping a long source line.
  if(left>0&&/[\uDC00-\uDFFF]/.test(line[left]??''))left--;
  if(right<line.length&&/[\uDC00-\uDFFF]/.test(line[right]??''))right++;
  const expand=(text:string)=>text.replaceAll('\t','    ');
  const prefix=left?'…':'';
  const text=prefix+expand(line.slice(left,right))+(right<line.length?'…':'');
  const width=(text:string)=>[...text].reduce((n,ch)=>n+(/\p{Mark}/u.test(ch)?0:/[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE10-\uFE6F\uFF01-\uFF60\uFFE0-\uFFE6]|[\u{1F300}-\u{1FAFF}]/u.test(ch)?2:1),0);
  return {line:position.line,column:position.column,text,marker:' '.repeat(width(prefix+expand(line.slice(left,offset-start))))+'^'};
}
