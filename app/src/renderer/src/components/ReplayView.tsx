import { useStore } from '../store';

function payloadText(payload: unknown): string {
  return typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
}

function statusClass(status: string): string {
  if (status === '已完成') return 'green';
  if (status === '进行中') return 'amber';
  return 'grey';
}

export function ReplayView({ taskId }: { taskId: string }) {
  const { state, dispatch } = useStore();
  const task = state.tasks.find((t) => t.id === taskId);
  const object = task ? state.objects.find((item) => item.id === task.objectId) : null;
  const rows = state.taskAudits.filter((a) => a.taskId === taskId).sort((a, b) => a.seq - b.seq);
  return (
    <div className="replay-page">
      <div className="inbox-head">
        <div>
          <h2>任务回放</h2>
          {object && <span className="dim">{object.name}</span>}
        </div>
        <div className="replay-actions">
          {task?.status === '进行中' && (
            <button
              type="button"
              className="btn outline sm danger-hover"
              onClick={() => void window.staffdesk.stopTask(task.id)}
            >
              停止
            </button>
          )}
          <button
            type="button"
            className="ghost small"
            onClick={() =>
              dispatch({
                type: 'SET_VIEW',
                view: task ? { kind: 'object', objectId: task.objectId } : { kind: 'inbox' },
              })
            }
          >
            {task ? '返回对象' : '返回'}
          </button>
        </div>
      </div>
      {!task && <p className="dim">没有这条任务</p>}
      {task && (
        <div className="replay-summary">
          <span className={`tag ${statusClass(task.status)}`}>
            {task.status}
            {task.stopReason ? ` · ${task.stopReason}` : ''}
          </span>
          <span className="tag grey">{task.kind}</span>
          {task.budgetGear && <span className="tag grey">{task.budgetGear}</span>}
          {task.query && <span className="replay-query">{task.query}</span>}
          {task.parentTaskId && <span className="tag grey">父雷达 {task.parentTaskId}</span>}
          {task.dueAt && <span className="tag grey">应跑 {task.dueAt}</span>}
          {task.nextDueAt && <span className="tag grey">下次 {task.nextDueAt}</span>}
        </div>
      )}
      <ol className="replay-timeline">
        {rows.map((row) => (
          <li key={`${row.taskId}-${row.seq}`} className="replay-card">
            <div className="replay-card-head">
              <strong>
                {row.seq}. {row.kind}
              </strong>
              <time>{row.ts.slice(11, 19)}</time>
            </div>
            <pre className="replay-payload">{payloadText(row.payload)}</pre>
          </li>
        ))}
      </ol>
      {rows.length === 0 && (
        <p className="dim">{task?.status === '进行中' ? '正在准备第一步。' : '还没有步骤。'}</p>
      )}
    </div>
  );
}
