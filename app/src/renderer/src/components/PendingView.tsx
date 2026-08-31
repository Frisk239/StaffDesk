import { useState } from 'react';
import { useStore } from '../store';
import type { Predicate, Proposal } from '@shared/types';

function decidedText(decision: Proposal['decision'] | undefined): string {
  if (decision === 'accept-merge') return '已并入';
  if (decision === 'accept-drop') return '已丢弃';
  if (decision === 'accept-close') return '已关窗';
  return '已驳回';
}

export function PendingView() {
  const { state, dispatch } = useStore();
  // 编目卡上人选拖的槽：proposalId → 槽名（undefined = 未选，回落 payload 预选）。
  const [slotChoice, setSlotChoice] = useState<Record<string, Predicate>>({});
  const claimOf = (claimId: string) =>
    state.claims.find((x) => x.id === claimId) ?? state.pendingClaims.find((x) => x.id === claimId);
  const tidyInWs = (claimId: string) => {
    const o = state.objects.find((x) => x.id === claimOf(claimId)?.objectId);
    return o?.workspaceId === state.currentWorkspaceId;
  };
  /** 编目卡下拉：受控槽里与该主张对象种类匹配的槽清单（0025 不准自开槽）。 */
  const slotOptionsFor = (claimId: string): Predicate[] => {
    const claim = claimOf(claimId);
    const kind = state.objects.find((x) => x.id === claim?.objectId)?.kind;
    if (!kind) return [];
    return state.slotDefs.filter((d) => d.kind === kind).map((d) => d.name);
  };
  const tidies = state.proposals.filter((p) => {
    if (p.type !== '整理') return false;
    if (p.payload.kind === '整理' || p.payload.kind === '标过时')
      return tidyInWs(p.payload.claimId);
    if (p.payload.kind === '丢弃未核') return tidyInWs(p.payload.claimIds[0] ?? '');
    if (p.payload.kind === '合并重复') return tidyInWs(p.payload.keepId);
    return false;
  });
  const candidates = state.proposals.filter((p) => {
    if (p.type !== '候选记忆' || p.payload.kind !== '候选记忆') return false;
    const from = p.payload.kind === '候选记忆' ? p.payload.fromObjectId : undefined;
    if (!from) return true;
    const o = state.objects.find((x) => x.id === from);
    return o?.workspaceId === state.currentWorkspaceId;
  });
  const decide = (
    proposalId: string,
    decision: Exclude<Proposal['decision'], undefined>,
    targetPredicate?: string,
  ) =>
    dispatch({
      type: 'PROPOSAL_DECIDE',
      proposalId,
      decision,
      ...(targetPredicate ? { targetPredicate } : {}),
    });

  const renderTidyActions = (p: Proposal) => {
    if (p.payload.kind === '合并重复') {
      return (
        <>
          <button className="btn primary sm" onClick={() => decide(p.id, 'accept-merge')}>
            合并（保留首条，去掉 {p.payload.dropIds.length} 条重复）
          </button>
          <button className="btn outline sm danger-hover" onClick={() => decide(p.id, 'reject')}>
            驳回
          </button>
        </>
      );
    }
    if (p.payload.kind === '标过时') {
      return (
        <>
          <button className="btn primary sm" onClick={() => decide(p.id, 'accept-close')}>
            确认已过时（关窗）
          </button>
          <button className="btn outline sm danger-hover" onClick={() => decide(p.id, 'reject')}>
            驳回
          </button>
        </>
      );
    }
    if (p.payload.kind === '整理') {
      const choice = slotChoice[p.id] ?? p.payload.targetPredicate;
      const options = slotOptionsFor(p.payload.claimId);
      return (
        <>
          <select
            className="proposal-select"
            aria-label="选择要并入的槽"
            value={choice ?? ''}
            onChange={(e) => setSlotChoice((prev) => ({ ...prev, [p.id]: e.target.value }))}
          >
            <option value="">选择要并入的槽…</option>
            {options.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
          <button
            className="btn primary sm"
            disabled={!choice}
            onClick={() => decide(p.id, 'accept-merge', choice)}
          >
            接受 · 并入{choice ? `「${choice}」` : '（先选槽）'}
          </button>
          <button className="btn outline sm" onClick={() => decide(p.id, 'accept-drop')}>
            接受 · 丢弃主张
          </button>
          <button className="btn outline sm danger-hover" onClick={() => decide(p.id, 'reject')}>
            驳回
          </button>
          {/* 有预选槽的整理卡才走对话流；无目标的编目卡只在待确认页处理，避免转发链拿不到槽。 */}
          {p.payload.targetPredicate && (
            <button
              className="btn ghost sm"
              onClick={() => dispatch({ type: 'OPEN_PROPOSAL_CARD', proposalId: p.id })}
            >
              在对话里处理
            </button>
          )}
        </>
      );
    }
    return null;
  };

  const renderTidyBody = (p: Proposal) => {
    if (p.payload.kind === '合并重复') {
      // 对比从账本实时取：提议后主张被人先动过也不误导。
      const keepText = claimOf(p.payload.keepId)?.text ?? '（已不在账本）';
      const drops = p.payload.dropIds.map((id) => ({
        id,
        text: claimOf(id)?.text ?? '（已不在账本）',
      }));
      return (
        <div className="proposal-detail">
          <div className="merge-line keep">
            <span className="tag green">保留</span>
            <span>{keepText}</span>
          </div>
          {drops.map((drop) => (
            <div className="merge-line drop" key={drop.id}>
              <span className="tag grey">去掉</span>
              <span>{drop.text}</span>
            </div>
          ))}
        </div>
      );
    }
    return <p className="proposal-detail">{p.detail}</p>;
  };

  return (
    <div className="pending-view">
      <div className="pending-section">
        <div className="pane-title">整理提议</div>
        {tidies.length === 0 && <div className="dim pad">暂无整理提议。</div>}
        {tidies.map((p) => (
          <div className={`proposal-card${p.pending ? '' : ' decided'}`} key={p.id}>
            <div className="proposal-title">{p.title}</div>
            {renderTidyBody(p)}
            {p.pending ? (
              <div className="proposal-actions">{renderTidyActions(p)}</div>
            ) : (
              <div className="dim small-text">已处理：{decidedText(p.decision)}</div>
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
                {p.payload.kind === '候选记忆' && (
                  <span className="tag grey">{p.payload.scope}</span>
                )}
              </div>
              <p className="proposal-detail">{p.detail}</p>
              {p.payload.kind === '候选记忆' && (
                <div className="dim small-text">
                  会话消息：{p.payload.fromMessageIds?.join('、') || '旧候选未记录'} · 摘录：
                  {p.payload.sourceExcerpt || '旧候选未记录'}
                </div>
              )}
              {p.pending ? (
                <div className="proposal-actions">
                  <button
                    className="btn outline sm"
                    onClick={() =>
                      dispatch({
                        type: 'PROPOSAL_DECIDE',
                        proposalId: p.id,
                        decision: 'accept-merge',
                      })
                    }
                  >
                    接受 · 并入{p.payload.kind === '候选记忆' ? p.payload.scope : ''}记忆
                  </button>
                  <button
                    className="btn outline sm danger-hover"
                    onClick={() =>
                      dispatch({ type: 'PROPOSAL_DECIDE', proposalId: p.id, decision: 'reject' })
                    }
                  >
                    驳回
                  </button>
                </div>
              ) : (
                <div className="dim small-text">
                  已处理：{p.decision === 'reject' ? '已驳回' : '已写入记忆'}
                </div>
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
