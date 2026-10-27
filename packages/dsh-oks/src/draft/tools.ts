import { createSelector } from '../select.ts';
import {chartTitle} from '../chart/spec.ts';
import type {ChartSpec} from '../chart/spec.ts';
import { createKtools, type Ktools } from '../ktools.ts';
import { createHash, randomUUID } from 'node:crypto';
import { createProjector } from '../project.ts';
import type { JsonValue } from '../project.ts';
import type { AttachmentsService, FileAttachmentRef, ToolDefinition, ToolExec } from '../host.ts';
import { isRecord } from '../host.ts';
import type { Knowledge, WorkspaceEntry } from '../knowledge.ts';
import type { TimeContext } from '../time-context.ts';
import type { ContextTimeZone } from '../time.ts';
import { embedChartInput, isResultColumn, readWorkText } from '../results.ts';
import { createDraftBackend } from './backend.ts';
import { DraftRuntime } from './runtime.ts';
import type { DraftBackend, DraftRun, DraftValue } from './runtime.ts';
import { escapeHtml, renderMarkdown } from '../chart/markdown.ts';
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

export function createDraftTools(options: {
  knowledge: Knowledge;
  attachments?:()=>AttachmentsService|undefined;
  timeContext: TimeContext;
  ktools?: Ktools;
  backend?: (entry: WorkspaceEntry, file: string, zone: () => ContextTimeZone) => DraftBackend;
}) {
  const ktools=options.ktools??createKtools();
  const records = new Map<string, RecordState>();
  const anonymousSessions = new WeakMap<object, string>();
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
    let outputPreviewBytes = 0;
    let hiddenOutputs=0;
    const acquisitions: DraftRun['acquisitions'] = [];
    for (const acquisition of run.acquisitions) {
      if (jsonBytes(acquisitions) + jsonBytes(acquisition) < 1500) acquisitions.push(acquisition);
    }
    const acquisitionBytes = jsonBytes(acquisitions);
    for (const [name, state] of [...run.outputs].sort(([a],[b])=>Number(b==='output')-Number(a==='output'))) {
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
        if (name === 'output' && jsonBytes(state.value.data) <= 512 && outputPreviewBytes < 1536) {
          item.data = state.value.data; outputPreviewBytes += jsonBytes(state.value.data);
        }
      }
      if (state.error) item.error = state.error.slice(0, 800);
      if (acquisitionBytes + jsonBytes(outputs) + jsonBytes(item) < 5500) outputs.push(item);
    }
    const allDiagnostics=run.diagnostics??[];
    const seen=new Set<string>();
    const firstByUnit=allDiagnostics.filter(d=>{const key=d.asset??d.stage;if(seen.has(key))return false;seen.add(key);return true;});
    const diagnostics=allDiagnostics.length?[...firstByUnit,...allDiagnostics.filter(d=>!firstByUnit.includes(d))].slice(0,8).map(({related,...diagnostic})=>({
      ...diagnostic,message:diagnostic.message.slice(0,400),messageTruncated:diagnostic.message.length>400,
    })):undefined;
    const result = { ok: run.status === 'complete' && counts.failed === 0 && counts.blocked === 0, computation: counts.failed || counts.blocked ? 'partial' : run.status === 'complete' ? 'succeeded' : 'unavailable', run: run.id, sourceHash: run.sourceHash, batch: run.batch, status: run.status,
      ...(diagnostics?{diagnostics,omittedDiagnostics:allDiagnostics.length-diagnostics.length,diagnosticsInput:`${file}#diagnostics`}:{}),counts, failures, omittedFailures:failureCount-failures.length, failuresInput:`${file}#failures`, acquisitions, omittedAcquisitions: run.acquisitions.length - acquisitions.length, outputs, omittedOutputs: run.outputs.size - hiddenOutputs - outputs.length,
      ...(run.error ? { error: run.error.slice(0, 2500), ...(run.errorSpan?{at:run.errorSpan.start}:{}) } : {}) };
    while(jsonBytes(result)>6500 && outputs.length){outputs.pop();result.omittedOutputs++;}
    while(jsonBytes(result)>6500 && diagnostics?.length){diagnostics.pop();result.omittedDiagnostics=allDiagnostics.length-diagnostics.length;}
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
      description: 'Evaluate the complete pipeline and named assets, Figures and optional Reports in a .work .dari report. Pipeline uses name <- expression; bindings, with prior definitions only, no shadow, and an optional final output object. Assets compile before execution; nodes run by DAG dependencies. Names starting with _ skip cross-run calculation caching. Reuses this session/source acquisition batch and deterministic computations; refresh starts a new acquisition batch for exec_query/context, while query(intent) only compiles a reusable plan with columns. Collects independent pipeline, asset, figure and report validation errors before execution; #diagnostics pages the full list. Returns root failures first with component/asset, bindings, source location and reason; #failures reads the full list with pagination. Returns bounded statuses, the final output object and readonly references. A single Report returns its retained #reports.name address; use oks_show to publish an attachment. With multiple Reports select reports.name explicitly. Computation, query and rendering are defined in the draft.',
      parameters: { type: 'object', properties: { src: { type: 'string' }, answer: { type: 'string' }, refresh: { type: 'boolean' } }, required: ['src'], additionalProperties: false },
      output,
      async execute(args: { src?: unknown; answer?: unknown; refresh?: unknown }, exec: ToolExec) {
        assertKeys(args, ['src', 'answer', 'refresh']);
        if (typeof args.src !== 'string' || !args.src.endsWith('.dari')) throw new Error('src must be a oks://work/*.dari report path; migrate Markdown explicitly');
        if (args.answer !== undefined && typeof args.answer !== 'string') throw new Error('answer must be reports.name or a Report binding name');
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
          if (!source?.delivery || source.at.length || source.path.length) return { ...base, delivery: { status: 'unavailable', error: 'Selected output is not a complete Report' } };
          return {...base,delivery:{status:'ready',mode:'retained',answer:name,input:`${args.src}#${name}`,show:'oks_show'}};
        } finally {
          record.active = false;
          record.touched = Date.now();
          if (closed) record.runtime.dispose();
        }
      },
    },
    {
      name: 'oks_show',
      description: 'Publish an existing DARI figure or report as a durable host attachment and return its reference and presentation instructions. input is oks://work/analysis.dari#figures.name or #reports.name. Reads the latest retained output in this session; never executes SQL, runs a draft, refreshes context or saves a business report. Include the returned markdown verbatim in the answer to show SVG inline; for reports and tables call the host present tool with the returned present object to show a native file card. Report HTML includes the complete DARI source structure and retained execution context; these are available under the report output dari/context fields through oks_project. Bytes stay outside model context. Edited sources are marked stale.',
      parameters: {type:'object',properties:{input:{type:'string'}},required:['input'],additionalProperties:false},
      output: {
        schema: OBJECT,
        render: (_args:unknown,value:{attachment:FileAttachmentRef}) => [{type:'text',text:JSON.stringify(value)},{type:'file',attachment:value.attachment}],
        presentationMeta: (_args:unknown,value:{attachment:FileAttachmentRef}) => ({attachment:value.attachment}),
      },
      async execute(args:{input?:unknown},exec:ToolExec){
        assertKeys(args,['input']);
        const match=typeof args.input==='string' ? /^((?:oks:\/\/work\/|\.work\/).+\.dari)#((?:(?:figures|reports)\.)?[A-Za-z_$][A-Za-z0-9_$]*)$/.exec(args.input) : null;
        if(!match)throw new Error('input must select #figures.name or #reports.name in an oks://work/*.dari source');
        const entry=options.knowledge.ensureWorkspace(exec);
        const read=readWorkText(entry.root,match[1],'oks_show');
        const record=recordFor(entry,exec,read.file,false);
        const retained=record.runtime.read(match[2],read.text);
        const source=retained.value.sources.length===1?retained.value.sources[0]:undefined;
        if(!source||source.at.length||source.path.length)throw new Error('Selected output is not a complete presentation');
        const attachments=options.attachments?.();
        if(!attachments)throw new Error('The host attachments service is unavailable');
        let html:string,title:string,kind:string;
        if(source.delivery){html=source.delivery.html;title=source.delivery.title;kind='report';}
        else if(source.display){
          const data=retained.value.data;
          title=isRecord(data)&&isRecord(data.spec)
            ? source.display.kind==='chart'?chartTitle(data.spec as unknown as ChartSpec):typeof data.spec.title==='string'?data.spec.title:match[2].slice(match[2].indexOf('.')+1)
            :match[2].slice(match[2].indexOf('.')+1);
          kind=source.display.kind;
          const body=kind==='chart'?source.display.content:renderMarkdown(source.display.content,(_info,text)=>`<pre><code>${escapeHtml(text)}</code></pre>`);
          html=`<!doctype html><html><head><meta charset="utf-8"><style>body{margin:12px;font:14px sans-serif;color:#222}svg{max-width:100%;height:auto}table{border-collapse:collapse;width:100%}th,td{border:1px solid #ddd;padding:6px;text-align:left}h2{font-size:16px}</style></head><body><h2>${escapeHtml(title)}</h2>${body}</body></html>`;
        }else throw new Error('Selected output has no presentation');
        const content=kind==='chart'?embedChartInput(source.display!.content.replace(/<svg[^>]*>/,open=>open+`<title>${escapeHtml(title)}</title>`),{origin:source.origin,data:retained.value.data as never}):html;
        const extension=kind==='chart'?'.svg':kind==='report'?'.report.html':'.html';
        if(exec.signal?.aborted)throw new Error('aborted');
        const attachment=await attachments.saveFile({data:Buffer.from(content),name:match[2].slice(match[2].indexOf('.')+1)+extension});
        const path=attachments.fileHostPath(attachment);
        const label=title.replace(/[\r\n]/g,' ').replace(/[\\[\]]/g,'\\$&');
        const markdown=path&&kind==='chart'?`![${label}](${encodeURI(path).replaceAll('(','%28').replaceAll(')','%29').replaceAll('#','%23').replaceAll('?','%3F')})`:undefined;
        const present=path&&kind!=='chart'?{files:[{path,description:title}]}:undefined;
        return {ok:true,input:args.input,run:retained.run,sourceHash:retained.sourceHash,stale:retained.stale,kind,title,attachment,...(path?{path}:{}),...(markdown?{markdown}:{}),...(present?{present}:{})};
      },
    },
    {
      name:'renew_context',
      description:'Reset the acquisition batch of one oks://work/*.dari source in the current session. Does not execute the draft or query the database. The next run captures a new context and query results; deterministic query plans remain reusable. Existing outputs become unavailable until the next run.',
      parameters:{type:'object',properties:{src:{type:'string'}},required:['src'],additionalProperties:false},
      output,
      async execute(args:{src?:unknown},exec:ToolExec){
        assertKeys(args,['src']);
        if(typeof args.src!=='string'||!args.src.endsWith('.dari'))throw new Error('src must be a oks://work/*.dari report path');
        const entry=options.knowledge.ensureWorkspace(exec);
        const read=readWorkText(entry.root,args.src,'renew_context');
        const record=recordFor(entry,exec,read.file,true);
        if(record.active)throw new Error('This draft is already running; wait for it to finish');
        const batch=record.runtime.renew();record.touched=Date.now();
        return {ok:true,src:read.file,batch,status:'renewed'};
      },
    },
    {
      name: 'oks_project',
      description: 'Read structured input, optionally apply a jq transform {lib,name,args}, then a select rule string. The current model root directory, branch shapes and counts are provided in this session’s knowledge navigation and oks://help/knowledge.md; select=":keys" enumerates actual roots. Resources: oks://knowledge or retained oks://work/<file>.dari#<binding>, #figures.<name>, #reports.<name>, #output, #failures, #diagnostics and #meta.<binding>. select examples: ports.rows; {rows,columns}; items[0:25]:map({id,name}). :map projects array items or object values, preserving object keys; use ? to skip absent fields or preserve null while short-circuiting the rest, e.g. a?.b.{c?:len,d}. Multi-field projections require braces. :keys/:len inspect shape. Read oks://help/project.md with oks_read for syntax. Returns .data; oversized results return {error:"payload_too_large",repr,reprLength,len} with a 4096-character JSON preview. Reading never executes SQL, runs drafts, refreshes or saves.',
      parameters:{type:'object',properties:{input:{type:'string'},select:{type:'string'},transform:{type:'object',properties:{lib:{type:'string'},name:{type:'string'},args:{type:'object'}},required:['lib','name'],additionalProperties:false}},required:['input'],additionalProperties:false},
      output,
      async execute(args:{input?:unknown;select?:unknown;transform?:unknown},exec:ToolExec) {
        assertKeys(args,['input','select','transform']);
        if(typeof args.input!=='string')throw new Error('input must identify one structured resource');
        const select=args.select===undefined?undefined:createSelector(args.select);
        let transform:{lib:string;name:string;args:Record<string,unknown>}|undefined;
        if(args.transform!==undefined){
          assertKeys(args.transform,['lib','name','args']);
          const t=args.transform as Record<string,unknown>;
          if(typeof t.lib!=='string'||t.lib.includes('#'))throw new Error('transform.lib must identify a library without #name');
          if(typeof t.name!=='string'||!/^[A-Za-z_][A-Za-z0-9_]*$/.test(t.name))throw new Error('transform.name must be a method name');
          if(t.args!==undefined&&!isRecord(t.args))throw new Error('transform.args must be an object');
          transform={lib:t.lib,name:t.name,args:(t.args??{}) as Record<string,unknown>};
        }
        const resource=args.input;
        const isKnowledge=resource==='oks://knowledge';
        // Open the workspace only when resolving a supported structured resource.
        let entry:WorkspaceEntry|undefined;
        const workspace=()=>entry??=options.knowledge.ensureWorkspace(exec);
        const view=async(data:unknown)=>{
          if(transform){
            const root=transform.lib==='oks://builtin/tools/ktools.lib.jq'?'':workspace().settings.workspaceRoot;
            const code=await ktools.program(root,transform.lib+'#'+transform.name,transform.args,exec.signal);
            // Transform output has a separate internal budget; select runs before the public payload budget.
            const result=isKnowledge
              ?await options.knowledge.queryKnowledge(workspace(),code.text,{input:null,timeoutMs:5000,maxBytes:8*1024*1024,signal:exec.signal,programFile:code.file})
              :await ktools.run(code.text,{input:data,timeoutMs:5000,maxBytes:8*1024*1024,signal:exec.signal,programFile:code.file});
            if(!result.ok)return {ok:false,error:'Transform output exceeds its internal 8 MiB budget; narrow the transform',shape:result.shape};
            data=result.data;
          }
          return {data:select?select(data as JsonValue):data};
        };
        if(isKnowledge){
          if(transform)return {ok:true,model:workspace().modelHash,...await view(null)};
          const index=await options.knowledge.ensureIndex(workspace());
          return {ok:true,model:workspace().modelHash,...await view(index.knowledge)};
        }
        const match=/^((?:oks:\/\/work\/|\.work\/).+\.dari)#([^#]+)$/.exec(resource);
        if(match){
          const read=readWorkText(workspace().root,match[1],'oks_project');
          const record=recordFor(workspace(),exec,read.file,false);
          if(match[2]==='failures'||match[2]==='diagnostics'){
            const described=record.runtime.describe(read.text);
            const data=match[2]==='diagnostics'?described.diagnostics:described.outputs.filter(output=>output.status==='failed'||output.status==='blocked').map(output=>({...output,input:`${read.file}#${output.name}`}));
            const {outputs:_outputs,diagnostics:_diagnostics,...summary}=described;
            return {ok:true,...summary,...await view(data)};
          }
          const meta=match[2].startsWith('meta.');
          const readValue=record.runtime.read(meta?match[2].slice(5):match[2],read.text);
          const data=meta?{sources:readValue.value.sources.map(({origin,at,path})=>({origin,at,path})),run:readValue.run,sourceHash:readValue.sourceHash}:readValue.value.data;
          return {ok:true,run:readValue.run,sourceHash:readValue.sourceHash,stale:readValue.stale,...await view(data)};
        }
        throw new Error('Unknown structured resource; use oks://knowledge or oks://work/<file>.dari#<binding>');
      },
    },
  ];
  return {
    tools,
    dispose() {
      closed = true; shutdown.abort();
      for (const record of records.values()) if (!record.active) record.runtime.dispose();
      records.clear();
    },
  };
}
