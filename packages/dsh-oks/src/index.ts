// Workspace-scoped ontology tools. oks.json declares the model and readonly data file.
// work_* edits DARI drafts; oks_run_answer evaluates them; oks_data reads retained outputs.
// oks_data reads facts and declared capabilities from oks://knowledge; va_ask normalizes vocabulary.
// Reports archive evidence and code; the artifacts panel manages retention and pinning.

export { createProjector } from './project.ts';
export type { JsonValue, ProjectRule, Projector } from './project.ts';
export { buildOption, CHART_WIDTH, plotHeight } from './chart/option.ts';
export { artifactName, NAME_MAX, resultStamp } from './results.ts';
export { embedArtifactMeta, readArtifactMeta, saveArtifact } from './results.ts';
export { renderEchartsSvg } from './chart/echarts.ts';
export { renderMarkdown } from './chart/markdown.ts';

import { createKnowledge } from './knowledge.ts';
import { disposeJaqEngine } from './jaq.ts';
import { createTimeContext } from './time-context.ts';
import { createTools } from './tools.ts';
import { withOutputLimit } from './payload.ts';
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
  ctx.effect(() => definitions.dispose);
  for (const definition of definitions) {
    const dispose = ctx.tools.register(withOutputLimit(definition));
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
