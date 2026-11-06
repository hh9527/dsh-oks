import {embedFigureCsv} from '../chart/svg-data.ts';
import {runTyped,validateTypedRows} from './typed-runtime.ts';
import {isBox,typeOf,show,unbox,record,scalar,type Ty} from './typed-types.ts';
import {SqlWorkspace} from './sql.ts';
import { projectionError } from './projection.ts';
import { componentSpec } from './components.ts';
import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import { canonicalJson } from '../key.ts';
import { isRecord } from '../host.ts';
import type { Knowledge, WorkspaceEntry } from '../knowledge.ts';
import { limitProblem } from '../intent-limit.ts';
import { appendNode, describeRows, isResultColumn, originOf, rowsOf, resultStamp } from '../results.ts';
import type { DataOrigin, OriginNode, ResultColumn } from '../results.ts';
import {timeWindowOptions,timeWindows,TIME_WINDOWS_VERSION} from '../time-windows.ts';
import { encode, resolveZone } from '../time.ts';
import type { ContextTimeZone } from '../time.ts';
import { tableMarkdown } from '../view/table.ts';
import { buildOption, CHART_WIDTH } from '../chart/option.ts';
import { renderEchartsSvg } from '../chart/echarts.ts';
import { chartTitle, missingColumns, parseChartSpec, parseTableSpec, shapeProblem } from '../chart/spec.ts';
import {selectReport} from '../report/structure.ts';
import { assembleReport } from '../report/assemble.ts';
import type { ReportBinding } from '../report/assemble.ts';
import { restoreAssets } from '../report/page.ts';
import { DraftSyntaxError } from './pipeline.ts';
import { DiagnosticCollector } from './diagnostics.ts';
import type { Expr, Operator, Span, SourceDiagnostic } from './pipeline.ts';
import type { DraftDocument } from './document.ts';
import type { CallContext, Computed, DraftBackend, DraftValue, QueryPlan } from './runtime.ts';

/** Stable analysis fixture; execution always captures the real clock independently. */
export const ANALYSIS_CONTEXT_TIME = Date.parse('2026-01-15T12:00:00.000Z');

const UNKNOWN = Symbol('dynamic');
const digest = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
const jsonPath = (path: (string | number)[]) => '.data' + path.map(key => `[${JSON.stringify(key)}]`).join('');
const fail = (message: string, span: Span): never => { throw new DraftSyntaxError(message, span); };

type CachedCheck = { error?:string;result?:unknown; };
class IntentValidationError extends Error {}
/** Per-source validation cache. Only deterministic completed checks are admitted. */
class Checks {
  private entries = new Map<string, CachedCheck>();
  get(key: string) { return this.entries.get(key); }
  set(key: string, value: CachedCheck) {
    if (Buffer.byteLength(canonicalJson(value)) > 16384) return;
    this.entries.delete(key);
    if (this.entries.size >= 128) this.entries.delete(this.entries.keys().next().value!);
    this.entries.set(key, value);
  }
}

/** Determine values that can be checked without executing any query, context or render operator. */
function constant(expr: Expr, bindings: Map<string, unknown>): unknown | typeof UNKNOWN {
  if (expr.kind === 'literal') return expr.value;
  if (expr.kind === 'ref') return bindings.has(expr.name) ? bindings.get(expr.name) : UNKNOWN;
  if (expr.kind === 'call') return expr.operator === 'data' ? constant(expr.args[0], bindings) : UNKNOWN;
  if (expr.kind === 'project') {
    const value = constant(expr.input, bindings);
    if (value === UNKNOWN) return UNKNOWN;
    if (value === null || typeof value !== 'object' || !Object.hasOwn(value, expr.key) ||
        (Array.isArray(value) ? typeof expr.key !== 'number' : typeof expr.key !== 'string')) return fail(projectionError(value,expr), expr.span);
    return (value as Record<string | number, unknown>)[expr.key];
  }
  const entries = expr.kind === 'array' ? expr.values.map((value, index) => [index, value] as const) : expr.entries.map(({ key, value }) => [key, value] as const);
  const values: [string | number, unknown][] = [];
  for (const [key, child] of entries) {
    const value = constant(child, bindings);
    if (value === UNKNOWN) return UNKNOWN;
    values.push([key, value]);
  }
  return expr.kind === 'array' ? values.map(([, value]) => value) : Object.fromEntries(values);
}

export function draftValueOrigin(value: DraftValue): DataOrigin {
  if (value.sources.length === 1 && value.sources[0].at.length === 0 && value.sources[0].path.length === 0) return value.sources[0].origin;
  const inputs = Object.fromEntries(value.sources.map((source, index) => [String(index), source.origin.root]));
  return appendNode(value.sources.map(source => source.origin), {
    kind: value.sources.length === 0 ? 'input' : 'transform',
    method: 'identity', data: value.data, inputs,
    inputPaths: Object.fromEntries(value.sources.map((source, index) => [String(index), jsonPath(source.path)])),
    construction: value.sources.map((source, index) => ({ input: String(index), at: source.at, path: source.path })),
  }, value.data);
}

function bindingsOf(input: DraftValue): Record<string, ReportBinding> {
  if (!isRecord(input.data)) throw new Error('Report inputs must be an object');
  return Object.fromEntries(Object.entries(input.data).map(([key, data]) => {
    const selected: DraftValue = { data, sources: input.sources.flatMap(source => source.at.length === 0
      ? [{ ...source, path: [...source.path, key] }]
      : source.at[0] === key ? [{ ...source, at: source.at.slice(1) }] : []) };
    const source = selected.sources.length === 1 ? selected.sources[0] : undefined;
    return [key, {
      src: `draft:${key}`, root: '.data', value: data, origin: draftValueOrigin(selected),
      ...(source && source.at.length === 0 && source.path.length === 0 && source.display ? { display: source.display } : {}),
    }];
  }));
}

function scalarText(value: unknown): { value: string } | { error: string } {
  return value === null || ['string', 'number', 'boolean'].includes(typeof value)
    ? { value: value===null?'无数据':typeof value === 'string' ? value : JSON.stringify(value) }
    : { error: 'Template span must select a JSON scalar' };
}

function dataNature(raw: unknown): OriginNode['nature'] {
  if (raw === undefined) return 'given';
  if (!isRecord(raw) || Object.keys(raw).some(key => key !== 'kind') || !['given', 'parameter', 'assumption', 'example'].includes(String(raw.kind))) throw new Error('data options must be {kind:"given"|"parameter"|"assumption"|"example"}');
  return raw.kind as OriginNode['nature'];
}

export function createDraftBackend(options: {
  knowledge: Pick<Knowledge, 'executorFor'>;
  entry: WorkspaceEntry;
  file: string;
  contextZone: () => ContextTimeZone;
  contextNow?:()=>number;
}): DraftBackend {
  const { knowledge, entry, file } = options;
  const checks = new Checks();
  const planEnvironment = () => ({model:entry.modelHash,domain:entry.settings.domain,compiler:1});
  const queryEnvironment = () => ({...planEnvironment(), dataFile: entry.settings.dataFile, limit: entry.settings.queryMaxRows });
  const environment = (operator: Operator): unknown => operator === 'query' ? planEnvironment() : operator === 'exec_query' ? queryEnvironment()
    : operator === 'context' ? { clock: 1 }
    : operator === 'time_windows' ? {calendar:'Temporal',version:TIME_WINDOWS_VERSION}
    : { operator, version: 2 };
  type PreparedQuery = { sql: string; bindings: unknown[]; columns: ResultColumn[]; limit_slot: number };
  const lower = async (intent: unknown, signal?: AbortSignal): Promise<PreparedQuery> => {
    const problem = limitProblem(intent);
    if (problem) throw new IntentValidationError(problem);
    const key = digest({ intent, environment: planEnvironment() });
    const cached = checks.get(key);
    if (cached?.error) throw new IntentValidationError(cached.error);
    if (cached?.result) return cached.result as PreparedQuery;
    const response = await entry.runner!.send(`${entry.settings.domain}/transform`, { intents: [intent] }, signal);
    if (signal?.aborted) throw new Error('aborted');
    const lowered = response.ok?.queries;
    if(response.ok?.accepted===false&&Array.isArray(response.ok?.diagnostics)){
      const error = `Intent rejected: ${JSON.stringify(response.ok.diagnostics)}`;
      checks.set(key, { error });throw new IntentValidationError(error);
    }
    if (response.ok?.accepted !== true || !Array.isArray(lowered) || lowered.length !== 1 || !isRecord(lowered[0]) || typeof lowered[0].sql !== 'string' || !Array.isArray(lowered[0].bindings)) {
      const error = `Intent rejected: ${JSON.stringify(response.ok?.diagnostics ?? response.error ?? response)}`;
      throw new Error(error);
    }
    const limitSlot = lowered[0].limit_slot;
    if (typeof limitSlot !== 'number' || !Number.isInteger(limitSlot) || limitSlot < 0
        || limitSlot >= lowered[0].bindings.length || lowered[0].bindings[limitSlot] !== (intent as {limit:number}).limit) {
      throw new Error('Invalid model limit_slot: expected the binding index of the requested top-level limit');
    }
    const rawColumns = lowered[0].columns;
    if (!Array.isArray(rawColumns) || !rawColumns.every(isResultColumn)
        || new Set(rawColumns.map(column => column.name)).size !== rawColumns.length) {
      throw new Error('Invalid model result columns: expected ordered {name,type,nullable} declarations');
    }
    const columns = rawColumns as ResultColumn[];
    const result: PreparedQuery = { sql: lowered[0].sql, bindings: lowered[0].bindings, limit_slot: limitSlot,
      columns: columns.map(({name, type, nullable}) => ({name, type, nullable})) };
    checks.set(key, { result });
    return result;
  };
  const sqlWorkspace=new SqlWorkspace();
  const validateFigure = (raw: unknown) => {
    if (!isRecord(raw)) throw new Error('render_figure spec must be an object');
    if (raw.kind === 'table') return parseTableSpec(raw);
    const parsed = parseChartSpec(raw);
    if ('error' in parsed) throw new Error(parsed.error);
    return parsed;
  };
  const preflight = async (document: DraftDocument, signal?: AbortSignal, options?: {validateQueries?:boolean}) => {
    const diagnostics=new DiagnosticCollector();diagnostics.reportAll(document.diagnostics??[]);
    const plannedQueries:{intent:unknown;span:Span}[]=[];
    const constants = new Map<string, unknown>();
    const visit = async (expr: Expr): Promise<void> => {
      if (expr.kind === 'array') { for (const value of expr.values) await visit(value); }
      else if (expr.kind === 'object') { for (const { value } of expr.entries) await visit(value); }
      else if (expr.kind === 'project') { await visit(expr.input); constant(expr, constants); }
      else if (expr.kind === 'call') {
        for (const arg of expr.args) await visit(arg);
        try {
          const first = expr.args[0] ? constant(expr.args[0], constants) : UNKNOWN;
          const second = expr.args[1] ? constant(expr.args[1], constants) : UNKNOWN;
          if (['render_figure', 'render_report'].includes(expr.operator) && second !== UNKNOWN && !isRecord(second)) throw new Error(`${expr.operator} inputs must be a named object`);
          if (expr.operator === 'render_figure' && second !== UNKNOWN && isRecord(second) && (!Object.hasOwn(second, 'data') || Object.keys(second).some(key => key !== 'data' && key !== 'nodes'))) throw new Error('render_figure inputs must be {data,nodes?}');
          if (expr.operator === 'time_windows' && second !== UNKNOWN) timeWindowOptions(second);
          if (expr.operator === 'query' && first !== UNKNOWN) plannedQueries.push({intent:first,span:expr.span});
          if (expr.operator === 'render_figure' && first !== UNKNOWN){try{validateFigure(componentSpec(first,expr.figureKind));}catch(error){fail(error instanceof Error?error.message:String(error),expr.args[0].span);}}
          if (expr.operator === 'data' && expr.args[1]) {
            const nature = constant(expr.args[1], constants);
            if (nature !== UNKNOWN) dataNature(nature);
          }
          if (expr.operator === 'render_report' && (expr.args[1].kind === 'object' || (second !== UNKNOWN && isRecord(second)))) {
            const asset = document.assets.get(first as string);
            if(!asset)return;
            const refs = new Set(asset.program!.refs);
            const keys = expr.args[1].kind === 'object' ? expr.args[1].entries.map(entry => entry.key) : Object.keys(second as Record<string, unknown>);
            const missing = [...refs].filter(ref => !keys.includes(ref));
            const unused = keys.filter(key => !refs.has(key));
            if (missing.length || unused.length) throw new Error(`Template bindings mismatch: missing [${missing}], unused [${unused}]`);
          }
        } catch (error) {
          if (signal?.aborted) throw error;
          if(error instanceof DraftSyntaxError)throw error;
          fail(error instanceof Error ? error.message : String(error), expr.span);
        }
      }
    };
    for (const { statement } of document.nodes) {
      try {
        await visit(statement.value);
        if (statement.kind === 'binding') {
          const value = constant(statement.value, constants);
          if (value !== UNKNOWN) constants.set(statement.name, value);
        }
      } catch(error) {
        if(signal?.aborted)throw error;
        if(!(error instanceof DraftSyntaxError))throw error;
        const figure=statement.kind==='binding'&&statement.value.kind==='call'&&statement.value.operator==='render_figure';
        diagnostics.reportAll((error.diagnostics.length?error.diagnostics:[{file,stage:figure?'figure':'validation',message:error.message,span:error.span}]).map(d=>({...d,...(statement.kind==='binding'?{asset:statement.name}:{})})));
      }
    }
    // Model-dependent checks need a locally valid document; they never execute business SQL.
    if(options?.validateQueries!==false&&!diagnostics.hasErrors())for(const query of plannedQueries){
      try{await lower(query.intent,signal);}catch(error){if(signal?.aborted||!(error instanceof IntentValidationError))throw error;diagnostics.report({file,stage:'validation',message:error.message,span:query.span});}
    }
    const errors=diagnostics.list().filter(d=>d.severity!=='warning');
    if(errors.length)throw new DraftSyntaxError(errors[0].message,errors[0].span,errors);
  };
  const checkCall = (ctx:CallContext, known:(value:unknown)=>boolean):SourceDiagnostic[] => {
    const diagnostics=new DiagnosticCollector();
    const check=(work:()=>void,span=ctx.span)=>{try{work();}catch(error){diagnostics.report({file,stage:ctx.operator==='render_figure'?'figure':ctx.operator==='render_report'?'template':'validation',message:error instanceof Error?error.message:String(error),span});}};
    const first=ctx.args[0]?.data,second=ctx.args[1]?.data;
    if(['render_figure','render_report'].includes(ctx.operator)&&ctx.args[1]&&known(second))check(()=>{if(!isRecord(second))throw new Error(`${ctx.operator} inputs must be a named object`);});
    if(ctx.operator==='data'&&ctx.args[1]&&known(second))check(()=>{dataNature(second);});
    if(ctx.operator==='time_windows'&&known(second))check(()=>{timeWindowOptions(second);});
    if(ctx.operator==='render_figure'){
      if(isRecord(second))check(()=>{if(!Object.hasOwn(second,'data')||Object.keys(second).some(key=>key!=='data'&&key!=='nodes'))throw new Error('render_figure inputs must be {data,nodes?}');});
      if(known(first))check(()=>{
        const raw=componentSpec(first,ctx.figureKind);
        validateFigure(raw);
        if(!isRecord(second))return;
        if(isRecord(second.data)&&Array.isArray(second.data.columns)){
          const columns=second.data.columns.map(c=>isRecord(c)?String(c.name):String(c));
          const spec=raw as Record<string,unknown>;
          const missing=spec.kind==='table'?(()=>{const table=parseTableSpec(spec);return [...new Set([...(table.columns??[]),...Object.keys(table.labels)])].filter(c=>!columns.includes(c));})():(()=>{const parsed=parseChartSpec(spec);if('error' in parsed)throw new Error(parsed.error);return missingColumns(parsed.spec,columns,1);})();
          if(missing.length)throw new Error(`Missing figure columns: ${missing.join(', ')}`);
          if(isBox(second.data)&&spec.kind!=='table'){
            const t=typeOf(second.data);const value=typeof spec.value==='string'?spec.value:undefined;
            const column=t.kind==='table'?t.columns.find(c=>c.name===value):undefined;
            if(column&&!['Int','Float'].includes(column.type))throw new Error(`Figure value ${value} requires a numeric column, got ${column.type}`);
            if(t.kind==='table'&&(spec.kind==='line'||spec.kind==='area')){
              const x=t.columns.find(c=>c.name===spec.x);
              const compatible:Record<string,string[]>={Int:['Int'],Float:['Int','Float'],String:['String'],Rfc3339:['String','DateTimeUtc'],EpochMillis:['Int','EpochMillis']};
              if(x&&!compatible[String(spec.xType)]?.includes(x.type))throw new Error(`Figure x ${spec.x} with xType ${spec.xType} has incompatible column type ${x.type}`);
            }
          }
        }
        if(!known(second.data))return;
        const rows=rowsOf(second.data,'render_figure.data');
        const spec=raw as Record<string,unknown>;
        if(spec.kind==='table'){
          const parsed=parseTableSpec(spec);
          const columns=new Set(rows.flatMap(row=>Object.keys(row)));
          const missing=rows.length?[...new Set([...(parsed.columns??[]),...Object.keys(parsed.labels)])].filter(c=>!columns.has(c)):[];
          if(missing.length)throw new Error(`Missing figure columns: ${missing.join(', ')}`);
        }else{
          const parsed=parseChartSpec(spec);
          if('error' in parsed)throw new Error(parsed.error);
          const columns=[...new Set(rows.flatMap(row=>Object.keys(row)))];
          const missing=missingColumns(parsed.spec,columns,rows.length);
          if(missing.length)throw new Error(`Missing figure columns: ${missing.join(', ')}`);
          const issue=shapeProblem(rows,parsed.spec);if(issue)throw new Error(issue);
          if(parsed.spec.kind==='graph'&&known(second.nodes))rowsOf(second.nodes,'render_figure.nodes');
        }
      });
    }
    if(ctx.operator==='render_report'&&ctx.asset?.program&&isRecord(second)){
      const program=ctx.asset.program;
      const refs=new Set(program.refs);
      check(()=>{
        const missing=[...refs].filter(key=>!Object.hasOwn(second,key));
        const unused=Object.keys(second).filter(key=>!refs.has(key));
        if(missing.length||unused.length)throw new Error(`Template bindings mismatch: missing [${missing}], unused [${unused}]`);
      });
      for(const [name,reference]of Object.entries(ctx.asset.references??{}))if(reference.kind==='condition')check(()=>{
        const t=typeOf(second[name]);
        if(t.kind!=='scalar'||t.name!=='Bool'||t.nullable)throw new Error('if condition requires Bool, got '+show(t)+'; use ?? False for Option(Bool)');
      },reference.span);
      for(const [name,reference]of Object.entries(ctx.asset.references??{}))if(reference.kind==='value'&&isBox(second[name]))check(()=>{const t=typeOf(second[name]);if(t.kind!=='scalar'&&t.kind!=='null')throw new Error('Value.data must select a scalar, got '+show(t));},reference.span);
      for(const [name,reference]of Object.entries(ctx.asset.references??{}))if(reference.kind==='value'&&known(second[name]))check(()=>{
        const value=unbox(second[name]);
        if(value!==null&&!['string','number','boolean'].includes(typeof value))throw new Error('Value.data must select a scalar; construct a summary in pipeline');
      },reference.span);

    }
    return diagnostics.list();
  };
  const contextValue = (now:number):Computed => {
      const { zone } = resolveZone(undefined, options.contextZone());
      const encoded = encode(now, zone);
      return { data: {
        utc: { epochMillis: encoded.epochMillis, epochSeconds: Math.floor(encoded.epochMillis / 1000), rfc3339: new Date(encoded.epochMillis).toISOString() },
        tz: { client: { id: encoded.zone, offset: encoded.offset, offsetMinutes: encoded.offsetMinutes } },
      }, evidence: { acquiredAt: new Date(encoded.epochMillis).toISOString() } };
  };
  const parameterValue = async (ctx:CallContext):Promise<Computed> => {
    if (ctx.operator === 'data') {
      dataNature(ctx.args[1]?.data);
      return { data: ctx.args[0].data };
    }
    if (ctx.operator === 'query') {
      const intent = ctx.args[0].data;
      const lowered = await lower(intent, ctx.signal);
      const plan:QueryPlan={...lowered,intent,environment:digest(planEnvironment())};
      return {data:{columns:lowered.columns},evidence:{plan}};
    }
    if (ctx.operator === 'time_windows') {
      ctx.signal?.throwIfAborted();
      const data=timeWindows(ctx.args[0].data,ctx.args[1].data);
      const point=record({epochMillis:scalar('EpochMillis'),dateTimeUtc:scalar('DateTimeUtc'),rfc3339:scalar('String')});
      return {data,logicalType:{kind:'array',element:record({label:scalar('String'),zone:scalar('String'),start:point,end:point}),length:data.length,nullable:false} satisfies Ty};
    }
    throw new DraftSyntaxError('Not a parameter operator: '+ctx.operator,ctx.span);
  };
  const execute = async (ctx: CallContext): Promise<Computed> => {
    if(['typed_value','relational','relational_one','table_union','typed_table'].includes(ctx.operator))return runTyped(ctx,sqlWorkspace,false);
    if(['data','time_windows','query'].includes(ctx.operator))return parameterValue(ctx);
    if (ctx.operator === 'context') return contextValue(options.contextNow?.()??Date.now());
    if(ctx.operator==='exec_query') {
      const plan=ctx.args[0].plan;
      if(!plan)throw new Error('exec_query requires a complete plan returned by query(intent); JSON objects and projections are not executable plans');
      if(plan.environment!==digest(planEnvironment()))throw new Error('Query plan belongs to a different model/compiler environment; regenerate it with query(intent)');
      const {intent}=plan;
      const lowered=plan;
      const dataFile = entry.settings.dataFile;
      let observed: Record<string, unknown> = dataFile === undefined ? {} : { dataFile };
      if (dataFile) {
        try { const info = statSync(dataFile); observed = { dataFile, bytes: info.size, modifiedAt: new Date(info.mtimeMs).toISOString() }; }
        catch { observed.readable = false; }
      }
      const acquiredAt = new Date().toISOString();
      const { executor, manifest } = knowledge.executorFor(entry.settings);
      const limit = (intent as { limit: number }).limit;
      const bindings = [...lowered.bindings];
      bindings[lowered.limit_slot] = limit + 1;
      const outcome = await executor.send(lowered.sql, bindings, ctx.signal, limit + 1);
      const truncated = outcome.truncated || outcome.rows.length > limit;
      if (lowered.columns && (lowered.columns.length !== outcome.columns.length
          || lowered.columns.some((column, index) => column.name !== outcome.columns[index]))) {
        throw new Error('Model result columns do not match SQL result column order');
      }
      const described = describeRows(outcome.columns, outcome.rows.slice(0, limit));
      validateTypedRows(described.rows,lowered.columns);
      const data = { rows: described.rows, columns: lowered.columns ?? described.columns, truncated };
      return { data, evidence: { ...observed, acquiredAt, model: entry.modelHash, domain: entry.settings.domain, batch: ctx.batch, manifest } };
    }
    if (ctx.operator === 'render_figure') {
      const raw = componentSpec(ctx.args[0].data,ctx.figureKind);
      validateFigure(raw);
      const spec = raw as Record<string, unknown>;
      const input = ctx.args[1].data;
      if (!isRecord(input) || !Object.hasOwn(input, 'data') || Object.keys(input).some(key => key !== 'data' && key !== 'nodes')) throw new Error('render_figure inputs must be {data, nodes?}');
      const rows = rowsOf(input.data, 'render_figure.data');
      if (spec.kind === 'table') {
        const parsed = parseTableSpec(spec);
        const table = tableMarkdown(rows, { ...(parsed.columns ? { columns: parsed.columns } : {}), labels:parsed.labels, ...(parsed.title ? { title: parsed.title } : {}) });
        if ('error' in table) throw new Error(table.error);
        return { data: { rows, spec }, evidence: { display: { kind: 'table', content: table.embedded } } };
      }
      const parsed = parseChartSpec(spec);
      if ('error' in parsed) throw new Error(parsed.error);
      const columns = [...new Set(rows.flatMap(row => Object.keys(row)))];
      const missing = missingColumns(parsed.spec, columns, rows.length);
      if (missing.length) throw new Error(`Missing figure columns: ${missing.join(', ')}`);
      const issue = shapeProblem(rows, parsed.spec);
      if (issue) throw new Error(issue);
      const nodeRows = parsed.spec.kind === 'graph' ? rowsOf(input.nodes, 'render_figure.nodes') : undefined;
      const { option, height } = buildOption(rows, parsed.spec, nodeRows);
      const svg = embedFigureCsv(renderEchartsSvg(option, CHART_WIDTH, height), {rows,spec,...(nodeRows?{nodeRows}:{})});
      return { data: { rows, spec: parsed.spec, ...(nodeRows ? { nodeRows } : {}) }, evidence: { title: chartTitle(parsed.spec), display: { kind: 'chart', content: svg } } };
    }
    if (ctx.operator === 'render_report') {
      if (!isRecord(ctx.args[1].data)) throw new Error('Report inputs must be a named object');
      for(const [name,ref]of Object.entries(ctx.asset!.references??{}))if(ref.kind==='value'||ref.kind==='condition'){
        const value=ctx.args[1].data[name];
        if(ref.kind==='condition'&&typeof value!=='boolean')fail('if condition requires Bool',ref.span);
        if(value!==null&&!['string','number','boolean'].includes(typeof value))fail('Value.data must select a scalar; construct a summary in pipeline',ref.span);
      }
      return { data: { items: ctx.args[1].data } };
    }
    throw new Error(`Unsupported operator ${ctx.operator}`);
  };
  const assemble = (ctx: CallContext, computed: Computed): DraftValue => {
    const named = ctx.operator === 'time_windows' ? bindingsOf({data:{ctx:ctx.args[0].data},sources:ctx.args[0].sources.map(source=>({...source,at:['ctx',...source.at]}))}) : ['typed_value','relational','relational_one','render_figure'].includes(ctx.operator) ? bindingsOf(ctx.args[1] ?? { data: {}, sources: [] }) : undefined;
    const parents = named ? Object.values(named).map(binding => binding.origin) : ctx.args.map(draftValueOrigin);
    const inputs = named ? Object.fromEntries(Object.entries(named).map(([key, binding]) => [key, binding.origin.root])) : Object.fromEntries(parents.map((parent, index) => [String(index), parent.root]));
    const node: OriginNode = {
      kind: ctx.operator === 'exec_query' ? 'query' : ctx.operator === 'data' ? 'input' : ctx.operator === 'context' ? 'context' : ctx.operator === 'render_figure' ? 'display' : 'transform',
      motivation: ctx.statement.motivation,
      inputs,
      ...(named ? { inputPaths: Object.fromEntries(Object.keys(named).map(key => [key, '.data'])) } : {}),
      draft: { file, hash: ctx.sourceHash, line: ctx.span.start.line, column: ctx.span.start.column, ...(ctx.asset ? { asset: ctx.asset.name } : {}) },
      ...(ctx.operator === 'exec_query' ? { intent: ctx.args[0].plan!.intent, source: computed.evidence } : {}),
      ...(ctx.operator === 'query' ? {method:'identity' as const,data:computed.data,intent:ctx.args[0].data} : {}),
      ...(ctx.operator === 'data' || ctx.operator === 'context' ? { data: computed.data } : {}),
      ...(ctx.operator === 'data' ? { nature: dataNature(ctx.args[1]?.data) } : {}),
      ...(['typed_value','relational','relational_one','table_union','typed_table'].includes(ctx.operator)?{method:'pipeline' as const,snip:typeof ctx.args[0]?.data==='string'?ctx.args[0].data:ctx.operator,inputShape:'named' as const,outputs:1}:{}),
      ...(ctx.operator === 'time_windows' ? {method:'pipeline' as const,snip:JSON.stringify({operator:'time_windows',version:TIME_WINDOWS_VERSION,options:ctx.args[1].data}),inputShape:'named' as const,outputs:1} : {}),
      ...(ctx.operator === 'render_figure' ? { spec: (computed.data as {spec:unknown}).spec } : {}),
    };
    let origin = appendNode(parents, node, computed.data);
    if (ctx.operator === 'render_report') {
      let bindings = bindingsOf(ctx.args[1]);
      const items=Object.fromEntries(Object.entries(bindings).map(([name,binding])=>[name,binding.value]));
      const selected=selectReport(ctx.asset!.program!,items);
      const title = ctx.asset?.title ?? ctx.title ?? ctx.asset!.name.replace(/^@report\//,'');
      if(ctx.asset?.format==='markdown'){
        const reportValues=Object.fromEntries(Object.entries(ctx.asset.references??{}).filter(([alias,ref])=>ref.kind==='value'&&selected.refs.includes(alias)).map(([alias,ref])=>[ref.code??alias,bindings[alias].value]));
        return {data:{items},reportValues,sources:[{origin,at:[],path:[]}]};
      }
      bindings=Object.fromEntries(Object.entries(bindings).filter(([name])=>selected.refs.includes(name)));
      const report = assembleReport({ name: 'answer', title, subtitle: null, category: '即时分析', at: resultStamp(), draft: node.draft, motivation: node.motivation, program:selected, figurePlacement:ctx.asset!.figurePlacement, bindings,
        valueOf: (ref) => scalarText(bindings[ref]?.value),
      });
      if ('error' in report) throw new Error(report.error);
      origin = restoreAssets(report.origin, report.assets);
      const reportValues=Object.fromEntries(Object.entries(ctx.asset!.references!)
        .filter(([ref,reference])=>reference.kind==='value'&&selected.refs.includes(ref))
        .map(([ref,reference])=>[reference.code??ref,bindings[ref].value]));
      return { data: { assets: report.assets, items: report.items }, reportValues, sources: [{ origin, at: [], path: [], delivery: { html: report.page, title } }] };
    }
    const evidence = computed.evidence as { display?: { kind: 'chart' | 'table'; content: string } } | undefined;
    return { logicalType:computed.logicalType, data: computed.data, sources: [{ origin, at: [], path: [], ...(evidence?.display ? { display: evidence.display } : {}) }],
      ...(ctx.operator==='query'?{plan:(computed.evidence as {plan:QueryPlan}).plan}:{}) };
  };
  const analyze = async (ctx:CallContext):Promise<Computed> => {
    if(ctx.operator==='context')return contextValue(ANALYSIS_CONTEXT_TIME);
    if(['typed_value','relational','relational_one','table_union','typed_table'].includes(ctx.operator))return runTyped(ctx,sqlWorkspace,true);
    // These implementations only compute parameter values or transform an intent into a schema/plan.
    if(['data','time_windows','query'].includes(ctx.operator)){
      try{return await parameterValue(ctx);}catch(error){if(error instanceof IntentValidationError)throw new DraftSyntaxError(error.message,ctx.span);throw error;}
    }
    throw new DraftSyntaxError('Operator is not available during analysis: '+ctx.operator,ctx.span);
  };
  return { preflight, checkCall, analyze, beginRun:run=>sqlWorkspace.beginRun(run), finishRun:async run=>sqlWorkspace.finishRun(run), dispose:()=>{void sqlWorkspace.clear();}, environment, execute, assemble, executionContext:()=>({hash:entry.modelHash??null,domain:entry.settings?.domain??null}) };
}
