import { useStore } from '../store';
import type { TaskStatus } from '@shared/types';

// M19：任务列表页——所有对象上开过的办事意图按时间倒序汇成一轨。
// 只读列表 + 跳转回放；任何会 pushCard 抢回对象视图的动作都不在这里发起。
function statusClass(status: TaskStatus): string {
  if (status === '已完成') return 'green';
  if (status === '进行中') return 'amber';
  return 'grey';
}

export function TasksView() {
  const { state, dispatch } = useStore();
  const tasks = [...state.tasks].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return (
    <section className="all-objects">
      <div className="all-objects-head">
        <h2>任务</h2>
        <span className="dim">调研、出简报、再搜一轮与雷达都从这里回看过程</span>
      </div>
      {tasks.length === 0 && (
        <div className="empty-guide">
          <div className="empty-big">还没有任务</div>
        </div>
      )}
      {tasks.map((task) => {
        const object = state.objects.find((item) => item.id === task.objectId);
        return (
          <div key={task.id} className="all-object-row">
            <span className="session-meta">
              <span className="session-name">{object?.name ?? '未知对象'}</span>
              <span className="session-sub">{task.createdAt}</span>
            </span>
            <span className="tag grey">{task.kind}</span>
            <span className={`tag ${statusClass(task.status)}`}>
              {task.status}
              {task.stopReason ? ` · ${task.stopReason}` : ''}
            </span>
            {task.budgetGear && <span className="tag grey">{task.budgetGear}</span>}
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
          </div>
        );
      })}
    </section>
  );
}
