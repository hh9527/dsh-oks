import {isRecord} from '../host.ts';
import {TypedCompiler,fail} from './typed-compiler.ts';
import {UNKNOWN,TYPED,box,isBox,typeOf,unbox,known,common,scalar,rowType,show,type Ty} from './typed-types.ts';
import type {N} from './typed-syntax.ts';
import type {SqlWorkspace,SqlColumn} from './sql.ts';
import type {CallContext,Computed} from './runtime.ts';
import {DraftSyntaxError} from './pipeline.ts';
const mark=(v:any,type:Ty)=>({...v,[TYPED]:type,value:v});
const q=(s:string)=>'"'+s.replaceAll('"','""')+'"';
export function validateTypedRows(rows:Record<string,unknown>[],columns:SqlColumn[]){
 for(const row of rows)for(const c of columns){const v=row[c.name];if(v===null&&c.nullable)continue;const ok=v!==null&&(c.type==='Int'||c.type==='EpochMillis'?Number.isSafeInteger(v):c.type==='Float'?typeof v==='number'&&Number.isFinite(v):c.type==='Bool'?typeof v==='boolean'||v===0||v===1:typeof v==='string');if(!ok)throw new Error('Value violates declared type '+c.name+':'+c.type+(c.nullable?'?':''));if(c.type==='Bool')row[c.name]=!!v;}
}
export async function runTyped(ctx:CallContext,workspace:SqlWorkspace,check:boolean):Promise<Computed>{
 if(ctx.operator==='typed_table'){
  const value=ctx.args[0]?.data;
  if(!check&&!known(value))throw new DraftSyntaxError('table rows must be known given/example values',ctx.span);
  const type=typeOf(value,ctx.args[0]?.logicalType as Ty|undefined);
  if(type.kind!=='array'||type.element.kind!=='record'||!Object.keys(type.element.fields).length)throw new DraftSyntaxError('table requires a nonempty array of scalar records',ctx.span);
  const columns=Object.entries(type.element.fields).map(([name,t])=>{if(t.kind!=='scalar')throw new DraftSyntaxError('table column '+name+' requires an inferred scalar type',ctx.span);return {name,type:t.name,nullable:t.nullable};});
  const logicalType:Ty={kind:'table',columns,minRows:type.length,maxRows:type.length};
  const rows=unbox(value);if(known(value))validateTypedRows(rows,columns);
  return {data:check?mark({columns,rows:UNKNOWN,truncated:UNKNOWN},logicalType):{columns,rows,truncated:false},logicalType};
 }
 if(ctx.operator==='table_union'){
  const value=ctx.args[0]?.data;
  if(check&&isBox(value)){
   const t=typeOf(value);if(t.kind!=='array'||t.element.kind!=='table'||t.length===0)throw new DraftSyntaxError('union_all requires a nonempty array of tables',ctx.span);
   const type:Ty={kind:'table',columns:t.element.columns};return {data:mark({columns:type.columns,rows:UNKNOWN,truncated:UNKNOWN},type),logicalType:type};
  }
  const tables=ctx.args[0]?.data;if(!Array.isArray(tables)||!tables.length)throw new DraftSyntaxError('union_all requires a nonempty array of tables',ctx.span);
  const types=tables.map(t=>typeOf(t));for(const t of types)if(t.kind!=='table')throw new DraftSyntaxError('union_all requires Table values',ctx.span);
  const first=(types[0] as Extract<Ty,{kind:'table'}>).columns;
  const columns=first.map((c,i)=>{let t=scalar(c.type,c.nullable);for(const table of types.slice(1)){const cols=(table as Extract<Ty,{kind:'table'}>).columns;if(cols.length!==first.length||cols[i]?.name!==c.name)throw new DraftSyntaxError('union_all column names/order differ',ctx.span);t=common(t,scalar(cols[i].type,cols[i].nullable));}if(t.kind!=='scalar')throw new Error('Invalid union type');return {name:c.name,type:t.name,nullable:t.nullable};});
  const type:Ty={kind:'table',columns};if(check)return {data:mark({columns,rows:UNKNOWN,truncated:UNKNOWN},type),logicalType:type};
  const inputs=Object.fromEntries(tables.map((t,i)=>['s'+i,unbox(t)]));
  const sql=tables.map((_,i)=>'SELECT '+columns.map(c=>q(c.name)).join(',')+' FROM '+q('t_s'+i)).join(' UNION ALL ');
  const result=await workspace.execute(ctx.run,sql,inputs,false,ctx.signal,[]);if(result.truncated)throw new Error('Typed union exceeds the output row budget');validateTypedRows(result.rows,columns);return {data:{...result,columns},logicalType:type};
 }
 const ast=JSON.parse(String(ctx.args[0]?.data)) as N;
 const input=ctx.args[1]?.data;if(!isRecord(input))throw new DraftSyntaxError('Typed inputs must be named',ctx.span);
 const hint=ctx.args[1]?.logicalType as Ty|undefined;
 const compiler=new TypedCompiler(input,hint?.kind==='record'?hint.fields:{},check);
 if(ctx.operator==='typed_value'){
  const v=compiler.compile(ast);if(check)return {data:box(v.type,v.known?v.value:UNKNOWN),logicalType:v.type};
  if(!v.known)fail(ast,'Scalar expression requires a materialized value');compiler.validNumber(v.value,v.type,ast);return {data:v.value,logicalType:v.type};
 }
 const plan=compiler.relational(ast);
 if(check){
  // Types come from our AST rules; prepare is a separate lowering consistency check.
  await workspace.execute(ctx.run,plan.sql,Object.fromEntries(Object.entries(plan.tables).map(([k,v])=>[k,unbox(v)])),true,ctx.signal,compiler.bindings);
  return {data:ctx.operator==='relational_one'?box(plan.type):mark({columns:plan.columns,rows:UNKNOWN,truncated:UNKNOWN},plan.type),logicalType:plan.type,evidence:{guard:plan.guard}};
 }
 const result=await workspace.execute(ctx.run,plan.sql,Object.fromEntries(Object.entries(plan.tables).map(([k,v])=>[k,unbox(v)])),false,ctx.signal,compiler.bindings);
 if(result.truncated)fail(ast,'Typed select exceeds the output row budget');validateTypedRows(result.rows,plan.columns);
 if(ctx.operator==='relational_one'){if(result.rows.length>1)fail(ast,'CardinalityViolation: select_one expected at most one row');return {data:result.rows[0]??null,logicalType:plan.type};}
 return {data:{...result,columns:plan.columns},logicalType:plan.type};
}
