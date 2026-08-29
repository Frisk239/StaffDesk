import type { DeskTask } from '@shared/types';

const DAY_MS = 24 * 60 * 60 * 1000;

/** 彻底退出期间错过的周期只补最新一次。 */
export function latestDueRadar(tasks: DeskTask[], now = Date.now()): DeskTask | null {
  const radars = tasks
    .filter((t) => t.kind === '周期性雷达')
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const latest = radars[0];
  if (!latest) return null;
  const created = Date.parse(latest.createdAt.replace(' ', 'T'));
  if (Number.isNaN(created)) return latest;
  if (now - created < DAY_MS) return null;
  return latest;
}

export function lateAuditPayload(taskId: string): { taskId: string; late: true; note: string } {
  return { taskId, late: true, note: '迟跑：只补最新一次，中间周期记未跑' };
}
