import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import { canonicalJson } from '../key.ts';
import { isRecord } from '../host.ts';
import type { Knowledge, WorkspaceEntry } from '../knowledge.ts';
import type { JaqCheckOptions, JaqOptions, JaqOutcome } from '../jaq.ts';
import { checkJaq, runJaq, JaqCompileError } from '../jaq.ts';
import { limitProblem } from '../intent-limit.ts';
import { appendNode, describeRows, isResultColumn, originOf, rowsOf, resultStamp } from '../results.ts';
import type { DataOrigin, OriginNode, ResultColumn } from '../results.ts';
import { timeWindowCode } from '../time-programs.ts';
import { encode, resolveZone } from '../time.ts';
import type { ContextTimeZone } from '../time.ts';
import { tableMarkdown } from '../view/table.ts';
import { buildOption, CHART_WIDTH } from '../chart/option.ts';
import { renderEchartsSvg } from '../chart/echarts.ts';
import { applyInferredXType, chartTitle, missingColumns, parseChartSpec, parseTableSpec, shapeProblem } from '../chart/spec.ts';
import { checkAuthorXhtml } from '../report/xhtml.ts';
import { assembleReport } from '../report/assemble.ts';
import type { ReportBinding } from '../report/assemble.ts';
import { restoreAssets } from '../report/page.ts';
import { DraftSyntaxError } from './pipeline.ts';
import type { Expr, Operator, Span } from './pipeline.ts';
import type { DraftAsset, DraftDocument } from './document.ts';
import type { CallContext, Computed, DraftBackend, DraftValue } from './runtime.ts';

const UNKNOWN = Symbol('dynamic');
const digest = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
const jsonPath = (path: (string | number)[]) => '.data' + path.map(key => `[${JSON.stringify(key)}]`).join('');
const fail = (message: string, span: Span): never => { throw new DraftSyntaxError(message, span); };

type CachedCheck = { error?: string; result?: unknown };
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

/** Determine values that can be checked without executing any query, jq, context or render operator. */
function constant(expr: Expr, bindings: Map<string, unknown>): unknown | typeof UNKNOWN {
  if (expr.kind === 'literal') return expr.value;
  if (expr.kind === 'ref') return bindings.has(expr.name) ? bindings.get(expr.name) : UNKNOWN;
  if (expr.kind === 'call') return expr.operator === 'data' ? constant(expr.args[0], bindings) : UNKNOWN;
  if (expr.kind === 'project') {
    const value = constant(expr.input, bindings);
    if (value === UNKNOWN) return UNKNOWN;
    if (value === null || typeof value !== 'object' || !Object.hasOwn(value, expr.key) ||
        (Array.isArray(value) ? typeof expr.key !== 'number' : typeof expr.key !== 'string')) return fail('Invalid static projection', expr.span);
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
  if (!isRecord(input.data)) throw new Error('render_html inputs must be an object');
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

function pickScalar(value: unknown, raw: string | undefined): { value: string } | { error: string } {
  if (raw && raw !== '.') {
    if (!/^\.(?:[A-Za-z_][A-Za-z0-9_]*|[0-9]+)(?:\.(?:[A-Za-z_][A-Za-z0-9_]*|[0-9]+))*$/.test(raw)) return { error: `Invalid scalar pick ${raw}` };
    for (const key of raw.slice(1).split('.')) {
      if (!value || typeof value !== 'object' || !Object.hasOwn(value, key)) return { error: `Missing scalar pick ${raw}` };
      value = (value as Record<string, unknown>)[key];
    }
  }
  return value === null || ['string', 'number', 'boolean'].includes(typeof value)
    ? { value: typeof value === 'string' ? value : JSON.stringify(value) }
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
  jq?: { run: (source: string, options: JaqOptions) => Promise<JaqOutcome>; check: (source: string, options: JaqCheckOptions) => Promise<{ cached: boolean }> };
}): DraftBackend {
  const { knowledge, entry, file } = options;
  const jq = options.jq ?? { run: runJaq, check: checkJaq };
  const checks = new Checks();
  const queryEnvironment = () => ({ model: entry.modelHash, domain: entry.settings.domain, dataFile: entry.settings.dataFile, limit: entry.settings.queryMaxRows });
  const environment = (operator: Operator): unknown => operator === 'query' ? queryEnvironment()
    : operator === 'context' ? { clock: 1, zone: options.contextZone() }
    : { operator, version: 1 };
  type PreparedQuery = { sql: string; bindings: unknown[]; columns?: ResultColumn[]; limit_slot: number };
  const lower = async (intent: unknown, signal?: AbortSignal): Promise<PreparedQuery> => {
    const problem = limitProblem(intent);
    if (problem) throw new Error(problem);
    const key = digest({ intent, environment: queryEnvironment() });
    const cached = checks.get(key);
    if (cached?.error) throw new Error(cached.error);
    if (cached?.result) return cached.result as PreparedQuery;
    const response = await entry.runner!.send(`${entry.settings.domain}/transform`, { intents: [intent] }, signal);
    if (signal?.aborted) throw new Error('aborted');
    const lowered = response.ok?.queries;
    if (response.ok?.accepted !== true || !Array.isArray(lowered) || lowered.length !== 1 || !isRecord(lowered[0]) || typeof lowered[0].sql !== 'string' || !Array.isArray(lowered[0].bindings)) {
      const error = `Intent rejected: ${JSON.stringify(response.ok?.diagnostics ?? response.error ?? response)}`;
      if (response.ok?.accepted === false && Array.isArray(response.ok?.diagnostics)) checks.set(key, { error });
      throw new Error(error);
    }
    const limitSlot = lowered[0].limit_slot;
    if (typeof limitSlot !== 'number' || !Number.isInteger(limitSlot) || limitSlot < 0
        || limitSlot >= lowered[0].bindings.length || lowered[0].bindings[limitSlot] !== (intent as {limit:number}).limit) {
      throw new Error('Invalid model limit_slot: expected the binding index of the requested top-level limit');
    }
    const rawColumns = lowered[0].columns;
    if (rawColumns !== undefined && (!Array.isArray(rawColumns) || !rawColumns.every(isResultColumn)
        || new Set(rawColumns.map(column => column.name)).size !== rawColumns.length)) {
      throw new Error('Invalid model result columns: expected ordered {name,type,nullable} declarations');
    }
    const columns = rawColumns as ResultColumn[] | undefined;
    const result: PreparedQuery = { sql: lowered[0].sql, bindings: lowered[0].bindings, limit_slot: limitSlot,
      ...(columns ? { columns: columns.map(({name, type, nullable}) => ({name, type, nullable})) } : {}) };
    checks.set(key, { result });
    return result;
  };
  const checkAsset = async (asset: DraftAsset, signal?: AbortSignal) => {
    const key = digest({ language: asset.language, source: asset.source, checker: 1 });
    let checked = checks.get(key);
    if (!checked) {
      if (asset.language === 'jq') {
        try {
          await jq.check(asset.source, { timeoutMs: 5000, signal, programFile: '<draft-asset>' });
          checked = {};
        } catch (error) {
          if (!(error instanceof JaqCompileError)) throw error;
          checked = { error: error.message };
        }
      } else {
        const result = checkAuthorXhtml(asset.source);
        checked = { result, ...(result.errors.length ? { error: result.errors.map(error => `${error.line}:${error.column} ${error.message}`).join('\n') } : {}) };
      }
      checks.set(key, checked);
    }
    if (checked.error) fail(`${asset.name}: ${checked.error.replaceAll('<draft-asset>', asset.name)}`, { start: asset.body, end: asset.body });
  };
  const windowCode = (raw: unknown) => {
    if (!isRecord(raw) || Object.keys(raw).some(key => !['unit', 'count', 'mode'].includes(key))) throw new Error('time_windows options are {unit,count,mode}');
    return timeWindowCode('builtin://time/windows.jq', { ...raw, input: 'ctx' });
  };
  const validateFigure = (raw: unknown) => {
    if (!isRecord(raw)) throw new Error('render_figure spec must be an object');
    if (raw.kind === 'table') return parseTableSpec(raw);
    const parsed = parseChartSpec(raw);
    if ('error' in parsed) throw new Error(parsed.error);
    return parsed;
  };
  const preflight = async (document: DraftDocument, signal?: AbortSignal) => {
    const referenced = new Set(document.nodes.flatMap(node => node.assets.map(asset => asset.name)));
    for (const name of referenced) await checkAsset(document.assets.get(name)!, signal);
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
          if (['jq', 'render_figure', 'render_html'].includes(expr.operator) && second !== UNKNOWN && !isRecord(second)) throw new Error(`${expr.operator} inputs must be a named object`);
          if (expr.operator === 'render_figure' && second !== UNKNOWN && isRecord(second) && (!Object.hasOwn(second, 'data') || Object.keys(second).some(key => key !== 'data' && key !== 'nodes'))) throw new Error('render_figure inputs must be {data,nodes?}');
          if (expr.operator === 'time_windows' && second !== UNKNOWN) windowCode(second);
          if (expr.operator === 'query' && first !== UNKNOWN) await lower(first, signal);
          if (expr.operator === 'render_figure' && first !== UNKNOWN) validateFigure(first);
          if (expr.operator === 'data' && expr.args[1]) {
            const nature = constant(expr.args[1], constants);
            if (nature !== UNKNOWN) dataNature(nature);
          }
          if (expr.operator === 'render_html' && (expr.args[1].kind === 'object' || (second !== UNKNOWN && isRecord(second)))) {
            const asset = document.assets.get(first as string)!;
            const refs = new Set(checkAuthorXhtml(asset.source).refs);
            const keys = expr.args[1].kind === 'object' ? expr.args[1].entries.map(entry => entry.key) : Object.keys(second as Record<string, unknown>);
            const missing = [...refs].filter(ref => !keys.includes(ref));
            const unused = keys.filter(key => !refs.has(key));
            if (missing.length || unused.length) throw new Error(`Template bindings mismatch: missing [${missing}], unused [${unused}]`);
          }
        } catch (error) {
          if (signal?.aborted) throw error;
          fail(error instanceof Error ? error.message : String(error), expr.span);
        }
      }
    };
    for (const { statement } of document.nodes) {
      await visit(statement.value);
      if (statement.kind === 'binding') {
        const value = constant(statement.value, constants);
        if (value !== UNKNOWN) constants.set(statement.name, value);
      }
    }
  };
  const execute = async (ctx: CallContext): Promise<Computed> => {
    if (ctx.operator === 'data') {
      dataNature(ctx.args[1]?.data);
      return { data: ctx.args[0].data };
    }
    if (ctx.operator === 'context') {
      const { zone } = resolveZone(undefined, options.contextZone());
      const encoded = encode(Date.now(), zone);
      return { data: {
        utc: { epochMillis: encoded.epochMillis, epochSeconds: Math.floor(encoded.epochMillis / 1000), rfc3339: new Date(encoded.epochMillis).toISOString() },
        tz: { client: { id: encoded.zone, offset: encoded.offset, offsetMinutes: encoded.offsetMinutes } },
      }, evidence: { acquiredAt: new Date(encoded.epochMillis).toISOString() } };
    }
    if (ctx.operator === 'query') {
      const intent = ctx.args[0].data;
      const lowered = await lower(intent, ctx.signal);
      const dataFile = entry.settings.dataFile;
      let observed: Record<string, unknown> = { dataFile };
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
      const data = { rows: described.rows, columns: lowered.columns ?? described.columns, truncated };
      return { data, evidence: { ...observed, acquiredAt, model: entry.modelHash, domain: entry.settings.domain, batch: ctx.batch, manifest } };
    }
    if (ctx.operator === 'time_windows') {
      const code = windowCode(ctx.args[1].data);
      const result = await jq.run(code.text, {input:{ctx:ctx.args[0].data},timeoutMs:5000,maxBytes:1024*1024,signal:ctx.signal,programFile:code.file});
      if (!result.ok) throw new Error('Time windows exceeded the storage budget');
      return {data:result.data};
    }
    if (ctx.operator === 'jq') {
      const input = ctx.args[1]?.data ?? {};
      if (!isRecord(input)) throw new Error('jq inputs must be a named object');
      const result = await jq.run(ctx.asset!.source, { input, timeoutMs: 5000, maxBytes: 8 * 1024 * 1024, signal: ctx.signal, programFile: ctx.asset!.name });
      if (!result.ok) throw new Error(`jq output exceeded the storage budget: ${JSON.stringify(result.shape)}`);
      return { data: result.data };
    }
    if (ctx.operator === 'render_figure') {
      const raw = ctx.args[0].data;
      validateFigure(raw);
      const spec = raw as Record<string, unknown>;
      const input = ctx.args[1].data;
      if (!isRecord(input) || !Object.hasOwn(input, 'data') || Object.keys(input).some(key => key !== 'data' && key !== 'nodes')) throw new Error('render_figure inputs must be {data, nodes?}');
      const rows = rowsOf(input.data, 'render_figure.data');
      if (spec.kind === 'table') {
        const parsed = parseTableSpec(spec);
        const table = tableMarkdown(rows, { ...(parsed.columns ? { columns: parsed.columns } : {}), ...(parsed.title ? { title: parsed.title } : {}) });
        if ('error' in table) throw new Error(table.error);
        return { data: { rows, spec }, evidence: { display: { kind: 'table', content: table.embedded } } };
      }
      const parsed = parseChartSpec(spec);
      if ('error' in parsed) throw new Error(parsed.error);
      const columns = [...new Set(rows.flatMap(row => Object.keys(row)))];
      const missing = missingColumns(parsed.spec, columns, rows.length);
      if (missing.length) throw new Error(`Missing figure columns: ${missing.join(', ')}`);
      applyInferredXType(parsed.spec, rows);
      const issue = shapeProblem(rows, parsed.spec);
      if (issue) throw new Error(issue);
      const nodeRows = parsed.spec.kind === 'graph' ? rowsOf(input.nodes, 'render_figure.nodes') : undefined;
      const { option, height } = buildOption(rows, parsed.spec, nodeRows);
      const svg = renderEchartsSvg(option, CHART_WIDTH, height);
      return { data: { rows, spec: parsed.spec, ...(nodeRows ? { nodeRows } : {}) }, evidence: { title: chartTitle(parsed.spec), display: { kind: 'chart', content: svg } } };
    }
    if (ctx.operator === 'render_html') {
      if (!isRecord(ctx.args[1].data)) throw new Error('render_html inputs must be a named object');
      return { data: { items: ctx.args[1].data } };
    }
    throw new Error(`Unsupported operator ${ctx.operator}`);
  };
  const assemble = (ctx: CallContext, computed: Computed): DraftValue => {
    const named = ctx.operator === 'time_windows' ? bindingsOf({data:{ctx:ctx.args[0].data},sources:ctx.args[0].sources.map(source=>({...source,at:['ctx',...source.at]}))}) : ctx.operator === 'jq' || ctx.operator === 'render_figure' ? bindingsOf(ctx.args[1] ?? { data: {}, sources: [] }) : undefined;
    const parents = named ? Object.values(named).map(binding => binding.origin) : ctx.args.map(draftValueOrigin);
    const inputs = named ? Object.fromEntries(Object.entries(named).map(([key, binding]) => [key, binding.origin.root])) : Object.fromEntries(parents.map((parent, index) => [String(index), parent.root]));
    const node: OriginNode = {
      kind: ctx.operator === 'query' ? 'query' : ctx.operator === 'data' ? 'input' : ctx.operator === 'context' ? 'context' : ctx.operator === 'render_figure' ? 'display' : 'transform',
      motivation: ctx.statement.motivation,
      inputs,
      ...(named ? { inputPaths: Object.fromEntries(Object.keys(named).map(key => [key, '.data'])) } : {}),
      draft: { file, hash: ctx.sourceHash, line: ctx.span.start.line, column: ctx.span.start.column, ...(ctx.asset ? { asset: ctx.asset.name } : {}) },
      ...(ctx.operator === 'query' ? { intent: ctx.args[0].data, source: computed.evidence } : {}),
      ...(ctx.operator === 'data' || ctx.operator === 'context' ? { data: computed.data } : {}),
      ...(ctx.operator === 'data' ? { nature: dataNature(ctx.args[1]?.data) } : {}),
      ...(ctx.operator === 'jq' ? { method: 'jq', snip: ctx.asset!.source, snipFile: `${file}#${ctx.asset!.name}`, inputShape: 'named', outputs: 1 } : {}),
      ...(ctx.operator === 'time_windows' ? {method:'jq',snip:windowCode(ctx.args[1].data).text,snipFile:'builtin://time/windows.jq',inputShape:'named',outputs:1} : {}),
      ...(ctx.operator === 'render_figure' ? { spec: ctx.args[0].data } : {}),
    };
    let origin = appendNode(parents, node, computed.data);
    if (ctx.operator === 'render_html') {
      const bindings = bindingsOf(ctx.args[1]);
      const title = ctx.title ?? ctx.asset!.name.replace(/\.xhtml$/, '');
      const report = assembleReport({ name: 'answer', title, subtitle: null, category: '即时分析', at: resultStamp(), draft: node.draft, motivation: node.motivation, xhtml: ctx.asset!.source, bindings,
        valueOf: (ref, pick) => pickScalar(bindings[ref]?.value, pick),
      });
      if ('error' in report) throw new Error(report.error);
      origin = restoreAssets(report.origin, report.assets);
      return { data: { assets: report.assets, items: report.items }, sources: [{ origin, at: [], path: [], delivery: { html: report.page, title } }] };
    }
    const evidence = computed.evidence as { display?: { kind: 'chart' | 'table'; content: string } } | undefined;
    return { data: computed.data, sources: [{ origin, at: [], path: [], ...(evidence?.display ? { display: evidence.display } : {}) }] };
  };
  return { preflight, environment, execute, assemble };
}
