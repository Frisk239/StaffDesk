import { describe, expect, it } from 'vitest';
import {
  addDaysUtc,
  compareStamp,
  formatLocalDateTime,
  isStampOverdue,
  parseStampMs,
  utcIso,
} from '@shared/time';

describe('时间语义：持久 UTC、展示本地、比较用 epoch', () => {
  it('utcIso 写出带 Z 的完整 ISO', () => {
    expect(utcIso(Date.parse('2026-09-03T06:23:00.000Z'))).toBe('2026-09-03T06:23:00.000Z');
  });

  it('UTC 展示保持 UTC 墙钟', () => {
    expect(formatLocalDateTime('2026-09-03T06:23:00.000Z', 'UTC')).toBe('2026-09-03 06:23');
  });

  it('UTC+8 展示加八小时，并跨日', () => {
    expect(formatLocalDateTime('2026-09-03T16:30:00.000Z', 'Asia/Shanghai')).toBe(
      '2026-09-04 00:30',
    );
    expect(formatLocalDateTime('2026-09-03T06:23:00.000Z', 'Asia/Shanghai')).toBe(
      '2026-09-03 14:23',
    );
  });

  it('遗留无时区戳原样展示，不当成本地再转一次', () => {
    expect(formatLocalDateTime('2026-09-01 09:00')).toBe('2026-09-01 09:00');
  });

  it('到期比较用 epoch，不混本地 nowStamp 与 UTC 切片', () => {
    const storedUtcSlice = '2026-09-03 06:23';
    const nowShanghai = Date.parse('2026-09-03T06:23:00.000Z');
    expect(isStampOverdue(storedUtcSlice, nowShanghai)).toBe(true);
    expect(isStampOverdue('2026-09-03T06:24:00.000Z', nowShanghai)).toBe(false);
    const localNowStamp = '2026-09-03 14:23';
    expect(storedUtcSlice <= localNowStamp).toBe(true);
    expect(isStampOverdue('2026-09-03T14:23:00.000Z', nowShanghai)).toBe(false);
  });

  it('排序按真实时间，不按格式化字符串', () => {
    const iso = '2026-09-01T08:00:00.000Z';
    const naiveLater = '2026-09-01 09:00';
    expect(compareStamp(iso, naiveLater)).toBeLessThan(0);
    expect(iso.localeCompare(naiveLater)).toBeGreaterThan(0);
  });

  it('雷达加日在 UTC 上前进，不随本地时区漂', () => {
    expect(addDaysUtc('2026-09-03T16:00:00.000Z', 1)).toBe('2026-09-04T16:00:00.000Z');
    expect(parseStampMs(addDaysUtc('2026-09-03 06:23', 1))).toBe(
      Date.parse('2026-09-04T06:23:00.000Z'),
    );
  });
});
