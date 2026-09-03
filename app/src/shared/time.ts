/** 持久层时间：完整 ISO UTC。展示转用户本地；比较/排序用 epoch，不用格式化串。 */

const NAIVE_RE = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/;
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function utcIso(ms: number = Date.now()): string {
  return new Date(ms).toISOString();
}

export function isNaiveDateTime(stamp: string): boolean {
  return NAIVE_RE.test(stamp.trim());
}

export function parseStampMs(stamp: string): number {
  const trimmed = stamp.trim();
  if (!trimmed) return Number.NaN;
  if (DATE_ONLY_RE.test(trimmed)) return Date.parse(`${trimmed}T00:00:00.000Z`);
  if (/[zZ]$/.test(trimmed) || /[+-]\d{2}:\d{2}$/.test(trimmed)) return Date.parse(trimmed);
  const naive = trimmed.match(NAIVE_RE);
  if (naive) {
    const [, date, hour, minute, second] = naive;
    return Date.parse(`${date}T${hour}:${minute}:${second ?? '00'}.000Z`);
  }
  return Date.parse(trimmed);
}

export function addDaysUtc(stamp: string, days: number): string {
  const parsed = parseStampMs(stamp);
  const base = Number.isNaN(parsed) ? Date.now() : parsed;
  return utcIso(base + days * 24 * 60 * 60 * 1000);
}

function part(parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): string {
  return parts.find((item) => item.type === type)?.value ?? '';
}

export function formatLocalDateTime(stamp: string, timeZone?: string): string {
  const trimmed = stamp.trim();
  if (isNaiveDateTime(trimmed) && timeZone === undefined) {
    const match = trimmed.match(NAIVE_RE);
    if (!match) return trimmed;
    const [, date, hour, minute] = match;
    return `${date} ${hour}:${minute}`;
  }
  const ms = parseStampMs(trimmed);
  if (Number.isNaN(ms)) return stamp;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(ms));
  return `${part(parts, 'year')}-${part(parts, 'month')}-${part(parts, 'day')} ${part(parts, 'hour')}:${part(parts, 'minute')}`;
}

export function formatLocalTime(stamp: string, timeZone?: string): string {
  const ms = parseStampMs(stamp);
  if (Number.isNaN(ms)) return stamp;
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(ms));
}

export function compareStamp(a: string, b: string): number {
  return parseStampMs(a) - parseStampMs(b);
}

export function isStampOverdue(due: string, nowMs: number = Date.now()): boolean {
  const dueMs = parseStampMs(due);
  return !Number.isNaN(dueMs) && dueMs <= nowMs;
}
