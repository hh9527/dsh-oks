import {reportExtractDariTool} from './report-extract.ts';
import {moveEntryTool} from './move-entry.ts';
import {removeFileTool,type FilePolicyService} from './remove-file.ts';
import type { PluginConfig } from './config.ts';
import type { ApprovalService, AttachmentsService, LogFn, ToolDefinition, ToolExec } from './host.ts';
import type { Knowledge } from './knowledge.ts';
import type { TimeContext } from './time-context.ts';
import { createDraftTools } from './draft/tools.ts';
import { renderAsk, KA_HELPER_PREFIX } from './ka.ts';
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
      name: 'ka_ask',
      timeoutMs: 245_000,
      description: 'Ask the knowledge assistant for a short list of relevant semantic addresses and one-sentence purposes for the original user question. It adds retrieval terms or unresolved business ambiguity only when necessary. Consult when domain vocabulary, canonical values or relationships are unclear; direct scoped search does not require consultation. Send the original question and include explicit user constraints verbatim. The tool first consults VA, then supplies the original question and vocabulary result to KA for relationship navigation. KA has no tools. Waits for and returns the assistant answer before subsequent knowledge retrieval. Returns two natural-language sections: "阅读清单" (KA reading list) and "词汇参考" (VA vocabulary reference), each preserved verbatim. Select Entity/Dataset anchor IDs from 阅读清单 and copy name from each 词汇参考 line (- `name` in `ctx`: user wording) into the q array of oks_search({q:[...],scope:[...]}), using ctx to select the shared scope. All terms use that same scope; make separate calls for different scopes; use oks_routes for relationships. The wording after the colon is only the user vocabulary comparison. Then read selected IDs with oks_info. Each consultation retains a fixed knowledge prefix and collapses prior questions and answers.',
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
  return Object.assign([...definitions, reportExtractDariTool({knowledge,approval,filePolicy}), removeFileTool({knowledge,approval,filePolicy}), moveEntryTool({knowledge,approval,filePolicy}), ...drafts.tools], { dispose: drafts.dispose });
}
