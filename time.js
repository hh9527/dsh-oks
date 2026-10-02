// 纯时间计算：零依赖，只用 Node 内置的 Intl。
//
// 这里**不涉及任何领域知识，也不假设知识服务声明了哪些时间格式**：它只做
// 「某一时刻 ↔ 各种标准表示」与「日历运算」，调用方自己挑要用哪一种表示。
//
// 设计约定（都是为了不产生静默误解）：
//   1. 所有"时刻"内部一律用 epoch 毫秒表示；时区只影响**表示**与**日历运算**。
//   2. 无时区后缀的文本（"YYYY-MM-DD HH:MM:SS" 或 "YYYY-MM-DD"）按**传入时区的本地时间**解释；
//      带 Z 或 ±hh:mm 的 RFC 3339 文本是绝对时刻。
//   3. day/week 这类"日历单位"的加减保持**本地墙钟**（跨 DST 时一天可能不是 24 小时）；
//      hour/minute/second 是精确时长。
//   4. month/quarter/year 加减按日历钳制（1 月 31 日 + 1 月 = 2 月 28/29 日）。
//   5. 区间一律半开 [start, end)：调用方用两次计算得到两端。
//   6. 时区必须由**调用方**或**插件行声明**给出，**绝不使用宿主时区兜底**——那会把时间边界
//      静默算错；两者都没有时报错，让 agent 去问用户或去声明。

const PARTS = { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short', hourCycle: 'h23' };
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** 校验并规范化 IANA 时区名；不合法就明确报错，不静默回退。 */
function assertZone(zone) {
  if (typeof zone !== 'string' || zone.length === 0) throw new Error('time zone must be a non-empty IANA name');
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
  } catch (cause) {
    throw new Error(`unknown time zone: ${zone}`, { cause });
  }
  return zone;
}

/**
 * 时区从哪来：调用方显式给的 > 插件行声明的。来源要一起报出去，便于在回答里写明口径。
 * 这里**故意没有宿主时区兜底**：宿主时区与用户所在的时区无关，用它算"今天""上周"会静默偏掉。
 */
function resolveZone(requested, configured) {
  if (typeof requested === 'string' && requested.length > 0) {
    return { zone: assertZone(requested), source: 'argument' };
  }
  if (typeof configured === 'string' && configured.length > 0) {
    return { zone: assertZone(configured), source: 'config' };
  }
  throw new Error(
    'dsh-oks: 没有可用的时区。时区只能来自调用参数 timeZone，或插件行 config.timeZone 的声明；'
    + '本插件不使用宿主时区兜底（宿主时区与用户所在时区无关，会把时间边界静默算错）。'
    + '请向用户确认时区后显式传入，或在 profile 的插件行声明它。',
  );
}

const pad = (value, width = 2) => String(value).padStart(width, '0');

/** 该时刻在给定时区里的日历字段。 */
function localParts(epochMillis, zone) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, ...PARTS }).formatToParts(new Date(epochMillis));
  const get = (type) => parts.find((part) => part.type === type)?.value ?? '';
  const weekday = get('weekday');
  const index = WEEKDAYS.indexOf(weekday);
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour: Number(get('hour')),
    minute: Number(get('minute')),
    second: Number(get('second')),
    weekday,
    weekdayIndex: index < 0 ? 1 : index + 1, // 1=周一 … 7=周日
  };
}

/** 该时刻在给定时区的 UTC 偏移（分钟）。 */
function offsetMinutes(epochMillis, zone) {
  const p = localParts(epochMillis, zone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(epochMillis / 1000) * 1000) / 60000);
}

function offsetText(minutes) {
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  return `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** 本地日历字段（当作 UTC 毫秒）→ 真实时刻。两趟修正，DST 也能落在一个有效时刻上。 */
function fromLocal(localMillis, zone) {
  const guess = localMillis - offsetMinutes(localMillis, zone) * 60000;
  return localMillis - offsetMinutes(guess, zone) * 60000;
}

const localMillisOf = (epochMillis, zone) => epochMillis + offsetMinutes(epochMillis, zone) * 60000;

/** ISO-8601 周序号（周一起算），用于"第几周"这类表述。 */
function isoWeek(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  const weekday = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - weekday);
  const yearStart = Date.UTC(date.getUTCFullYear(), 0, 1);
  return {
    weekYear: date.getUTCFullYear(),
    week: Math.ceil(((date.getTime() - yearStart) / 86400000 + 1) / 7),
    weekday,
  };
}

/** 一个时刻的完整表示：调用方据此挑选知识服务声明的那种形式。 */
function encode(epochMillis, zone) {
  if (!Number.isFinite(epochMillis)) throw new Error(`not a finite instant: ${epochMillis}`);
  const p = localParts(epochMillis, zone);
  const offset = offsetMinutes(epochMillis, zone);
  const text = `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}`;
  const date = `${p.year}-${pad(p.month)}-${pad(p.day)}`;
  const uptc = localParts(epochMillis, 'UTC');
  const utcText = `${uptc.year}-${pad(uptc.month)}-${pad(uptc.day)} ${pad(uptc.hour)}:${pad(uptc.minute)}:${pad(uptc.second)}`;
  const utcDate = `${uptc.year}-${pad(uptc.month)}-${pad(uptc.day)}`;
  return {
    epochMillis: Math.trunc(epochMillis),
    epochSeconds: Math.floor(epochMillis / 1000),
    zone,
    offsetMinutes: offset,
    offset: offsetText(offset),
    utc: {
      text: utcText,
      rfc3339: `${utcDate}T${utcText.slice(11)}Z`,
      date: utcDate,
    },
    local: {
      text,
      rfc3339: `${date}T${text.slice(11)}${offsetText(offset)}`,
      date,
      weekday: p.weekday,
      weekdayIndex: p.weekdayIndex,
    },
    isoWeek: isoWeek(p.year, p.month, p.day),
  };
}

/** 解析调用方给的"某个时刻"。字符串按自身语法判定，绝不猜。 */
function parseMoment(value, zone) {
  if (value === undefined || value === null || value === 'now') return Date.now();
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`not a finite instant: ${value}`);
    return Math.trunc(value); // 约定：数字一律是 epoch 毫秒
  }
  if (typeof value !== 'string') throw new Error(`unsupported instant: ${JSON.stringify(value)}`);
  const text = value.trim();
  const absolute = /^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.(\d{1,3}))?(Z|z|[+-]\d{2}:?\d{2})$/.exec(text);
  if (absolute !== null) {
    const ms = Date.parse(text.replace(' ', 'T'));
    if (!Number.isFinite(ms)) throw new Error(`unparsable instant: ${value}`);
    return ms;
  }
  const local = /^(\d{4})-(\d{2})-(\d{2})(?:[Tt ](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(text);
  if (local === null) {
    throw new Error(`unparsable instant: ${JSON.stringify(value)}（要 epoch 毫秒、RFC 3339，或 "YYYY-MM-DD[ HH:MM[:SS]]"）`);
  }
  const [, y, mo, d, h = '0', mi = '0', s = '0'] = local;
  const localMillis = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
  return fromLocal(localMillis, zone);
}

const UNITS = new Set(['year', 'quarter', 'month', 'week', 'day', 'hour', 'minute', 'second']);
const SNAPS = new Set(['year', 'quarter', 'month', 'week', 'day']);

function addCalendar(localMillis, unit, amount) {
  const at = new Date(localMillis);
  const year = at.getUTCFullYear();
  const month = at.getUTCMonth();
  const day = at.getUTCDate();
  if (unit === 'year') {
    at.setUTCFullYear(year + amount);
  } else if (unit === 'quarter') {
    at.setUTCMonth(month + amount * 3);
  } else if (unit === 'month') {
    const target = month + amount;
    at.setUTCDate(1);
    at.setUTCMonth(target);
    const lastDay = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 0)).getUTCDate();
    at.setUTCDate(Math.min(day, lastDay)); // 钳制：1/31 + 1 月 = 2/28 或 2/29
  } else {
    at.setUTCDate(day + amount); // day（week 在调用处已折算成 7 天）
  }
  return at.getTime();
}

function floorCalendar(localMillis, unit, weekStartsOn) {
  const at = new Date(localMillis);
  const year = at.getUTCFullYear();
  const month = at.getUTCMonth();
  const day = at.getUTCDate();
  if (unit === 'year') return Date.UTC(year, 0, 1);
  if (unit === 'quarter') return Date.UTC(year, Math.floor(month / 3) * 3, 1);
  if (unit === 'month') return Date.UTC(year, month, 1);
  if (unit === 'week') {
    const weekday = at.getUTCDay() || 7; // 1=周一 … 7=周日
    const shift = (weekday - weekStartsOn + 7) % 7;
    return Date.UTC(year, month, day - shift);
  }
  return Date.UTC(year, month, day); // day
}

/**
 * 按顺序施加一串运算。state = { epochMillis, zone }，运算可以换时区。
 * op：
 *   {op:"add",   unit, amount}                日历加减（负数即减）
 *   {op:"floor", unit, weekStartsOn?}         向下取整到日历边界（默认周一）
 *   {op:"ceil",  unit, weekStartsOn?}         向上取整（已对齐则不动）
 *   {op:"convert", zone}                      换时区（时刻不变）
 */
function applyOps(state, operations) {
  let { epochMillis, zone } = state;
  const applied = [];
  for (const raw of Array.isArray(operations) ? operations : []) {
    const op = String(raw?.op ?? '');
    if (op === 'convert') {
      zone = assertZone(String(raw?.zone ?? ''));
      applied.push(`convert → ${zone}`);
      continue;
    }
    if (op === 'add') {
      const unit = String(raw?.unit ?? '');
      const amount = Number(raw?.amount);
      if (!UNITS.has(unit)) throw new Error(`add needs a unit in ${[...UNITS].join('/')}`);
      if (!Number.isFinite(amount)) throw new Error('add needs a finite numeric amount');
      if (unit === 'hour' || unit === 'minute' || unit === 'second') {
        const factor = unit === 'hour' ? 3600000 : unit === 'minute' ? 60000 : 1000;
        epochMillis += amount * factor; // 精确时长
      } else {
        const step = unit === 'week' ? 7 : 1;
        const local = addCalendar(localMillisOf(epochMillis, zone), unit === 'week' ? 'day' : unit, amount * step);
        epochMillis = fromLocal(local, zone);
      }
      applied.push(`add ${amount} ${unit}`);
      continue;
    }
    if (op === 'floor' || op === 'ceil') {
      const unit = String(raw?.unit ?? '');
      if (!SNAPS.has(unit)) throw new Error(`${op} needs a unit in ${[...SNAPS].join('/')}`);
      const weekStartsOn = Number.isInteger(raw?.weekStartsOn) && raw.weekStartsOn >= 1 && raw.weekStartsOn <= 7
        ? raw.weekStartsOn
        : 1;
      const local = localMillisOf(epochMillis, zone);
      const floored = floorCalendar(local, unit, weekStartsOn);
      let target = floored;
      if (op === 'ceil' && floored < local) {
        target = unit === 'week'
          ? addCalendar(floored, 'day', 7)
          : addCalendar(floored, unit, 1);
      }
      epochMillis = fromLocal(target, zone);
      applied.push(`${op} ${unit}${unit === 'week' ? `(weekStartsOn=${weekStartsOn})` : ''}`);
      continue;
    }
    throw new Error(`unsupported operation: ${JSON.stringify(raw)}`);
  }
  return { epochMillis, zone, applied };
}

export { applyOps, assertZone, encode, isoWeek, localParts, offsetMinutes, offsetText, parseMoment, resolveZone };
