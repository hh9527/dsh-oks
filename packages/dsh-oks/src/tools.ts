import { WORK_URI, MEMORY_URI, sourceUri } from './resource-path.ts';
import { createKtools, type Ktools } from './ktools.ts';
import { KTOOLS_FILE, KTOOLS_BUILTIN } from './ktools-path.ts';
import { builtinKtoolsSource } from './knowledge-programs.ts';
/** Host bridge: work files, retained artifacts, vocabulary and draft tool lifecycle. */
import { unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { createDraftTools } from './draft/tools.ts';
import { parseArtifactOrigin } from './report/read.ts';
import { restoreAssets } from './report/page.ts';
import { windowText } from './config.ts';
import type { PluginConfig } from './config.ts';
import { errorText, isRecord } from './host.ts';
import type { LogFn, ToolDefinition, ToolExec } from './host.ts';
import type { Knowledge, WorkspaceEntry } from './knowledge.ts';
import type { TimeContext } from './time-context.ts';
import { renderAsk, VA_HELPER_PREFIX } from './va.ts';
import type { VaRuntime } from './va.ts';
import { OBJECT_OUTPUT, renderArtifacts, renderValue, renderWorkDelete, renderWorkEdit, renderWorkRead, renderWorkWrite } from './response.ts';
import { adoptArtifacts, collectMaterials, collectWork, listArtifacts, markCleanup, materialCount, openState, pruneArtifacts, reconcileArtifacts, recordArtifact, VISIBLE } from './state.ts';
import { deleteWorkFile, prepareWorkEdit, readWorkText, readTextLines, listWorkFiles, readArtifact, readWorkFile, WORK_DIR, writeWorkFile, saveArtifact } from './results.ts';
import type { DataOrigin, Envelope, SaveArtifactOptions } from './results.ts';

function readProduct(root: string, asset: string): Envelope {
  const extension = asset.endsWith('.report.html') ? '.html'
    : asset.endsWith('.svg') ? '.svg'
      : asset.endsWith('.table.md') ? '.md' : '.json';
  let content: string;
  try {
    if (extension === '.json' && !/\.(qres|tr|def|ctx)\.json$/.test(asset)) {
      throw new Error(`资源不是已声明的数据资产类型：${asset}`);
    }
    content = readArtifact(root, asset, extension);
  } catch (cause) {
    throw new Error(`读不到这份产物：${asset}（${errorText(cause)}）`);
  }
  const parsed = parseArtifactOrigin(asset, content);
  if ('error' in parsed) throw new Error(parsed.error);
  return parsed;
}

function originForCarrying(asset: string, product: Envelope): DataOrigin {
  if (!asset.endsWith('.report.html')) return product.origin;
  const data = product.data;
  if (!isRecord(data) || !isRecord(data.assets)) return product.origin;
  return restoreAssets(product.origin, data.assets as Record<string, string>);
}

/** 普通资源只暴露负荷，#meta 显式暴露追踪信息；上游来源独立携带。 */
function readDataResource(root: string, src: string): { value: unknown; origin: DataOrigin; root: '.data' | '#meta' } {
  const parts = src.split('#');
  if (parts.length > 2 || (parts.length === 2 && parts[1] !== 'meta')) {
    throw new Error(`资源选择符错误：${src}`);
  }
  const asset = parts[0];
  const product = readProduct(root, asset);
  const meta = parts.length === 2;
  return {
    value: meta ? { meta: product.meta, origin: product.origin } : product.data,
    origin: originForCarrying(asset, product),
    root: meta ? '#meta' : '.data',
  };
}

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
export function createTools({ knowledge, va, timeContext, log, ktools=createKtools() }: {
  knowledge: Knowledge;
  ktools?: Ktools;
  va: VaRuntime;
  timeContext: TimeContext;
  log: LogFn;
  config: PluginConfig | undefined;
}): ToolDefinition[] & { dispose(): void } {
  const pruneBeforeWrite = (entry: WorkspaceEntry): void => {
    const root = entry.settings.workspaceRoot;
    const windows = entry.settings.retention.auto;
    const state = openState(root);
    try {
      const artifacts = pruneArtifacts(state, root, windows.artifacts);
      if (artifacts.removed.length > 0) {
        log(`[oks] prune · 清理 ${artifacts.removed.length} 个过期产物（窗口 ${windowText(windows.artifacts)}；`
          + `保留 ${artifacts.kept} 个、文件已经不在了 ${artifacts.missing} 个）`);
      }
      const materials = collectMaterials(root, windows.materials);
      if (materials.removed.length > 0) {
        log(`[oks] prune · 清理 ${materials.removed.length} 个过期材料（窗口 ${windowText(windows.materials)}；`
          + `认不出 ${materials.untouched} 个不动）`);
      }
      let workRemoved = 0;
      if (windows.work !== null) {
        const work = collectWork(root, windows.work);
        workRemoved = work.removed.length;
        if (work.removed.length > 0) {
          log(`[oks] prune · 清理 ${work.removed.length} 个过期程序文件（窗口 ${windowText(windows.work)}）`);
        }
      }
      // 顺手把账本对齐一次（补登 + 清掉文件已不在的行）：这是写路径该做的事，
      // 读路径因此可以完全不碰目录。人工放进 artifacts/ 的报告也在这里被收进清单。
      // "最后一次清理"只在确实清了东西时更新（每次写操作都刷一遍时间，这行就没意义了）。
      markCleanup(root, 'auto', artifacts.removed.length + materials.removed.length + workRemoved);
      const reconciled = reconcileArtifacts(state, root);
      if (reconciled.adopted > 0 || reconciled.removed.length > 0) {
        log(`[oks] 账本 · 补登 ${reconciled.adopted} 份、清掉 ${reconciled.removed.length} 条`
          + `（文件已经不在了）`);
      }
    } finally {
      state.close();
    }
  };

  /** 产出一份文件，并在**同一处**记账（只对进清单的那一类）。
   *  行与磁盘上的文件由这一次调用一起产生，于是不存在"文件在、账上没有"；记账失败就把文件删掉、
   *  整个调用失败，也不留孤文件。图不进清单（它是报表里的材料），产出流程一样，只是不记账。 */
  const saveAndRecord = (entry: WorkspaceEntry, options: Omit<SaveArtifactOptions, 'root'>): { asset: string; at: string } => {
    const root = entry.settings.workspaceRoot;
    pruneBeforeWrite(entry);
    const saved = saveArtifact({ root, ...options });
    const file = saved.asset.slice(saved.asset.lastIndexOf('/') + 1);
    if (!VISIBLE.test(file)) return saved;
    const state = openState(root);
    try {
      recordArtifact(state, file, saved.meta);
    } catch (cause) {
      try {
        unlinkSync(join(root, saved.asset));
      } catch {
        // 删不掉也不掩盖真正的原因：底下那句错误才是要看的。
      }
      throw new Error(`这份产物没能登记进清单（已把它删掉，不留孤文件）：${errorText(cause)}`);
    } finally {
      state.close();
    }
    return saved;
  };

  const definitions: ToolDefinition[] = [
    {
      name: 'oks_artifacts',
      description: 'List this workspace\'s reports, newest first, each with its title, category, time and whether it is pinned. Figures live inside reports, and query results are internal: neither appears here. Everything the workspace produces expires on the retention window its oks.json declares, so a report from an earlier session may already be gone. Use it when the user asks what has been produced in this workspace.',
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      output: { schema: OBJECT_OUTPUT, render: renderArtifacts },
      async execute(_args: unknown, exec: ToolExec) {
        const entry = knowledge.ensureWorkspace(exec);
        const root = entry.settings.workspaceRoot;
        const state = openState(root);
        try {
          // 读工具与端点走同一条路：账本就是清单，外加一次"只补登、不删除"的对账。
          adoptArtifacts(state, root);
          const entries = listArtifacts(state);
          log(`[oks] artifacts · ${entries.length} 条（保留 ${entries.filter((item) => item.pinned).length}）`);
          return { ok: true as const, keepAliveMinutes: entry.settings.retention.auto.artifacts, entries };
        } finally {
          state.close();
        }
      },
    },
    {
      name: 'oks_read',
      description: 'Read line-numbered source from oks://work/<file>, persistent oks://memory/tools/ktools.lib.jq, or readonly oks://builtin/tools/ktools.lib.jq. offset/limit page lines. A missing oks://memory/tools/ktools.lib.jq returns an editable starter. Use oks_list({path:"oks://work/"}) to list files.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Source path: oks://work/<file>, oks://memory/tools/ktools.lib.jq or oks://builtin/tools/ktools.lib.jq; oks://work/ lists files.' },
          offset: { type: 'number', description: 'First line to return, 1-based. Default 1.' },
          limit: { type: 'number', description: 'How many lines to return, 1..2000. Default 400.' },
        },
        required: ['path'],
        additionalProperties: false,
      },
      output: { schema: OBJECT_OUTPUT, render: renderWorkRead },
      async execute(args: WorkReadArgs, exec: ToolExec) {
        if(args?.path===KTOOLS_BUILTIN)return {ok:true as const,...readTextLines(builtinKtoolsSource,KTOOLS_BUILTIN,args.offset,args.limit,'oks_read'),entries:[]};
        const entry = knowledge.ensureWorkspace(exec);
        const root = entry.settings.workspaceRoot;
        const given = args?.path;
        if (given === WORK_URI) {
          return { ok: true as const, file: WORK_URI, entries: listWorkFiles(root).filter(f=>f.name.startsWith('.work/')).map(f=>({...f,name:sourceUri(f.name)})), lines: [], from: 1, total: 0, bytes: 0 };
        }
        const read = readWorkFile(root, args?.path, args?.offset, args?.limit, 'oks_read');
        log(`[oks] oks_read ${read.file} · 第 ${read.from} 行起 ${read.lines.length} 行`
          + `（共 ${read.total} 行 · ${(read.bytes / 1024).toFixed(1)} KB）`);
        return { ok: true as const, ...read, entries: [] };
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
      description: 'List oks://work/ scratch files and the existing persistent oks://memory/tools/ktools.lib.jq library: path, size and modification time.',
      parameters: { type: 'object', properties: {path:{type:'string'}}, additionalProperties: false },
      output: { schema: OBJECT_OUTPUT, render: renderValue },
      async execute(args:{path?:unknown}, exec: ToolExec) {
        const entry = knowledge.ensureWorkspace(exec);
        const path=args?.path;
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
      description: 'Consult this session\'s vocabulary helper and get its answer back: send one paraphrase — a word, a phrase or a sentence, any language — and you receive the vocabulary\'s own equivalent or near expressions, one per line and verbatim. The helper holds the whole vocabulary in its system prompt, so the first call sets it up and takes longer; each later call is one question. Treat what it returns as leads: look the strings up with oks_data input=oks://knowledge method oks://builtin/tools/ktools.lib.jq#search and read declarations with oks_data; read resolves the exact returned address and pairs facts with descriptions.',
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

  const drafts = createDraftTools({ knowledge, timeContext, save: saveAndRecord, readResource: readDataResource, ktools });
  return Object.assign([...definitions, ...drafts.tools], { dispose: drafts.dispose });
}
