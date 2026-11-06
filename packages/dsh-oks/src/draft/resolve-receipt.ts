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
      if(!message)return;
      const at=isRecord(raw.span)&&isRecord(raw.span.start)?raw.span.start:isRecord(raw.at)?raw.at:undefined;
      const location=at&&typeof at.line==='number'&&typeof at.column==='number'?`L${at.line}:${at.column}: `:'';
      const item={location,message:message.replace(/[\r\n\u2028\u2029]+/g,' ')};
      if(!errors.some(e=>e.location===item.location&&e.message===item.message))errors.push(item);
    };
    if(Array.isArray(value.failures))value.failures.forEach(add);
    if(Array.isArray(value.diagnostics))value.diagnostics.forEach(add);
    if(!errors.length)add(value);
    if(!errors.length)errors.push({location:'',message:typeof value.status==='string'?value.status:'Resolution failed'});
    const lines=[receiptHeader('ResolveFailed'),'','## diagnostics',...errors.slice(0,20).map(e=>'- '+e.location+e.message)];
    const omitted=errors.length-20+(typeof value.omittedFailures==='number'?value.omittedFailures:0)+(typeof value.omittedDiagnostics==='number'?value.omittedDiagnostics:0);
    if(omitted>0)lines.push(`- ${omitted} more errors omitted`);
    return lines.join('\n');
  }
  if(!isRecord(value.answer)||typeof value.answer.embedded!=='string')throw new Error('Missing resolved Answer');
  // Delivery failed: the model is the only channel left, so hand it the full Answer.
  if(typeof value.deliveryNote==='string')return value.deliveryNote+'\n\n'+value.answer.embedded;
  const delivery=isRecord(value.delivery)?value.delivery:undefined;
  const messageId=delivery?.ok===true&&typeof delivery.messageId==='string'?delivery.messageId:undefined;
  const counts=isRecord(value.counts)?value.counts:undefined;
  const lines=[receiptHeader('Succeed'),''];
  lines.push(`- answer message: ${messageId??'(delivered)'}`);
  if(typeof value.run==='string')lines.push(`- run: ${value.run}`);
  if(counts&&typeof counts.executed==='number'&&typeof counts.cached==='number')lines.push(`- executed: ${counts.executed}, cached: ${counts.cached}`);
  lines.push('','The Answer is the delivered message in the conversation; do not repeat it. Add commentary only when it helps the reader.');
  return lines.join('\n');
}
