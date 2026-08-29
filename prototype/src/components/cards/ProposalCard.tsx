import { useStore } from '../../store';

export function ProposalCard({ proposalId }: { proposalId: string }) {
  const { state, dispatch } = useStore();
  const p = state.proposals.find((x) => x.id === proposalId);
  if (!p) return <div className="deal-card dim">提议已不在</div>;

  return (
    <div className="deal-card proposal">
      <div className="deal-kicker">{p.type}</div>
      <div className="proposal-title">{p.title}</div>
      <p className="proposal-detail">{p.detail}</p>
      {p.pending ? (
        <div className="deal-actions">
          {p.payload.kind === '整理' ? (
            <>
              <button
                type="button"
                onClick={() => dispatch({ type: 'PROPOSAL_DECIDE', proposalId: p.id, decision: 'accept-merge' })}
              >
                接受 · 并入「{p.payload.targetPredicate}」
              </button>
              <button type="button" onClick={() => dispatch({ type: 'PROPOSAL_DECIDE', proposalId: p.id, decision: 'accept-drop' })}>
                接受 · 丢弃主张
              </button>
              <button type="button" className="ghost" onClick={() => dispatch({ type: 'PROPOSAL_DECIDE', proposalId: p.id, decision: 'reject' })}>
                驳回
              </button>
            </>
          ) : (
            <>
              <button type="button" onClick={() => dispatch({ type: 'PROPOSAL_DECIDE', proposalId: p.id, decision: 'accept-merge' })}>
                接受 · 并入耐久记忆
              </button>
              <button type="button" className="ghost" onClick={() => dispatch({ type: 'PROPOSAL_DECIDE', proposalId: p.id, decision: 'reject' })}>
                驳回
              </button>
            </>
          )}
        </div>
      ) : (
        <div className="dim small-text">
          已处理：
          {p.decision === 'accept-merge' ? '已接受' : p.decision === 'accept-drop' ? '已丢弃' : '已驳回'}
        </div>
      )}
    </div>
  );
}
