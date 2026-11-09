import {ENABLE_OKS_SEARCH} from './features.ts';
import {reportExtractDariTool} from './report-extract.ts';
import {moveEntryTool} from './move-entry.ts';
import {removeFileTool,type FilePolicyService} from './remove-file.ts';
import type { PluginConfig } from './config.ts';
import type { ApprovalService, AttachmentsService, LogFn, ToolDefinition, ToolExec } from './host.ts';
import type { Knowledge } from './knowledge.ts';
import type { TimeContext } from './time-context.ts';
import { createDraftTools } from './draft/tools.ts';
import { renderAsk } from './ka.ts';
import type { KaRuntime } from './ka.ts';
import { OBJECT_OUTPUT } from './response.ts';

interface AskArgs { query?: string }

/** Public knowledge consultation and DARI lifecycle tools. */
export function createTools({ knowledge, ka, timeContext, attachments, approval, filePolicy }: {
  knowledge: Knowledge;
  filePolicy?:()=>FilePolicyService|undefined;
  attachments?:()=>AttachmentsService|undefined;
  approval?:()=>ApprovalService|undefined;
  ka: KaRuntime;
  timeContext: TimeContext;
  log: LogFn;
  config: PluginConfig | undefined;
}): ToolDefinition[] & { dispose(): void } {
  const definitions: ToolDefinition[] = [
    {
      name: 'va_ask',
      timeoutMs: 125_000,
      description: 'Align wording from the original user question to domain vocabulary. Returns verbatim ASCII English vocabulary entries grouped by user wording, preserving spelling and case, without knowledge addresses or query plans. Use relevant returned entity/property/value terms with oks_discover for conceptual mappings, to discover actual knowledge IDs, then use oks_info and oks_routes as needed. Include the original question and explicit constraints.'+(ENABLE_OKS_SEARCH?' Use oks_search for scoped lexical searches when needed.':''),
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
        if (query.length === 0) throw new Error('dsh-oks: va_ask 需要一个问题（query）。');
        const caller = exec?.agent;
        const key = caller?.session?.id;
        if (typeof key === 'string' && key.startsWith('session-va-')) {
          throw new Error('dsh-oks: 词汇助手不咨询自己。');
        }
        if (caller === undefined || typeof key !== 'string' || key.length === 0) {
          throw new Error('dsh-oks: 无法确定调用方会话，va_ask 需要它来登记词汇子会话。');
        }
        return ka.ask(caller, key, query, exec?.signal);
      },
    },
  ];
  const drafts = createDraftTools({approval, knowledge, timeContext, attachments });
  return Object.assign([...definitions, reportExtractDariTool({knowledge,approval,filePolicy}), removeFileTool({knowledge,approval,filePolicy}), moveEntryTool({knowledge,approval,filePolicy}), ...drafts.tools], { dispose: drafts.dispose });
}
