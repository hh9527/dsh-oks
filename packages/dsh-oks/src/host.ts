// 宿主侧契约的**最小面**，不是平台完整类型：这里只声明这个插件真正用到的那几个成员，
// 按现有代码的实际用法提取。宿主（DSH）自己的完整类型不在这里，也不该在这里复制。
//
// 三块：
//   1. 插件上下文（ctx / agentCtx）与它取到的服务、工具定义；
//   2. agent 句柄与**会话表面**（工具 exec 拿到的调用方与知识子会话）；
//   3. 知识服务的响应形状——宿主之外的对端协议，同样只声明我们用到的字段；
//      外加两个收窄小工具（isRecord / isArray）与错误转文本，供各模块共用。
//
// 这里的所有接口都是**结构性**的：宿主给的对象只要在这些成员上对得上就能装进来。

// ── 1. 插件上下文与宿主服务 ──────────────────────────────────────────────────

/** 宿主日志：插件只用到 info。 */
export interface LoggerLike {
  info?(message: string): void;
}

/** `ctx.effect` / `tools.register` 的返回值：一个可选的清理函数。 */
export type Disposable = () => void;

/** 插件的宿主日志出口（createTools / createKnowledge 等一路带上来的那个）。 */
export type LogFn = (message: string) => void;

/** 宿主内容块：简短 text 与持久 file 引用；文件内容不进模型上下文。 */
export interface RenderBlock {
  type: string;
  text?: string;
  attachment?: FileAttachmentRef;
}

/** Durable host file attachment; bytes are stored verbatim by ctx.attachments. */
export interface FileAttachmentRef { attachmentId:string; name:string; bytes:number }
export interface AttachmentsService {
  saveFile(input:{data:Uint8Array;name?:string}):Promise<FileAttachmentRef>;
  fileHostPath(ref:FileAttachmentRef):string|undefined;
}

/** 自带技能：注册进 skills 服务时用的形状。 */
export interface SkillLike {
  name: string;
  description: string;
  source: string;
  content: string;
}

export interface SkillsService {
  register(skill: SkillLike): Disposable | void;
}

export interface SystemPromptService {
  section(options: { name: string; order: number; text: string; interpolate?: boolean }): void;
  getSectionOrder(name: string): number;
}

/** 宿主执行、登记并向父会话投递子会话结果。 */
export interface SubagentActivation {
  childId: string;
  messageId: string;
  result: Promise<{ output: ContentBlock[]; stopReason: string; diagnostic?: string }>;
  dispose(): Promise<void>;
}

export interface SubagentsService {
  listChildren(parentSessionId: string, signal?: AbortSignal): Promise<{ id: string; label?: string; mode: string }[]>;
  drainChildren(parent: AgentLike, childIds: string[]): Promise<void>;
  sendMessage(parent: AgentLike, childId: string, prompt: ContentBlock[], options: { signal: AbortSignal }): Promise<string>;
  startActivation(spec: {
    provider: string;
    label: string;
    childId: string;
    delivery: 'parent' | 'caller';
    signal: AbortSignal;
    request: {
      parent: AgentLike;
      cwd: string;
      agentPreset: string;
      prompt: ContentBlock[];
      agentOptions?: { reasoningEffort: string };
    };
  }): Promise<SubagentActivation>;
}

export interface PromptAssembly {
  tools?: { name: string; [key: string]: unknown }[];
  sections: { name: string; text: string; interpolate?: boolean }[];
}

/** 工具定义：宿主只按 name/description/parameters/output 注册，execute 由宿主调用。
 *  render / presentationMeta / execute 的参数这里写成 never：定义方各自的具体签名都能装进来
 *  （逆变位置，never 可赋给任何参数类型），而插件自己从不调用它们。 */
export interface ToolDefinition {
  timeoutMs?: number;
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  output: {
    schema: unknown;
    render: (args: never, value: never) => RenderBlock[];
    /** 可选的宿主呈现记录（presentationMeta）：宿主把它投影进工具结果的 meta，与 render 的
     *  内容分开传递——render 的内容进模型可见的工具消息，meta 不进模型上下文。 */
    presentationMeta?: (args: never, value: never) => unknown;
  };
  execute(args: never, exec: ToolExec): Promise<unknown>;
}

/** DSH native one-action approval; only allowed-once authorizes execution. */
export interface ApprovalService {
  request(input:{agent:AgentLike;toolName:string;callId?:string;reason:string;signal?:AbortSignal}):Promise<'allowed-once'|'rejected'|'cancelled'|'unavailable'>;
}

export interface ToolsService {
  register(tool: ToolDefinition): Disposable | void;
  /** 限制该作用域继承的工具；本作用域直接注册的工具不受过滤影响。 */
  restrict(options: { allow: string[] }): void;
}

/** 工具 execute 收到的 exec：插件只用到取消信号与调用方 agent。 */
export interface ToolExec {
  callId?: string;
  signal?: AbortSignal;
  agent?: AgentLike;
}

/** 定位工作区只需要会话这一层（工具 exec 与 ka 装配时给的都是这个最小形状）。 */
export interface WorkspaceProbe {
  agent?: { session?: SessionLike } | null;
}

/** 插件上下文（apply 的 ctx）。
 *  `get` 按已知服务名给具体类型，其余回落成 unknown，取到后各调用处照旧自己判断。 */
export interface PluginContext {
  logger?: LoggerLike | null;
  get(name: 'approval'): ApprovalService | undefined;
  get(name: 'attachments'): AttachmentsService | undefined;
  get(name: 'skills'): SkillsService | undefined;
  get(name: 'subagents'): SubagentsService | undefined;
  get(name: string): unknown;
  /** 需要某个服务时才装配（取不到就不装）：插件在无 web 的部署里照常工作。 */
  inject?(names: string[], run: (ctx: PluginContext) => void): void;
  on(event: 'agent/pre-step', handler: PreStepHandler): Disposable;
  on(event: 'subagent/end', handler: (payload: { id: string; stopReason: string; lastAssistantMessage?: ContentBlock[] }) => void): Disposable;
  on(event: 'agent/status', handler: (payload: { agent: AgentLike; status: string }) => void): Disposable;
  on(event: 'system-prompt/assemble', handler: (
    assembly: PromptAssembly,
    context: { agent?: AgentLike; signal?: AbortSignal },
    next: () => Promise<PromptAssembly>,
  ) => Promise<PromptAssembly>): Disposable;
  effect(effect: () => unknown): void;
  tools: ToolsService;
  systemPrompt?: SystemPromptService | null;
}

// ── 2. agent 与会话表面 ──────────────────────────────────────────────────────

/** 当轮用户消息上按插件规范挂的浏览器时区（source.clientTimeZone）。 */
export interface ContextMessageLike {
  source?: {
    kind?: string;
    rpcId?: string;
    clientTimeZone?: string;
    senderSessionId?: string;
  } | null;
}

export interface StepDecision {
  kind?: string;
  messages?: ContextMessageLike[];
}

export interface PreStepPayload {
  step?: number;
  agent?: { session?: SessionLike } | null;
  messages?: readonly ContextMessageLike[] | null;
  signal?: AbortSignal;
}

export type PreStepHandler = (
  payload: PreStepPayload,
  next: () => Promise<StepDecision | undefined>,
) => Promise<StepDecision | undefined>;

export interface ContentBlock {
  type?: string;
  text?: string;
}

export interface EventData {
  source?: ContextMessageLike['source'];
  id?: string;
  content?: ContentBlock[];
  reason?: { kind?: string } | null;
  interrupted?: boolean;
  message?: { content?: ContentBlock[] | null } | null;
}

/** 会话日志里的一条事件：插件只读 seq / type / data 三处。 */
export interface EventLike {
  seq: number;
  type: string;
  data?: EventData | null;
}

/** 会话表面：工作区来源（meta/header/cwd）、日志事件、以及表面节点的追加与收起。
 *  `seq` 与 `surface.nodes` 是表面序号；`append` 返回刚落下的那条事件。 */
export interface SessionLike {
  requestHeader?(): { config?: { provider?:string; model?:string } } | undefined;
  id?: string;
  seq?: number;
  cwd?: string;
  meta?: { cwd?: string } | null;
  header?: { cwd?: string } | null;
  surface?: { nodes?: number[] } | null;
  eventAt?(seq: number): EventLike | undefined;
  snapshotEvents(): EventLike[];
  append(type: string, data: unknown, options?: unknown): EventLike;
}

/** 词汇咨询使用的调用方身份与工作区；其余执行行为由宿主管理。 */
export interface AgentLike {
  ctx?: { tools: ToolsService };
  options?: { provider?:string; model?:string };
  session: SessionLike;
}

// ── 3. 知识服务响应（对端协议）与收窄小工具 ──────────────────────────────────

/** 失败响应里诊断的**文本**面（批次级诊断另有 struct）。 */
export interface ErrorDiagnostic {
  message?: string;
}

export interface DiagnosticEntry {
  index: number;
  diagnostic?: {
    severity?: string;
    message?: string;
  } | null;
}

export interface QueryPayload {
  sql?: unknown;
  bindings?: unknown;
  columns?: unknown;
  limit_slot?: unknown;
}

export interface DocumentPayload {
  Found?: KnowledgeNode | null;
}

/** 服务响应的 `ok`：这里只声明插件读的那几个字段，其余走索引签名。 */
export interface OkPayload {
  accepted?: boolean;
  queries?: QueryPayload[] | null;
  diagnostics?: DiagnosticEntry[] | null;
  Document?: DocumentPayload | string | null;
  [key: string]: unknown;
}

export interface ServiceResponse {
  error?: boolean;
  diagnostics?: ErrorDiagnostic[] | null;
  ok?: OkPayload | null;
}

/** 一条过程轨迹：发了什么（method + request）、收回了什么（response）。 */
export interface TraceStep {
  method: string;
  request: unknown;
  response: ServiceResponse;
  note?: string;
}

export interface LocalizedText {
  label?: string;
  summary?: string;
}

export interface TermText {
  term?: string;
  description?: string;
}

export interface NodeDescription {
  label?: string;
  summary?: string;
  aliases?: string[] | null;
  localized?: LocalizedText[] | null;
  terms?: TermText[] | null;
}

/** 节点 detail：插件读 localized 与 schemas，其余字段按声明名（owner）动态取。 */
export interface NodeDetail {
  localized?: LocalizedText[] | null;
  schemas?: string[] | null;
  [key: string]: unknown;
}

export interface NodeLink {
  role?: string;
  key: string;
  type: string;
}

export interface KnowledgeNode {
  address?: {node:string;member:string|null};
  key: string;
  type?: string;
  detail?: NodeDetail | null;
  description?: NodeDescription | null;
  links: NodeLink[];
}

/** 收窄成"非 null、非数组的对象"（JSON 边界用）。 */
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** 收窄成数组（JSON 边界用；不引入 any）。 */
export const isArray = (value: unknown): value is unknown[] => Array.isArray(value);

/** 收窄成知识节点：key 是字符串、links 是数组——这正是检索层后续要用到的两处。 */
export const isKnowledgeNode = (value: unknown): value is KnowledgeNode =>
  isRecord(value) && typeof value.key === 'string' && isArray(value.links);

/** 失败原因的文本：与原写法 `cause?.message ?? cause` 同义，只是收成 string。 */
export const errorText = (cause: unknown): string => {
  const message = isRecord(cause) ? cause.message : undefined;
  return String(message ?? cause);
};

// Node 的类型里只有 ES2023（没有 DOM），WebAssembly 这个宿主全局在这里补上插件用到的
// 最小面：构造 Module、读自定义段。字面量类型与自定义段名的用法保持与 WebAssembly 一致。
declare global {
  namespace WebAssembly {
    class Module {
      constructor(bytes: Uint8Array);
      static customSections(module: Module, sectionName: string): ArrayBuffer[];
    }
  }
}
