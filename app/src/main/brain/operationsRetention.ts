/**
 * M34（0063）：operations 操作账本保留策略纯函数，与 taskAuditRetention（M28 v10）同款纪律——
 * 规则全部写在这里，persist 只负责把待删行落库；SQLite 只在集成烟雾测试里碰（AGENTS.md 架构规则）。
 * 恢复快照查询（listDeletedSourceRecoveries）已走 WHERE action = 'DELETE_SOURCE' +
 * v7 idx_operations_action 索引，不在本刀射程；这里只管行数上限。
 */

/**
 * 全局行数上限：单人年使用量级——每 dispatch 一行，日均约 50 次 dispatch ≈ 1.8 万行/年，
 * 2 万行足以覆盖整年留痕（撤销/回放），再旧的属归档诉求，不留在热账本里（0063）。
 */
export const OPERATIONS_RETENTION_LIMIT = 20_000;

/**
 * 豁免 action（0063 裁决原文）：删除恢复依赖 DELETE_SOURCE 的快照 payload（恢复入口在它就在）、
 * 纠正留痕（CORRECT_CLAIM 关窗+禁写的操作证据，0006）、主键角色变更历史（SET_SOURCE_ROLE，0062）。
 * 豁免行占比失控属异常场景，不做二级兜底——上限兜住的是规模不是语义。
 */
export const OPERATIONS_EXEMPT_ACTIONS: readonly string[] = [
  'DELETE_SOURCE',
  'CORRECT_CLAIM',
  'SET_SOURCE_ROLE',
];

/** 库态行的最小形状：裁剪只看身份、action 与时间，不搬运 payload。 */
export interface OperationRow {
  id: string;
  action: string;
  createdAt: string;
}

/**
 * 库态裁剪：输入全部轻量行，返回待删行（调用方按 id 落 DELETE）。空数组 = 不动手。
 * 不变量——豁免行永不出结果集；恰好等于上限不动；被裁的一定是非豁免行中
 * (created_at, id) 最旧者（created_at 同值按 id 字典序破平，与任务审计的 (ts, seq) 同构）。
 */
export function pruneOperations(
  rows: OperationRow[],
  limit: number = OPERATIONS_RETENTION_LIMIT,
): OperationRow[] {
  if (rows.length <= limit) return [];
  const excess = rows.length - limit;
  const prunable = rows.filter((row) => !OPERATIONS_EXEMPT_ACTIONS.includes(row.action));
  const ordered = [...prunable].sort((a, b) =>
    a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1,
  );
  // 非豁免行不足 excess 时只裁到有为止：豁免集合优先于行数上限（0063）。
  return ordered.slice(0, excess);
}
