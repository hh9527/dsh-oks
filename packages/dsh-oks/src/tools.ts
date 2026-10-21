import {helpFiles,helpEntries} from './help-files.ts';
import { WORK_URI, MEMORY_URI, sourceUri } from './resource-path.ts';
import { createKtools, type Ktools } from './ktools.ts';
import { KTOOLS_FILE, KTOOLS_BUILTIN } from './ktools-path.ts';
import { builtinKtoolsSource } from './knowledge-programs.ts';
/** Host bridge: work files, vocabulary and draft tool lifecycle. */
import { createDraftTools } from './draft/tools.ts';
import type { PluginConfig } from './config.ts';
import type { AttachmentsService, LogFn, ToolDefinition, ToolExec } from './host.ts';
import type { Knowledge } from './knowledge.ts';
import type { TimeContext } from './time-context.ts';
import { renderAsk, VA_HELPER_PREFIX } from './va.ts';
import type { VaRuntime } from './va.ts';
import { OBJECT_OUTPUT, renderValue, renderWorkDelete, renderWorkEdit, renderWorkRead, renderWorkWrite } from './response.ts';
import { deleteWorkFile, prepareWorkEdit, readWorkText, readTextLines, listWorkFiles, readWorkFile, WORK_DIR, writeWorkFile } from './results.ts';

interface WorkReadArgs {
  path?: unknown;
  offset?: unknown;
  limit?: unknown;
}
interface WorkWriteArgs {
  path?: unknown;
  content?: unknown;
}
interface WorkEditArgs {
  path?: unknown;
  old_string?: unknown;
  new_string?: unknown;
  replace_all?: unknown;
}

/** oks_delete 的入参：要删的那份代码文件。 */
interface WorkDeleteArgs {
  path?: unknown;
}

/** 当前会话词汇咨询的入参。 */
interface AskArgs {
  query?: string;
}

/** 注册宿主工具及其工作区／会话运行状态。 */
export function createTools({ knowledge, va, timeContext, log, attachments, ktools=createKtools() }: {
  knowledge: Knowledge;
  attachments?:()=>AttachmentsService|undefined;
  ktools?: Ktools;
  va: VaRuntime;
  timeContext: TimeContext;
  log: LogFn;
  config: PluginConfig | undefined;
}): ToolDefinition[] & { dispose(): void } {
  const definitions: ToolDefinition[] = [
    {
      name: 'oks_read',
      description: 'Read line-numbered source from oks://work/<file>, persistent oks://memory/tools/ktools.lib.jq, or readonly oks://builtin/tools/ktools.lib.jq and oks://help/<name>.md. offset/limit page lines (default/max 2000); lines longer than 2000 characters are marked and truncated; selected text is capped at 50 KiB with a continuation offset. A missing oks://memory/tools/ktools.lib.jq returns an editable starter. Use oks_list({path:"oks://work/"}) to list files.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Source path: oks://work/<file>, oks://memory/tools/ktools.lib.jq or oks://builtin/tools/ktools.lib.jq and oks://help/<name>.md. Use oks_list for directories.' },
          offset: { type: 'number', description: 'First line to return, 1-based. Default 1.' },
          limit: { type: 'number', description: 'How many lines to return, 1..2000. Default 2000.' },
        },
        required: ['path'],
        additionalProperties: false,
      },
      output: { schema: OBJECT_OUTPUT, render: renderWorkRead },
      async execute(args: WorkReadArgs, exec: ToolExec) {
        if(typeof args?.path==='string'&&args.path.startsWith('oks://help/')){
          if(!Object.hasOwn(helpFiles,args.path))throw new Error('Unknown readonly help file; use oks_list({path:"oks://help/"})');
          return readTextLines(helpFiles[args.path],args.path,args.offset,args.limit,'oks_read');
        }
        if(args?.path===KTOOLS_BUILTIN)return readTextLines(builtinKtoolsSource,KTOOLS_BUILTIN,args.offset,args.limit,'oks_read');
        const entry = knowledge.ensureWorkspace(exec);
        const root = entry.settings.workspaceRoot;
        const given = args?.path;
        if (given === WORK_URI) throw new Error('Not a regular file; use oks_list({path:"oks://work/"})');
        const read = await readWorkFile(root, args?.path, args?.offset, args?.limit, 'oks_read');
        log(`[oks] oks_read ${read.path} · 第 ${read.offset} 行起 ${read.lines.length} 行（共 ${read.totalLines} 行）`);
        return read;
      },
    },
    {
      name: 'oks_write',
      description: 'Write UTF-8 source to oks://work/<file> or persistent oks://memory/tools/ktools.lib.jq. DARI drafts contain their own jq assets; execute them with oks_run_answer. Knowledge methods belong in oks://memory/tools/ktools.lib.jq: only comments and def name($args): ...; definitions, compiled before saving. Invalid content preserves the existing file. Read oks://builtin/tools/ktools.lib.jq for examples. The library is exempt from automatic cleanup.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Source address: oks://work/<file> or oks://memory/tools/ktools.lib.jq.' },
          content: { type: 'string', description: 'Source text, verbatim.' },
        },
        required: ['path', 'content'],
        additionalProperties: false,
      },
      output: { schema: OBJECT_OUTPUT, render: renderWorkWrite },
      async execute(args: WorkWriteArgs, exec: ToolExec) {
        const entry = knowledge.ensureWorkspace(exec);
        if(args?.path===KTOOLS_FILE)await ktools.validate(args.content,KTOOLS_FILE,exec.signal);
        const saved = writeWorkFile(entry.settings.workspaceRoot, args?.path, args?.content, 'oks_write');
        log(`[oks] oks_write ${saved.file} · ${(saved.bytes / 1024).toFixed(1)} KB · ${saved.created ? '新建' : '覆盖'}`);
        return { ok: true as const, ...saved };
      },
    },
    {
      name: 'oks_edit',
      description: 'Replace exact text in oks://work/<file> or persistent oks://memory/tools/ktools.lib.jq. old_string must occur once unless replace_all=true. Library edits compile before saving; invalid content preserves the existing file.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Source address: oks://work/<file> or oks://memory/tools/ktools.lib.jq.' },
          old_string: { type: 'string', description: 'The exact text to replace (must occur verbatim).' },
          new_string: { type: 'string', description: 'What to put in its place.' },
          replace_all: { type: 'boolean', description: 'Replace every occurrence instead of requiring uniqueness. Default false.' },
        },
        required: ['path', 'old_string', 'new_string'],
        additionalProperties: false,
      },
      output: { schema: OBJECT_OUTPUT, render: renderWorkEdit },
      async execute(args: WorkEditArgs, exec: ToolExec) {
        const entry = knowledge.ensureWorkspace(exec);
        const root=entry.settings.workspaceRoot;
        const candidate=prepareWorkEdit(root,args?.path,args?.old_string,args?.new_string,args?.replace_all,'oks_edit');
        if(candidate.file===KTOOLS_FILE)await ktools.validate(candidate.body,KTOOLS_FILE,exec.signal);
        if(readWorkText(root,candidate.file,'oks_edit').text!==candidate.original)throw new Error('File changed while validating; read and retry');
        writeWorkFile(root,candidate.file,candidate.body,'oks_edit');
        const saved={file:candidate.file,replaced:candidate.replaced,bytes:candidate.bytes};
        log(`[oks] oks_edit ${saved.file} · 替换 ${saved.replaced} 处 · ${(saved.bytes / 1024).toFixed(1)} KB`);
        return { ok: true as const, ...saved };
      },
    },
    {
      name: 'oks_list',
      description: 'List readonly oks://help/ text files, oks://work/ scratch files and the existing persistent oks://memory/tools/ktools.lib.jq library: path, size and modification time.',
      parameters: { type: 'object', properties: {path:{type:'string'}}, additionalProperties: false },
      output: { schema: OBJECT_OUTPUT, render: renderValue },
      async execute(args:{path?:unknown}, exec: ToolExec) {
        const path=args?.path;
        if(path==='oks://help/')return {ok:true as const,files:helpEntries(),count:helpEntries().length};
        const entry = knowledge.ensureWorkspace(exec);
        const dirs=[WORK_URI,MEMORY_URI,MEMORY_URI+'tools/','oks://builtin/','oks://builtin/tools/'];
        if(path!==undefined&&!dirs.includes(path as string))throw new Error('path must be an OKS source directory');
        const all=listWorkFiles(entry.settings.workspaceRoot).map(file=>({...file,name:sourceUri(file.name)}));
        if(typeof path==='string'&&path.startsWith('oks://builtin/'))all.push({name:KTOOLS_BUILTIN,bytes:Buffer.byteLength(builtinKtoolsSource),modifiedAt:''});
        const files=all.filter(file=>path===undefined||file.name.startsWith(path as string));
        return { ok: true as const, files, count: files.length };
      },
    },
    {
      name: 'oks_delete',
      description: 'Delete one file in oks://work/ or explicitly delete oks://memory/tools/ktools.lib.jq. The persistent library is only removed by explicit deletion; automatic cleanup retains it.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Source address: oks://work/<file> or oks://memory/tools/ktools.lib.jq.' },
        },
        required: ['path'],
        additionalProperties: false,
      },
      output: { schema: OBJECT_OUTPUT, render: renderWorkDelete },
      async execute(args: WorkDeleteArgs, exec: ToolExec) {
        const entry = knowledge.ensureWorkspace(exec);
        const removed = deleteWorkFile(entry.settings.workspaceRoot, args?.path);
        log(`[oks] oks_delete ${removed.file} · 还剩 ${removed.remaining} 个文件`);
        return { ok: true as const, ...removed };
      },
    },
    {
      name: 'va_ask',
      description: 'Consult this session\'s vocabulary helper and get its answer back: send one paraphrase — a word, a phrase or a sentence, any language — and you receive the vocabulary\'s own equivalent or near expressions, one per line and verbatim. The helper holds the whole vocabulary in its system prompt, so the first call sets it up and takes longer; each later call is one question. Treat what it returns as leads: look the strings up with oks_project({input:"oks://knowledge",transform:{lib:"oks://builtin/tools/ktools.lib.jq",name:"search",args:{query:"returned word"}}}) and read declarations with its read method; read resolves the exact returned address and pairs facts with descriptions.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'The paraphrase to consult about, e.g. "丢包" or "port pressure".',
          },
        },
        required: ['query'],
        additionalProperties: false,
      },
      output: { schema: OBJECT_OUTPUT, render: renderAsk },
      async execute(args: AskArgs, exec: ToolExec) {
        const query = typeof args?.query === 'string' ? args.query.trim() : '';
        if (query.length === 0) throw new Error('dsh-oks: va_ask 需要一个说法（query）。');
        const caller = exec?.agent;
        const key = caller?.session?.id;
        if (typeof key === 'string' && key.startsWith(VA_HELPER_PREFIX)) {
          throw new Error('dsh-oks: 词汇助手不咨询自己。');
        }
        if (caller === undefined || typeof key !== 'string' || key.length === 0) {
          throw new Error('dsh-oks: 无法确定调用方会话，va_ask 需要它来记住词汇助手。');
        }
        return va.ask(caller, key, query, exec?.signal);
      },
    },
  ];

  const drafts = createDraftTools({ knowledge, timeContext, attachments, ktools });
  return Object.assign([...definitions, ...drafts.tools], { dispose: drafts.dispose });
}
