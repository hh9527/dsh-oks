import {isRecord} from '../host.ts';

export const receiptHeader=(status:'Succeed'|'CheckFailed'|'ResolveFailed')=>status+'\n'+'-'.repeat(status.length);

/** Execution metadata stays structured internally; the agent sees only requested deliverables. */
export function renderResolveReceipt(value:unknown):string {
  if(!isRecord(value))throw new Error('Invalid DARI resolve receipt');
  if(typeof value.text==='string')return value.text;
  if(value.ok!==true){
    const errors:{location:string;message:string}[]=[];
    const add=(raw:unknown)=>{
      if(!isRecord(raw)||raw.status==='blocked')return;
      const message=typeof raw.message==='string'?raw.message:typeof raw.error==='string'?raw.error:'';
      if(!message||/^Upstream\b/.test(message))return;
      const at=isRecord(raw.span)&&isRecord(raw.span.start)?raw.span.start:isRecord(raw.at)?raw.at:undefined;
      const location=at&&typeof at.line==='number'&&typeof at.column==='number'?`L${at.line}:${at.column}: `:'';
      const item={location,message:message.replace(/[\r\n\u2028\u2029]+/g,' ')};
      if(!errors.some(e=>e.location===item.location&&e.message===item.message))errors.push(item);
    };
    if(Array.isArray(value.failures))value.failures.forEach(add);
    if(Array.isArray(value.diagnostics))value.diagnostics.forEach(add);
    if(!errors.length)add(value);
    if(!errors.length)errors.push({location:'',message:typeof value.status==='string'?value.status:'Resolution failed'});
    const lines=[receiptHeader('ResolveFailed'),'','# errors:',...errors.slice(0,20).map(e=>'- '+e.location+e.message)];
    const omitted=errors.length-20+(typeof value.omittedFailures==='number'?value.omittedFailures:0)+(typeof value.omittedDiagnostics==='number'?value.omittedDiagnostics:0);
    if(omitted>0)lines.push(`- ${omitted} more errors omitted`);
    return lines.join('\n');
  }
  if(!isRecord(value.answer)||typeof value.answer.embedded!=='string')throw new Error('Missing resolved Answer');
  return value.answer.embedded;
}
