import type { TaskAudit } from './types';

/** 任务审计 kind：累计 token。回放按此渲染，payload 不含密钥。 */
export const FEE_AUDIT_KIND = '费用';

/** ADR 0059：端点不回传 usage 时审计行必须出现的原文。 */
export const MISSING_USAGE_NOTE = '端点未回传 usage';

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
}

export interface TaskFeeSpend {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  missingUsageCalls: number;
  lastMissingUsage: boolean;
}

export interface TaskFeePayload {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  missingUsageCalls: number;
  sourceId?: string | undefined;
  note?: string | undefined;
}

export function emptyFeeSpend(): TaskFeeSpend {
  return {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    missingUsageCalls: 0,
    lastMissingUsage: false,
  };
}

/**
 * ADR 0059：有 usage 则累加 prompt+completion；缺失不得当 0，计入调用次数近似。
 * 只有任务抽取路径调用；用户手发 chat 不走这里。
 */
export function recordFeeSpend(spend: TaskFeeSpend, usage: TokenUsage | undefined): TaskFeeSpend {
  if (!usage) {
    return {
      ...spend,
      missingUsageCalls: spend.missingUsageCalls + 1,
      lastMissingUsage: true,
    };
  }
  return {
    promptTokens: spend.promptTokens + usage.promptTokens,
    completionTokens: spend.completionTokens + usage.completionTokens,
    totalTokens: spend.totalTokens + usage.promptTokens + usage.completionTokens,
    missingUsageCalls: spend.missingUsageCalls,
    lastMissingUsage: false,
  };
}

export function feeAuditPayload(
  spend: TaskFeeSpend,
  sourceId?: string | undefined,
): TaskFeePayload {
  const payload: TaskFeePayload = {
    promptTokens: spend.promptTokens,
    completionTokens: spend.completionTokens,
    totalTokens: spend.totalTokens,
    missingUsageCalls: spend.missingUsageCalls,
  };
  if (sourceId) payload.sourceId = sourceId;
  if (spend.lastMissingUsage) payload.note = MISSING_USAGE_NOTE;
  return payload;
}

export function parseFeePayload(payload: unknown): TaskFeePayload | null {
  if (!payload || typeof payload !== 'object') return null;
  const row = payload as Record<string, unknown>;
  const promptTokens = asNonNegInt(row.promptTokens);
  const completionTokens = asNonNegInt(row.completionTokens);
  const totalTokens = asNonNegInt(row.totalTokens);
  const missingUsageCalls = asNonNegInt(row.missingUsageCalls);
  if (
    promptTokens === undefined ||
    completionTokens === undefined ||
    totalTokens === undefined ||
    missingUsageCalls === undefined
  ) {
    return null;
  }
  const parsed: TaskFeePayload = {
    promptTokens,
    completionTokens,
    totalTokens,
    missingUsageCalls,
  };
  if (typeof row.sourceId === 'string' && row.sourceId) parsed.sourceId = row.sourceId;
  if (typeof row.note === 'string' && row.note) parsed.note = row.note;
  return parsed;
}

export function formatTokenCount(n: number): string {
  if (!Number.isFinite(n) || n < 1000) return `${Math.max(0, Math.floor(n || 0))} token`;
  return `${(n / 1000).toFixed(1)}k token`;
}

export function latestTaskTokenTotal(audits: TaskAudit[], taskId: string): number | undefined {
  const feeRows = audits
    .filter((audit) => audit.taskId === taskId && audit.kind === FEE_AUDIT_KIND)
    .sort((a, b) => a.seq - b.seq);
  const last = feeRows.at(-1);
  if (!last) return undefined;
  return parseFeePayload(last.payload)?.totalTokens;
}

function asNonNegInt(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined;
  return Math.floor(value);
}
