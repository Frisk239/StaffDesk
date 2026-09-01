import { useState } from 'react';
import { useStore } from '../store';
import type { MemoryScope, ObjectKind, Predicate, Proposal } from '@shared/types';

/** 已处理徽标按提议类型给词：建对象/建关系的 accept-merge 是「已建立」，不是「已并入」。 */
function decidedText(p: Proposal): string {
  if (p.decision === 'reject') return '已驳回';
  if (p.payload.kind === '建对象' || p.payload.kind === '建关系') return '已建立';
  if (p.decision === 'accept-merge') return '已并入';
  if (p.decision === 'accept-drop') return '已丢弃';
  return '已关窗';
}

export function PendingView() {
  const { state, dispatch } = useStore();
  // 编目卡上人选拖的槽：proposalId → 槽名（undefined = 未选，回落 payload 预选）。
  const [slotChoice, setSlotChoice] = useState<Record<string, Predicate>>({});
  // 建对象卡上人选的种类（0052）：undefined = 未选，select 默认展示「组织」。
  const [kindChoice, setKindChoice] = useState<Record<string, ObjectKind>>({});
  // 候选卡上人选的范围（0055）：undefined = 未改，回落 payload 默认。
  const [scopeChoice, setScopeChoice] = useState<Record<string, MemoryScope>>({});
  const claimOf = (claimId: string) =>
    state.claims.find((x) => x.id === claimId) ?? state.pendingClaims.find((x) => x.id === claimId);
  const objectInWs = (objectId?: string) => {
    if (!objectId) return false;
    const o = state.objects.find((x) => x.id === objectId);
    return o?.workspaceId === state.currentWorkspaceId;
  };
  const tidyInWs = (claimId: string) => objectInWs(claimOf(claimId)?.objectId);
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
    if (p.payload.kind === '主键新版过时') return tidyInWs(p.payload.oldClaimId);
    if (p.payload.kind === '丢弃未核') return tidyInWs(p.payload.claimIds[0] ?? '');
    if (p.payload.kind === '合并重复') return tidyInWs(p.payload.keepId);
    // 建对象挂在抽取语境对象的账页；建关系挂在锚对象账页（两端任一在当前区即显示）。
    if (p.payload.kind === '建对象') return objectInWs(p.payload.fromObjectId);
    if (p.payload.kind === '建关系')
      return objectInWs(p.payload.objectId) || objectInWs(p.payload.targetId);
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
    overrides?: { targetPredicate?: string; objectKind?: ObjectKind; scope?: MemoryScope },
  ) =>
    dispatch({
      type: 'PROPOSAL_DECIDE',
      proposalId,
      decision,
      ...(overrides?.targetPredicate ? { targetPredicate: overrides.targetPredicate } : {}),
      ...(overrides?.objectKind ? { objectKind: overrides.objectKind } : {}),
      ...(overrides?.scope ? { scope: overrides.scope } : {}),
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
    if (p.payload.kind === '主键新版过时') {
      return (
        <>
          <button className="btn primary sm" onClick={() => decide(p.id, 'accept-close')}>
            确认旧版过时（关窗）
          </button>
          <button className="btn outline sm danger-hover" onClick={() => decide(p.id, 'reject')}>
            驳回
          </button>
        </>
      );
    }
    if (p.payload.kind === '建对象') {
      // 0052：对象只由人确认建立——种类是必选的人选，默认给「组织」。
      const kind = kindChoice[p.id] ?? '组织';
      return (
        <>
          <select
            className="proposal-select"
            aria-label="选择对象种类"
            value={kind}
            onChange={(e) =>
              setKindChoice((prev) => ({ ...prev, [p.id]: e.target.value as ObjectKind }))
            }
          >
            <option value="组织">组织</option>
            <option value="人">人</option>
            <option value="项目">项目</option>
          </select>
          <button
            className="btn primary sm"
            disabled={!kind}
            onClick={() => decide(p.id, 'accept-merge', { objectKind: kind })}
          >
            确认 · 建立{kind}对象「{p.payload.name}」
          </button>
          <button className="btn outline sm danger-hover" onClick={() => decide(p.id, 'reject')}>
            驳回
          </button>
        </>
      );
    }
    if (p.payload.kind === '建关系') {
      return (
        <>
          <button className="btn primary sm" onClick={() => decide(p.id, 'accept-merge')}>
            确认 · 建立关系
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
            onClick={() =>
              decide(p.id, 'accept-merge', choice ? { targetPredicate: choice } : undefined)
            }
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
    if (p.payload.kind === '建关系') {
      // 字段先落 const：payload 判别收窄进不了 find 回调。
      const relAId = p.payload.objectId;
      const relBId = p.payload.targetId;
      const a = state.objects.find((x) => x.id === relAId);
      const b = state.objects.find((x) => x.id === relBId);
      return (
        <div className="proposal-detail">
          <div className="merge-line keep">
            <span className="tag grey">{a?.kind ?? '对象'}</span>
            <span>{a?.name ?? p.payload.objectId}</span>
            <span> ↔ </span>
            <span className="tag grey">{b?.kind ?? '对象'}</span>
            <span>{b?.name ?? p.payload.targetId}</span>
          </div>
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
              <div className="dim small-text">已处理：{decidedText(p)}</div>
            )}
          </div>
        ))}
      </div>

      <div className="pending-section">
        <div className="pane-title">候选记忆</div>
        {candidates.length === 0 ? (
          <div className="dim pad">暂无</div>
        ) : (
          candidates.map((p) => {
            // 0055：范围默认由提议给定，确认卡上可改；确认时以人选为准。
            const chosenScope =
              scopeChoice[p.id] ?? (p.payload.kind === '候选记忆' ? p.payload.scope : undefined);
            return (
              <div className={`proposal-card${p.pending ? '' : ' decided'}`} key={p.id}>
                <div className="proposal-title">
                  {p.title}
                  {p.payload.kind === '候选记忆' &&
                    (p.pending ? (
                      <select
                        className="proposal-select"
                        aria-label="选择记忆范围"
                        value={chosenScope ?? ''}
                        onChange={(e) =>
                          setScopeChoice((prev) => ({
                            ...prev,
                            [p.id]: e.target.value as MemoryScope,
                          }))
                        }
                      >
                        <option value="全局">全局</option>
                        <option value="对象">对象</option>
                        <option value="会话">会话</option>
                      </select>
                    ) : (
                      <span className="tag grey">{chosenScope}</span>
                    ))}
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
                        decide(
                          p.id,
                          'accept-merge',
                          chosenScope ? { scope: chosenScope } : undefined,
                        )
                      }
                    >
                      接受 · 并入{chosenScope}记忆
                    </button>
                    <button
                      className="btn outline sm danger-hover"
                      onClick={() => decide(p.id, 'reject')}
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
            );
          })
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
