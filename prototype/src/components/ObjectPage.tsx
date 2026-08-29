import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { closedClaims, conflictsOf, isExtracting, projectionClaims, useStore } from '../store';
import { scenarioOfWorkspace, slotsForScene } from '../scenario';
import type { Claim, Predicate } from '../types';

// 0033：谓词槽表是数据（state.slotDefs），按对象种类分区，再按对象所在工作区的场景过滤；通用槽恒显示。

function UnverifiedTag({ claim }: { claim: Claim }) {
  return claim.unverified ? <span className="tag amber">未核</span> : null;
}

export function Projection({ objectId }: { objectId: string }) {
  const { state, dispatch } = useStore();
  const obj = state.objects.find((o) => o.id === objectId)!;
  const claims = projectionClaims(state, objectId);
  const closed = closedClaims(state, objectId);
  const scenario = scenarioOfWorkspace(state.workspaces, obj.workspaceId);
  const slots = slotsForScene(state.slotDefs, obj.kind, scenario);
  const extracting = isExtracting(state, objectId);
  const [showClosed, setShowClosed] = useState(false);

  const open = (id: string) => dispatch({ type: 'OPEN_AUDIT_CARD', claimId: id });

  const slotContent = (slot: Predicate) => {
    const inSlot = claims.filter((c) => c.predicate === slot);
    if (inSlot.length === 0) {
      return (
        <div className="slot-unknown" key={slot}>
          <span className="unknown-mark">未知</span>
        </div>
      );
    }
    const rendered: ReactElement[] = [];
    const used = new Set<string>();
    for (const c of inSlot) {
      if (used.has(c.id)) continue;
      const foes = conflictsOf(state, c.id).filter((f) => f.predicate === slot);
      if (foes.length > 0 && c.predicate !== '未编目') {
        const foe = foes[0];
        used.add(foe.id);
        rendered.push(
          <div className="conflict-box stacked" key={c.id}>
            <div className="conflict-label">冲突</div>
            <ClaimCard claim={c} onClick={open} />
            <ClaimCard claim={foe} onClick={open} />
          </div>,
        );
      } else {
        rendered.push(<ClaimCard key={c.id} claim={c} onClick={open} />);
      }
    }
    return rendered;
  };

  const uncataloged = claims.filter((c) => c.predicate === '未编目');

  return (
    <section className="projection">
      <div className="proj-head">
        <span className="kind-chip">{obj.kind}</span>
        <h1 className="proj-name">{obj.name}</h1>
        <span className="tag grey">{scenario}</span>
        {obj.note && <span className="dim">{obj.note}</span>}
      </div>
      {extracting && (
        <div className="extract-banner">
          <span className="pulse-dot" /> 抽取中
        </div>
      )}

      <div className="slot-grid">
        {slots.map((slot) => (
          <div className="slot-card" key={slot}>
            <div className="slot-title">{slot}</div>
            {slotContent(slot)}
          </div>
        ))}
      </div>

      {uncataloged.length > 0 && (
        <div className="slot-card full uncat">
          <div className="slot-title">
            未编目
          </div>
          {uncataloged.map((c) => (
            <ClaimCard key={c.id} claim={c} onClick={open} />
          ))}
        </div>
      )}

      {closed.length > 0 && (
        <div className="closed-section">
          <button className="btn ghost sm" onClick={() => setShowClosed((v) => !v)}>
            {showClosed ? '收起' : '已关窗'} {closed.length}
          </button>
          {showClosed &&
            closed.map((c) => (
              <div className="closed-claim" key={c.id} onClick={() => open(c.id)}>
                <span className="tag red">过时</span>
                <span className="tag red">{c.closeReason}</span>
                <span className="closed-text">{c.text}</span>
              </div>
            ))}
        </div>
      )}
    </section>
  );
}

function ClaimCard({ claim, onClick }: { claim: Claim; onClick: (id: string) => void }) {
  const { state } = useStore();
  const src = state.sources.find((s) => s.id === claim.sourceId);
  return (
    <button className="claim-card" onClick={() => onClick(claim.id)}>
      <span className="claim-text">{claim.text}</span>
      <span className="claim-meta">
        <UnverifiedTag claim={claim} />
        <span className="tag grey">{src ? (src.virtual ? '使用者陈述' : src.title) : claim.sourceId}</span>
      </span>
    </button>
  );
}

export function SourcesPane({ objectId }: { objectId: string }) {
  const { state, dispatch } = useStore();
  const [openIds, setOpenIds] = useState<Set<string>>(new Set());
  const cardRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const sources = state.sources.filter((s) => !s.virtual && s.boundObjectIds.includes(objectId));

  useEffect(() => {
    const id = state.sourceFocusId;
    if (!id) return;
    setOpenIds((prev) => new Set(prev).add(id));
    const el = cardRefs.current[id];
    el?.scrollIntoView({ block: 'nearest' });
  }, [state.sourceFocusId]);

  const toggle = (id: string) => {
    const next = new Set(openIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setOpenIds(next);
  };

  const renderBody = (sourceId: string, body: string) => {
    const spans = state.claims.filter((c) => c.sourceId === sourceId && c.span).map((c) => c.span!);
    if (spans.length === 0) return body;
    let parts: (string | { span: string })[] = [body];
    for (const sp of spans) {
      parts = parts.flatMap((p) => {
        if (typeof p !== 'string') return [p];
        const i = p.indexOf(sp);
        if (i < 0) return [p];
        return [p.slice(0, i), { span: sp }, p.slice(i + sp.length)];
      });
    }
    return parts.map((p, i) =>
      typeof p === 'string' ? <span key={i}>{p}</span> : <mark className="span-mark" key={i}>{p.span}</mark>,
    );
  };

  return (
    <aside className="sources-pane">
      <div className="pane-title">已绑定来源</div>
      {sources.length === 0 && <div className="dim pad">暂无</div>}
      {sources.map((s) => {
        const job = state.extractJobs.find((j) => j.sourceId === s.id);
        const isOpen = openIds.has(s.id);
        return (
          <div className="source-card" key={s.id} ref={(el) => { cardRefs.current[s.id] = el; }}>
            <button className="source-head" onClick={() => toggle(s.id)}>
              <span className={`tri${isOpen ? ' open' : ''}`}>▸</span>
              <span className="source-title">{s.title}</span>
            </button>
            <div className="source-meta">
              <span className="tag path">{s.path}</span>
              {s.role && <span className="tag role">{s.role}</span>}
              {job?.status === '抽取中' ? (
                <span className="tag amber">
                  <span className="pulse-dot inline" /> 抽取中
                </span>
              ) : (
                <span className="tag grey">抽取完成</span>
              )}
            </div>
            {isOpen && (
              <pre className="source-body small">
                {renderBody(s.id, s.body)}
              </pre>
            )}
            {isOpen && (
              <div className="source-bind dim">
                绑定对象：{s.boundObjectIds.map((id) => state.objects.find((o) => o.id === id)?.name).join('、')}
              </div>
            )}
          </div>
        );
      })}
      {sources.length > 0 && (
        <button className="link pad" onClick={() => dispatch({ type: 'SET_VIEW', view: { kind: 'inbox' } })}>
          Inbox
        </button>
      )}
    </aside>
  );
}


