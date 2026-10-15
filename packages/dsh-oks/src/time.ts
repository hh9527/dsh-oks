// 会话上下文（时刻与时区）的读取与标准表示：零依赖，只用 Node 内置的 Intl。
//
// 这里**不涉及任何领域知识，也不假设知识服务声明了哪些时间格式**：它只做「某一时刻 ↔ 各种标准
// 表示」，以及"时区从哪来"。
//
// 设计约定（都是为了不产生静默误解）：
//   1. 所有"时刻"内部一律用 epoch 毫秒表示；时区只影响**表示**。
//   2. 时区按**插件规范**取：本次请求的上下文时区（当轮用户消息上的 source.clientTimeZone）；
//      没有或互相冲突（missing / mixed）时报错，让 agent 按规范的策略去问用户——不猜。
//   3. 日历运算（加减、对齐到日历边界）由求值器里的受控内建做（`tzadd` / `tzfloor` / `tzceil`，
//      见 crates/oks-wti）：时区显式传参，于是它进得了程序与来源链。

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

/** 上下文里要给出去的东西：**绝对值**（epoch 毫秒 + UTC 的 RFC 3339）与这个时区本身。
 *  墙钟由程序里的 `tzwall(zone)` 当场算。 */
export interface EncodedInstant {
  epochMillis: number;
  /** UTC 的 RFC 3339 文本（绝对时刻，没有时区歧义）。 */
  rfc3339: string;
  zone: string;
  offset: string;
  offsetMinutes: number;
}

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

/** 该时刻在给定时区里的日历字段——**只用来算偏移**（墙钟是程序的活：`tzwall(zone)` 当场算）。 */
interface WallParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const PARTS: Intl.DateTimeFormatOptions = {
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
};

function wallParts(epochMillis: number, zone: string): WallParts {
  const parts = new Intl.DateTimeFormat('en-US', { ...PARTS, timeZone: zone })
    .formatToParts(new Date(epochMillis));
  const pick = (type: string): number => {
    const found = parts.find((part) => part.type === type);
    if (found === undefined) throw new Error(`时区 ${zone} 没给出 ${type}`);
    return Number(found.value);
  };
  return {
    year: pick('year'), month: pick('month'), day: pick('day'),
    hour: pick('hour'), minute: pick('minute'), second: pick('second'),
  };
}

/** 该时刻在给定时区的 UTC 偏移（分钟）。 */
function offsetMinutes(epochMillis: number, zone: string): number {
  const p = wallParts(epochMillis, zone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(epochMillis / 1000) * 1000) / 60000);
}

function offsetText(minutes: number): string {
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  return `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** 一个时刻的完整表示：调用方据此挑选知识服务声明的那种形式。 */
function encode(epochMillis: number, zone: string): EncodedInstant {
  if (!Number.isFinite(epochMillis)) throw new Error(`not a finite instant: ${epochMillis}`);
  const minutes = offsetMinutes(epochMillis, zone);
  const at = new Date(epochMillis);
  const rfc3339 = `${at.getUTCFullYear()}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())}`
    + `T${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())}:${pad(at.getUTCSeconds())}Z`;
  return {
    epochMillis: Math.trunc(epochMillis),
    rfc3339,
    zone,
    offset: offsetText(minutes),
    offsetMinutes: minutes,
  };
}

export { deriveContextTimeZone, encode, resolveZone };
