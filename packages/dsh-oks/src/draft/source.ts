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
  /** Saxes counts Unicode scalars; public offsets/columns count UTF-16 code units. */
  scalarOffset(line:number,column:number):number {
    const start=this.lines[line-1]??this.text.length;
    const end=this.lines[line]??this.text.length;
    let offset=start;
    for(let index=1;index<column&&offset<end;index++)offset+=this.text.codePointAt(offset)!>0xffff?2:1;
    return offset;
  }
  span(start:number,end:number):Span {
    if(end<start)throw new Error('Invalid original source range');
    return {start:this.position(start),end:this.position(end)};
  }
  fragment(name:string,language:'jq'|'pipeline'|'xhtml',start:number,end:number):SourceFragment {
    this.span(start,end);return new SourceFragment(this,name,language,start,end);
  }
}
export class SourceFragment {
  readonly text:string;
  readonly file:SourceFile; readonly name:string; readonly language:'jq'|'pipeline'|'xhtml'; readonly start:number; readonly end:number;
  constructor(file:SourceFile,name:string,language:'jq'|'pipeline'|'xhtml',start:number,end:number){
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
