// dsh-oks —— DSH 能力扩展：把"某个领域的知识服务（OKS）"接成七个原生工具。
// 插件不认识任何模型：开放哪个模型、模型在哪，由**会话所在工作区**根目录的 oks.json 声明
// （{"domain":"...","artifact":"...wasm","dataFile":"...sqlite"}）。
// 工作区是会话属性，所以一份插件能服务任意多工作区。
//
// 八个工具：oks_search（按名词/说法在词汇表里找到 key）、
// oks_references（按 key 反向找到引用它的节点）、
// oks_info（按服务给出的不透明 key 读节点，入口是 key "index"）、
// oks_check_intent（只校验结构化 Intent，只回诊断）、
// oks_query（校验后**只读查询**数据文件，回结果；SQL/bindings 只在这一条路径上出现）。
// 外加两个与模型无关的辅助工具：time_now（当前时刻的各种标准表示）、
// time_calc（日历代数：加减 / 对齐到日历边界 / 换时区）——服务不读时钟，相对时间
// 必须在提交前换成绝对边界；这两个工具只做标准表示，不解释任何领域格式。
// 第八个是 va_ask：咨询一个**词汇助手**——插件自己建（顶层 agent，同工作区、同 preset）、
// 自己喂（**把整份词表渲染成一条提示词**，加上角色与回答方法）、自己收（每次拿到回答后把问答
// 从模型可见表面收回到标记点）；助手没有任何工具，每轮只看到「词汇 + 方法 + 标记 + 当前这个问题」，
// 会话日志保持 append-only。
//
// 词汇表与引用图：第一次用到检索时（三个检索出口都用这一份），插件按服务声明的**发现契约**
// （`<domain>/discovery` 声明 revision、入口 roots、每类 key 的 key 模式，以及哪些 kind 进
// 词汇表、每类词条的归属字段与必须非空的字段；沿 `info` 的引用图走完，再在本地派生）在内存里
// 建好词汇表与反向引用索引，之后整个进程按产物的 artifact_sha256 复用。索引里只有词汇与
// 引用边，不含节点内容——读节点始终由 oks_info 透传给服务。它不写工作区、也不进模型上下文。
//
// **插件在工作区里不写任何东西**：没有计划文件、没有缓存产物。每次执行的 SQL、bindings、
// 行数与耗时写进宿主日志（ctx.logger），工作区保持干净。
//
// **代码里不写任何"地图长什么样"的假设**（有哪些种类、入口、字段、格式、路由、分页）：
// 那些是服务自己的声明，由 agent 按 key 自主探索。唯一的例外是服务自己声明的消费契约
// ——发现契约（入口、key 模式、词汇表）；检索层照它派生，对不上时直接报错，不静默降级。
//
// 零依赖：直接注册原始工具定义，因此装在 profile 里或从工作区加载都不会有模块解析问题；
// 查询用 Node 自带的 node:sqlite（只读打开）。parameters 只用受支持的 JSON Schema
// 关键字子集，数量校验放在 execute 里。

import { createKnowledge } from './knowledge.ts';
import { createTimeContext } from './time-context.ts';
import { createTools } from './tools.ts';
import { createVaRuntime } from './va.ts';
import type { LogFn, PluginContext } from './host.ts';
import type { PluginConfig } from './config.ts';

export const inject = ['tools'];

export function apply(ctx: PluginContext, config: PluginConfig = {}): void {
  const log: LogFn = (message) => {
    try {
      const logger = ctx.logger;
      if (logger?.info) logger.info(message);
      else console.error(message);
    } catch {
      console.error(message);
    }
  };

  const timeContext = createTimeContext({ ctx, log });
  timeContext.install();

  const knowledge = createKnowledge({ ctx, log, config });

  const va = createVaRuntime({ ctx, log, config, knowledge });

  const definitions = createTools({ knowledge, va, timeContext, log, config });
  for (const definition of definitions) {
    const dispose = ctx.tools.register(definition);
    if (typeof dispose === 'function') ctx.effect(() => dispose);
  }

  ctx.effect(() => knowledge.dispose);
}
