import { applyOps, encode, parseMoment, resolveZone } from './time.js';
import { capLine } from './text.js';
import { OBJECT_OUTPUT, renderCheck, renderJson, renderQuery, renderValue, withoutQueries } from './response.js';
import { REFERENCE_KINDS, referencesOf, renderReferences, renderSearch, renderVocabulary, searchIndex, vocabularyPage } from './retrieval.js';
import { renderAsk, VA_HELPER_PREFIX } from './va.js';

export function createTools({ knowledge, va, timeContext, log, config }) {
  /** 降一批 Intent。服务只在整批通过时才回 queries，所以被拒批次里没有报 Error 的子集
   *  会再提交一次——这样"5 个里坏了 1 个"仍能拿到其余 4 个的执行物。 */
  const lowerBatch = async (entry, intents, signal) => {
    const method = `${entry.settings.domain}/transform`;
    const trace = [];
    const response = await entry.runner.send(method, { intents }, signal);
    trace.push({ method, request: { intents }, response });
    const diagnostics = Array.isArray(response?.ok?.diagnostics) ? response.ok.diagnostics : [];
    const errors = new Set(diagnostics
      .filter((item) => item?.diagnostic?.severity === 'Error')
      .map((item) => item.index));
    let batch = null;
    let subset = null;
    if (response?.ok?.accepted === true && Array.isArray(response?.ok?.queries)) {
      batch = { response, intents, indexes: intents.map((_intent, index) => index) };
    } else if (entry.settings.retryAcceptedSubset !== false) {
      const indexes = intents.map((_intent, index) => index).filter((index) => !errors.has(index));
      if (indexes.length > 0 && indexes.length < intents.length) {
        const subsetIntents = indexes.map((index) => intents[index]);
        const retry = await entry.runner.send(method, { intents: subsetIntents }, signal);
        trace.push({ method, request: { intents: subsetIntents }, response: retry, note: '仅未报 Error 的子集，再降一次' });
        const passed = retry?.ok?.accepted === true && Array.isArray(retry?.ok?.queries);
        subset = { indexes, accepted: passed };
        if (passed) batch = { response: retry, intents: subsetIntents, indexes };
      }
    }
    return { method, trace, response, diagnostics, batch, subset };
  };

  const arityError = (method, intents, toolName) => ({
    trace: [{
      method,
      request: { intents },
      response: { error: true, diagnostics: [{ message: `${toolName} requires one to five independent Intents` }] },
    }],
    intents,
    diagnostics: [{ index: 0, diagnostic: { severity: 'Error', message: `${toolName} requires one to five independent Intents` } }],
  });

  // 工具描述在注册时写死，此时还不知道任何工作区，所以文本里不出现领域名。
  // 设计约束：**这里也不写任何"地图长什么样"的假设**。工具描述只说协议（怎么打交道）
  // 与呈现（收到什么就原样给什么）；具体有哪些种类、入口、字段、格式、路由、分页，
  // 一律由服务自己的声明回答——模型换了形状，这里一行都不用改。
  const definitions = [
    {
      name: 'oks_info',
      description: 'Read one knowledge node of this workspace\'s knowledge service by its opaque string key. Start with key "index" — the one key you may supply from memory; it tells you where to go next. From there, follow the keys the service returns, whatever shape it declares, and copy each key verbatim: never construct, split or decode one. Use only the canonical IDs the service declares when writing Intents; display names and physical column names are not substitutes.',
      parameters: {
        type: 'object',
        properties: {
          key: {
            type: 'string',
            description: 'Opaque knowledge key, copied verbatim from what the service returned — another node, a link, or a diagnostic. "index" is the one key you may supply from memory.',
          },
        },
        required: ['key'],
        additionalProperties: false,
      },
      output: { schema: OBJECT_OUTPUT, render: renderJson },
      async execute(args, exec) {
        const entry = knowledge.ensureWorkspace(exec);
        const method = `${entry.settings.domain}/info`;
        const request = args?.key !== undefined && args?.key !== null ? { key: args.key } : null;
        if (request === null) {
          return {
            trace: [{
              method,
              request: {},
              response: { error: true, diagnostics: [{ message: 'oks_info needs a knowledge key' }] },
            }],
          };
        }
        const response = await entry.runner.send(method, request, exec?.signal);
        return { trace: [{ method, request, response }] };
      },
    },
    {
      name: 'oks_search',
      description: 'Find this workspace\'s knowledge vocabulary by name, alias or description and get what you need to address a node: its kind, its name, its owner, where the term matched and how well. Keys are not returned — compose the key with the pattern the service declares for that kind in index.detail.key_patterns, then read the node with oks_info. Use it when you know what a thing is called but not its key; narrow with kind= or dataset=, and page with skip=.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Words to look for in a term\'s name, aliases or description. Matching is case-insensitive and splits camelCase and separators; every word must appear somewhere in the term. Omit it to list everything the filters allow.',
          },
          kind: { type: 'string', description: 'Restrict to one kind of term. The kinds that are discoverable are declared by the knowledge service of this workspace; a kind outside that declaration is rejected with the declared list.' },
          dataset: { type: 'string', description: 'Restrict to terms whose declared owner "dataset" is this one.' },
          skip: { type: 'number', description: 'Start at this match (default 0). The response reports how many matches remain, so page with skip = start + matched.length.' },
        },
        additionalProperties: false,
      },
      output: { schema: OBJECT_OUTPUT, render: renderSearch },
      async execute(args, exec) {
        const entry = knowledge.ensureWorkspace(exec);
        const index = await knowledge.ensureIndex(entry);
        const result = searchIndex(index, args);
        log(`[oks] search query=${JSON.stringify(args?.query ?? '')} kind=${args?.kind ?? '-'}`
          + ` dataset=${args?.dataset ?? '-'} skip=${result.start} → ${result.total} 命中 · 返回 ${result.matched.length}`
          + `${result.more === null ? '' : ` · 还有 ${result.more}`}`);
        return result;
      },
    },
    {
      name: 'oks_vocabulary',
      description: 'Page through the entire vocabulary of this workspace\'s knowledge service: every term with its kind, its declared owner, all of its aliases and a short description, in a fixed order. Paging with skip= therefore never repeats or drops a term; one page is bounded by bytes and a term is never split across pages. This tool serves the vocabulary helper that va_ask runs: it answers only inside that helper\'s session, where it is called page by page to load the whole vocabulary. In a work session, look terms up with oks_search and read them with oks_info.',
      parameters: {
        type: 'object',
        properties: {
          skip: {
            type: 'number',
            description: 'Start at this term in the fixed order (default 0). Each page reports how many terms remain, so page with skip = start + entries.length.',
          },
        },
        additionalProperties: false,
      },
      output: { schema: OBJECT_OUTPUT, render: renderVocabulary },
      async execute(args, exec) {
        const sessionId = exec?.agent?.session?.id;
        if (typeof sessionId !== 'string' || !sessionId.startsWith(VA_HELPER_PREFIX)) {
          throw new Error('dsh-oks: 整份词汇只交给词汇助手（va_ask 起的那个会话）；工作会话里找词用 oks_search，读节点用 oks_info。');
        }
        const entry = knowledge.ensureWorkspace(exec);
        const index = await knowledge.ensureIndex(entry);
        const result = vocabularyPage(index, args);
        log(`[oks] vocabulary skip=${result.start} → ${result.total} 条 · 返回 ${result.entries.length}`
          + `${result.more === null ? '' : ` · 还有 ${result.more}`}`);
        return result;
      },
    },
    {
      name: 'oks_references',
      description: 'List what references a knowledge key, from the reference graph the plugin derives when the vocabulary is built. Each row names the reference kind and the referencing node\'s key, so you can read that node with oks_info or follow it further. Use it to see what depends on a term before you change how you address it.',
      parameters: {
        type: 'object',
        properties: {
          key: {
            type: 'string',
            description: 'A knowledge key that exists in this artifact — composed from the declared key patterns, or taken verbatim from what a node returned.',
          },
          link: { type: 'string', enum: REFERENCE_KINDS, description: 'Restrict to one reference kind.' },
          kind: { type: 'string', description: 'Restrict to referencing nodes of one kind. The kinds that are discoverable are declared by the knowledge service of this workspace.' },
          skip: { type: 'number', description: 'Start at this reference (default 0).' },
        },
        required: ['key'],
        additionalProperties: false,
      },
      output: { schema: OBJECT_OUTPUT, render: renderReferences },
      async execute(args, exec) {
        const entry = knowledge.ensureWorkspace(exec);
        const index = await knowledge.ensureIndex(entry);
        const result = referencesOf(index, args);
        log(`[oks] references key=${result.key} link=${args?.link ?? '-'} kind=${args?.kind ?? '-'}`
          + ` skip=${result.start} → ${result.total} 条 · 返回 ${result.references.length}`);
        return result;
      },
    },
    {
      name: 'oks_check_intent',
      description: 'Validate one to five independent graph Intents against this workspace\'s knowledge model and report the diagnostics. Nothing is executed and no query text comes back — this is the cheap way to find out whether a batch is acceptable. All Intents are checked even if one fails, and the subset without Error diagnostics is checked again so a partially bad batch still tells you which members are good. On rejection, read the diagnostics and repair the Intent with its business meaning intact.',
      parameters: {
        type: 'object',
        properties: {
          intents: {
            type: 'array',
            description: 'One to five independent graph Intents, e.g. {"op":"Graph","root":"d","nodes":[{"id":"d","entity":"<dataset id>"}],"edges":[],"select":[],"count":"d"}. Closed Intent choices use the declared enum spelling in PascalCase (e.g. op "Graph", filter op "Eq", direction "Desc", row_grain "Root"); the entity is the declared dataset id, not the knowledge key. The service also declares the authoritative Intent syntax — read it from the knowledge nodes it points you to instead of relying on memory.',
            items: { type: 'object', additionalProperties: true },
          },
        },
        required: ['intents'],
        additionalProperties: false,
      },
      output: { schema: OBJECT_OUTPUT, render: renderCheck },
      async execute(args, exec) {
        const entry = knowledge.ensureWorkspace(exec);
        const intents = Array.isArray(args?.intents) ? args.intents : [];
        const method = `${entry.settings.domain}/transform`;
        if (intents.length < 1 || intents.length > 5) return arityError(method, intents, 'oks_check_intent');
        const { trace, response, diagnostics, batch, subset } = await lowerBatch(entry, intents, exec?.signal);
        return {
          trace: trace.map((step) => ({ ...step, response: withoutQueries(step.response) })),
          intents,
          accepted: response?.ok?.accepted === true,
          diagnostics,
          subset,
          queryCount: Array.isArray(batch?.response?.ok?.queries) ? batch.response.ok.queries.length : 0,
        };
      },
    },
    {
      name: 'oks_query',
      description: 'Answer a business question from this workspace\'s data: validate one to five independent graph Intents, then run the accepted ones as read-only queries against the data file the workspace declares, returning the rows together with the statement and bindings that produced them. A rejected Intent returns diagnostics instead of rows. Use oks_check_intent first when you only want to iterate on the Intent shape.',
      parameters: {
        type: 'object',
        properties: {
          intents: {
            type: 'array',
            description: 'One to five independent graph Intents, same shape as oks_check_intent accepts.',
            items: { type: 'object', additionalProperties: true },
          },
        },
        required: ['intents'],
        additionalProperties: false,
      },
      output: { schema: OBJECT_OUTPUT, render: renderQuery },
      async execute(args, exec) {
        const entry = knowledge.ensureWorkspace(exec);
        const intents = Array.isArray(args?.intents) ? args.intents : [];
        const method = `${entry.settings.domain}/transform`;
        if (intents.length < 1 || intents.length > 5) {
          return { ...arityError(method, intents, 'oks_query'), results: [], dataFile: entry.settings.dataFile ?? null };
        }
        const { trace, response, diagnostics, batch } = await lowerBatch(entry, intents, exec?.signal);
        const answers = {
          trace,
          intents,
          accepted: response?.ok?.accepted === true,
          diagnostics,
          results: [],
          dataFile: entry.settings.dataFile ?? null,
          window: null,
          queryMaxRows: entry.settings.queryMaxRows,
        };
        if (batch === null) return answers;

        const { executor, manifest } = knowledge.executorFor(entry.settings);
        answers.window = manifest?.window ?? null;
        const queries = batch.response?.ok?.queries ?? [];
        for (let at = 0; at < queries.length; at += 1) {
          const query = queries[at];
          const index = batch.indexes[at] ?? at;
          const sql = String(query?.sql ?? '');
          const bindings = Array.isArray(query?.bindings) ? query.bindings : [];
          const started = Date.now();
          try {
            const outcome = await executor.send(sql, bindings, exec?.signal);
            const ms = Date.now() - started;
            answers.results.push({
              index, sql, bindings, rows: outcome.rows, truncated: outcome.truncated, error: null, ms,
            });
            // 执行留痕进宿主日志：模型可见面之外唯一能查到"跑了什么"的地方。
            log(`[oks] query intent#${index + 1} → ${outcome.rows.length}${outcome.truncated ? '+' : ''} row(s)`
              + ` · ${ms} ms · sql=${capLine(sql.replace(/\s+/g, ' '), 200)}`
              + ` · bindings=${capLine(JSON.stringify(bindings), 200)}`);
          } catch (cause) {
            const ms = Date.now() - started;
            const message = String(cause?.message ?? cause);
            answers.results.push({ index, sql, bindings, rows: null, truncated: false, error: message, ms });
            log(`[oks] query intent#${index + 1} failed after ${ms} ms: ${message}`);
          }
        }
        return answers;
      },
    },
    {
      name: 'time_now',
      description: 'Read the current instant from the host clock in several standard forms — epoch milliseconds and seconds, UTC text, RFC 3339, local text with its UTC offset, calendar date, and ISO week. The knowledge service never reads the clock, so every relative expression ("last week", "the last 24 hours") has to become an absolute boundary before it is submitted: resolve it here, state the time zone you used, and pick whichever form the knowledge node itself declares. This tool knows nothing about domain time formats.',
      parameters: {
        type: 'object',
        properties: {
          timeZone: {
            type: 'string',
            description: 'IANA time zone such as "Asia/Shanghai". By default the zone comes from the request context — the browser zone the client attached to the current turn messages, read per the plugin spec — so pass one only to override it (for example when the context zone is mixed or missing). The zone comes from the request context or from this argument; with neither, the call fails and asks you to confirm it with the user. The source actually used is echoed back.',
          },
        },
        additionalProperties: false,
      },
      output: { schema: OBJECT_OUTPUT, render: renderValue },
      async execute(args, exec) {
        const { zone, source } = resolveZone(args?.timeZone, timeContext.zones.get(exec?.agent?.session));
        return { timeZone: zone, timeZoneSource: source, ...encode(Date.now(), zone) };
      },
    },
    {
      name: 'time_calc',
      description: 'Apply ordered calendar arithmetic to an instant and return every standard form of the result: add (year/quarter/month/week/day/hour/minute/second), floor/ceil to a calendar boundary (weeks start on Monday unless weekStartsOn is given), and convert between time zones. Day and week arithmetic keeps the local wall clock, so a day across a daylight-saving change is not always 24 hours; month/quarter/year addition clamps to the last valid day. Intervals are half-open [start, end), so compute both ends. base accepts "now" (the default), epoch milliseconds as a number, RFC 3339 text, or zone-less text "YYYY-MM-DD[ HH:MM[:SS]]" read as local time in the given zone.',
      parameters: {
        type: 'object',
        properties: {
          base: {
            oneOf: [{ type: 'string' }, { type: 'number' }],
            description: '"now" (default), epoch milliseconds as a number, RFC 3339 text, or zone-less "YYYY-MM-DD[ HH:MM[:SS]]" read as local time in timeZone.',
          },
          timeZone: {
            type: 'string',
            description: 'IANA time zone such as "Asia/Shanghai". By default the zone comes from the request context — the browser zone the client attached to the current turn messages, read per the plugin spec — so pass one only to override it (for example when the context zone is mixed or missing). The zone comes from the request context or from this argument; with neither, the call fails and asks you to confirm it with the user. The source actually used is echoed back.',
          },
          operations: {
            type: 'array',
            description: 'Applied in order, e.g. {"op":"add","unit":"month","amount":-1}, {"op":"floor","unit":"week","weekStartsOn":1}, {"op":"ceil","unit":"day"}, {"op":"convert","zone":"UTC"}.',
            items: { type: 'object', additionalProperties: true },
          },
        },
        additionalProperties: false,
      },
      output: { schema: OBJECT_OUTPUT, render: renderValue },
      async execute(args, exec) {
        const { zone, source } = resolveZone(args?.timeZone, timeContext.zones.get(exec?.agent?.session));
        const base = parseMoment(args?.base, zone);
        const result = applyOps({ epochMillis: base, zone }, args?.operations);
        return {
          timeZone: result.zone,
          timeZoneSource: source,
          base: { input: args?.base ?? 'now', ...encode(base, zone) },
          operations: result.applied,
          ...encode(result.epochMillis, result.zone),
        };
      },
    },
    {
      name: 'va_ask',
      description: 'Consult this session\'s vocabulary helper and get its answer back: send one paraphrase — a word, a phrase or a sentence, any language — and you receive the vocabulary\'s equivalent or near expressions, each with the dimension it differs on. The helper reads the whole vocabulary once, so the first call sets it up and takes longer; each later call is one question. Treat what it returns as leads: look the strings up with oks_search and read the declarations with oks_info.',
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
      async execute(args, exec) {
        const query = typeof args?.query === 'string' ? args.query.trim() : '';
        if (query.length === 0) throw new Error('dsh-oks: va_ask 需要一个说法（query）。');
        const caller = exec?.agent;
        if (typeof caller?.session?.id === 'string' && caller.session.id.startsWith(VA_HELPER_PREFIX)) {
          throw new Error('dsh-oks: 词汇助手不咨询自己。');
        }
        const key = caller?.session?.id;
        if (typeof key !== 'string' || key.length === 0) {
          throw new Error('dsh-oks: 无法确定调用方会话，va_ask 需要它来记住词汇助手。');
        }
        return va.ask(caller, key, query, exec?.signal);
      },
    },
  ];

  return definitions;
}
