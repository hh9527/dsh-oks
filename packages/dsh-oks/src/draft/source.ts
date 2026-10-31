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
  fragment(name:string,language:'sql'|'pipeline',start:number,end:number):SourceFragment {
    this.span(start,end);return new SourceFragment(this,name,language,start,end);
  }
}
export class SourceFragment {
  readonly text:string;
  readonly file:SourceFile; readonly name:string; readonly language:'sql'|'pipeline'; readonly start:number; readonly end:number;
  constructor(file:SourceFile,name:string,language:'sql'|'pipeline',start:number,end:number){
    this.file=file;this.name=name;this.language=language;this.start=start;this.end=end;
    this.text=file.text.slice(start,end);
  }
  /** A language module supplies fragment-relative offsets; all public spans are original UTF-16. */
  locate(start:number,end:number,unit:'utf16'|'utf8'='utf16'):{file:string;span:Span} {
    const local=(offset:number)=>{
      const length=unit==='utf8'?Buffer.byteLength(this.text):this.text.length;
      if(!Number.isInteger(offset)||offset<0||offset>length)throw new Error('Invalid fragment offset');
      if(unit==='utf16')return offset;
      const prefix=Buffer.from(this.text).subarray(0,offset).toString('utf8');
      if(Buffer.byteLength(prefix)!==offset)throw new Error('UTF-8 offset splits a code point');
      return prefix.length;
    };
    if(end<start)throw new Error('Invalid fragment range');
    return {file:this.file.path,span:this.file.span(this.start+local(start),this.start+local(end))};
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
