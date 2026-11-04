import {receiptHeader} from './resolve-receipt.ts';
import {createHash} from 'node:crypto';
import {canonicalJson} from '../key.ts';
import {isRecord} from '../host.ts';
import type {CheckedBinding,checkDesign} from './design.ts';
import type {Span} from './pipeline.ts';
import {show,type Ty} from './typed-types.ts';

export type Inspect = {data?:string[];figures?:string[]};
type Shape=NonNullable<CheckedBinding['shape']>;

/** Only visible shape participates: record key order is irrelevant; table column order is significant. */
export function normalizeShape(t:Shape):Shape {
  if(t.kind==='figure')return {kind:'figure',data:normalizeShape(t.data) as Ty,...(t.nodes?{nodes:normalizeShape(t.nodes) as Ty}:{})};
  if(t.kind==='record')return {...t,fields:Object.fromEntries(Object.keys(t.fields).sort().map(k=>[k,normalizeShape(t.fields[k]) as Ty]))};
  if(t.kind==='array')return {kind:'array',element:normalizeShape(t.element) as Ty,nullable:false};
  if(t.kind==='table')return {kind:'table',columns:t.columns.map(({name,type,nullable})=>({name,type,nullable}))};
  return t;
}

export const shapeFingerprint=(shape:Shape):string=>'t1-'+createHash('sha256').update(canonicalJson(['dari-shape/v1',normalizeShape(shape)])).digest('base64url').slice(0,9);
const displayShape=(shape:Shape):string=>{
  const t=normalizeShape(shape);
  return t.kind==='figure'?`Figure(data=${show(t.data)}${t.nodes?`, nodes=${show(t.nodes)}`:''})`:show(t);
};
const oneLine=(s:string)=>s.replace(/[\r\n\u2028\u2029]+/g,' ');

export function parseInspect(raw:unknown):Inspect|undefined {
  if(raw===undefined)return undefined;
  if(!isRecord(raw)||Object.keys(raw).some(k=>!['data','figures'].includes(k)))throw new Error('inspect accepts only data and figures arrays');
  for(const key of ['data','figures'])if(raw[key]!==undefined&&(!Array.isArray(raw[key])||raw[key].length>32||!raw[key].every(n=>typeof n==='string'&&n.length>0)))throw new Error(`inspect.${key} must contain at most 32 nonempty binding names`);
  return raw as Inspect;
}

/** Compact public receipt; internal query plans, types and diagnostics remain structured. */
export function checkReceipt(result:Awaited<ReturnType<typeof checkDesign>>,inspect?:Inspect) {
  const lines=['# ready-status:'];
  for(const binding of result.checkedBindings){
    const name=binding.kind==='answer'?'answer':`${binding.kind}.${binding.name}`;
    const status=!binding.checked?'?':binding.shape?shapeFingerprint(binding.shape):'checked';
    lines.push(`- ${name}: ${status}`);
  }
  const errors:{span?:Span;message:string}[]=result.diagnostics.filter(d=>!/^Upstream\b/.test(d.message)).map(d=>({span:d.span,message:d.message}));
  if(!result.ok&&!errors.length)errors.push({span:undefined,message:'Checking is incomplete; no execution was performed'});
  const inspected:string[]=[];
  for(const [key,kind] of [['data','data'],['figures','figure']] as const)for(const name of new Set(inspect?.[key]??[])){
    const binding=result.checkedBindings.find(b=>b.name===name&&b.kind===kind);
    if(!binding){errors.push({span:undefined,message:`Unknown ${kind} binding ${JSON.stringify(name)}`});continue;}
    inspected.push(`- ${kind}.${name}: ${binding.checked&&binding.shape?oneLine(displayShape(binding.shape)):'?'}`);
  }
  if(errors.length){
    lines.push('','# errors:');
    for(const {span,message} of errors.slice(0,20)){
      const at=span?`L${span.start.line}:${span.start.column}-L${span.end.line}:${span.end.column}: `:'';
      lines.push(`- ${at}${oneLine(message)}`);
    }
    if(errors.length>20)lines.push(`- ${errors.length-20} more errors omitted; fix the listed errors and check again`);
  }
  if(inspected.length)lines.push('','# inspect:',...inspected);
  const ok=result.ok&&errors.length===0;
  return {ok,text:receiptHeader(ok?'Succeed':'CheckFailed')+'\n\n'+lines.join('\n')};
}
