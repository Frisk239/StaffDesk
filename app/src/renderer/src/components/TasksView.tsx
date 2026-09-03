import { useState } from 'react';
import { formatTokenCount, latestTaskTokenTotal } from '@shared/taskFee';
import { compareStamp, formatLocalDateTime, isStampOverdue } from '@shared/time';
import type { DeskTask, TaskKind, TaskStatus } from '@shared/types';
import { useStore } from '../store';

// M19：任务列表页——所有对象上开过的办事意图汇成一轨；M27 收口加筛选、进行中置顶与失败重跑。
// 只读列表 + 跳转回放；任何会 pushCard 抢回对象视图的动作都不在这里发起（再搜一轮除外——
// 它是带上轮语境的新任务，见 CONTEXT「任务」）。

const KIND_FILTERS: ReadonlyArray<'全部' | TaskKind> = [
  '全部',
  '调研',
  '再搜一轮',
  '出简报',
  '周期性雷达',
];
const STATUS_FILTERS: ReadonlyArray<'全部' | TaskStatus> = [
  '全部',
  '待启动',
  '进行中',
  '已完成',
  '已停止',
];
type KindFilter = (typeof KIND_FILTERS)[number];
type StatusFilter = (typeof STATUS_FILTERS)[number];

function statusClass(status: TaskStatus): string {
  if (status === '已完成') return 'green';
  if (status === '进行中') return 'amber';
  return 'grey';
}

// 词条「任务」：再搜一轮与失败重跑都是带上轮语境的新任务——已完成但失败、或已停止的
// 调研轮次从行尾直接再开一轮（出简报与雷达不在重跑之列）。
function rerunnable(task: DeskTask): boolean {
  if (task.kind !== '调研' && task.kind !== '再搜一轮') return false;
  return task.status === '已停止' || (task.status === '已完成' && task.stopReason === '失败');
}

function FilterChips<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: readonly T[];
  value: T;
  onChange: (next: T) => void;
}) {
  return (
    <div className="task-filter-group">
      <span className="task-filter-label">{label}</span>
      <div className="task-filter-chips" role="group" aria-label={`按${label}筛选`}>
        {options.map((option) => (
          <button
            key={option}
            type="button"
            className={value === option ? 'on' : ''}
            aria-pressed={value === option}
            onClick={() => onChange(option)}
          >
            {option}
          </button>
        ))}
      </div>
    </div>
  );
}

export function TasksView() {
  const { state, dispatch } = useStore();
  const [kindFilter, setKindFilter] = useState<KindFilter>('全部');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('全部');
  // 进行中置顶（正在办事的先看见），其余按真实时间倒序，不用格式化串。
  const tasks = state.tasks
    .filter(
      (task) =>
        (kindFilter === '全部' || task.kind === kindFilter) &&
        (statusFilter === '全部' || task.status === statusFilter),
    )
    .sort((a, b) => {
      const aRunning = a.status === '进行中' ? 0 : 1;
      const bRunning = b.status === '进行中' ? 0 : 1;
      return aRunning - bRunning || compareStamp(b.createdAt, a.createdAt);
    });

  return (
    <section className="all-objects">
      <div className="all-objects-head">
        <h2>任务</h2>
        <span className="dim">调研、出简报、再搜一轮与雷达都从这里回看过程</span>
      </div>
      <FilterChips
        label="种类"
        options={KIND_FILTERS}
        value={kindFilter}
        onChange={setKindFilter}
      />
      <FilterChips
        label="状态"
        options={STATUS_FILTERS}
        value={statusFilter}
        onChange={setStatusFilter}
      />
      {state.tasks.length === 0 && (
        <div className="empty-guide">
          <div className="empty-big">还没有任务</div>
        </div>
      )}
      {state.tasks.length > 0 && tasks.length === 0 && (
        <div className="dim pad">没有符合筛选的任务</div>
      )}
      {tasks.map((task) => {
        const object = state.objects.find((item) => item.id === task.objectId);
        const overdue = Boolean(task.nextDueAt && isStampOverdue(task.nextDueAt));
        const tokenTotal = latestTaskTokenTotal(state.taskAudits, task.id);
        return (
          <div key={task.id} className="all-object-row">
            <span className="session-meta">
              <span className="session-name">{object?.name ?? '未知对象'}</span>
              <span className="session-sub">{formatLocalDateTime(task.createdAt)}</span>
            </span>
            <span className="tag grey">{task.kind}</span>
            <span className={`tag ${statusClass(task.status)}`}>
              {task.status}
              {task.stopReason ? ` · ${task.stopReason}` : ''}
            </span>
            {task.budgetGear && <span className="tag grey">{task.budgetGear}</span>}
            {tokenTotal !== undefined && (
              <span className="tag grey">{formatTokenCount(tokenTotal)}</span>
            )}
            {task.kind === '周期性雷达' && task.nextDueAt && (
              // 雷达行显示下次到点；到期如实标注（词条「回放」：雷达错过的周期如实记，不假装）。
              <span className={`tag ${overdue ? 'red' : 'grey'}`}>
                {overdue ? '已到期' : '下次'} · {formatLocalDateTime(task.nextDueAt).slice(5)}
              </span>
            )}
            {task.query && (
              <span className="replay-query" title={task.query}>
                {task.query}
              </span>
            )}
            <button
              type="button"
              className="btn ghost sm"
              onClick={() =>
                dispatch({ type: 'SET_VIEW', view: { kind: 'replay', taskId: task.id } })
              }
            >
              打开回放
            </button>
            {rerunnable(task) && (
              <button
                type="button"
                className="btn ghost sm"
                title="带上轮语境新开一轮"
                onClick={() =>
                  void window.staffdesk.startResearch(task.objectId, task.budgetGear ?? '快搜', {
                    kind: '再搜一轮',
                    fromTaskId: task.id,
                  })
                }
              >
                再搜一轮
              </button>
            )}
          </div>
        );
      })}
    </section>
  );
}
