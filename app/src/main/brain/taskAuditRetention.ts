import type { TaskAudit } from '@shared/types';

/**
 * M28 读路径债刀（0059 同门 v10）：task_audits 保留策略纯函数。
 * 审计是任务回放与「不悬空」的证据，只给活跃任务写，但每日雷达是唯一稳定增长入口——
 * 无界落库会让每次读账本都变贵。规则全部写在这里（纯函数），persist 只负责把裁剪结果落库；
 * SQLite 只在集成烟雾测试里碰（AGENTS.md 架构规则）。
 */

/** 每任务审计行上限：超限按 ts 序裁最旧（ts 同值按 seq 小者先裁）。 */
export const TASK_AUDIT_RETENTION_LIMIT = 500;

/**
 * 豁免行 kind：硬顶与失败类审计是「触顶入库 / 不悬空」纪律的最后一句证据，
 * 裁无期审计也不得裁掉它们（0049 触顶行为、0059 费用触顶）。
 * 引擎「停止」行携带终态原因，载荷 reason ∈ 本集合时同样豁免。
 */
export const TASK_AUDIT_EXEMPT_KINDS: readonly string[] = ['触顶', '费用触顶', '手动停止', '失败'];

/**
 * 内存态裁剪（先裁再落库）：返回引用相同表示无行可删（dispatch 脏判 fast-path 依赖）。
 * 不变量——豁免行永不出结果集；被裁的一定是非豁免行中 (ts, seq) 最旧者；
 * 恰好等于上限不动手。
 */
export function pruneTaskAudits(
  audits: TaskAudit[],
  limit: number = TASK_AUDIT_RETENTION_LIMIT,
): TaskAudit[] {
  const byTask = new Map<string, TaskAudit[]>();
  for (const audit of audits) {
    const list = byTask.get(audit.taskId) ?? [];
    list.push(audit);
    byTask.set(audit.taskId, list);
  }

  const doomed = new Set<TaskAudit>();
  for (const list of byTask.values()) {
    const excess = list.length - limit;
    if (excess <= 0) continue;
    // 稳定排序：ts 字典序（ISO）→ seq 数字序；只有旧→新数够 excess 个非豁免行才收手。
    const ordered = [...list].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.seq - b.seq));
    let dropped = 0;
    for (const audit of ordered) {
      if (dropped >= excess) break;
      if (isExemptAudit(audit)) continue;
      doomed.add(audit);
      dropped += 1;
    }
  }
  if (doomed.size === 0) return audits;
  return audits.filter((audit) => !doomed.has(audit));
}

/** 豁免判定：kind 直接命中；引擎「停止」行 reason=手动 ≡ 手动停止，其余终态原因原样命中。 */
function isExemptAudit(audit: TaskAudit): boolean {
  if (TASK_AUDIT_EXEMPT_KINDS.includes(audit.kind)) return true;
  if (audit.kind !== '停止') return false;
  const reason = (audit.payload as { reason?: unknown } | null)?.reason;
  if (typeof reason !== 'string') return false;
  if (reason === '手动') return true;
  return TASK_AUDIT_EXEMPT_KINDS.includes(reason);
}
