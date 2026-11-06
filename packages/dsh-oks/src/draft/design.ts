import {isRecord} from '../host.ts';
import {UNKNOWN,TYPED,known as isKnown,unbox,isBox,typeOf,box,show,common,scalar,hasError,TypeRuleError,UpstreamTypeUnavailable,type Ty} from './typed-types.ts';
import { projectionError } from './projection.ts';
import { SourceFile, sourceExcerpt } from './source.ts';
import { parseDraftForValidation, type DraftDocument } from './document.ts';
import { DraftSyntaxError, type Expr, type SourceDiagnostic } from './pipeline.ts';
import { DiagnosticCollector } from './diagnostics.ts';
import type { DraftBackend, CallContext } from './runtime.ts';

/** Source language has one query operator. Plan/execution separation is internal IR. */
export function parseDesign(source: string, file?: string, collector?:DiagnosticCollector): DraftDocument {
  const doc = parseDraftForValidation(source, file, collector);
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

/** Analysis and execution share parsing/name resolution; only their lowering differs. */
export function parseAnalysisDesign(source:string,file?:string,collector?:DiagnosticCollector):DraftDocument {
  const doc=parseDesign(source,file,collector);
  for(const node of doc.nodes)if(node.analysis)node.statement.value=node.analysis;
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

export type CheckedBinding = {
  name: string;
  kind: 'data'|'figure'|'report'|'answer';
  checked: boolean;
  shape?: Ty | {kind:'figure';data:Ty;nodes?:Ty};
};

/** Evaluate only design values. Never acquire rows or execute postprocessing on invented rows. */
export async function checkDesign(source: string, file: string, backend: DraftBackend, signal?: AbortSignal, options:{answer?:string;requireSelection?:boolean}={}) {
  signal?.throwIfAborted();
  const diagnostics = new DiagnosticCollector();
  const warnings: SourceDiagnostic[] = [];
  let reports:string[]=[]; let answer:string|undefined;
  const queries: {binding:string;at:Expr['span']['start'];columns?:unknown;type?:string;guard?:string;result:object}[] = [];
  const types:Record<string,string>={};
  const checkedBindings:CheckedBinding[]=[];
  const resolved=new Set<string>();
  const deferred: {binding:string;operator:string;at:Expr['span']['start'];reason:string}[] = [];
  let upstreamUnavailable=false;
  const sourceFile=new SourceFile(file,source);
  const addError = (error: unknown, span: Expr['span'],stage='validation',asset?:string) => {
    if (signal?.aborted) throw error;
    const entries:SourceDiagnostic[]=error instanceof DraftSyntaxError && error.diagnostics.length ? error.diagnostics : [{file,stage,message:error instanceof Error?error.message:String(error),span:error instanceof DraftSyntaxError?error.span:span}];
    diagnostics.reportAll(entries.map(d=>({...d,file:d.file??file,...(asset&&d.asset===undefined?{asset}:{}),...(d.stage==='syntax'&&(!d.file||d.file===file)?{excerpt:sourceExcerpt(sourceFile,d.span)}:{})})));
  };
  let doc: DraftDocument;
  try { doc = parseAnalysisDesign(source,file,diagnostics); }
  catch (error) { if (!(error instanceof DraftSyntaxError)) throw error; addError(error,error.span,'syntax'); return {ok:false,status:'invalid' as const,queries,types,checkedBindings,deferred,diagnostics:diagnostics.list(),warnings,reports,...(answer===undefined?{}:{answer}),execution:'not performed' as const}; }
  if(doc.declarations)for(const [name,kind] of doc.declarations)checkedBindings.push({name,kind,checked:false});
  else for(const {statement,internal} of doc.nodes)if(!internal&&statement.kind==='binding'){
    const e=statement.value;
    const kind=e.kind==='call'&&e.operator==='render_figure'?'figure':e.kind==='call'&&e.operator==='render_report'?'report':'data';
    checkedBindings.push({name:statement.name,kind,checked:false});
  }
  reports=doc.answers.filter(name=>doc.assets.get('@report/'+name)?.format!=='markdown');
  const hasAnswer=doc.assets.get('@report/answer')?.format==='markdown';
  if(options.answer!==undefined){
    const matches=reports.filter(n=>n===options.answer||n===`reports.${options.answer}`);
    if(matches.length===1)answer=matches[0];
    else diagnostics.report({file,stage:'validation',message:`${matches.length?'Ambiguous':'Unknown'} report ${JSON.stringify(options.answer)}. Available reports: ${reports.join(', ')||'(none)'}`,span:doc.pipeline});
  }else if(hasAnswer)answer='answer';
  else if(reports.length===1)answer=reports[0];
  else if(options.requireSelection&&reports.length>1)diagnostics.report({file,stage:'validation',message:`Select answer from: ${reports.join(', ')}`,span:doc.pipeline});
  diagnostics.reportAll((doc.diagnostics??[]).filter(d=>d.severity==='warning'));
  try { await backend.preflight(doc,signal,{validateQueries:false,diagnostics}); } catch (error) { if(!(error instanceof DraftSyntaxError))throw error;addError(error,doc.pipeline); }
  signal?.throwIfAborted();
  const analyze=backend.analyze;
  if(!analyze)throw new Error('Backend does not provide an analysis implementation');
  const bindings = new Map<string,unknown>();
  const settle=async<T>(items:readonly {span:Expr['span'];run:()=>Promise<T>}[]):Promise<T[]>=>{
    signal?.throwIfAborted();
    const pending=Promise.allSettled(items.map(item=>item.run()));
    signal?.throwIfAborted();
    let onAbort:(()=>void)|undefined;
    const cancelled=signal?new Promise<never>((_,reject)=>{onAbort=()=>reject(signal.reason);signal.addEventListener('abort',onAbort,{once:true});}):undefined;
    let results:PromiseSettledResult<T>[];
    try{results=await (cancelled?Promise.race([pending,cancelled]):pending);}finally{if(onAbort)signal!.removeEventListener('abort',onAbort);}
    signal?.throwIfAborted();
    const collected=new DiagnosticCollector();let unavailable:UpstreamTypeUnavailable|undefined;
    for(const [index,result] of results.entries())if(result.status==='rejected'){
      const error=result.reason;
      if(signal?.aborted)throw error;
      if(error instanceof UpstreamTypeUnavailable){unavailable=error;continue;}
      if(!(error instanceof DraftSyntaxError)&&!(error instanceof TypeRuleError))throw error;
      collected.reportAll(error instanceof DraftSyntaxError&&error.diagnostics.length?error.diagnostics:[{file,stage:error instanceof TypeRuleError?'type':'validation',message:error.message,span:error instanceof DraftSyntaxError?error.span:items[index].span}]);
    }
    const errors=collected.list();if(errors.length)throw new DraftSyntaxError(errors[0].message,errors[0].span,errors);
    if(unavailable)throw unavailable;
    return results.map(result=>(result as PromiseFulfilledResult<T>).value);
  };
  for (const {statement,internal,bindings:dependencies} of doc.nodes) {
    let figureShape:Extract<CheckedBinding['shape'],{kind:'figure'}>|undefined;
    const binding = statement.kind === 'binding' ? statement.name : 'output';
    type Environment=Map<string,unknown>;
    const evaluate = async (e: Expr,locals:Environment=new Map(),variants:Environment[]=[new Map()]): Promise<unknown> => {
      const child=(e:Expr)=>evaluate(e,locals,variants);
      signal?.throwIfAborted();
      if (e.kind === 'literal') return e.value;
      if (e.kind === 'ref') return locals.has(e.name)?locals.get(e.name):bindings.has(e.name) ? bindings.get(e.name) : UNKNOWN;
      if (e.kind === 'array') return settle(e.values.map(value=>({span:value.span,run:()=>child(value)})));
      if (e.kind === 'object') {const values=await settle(e.entries.map(({value})=>({span:value.span,run:()=>child(value)})));return Object.fromEntries(e.entries.map(({key},i)=>[key,values[i]]));}
      if (e.kind === 'project') {
        let value = await child(e.input);
        if(isBox(value)){const t=typeOf(value);if(t.kind==='error')return value;const field=t.kind==='record'&&!t.nullable&&typeof e.key==='string'&&Object.hasOwn(t.fields,e.key)?t.fields[e.key]:t.kind==='array'&&typeof e.key==='number'&&e.key>=0&&(t.length===undefined||e.key<t.length)?t.element:undefined;if(!field)throw new DraftSyntaxError('Invalid projection from '+show(t),e.span);return box(field,isKnown(value)?unbox(value)[e.key]:UNKNOWN);}
        if (value === UNKNOWN) return UNKNOWN;
        if (value === null || typeof value !== 'object' || (Array.isArray(value)?typeof e.key!=='number':typeof e.key!=='string') || !Object.hasOwn(value,e.key)) throw new DraftSyntaxError(projectionError(value,e),e.span);
        return (value as Record<string|number,unknown>)[e.key];
      }
      if(e.operator==='analysis_map'){
        const input=await child(e.args[0]);let t:Ty;
        try{t=typeOf(input);}catch(error){if(!(error instanceof TypeRuleError))throw error;addError(new DraftSyntaxError(error.message,e.args[0].span),e.args[0].span,'type');t={kind:'error'};}
        if(t.kind==='error'||hasError(input)){
          const params=JSON.parse(String((e.args[1] as Extract<Expr,{kind:'literal'}>).value)) as string[];
          const scope=new Map(locals);scope.set(params[0],box({kind:'error'}));if(params[1])scope.set(params[1],box(scalar('Int')));
          await evaluate(e.args[2],scope,[scope]);
          throw new UpstreamTypeUnavailable();
        }
        if(t.kind!=='array')throw new DraftSyntaxError('map requires Array, got '+show(t),e.span);
        if(t.element.kind==='never')throw new DraftSyntaxError('map requires an inferable element type',e.span);
        const params=JSON.parse(String((e.args[1] as Extract<Expr,{kind:'literal'}>).value)) as string[];
        const scope=new Map(locals);scope.set(params[0],box(t.element));if(params[1])scope.set(params[1],box(scalar('Int')));
        // Only parameter values are specialized. The body/type structure is visited once.
        const cases:Environment[]=[];
        for(const parent of variants){
          const value=variants.length===1&&locals.size===0?input:await evaluate(e.args[0],parent,[parent]);
          const items=Array.isArray(value)?value:isKnown(value)?unbox(value) as unknown[]:Array.from({length:t.length??0},()=>box(t.element));
          for(const [i,item]of items.entries()){
            const v=new Map(parent);v.set(params[0],box(t.element,item));if(params[1])v.set(params[1],i);cases.push(v);
          }
        }
        const result=await evaluate(e.args[2],scope,cases.length?cases:variants);
        const type:Ty={kind:'array',element:typeOf(result),length:t.length,nullable:false};
        // Materialize pure parameter expressions when subsequent query arguments need them.
        const pure=(e:Expr):boolean=>e.kind==='call'?['typed_value','data','context','time_windows','analysis_map'].includes(e.operator)&&e.args.every(pure):e.kind==='array'?e.values.every(pure):e.kind==='object'?e.entries.every(x=>pure(x.value)):e.kind==='project'?pure(e.input):true;
        if(isKnown(input)&&variants.length===1&&pure(e.args[2])){
          const values=await settle(cases.map(v=>({span:e.args[2].span,run:()=>evaluate(e.args[2],v,[v])})));
          if(values.every(isKnown))return box(type,values.map(unbox));
        }
        return box(type);
      }
      const args = await settle(e.args.map(arg=>({span:arg.span,run:()=>child(arg)})));
      const ctx: CallContext = {operator:e.operator,figureKind:e.figureKind,args:args.map(data=>({data,sources:[]})),statement,expression:e,diagnostics:diagnostics.scope({file,...(statement.kind==='binding'?{asset:binding}:{})}),span:e.span,run:'check',batch:'check',sourceHash:'check',signal,
        asset:typeof args[0] === 'string'?doc.assets.get(args[0]):undefined};
      if(hasError(args)&&!['typed_value','relational','relational_one','table_union'].includes(e.operator))throw new UpstreamTypeUnavailable();
      if(['typed_value','relational','relational_one','table_union','typed_table'].includes(e.operator)){
        const [computed]=await settle([{span:e.span,run:()=>analyze(ctx)}]);
        if(e.operator!=='typed_value'){const t=computed.logicalType as Ty;queries.push({binding,at:e.span.start,type:show(t),...(t.kind==='table'?{columns:t.columns}:{}),...(e.operator==='relational_one'&&(computed.evidence as {guard?:boolean})?.guard?{guard:'at most one row checked at runtime'}:{}),result:{values:'runtime',type:'checked'}});}
        return computed.data;
      }
      if(e.operator==='query'){
        const candidates=unknown(args)?await settle(variants.map(v=>({span:e.span,run:()=>settle(e.args.map(a=>({span:a.span,run:()=>evaluate(a,v,[v])})))}))):[args];
        let schema:Ty|undefined;
        const candidateErrors=new DiagnosticCollector();
        for(const values of candidates){
          try{
            if(unknown(values))throw new DraftSyntaxError('query parameters must be known during checking; business values cannot determine a remote query',e.span);
            const [computed]=await settle([{span:e.span,run:()=>analyze({...ctx,args:values.map(data=>({data:unbox(data),sources:[]}))})}]);
            signal?.throwIfAborted();
            const columns=(computed.data as {columns:unknown}).columns;
            const t=typeOf({columns,rows:UNKNOWN,truncated:UNKNOWN});schema=schema?common(schema,t):t;
          }catch(error){
            if(signal?.aborted||!(error instanceof DraftSyntaxError)&&!(error instanceof TypeRuleError))throw error;
            candidateErrors.reportAll(error instanceof DraftSyntaxError&&error.diagnostics.length?error.diagnostics:[{file,stage:error instanceof TypeRuleError?'type':'validation',message:error.message,span:error instanceof DraftSyntaxError?error.span:e.span}]);
          }
        }
        const failures=candidateErrors.list();if(failures.length)throw new DraftSyntaxError(failures[0].message,failures[0].span,failures);
        if(!schema||schema.kind!=='table')throw new DraftSyntaxError('query has no analyzable parameter values',e.span);
        queries.push({binding,at:e.span.start,columns:schema.columns,result:{rows:'runtime',columns:'checked',truncated:'runtime'}});
        const data={columns:schema.columns,rows:UNKNOWN,truncated:UNKNOWN};return {...data,[TYPED]:schema,value:data};
      }
      const findings=backend.checkCall?.(ctx,value=>!unknown(value))??[];
      diagnostics.reportAll(findings);
      if(findings.some(d=>d.severity!=='warning'))return UNKNOWN;
      if(e.operator==='render_figure'&&isRecord(args[1])){
        try{figureShape={kind:'figure',data:typeOf(args[1].data),...(args[1].nodes===undefined?{}:{nodes:typeOf(args[1].nodes)})};}catch{}
      }
      if ((unknown(args)&&e.operator!=='data') || e.operator === 'render_figure' || e.operator === 'render_report') {
        deferred.push({binding,operator:e.operator,at:e.span.start,reason:unknown(args)?'Requires runtime data; not executed during checking':'Rendering is deferred until execution'});
        return UNKNOWN;
      }
      if (!['data','context','time_windows','query'].includes(e.operator)) throw new Error('Operator is not available during checking');
      const [computed] = await settle([{span:e.span,run:()=>analyze({...ctx,args:ctx.args.map(a=>({...a,data:unknown(a.data)?a.data:unbox(a.data)}))})}]).catch(error=>{
        if(signal?.aborted || error instanceof DraftSyntaxError) throw error;
        throw new DraftSyntaxError(error instanceof Error?error.message:String(error),e.span);
      });
      if(computed.logicalType&&isKnown(computed.data))return box(computed.logicalType as Ty,computed.data);
      return computed.data;
    };
    try {
      const before=diagnostics.checkpoint();
      const value=await evaluate(statement.value);
      if(statement.kind==='binding'){
        bindings.set(binding,value);
        let shape:CheckedBinding['shape'];
        let opaqueInternal=false;
        const result=checkedBindings.find(n=>n.name===binding);
        const presentation=statement.value.kind==='call'&&statement.value.operator==='render_report';
        try{shape=figureShape??typeOf(value);}catch(error){
          if(error instanceof TypeRuleError){if(internal)opaqueInternal=true;else addError(new DraftSyntaxError(error.message,statement.span),statement.span,'type');}
          else if(error instanceof UpstreamTypeUnavailable){if(!presentation)upstreamUnavailable=true;}
          else throw error;
        }
        const localError=diagnostics.list().some(d=>d.severity!=='warning'&&(d.asset===binding || (d.span.start.offset>=statement.span.start.offset&&d.span.start.offset<statement.span.end.offset)));
        const checked=!diagnostics.hasErrors(before)&&!localError&&dependencies.every(name=>resolved.has(name))&&(shape!==undefined||presentation||opaqueInternal);
        if(checked)resolved.add(binding);
        else bindings.set(binding,box({kind:'error'}));
        if(checked&&!internal&&shape!==undefined&&shape.kind!=='figure')types[binding]=show(shape);
        if(result){result.checked=checked;if(checked&&shape!==undefined)result.shape=shape;}
      }
    }
    catch (error) { if(error instanceof UpstreamTypeUnavailable)upstreamUnavailable=true;else if(error instanceof DraftSyntaxError||error instanceof TypeRuleError)addError(error,statement.span,'validation',statement.kind==='binding'?binding:undefined);else throw error; if (statement.kind === 'binding') bindings.set(binding,box({kind:'error'})); }
  }
  const unique = diagnostics.list();
  signal?.throwIfAborted();
  warnings.push(...unique.filter(d=>d.severity==='warning'));
  const errors=unique.filter(d=>d.severity!=='warning');
  const unresolved = upstreamUnavailable||deferred.some(d=>d.operator==='query');
  return {ok:errors.length===0 && !unresolved,status:errors.length?'invalid':unresolved?'incomplete':'checked',queries,types,checkedBindings,deferred,diagnostics:errors,warnings,reports,...(answer===undefined?{}:{answer}),
    execution:'not performed',runtimeChecks:['Remote result schema and cell types, table completeness and resource budgets','select_one cardinality guards that could not be statically proven','Actual figure column values and rendering','Runtime provenance chains and rendered report assembly']};
}
