import {renderResolveReceipt} from './resolve-receipt.ts';
import {checkReceipt,parseInspect} from './check-receipt.ts';
import {renderMarkdownAnswer} from '../report/markdown-answer.ts';
import {chartTitle} from '../chart/spec.ts';
import type {ChartSpec} from '../chart/spec.ts';
import { createHash, randomUUID } from 'node:crypto';
import { createProjector } from '../project.ts';
import type { JsonValue } from '../project.ts';
import type { ApprovalService, AttachmentsService, ToolDefinition, ToolExec } from '../host.ts';
import { isRecord } from '../host.ts';
import type { Knowledge, WorkspaceEntry } from '../knowledge.ts';
import type { TimeContext } from '../time-context.ts';
import type { ContextTimeZone } from '../time.ts';
import { isTableColumn, readDariSource } from '../results.ts';
import { createDraftBackend } from './backend.ts';
import { DraftRuntime } from './runtime.ts';
import { checkDesign, parseDesign, parseExecutableDesign } from './design.ts';
import type { DraftBackend, DraftRun } from './runtime.ts';
import { escapeHtml } from '../chart/markdown.ts';
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

type RecordState = { contextTime:number; runtime: DraftRuntime; zone: ContextTimeZone; touched: number; active: boolean };

export function createDraftTools(options: {
  knowledge: Knowledge;
  attachments?:()=>AttachmentsService|undefined;
  approval?:()=>ApprovalService|undefined;
  timeContext: TimeContext;
  backend?: (entry: WorkspaceEntry, file: string, zone: () => ContextTimeZone) => DraftBackend;
}) {
  const records = new Map<string, RecordState>();
  const anonymousSessions = new WeakMap<object, string>();
  const shutdown = new AbortController();
  let closed = false;
  const pending = new Set<string>();
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
      const state = { contextTime:Date.now(), zone: { kind: 'missing' } as ContextTimeZone, touched: Date.now(), active: false };
      const backend = options.backend?.(entry, file, () => state.zone) ?? createDraftBackend({ knowledge: options.knowledge, entry, file, contextZone: () => state.zone,contextNow:()=>state.contextTime });
      record = Object.assign(state, { runtime: new DraftRuntime(backend,{file,parse:parseExecutableDesign}) });
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
        if (isRecord(state.value.data) && Array.isArray(state.value.data.columns) && state.value.data.columns.every(isTableColumn)) {
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
  const checkSource = async (entry:WorkspaceEntry, file:string, text:string, exec:ToolExec, signal:AbortSignal) => {
    const zone:ContextTimeZone=structuredClone(options.timeContext.zones.get(exec.agent!.session!)??{kind:'missing'});
    const knowledge={executorFor:()=>{throw new Error('Business query execution is forbidden during checking');}};
    const record=recordFor(entry,exec,file,true);record.zone=zone;
    const backend=createDraftBackend({knowledge,entry,file,contextZone:()=>zone,contextNow:()=>record.contextTime});
    return checkDesign(text,file,backend,signal);
  };
  const publish = async (record:RecordState,sourceText:string,name:string,exec:ToolExec) => {
    const retained=record.runtime.read(name,sourceText);
    const source=retained.value.sources.length===1?retained.value.sources[0]:undefined;
    if(!source||source.at.length||source.path.length)throw new Error('Selected output is not a complete presentation');
    if(source.display?.kind==='table'&&!source.delivery)return {embedded:source.display.content};
    const attachments=options.attachments?.();
    if(!attachments)throw new Error('The host attachments service is unavailable');
    let content:string,title:string,kind:'chart'|'report';
    if(source.delivery){content=source.delivery.html;title=source.delivery.title;kind='report';}
    else if(source.display?.kind==='chart'){
      const data=retained.value.data;
      title=isRecord(data)&&isRecord(data.spec)?chartTitle(data.spec as unknown as ChartSpec):name.slice(name.indexOf('.')+1);
      kind='chart';
      content=source.display.content.replace(/<svg[^>]*>/,open=>open+`<title>${escapeHtml(title)}</title>`);
    }else throw new Error('Selected output has no presentation');
    const extension=kind==='chart'?'.svg':'.report.html';
    if(exec.signal?.aborted)throw new Error('aborted');
    const attachment=await attachments.saveFile({data:Buffer.from(content),name:name.slice(name.indexOf('.')+1)+extension});
    const path=attachments.fileHostPath(attachment);
    const label=title.replace(/[\r\n]/g,' ').replace(/[\\[\]]/g,'\\$&');
    if(!path)throw new Error('The host attachment has no displayable path');
    const target=encodeURI(path).replaceAll('(','%28').replaceAll(')','%29').replaceAll('#','%23').replaceAll('?','%3F');
    return {embedded:kind==='chart'?`![${label}](${target})`:`[${label}](${target})`};
  };
  const tools: ToolDefinition[] = [
    {
      name:'dari_check',
      description:'Check the entire DARI source without acquiring business rows. Returns compact text headed Succeed or CheckFailed: ready-status lists every declared binding; t1- fingerprints identify successfully checked type shapes, ? means not successfully checked, and reports/answer use checked. An unchanged fingerprint means previously inspected shape information remains valid. Optionally inspect data/figures by binding name to read inferred shapes only. Errors include original source spans, capped at 20; upstream cascades are hidden. Fingerprints describe shapes, not execution caches.',
      parameters:{type:'object',properties:{src:{type:'string'},inspect:{type:'object',properties:{data:{type:'array',maxItems:32,items:{type:'string',minLength:1}},figures:{type:'array',maxItems:32,items:{type:'string',minLength:1}}},additionalProperties:false}},required:['src'],additionalProperties:false},
      output:{schema:OBJECT,render:(_args:unknown,value:unknown)=>[{type:'text',text:(value as {text:string}).text}]},
      async execute(args:{src?:unknown;inspect?:unknown},exec:ToolExec) {
        assertKeys(args,['src','inspect']);
        const inspect=parseInspect(args.inspect);
        if(typeof args.src!=='string'||!args.src.endsWith('.dari'))throw new Error('src must be a local .dari path');
        const entry=options.knowledge.ensureWorkspace(exec);
        const read=readDariSource(entry.root,args.src,'dari_check');
        const signal=AbortSignal.any([shutdown.signal,AbortSignal.timeout(120000),...(exec.signal?[exec.signal]:[])]);
        return checkReceipt(await checkSource(entry,read.file,read.text,exec,signal),inspect);
      },
    },
    {
      name:'dari_resolve',
      description:'Check a DARI source and resolve requested outputs. answer is required: true resolves the unique Answer; false selects only explicit data/figures/reports. Successful text begins Succeed and a divider, followed by comment-delimited blocks: <!-- answer -->, <!-- reports.name --> and <!-- figures.name --> contain ready-to-use Markdown; <!-- data.name --> contains structured JSON in a code fence. Copy requested Markdown verbatim into the reply, excluding receipt headers and markers. Executes only selected dependencies and reuses cached computations. Failures are concise tool errors. requireRunApproval controls native approval; dari_renew_context starts a fresh acquisition batch.',
      parameters:{type:'object',properties:{src:{type:'string'},data:{type:'array',items:{type:'string'}},figures:{type:'array',items:{type:'string'}},reports:{type:'array',items:{type:'string'}},answer:{type:'boolean',description:'Required. true resolves the unique Answer; false selects only explicit data/figures/reports for debugging.'}},required:['src','answer'],additionalProperties:false},
      output:{schema:OBJECT,render:(_args:unknown,value:unknown)=>[{type:'text',text:renderResolveReceipt(value)}]},
      async execute(args:{src?:unknown;data?:unknown;figures?:unknown;reports?:unknown;answer?:unknown},exec:ToolExec){
        assertKeys(args,['src','answer','data','figures','reports']);
        if(typeof args.src!=='string'||!args.src.endsWith('.dari'))throw new Error('src must be a local .dari path');
        if(typeof args.answer!=='boolean')throw new Error('answer must be explicitly set to true or false');
        const selection={data:[] as string[],figures:[] as string[],reports:[] as string[]};
        for(const kind of ['data','figures','reports'] as const){
          const names=args[kind];
          if(names!==undefined&&(!Array.isArray(names)||names.some(n=>typeof n!=='string'||!n.length)))throw new Error(`${kind} must be an array of binding names`);
          selection[kind]=[...new Set(names as string[]|undefined)];
        }
        const targets=[...Object.values(selection).flat(),...(args.answer?['answer']:[])];
        if(!targets.length)throw new Error('Select at least one data, figure or report binding');
        if(!exec.agent?.session)throw new Error('dari_resolve requires a caller session');
        const entry=options.knowledge.ensureWorkspace(exec);
        const read=readDariSource(entry.root,args.src,'dari_resolve');
        const key=keyFor(entry,exec,read.file);
        if(pending.has(key))throw new Error('This draft is already awaiting approval or running');
        pending.add(key);
        const signal=AbortSignal.any([shutdown.signal,...(exec.signal?[exec.signal]:[])]);
        try{
          signal.throwIfAborted();
          const checked=await checkSource(entry,read.file,read.text,exec,AbortSignal.any([signal,AbortSignal.timeout(120000)]));
          if(!checked.ok)return {...checked,...checkReceipt(checked),execution:'not performed'};
          const doc=parseDesign(read.text,read.file);
          const answers=new Set([...doc.assets.values()].filter(a=>a.format==='markdown').map(a=>a.name.slice('@report/'.length)));
          const reports=new Set(doc.answers.filter(name=>!answers.has(name)));
          if(args.answer&&!answers.has('answer'))throw new Error('Missing answer := Answer [...]; use answer:false for explicit debug selections');
          const figures=new Set(Object.values(doc.authoring?.figures??{}).map(f=>f.binding));
          const bindings=new Set(doc.nodes.filter(n=>!n.internal&&n.statement.kind==='binding').map(n=>n.statement.kind==='binding'?n.statement.name:''));
          const diagnostics=[];
          for(const kind of ['data','figures','reports'] as const)for(const name of selection[kind]){
            const node=doc.nodes.find(n=>n.statement.kind==='binding'&&n.statement.name===name);
            // Pipeline chart bindings can directly call render_figure.
            const figure=figures.has(name)||node?.statement.value.kind==='call'&&node.statement.value.operator==='render_figure';
            const valid=bindings.has(name)&&(kind==='reports'?reports.has(name):kind==='figures'?figure:!reports.has(name)&&!answers.has(name)&&!figure);
            if(!valid)diagnostics.push({file:read.file,stage:'selection',message:`Unknown ${kind} binding or wrong kind: ${name}`,span:node?.statement.span??doc.pipeline});
          }
          if(diagnostics.length)return {ok:false,status:'invalid',diagnostics,execution:'not performed'};
          const requiresApproval=entry.settings.requireRunApproval===true;
          const approval=requiresApproval?options.approval?.():undefined;
          if(requiresApproval&&!approval)return {ok:false,status:'approval-unavailable',execution:'not performed'};
          const sourceHash=sha(read.text);
          const environment=()=>canonicalJson([entry.modelHash,entry.settings.domain,entry.settings.dataFile,entry.settings.queryMaxRows,entry.settings.requireRunApproval??false,options.timeContext.zones.get(exec.agent!.session!)??null]);
          const approvedEnvironment=environment();
          let approvalStatus:'allowed-once'|'not-required'='not-required';
          if(requiresApproval){
            const reason=`解析分析稿 ${read.file.split('/').at(-1)}`;
            const decision=await approval!.request({agent:exec.agent,toolName:'dari_resolve',...(exec.callId?{callId:exec.callId}:{}),reason,signal});
            signal.throwIfAborted();
            if(decision!=='allowed-once')return {ok:false,status:decision==='rejected'?'approval-rejected':decision==='cancelled'?'approval-cancelled':'approval-unavailable',execution:'not performed',sourceHash};
            approvalStatus='allowed-once';
          }
          if(approvedEnvironment!==environment())return {ok:false,status:'environment-changed',execution:'not performed',sourceHash};
          if(readDariSource(entry.root,args.src,'dari_resolve').text!==read.text)return {ok:false,status:'source-changed',execution:'not performed',sourceHash};
          const answerAsset=args.answer?doc.assets.get('@report/answer'):undefined;
          const presentationNames=[...selection.figures,...selection.reports,...Object.values(answerAsset?.references??{}).filter(r=>r.kind!=='value').map(r=>r.code!)];
          const needsAttachment=presentationNames.some(name=>{
            const value=doc.nodes.find(n=>n.statement.kind==='binding'&&n.statement.name===name)?.statement.value;
            return !(value?.kind==='call'&&value.operator==='render_figure'&&value.figureKind==='table');
          });
          if(needsAttachment&&!options.attachments?.())throw new Error('The host attachments service is unavailable');
          const record=recordFor(entry,exec,read.file,true);
          if(record.active)throw new Error('This draft is already running; wait for it to finish');
          record.active=true;record.touched=Date.now();
          record.zone=structuredClone(options.timeContext.zones.get(exec.agent.session)??{kind:'missing'});
          try{
            const run=await record.runtime.run(read.text,{targets,signal:AbortSignal.any([signal,AbortSignal.timeout(120000)])});
            const base=receipt(run,read.file);
            if(!base.ok)return {...base,approval:approvalStatus};
            const data:Record<string,unknown>=Object.create(null);
            const figures:Record<string,{embedded:string}>=Object.create(null);
            const reports:Record<string,{embedded:string}>=Object.create(null);
            let answer:{embedded:string}|undefined;
            const published=new Map<string,{embedded:string}>();
            const publishOnce=async(name:string)=>{let value=published.get(name);if(!value){value=await publish(record,read.text,name,exec);published.set(name,value);}return value;};
            for(const name of selection.data)data[name]=record.runtime.read(name,read.text).value.data;
            for(const name of selection.figures)figures[name]=await publishOnce(name);
            for(const name of selection.reports)reports[name]=await publishOnce(name);
            if(args.answer){
              const asset=answerAsset!;
              const presentations:Record<string,string>=Object.create(null);
              for(const [alias,reference]of Object.entries(asset.references??{}))if(reference.kind!=='value')presentations[alias]=(await publishOnce(reference.code!)).embedded;
              const value=record.runtime.read('answer',read.text).value.data as {items:Record<string,unknown>};
              answer={embedded:renderMarkdownAnswer(asset.program!,value.items,presentations)};
            }
            // Receipts describe failures, not unrequested values or intermediate bindings.
            return {ok:true,run:run.id,sourceHash:run.sourceHash,batch:run.batch,counts:base.counts,approval:approvalStatus,
              ...(selection.data.length?{data:{...data}}:{}),...(selection.figures.length?{figures:{...figures}}:{}),...(selection.reports.length?{reports:{...reports}}:{}),...(answer?{answer}:{})};
          }finally{record.active=false;record.touched=Date.now();if(closed)record.runtime.dispose();}
        }finally{pending.delete(key);}
      },
    },
    {
      name: 'dari_renew_context',
      description: 'Start a fresh acquisition context for one local DARI source in the current session. Renews the time baseline and query snapshots, invalidates previous results, and preserves reusable deterministic computations. Does not execute queries or modify source. The next dari_resolve acquires new data.',
      parameters: {type:'object',properties:{src:{type:'string'}},required:['src'],additionalProperties:false},
      output,
      async execute(args:{src?:unknown},exec:ToolExec) {
        exec.signal?.throwIfAborted();
        assertKeys(args,['src']);
        const entry=options.knowledge.ensureWorkspace(exec);
        const read=readDariSource(entry.root,args.src,'dari_renew_context');
        const key=keyFor(entry,exec,read.file);
        if(pending.has(key))throw new Error('This draft is already awaiting approval or running');
        const record=recordFor(entry,exec,read.file,true);
        if(record.active)throw new Error('This draft is already running; wait for it to finish');
        const batch=record.runtime.renew();
        record.contextTime=Date.now();
        record.zone=structuredClone(options.timeContext.zones.get(exec.agent!.session!)??{kind:'missing'});
        record.touched=Date.now();
        return {ok:true,src:read.file,batch,status:'renewed'};
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
