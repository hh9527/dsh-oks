import {helpFiles,helpEntries} from './help-files.ts';
import { renderKnowledgeHelp } from './knowledge-navigation.ts';
import { errorText } from './host.ts';
import { WORK_URI, sourceUri } from './resource-path.ts';
/** Host bridge: work files, vocabulary and draft tool lifecycle. */
import { createDraftTools } from './draft/tools.ts';
import type { PluginConfig } from './config.ts';
import type { ApprovalService, AttachmentsService, LogFn, ToolDefinition, ToolExec } from './host.ts';
import type { Knowledge } from './knowledge.ts';
import type { TimeContext } from './time-context.ts';
import { renderAsk, KA_HELPER_PREFIX } from './ka.ts';
import type { KaRuntime } from './ka.ts';
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
export function createTools({ knowledge, ka, timeContext, log, attachments, approval }: {
  knowledge: Knowledge;
  attachments?:()=>AttachmentsService|undefined;
  approval?:()=>ApprovalService|undefined;
  ka: KaRuntime;
  timeContext: TimeContext;
  log: LogFn;
  config: PluginConfig | undefined;
}): ToolDefinition[] & { dispose(): void } {
  const helpTexts = async (exec: ToolExec): Promise<Record<string, string>> => {
    if (!exec.agent?.session) return helpFiles;
    try {
      const entry = knowledge.ensureWorkspace(exec);
      const index = await knowledge.ensureIndex(entry);
      return { ...helpFiles, 'oks://help/knowledge.md': renderKnowledgeHelp(helpFiles['oks://help/knowledge.md'], index.knowledge, entry.settings.domain) };
    } catch (error) {
      exec.signal?.throwIfAborted();
      log('[oks] knowledge help overview unavailable: ' + errorText(error));
      return { ...helpFiles, 'oks://help/knowledge.md': helpFiles['oks://help/knowledge.md'] + '\n当前模型目录暂不可用；模型就绪后用 oks_project({input:"oks://knowledge",select:":keys"}) 核对实际根分支。\n' };
    }
  };
  const definitions: ToolDefinition[] = [
    {
      name: 'oks_read',
      description: 'Read line-numbered analysis source at oks://work/<file> or readonly manuals at oks://help/<name>.md. Use oks_list to discover files.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Source path: oks://work/<file>' },
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
          const files=args.path==='oks://help/knowledge.md'?await helpTexts(exec):helpFiles;
          return readTextLines(files[args.path],args.path,args.offset,args.limit,'oks_read');
        }
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
      description: 'Write UTF-8 analysis source to oks://work/<file>. Check a DARI draft with oks_check, then execute it with oks_run; approval is controlled by configuration.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Source path: oks://work/<file>' },
          content: { type: 'string', description: 'Source text, verbatim.' },
        },
        required: ['path', 'content'],
        additionalProperties: false,
      },
      output: { schema: OBJECT_OUTPUT, render: renderWorkWrite },
      async execute(args: WorkWriteArgs, exec: ToolExec) {
        const entry = knowledge.ensureWorkspace(exec);
        const saved = writeWorkFile(entry.settings.workspaceRoot, args?.path, args?.content, 'oks_write');
        log(`[oks] oks_write ${saved.file} · ${(saved.bytes / 1024).toFixed(1)} KB · ${saved.created ? '新建' : '覆盖'}`);
        return { ok: true as const, ...saved };
      },
    },
    {
      name: 'oks_edit',
      description: 'Replace exact text in oks://work/<file>. old_string must occur once unless replace_all=true.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Source path: oks://work/<file>' },
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
        if(readWorkText(root,candidate.file,'oks_edit').text!==candidate.original)throw new Error('File changed while validating; read and retry');
        writeWorkFile(root,candidate.file,candidate.body,'oks_edit');
        const saved={file:candidate.file,replaced:candidate.replaced,bytes:candidate.bytes};
        log(`[oks] oks_edit ${saved.file} · 替换 ${saved.replaced} 处 · ${(saved.bytes / 1024).toFixed(1)} KB`);
        return { ok: true as const, ...saved };
      },
    },
    {
      name: 'oks_list',
      description: 'List readonly oks://help/ manuals or oks://work/ analysis source files.',
      parameters: { type: 'object', properties: {path:{type:'string'}}, additionalProperties: false },
      output: { schema: OBJECT_OUTPUT, render: renderValue },
      async execute(args:{path?:unknown}, exec: ToolExec) {
        const path=args?.path;
        if(path==='oks://help/'){const files=helpEntries(await helpTexts(exec));return {ok:true as const,files,count:files.length};}
        const entry = knowledge.ensureWorkspace(exec);
        const dirs=[WORK_URI];
        if(path!==undefined&&!dirs.includes(path as string))throw new Error('path must be an OKS source directory');
        const all=listWorkFiles(entry.settings.workspaceRoot).map(file=>({...file,name:sourceUri(file.name)}));
        const files=all.filter(file=>path===undefined||file.name.startsWith(path as string));
        return { ok: true as const, files, count: files.length };
      },
    },
    {
      name: 'oks_delete',
      description: 'Delete one source file in oks://work/.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Source path: oks://work/<file>' },
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
      name: 'ka_ask',
      timeoutMs: 125_000,
      description: 'Ask the knowledge assistant for a short list of relevant semantic addresses and one-sentence purposes for the original user question. It adds retrieval terms or unresolved business ambiguity only when necessary. Send the original question before selecting datasets or measures; include explicit user constraints verbatim. It holds the domain relationship map and consults a separate vocabulary assistant. Waits for and returns the assistant answer before subsequent knowledge retrieval. Independently use oks_search/oks_cap/oks_card to inspect details and design queries. Each consultation retains a fixed knowledge prefix and collapses prior questions and answers.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'The original user question, including explicit constraints. Preserve its scope rather than preselecting dataset or field IDs.',
          },
        },
        required: ['query'],
        additionalProperties: false,
      },
      output: { schema: OBJECT_OUTPUT, render: renderAsk },
      async execute(args: AskArgs, exec: ToolExec) {
        const query = typeof args?.query === 'string' ? args.query.trim() : '';
        if (query.length === 0) throw new Error('dsh-oks: ka_ask 需要一个问题（query）。');
        const caller = exec?.agent;
        const key = caller?.session?.id;
        if (typeof key === 'string' && key.startsWith(KA_HELPER_PREFIX)) {
          throw new Error('dsh-oks: 知识助手不咨询自己。');
        }
        if (caller === undefined || typeof key !== 'string' || key.length === 0) {
          throw new Error('dsh-oks: 无法确定调用方会话，ka_ask 需要它来登记知识子会话。');
        }
        return ka.ask(caller, key, query, exec?.signal);
      },
    },
  ];

  const drafts = createDraftTools({approval, knowledge, timeContext, attachments });
  return Object.assign([...definitions, ...drafts.tools], { dispose: drafts.dispose });
}
