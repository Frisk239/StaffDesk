import type { Action } from '@shared/actions';
import type { State, TaskAudit } from '@shared/types';
import { addDaysUtc, formatLocalDateTime, parseStampMs, utcIso } from '@shared/time';
import { maybeEnqueuePrimarySuggestions, nextId } from './actionHelpers';

// 任务与雷达域 reducer 分支：调研任务状态与审计去重追加、周期雷达排程（时间族走 shared/time）。

function nextRadarDueAfter(
  task: { nextDueAt?: string | undefined; intervalDays?: number | undefined },
  afterIso: string,
): string {
  const interval = Math.max(1, task.intervalDays ?? 1);
  let due = task.nextDueAt ?? afterIso;
  let guard = 0;
  while (parseStampMs(due) <= parseStampMs(afterIso) && guard < 370) {
    due = addDaysUtc(due, interval);
    guard += 1;
  }
  return due;
}

function taskAuditKey(audit: TaskAudit): string {
  return `${audit.taskId}\0${audit.seq}`;
}

function appendTaskAudits(existing: TaskAudit[], incoming: TaskAudit[]): TaskAudit[] {
  const seen = new Set(existing.map(taskAuditKey));
  const fresh = incoming.filter((audit) => {
    const key = taskAuditKey(audit);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return fresh.length > 0 ? [...existing, ...fresh] : existing;
}

export function taskActions(state: State, action: Action): State | undefined {
  switch (action.type) {
    case 'TASK_RUN_STARTED': {
      const object = state.objects.find((item) => item.id === action.task.objectId);
      if (!object) return state;
      const task = { ...action.task, status: '进行中' as const };
      delete task.stopReason;
      const exists = state.tasks.some((item) => item.id === task.id);
      const tasks = exists
        ? state.tasks.map((item) => (item.id === task.id ? task : item))
        : [...state.tasks, task];
      return {
        ...state,
        seq: state.seq + 1,
        tasks,
        toast: {
          text: task.kind === '再搜一轮' ? '再搜一轮已开始' : '调研已开始',
          id: state.seq + 1,
        },
      };
    }

    case 'TASK_AUDIT_APPENDED': {
      if (!state.tasks.some((task) => task.id === action.taskId)) return state;
      const incoming = action.audits.filter((audit) => audit.taskId === action.taskId);
      const taskAudits = appendTaskAudits(state.taskAudits, incoming);
      return taskAudits === state.taskAudits ? state : { ...state, taskAudits };
    }

    case 'TASK_STOP_REQUESTED': {
      const task = state.tasks.find((item) => item.id === action.taskId);
      if (!task) {
        return {
          ...state,
          seq: state.seq + 1,
          toast: { text: '没有这条任务', id: state.seq + 1 },
        };
      }
      if (task.status !== '进行中') {
        return {
          ...state,
          seq: state.seq + 1,
          toast: { text: '任务已经结束', id: state.seq + 1 },
        };
      }
      return {
        ...state,
        seq: state.seq + 1,
        tasks: state.tasks.map((item) =>
          item.id === action.taskId
            ? { ...item, status: '已停止' as const, stopReason: '手动' as const }
            : item,
        ),
        toast: { text: '正在停止任务', id: state.seq + 1 },
      };
    }

    case 'CREATE_RADAR': {
      const object = state.objects.find((item) => item.id === action.objectId);
      if (!object) return state;
      const existing = state.tasks.find(
        (task) =>
          task.objectId === action.objectId &&
          task.kind === '周期性雷达' &&
          task.status !== '已停止',
      );
      if (existing) {
        return {
          ...state,
          toast: { text: '这个对象已有每日雷达', id: state.seq },
          seq: state.seq + 1,
        };
      }
      const [taskId, seq] = nextId(state, 'task');
      const createdAt = utcIso();
      const intervalDays = Math.max(1, action.intervalDays ?? 1);
      const nextDueAt = addDaysUtc(createdAt, intervalDays);
      const task = {
        id: taskId,
        objectId: action.objectId,
        kind: '周期性雷达' as const,
        status: '待启动' as const,
        budgetGear: action.budgetGear ?? '快搜',
        query: action.query?.trim() || `${object.name} 官方 介绍`,
        intervalDays,
        nextDueAt,
        createdAt,
      };
      return {
        ...state,
        seq,
        tasks: [...state.tasks, task],
        taskAudits: [
          ...state.taskAudits,
          {
            taskId,
            seq: 1,
            kind: '计划',
            payload: { intervalDays, nextDueAt, query: task.query },
            ts: new Date().toISOString(),
          },
        ],
        toast: { text: `已创建每日雷达，下次 ${formatLocalDateTime(nextDueAt)}`, id: seq },
      };
    }

    case 'APPLY_RESEARCH': {
      const existingIds = new Set(state.sources.map((s) => s.id));
      const incoming = action.sources.filter((s) => !existingIds.has(s.id));
      const parentTaskId = action.task.parentTaskId;
      const existingTask = state.tasks.find((task) => task.id === action.task.id);
      const task =
        existingTask?.status === '已停止' && existingTask.stopReason === '手动'
          ? { ...action.task, status: '已停止' as const, stopReason: '手动' as const }
          : action.task;
      const tasks = [...state.tasks.filter((t) => t.id !== task.id), task].map((item) =>
        parentTaskId && item.id === parentTaskId && item.kind === '周期性雷达'
          ? {
              ...item,
              status: '待启动' as const,
              lastRunAt: action.task.createdAt,
              nextDueAt: nextRadarDueAfter(item, action.task.createdAt),
            }
          : item,
      );
      let next: State = {
        ...state,
        tasks,
        taskAudits: [
          ...(state.taskAudits ?? []).filter((a) => a.taskId !== action.task.id),
          ...action.audits,
        ],
        sources: [...state.sources, ...incoming],
        toast: {
          text:
            task.status === '已停止'
              ? `调研停止：${task.stopReason ?? '失败'}，写入 ${incoming.length} 条来源`
              : task.stopReason === '触顶' || task.stopReason === '费用触顶'
                ? `调研触顶：已打开 ${incoming.length} 条来源入库`
                : `调研完成：写入 ${incoming.length} 条来源`,
          id: state.seq,
        },
        seq: state.seq + 1,
        view:
          state.view.kind === 'replay' && state.view.taskId === task.id
            ? state.view
            : { kind: 'object', objectId: task.objectId },
      };
      for (const src of incoming) {
        next = maybeEnqueuePrimarySuggestions(next, src.id, src.boundObjectIds);
      }
      return next;
    }

    default:
      return undefined;
  }
}
