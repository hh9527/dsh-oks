/** Virtual text reads use the same line windows and presentation as the host read tool. */
export const READ_LIMIT = 2000;
export const READ_MAX_LINE_LENGTH = 2000;
export const READ_MAX_BYTES = 50 * 1024;
export const READ_STREAM_MIN_SIZE = 10 * 1024 * 1024;
export interface ReadResult {
  path:string;
  offset:number;
  lines:{number:number;text:string}[];
  totalLines:number;
}
export function readArgs(offset:unknown,limit:unknown) {
  const start=offset===undefined?1:offset;
  const count=limit===undefined?READ_LIMIT:limit;
  if(typeof start!=='number'||!Number.isInteger(start)||start<1)throw new Error('offset must be a positive integer');
  if(typeof count!=='number'||!Number.isInteger(count)||count<1)throw new Error('limit must be a positive integer');
  if(count>READ_LIMIT)throw new Error(`limit must be less than or equal to ${READ_LIMIT}`);
  return {offset:start,limit:count};
}
export async function readWindow(chunks:Iterable<string>|AsyncIterable<string>,path:string,offset:unknown,limit:unknown):Promise<ReadResult> {
  const request=readArgs(offset,limit);
  const lines:ReadResult['lines']=[];
  let totalLines=0,bytes=0,capped=false,buffer='';
  const append=(part:string)=>{if(buffer.length<=READ_MAX_LINE_LENGTH)buffer=(buffer+part).slice(0,READ_MAX_LINE_LENGTH+1);};
  const flush=()=>{
    totalLines++;
    const raw=buffer.endsWith('\r')?buffer.slice(0,-1):buffer;buffer='';
    if(capped||totalLines<request.offset||lines.length>=request.limit)return;
    const text=raw.length>READ_MAX_LINE_LENGTH?`${raw.substring(0,READ_MAX_LINE_LENGTH)}... (line truncated to ${READ_MAX_LINE_LENGTH} chars)`:raw;
    const size=Buffer.byteLength(text)+(lines.length>0?1:0);
    if(bytes+size>READ_MAX_BYTES){capped=true;return;}
    bytes+=size;lines.push({number:totalLines,text});
  };
  for await(const chunk of chunks){
    let start=0,next:number;
    while((next=chunk.indexOf('\n',start))!==-1){append(chunk.slice(start,next));flush();start=next+1;}
    append(chunk.slice(start));
  }
  if(buffer.length)flush();
  if(request.offset>totalLines&&!(totalLines===0&&request.offset===1))throw new Error(`offset ${request.offset} is out of range for "${path}" (${totalLines} lines)`);
  return {path,offset:request.offset,lines,totalLines};
}
export function formatRead(result:ReadResult,limit:unknown):string {
  const request=readArgs(result.offset,limit);
  const end=result.lines.at(-1)?.number??Math.max(0,result.offset-1);
  const footer=result.lines.length<request.limit&&end<result.totalLines
    ?`(Output capped. Showing lines ${result.offset}-${end}. Use offset=${end+1} to continue.)`
    :end<result.totalLines
      ?`(Showing lines ${result.offset}-${end} of ${result.totalLines}. Use offset=${end+1} to continue.)`
      :`(End of file - total ${result.totalLines} lines)`;
  const body=result.lines.length?result.lines.map(line=>`${line.number}: ${line.text}`).join('\n')+'\n\n'+footer:footer;
  return `<path>${result.path}</path>\n<type>file</type>\n<content>\n${body}\n</content>`;
}
