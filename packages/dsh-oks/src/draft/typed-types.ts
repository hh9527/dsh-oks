import {isRecord} from '../host.ts';
import type {SqlColumn} from './sql.ts';
export const UNKNOWN=Symbol('runtime data');
export const TYPED=Symbol('typed check value');
export type Ty={kind:'never'}|{kind:'scalar';name:string;nullable:boolean}|{kind:'record';fields:Record<string,Ty>;nullable:boolean}|{kind:'array';element:Ty;length?:number;nullable:false}|{kind:'table';columns:SqlColumn[];minRows?:number;maxRows?:number}|{kind:'null'};
export type Box={ [TYPED]:Ty;value:unknown };
export const scalar=(name:string,nullable=false):Ty=>({kind:'scalar',name,nullable});
export const record=(fields:Record<string,Ty>,nullable=false):Ty=>({kind:'record',fields,nullable});
export const optional=(t:Ty):Ty=>t.kind==='scalar'||t.kind==='record'?{...t,nullable:true}:t.kind==='null'?t:(()=>{throw new Error('Option requires scalar or record');})();
export const present=(t:Ty):Ty=>t.kind==='scalar'||t.kind==='record'?{...t,nullable:false}:t;
export const box=(type:Ty,value:unknown=UNKNOWN):Box=>{
 // Abstract tables retain their schema at the SQLite/figure boundary, without any rows.
 if(type.kind==='table'&&value===UNKNOWN){const data={columns:type.columns,rows:UNKNOWN,truncated:UNKNOWN};return {...data,[TYPED]:type,value:data};}
 return {[TYPED]:type,value};
};
export const isBox=(v:unknown):v is Box=>isRecord(v)&&TYPED in v;
export function known(v:unknown):boolean{if(v===UNKNOWN)return false;if(isBox(v))return known(v.value);if(Array.isArray(v))return v.every(known);return !isRecord(v)||Object.values(v).every(known);}
export function unbox(v:unknown):any{if(isBox(v))return unbox(v.value);if(Array.isArray(v))return v.map(unbox);if(isRecord(v))return Object.fromEntries(Object.entries(v).map(([k,v])=>[k,unbox(v)]));return v;}
export function common(a:Ty,b:Ty):Ty{
 if(a.kind==='never')return b;if(b.kind==='never')return a;
 if(a.kind==='array'&&b.kind==='array')return {kind:'array',element:common(a.element,b.element),nullable:false,...(a.length===b.length&&a.length!==undefined?{length:a.length}:{})};
 if(a.kind==='table'&&b.kind==='table'){
  if(a.columns.length!==b.columns.length||a.columns.some((c,i)=>c.name!==b.columns[i].name))throw new Error('Incompatible table columns');
  const columns=a.columns.map((c,i)=>{const t=common(scalar(c.type,c.nullable),scalar(b.columns[i].type,b.columns[i].nullable));if(t.kind!=='scalar')throw new Error('Invalid column type');return {name:c.name,type:t.name,nullable:t.nullable};});
  return {kind:'table',columns};
 }
 if(a.kind==='null')return optional(b);if(b.kind==='null')return optional(a);
 if(a.kind==='scalar'&&b.kind==='scalar'){if(a.name===b.name)return scalar(a.name,a.nullable||b.nullable);if(['Int','Float'].includes(a.name)&&['Int','Float'].includes(b.name))return scalar('Float',a.nullable||b.nullable);}
 if(a.kind==='record'&&b.kind==='record'&&Object.keys(a.fields).join('\0')===Object.keys(b.fields).join('\0'))return record(Object.fromEntries(Object.keys(a.fields).map(k=>[k,common(a.fields[k],b.fields[k])])),a.nullable||b.nullable);
 throw new Error('Incompatible types '+show(a)+' and '+show(b));
}
export function typeOf(v:unknown,hint?:Ty):Ty{
 if(hint)return hint;if(isBox(v))return v[TYPED];if(v===UNKNOWN)throw new Error('Upstream type is unavailable');
 if(v===null)return {kind:'null'};if(typeof v==='string')return scalar('String');if(typeof v==='number')return scalar(Number.isInteger(v)?'Int':'Float');if(typeof v==='boolean')return scalar('Bool');
 if(Array.isArray(v)){let element:Ty|undefined;for(const x of v)element=element?common(element,typeOf(x)):typeOf(x);if(!element)element={kind:'never'};return {kind:'array',element,length:v.length,nullable:false};}
 if(isRecord(v)){if(Array.isArray(v.columns)&&'rows' in v){const names=new Set<string>();for(const c of v.columns){if(!isRecord(c)||typeof c.name!=='string'||typeof c.type!=='string'||c.type==='Unknown'||typeof c.nullable!=='boolean'||names.has(c.name))throw new Error('Invalid or unknown table column type');names.add(c.name);}return {kind:'table',columns:v.columns as SqlColumn[]};}return record(Object.fromEntries(Object.entries(v).map(([k,x])=>[k,typeOf(x)])));}
 throw new Error('Unsupported value type');
}
export function show(t:Ty):string{if(t.kind==='never')return 'Never';if(t.kind==='null')return 'None';if(t.kind==='table')return 'Table('+show(record(Object.fromEntries(t.columns.map(c=>[c.name,scalar(c.type,c.nullable)]))))+')';if(t.kind==='array')return 'Array('+show(t.element)+')';const text=t.kind==='scalar'?t.name:'{'+Object.entries(t.fields).map(([k,v])=>k+':'+show(v)).join(', ')+'}';return t.nullable?'Option('+text+')':text;}
export function rowType(columns:SqlColumn[]):Ty{return record(Object.fromEntries(columns.map(c=>[c.name,scalar(c.type,c.nullable)])));}
