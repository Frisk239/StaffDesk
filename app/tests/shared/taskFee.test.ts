import { describe, expect, it } from 'vitest';
import {
  MISSING_USAGE_NOTE,
  emptyFeeSpend,
  feeAuditPayload,
  formatTokenCount,
  latestTaskTokenTotal,
  parseFeePayload,
  recordFeeSpend,
} from '../../src/shared/taskFee';

describe('任务费用累计（ADR 0059）', () => {
  it('有 usage 则累加 prompt 与 completion，不折金额', () => {
    const first = recordFeeSpend(emptyFeeSpend(), { promptTokens: 10, completionTokens: 2 });
    const second = recordFeeSpend(first, { promptTokens: 5, completionTokens: 1 });
    expect(second).toEqual({
      promptTokens: 15,
      completionTokens: 3,
      totalTokens: 18,
      missingUsageCalls: 0,
      lastMissingUsage: false,
    });
  });

  it('usage 缺失不得当 0，计入调用次数近似并标注原文', () => {
    const missing = recordFeeSpend(emptyFeeSpend(), undefined);
    expect(missing.totalTokens).toBe(0);
    expect(missing.missingUsageCalls).toBe(1);
    expect(missing.lastMissingUsage).toBe(true);
    expect(feeAuditPayload(missing).note).toBe(MISSING_USAGE_NOTE);
  });

  it('空花费是用户手发 chat 的豁免口径：不调用 record 则预算仍为 0', () => {
    expect(emptyFeeSpend().totalTokens).toBe(0);
    expect(emptyFeeSpend().missingUsageCalls).toBe(0);
  });

  it('任务行用量格式化为 k token', () => {
    expect(formatTokenCount(500)).toBe('500 token');
    expect(formatTokenCount(12300)).toBe('12.3k token');
  });

  it('从费用审计行读取最新累计 token', () => {
    const total = latestTaskTokenTotal(
      [
        {
          taskId: 't1',
          seq: 1,
          kind: '费用',
          payload: feeAuditPayload(
            recordFeeSpend(emptyFeeSpend(), { promptTokens: 8, completionTokens: 2 }),
          ),
          ts: '2026-09-01T00:00:00.000Z',
        },
        {
          taskId: 't1',
          seq: 2,
          kind: '费用',
          payload: {
            promptTokens: 20,
            completionTokens: 4,
            totalTokens: 24,
            missingUsageCalls: 0,
          },
          ts: '2026-09-01T00:00:01.000Z',
        },
      ],
      't1',
    );
    expect(total).toBe(24);
    expect(parseFeePayload({ promptTokens: 1, completionTokens: 1 })).toBeNull();
  });
});
