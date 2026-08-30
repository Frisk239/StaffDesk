import type { DeskTask } from '@shared/types';
import type { ResearchRunOptions } from './engine';

const DAY_MS = 24 * 60 * 60 * 1000;

function parseDue(task: DeskTask): number {
  const raw = task.nextDueAt ?? task.createdAt;
  const parsed = parseStamp(raw);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function parseStamp(stamp: string): number {
  const match = stamp.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  if (!match) return Date.parse(stamp.replace(' ', 'T'));
  const [, y, m, d, h, min] = match;
  return new Date(Number(y), Number(m) - 1, Number(d), Number(h), Number(min)).getTime();
}

function formatStamp(ms: number): string {
  const d = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, '0');
  return [
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    `${pad(d.getHours())}:${pad(d.getMinutes())}`,
  ].join(' ');
}

function intervalMs(task: DeskTask): number {
  return Math.max(1, task.intervalDays ?? 1) * DAY_MS;
}

function latestDueWindow(task: DeskTask, now: number): { dueAt: string; missedRuns: number } {
  let dueMs = parseDue(task);
  if (dueMs <= 0) return { dueAt: task.nextDueAt ?? task.createdAt, missedRuns: 0 };
  const step = intervalMs(task);
  let missedRuns = 0;
  while (dueMs + step <= now) {
    dueMs += step;
    missedRuns += 1;
  }
  return { dueAt: formatStamp(dueMs), missedRuns };
}

export interface RadarRunPlan {
  radar: DeskTask;
  query: string | undefined;
  dueAt: string;
  late: boolean;
  missedRuns: number;
  options: ResearchRunOptions;
}

/** 彻底退出期间错过的周期只补最新一次。 */
export function latestDueRadar(tasks: DeskTask[], now = Date.now()): DeskTask | null {
  const due = dueRadars(tasks, now);
  return due[0] ?? null;
}

export function dueRadars(tasks: DeskTask[], now = Date.now()): DeskTask[] {
  return tasks
    .filter((t) => t.kind === '周期性雷达' && t.status !== '已停止')
    .filter((t) => parseDue(t) <= now)
    .sort((a, b) => parseDue(b) - parseDue(a));
}

export function planRadarRun(radar: DeskTask, now = Date.now()): RadarRunPlan {
  const dueMs = parseDue(radar);
  const late = dueMs > 0 && dueMs < now;
  const window = latestDueWindow(radar, now);
  const dueAt = late ? window.dueAt : (radar.nextDueAt ?? radar.createdAt);
  const missedRuns = late ? window.missedRuns : 0;
  return {
    radar,
    query: radar.query,
    dueAt,
    late,
    missedRuns,
    options: {
      kind: '再搜一轮',
      parentTaskId: radar.id,
      query: radar.query,
      dueAt,
      late,
      missedRuns,
    },
  };
}

export function lateAuditPayload(taskId: string): { taskId: string; late: true; note: string } {
  return { taskId, late: true, note: '迟跑：只补最新一次，中间周期记未跑' };
}
