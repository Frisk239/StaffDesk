import { useStore } from '../store';

export function PendingView() {
  const { state, dispatch } = useStore();
  const tidyInWs = (claimId: string) => {
    const c = state.claims.find((x) => x.id === claimId) ?? state.pendingClaims.find((x) => x.id === claimId);
    const o = state.objects.find((x) => x.id === c?.objectId);
    return o?.workspaceId === state.currentWorkspaceId;
  };
  const tidies = state.proposals.filter((p) => {
    if (p.type !== '整理') return false;
    if (p.payload.kind === '整理') return tidyInWs(p.payload.claimId);
    if (p.payload.kind === '丢弃未核') return tidyInWs(p.payload.claimIds[0]);
    return false;
  });
  const candidates = state.proposals.filter((p) => {
    if (p.type !== '候选记忆' || p.payload.kind !== '候选记忆') return false;
    const from = p.payload.kind === '候选记忆' ? p.payload.fromObjectId : undefined;
    if (!from) return true;
    const o = state.objects.find((x) => x.id === from);
    return o?.workspaceId === state.currentWorkspaceId;
  });

  return (
    <div className="pending-view">
      <div className="pending-section">
        <div className="pane-title">整理提议</div>
        {tidies.length === 0 && <div className="dim pad">暂无整理提议。</div>}
        {tidies.map((p) => (
          <div className={`proposal-card${p.pending ? '' : ' decided'}`} key={p.id}>
            <div className="proposal-title">{p.title}</div>
            <p className="proposal-detail">{p.detail}</p>
            {p.pending ? (
              <div className="proposal-actions">
                {p.payload.kind === '整理' && (
                  <button
                    className="btn primary sm"
                    onClick={() => dispatch({ type: 'PROPOSAL_DECIDE', proposalId: p.id, decision: 'accept-merge' })}
                  >
                    接受 · 并入「{p.payload.targetPredicate}」
                  </button>
                )}
                {p.payload.kind === '丢弃未核' && (
                  <button
                    className="btn primary sm"
                    onClick={() => dispatch({ type: 'PROPOSAL_DECIDE', proposalId: p.id, decision: 'accept-drop' })}
                  >
                    接受 · 丢弃（{p.payload.claimIds.length} 条）
                  </button>
                )}
                {p.payload.kind === '整理' && (
                  <button className="btn outline sm" onClick={() => dispatch({ type: 'PROPOSAL_DECIDE', proposalId: p.id, decision: 'accept-drop' })}>
                    接受 · 丢弃主张
                  </button>
                )}
                <button className="btn outline sm danger-hover" onClick={() => dispatch({ type: 'PROPOSAL_DECIDE', proposalId: p.id, decision: 'reject' })}>
                  驳回
                </button>
                {p.payload.kind === '整理' && (
                  <button className="btn ghost sm" onClick={() => dispatch({ type: 'OPEN_PROPOSAL_CARD', proposalId: p.id })}>
                    在对话里处理
                  </button>
                )}
              </div>
            ) : (
              <div className="dim small-text">
                已处理：
                {p.decision === 'accept-merge' ? '已并入' : p.decision === 'accept-drop' ? '已丢弃' : '已驳回'}
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="pending-section">
        <div className="pane-title">候选记忆</div>
        {candidates.length === 0 ? (
          <div className="dim pad">暂无</div>
        ) : (
          candidates.map((p) => (
            <div className={`proposal-card${p.pending ? '' : ' decided'}`} key={p.id}>
              <div className="proposal-title">
                {p.title}
                {p.payload.kind === '候选记忆' && <span className="tag grey">{p.payload.scope}</span>}
              </div>
              <p className="proposal-detail">{p.detail}</p>
              {p.pending ? (
                <div className="proposal-actions">
                  <button
                    className="btn outline sm"
                    onClick={() => dispatch({ type: 'PROPOSAL_DECIDE', proposalId: p.id, decision: 'accept-merge' })}
                  >
                    接受 · 并入{p.payload.kind === '候选记忆' ? p.payload.scope : ''}记忆
                  </button>
                  <button className="btn outline sm danger-hover" onClick={() => dispatch({ type: 'PROPOSAL_DECIDE', proposalId: p.id, decision: 'reject' })}>
                    驳回
                  </button>
                </div>
              ) : (
                <div className="dim small-text">已处理：{p.decision === 'reject' ? '已驳回' : '已写入记忆'}</div>
              )}
            </div>
          ))
        )}

        <div className="memories-box">
          <div className="sec-title">记忆</div>
          {state.memories.map((m) => (
            <div className="memory-row" key={m.id}>
              <span className={`tag ${m.kind === '禁写' ? 'red' : 'grey'}`}>{m.kind}</span>
              <span className="tag grey">{m.scope}</span>
              <span>{m.text}</span>
              {m.kind === '禁写' && (
                // 0034：禁写的显式回退入口——误纠正不该永久拦截。
                <button
                  type="button"
                  className="ghost small"
                  title="移除这条禁写（撤销对它的拦截）"
                  onClick={() => dispatch({ type: 'REMOVE_MEMORY', id: m.id })}
                >
                  移除
                </button>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
