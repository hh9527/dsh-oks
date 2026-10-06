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
//   6. 时区按**插件规范**取：本次请求的上下文时区（用户消息上的 source.clientTimeZone），
//      调用方也可以显式覆盖；两者都没有时报错，让 agent 按规范的策略去问用户
//      （mixed / missing → ask the user）。

import { isArray, isRecord } from './host.ts';
import type { ContextMessageLike } from './host.ts';

/** 上下文时区：按插件规范从**当轮用户消息**推导出的四态。 */
export type ContextTimeZone =
  | { kind: 'resolved'; timeZone: string }
  | { kind: 'mixed'; timeZones: string[] }
  | { kind: 'missing' }
  | { kind: 'invalid'; timeZone: string };

/** 时区来源：调用方显式给的，还是本次请求上下文带的。 */
export interface ResolvedZone {
  zone: string;
  source: string;
}

/** 一个时刻在一个时区里的日历字段。 */
export interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: string;
  weekdayIndex: number;
}

/** 一个时刻的完整标准表示。 */
export interface EncodedInstant {
  epochMillis: number;
  epochSeconds: number;
  zone: string;
  offsetMinutes: number;
  offset: string;
  utc: { text: string; rfc3339: string; date: string };
  local: { text: string; rfc3339: string; date: string; weekday: string; weekdayIndex: number };
  isoWeek: { weekYear: number; week: number; weekday: number };
}

/** applyOps 的状态：当前时刻 + 当前时区。 */
export interface TimeState {
  epochMillis: number;
  zone: string;
}

/** 一条日历运算。字段按 op 取用，多给的字段忽略。 */
export interface TimeOperation {
  op?: string;
  unit?: string;
  amount?: number;
  zone?: string;
  weekStartsOn?: number;
}

const PARTS: Intl.DateTimeFormatOptions = { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short', hourCycle: 'h23' };
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** 规范里的 IANA 形态：UTC 或 Area/Location。 */
const IANA_TIME_ZONE = /^[A-Za-z][A-Za-z0-9_+.-]*(?:\/[A-Za-z0-9_+.-]+)+$/;

/**
 * 按插件规范从**当轮用户消息**里推导浏览器时区（与 dsh-time-context 同一套字段与三态）：
 * 只认 source.kind === "user" 且带 rpcId 的消息上的 source.clientTimeZone。
 * 返回 {kind:"resolved",timeZone} | {kind:"mixed",timeZones} | {kind:"missing"} | {kind:"invalid",...}。
 * 规范里不合法是抛错；这里降级成可报告的态，让工具能给出"去问用户"的指引而不是打断回合。
 */
function deriveContextTimeZone(messages: unknown): ContextTimeZone {
  const zones = new Set<string>();
  for (const message of isArray(messages) ? messages : []) {
    const source = isRecord(message) ? message.source : undefined;
    if (!isRecord(source) || source.kind !== 'user' || typeof source.rpcId !== 'string') continue;
    const value = source.clientTimeZone;
    if (typeof value !== 'string') continue;
    if (value !== 'UTC' && !IANA_TIME_ZONE.test(value)) return { kind: 'invalid', timeZone: value };
    try {
      if (new Intl.DateTimeFormat('en-US', { timeZone: value }).resolvedOptions().timeZone !== value) {
        return { kind: 'invalid', timeZone: value };
      }
    } catch {
      return { kind: 'invalid', timeZone: value };
    }
    zones.add(value);
  }
  const sorted = [...zones].sort();
  if (sorted.length === 0) return { kind: 'missing' };
  if (sorted.length === 1) return { kind: 'resolved', timeZone: sorted[0] };
  return { kind: 'mixed', timeZones: sorted };
}

/** 校验并规范化 IANA 时区名；不合法就明确报错，不静默回退。 */
function assertZone(zone: unknown): string {
  if (typeof zone !== 'string' || zone.length === 0) throw new Error('time zone must be a non-empty IANA name');
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
  } catch (cause) {
    throw new Error(`unknown time zone: ${zone}`, { cause });
  }
  return zone;
}

/**
 * 时区从哪来：调用方显式给的 > **本次请求的上下文时区**（按插件规范从用户消息推导）。
 * 来源要一起报出去，便于在回答里写明口径。
 * 两者都没有时明确报错，并要求向用户澄清——这样"今天""上周"这类边界始终落在用户所在的时区里。
 */
function resolveZone(requested: unknown, context: ContextTimeZone | undefined): ResolvedZone {
  if (typeof requested === 'string' && requested.length > 0) {
    return { zone: assertZone(requested), source: 'argument' };
  }
  if (context?.kind === 'resolved') return { zone: assertZone(context.timeZone), source: 'context' };
  if (context?.kind === 'mixed') {
    throw new Error('dsh-oks: 本次请求带进来的浏览器时区不一致（' + context.timeZones.join(', ')
      + '）。按规范应向用户澄清用哪个时区，或显式传 timeZone。');
  }
  if (context?.kind === 'invalid') {
    throw new Error('dsh-oks: 本次请求带的浏览器时区不合法（' + String(context.timeZone)
      + '）。请向用户确认时区，或显式传 timeZone。');
  }
  throw new Error('dsh-oks: 本次请求没有带浏览器时区。请向用户确认时区后显式传入 timeZone，'
    + '或让请求带上浏览器时区——上下文时区按插件规范从用户消息读取。');
}

const pad = (value: unknown, width = 2): string => String(value).padStart(width, '0');

/** 该时刻在给定时区里的日历字段。 */
function localParts(epochMillis: number, zone: string): LocalParts {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, ...PARTS }).formatToParts(new Date(epochMillis));
  const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? '';
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
function offsetMinutes(epochMillis: number, zone: string): number {
  const p = localParts(epochMillis, zone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(epochMillis / 1000) * 1000) / 60000);
}

function offsetText(minutes: number): string {
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  return `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** 本地日历字段（当作 UTC 毫秒）→ 真实时刻。两趟修正，DST 也能落在一个有效时刻上。 */
function fromLocal(localMillis: number, zone: string): number {
  const guess = localMillis - offsetMinutes(localMillis, zone) * 60000;
  return localMillis - offsetMinutes(guess, zone) * 60000;
}

const localMillisOf = (epochMillis: number, zone: string): number =>
  epochMillis + offsetMinutes(epochMillis, zone) * 60000;

/** ISO-8601 周序号（周一起算），用于"第几周"这类表述。 */
function isoWeek(year: number, month: number, day: number): { weekYear: number; week: number; weekday: number } {
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
function encode(epochMillis: number, zone: string): EncodedInstant {
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

/** 解析调用方给的"某个时刻"：字符串按自身语法判定，不合语法就报错。 */
function parseMoment(value: unknown, zone: string): number {
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

function addCalendar(localMillis: number, unit: string, amount: number): number {
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

function floorCalendar(localMillis: number, unit: string, weekStartsOn: number): number {
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
function applyOps(state: TimeState, operations: unknown): { epochMillis: number; zone: string; applied: string[] } {
  let { epochMillis, zone } = state;
  const applied: string[] = [];
  for (const raw of isArray(operations) ? operations : []) {
    const op = String(isRecord(raw) ? raw.op ?? '' : '');
    if (op === 'convert') {
      zone = assertZone(String(isRecord(raw) ? raw.zone ?? '' : ''));
      applied.push(`convert → ${zone}`);
      continue;
    }
    if (op === 'add') {
      const unit = String(isRecord(raw) ? raw.unit ?? '' : '');
      const amount = Number(isRecord(raw) ? raw.amount : undefined);
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
      const unit = String(isRecord(raw) ? raw.unit ?? '' : '');
      if (!SNAPS.has(unit)) throw new Error(`${op} needs a unit in ${[...SNAPS].join('/')}`);
      const requested = isRecord(raw) ? raw.weekStartsOn : undefined;
      const rawWeekStartsOn = Number.isInteger(requested) ? Number(requested) : 0;
      const weekStartsOn = rawWeekStartsOn >= 1 && rawWeekStartsOn <= 7 ? rawWeekStartsOn : 1;
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

export { applyOps, assertZone, deriveContextTimeZone, encode, isoWeek, localParts, offsetMinutes, offsetText, parseMoment, resolveZone };
