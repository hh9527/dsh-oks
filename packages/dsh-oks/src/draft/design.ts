import {UNKNOWN,TYPED,known as isKnown,unbox,isBox,typeOf,box,show,type Ty} from './typed-types.ts';
import { projectionError } from './projection.ts';
import { SourceFile } from './source.ts';
import { parseDraftForValidation, type DraftDocument } from './document.ts';
import { DraftSyntaxError, type Expr, type SourceDiagnostic } from './pipeline.ts';
import type { DraftBackend, CallContext } from './runtime.ts';

/** Source language has one query operator. Plan/execution separation is internal IR. */
export function parseDesign(source: string, file?: string): DraftDocument {
  const doc = parseDraftForValidation(source, file);
  const visit = (e: Expr): void => {
    if (e.kind === 'call') {
      if (e.operator === 'exec_query') throw new DraftSyntaxError('Use query(intent); exec_query is not a DARI operator', e.span);
      e.args.forEach(visit);
    } else if (e.kind === 'array') e.values.forEach(visit);
    else if (e.kind === 'object') e.entries.forEach(x => visit(x.value));
    else if (e.kind === 'project') visit(e.input);
  };
  doc.nodes.forEach(n => visit(n.statement.value));
  return doc;
}

export function parseExecutableDesign(source: string, file?: string): DraftDocument {
  const doc = parseDesign(source, file);
  const lower = (e: Expr): Expr => {
    if (e.kind === 'call') {
      const call = {...e, args:e.args.map(lower)};
      return call.operator === 'query' ? {kind:'call',operator:'exec_query',args:[call],span:e.span} : call;
    }
    if (e.kind === 'array') return {...e,values:e.values.map(lower)};
    if (e.kind === 'object') return {...e,entries:e.entries.map(x=>({...x,value:lower(x.value)}))};
    if (e.kind === 'project') return {...e,input:lower(e.input)};
    return e;
  };
  for (const node of doc.nodes) node.statement.value = lower(node.statement.value);
  return doc;
}

const unknown=(v:unknown)=>!isKnown(v);

/** Evaluate only design values. Never acquire rows or execute postprocessing on invented rows. */
export async function checkDesign(source: string, file: string, backend: DraftBackend, signal?: AbortSignal, options:{answer?:string;requireSelection?:boolean}={}) {
  const diagnostics: SourceDiagnostic[] = [];
  const warnings: SourceDiagnostic[] = [];
  let reports:string[]=[]; let answer:string|undefined;
  const queries: {binding:string;at:Expr['span']['start'];columns?:unknown;type?:string;guard?:string;result:object}[] = [];
  const types:Record<string,string>={};
  const deferred: {binding:string;operator:string;at:Expr['span']['start'];reason:string}[] = [];
  const addError = (error: unknown, span: Expr['span']) => {
    if (signal?.aborted) throw error;
    diagnostics.push(...(error instanceof DraftSyntaxError && error.diagnostics.length ? error.diagnostics : [{file,stage:'validation',message:error instanceof Error?error.message:String(error),span:error instanceof DraftSyntaxError?error.span:span}]));
  };
  let doc: DraftDocument;
  try { doc = parseDesign(source,file); }
  catch (error) { if (!(error instanceof DraftSyntaxError)) throw error; addError(error,error.span); return {ok:false,status:'invalid' as const,queries,types,deferred,diagnostics,warnings,reports,...(answer===undefined?{}:{answer}),execution:'not performed' as const}; }
  reports=doc.answers;
  if(options.answer!==undefined){
    const matches=reports.filter(n=>n===options.answer||n===`reports.${options.answer}`);
    if(matches.length===1)answer=matches[0];
    else diagnostics.push({file,stage:'validation',message:`${matches.length?'Ambiguous':'Unknown'} report ${JSON.stringify(options.answer)}. Available reports: ${reports.join(', ')||'(none)'}`,span:doc.pipeline});
  }else if(reports.length===1)answer=reports[0];
  else if(options.requireSelection&&reports.length>1)diagnostics.push({file,stage:'validation',message:`Select answer from: ${reports.join(', ')}`,span:doc.pipeline});
  try { await backend.preflight(doc,signal); } catch (error) { addError(error,doc.pipeline); }
  const original=new SourceFile(file,source);
  for(const asset of doc.assets.values())if(asset.program){
    const at=(line:number,column:number)=>{
      const offset=original.lines[line-1]+column-1;return original.span(offset,offset);
    };
    for(const item of asset.program.LitNotOnSpan)diagnostics.push({file,stage:'provenance',asset:asset.name,message:`data-oks-lit is only allowed on span, not ${item.tag}`,span:at(item.line,item.column)});
  }
  const bindings = new Map<string,unknown>();
  for (const {statement,internal} of doc.nodes) {
    const binding = statement.kind === 'binding' ? statement.name : 'output';
    const evaluate = async (e: Expr): Promise<unknown> => {
      signal?.throwIfAborted();
      if (e.kind === 'literal') return e.value;
      if (e.kind === 'ref') return bindings.has(e.name) ? bindings.get(e.name) : UNKNOWN;
      if (e.kind === 'array') return Promise.all(e.values.map(evaluate));
      if (e.kind === 'object') return Object.fromEntries(await Promise.all(e.entries.map(async x=>[x.key,await evaluate(x.value)])));
      if (e.kind === 'project') {
        let value = await evaluate(e.input);
        if(isBox(value)){const t=typeOf(value);const field=t.kind==='record'&&!t.nullable&&typeof e.key==='string'&&Object.hasOwn(t.fields,e.key)?t.fields[e.key]:t.kind==='array'&&typeof e.key==='number'&&e.key>=0&&(t.length===undefined||e.key<t.length)?t.element:undefined;if(!field)throw new DraftSyntaxError('Invalid projection from '+show(t),e.span);return box(field,isKnown(value)?unbox(value)[e.key]:UNKNOWN);}
        if (value === UNKNOWN) return UNKNOWN;
        if (value === null || typeof value !== 'object' || (Array.isArray(value)?typeof e.key!=='number':typeof e.key!=='string') || !Object.hasOwn(value,e.key)) throw new DraftSyntaxError(projectionError(value,e),e.span);
        return (value as Record<string|number,unknown>)[e.key];
      }
      const args = await Promise.all(e.args.map(evaluate));
      const ctx: CallContext = {operator:e.operator,figureKind:e.figureKind,args:args.map(data=>({data,sources:[]})),statement,span:e.span,run:'check',batch:'check',sourceHash:'check',signal,
        asset:typeof args[0] === 'string'?doc.assets.get(args[0]):undefined};
      if(['typed_value','relational','relational_one','table_union','typed_table'].includes(e.operator)&&backend.checkTyped){
        const computed=await backend.checkTyped(ctx);
        if(e.operator!=='typed_value'){const t=computed.logicalType as Ty;queries.push({binding,at:e.span.start,type:show(t),...(t.kind==='table'?{columns:t.columns}:{}),...(e.operator==='relational_one'&&(computed.evidence as {guard?:boolean})?.guard?{guard:'at most one row checked at runtime'}:{}),result:{values:'runtime',type:'checked'}});}
        return computed.data;
      }
      if(e.operator==='query'){if(unknown(args))throw new DraftSyntaxError('query parameters must be known during checking; business values cannot determine a remote query',e.span);ctx.args=ctx.args.map(a=>({...a,data:unbox(a.data)}));}
      const errors=backend.checkCall?.(ctx,value=>!unknown(value))??[];
      if(errors.length){diagnostics.push(...errors);return UNKNOWN;}
      if(e.operator==='sql'&&backend.checkSql){
        let computed;
        try{computed=await backend.checkSql(ctx);}catch(error){
          if(signal?.aborted)throw error;
          const asset=ctx.asset;
          const diagnostic={file,stage:'sql',asset:asset?.name,message:error instanceof Error?error.message:String(error),span:asset?.span??e.span};
          throw new DraftSyntaxError(diagnostic.message,diagnostic.span,[diagnostic]);
        }
        const columns=(computed.data as {columns:unknown}).columns;
        queries.push({binding,at:e.span.start,columns,result:{rows:'runtime',columns:'checked',truncated:'runtime'}});
        return {columns,rows:UNKNOWN,truncated:UNKNOWN};
      }
      if (unknown(args) || e.operator === 'render_figure' || e.operator === 'render_report') {
        deferred.push({binding,operator:e.operator,at:e.span.start,reason:unknown(args)?'Requires runtime data; not executed during checking':'Rendering is deferred until execution'});
        return UNKNOWN;
      }
      if (!['data','context','time_windows','query'].includes(e.operator)) throw new Error('Operator is not available during checking');
      const computed = await backend.execute({...ctx,args:ctx.args.map(a=>({...a,data:unknown(a.data)?a.data:unbox(a.data)}))}).catch(error=>{
        if(signal?.aborted || error instanceof DraftSyntaxError) throw error;
        throw new DraftSyntaxError(error instanceof Error?error.message:String(error),e.span);
      });
      if (e.operator === 'query') {
        const columns = (computed.data as {columns:unknown}).columns;
        queries.push({binding,at:e.span.start,columns,result:{rows:'runtime',columns:'checked',truncated:'runtime'}});
        const data={columns,rows:UNKNOWN,truncated:UNKNOWN};return doc.nodes.some(n=>n.typed)?{...data,[TYPED]:typeOf(data),value:data}:data;
      }
      if(computed.logicalType&&isKnown(computed.data))return box(computed.logicalType as Ty,computed.data);
      return computed.data;
    };
    try { const value = await evaluate(statement.value); if (statement.kind === 'binding'){bindings.set(binding,value);try{if(!internal)types[binding]=show(typeOf(value));}catch{}} }
    catch (error) { addError(error,statement.span); if (statement.kind === 'binding') bindings.set(binding,UNKNOWN); }
  }
  const unique = [...new Map(diagnostics.map(d=>[`${d.span.start.offset}:${d.message}`,d])).values()];
  const unresolved = deferred.some(d=>d.operator==='query');
  return {ok:unique.length===0 && !unresolved,status:unique.length?'invalid':unresolved?'incomplete':'checked',queries,types,deferred,diagnostics:unique,warnings,reports,...(answer===undefined?{}:{answer}),
    execution:'not performed',runtimeChecks:['Remote result schema and cell types, table completeness and resource budgets','select_one cardinality guards that could not be statically proven','Actual figure column values and rendering','Runtime provenance chains and rendered report assembly']};
}
