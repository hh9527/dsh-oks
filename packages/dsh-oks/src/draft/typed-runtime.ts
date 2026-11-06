import {isRecord} from '../host.ts';
import {TypedCompiler,fail} from './typed-compiler.ts';
import {UNKNOWN,TYPED,box,isBox,typeOf,unbox,known,common,scalar,rowType,show,hasError,TypeRuleError,UpstreamTypeUnavailable,type Ty} from './typed-types.ts';
import type {N} from './typed-syntax.ts';
import type {SqlWorkspace,SqlColumn} from './sql.ts';
import type {CallContext,Computed} from './runtime.ts';
import {DraftSyntaxError} from './pipeline.ts';
import {DiagnosticCollector} from './diagnostics.ts';
const mark=(v:any,type:Ty)=>({...v,[TYPED]:type,value:v});
const q=(s:string)=>'"'+s.replaceAll('"','""')+'"';
export function validateTypedRows(rows:Record<string,unknown>[],columns:SqlColumn[]){
 for(const row of rows)for(const c of columns){const v=row[c.name];if(v===null&&c.nullable)continue;const ok=v!==null&&(c.type==='Int'||c.type==='EpochMillis'?Number.isSafeInteger(v):c.type==='Float'?typeof v==='number'&&Number.isFinite(v):c.type==='Bool'?typeof v==='boolean'||v===0||v===1:typeof v==='string');if(!ok)throw new Error('Value violates declared type '+c.name+':'+c.type+(c.nullable?'?':''));if(c.type==='Bool')row[c.name]=!!v;}
}
export async function runTyped(ctx:CallContext,workspace:SqlWorkspace,check:boolean):Promise<Computed>{
 if(ctx.operator==='typed_table'){
  const value=ctx.args[0]?.data;
  const dataExpr=ctx.expression?.kind==='call'?ctx.expression.args[0]:undefined;
  const rowsExpr=dataExpr?.kind==='call'&&dataExpr.operator==='data'?dataExpr.args[0]:undefined;
  const firstRow=rowsExpr?.kind==='array'?rowsExpr.values[0]:undefined;
  const rows=isBox(value)?value.value:value;
  const columnSpan=(name:string)=>{
   if(rowsExpr?.kind==='array'&&Array.isArray(rows))for(const [i,row] of rows.entries()){
    const cell=isRecord(row)?row[name]:undefined;if(cell===undefined||!known(cell)||hasError(cell))continue;
    const cellType=typeOf(cell),rowExpr=rowsExpr.values[i];
    if(cellType.kind!=='scalar'&&cellType.kind!=='null'&&rowExpr?.kind==='object')return rowExpr.entries.find(e=>e.key===name)?.value.span??ctx.span;
   }
   return firstRow?.kind==='object'?firstRow.entries.find(e=>e.key===name)?.value.span??ctx.span:ctx.span;
  };
  if(!check&&!known(value))throw new DraftSyntaxError('table rows must be known given/example values',ctx.span);
  const diagnostics=ctx.diagnostics?.scope()??new DiagnosticCollector();
  let type:Ty|undefined;
  if(check&&Array.isArray(rows)&&rows.length>1){
   const rowTypes=rows.map(row=>typeOf(row));
   const first=rowTypes[0];
   if(first.kind==='record'&&rowTypes.every(row=>row.kind==='record'&&Object.keys(row.fields).join('\0')===Object.keys(first.fields).join('\0'))){
    const fields={...first.fields};
    for(const [index,row] of rowTypes.entries())if(index>0&&row.kind==='record')for(const [name,current] of Object.entries(row.fields)){
     if(fields[name].kind==='error'||current.kind==='error'){fields[name]={kind:'error'};continue;}
     try{fields[name]=common(fields[name],current);}catch(error){
      if(!(error instanceof TypeRuleError))throw error;
      const rowExpr=rowsExpr?.kind==='array'?rowsExpr.values[index]:undefined;
      const span=rowExpr?.kind==='object'?rowExpr.entries.find(e=>e.key===name)?.value.span??ctx.span:ctx.span;
      diagnostics.report({stage:'type',message:'table column '+name+': '+error.message,span});fields[name]={kind:'error'};
     }
    }
    type={kind:'array',element:{...first,fields},length:rows.length,nullable:false};
   }
  }
  type??=typeOf(value,ctx.args[0]?.logicalType as Ty|undefined);
  if(check&&(type.kind==='error'||type.kind==='array'&&type.element.kind==='error'))throw new UpstreamTypeUnavailable();
  if(type.kind!=='array'||type.element.kind!=='record'||!Object.keys(type.element.fields).length)throw new DraftSyntaxError('table requires a nonempty array of scalar records',ctx.span);
  const columns:SqlColumn[]=[];
  for(const [name,t] of Object.entries(type.element.fields)){
   if(check&&t.kind==='error')continue;
   if(t.kind!=='scalar'){const message='table column '+name+' requires an inferred scalar type',span=columnSpan(name);if(!check)throw new DraftSyntaxError(message,span);diagnostics.report({stage:'type',message,span});}
   else columns.push({name,type:t.name,nullable:t.nullable});
  }
  const errors=diagnostics.list();if(errors.length)throw new DraftSyntaxError(errors[0].message,errors[0].span,errors);
  if(check&&hasError(value))throw new UpstreamTypeUnavailable();
  const logicalType:Ty={kind:'table',columns,minRows:type.length,maxRows:type.length};
  const materializedRows=unbox(value);if(known(value))validateTypedRows(materializedRows,columns);
  return {data:check?mark({columns,rows:UNKNOWN,truncated:UNKNOWN},logicalType):{columns,rows:materializedRows,truncated:false},logicalType};
 }
 if(ctx.operator==='table_union'){
  const value=ctx.args[0]?.data;
  const tablesExpr=ctx.expression?.kind==='call'?ctx.expression.args[0]:undefined;
  if(check&&isBox(value)){
   if(hasError(value))throw new UpstreamTypeUnavailable();
   const t=typeOf(value);if(t.kind!=='array'||t.element.kind!=='table'||t.length===0)throw new DraftSyntaxError('union_all requires a nonempty array of tables',ctx.span);
   const type:Ty={kind:'table',columns:t.element.columns};return {data:mark({columns:type.columns,rows:UNKNOWN,truncated:UNKNOWN},type),logicalType:type};
  }
  const tables=ctx.args[0]?.data;if(!Array.isArray(tables)||!tables.length)throw new DraftSyntaxError('union_all requires a nonempty array of tables',ctx.span);
  const inputDiagnostics=ctx.diagnostics?.scope()??new DiagnosticCollector();let unavailable=false;
  const types=tables.map((value,index):Ty=>{
   if(check&&hasError(value)){unavailable=true;return {kind:'error'};}
   try{return typeOf(value);}catch(error){
    if(!check)throw error;
    if(error instanceof UpstreamTypeUnavailable){unavailable=true;return {kind:'error'};}
    if(!(error instanceof TypeRuleError))throw error;
    inputDiagnostics.report({stage:'type',message:error.message,span:tablesExpr?.kind==='array'?tablesExpr.values[index]?.span??ctx.span:ctx.span});return {kind:'error'};
   }
  });
  for(const [index,t] of types.entries()){
   if(t.kind==='error'){unavailable=true;continue;}
   if(t.kind!=='table'){
    const span=tablesExpr?.kind==='array'?tablesExpr.values[index]?.span??ctx.span:ctx.span,message='union_all requires Table values';
    if(!check)throw new DraftSyntaxError(message,span);inputDiagnostics.report({stage:'type',message,span});
   }
  }
  const knownTables=types.flatMap((type,index)=>type.kind==='table'?[{type,index}]:[]);
  const first=knownTables[0]?.type.columns??[];
  const comparable=knownTables.slice(1).filter(({type,index})=>{
   if(type.columns.length===first.length&&type.columns.every((c,i)=>c.name===first[i].name))return true;
   const message='union_all column names/order differ',span=tablesExpr?.kind==='array'?tablesExpr.values[index]?.span??ctx.span:ctx.span;
   if(!check)throw new DraftSyntaxError(message,span);inputDiagnostics.report({stage:'type',message,span});return false;
  });
  const columns:SqlColumn[]=[];
  for(const [i,c] of first.entries()){
   let t=scalar(c.type,c.nullable),invalid=false;
   for(const {type,index} of comparable){
    const col=type.columns[i];
    try{t=common(t,scalar(col.type,col.nullable));}catch(error){
     if(!check||!(error instanceof TypeRuleError))throw error;
     inputDiagnostics.report({stage:'type',message:'union_all column '+c.name+': '+error.message,span:tablesExpr?.kind==='array'?tablesExpr.values[index]?.span??ctx.span:ctx.span});invalid=true;
    }
   }
   if(!invalid){if(t.kind!=='scalar')throw new Error('Invalid union type');columns.push({name:c.name,type:t.name,nullable:t.nullable});}
  }
  const errors=inputDiagnostics.list();if(errors.length)throw new DraftSyntaxError(errors[0].message,errors[0].span,errors);
  if(unavailable)throw new UpstreamTypeUnavailable();
  const type:Ty={kind:'table',columns};if(check)return {data:mark({columns,rows:UNKNOWN,truncated:UNKNOWN},type),logicalType:type};
  const inputs=Object.fromEntries(tables.map((t,i)=>['s'+i,unbox(t)]));
  const sql=tables.map((_,i)=>'SELECT '+columns.map(c=>q(c.name)).join(',')+' FROM '+q('t_s'+i)).join(' UNION ALL ');
  const result=await workspace.execute(ctx.run,sql,inputs,false,ctx.signal,[]);if(result.truncated)throw new Error('Typed union exceeds the output row budget');validateTypedRows(result.rows,columns);return {data:{...result,columns},logicalType:type};
 }
 const ast=JSON.parse(String(ctx.args[0]?.data)) as N;
 const input=ctx.args[1]?.data;if(!isRecord(input))throw new DraftSyntaxError('Typed inputs must be named',ctx.span);
 const hint=ctx.args[1]?.logicalType as Ty|undefined;
 const compiler=new TypedCompiler(input,hint?.kind==='record'?hint.fields:{},check,ctx.diagnostics?.scope());
 if(ctx.operator==='typed_value'){
  const v=compiler.compile(ast);if(check){compiler.throwIfErrors();if(hasError(input))throw new UpstreamTypeUnavailable();return {data:box(v.type,v.known?v.value:UNKNOWN),logicalType:v.type};}
  if(!v.known)fail(ast,'Scalar expression requires a materialized value');compiler.validNumber(v.value,v.type,ast);return {data:v.value,logicalType:v.type};
 }
 const plan=(()=>{try{return compiler.relational(ast);}catch(error){return compiler.rethrowWithDiagnostics(error);}})();
 if(check){
  if(hasError(input))throw new UpstreamTypeUnavailable();
  // Types come from our AST rules; prepare is a separate lowering consistency check.
  await workspace.execute(ctx.run,plan.sql,Object.fromEntries(Object.entries(plan.tables).map(([k,v])=>[k,unbox(v)])),true,ctx.signal,compiler.bindings);
  return {data:ctx.operator==='relational_one'?box(plan.type):mark({columns:plan.columns,rows:UNKNOWN,truncated:UNKNOWN},plan.type),logicalType:plan.type,evidence:{guard:plan.guard}};
 }
 const result=await workspace.execute(ctx.run,plan.sql,Object.fromEntries(Object.entries(plan.tables).map(([k,v])=>[k,unbox(v)])),false,ctx.signal,compiler.bindings);
 if(result.truncated)fail(ast,'Typed select exceeds the output row budget');validateTypedRows(result.rows,plan.columns);
 if(ctx.operator==='relational_one'){if(result.rows.length>1)fail(ast,'CardinalityViolation: select_one expected at most one row');return {data:result.rows[0]??null,logicalType:plan.type};}
 return {data:{...result,columns:plan.columns},logicalType:plan.type};
}
