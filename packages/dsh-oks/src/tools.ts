import {createDariTools} from '@hh9527/dari-model';
import {ENABLE_OKS_SEARCH} from '@hh9527/dari-model';
import {reportExtractDariTool} from '@hh9527/dari-model';
import {moveEntryTool} from '@hh9527/dari-model';
import {removeFileTool,type FilePolicyService} from '@hh9527/dari-model';
import type { PluginConfig } from '@hh9527/dari-model';
import type { ApprovalService, AttachmentsService, LogFn, ToolDefinition, ToolExec } from '@hh9527/dari-model';
import type { Knowledge } from '@hh9527/dari-model';
import type { TimeContext } from '@hh9527/dari-model';
import { renderAsk } from './va.ts';
import type { VaRuntime } from './va.ts';
import { OBJECT_OUTPUT } from '@hh9527/dari-model';

interface AskArgs { query?: string }

/** Public knowledge consultation and DARI lifecycle tools. */
export function createTools({ knowledge, va, timeContext, attachments, approval, filePolicy, config }: {
  knowledge: Knowledge;
  filePolicy?:()=>FilePolicyService|undefined;
  attachments?:()=>AttachmentsService|undefined;
  approval?:()=>ApprovalService|undefined;
  va: VaRuntime;
  timeContext: TimeContext;
  log: LogFn;
  config: PluginConfig | undefined;
}): ToolDefinition[] & { dispose(): void; infoContracts?:(points:any[],exec:ToolExec)=>Promise<Record<string,unknown>> } {
  const definitions: ToolDefinition[] = [
    {
      name: 'dari_vocab',
      timeoutMs: 125_000,
      description: 'Align wording from the original user question to domain vocabulary. Returns verbatim ASCII English vocabulary entries grouped by user wording, preserving spelling and case, without knowledge addresses or query plans. Use relevant returned entity/property/value terms with dari_kg_discover for conceptual mappings, to discover actual knowledge IDs, then use dari_kg_info and dari_kg_routes as needed. Include the original question and explicit constraints.'+(ENABLE_OKS_SEARCH?' Use dari_kg_search for scoped lexical searches when needed.':''),
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
        if (query.length === 0) throw new Error('dsh-oks: dari_vocab 需要一个问题（query）。');
        const caller = exec?.agent;
        const key = caller?.session?.id;
        if (typeof key === 'string' && key.startsWith('session-va-')) {
          throw new Error('dsh-oks: 词汇助手不咨询自己。');
        }
        if (caller === undefined || typeof key !== 'string' || key.length === 0) {
          throw new Error('dsh-oks: 无法确定调用方会话，dari_vocab 需要它来登记词汇子会话。');
        }
        const entry = knowledge.ensureWorkspace(exec);
        await knowledge.ensureIndex(entry);
        return va.ask(caller, key, query, exec?.signal, entry.settings);
      },
    },
  ];
  const drafts:{tools:ToolDefinition[];dispose:()=>void;infoContracts?:(points:any[],exec:ToolExec)=>Promise<Record<string,unknown>>} = createDariTools({config:config?.dari,knowledge,timeContext,attachments});
  return Object.assign([...definitions, reportExtractDariTool({knowledge,approval,filePolicy}), removeFileTool({knowledge,approval,filePolicy}), moveEntryTool({knowledge,approval,filePolicy}), ...drafts.tools], { dispose: drafts.dispose, ...(drafts.infoContracts?{infoContracts:drafts.infoContracts}:{}) });
}
