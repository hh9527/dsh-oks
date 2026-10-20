import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createProjector } from '../project.ts';
import type { JsonValue, ProjectRule } from '../project.ts';
import type { ToolDefinition, ToolExec } from '../host.ts';
import { isRecord } from '../host.ts';
import type { Knowledge, WorkspaceEntry } from '../knowledge.ts';
import type { TimeContext } from '../time-context.ts';
import type { ContextTimeZone } from '../time.ts';
import { builtinCode, toolResource } from '../knowledge-programs.ts';
import { embedChartInput, isResultColumn, readCodeFile, readWorkText } from '../results.ts';
import type { SaveArtifactOptions } from '../results.ts';
import { createDraftBackend } from './backend.ts';
import { chartTitle, type ChartSpec } from '../chart/spec.ts';
import { DraftRuntime } from './runtime.ts';
import type { DraftBackend, DraftRun, DraftValue } from './runtime.ts';
import { renderDraftReply } from './reply.ts';
import { canonicalJson } from '../key.ts';

const shape = createProjector('Shape');
const shapeOf = (value: unknown) => shape(value as JsonValue);
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const jsonBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const RETENTION_MS = 30 * 60 * 1000;
const MAX_DRAFTS = 8;
const OBJECT = { type: 'object', additionalProperties: true };
const output = { schema: OBJECT, render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value) }] };
const assertKeys = (args: unknown, keys: string[]) => {
  if (!isRecord(args) || Object.keys(args).some(key => !keys.includes(key))) throw new Error(`Expected only ${keys.join(', ')}`);
};

type RecordState = { runtime: DraftRuntime; zone: ContextTimeZone; touched: number; active: boolean };

/** Pure range reading of an already existing JSON value; no jq/project evaluation or materialization. */
export function readRange(data: unknown, args: { pointer?: unknown; offset?: unknown; limit?: unknown }) {
  if (args.pointer !== undefined) {
    if (typeof args.pointer !== 'string' || (args.pointer !== '' && !args.pointer.startsWith('/'))) throw new Error('pointer must be a JSON Pointer');
    for (const raw of args.pointer === '' ? [] : args.pointer.slice(1).split('/')) {
      if (/~(?![01])/.test(raw)) throw new Error('Invalid JSON Pointer escape');
      const key = raw.replaceAll('~1', '/').replaceAll('~0', '~');
      if (data === null || typeof data !== 'object' || !Object.hasOwn(data, key) ||
          (Array.isArray(data) && !/^(0|[1-9][0-9]*)$/.test(key))) throw new Error(`Missing JSON Pointer member ${key}`);
      data = (data as Record<string, unknown>)[key];
    }
  }
  if (args.offset === undefined && args.limit === undefined) return { data };
  const offset = args.offset ?? 0;
  const limit = args.limit ?? 20;
  if (!Number.isSafeInteger(offset) || (offset as number) < 0 || !Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > 100) throw new Error('Range requires offset >= 0 and limit 1..100');
  if (data === null || typeof data !== 'object') throw new Error('Ranges require an array or object');
  const keys = Object.keys(data);
  const start = offset as number;
  const end = start + (limit as number);
  const value = Array.isArray(data) ? data.slice(start, end) : Object.fromEntries(keys.slice(start, end).map(key => [key, (data as Record<string, unknown>)[key]]));
  return { data: value, range: { offset, limit, total: keys.length, next: end < keys.length ? end : null } };
}

export function createDraftTools(options: {
  knowledge: Knowledge;
  timeContext: TimeContext;
  save: (entry: WorkspaceEntry, value: Omit<SaveArtifactOptions, 'root'>) => { asset: string; at: string };
  readResource: (root: string, input: string) => { value: unknown };
  backend?: (entry: WorkspaceEntry, file: string, zone: () => ContextTimeZone) => DraftBackend;
}) {
  const records = new Map<string, RecordState>();
  const anonymousSessions = new WeakMap<object, string>();
  const delivered = new Map<string, { asset: string; at: string }>();
  const shutdown = new AbortController();
  let closed = false;
  const keyFor = (entry: WorkspaceEntry, exec: ToolExec, file: string) => {
    const session = exec?.agent?.session;
    if (!session) throw new Error('Draft tools require a caller session');
    let id = session.id ?? anonymousSessions.get(session);
    if (!id) { id = randomUUID(); anonymousSessions.set(session, id); }
    return canonicalJson([entry.root, id, file]);
  };
  const collect = () => {
    if (closed) throw new Error('Draft tools have been disposed');
    const cutoff = Date.now() - RETENTION_MS;
    for (const [key, record] of records) if (!record.active && record.touched < cutoff) { record.runtime.dispose(); records.delete(key); }
  };
  const recordFor = (entry: WorkspaceEntry, exec: ToolExec, file: string, create: boolean) => {
    collect();
    const key = keyFor(entry, exec, file);
    let record = records.get(key);
    if (!record && create) {
      if (records.size >= MAX_DRAFTS) {
        const candidate = [...records].filter(([, record]) => !record.active).sort((a, b) => a[1].touched - b[1].touched)[0];
        if (!candidate) throw new Error('All retained draft slots are active; wait for a running draft');
        candidate[1].runtime.dispose(); records.delete(candidate[0]);
      }
      const state = { zone: { kind: 'missing' } as ContextTimeZone, touched: Date.now(), active: false };
      const backend = options.backend?.(entry, file, () => state.zone) ?? createDraftBackend({ knowledge: options.knowledge, entry, file, contextZone: () => state.zone });
      record = Object.assign(state, { runtime: new DraftRuntime(backend,{file}) });
      records.set(key, record);
    }
    if (!record) throw new Error('No retained run for this session and source; execute the draft first');
    return record;
  };
  const saveOnce = (entry: WorkspaceEntry, value: Omit<SaveArtifactOptions, 'root'>) => {
    const key = sha(canonicalJson([entry.root, value.content]));
    const existing = delivered.get(key);
    if (existing && existsSync(join(entry.root, existing.asset))) return existing;
    const saved = options.save(entry, value);
    if (delivered.size >= 128) delivered.delete(delivered.keys().next().value!);
    delivered.set(key, saved);
    return saved;
  };
  const receipt = (run: DraftRun, file: string) => {
    const counts = { executed: 0, cached: 0, failed: 0, blocked: 0 };
    const failures: Record<string, unknown>[] = [];
    let failureCount = 0;
    for (const status of ['failed', 'blocked']) for (const [name,state] of run.outputs) {
      if (state.status !== status) continue;
      failureCount++;
      const item = {name:state.display?.label??name,...(state.display?{...state.display}:{}),status,at:{line:state.span.start.line,column:state.span.start.column},
        ...(state.context?{...state.context,bindings:state.context.bindings.slice(0,8)}:{}),error:(state.error??status).slice(0,600),messageTruncated:(state.error??status).length>600};
      failures.push(item);
    }
    const outputs: Record<string, unknown>[] = [];
    let debugBytes = 0;
    let hiddenOutputs=0;
    const acquisitions: DraftRun['acquisitions'] = [];
    for (const acquisition of run.acquisitions) {
      if (jsonBytes(acquisitions) + jsonBytes(acquisition) < 1500) acquisitions.push(acquisition);
    }
    const acquisitionBytes = jsonBytes(acquisitions);
    for (const [name, state] of run.outputs) {
      counts[state.status]++;
      if(state.internal&&state.value){hiddenOutputs++;continue;}
      const item: Record<string, unknown> = { name:state.display?.label??name,...(state.display?{...state.display}:{}), status: state.status, at: { line: state.span.start.line, column: state.span.start.column }, ...(state.internal?{}:{input: `${file}#${name}`}) };
      if (state.value) {
        item.shape = shapeOf(state.value.data);
        if (isRecord(state.value.data) && Array.isArray(state.value.data.rows)) {
          item.rowCount = state.value.data.rows.length;
          if (typeof state.value.data.truncated === 'boolean') item.truncated = state.value.data.truncated;
        }
        if (isRecord(state.value.data) && Array.isArray(state.value.data.columns) && state.value.data.columns.every(isResultColumn)) {
          const columns: unknown[] = [];
          for (const column of state.value.data.columns.slice(0, 12)) {
            if (jsonBytes([...columns, column]) > 1200) break;
            columns.push(column);
          }
          item.columns = columns;
          if (columns.length < state.value.data.columns.length) item.omittedColumns = state.value.data.columns.length - columns.length;
        }
        if (name.startsWith('debug/') && jsonBytes(state.value.data) <= 512 && debugBytes < 1536) {
          item.data = state.value.data; debugBytes += jsonBytes(state.value.data);
        }
      }
      if (state.error) item.error = state.error.slice(0, 800);
      if (acquisitionBytes + jsonBytes(outputs) + jsonBytes(item) < 5500) outputs.push(item);
    }
    const diagnostics=run.diagnostics?.slice(0,8).map(({related,...diagnostic})=>({
      ...diagnostic,message:diagnostic.message.slice(0,600),
      ...(related?{related:related.slice(0,2).map(r=>({...r,message:r.message.slice(0,120)}))}:{}),
    }));
    const result = { ok: run.status === 'complete' && counts.failed === 0 && counts.blocked === 0, computation: counts.failed || counts.blocked ? 'partial' : run.status === 'complete' ? 'succeeded' : 'unavailable', run: run.id, sourceHash: run.sourceHash, batch: run.batch, status: run.status,
      ...(diagnostics?{diagnostics}:{}),counts, failures, omittedFailures:failureCount-failures.length, failuresInput:`${file}#failures`, acquisitions, omittedAcquisitions: run.acquisitions.length - acquisitions.length, outputs, omittedOutputs: run.outputs.size - hiddenOutputs - outputs.length,
      ...(run.error ? { error: run.error.slice(0, 2500), ...(run.errorSpan?{at:run.errorSpan.start}:{}) } : {}) };
    while(jsonBytes(result)>6500 && outputs.length){outputs.pop();result.omittedOutputs++;}
    while(jsonBytes(result)>6500 && diagnostics?.length) diagnostics.pop();
    // Preserve failure identities; shorten messages instead of omitting failed nodes.
    for (const limit of [300,150,80]) {
      if(jsonBytes(result)<=6500) break;
      for(const failure of failures) {
        const message=String(failure.error);
        if(message.length>limit){failure.error=message.slice(0,limit);failure.messageTruncated=true;}
      }
    }
    return result;
  };
  const tools: ToolDefinition[] = [
    {
      name: 'oks_run_answer',
      description: 'Evaluate the complete pipeline and named assets and templates in a .work .dari report. Reuses this session/source acquisition batch and deterministic computations; refresh starts a new acquisition batch for exec_query/context, while query(intent) only compiles a reusable plan with columns. Returns root failures first with component/asset, bindings, source location and reason; #failures reads the full list with pagination. Returns bounded statuses/debug and readonly references. With one answer it delivers reply Markdown or a self-contained report; with multiple answers select a binding explicitly. Computation, query and rendering are defined in the draft.',
      parameters: { type: 'object', properties: { src: { type: 'string' }, answer: { type: 'string' }, delivery: { type: 'string', enum: ['reply', 'artifact'] }, refresh: { type: 'boolean' } }, required: ['src'], additionalProperties: false },
      output: { schema: OBJECT, render: (_args: unknown, value: { reply?: string }) => [{ type: 'text', text: JSON.stringify({ ...value, reply: undefined }) + (value.reply ? '\n\n' + value.reply : '') }] },
      async execute(args: { src?: unknown; answer?: unknown; delivery?: unknown; refresh?: unknown }, exec: ToolExec) {
        assertKeys(args, ['src', 'answer', 'delivery', 'refresh']);
        if (typeof args.src !== 'string' || !args.src.endsWith('.dari')) throw new Error('src must be a .work/*.dari report path; migrate Markdown explicitly');
        if (args.answer !== undefined && typeof args.answer !== 'string') throw new Error('answer must be a binding name');
        if (args.delivery !== undefined && !['reply', 'artifact'].includes(String(args.delivery))) throw new Error('delivery must be reply or artifact');
        if (args.refresh !== undefined && typeof args.refresh !== 'boolean') throw new Error('refresh must be boolean');
        const entry = options.knowledge.ensureWorkspace(exec);
        const read = readWorkText(entry.root, args.src, 'oks_run_answer');
        const record = recordFor(entry, exec, read.file, true);
        if (record.active) throw new Error('This draft is already running; wait for it to finish');
        record.active = true;
        record.touched = Date.now();
        record.zone = structuredClone(options.timeContext.zones.get(exec.agent!.session!) ?? { kind: 'missing' });
        try {
          const signal = AbortSignal.any([shutdown.signal, AbortSignal.timeout(120000), ...(exec.signal ? [exec.signal] : [])]);
          const run = await record.runtime.run(read.text, { refresh: args.refresh === true, signal });
          const base = receipt(run, read.file);
          if (run.status !== 'complete') return { ...base, delivery: { status: 'unavailable' } };
          const candidates = run.answers ?? [];
          let selected: [string, DraftValue] | undefined;
          if (typeof args.answer === 'string') {
            const state = run.outputs.get(args.answer);
            if (!state?.value || state.internal) return { ...base, delivery: { status: 'unavailable', answer: args.answer, error: state?.error ?? 'Answer binding is undefined or unsuccessful' } };
            selected = [args.answer, state.value];
          } else if (candidates.length === 1) {
            const state = run.outputs.get(candidates[0]);
            if (!state?.value || state.internal) return { ...base, delivery: { status: 'unavailable', answer: candidates[0], error: state?.error ?? 'Answer is unsuccessful' } };
            selected = [candidates[0], state.value];
          }
          else if (candidates.length > 1) return { ...base, delivery: { status: 'selection_required', candidates: candidates.slice(0, 20) } };
          if (!selected) return { ...base, delivery: { status: 'exploring' } };
          const [name, value] = selected;
          const source = value.sources.length === 1 ? value.sources[0] : undefined;
          if (!source?.delivery || source.at.length || source.path.length) return { ...base, delivery: { status: 'unavailable', error: 'Selected output is not a complete render_html answer' } };
          if (args.delivery === 'artifact') {
            // Stable evidence identity avoids rewriting the same report on an unchanged acquisition/source.
            const key = sha(canonicalJson([entry.root, source.origin.root, 'report']));
            let saved = delivered.get(key);
            if (!saved || !existsSync(join(entry.root, saved.asset))) {
              saved = saveOnce(entry, { name: 'answer', title: source.delivery.title, category: '即时分析', kind: 'report', content: source.delivery.html, extension: '.html', contentHasMeta: true });
              if (delivered.size >= 128) delivered.delete(delivered.keys().next().value!);
              delivered.set(key, saved);
            }
            return { ...base, delivery: { status: 'ready', mode: 'artifact', answer: name, ...saved } };
          }
          try {
            const reply = renderDraftReply(source.delivery.html, (svg, ref) => {
              const reportNode = source.origin.nodes[source.origin.root];
              const inputRoot = reportNode.inputs?.[ref];
              const item = (value.data as { items: Record<string, unknown> }).items[ref];
              if (!inputRoot || item === undefined) throw new Error(`Missing figure evidence ${ref}`);
              const content = embedChartInput(svg, { origin: { root: inputRoot, nodes: source.origin.nodes }, data: item as never });
              const title = isRecord(item) && isRecord(item.spec) ? chartTitle(item.spec as unknown as ChartSpec) : ref;
              return saveOnce(entry, { name: 'answer_chart', title, kind: 'chart', content, extension: '.svg' }).asset;
            });
            if (Buffer.byteLength(reply) > 8192) return { ...base, delivery: { status: 'too_large', error: 'Reply exceeds 8 KiB; shorten the draft answer or use delivery:"artifact"' } };
            return { ...base, delivery: { status: 'ready', mode: 'reply', answer: name }, reply };
          } catch (error) {
            return { ...base, delivery: { status: 'unsupported', error: error instanceof Error ? error.message.slice(0, 1000) : String(error).slice(0, 1000) } };
          }
        } finally {
          record.active = false;
          record.touched = Date.now();
          if (closed) record.runtime.dispose();
        }
      },
    },
    {
      name:'renew_context',
      description:'Reset the acquisition batch of one .work/*.dari source in the current session. Does not execute the draft or query the database. The next run captures a new context and query results; deterministic query plans remain reusable. Existing outputs become unavailable until the next run.',
      parameters:{type:'object',properties:{src:{type:'string'}},required:['src'],additionalProperties:false},
      output,
      async execute(args:{src?:unknown},exec:ToolExec){
        assertKeys(args,['src']);
        if(typeof args.src!=='string'||!args.src.endsWith('.dari'))throw new Error('src must be a .work/*.dari report path');
        const entry=options.knowledge.ensureWorkspace(exec);
        const read=readWorkText(entry.root,args.src,'renew_context');
        const record=recordFor(entry,exec,read.file,true);
        if(record.active)throw new Error('This draft is already running; wait for it to finish');
        const batch=record.runtime.renew();record.touched=Date.now();
        return {ok:true,src:read.file,batch,status:'renewed'};
      },
    },
    {
      name: 'oks_data',
      description: 'Read existing output only: input=".work/draft.dari#binding", #debug for the debug index, or #debug/1 for one output. Also reads existing artifact data. Does not execute, refresh, transform or save. query plans contain {columns}; exec_query outputs contain {rows,columns,truncated}; pointer="/columns" reads model-declared {name,type,nullable}. Optional JSON Pointer selects an existing subtree; offset/limit page arrays or object members. Edits mark retained output stale; failed/removed latest bindings never fall back to older success. Read oks://help/... resources with oks_knowledge.',
      parameters: { type: 'object', properties: { input: { type: 'string' }, pointer: { type: 'string' }, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 100 }, meta: { type: 'boolean' } }, required: ['input'], additionalProperties: false },
      output,
      async execute(args: { input?: unknown; pointer?: unknown; offset?: unknown; limit?: unknown; meta?: unknown }, exec: ToolExec) {
        assertKeys(args, ['input', 'pointer', 'offset', 'limit', 'meta']);
        if (typeof args.input !== 'string') throw new Error('input must be one existing output or artifact reference');
        if (args.meta !== undefined && typeof args.meta !== 'boolean') throw new Error('meta must be boolean');
        const entry = options.knowledge.ensureWorkspace(exec);
        const match = /^(\.work\/.+\.dari)#([^#]+)$/.exec(args.input);
        if (match) {
          const read = readWorkText(entry.root, match[1], 'oks_data');
          const record = recordFor(entry, exec, read.file, false);
          if (match[2] === 'debug' || match[2] === 'failures') {
            const described = record.runtime.describe(read.text);
            const data = described.outputs.filter(output => match[2]==='failures' ? output.status==='failed'||output.status==='blocked' : output.name.startsWith('debug/')).map(output => ({ ...output, ...(match[2]==='debug'?{input: `${read.file}#${output.name}`}:{}) }));
            const {outputs:_outputs,...summary}=described;
            return { ok: true, ...summary, ...readRange(data, args) };
          }
          const readValue = record.runtime.read(match[2], read.text);
          const data = args.meta ? { sources: readValue.value.sources.map(({origin, at, path}) => ({origin, at, path})), run: readValue.run, sourceHash: readValue.sourceHash } : readValue.value.data;
          return { ok: true, run: readValue.run, sourceHash: readValue.sourceHash, stale: readValue.stale, ...readRange(data, args) };
        }
        const read = options.readResource(entry.root, args.input + (args.meta && !args.input.endsWith('#meta') ? '#meta' : ''));
        return { ok: true, ...readRange(read.value, args) };
      },
    },
    {
      name: 'oks_knowledge',
      description: 'Discover the semantic knowledge graph before authoring a business draft. Root shape is datasets/types/relations/tools/items. Rendering knowledge: tools/render_figure#kinds/<kind> and #topics/<topic>; XHTML: tools/render_html#topics/references. Use project for a precise graph view, or jq with a .work .jq program or builtin://knowledge/{search,read,members,references}.jq and args. jq input is {knowledge:<graph>}. help reads oks://help/{knowledge,query,time,render} or a builtin descriptor; topic selects one exact help key. time_windows(ctx,{unit,count,mode}) in the draft computes calendar windows. Readonly; no business data, saves or draft computation.',
      parameters: { type: 'object', properties: { project: {}, jq: { type: 'object', properties: { src: { type: 'string' }, args: { type: 'object' } }, required: ['src'], additionalProperties: false }, help: { type: 'string' }, topic:{type:'string'} }, additionalProperties: false },
      output,
      async execute(args: { project?: unknown; jq?: unknown; help?: unknown; topic?: unknown }, exec: ToolExec) {
        assertKeys(args, ['project', 'jq', 'help', 'topic']);
        if (Object.keys(args).filter(key=>key!=='topic').length !== 1) throw new Error('Choose exactly one of project, jq or help');
        if (typeof args.help === 'string') {
          const resource = toolResource(args.help);
          if (args.topic !== undefined) {
            if (typeof args.topic !== 'string' || !isRecord(resource) || !Object.hasOwn(resource, args.topic)) throw new Error('Unknown help topic');
            return {ok:true,data:resource[args.topic]};
          }
          return {ok:true,data:args.help==='oks://help/query' && isRecord(resource) ? {topics:Object.keys(resource)} : resource};
        }
        if (args.topic !== undefined) throw new Error('topic requires help');
        const entry = options.knowledge.ensureWorkspace(exec);
        if (args.project !== undefined) {
          const project = createProjector(args.project as ProjectRule);
          const index = await options.knowledge.ensureIndex(entry);
          return { ok: true, model: entry.modelHash, data: project(index.knowledge as unknown as JsonValue) };
        }
        if (!isRecord(args.jq) || typeof args.jq.src !== 'string' || Object.keys(args.jq).some(key => !['src', 'args'].includes(key))) throw new Error('jq must be {src,args?}');
        const builtin = args.jq.src.startsWith('builtin://knowledge/');
        if (!builtin && args.jq.args !== undefined) throw new Error('jq.args is for builtin programs');
        const code = builtin ? builtinCode(args.jq.src, args.jq.args) : readCodeFile(entry.root, args.jq.src);
        const inputName = builtin && isRecord(args.jq.args) && typeof args.jq.args.input === 'string' ? args.jq.args.input : 'knowledge';
        const result = await options.knowledge.queryKnowledge(entry, code.text, { input: null, inputName, timeoutMs: 5000, maxBytes: 16384, signal: exec.signal, programFile: code.file });
        return result.ok ? { ok: true, model: entry.modelHash, data: result.data } : { ok: false, error: 'Knowledge output exceeds the budget; narrow the view', shape: result.shape };
      },
    },
  ];
  return {
    tools,
    dispose() {
      closed = true; shutdown.abort();
      for (const record of records.values()) if (!record.active) record.runtime.dispose();
      records.clear(); delivered.clear();
    },
  };
}
