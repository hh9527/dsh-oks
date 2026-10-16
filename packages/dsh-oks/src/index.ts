// dsh-oks —— DSH 能力扩展：把"某个领域的知识服务（OKS）"接成十九个原生工具。
// 插件不认识任何模型：开放哪个模型、模型在哪，由**会话所在工作区**根目录的 oks.json 声明
// （{"domain":"...","model":"...wasm","dataFile":"...sqlite"}）。
// 工作区是会话属性，所以一份插件能服务任意多工作区。
//
// 十九个工具：oks_search（按名词/说法在词汇表里找到 key）、
// oks_references（按 key 反向找到引用它的节点）、
// oks_info（按服务给出的不透明 key 读节点，入口是 key "index"）、
// oks_check_query_intent（只校验命名 Intent；通过的项给出该项的 key）、
// oks_exec_query_intent（核 key 后**只读查询**数据文件，成功项落盘、回结构回执；SQL/bindings 只在这一条路径上出现）、
// create_data（把 agent 自己给的数据落成一份封装——给定数据的唯一入口）、
// jq_transform（在具名输入上做加工：只看、不落盘；每个输入条目各带 root——jq 点路径，
//   默认 ".data" 是那份数据本身，".origin" 是来源链，"." 是整份 {meta, origin, data}；不写程序时
//   结果就是「名字 → 那一段」的对象，pick 再从结果里取回一段；要写表达式就把程序放 .work/*.jq、
//   参数 byFile 只给文件名——内层语言（jq）不与外层 JSON 的语法相邻，这是实测里整轮失败的主因）、
// jq_transform（同一套求值；给了 save 就把结果物化成封装数据——新来源链由工具组装）、
// oks_render_figure（按 spec.kind 出图或出表：出图时在服务端画成 SVG 存进工作区，只从一份封装取数，
//   图自带绘图材料与来源链；出表时落成 markdown，流里与报表里都能渲染；两者都给出可直接粘进回答的引用）、
// oks_render_report（把 markdown 组装成自足的 HTML 报告：图与表内联，展示项的最终数据与完整来源链
//   并进页面里的报表级来源结构；缺件或超限整份失败）、
// 读来源与读报告结构都不再另设工具：换一段 root 用 jq 投影即可。
// 代码区四个工具只作用在 .work/ 内：work_write（创建/覆盖）、work_read（按行读、"." 列目录）、
//   work_edit（字面替换）、work_delete（删一份文件）——jq 程序写在那里、由 byFile 按文件名引用。
//   宿主那三个通用文件工具的沙箱根是整个工作区，给不出"只能 .work/"这条边界，所以边界由插件
//   自己在执行层给出。
// oks_artifacts（列出这个工作区产出过什么）。
// 内部材料的回收由写路径自己保活，要立刻腾地方则用右侧栏「产出」页签的清理按钮（走插件自己的端点）；
// 窗口分 auto/manual 两套，配置在工作区 oks.json 的 retention 里。
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
export { renderMarkdown } from './chart/markdown.ts';
// 外加一个与模型无关的上下文工具：create_current_ctx_data —— 把当轮会话上下文（时刻与时区）
// **读一次**并落成 .oks/data/ 下的材料。服务不读时钟，求值器里也没有时钟：相对时间的绝对边界
// 只能由这份材料在 jq 里算出来（tzadd / tzfloor / tzceil），于是一组问题共用一个时间基准。
// 第十五个是 va_ask：咨询一个**词汇助手**——插件自己建（顶层 agent，同工作区、同 preset）、
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
// **查询与加工的结果都落在内部材料目录**：查询写 `<时间>-<名字>-<内容哈希>.qres.json`，
// 加工写 `<时间>-<名字>-<内容哈希>.tr.json`，agent 自填的输入数据写 `.def.json`——
// 数据只在这里，默认不进模型上下文，
// 要看形状或取数由 jq_transform 用表达式选，要留作下一步的输入就给它一个 save（物化成新的封装数据）。
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
import { disposeJaqEngine } from './jaq.ts';
import { createTimeContext } from './time-context.ts';
import { createTools } from './tools.ts';
import { PAYLOAD_MAX_BYTES } from './tools.ts';
import { createVaRuntime } from './va.ts';
import { ARTIFACTS_ENDPOINT, createArtifactsEndpoint, createDeleteEndpoint, createDownloadEndpoint,
  createCollectEndpoint, createPinEndpoint, COLLECT_ENDPOINT, DELETE_ENDPOINT, DOWNLOAD_ENDPOINT,
  PIN_ENDPOINT,
  sessionRootResolver } from './endpoint.ts';
import type { SessionPersistenceLike } from './endpoint.ts';
import type { LiveSessionsLike } from './endpoint.ts';
import { collectWithWindows, deleteArtifact, KEEP_ALIVE_MINUTES, markCleanup, pinByAsset } from './state.ts';

// 界面那条机械通道的两条路径（页签与插件约定同一对常量）。
export { ARTIFACTS_ENDPOINT, DOWNLOAD_ENDPOINT, PIN_ENDPOINT };
import type { LogFn, PluginContext } from './host.ts';
import { appendFileSync } from 'node:fs';
import { collectWindows, resolveSettings } from './config.ts';
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
    // **回执的大小闸门在所有工具上**：交回给模型的那一份超过上限时，数据留在文件里，
    // 交出去的是与数据接口同形状的合法 JSON 错误——数据本身不设上限（每份材料有自己的上限），
    // 把门的是"进模型上下文的这一份"。工具自己更精确的提示（如 jq_transform）在它内部先生效。
    const render = definition.output.render.bind(definition.output);
    // 超限时交出去的那句话按工具来：知识节点与工作区产物是两种东西，把"怎么取小一点"指错路比不说更糟。
    const oversizeHint = definition.name === 'oks_info'
      ? '回执太大，没有交给你。这是服务声明里的一个大节点：先用 oks_search 按 dataset / kind 把它下面的'
        + '成员列出来，再按 key 逐个读小节点。知识节点不在工作区里，jq_transform 读不到它。'
      : '回执太大，没有交给你。用更精确的取法再来一次：jq_transform 里用 pick 取一个字段，'
        + '或在 byFile 的程序里聚合与投影（length / group_by / map({…})）；'
        + '要整块数据就让它留在文件里，用 root 只取你要的那一段。'
        + '读报告（*.report.html）永远按项取：root 用 ".data.items.<项名>"、".data.structure"、'
        + '".origin"，不要一次取整份。';
    const dispose = ctx.tools.register({
      ...definition,
      output: {
        ...definition.output,
        render: (args, value) => {
          const blocks = render(args, value);
          const actualBytes = Buffer.byteLength(blocks.map((block) => block.text ?? '').join(''), 'utf8');
          if (actualBytes <= PAYLOAD_MAX_BYTES) return blocks;
          return [{
            type: 'text',
            text: JSON.stringify({
              ok: false,
              error: {
                code: 'payload_too_large',
                tool: definition.name,
                limitBytes: PAYLOAD_MAX_BYTES,
                actualBytes,
                hint: oversizeHint,
              },
            }),
          }];
        },
      },
    });
    if (typeof dispose === 'function') ctx.effect(() => dispose);
  }

  // 界面用的一对同源端点：清单 + 保留（都是机械操作，不该经过 agent）。
  // 需要 web 服务才装配——没有 web 的部署里插件照常工作（这里就不装）。
  ctx.inject?.(['webServer'], (webCtx) => {
    const webServer = webCtx.get('webServer');
    if (webServer === undefined) {
      // 不静默跳过：没有 web 服务时页签那五条端点不会注册，界面上表现为"读不到清单"——
      // 这一行就是解释，别让下次再从头猜。
      log('[oks] 这个部署没有 webServer 服务：产出页签的五条端点没有注册（工具面不受影响）');
      return;
    }
    const sessions = webCtx.get('sessions') as LiveSessionsLike | undefined;
    // 活会话表是首选；进程重启前建的会话靠宿主的会话持久化兜底（宿主的"工作区文件"面板同一条路）。
    // 解析不出来时明确报错，不去猜工作区——给错工作区比报错更难发现。
    // 兜底用宿主自己的会话持久化：活会话表落空时（例如重启前建的会话），宿主的"工作区文件"
    // 面板也是问它。**不再拿沙箱策略猜工作区**——那个值在 profile 级是启动目录，会给错答案。
    const sessionPersistence = webCtx.get('sessionPersistence') as SessionPersistenceLike | undefined;
    // 诊断时顺带看一眼活 agent 表（它持同一份会话头，用来核对"活表为什么没给 cwd"）。
    const agents = webCtx.get('agents') as { get?(id: string): { session?: { header?: { cwd?: unknown } } } | undefined } | undefined;
    const resolveRoot = sessionRootResolver({ sessions, persistence: sessionPersistence });
    /** 解析不出来时把各来源摊开记一行：这是"页签读不到清单"最需要的一条线索。 */
    const whyUnresolved = async (sessionId: string): Promise<string> => {
      const pick = (value: unknown): string => (value === undefined ? 'undefined' : String(value));
      const parts: string[] = [];
      parts.push(`sessions.cwd=${pick(sessions?.get?.(sessionId)?.header?.cwd)}`);
      parts.push(`agents.cwd=${pick(agents?.get?.(sessionId)?.session?.header?.cwd)}`);
      try {
        const stat = await sessionPersistence?.stat?.(sessionId);
        parts.push(`sessionPersistence.cwd=${pick(stat?.header?.cwd)}`);
      } catch (cause) {
        parts.push(`sessionPersistence.err=${String((cause as Error)?.message ?? cause).slice(0, 60)}`);
      }
      return parts.join(' · ');
    };
    const rootFor = async (sessionId: string): Promise<string> => {
      try {
        return await resolveRoot(sessionId);
      } catch (cause) {
        log(`[oks] 会话解析失败 · ${sessionId} · ${await whyUnresolved(sessionId)}`);
        throw cause;
      }
    };

    const deps = {
      log,
      rootFor,
      pin: pinByAsset,
      remove: deleteArtifact,
      // 报表窗口可配置：读不到声明（工作区没有 oks.json）时退回默认值，别让端点因此报错。
      keepAliveMinutes: (root: string) => {
        try {
          return resolveSettings(root, config).retention.auto.artifacts;
        } catch {
          return KEEP_ALIVE_MINUTES;
        }
      },
      // 页签那个按钮：按工作区配置的 manual 窗口清一次（材料 + 代码区）。
      collect: (root: string, ttl?: unknown) => {
        const manual = resolveSettings(root, config).retention.manual;
        // 页签下拉给的窗口（"30m" / "5m"）与工作区策略怎么合，见 config.ts 的 collectWindows。
        const outcome = collectWithWindows(root, collectWindows(manual, ttl));
        markCleanup(root, 'manual', outcome.removedMaterials + outcome.removedWork);
        return outcome;
      },
    };
    webCtx.effect(() => webServer.register({
      kind: 'exact', path: ARTIFACTS_ENDPOINT, handler: createArtifactsEndpoint(deps),
    }));
    webCtx.effect(() => webServer.register({
      kind: 'exact', path: PIN_ENDPOINT, handler: createPinEndpoint(deps),
    }));
    webCtx.effect(() => webServer.register({
      kind: 'exact', path: DELETE_ENDPOINT, handler: createDeleteEndpoint(deps),
    }));
    webCtx.effect(() => webServer.register({
      kind: 'exact', path: COLLECT_ENDPOINT, handler: createCollectEndpoint(deps),
    }));
    webCtx.effect(() => webServer.register({
      kind: 'exact', path: DOWNLOAD_ENDPOINT, handler: createDownloadEndpoint(deps),
    }));
    // 会话兜底用没用上是"重启后页签是否还会空"的关键，装好后第一行就该看见它。
    log(`[oks] 面板端点已开：${ARTIFACTS_ENDPOINT} · ${PIN_ENDPOINT} · ${DELETE_ENDPOINT}`
      + ` · ${COLLECT_ENDPOINT} · ${DOWNLOAD_ENDPOINT}`
      + `（会话兜底：${sessionPersistence === undefined ? '不可用' : '可用'}）`);
  });

  ctx.effect(() => knowledge.dispose);
  // 求值器是一个常驻 worker（第一次用 jq 时拉起）：卸载时收掉，别让它拖着事件循环。
  ctx.effect(() => disposeJaqEngine);
}
