// 工具侧的日历方法：与自定义程序共用 Wasm 引擎，计算正文及参数进入来源链。
export const timeWindows = {
  description: 'Calendar windows from an explicit context() value. Returns oldest first; every window is [start,end), with label, zone, epochMillis and RFC3339 boundaries.',
  args: ['input', 'unit', 'count', 'mode'],
  source: `
    .[$args.input] as $ctx
    | $ctx.utc.epochMillis as $millis
    | if ($millis | type) != "number" then error("time windows requires context utc.epochMillis")
      elif ($millis | floor) != $millis or ($millis | fabs) > 9007199254740991 then error("utc.epochMillis must be a safe integer")
      else . end
    | $ctx.tz.client.id as $zone
    | if ($zone | type) != "string" then error("time windows requires context tz.client.id") else . end
    | ($millis / 1000) as $now
    | (if $args.mode == "rolling" then $now else ($now | tzfloor($args.unit; $zone)) end) as $anchor
    | (if $args.mode == "current" then 1 else 0 end) as $shift
    | def shifted($n): tzadd($args.unit; $n; $zone) | if $args.mode == "rolling" then . else tzfloor($args.unit; $zone) end;
      def boundary: {epochMillis: (. * 1000 | round), rfc3339: strftime_tz("%Y-%m-%dT%H:%M:%S%.f%:z"; $zone)};
      [range(0; $args.count) as $i
       | ($anchor | shifted($i - $args.count + $shift)) as $start
       | ($anchor | shifted($i - $args.count + $shift + 1)) as $end
       | {label: ($start | if $args.mode == "rolling" then strftime_tz("%Y-%m-%dT%H:%M:%S%.f%:z"; $zone)
           elif $args.unit == "year" then strftime_tz("%Y"; $zone)
           elif $args.unit == "quarter" then (gmtime_tz($zone) | "\\(.[0])-Q\\(((.[1] / 3) | floor) + 1)")
           elif $args.unit == "month" then strftime_tz("%Y-%m"; $zone)
           else strftime_tz("%Y-%m-%d"; $zone) end),
          zone: $zone, start: ($start | boundary), end: ($end | boundary)}]`,
};

export const timeHelp = {
  input: 'Define let ctx = context(); then let windows = time_windows(ctx, {unit,count,mode}); in the draft. The helper consumes utc.epochMillis and tz.client.id; no conversion or fixed-offset arithmetic is needed.',
  program: {src:'builtin://time/windows.jq', args:{input:'ctx (default)',unit:'year | quarter | month | week | day',count:'integer 1..50',mode:'required: complete | current | rolling'}},
  semantics: {
    complete: 'Last N completed calendar periods. Excludes the current period.',
    current: 'N calendar periods including the current period. The last end is the next calendar boundary, which can be in the future.',
    rolling: 'N consecutive calendar-length windows ending at the context instant. All boundaries are shifted directly from that instant; month ends are clamped. Preserves milliseconds.',
    boundaries: 'Every interval is [start,end); ordered oldest first. Week begins Monday. Time-zone rules apply separately at each boundary, including DST. label uses YYYY-MM, YYYY-Qn, YYYY or the start date; rolling labels use the start RFC3339.',
  },
  examples: {
    completeMonths: 'let ctx = context(); let months = time_windows(ctx, {unit:"month",count:3,mode:"complete"}); debug(months);',
    includingThisMonth: 'let months = time_windows(ctx, {unit:"month",count:3,mode:"current"});',
    completeWeeks: 'let weeks = time_windows(ctx, {unit:"week",count:4,mode:"complete"});',
    rollingMonth: 'let months = time_windows(ctx, {unit:"month",count:1,mode:"rolling"});',
  },
  primitives: {
    input: 'All primitive time functions take epoch seconds. Use context utc.epochSeconds, or convert epochMillis with / 1000.',
    floor: 'tzfloor(unit; zone) returns the first instant of the containing calendar period. Units: day/week/month/quarter/year.',
    ceil: 'tzceil(unit; zone) returns the first instant of the NEXT calendar period, including when input is already on a boundary. Same units as tzfloor.',
    add: 'tzadd(unit; amount; zone): calendar units year/quarter/month/week/day; duration units hour/minute/second.',
    inspect: 'strftime_tz("%Y-%m-%dT%H:%M:%S%.f%:z"; zone) provides a readable boundary for primitive calculations.',
  },
};

export function timeWindowCode(src: string, rawArgs: unknown): {file:string;text:string} {
  if (rawArgs === null || (rawArgs !== undefined && (typeof rawArgs !== 'object' || Array.isArray(rawArgs)))) throw new Error('jq.args must be an object');
  const args: Record<string, unknown> = {input:'ctx', ...rawArgs as Record<string, unknown>};
  for (const key of Object.keys(args)) if (!timeWindows.args.includes(key)) throw new Error(`Unknown time window argument: ${key}`);
  if (typeof args.input !== 'string' || args.input === '') throw new Error('time windows input must be a load name');
  if (typeof args.unit !== 'string' || !['year','quarter','month','week','day'].includes(args.unit)) throw new Error('time windows unit must be year/quarter/month/week/day');
  if (!Number.isSafeInteger(args.count) || Number(args.count) < 1 || Number(args.count) > 50) throw new Error('time windows count must be 1..50');
  if (typeof args.mode !== 'string' || !['complete','current','rolling'].includes(args.mode)) throw new Error('time windows mode must be complete/current/rolling');
  return {file:src,text:`${JSON.stringify(args)} as $args | ${timeWindows.source}`};
}
