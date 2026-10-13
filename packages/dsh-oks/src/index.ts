// dsh-oks —— DSH 能力扩展：把"某个领域的知识服务（OKS）"接成十六个原生工具。
// 插件不认识任何模型：开放哪个模型、模型在哪，由**会话所在工作区**根目录的 oks.json 声明
// （{"domain":"...","model":"...wasm","dataFile":"...sqlite"}）。
// 工作区是会话属性，所以一份插件能服务任意多工作区。
//
// 十六个工具：oks_search（按名词/说法在词汇表里找到 key）、
// oks_references（按 key 反向找到引用它的节点）、
// oks_info（按服务给出的不透明 key 读节点，入口是 key "index"）、
// oks_check_intent（只校验命名 Intent；通过的项给出该项的 key）、
// oks_query（核 key 后**只读查询**数据文件，成功项落盘、回结构回执；SQL/bindings 只在这一条路径上出现）、
// create_data（把 agent 自己给的数据落成一份封装——给定数据的唯一入口）、
// jq_transform（在具名输入上做加工：只看、不落盘）、
// jq_transform_into（同一套求值，结果物化成封装数据——新来源链由工具组装）、
// oks_chart（在服务端把图画成 SVG 存进工作区：只从一份封装取数，图自带绘图材料与来源链，
//   回执给出可直接粘进回答的引用）、
// oks_view（把数据变成展示件并落成 markdown：先支持表格；流里与报表里都能渲染）、
// oks_report（把 markdown 组装成自足的 HTML 报告：图与表内联，展示项的最终数据与完整来源链
//   并进页面里的报表级来源结构；缺件或超限整份失败）、
// 报告侧还有四个：oks_report_items（列出报告里的展示项）、
// oks_extract_report_data / _into（把某一项的最终数据取出来看 / 物化成普通封装）、
// oks_origin（摊开任何一份产出自带的来源链，只核对不重算）。
// oks_artifacts（列出这个工作区产出过什么）。
//
// **保留（pin）不在工具面里**：那是用户在右侧栏「产出」页签里点一下的动作（走插件自己的端点），
// agent 不需要知道这件事，也就不会被诱导"出完顺手钉一下"。

// 出图的 lowering 与渲染层也在这里导出：插件入口是单文件打包，导出它们便于单独测试，
// 对宿主没有影响（宿主只认 apply 与 inject）。
export { buildOption, CHART_WIDTH, plotHeight } from './chart/option.ts';
// 产物的命名规则也导出：它是对外可核对的约定（名字里那段 = 文件内容的 sha256 前 8 位），
// 冒烟按它断言，别的工具按它解析。
export { artifactName, NAME_MAX, resultStamp } from './results.ts';
// 产物自述的读写也导出：它是"产物自己说得清自己是什么"这条契约的实现，冒烟直接按它断言。
export { embedArtifactMeta, readArtifactMeta, saveArtifact } from './results.ts';
export { renderEchartsSvg } from './chart/echarts.ts';
export { buildFigureHtml, renderReportHtml } from './chart/report.ts';
export { renderMarkdown } from './chart/markdown.ts';
// 外加两个与模型无关的辅助工具：time_now（当前时刻的各种标准表示）、
// time_calc（日历代数：加减 / 对齐到日历边界 / 换时区）——服务不读时钟，相对时间
// 必须在提交前换成绝对边界；这两个工具只做标准表示，不解释任何领域格式。
// 第十三个是 va_ask：咨询一个**词汇助手**——插件自己建（顶层 agent，同工作区、同 preset）、
// 自己喂（**把整份词表渲染成一条提示词**，加上角色与回答方法）、自己收（每次拿到回答后把问答
// 从模型可见表面收回到标记点）；助手没有任何工具，每轮只看到「词汇 + 方法 + 标记 + 当前这个问题」，
// 会话日志保持 append-only。
//
// 词汇表与引用图：第一次用到检索时（三个检索出口都用这一份），插件按服务声明的**发现契约**
// （`<domain>/discovery` 声明 revision、入口 roots、每类 key 的 key 模式，以及哪些 kind 进
// 词汇表、每类词条的归属字段与必须非空的字段；沿 `info` 的引用图走完，再在本地派生）在内存里
// 建好词汇表与反向引用索引，之后整个进程按模型内容的 sha256 复用。索引里只有词汇与
// 引用边，不含节点内容——读节点始终由 oks_info 透传给服务。它不进模型上下文。
//
// **查询与加工的结果都落在内部材料目录**：查询写 `<时间>-<名字>-<内容哈希>.query.json`，
// 加工写 `<时间>-<名字>-<内容哈希>.transform.json`，agent 自填的输入数据写 `.data.json`——
// 数据只在这里，默认不进模型上下文，
// 要看形状或取数由 jq_transform 用表达式选，要留作下一步的输入由 jq_transform_into 物化。
// 每份封装自带 `{ origin, data }`：origin 是产生它的操作及完整上游来源链（节点表）。除此之外没有计划文件、没有缓存产物；
// 每次执行的 SQL、bindings、行数与耗时写进宿主日志（ctx.logger）。
//
// **代码里不写任何"地图长什么样"的假设**（有哪些种类、入口、字段、格式、路由、分页）：
// 那些是服务自己的声明，由 agent 按 key 自主探索。唯一的例外是服务自己声明的消费契约
// ——发现契约（入口、key 模式、词汇表）；检索层照它派生，对不上时直接报错，不静默降级。
//
// node 半边零依赖：直接注册原始工具定义，因此装在 profile 里或从工作区加载都不会有模块解析问题；
// 查询用 Node 自带的 node:sqlite（只读打开）。parameters 只用受支持的 JSON Schema
// 关键字子集，批次形状 / 名字校验与 key 比对放在 execute 里。

import { createKnowledge } from './knowledge.ts';
import { createTimeContext } from './time-context.ts';
import { createTools } from './tools.ts';
import { createVaRuntime } from './va.ts';
import { ARTIFACTS_ENDPOINT, createArtifactsEndpoint, createDownloadEndpoint, createPinEndpoint, DOWNLOAD_ENDPOINT, PIN_ENDPOINT } from './endpoint.ts';
import { pinBySrc } from './state.ts';

// 界面那条机械通道的两条路径（页签与插件约定同一对常量）。
export { ARTIFACTS_ENDPOINT, DOWNLOAD_ENDPOINT, PIN_ENDPOINT };
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

  // 界面用的一对同源端点：清单 + 保留（都是机械操作，不该经过 agent）。
  // 需要 web 服务才装配——没有 web 的部署里插件照常工作（这里就不装）。
  ctx.inject?.(['webServer'], (webCtx) => {
    const webServer = webCtx.get('webServer');
    if (webServer === undefined) return;
    const sessions = webCtx.get('sessions');
    const deps = {
      log,
      rootFor: (sessionId: string) => {
        const cwd = sessions?.get(sessionId)?.header?.cwd;
        if (typeof cwd !== 'string' || cwd.length === 0) {
          throw new Error(`找不到会话 ${sessionId} 的工作区目录`);
        }
        return cwd;
      },
      pin: pinBySrc,
    };
    webCtx.effect(() => webServer.register({
      kind: 'exact', path: ARTIFACTS_ENDPOINT, handler: createArtifactsEndpoint(deps),
    }));
    webCtx.effect(() => webServer.register({
      kind: 'exact', path: PIN_ENDPOINT, handler: createPinEndpoint(deps),
    }));
    webCtx.effect(() => webServer.register({
      kind: 'exact', path: DOWNLOAD_ENDPOINT, handler: createDownloadEndpoint(deps),
    }));
    log(`[oks] 面板端点已开：${ARTIFACTS_ENDPOINT} · ${PIN_ENDPOINT} · ${DOWNLOAD_ENDPOINT}`);
  });

  ctx.effect(() => knowledge.dispose);
}
