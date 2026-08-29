import { conflictsOf, useStore } from '../../store';
import type { Claim } from '@shared/types';

function highlightSpan(body: string, span: string) {
  const i = body.indexOf(span);
  if (i < 0) return body;
  const lineStart = body.lastIndexOf('\n', i - 1) + 1;
  const rawBefore = body.slice(Math.max(lineStart, i - 40), i);
  const afterNl = body.indexOf('\n', i + span.length);
  const rawAfter = body.slice(i + span.length, afterNl < 0 ? i + span.length + 60 : Math.min(afterNl, i + span.length + 60));
  return (
    <>
      {rawBefore}
      <mark className="span-mark">{span}</mark>
      {rawAfter}
    </>
  );
}

export function AuditCard({ claimId }: { claimId: string }) {
  const { state, dispatch } = useStore();
  const claim = state.claims.find((c) => c.id === claimId);
  if (!claim) return <div className="deal-card dim">主张已不在账本</div>;
  const source = state.sources.find((s) => s.id === claim.sourceId);
  const foes = conflictsOf(state, claim.id);
  const live = claim.status !== '过时';

  return (
    <div className="deal-card audit">
      <div className="deal-kicker">审计</div>
      <p className="claim-fulltext">{claim.text}</p>
      <div className="claim-meta">
        <span className={`tag ${claim.predicate === '未编目' ? 'grey' : 'slot'}`}>
          {claim.predicate === '未编目' ? '未编目' : claim.predicate}
        </span>
        <span className={`tag ${claim.status === '过时' ? 'red' : 'green'}`}>{claim.status}</span>
        {claim.unverified && <span className="tag amber">未核</span>}
      </div>
      <div className="kv">
        <div className="kv-row">
          <span className="kv-k">有效期</span>
          <span className="kv-v">
            {claim.validFrom ?? '—'} → {claim.validTo ?? '未关窗'}
          </span>
        </div>
        <div className="kv-row">
          <span className="kv-k">进料路径</span>
          <span className="kv-v">
            {source?.virtual ? '使用者陈述' : source?.path ?? '—'}
            {source?.role ? ` · ${source.role}` : ''}
          </span>
        </div>
        <div className="kv-row">
          <span className="kv-k">来源</span>
          <span className="kv-v">{source?.virtual ? '使用者陈述' : (source?.title ?? '—')}</span>
        </div>
        {claim.closeReason && (
          <div className="kv-row">
            <span className="kv-k">关闭原因</span>
            <span className="kv-v">{claim.closeReason}</span>
          </div>
        )}
        {claim.supersededBy && (
          <div className="kv-row">
            <span className="kv-k">接替主张</span>
            <button className="btn ghost sm" onClick={() => dispatch({ type: 'OPEN_AUDIT_CARD', claimId: claim.supersededBy! })}>
              打开接替
            </button>
          </div>
        )}
      </div>

      {foes.length > 0 && (
        <div className="deal-section">
          <div className="conflict-box">
            <div className="conflict-label">冲突</div>
            <div className="conflict-pair wide">
              <Side claim={claim} current />
              {foes.map((f) => (
                <Side key={f.id} claim={f} onOpen={() => dispatch({ type: 'OPEN_AUDIT_CARD', claimId: f.id })} />
              ))}
            </div>
          </div>
        </div>
      )}

      {claim.span && source?.body && (
        <div className="deal-section">
          <div className="sec-title">原文片段</div>
          <pre className="span-quote">{highlightSpan(source.body, claim.span)}</pre>
        </div>
      )}

      {live && (
        <div className="deal-actions">
          {claim.unverified && (
            <button
              type="button"
              className="btn outline sm"
              onClick={() =>
                dispatch({
                  type: 'ENQUEUE_WRITE',
                  draft: {
                    objectId: claim.objectId,
                    kind: '晋升',
                    claimId: claim.id,
                    headline: `晋升「${claim.text}」`,
                    evidence: claim.span ?? claim.text,
                    outbound: true,
                  },
                })
              }
            >
              晋升
            </button>
          )}
          <button type="button" className="btn outline sm" onClick={() => dispatch({ type: 'OPEN_CORRECT_CARD', claimId: claim.id })}>
            这句不对
          </button>
          {source && !source.virtual && (
            <button type="button" className="btn outline sm" onClick={() => dispatch({ type: 'FOCUS_SOURCE', sourceId: source.id })}>
              看来源全文
            </button>
          )}
        </div>
      )}
      <div className="deal-id" title={claim.id}>
        {claim.id}
      </div>
    </div>
  );
}

function Side({ claim, current, onOpen }: { claim: Claim; current?: boolean; onOpen?: () => void }) {
  const { state } = useStore();
  const src = state.sources.find((s) => s.id === claim.sourceId);
  return (
    <button className="claim-card" type="button" onClick={onOpen} disabled={!onOpen}>
      <span className="claim-text">{claim.text}</span>
      <span className="claim-meta">
        {current && <span className="tag slot">当前</span>}
        {claim.unverified && <span className="tag amber">未核</span>}
        <span className="tag grey">{src ? (src.virtual ? '使用者陈述' : src.title) : claim.sourceId}</span>
      </span>
    </button>
  );
}

