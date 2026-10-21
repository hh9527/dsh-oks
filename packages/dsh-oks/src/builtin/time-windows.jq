# 基于显式时间上下文生成日历窗口；每个区间为 [start,end)。

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
           elif $args.unit == "quarter" then (gmtime_tz($zone) | "\(.[0])-Q\(((.[1] / 3) | floor) + 1)")
           elif $args.unit == "month" then strftime_tz("%Y-%m"; $zone)
           else strftime_tz("%Y-%m-%d"; $zone) end),
          zone: $zone, start: ($start | boundary), end: ($end | boundary)}]
