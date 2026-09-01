import { describe, expect, it } from 'vitest';
import type { TaskAudit } from '@shared/types';
import {
  pruneTaskAudits,
  TASK_AUDIT_RETENTION_LIMIT,
} from '../../src/main/brain/taskAuditRetention';

function audit(
  taskId: string,
  seq: number,
  kind: string,
  ts: string,
  payload: unknown = {},
): TaskAudit {
  return { taskId, seq, kind, payload, ts };
}

function ts(n: number): string {
  return new Date(Date.parse('2026-08-30T00:00:00.000Z') + n * 1000).toISOString();
}

describe('任务审计保留策略（内存态裁剪）', () => {
  it('未达上限不动：返回同一引用', () => {
    const audits = [
      audit('t1', 1, '搜索', ts(1)),
      audit('t1', 2, '打开', ts(2)),
      audit('t2', 1, '开始', ts(3)),
    ];
    expect(pruneTaskAudits(audits, 5)).toBe(audits);
    expect(pruneTaskAudits(audits, TASK_AUDIT_RETENTION_LIMIT)).toBe(audits);
  });

  it('恰好等于上限不动：返回同一引用', () => {
    const audits = [
      audit('t1', 1, '搜索', ts(1)),
      audit('t1', 2, '打开', ts(2)),
      audit('t1', 3, '停止', ts(3), { reason: '完成' }),
    ];
    expect(pruneTaskAudits(audits, 3)).toBe(audits);
  });

  it('超限裁最旧非豁免行，较新的普通行留下', () => {
    const audits = [
      audit('t1', 1, '开始', ts(1)),
      audit('t1', 2, '搜索', ts(2)),
      audit('t1', 3, '打开', ts(3)),
      audit('t1', 4, '搜索结果', ts(4)),
    ];
    const pruned = pruneTaskAudits(audits, 2);
    expect(pruned).not.toBe(audits);
    expect(pruned).toEqual([audit('t1', 3, '打开', ts(3)), audit('t1', 4, '搜索结果', ts(4))]);
  });

  it('豁免行保住：触顶 / 费用触顶 / 手动停止 / 失败，以及停止行携带这些终态原因', () => {
    const audits = [
      audit('t1', 1, '触顶', ts(1)),
      audit('t1', 2, '费用触顶', ts(2)),
      audit('t1', 3, '手动停止', ts(3)),
      audit('t1', 4, '失败', ts(4)),
      audit('t1', 5, '停止', ts(5), { reason: '手动' }),
      audit('t1', 6, '停止', ts(6), { reason: '触顶' }),
      audit('t1', 7, '停止', ts(7), { reason: '费用触顶' }),
      audit('t1', 8, '停止', ts(8), { reason: '失败' }),
      audit('t1', 9, '搜索', ts(9)),
      audit('t1', 10, '打开', ts(10)),
      audit('t1', 11, '搜索结果', ts(11)),
    ];
    const pruned = pruneTaskAudits(audits, 8);
    expect(pruned.map((row) => row.seq).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(pruned.some((row) => row.kind === '搜索')).toBe(false);
  });

  it('按任务分别计数：一任务超限不影响另一任务', () => {
    const audits = [
      audit('t1', 1, '开始', ts(1)),
      audit('t1', 2, '搜索', ts(2)),
      audit('t1', 3, '打开', ts(3)),
      audit('t2', 1, '开始', ts(4)),
      audit('t2', 2, '搜索', ts(5)),
    ];
    const pruned = pruneTaskAudits(audits, 2);
    expect(pruned.filter((row) => row.taskId === 't1').map((row) => row.seq)).toEqual([2, 3]);
    expect(pruned.filter((row) => row.taskId === 't2')).toEqual(
      audits.filter((row) => row.taskId === 't2'),
    );
  });
});
