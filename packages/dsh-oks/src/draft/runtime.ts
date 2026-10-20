import { COMPONENT_KINDS, type FigureKind } from './components.ts';
import { createHash, randomUUID } from 'node:crypto';
import { canonicalJson } from '../key.ts';
import { isRecord } from '../host.ts';
import { parseDraft } from './document.ts';
import type { DraftDocument, DraftAsset } from './document.ts';
import { DraftSyntaxError } from './pipeline.ts';
import type { Expr, Operator, Span, Statement, SourceDiagnostic, PipelineNode } from './pipeline.ts';
import type { DataOrigin, ResultColumn } from '../results.ts';

/** at identifies the value's location in a constructor; path identifies its original upstream projection. */
export type ValueSource = { display?: { kind: 'chart' | 'table'; content: string }; delivery?: { html: string; title: string }; origin: DataOrigin; at: (string | number)[]; path: (string | number)[] };
/** Internal plan payload; carried by a whole value reference, never by JSON construction/projection. */
export type QueryPlan = { environment: string; intent: unknown; sql: string; bindings: unknown[]; columns: ResultColumn[]; limit_slot: number };
export type DraftValue = { data: unknown; sources: ValueSource[]; plan?: QueryPlan };
export type Computed = { data: unknown; evidence?: unknown };
export type CallContext = {
  operator: Operator;
  figureKind?: FigureKind;
  args: DraftValue[];
  asset?: DraftAsset;
  statement: Statement;
  span: Span;
  run: string;
  batch: string;
  sourceHash: string;
  title?: string;
  signal?: AbortSignal;
};
export interface DraftBackend {
  /** Deterministic checks must complete before execute is called for any node. */
  preflight(document: DraftDocument, signal?: AbortSignal): Promise<void>;
  /** Include the actual compiler/model/source/renderer environment affecting this operator. */
  environment(operator: Operator): unknown;
  execute(context: CallContext): Promise<Computed>;
  /** Called even on a cache hit: computation reuse must not reuse the previous inputs' provenance. */
  assemble(context: CallContext, computed: Computed): DraftValue;
}
export type OutputState = {
  status: 'executed' | 'cached' | 'failed' | 'blocked';
  span: Span;
  internal?: boolean;
  display?: PipelineNode['display'];
  value?: DraftValue;
  error?: string;
  context?: { operator: Operator; component?: string; asset?: string; bindings: string[] };
};
export type Acquisition = {
  binding: string;
  operator: 'exec_query' | 'context';
  at: { line: number; column: number };
  status: 'executed' | 'cached';
  reason: 'reused' | 'refresh' | 'environment-changed' | 'cache-reclaimed' | 'no-retained-acquisition';
  acquiredAt: string;
  fromRun: string;
  fromBatch: string;
};
export type DraftRun = {
  id: string;
  sourceHash: string;
  batch: string;
  at: number;
  status: 'running' | 'complete' | 'invalid' | 'cancelled';
  outputs: Map<string, OutputState>;
  acquisitions: Acquisition[];
  error?: string;
  errorSpan?: Span;
  diagnostics?:SourceDiagnostic[];
  answers?:string[];
};
type Capture = Pick<Acquisition, 'acquiredAt' | 'fromRun' | 'fromBatch'>;
type CacheEntry = { result: Computed; bytes: number; acquisition: boolean; capture?: Capture; at: number };
class Blocked extends Error {}
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/** One instance belongs to one workspace/session/source. The host owns the instance registry and disposal. */
export class DraftRuntime {
  private readonly backend: DraftBackend;
  private readonly parse:(source:string,file?:string)=>DraftDocument;
  private readonly file:string;
  private readonly now: () => number;
  private readonly maxCacheBytes: number;
  private readonly maxCacheEntries: number;
  private readonly retentionMs: number;
  private readonly maxOutputBytes: number;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly acquisitionHistory = new Map<string, { environment: string; batch: string }>();
  private readonly captured = new Set<string>();
  private bytes = 0;
  private batch = randomUUID();
  private latest?: DraftRun;
  private active = false;

  constructor(backend: DraftBackend, options: { file?:string;parse?:(source:string,file?:string)=>DraftDocument;now?: () => number; maxCacheBytes?: number; maxCacheEntries?: number; retentionMs?: number; maxOutputBytes?: number } = {}) {
    this.backend = backend;
    this.parse=options.parse??parseDraft;this.file=options.file??'draft.dari';
    this.now = options.now ?? Date.now;
    this.maxCacheBytes = options.maxCacheBytes ?? 16 * 1024 * 1024;
    this.maxCacheEntries = options.maxCacheEntries ?? 128;
    this.retentionMs = options.retentionMs ?? 30 * 60 * 1000;
    this.maxOutputBytes = options.maxOutputBytes ?? 32 * 1024 * 1024;
    if (![this.maxCacheBytes, this.maxCacheEntries, this.retentionMs, this.maxOutputBytes].every(value => Number.isSafeInteger(value) && value >= 0) || this.retentionMs === 0) throw new Error('Invalid draft cache limits');
  }

  private remove(key: string) {
    const entry = this.cache.get(key);
    if (entry) this.bytes -= entry.bytes;
    this.cache.delete(key);
  }
  private collect() {
    const cutoff = this.now() - this.retentionMs;
    for (const [key, entry] of this.cache) if (entry.at < cutoff) this.remove(key);
    if (!this.active && this.latest && this.latest.at < cutoff) this.latest = undefined;
  }
  private cached(key: string): Computed | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    this.cache.delete(key);
    entry.at = this.now();
    this.cache.set(key, entry);
    return structuredClone(entry.result);
  }
  private store(key: string, result: Computed, acquisition: boolean, capture?: Capture) {
    const bytes = Buffer.byteLength(canonicalJson(result));
    if (bytes > this.maxCacheBytes || this.maxCacheEntries === 0) return;
    this.remove(key);
    while (this.cache.size >= this.maxCacheEntries || this.bytes + bytes > this.maxCacheBytes) {
      // Pure calculations can be rebuilt; retained acquisitions stay pinned until renewal/expiry.
      const candidate=[...this.cache].find(([,entry])=>!entry.acquisition);
      if(!candidate)return;
      this.remove(candidate[0]);
    }
    this.cache.set(key, { result: structuredClone(result), bytes, acquisition, capture, at: this.now() });
    this.bytes += bytes;
  }

  private resetAcquisitions() {
    this.batch = randomUUID();
    this.captured.clear();
    for (const [key,entry] of this.cache) if(entry.acquisition) this.remove(key);
  }

  /** Starts a new capture batch without evaluating source or accessing business data. */
  renew(): string {
    if(this.active) throw new Error('This draft is already running; wait for it to finish');
    this.resetAcquisitions();
    this.latest=undefined;
    return this.batch;
  }

  async run(source: string, options: { refresh?: boolean; signal?: AbortSignal } = {}): Promise<DraftRun> {
    if (this.active) throw new Error('This draft is already running; wait for that run to finish');
    this.collect();
    this.active = true;
    // Install the new run before parsing: invalid source must not reveal an older successful binding.
    const run: DraftRun = { id: randomUUID(), sourceHash: hash(source), batch: this.batch, at: this.now(), status: 'running', outputs: new Map(), acquisitions: [] };
    this.latest = run;
    try {
      const document = this.parse(source,this.file);
      run.answers=document.answers;
      if (options.signal?.aborted) throw new Error('aborted');
      await this.backend.preflight(document, options.signal);
      if (options.signal?.aborted) throw new Error('aborted');
      if (options.refresh) {
        this.resetAcquisitions();
      }
      run.batch = this.batch;
      let debug = 0;
      let outputBytes = 0;
      for (const node of document.nodes) {
        const statement = node.statement;
        const name = statement.kind === 'binding' ? statement.name : `debug/${++debug}`;
        if (options.signal?.aborted) {
          run.outputs.set(name, { status: 'blocked', span: statement.span, error: 'aborted',internal:node.internal,...(node.display?{display:node.display}:{}) });
          continue;
        }
        let executed = false;
        let failedCall: CallContext | undefined;
        const evaluate = async (expr: Expr): Promise<DraftValue> => {
          if (expr.kind === 'literal') return { data: expr.value, sources: [] };
          if (expr.kind === 'ref') {
            const output = run.outputs.get(expr.name);
            if (!output?.value) throw new Blocked(`Upstream ${output?.display?.label??expr.name} is ${output?.status ?? 'unavailable'}`);
            return output.value;
          }
          if (expr.kind === 'array' || expr.kind === 'object') {
            const entries: [string | number, Expr][] = expr.kind === 'array'
              ? expr.values.map((value, index) => [index, value])
              : expr.entries.map(({ key, value }) => [key, value]);
            const values: [string | number, DraftValue][] = [];
            for (const [key, entry] of entries) values.push([key, await evaluate(entry)]);
            return {
              data: expr.kind === 'array' ? values.map(([, value]) => value.data) : Object.fromEntries(values.map(([key, value]) => [key, value.data])),
              sources: values.flatMap(([key, value]) => value.sources.map(source => ({ ...source, at: [key, ...source.at] }))),
            };
          }
          if (expr.kind === 'project') {
            const input = await evaluate(expr.input);
            const isArray = Array.isArray(input.data);
            if (input.data === null || typeof input.data !== 'object' ||
                (isArray ? typeof expr.key !== 'number' : typeof expr.key !== 'string') || !Object.hasOwn(input.data, expr.key)) {
              throw new DraftSyntaxError(`Projection ${JSON.stringify(expr.key)} is missing or has the wrong container type`,expr.span);
            }
            return {
              data: (input.data as Record<string | number, unknown>)[expr.key],
              sources: input.sources.flatMap(source => source.at.length === 0
                ? [{ ...source, path: [...source.path, expr.key] }]
                : source.at[0] === expr.key ? [{ ...source, at: source.at.slice(1) }] : []),
            };
          }
          const args: DraftValue[] = [];
          for (const arg of expr.args) args.push(await evaluate(arg));
          const asset = expr.operator === 'jq' || expr.operator === 'render_html' ? document.assets.get(args[0].data as string) : undefined;
          const context: CallContext = { operator: expr.operator, figureKind:expr.figureKind, args, asset, statement, span: expr.span, run: run.id, batch: run.batch, sourceHash: run.sourceHash, title: document.title, signal: options.signal };
          const acquisition = expr.operator === 'exec_query' || expr.operator === 'context';
          const environment = this.backend.environment(expr.operator);
          const key = hash(canonicalJson({
            operator: expr.operator,
            figureKind: expr.figureKind ?? null,
            args: asset ? [asset.source, ...args.slice(1).map(value => value.data)] : args.map(value => expr.operator==='exec_query'?{data:value.data,plan:value.plan??null}:value.data),
            environment,
            batch: acquisition ? run.batch : null,
          }));
          let result = this.cached(key);
          const hit = result !== undefined;
          if (!result) {
            failedCall = context;
            if(acquisition && this.captured.has(key))
              throw new Error('Captured snapshot was reclaimed; use refresh:true or renew_context before acquiring it again');
            if(acquisition && this.captured.size>=4096)
              throw new Error('Acquisition identity budget exceeded; use refresh:true or renew_context');
            result = await this.backend.execute(context);
            if (options.signal?.aborted) throw new Error('aborted');
          }
          // Assemble with current inputs before admitting a new successful computation to the cache.
          failedCall = context;
          const value = this.backend.assemble(context, structuredClone(result));
          failedCall = undefined;
          let capture: Capture | undefined;
          if (acquisition) {
            const identity = hash(canonicalJson([expr.operator, args.map(arg => expr.operator==='exec_query'?{data:arg.data,plan:arg.plan??null}:arg.data)]));
            const previous = this.acquisitionHistory.get(identity);
            const environmentHash = hash(canonicalJson(environment));
            const reason = hit ? 'reused' : options.refresh || (previous && previous.batch !== run.batch) ? 'refresh'
              : previous && previous.environment !== environmentHash ? 'environment-changed'
              : previous ? 'cache-reclaimed' : 'no-retained-acquisition';
            const evidenceTime = isRecord(result.evidence) && typeof result.evidence.acquiredAt === 'string' ? result.evidence.acquiredAt : undefined;
            capture = hit ? this.cache.get(key)?.capture : { acquiredAt: evidenceTime ?? new Date(this.now()).toISOString(), fromRun: run.id, fromBatch: run.batch };
            if (!capture) throw new Error('Cached acquisition is missing its capture record');
            run.acquisitions.push({ binding: name, operator: expr.operator as 'exec_query' | 'context', at: { line: expr.span.start.line, column: expr.span.start.column }, status: hit ? 'cached' : 'executed', reason, ...capture });
            this.acquisitionHistory.delete(identity);
            if (this.acquisitionHistory.size >= 128) this.acquisitionHistory.delete(this.acquisitionHistory.keys().next().value!);
            this.acquisitionHistory.set(identity, { environment: environmentHash, batch: run.batch });
          }
          if(acquisition) this.captured.add(key);
          if (!hit) { this.store(key, result, acquisition, capture); executed = true; }
          return value;
        };
        try {
          const value = await evaluate(statement.value);
          const bytes = Buffer.byteLength(canonicalJson(value));
          if (outputBytes + bytes > this.maxOutputBytes) throw new Error('Draft run output storage budget exceeded; narrow the pipeline outputs');
          outputBytes += bytes;
          run.outputs.set(name, { status: executed ? 'executed' : 'cached', value, span: statement.span,internal:node.internal,...(node.display?{display:node.display}:{}) });
        } catch (error) {
          const location=error instanceof DraftSyntaxError?error.span:failedCall?.span??statement.span;
          const context = failedCall ? {operator:failedCall.operator,
            ...(failedCall.figureKind?{component:Object.keys(COMPONENT_KINDS).find(key=>COMPONENT_KINDS[key as keyof typeof COMPONENT_KINDS]===failedCall!.figureKind)!}:{}),
            ...(failedCall.asset?{asset:failedCall.asset.name}:{}),bindings:node.bindings} : undefined;
          run.outputs.set(name, { status: error instanceof Blocked ? 'blocked' : 'failed', error: `${this.file}:${location.start.line}:${location.start.column}: ${message(error)}`, span: location,internal:node.internal,...(node.display?{display:node.display}:{}), ...(context?{context}:{}) });
        }
      }
      run.status = options.signal?.aborted ? 'cancelled' : 'complete';
    } catch (error) {
      run.status = options.signal?.aborted ? 'cancelled' : 'invalid';
      run.error = message(error);
      if (error instanceof DraftSyntaxError) {
        run.errorSpan = error.span;
        run.diagnostics=error.diagnostics.length?error.diagnostics:[{file:this.file,stage:'validation',message:error.message,span:error.span}];
        run.error=`${this.file}:${error.span.start.line}:${error.span.start.column}: ${error.message}`;
      }
    } finally {
      this.active = false;
    }
    return structuredClone(run);
  }

  /** Read never restores or recomputes. The caller supplies the current source snapshot only to mark edits. */
  read(name: string, currentSource: string): { run: string; sourceHash: string; stale: boolean; value: DraftValue } {
    this.collect();
    const run = this.latest;
    if (!run) throw new Error('No retained run for this draft');
    if (run.status === 'running' || run.status === 'invalid') throw new Error(`Latest draft run is ${run.status}`);
    const output = run.outputs.get(name);
    if (!output) throw new Error(`Output ${name} is not defined in the latest run`);
    if(output.internal)throw new Error('Internal template nodes are not public bindings');
    if (!output.value) throw new Error(`Output ${name} is ${output.status}: ${output.error ?? ''}`);
    return { run: run.id, sourceHash: run.sourceHash, stale: hash(currentSource) !== run.sourceHash, value: structuredClone(output.value) };
  }

  describe(currentSource: string) {
    this.collect();
    const run = this.latest;
    if (!run) throw new Error('No retained run for this draft');
    return {
      run: run.id, sourceHash: run.sourceHash, stale: hash(currentSource) !== run.sourceHash, status: run.status,
      outputs: [...run.outputs].map(([name, output]) => ({ name:output.display?.label??name, ...(output.display?{...output.display}:{}), status: output.status, span: output.span, ...(output.context?{context:output.context}:{}), ...(output.error ? { error: output.error } : {}) })),
    };
  }

  dispose() {
    if (this.active) throw new Error('Cannot dispose an active draft runtime');
    this.latest = undefined;
    this.cache.clear();
    this.acquisitionHistory.clear();
    this.captured.clear();
    this.bytes = 0;
  }
}
