import { useStore } from '../store';

export function ReplayView({ taskId }: { taskId: string }) {
  const { state, dispatch } = useStore();
  const task = state.tasks.find((t) => t.id === taskId);
  const rows = state.taskAudits.filter((a) => a.taskId === taskId).sort((a, b) => a.seq - b.seq);
  return (
    <div className="inbox-page" style={{ padding: 24, overflow: 'auto' }}>
      <div className="inbox-head">
        <h2>任务回放</h2>
        <button type="button" className="ghost small" onClick={() => dispatch({ type: 'SET_VIEW', view: { kind: 'inbox' } })}>
          返回
        </button>
      </div>
      {!task && <p className="dim">没有这条任务</p>}
      {task && (
        <p className="dim">
          {task.kind} · {task.status}
          {task.stopReason ? ` · ${task.stopReason}` : ''}
          {task.budgetGear ? ` · ${task.budgetGear}` : ''}
        </p>
      )}
      <ol className="source-list">
        {rows.map((row) => (
          <li key={`${row.taskId}-${row.seq}`} className="source-card">
            <strong>
              {row.seq}. {row.kind}
            </strong>
            <pre className="dim" style={{ whiteSpace: 'pre-wrap' }}>
              {typeof row.payload === 'string' ? row.payload : JSON.stringify(row.payload, null, 2)}
            </pre>
          </li>
        ))}
      </ol>
      {rows.length === 0 && <p className="dim">还没有步骤。先在对象顶栏开调研。</p>}
    </div>
  );
}
