import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { closedClaims, conflictsOf, isExtracting, projectionClaims, useStore } from '../store';
import { scenarioOfWorkspace, slotsForScene } from '@shared/scenario';
import type { Claim, DeskObject, Predicate, SourceRole } from '@shared/types';
import { bindingRole } from '@shared/primarySource';

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
        if (!foe) continue;
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
        {/* key：切换对象时重挂载，行内编辑/面板草稿不跨对象残留。 */}
        <NoteEdit key={obj.id} obj={obj} />
      </div>
      {extracting && (
        <div className="extract-banner">
          <span className="pulse-dot" /> 抽取中
        </div>
      )}

      <RelationsSection key={obj.id} obj={obj} />

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
          <div className="slot-title">未编目</div>
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

// note 行内编辑：Enter/失焦提交，Esc 取消；清空提交 null 而非空串（loadLedger 读不回 ''）。
function NoteEdit({ obj }: { obj: DeskObject }) {
  const { dispatch } = useStore();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const escaped = useRef(false);

  const start = () => {
    setDraft(obj.note ?? '');
    setEditing(true);
  };
  const commit = () => {
    dispatch({ type: 'SET_OBJECT_NOTE', objectId: obj.id, note: draft.trim() || null });
    setEditing(false);
  };

  if (!editing) {
    return obj.note ? (
      <button type="button" className="proj-note dim" title="点击编辑备注" onClick={start}>
        {obj.note}
      </button>
    ) : (
      <button type="button" className="link" onClick={start}>
        加备注
      </button>
    );
  }
  return (
    <input
      className="note-edit-input"
      autoFocus
      value={draft}
      placeholder="一句话备注"
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (escaped.current) {
          escaped.current = false;
          return;
        }
        commit();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit();
        else if (e.key === 'Escape') {
          escaped.current = true;
          setEditing(false);
        }
      }}
    />
  );
}

// CONTEXT「关系」：裸边、无类型标签；界面不出现任何内部机制名或图谱类词。
function RelationsSection({ obj }: { obj: DeskObject }) {
  const { state, dispatch } = useStore();
  const [panelOpen, setPanelOpen] = useState(false);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [candidateFilter, setCandidateFilter] = useState('');

  // 悬边容错：find 不到的 id 直接跳过，不让对象页崩。
  const related = obj.relationIds.flatMap((id) => {
    const target = state.objects.find((o) => o.id === id);
    return target ? [target] : [];
  });

  // 仅跨种类边：候选池 = 当前工作区、未归档、异种、非自身、未关联，按种类分组（bind-panel 同款骨架）。
  const candidates = (['组织', '项目', '人'] as const)
    .filter((k) => k !== obj.kind)
    .map((kind) => ({
      kind,
      items: state.objects.filter(
        (o) =>
          o.workspaceId === state.currentWorkspaceId &&
          !o.archived &&
          o.kind === kind &&
          o.id !== obj.id &&
          !obj.relationIds.includes(o.id),
      ),
    }))
    .filter((g) => g.items.length > 0);

  // 候选搜索：按名称过滤，勾选状态不随过滤丢失（隐藏项保留在确认载荷里）。
  const keyword = candidateFilter.trim().toLowerCase();
  const visibleCandidates = candidates
    .map((g) => ({ ...g, items: g.items.filter((o) => o.name.toLowerCase().includes(keyword)) }))
    .filter((g) => g.items.length > 0);

  const toggle = (id: string) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const confirmAdd = () => {
    // 一次确认可加多条边：逐条 dispatch，对称双侧 append 由 reducer 负责。
    for (const id of checked) dispatch({ type: 'ADD_RELATION', objectId: obj.id, targetId: id });
    setChecked(new Set());
    setPanelOpen(false);
  };

  const closePanel = () => {
    setChecked(new Set());
    setCandidateFilter('');
    setPanelOpen(false);
  };

  return (
    <div className="relations-section">
      <div className="relations-head">
        <span className="slot-title">关系</span>
        <button type="button" className="btn outline sm" onClick={() => setPanelOpen((v) => !v)}>
          {panelOpen ? '收起' : '添加关系'}
        </button>
      </div>
      {related.length === 0 ? (
        <div className="dim">还没有关系</div>
      ) : (
        <div className="chip-row">
          {related.map((r) => (
            <span className="chip rel-chip" key={r.id}>
              <button
                type="button"
                className="rel-jump"
                onClick={() =>
                  dispatch({ type: 'SET_VIEW', view: { kind: 'object', objectId: r.id } })
                }
              >
                {r.name}
              </button>
              <span className="kind-chip">{r.kind}</span>
              {/* 关系不做撤销：边可即时重建，不进补偿写载荷（0034 只覆盖账本写入类动作）。 */}
              <button
                type="button"
                className="rel-remove"
                title="移除"
                aria-label={`移除关系 ${r.name}`}
                onClick={() =>
                  dispatch({ type: 'REMOVE_RELATION', objectId: obj.id, targetId: r.id })
                }
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      {panelOpen && (
        <div className="bind-panel">
          <div className="bind-panel-title">添加关系</div>
          {candidates.length > 0 && (
            <input
              className="bind-search"
              value={candidateFilter}
              placeholder="搜索对象"
              aria-label="搜索对象"
              onChange={(e) => setCandidateFilter(e.target.value)}
            />
          )}
          {candidates.length === 0 && <div className="dim">本工作区没有可关联的对象</div>}
          {candidates.length > 0 && visibleCandidates.length === 0 && (
            <div className="dim">没有匹配的对象</div>
          )}
          {visibleCandidates.map((g) => (
            <div className="bind-group" key={g.kind}>
              <div className="bind-group-title">{g.kind}</div>
              {g.items.map((o) => (
                <label key={o.id} className={`bind-option${checked.has(o.id) ? ' on' : ''}`}>
                  <input
                    type="checkbox"
                    checked={checked.has(o.id)}
                    onChange={() => toggle(o.id)}
                  />
                  <span>{o.name}</span>
                </label>
              ))}
            </div>
          ))}
          <div className="bind-actions">
            <button type="button" className="ghost" onClick={closePanel}>
              取消
            </button>
            <button
              type="button"
              className="primary"
              disabled={checked.size === 0}
              onClick={confirmAdd}
            >
              确认添加（{checked.size}）
            </button>
          </div>
        </div>
      )}
    </div>
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
        <span className="tag grey">
          {src ? (src.virtual ? '使用者陈述' : src.title) : claim.sourceId}
        </span>
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
      typeof p === 'string' ? (
        <span key={i}>{p}</span>
      ) : (
        <mark className="span-mark" key={i}>
          {p.span}
        </mark>
      ),
    );
  };

  return (
    <aside className="sources-pane">
      <div className="pane-title">已绑定来源</div>
      {sources.length === 0 && <div className="dim pad">暂无</div>}
      {sources.map((s) => {
        const job = state.extractJobs.find((j) => j.sourceId === s.id);
        const claimCount = state.claims.filter((claim) => claim.sourceId === s.id).length;
        const isOpen = openIds.has(s.id);
        return (
          <div
            className="source-card"
            key={s.id}
            ref={(el) => {
              cardRefs.current[s.id] = el;
            }}
          >
            <button className="source-head" onClick={() => toggle(s.id)}>
              <span className={`tri${isOpen ? ' open' : ''}`}>▸</span>
              <span className="source-title">{s.title}</span>
            </button>
            <div className="source-meta">
              <span className="tag path">{s.path}</span>
              <span className="tag role">{bindingRole(s, objectId)}</span>
              {job?.status === '抽取中' && (
                <span className="tag amber">
                  <span className="pulse-dot inline" /> 抽取中
                </span>
              )}
              {job?.status === '失败' && (
                <span className="tag red" title={job.detail}>
                  抽取失败
                </span>
              )}
              {job?.status === '未配置' && <span className="tag grey">未配置模型</span>}
              {job?.status === '完成' && (
                <span className="tag grey">
                  {claimCount > 0 ? `已抽取 ${claimCount} 条` : '无可核对主张'}
                </span>
              )}
              {!job && (
                <span className="tag grey">
                  {claimCount > 0 ? `已有 ${claimCount} 条主张` : '尚未运行'}
                </span>
              )}
              {job?.status !== '抽取中' && (
                <button
                  type="button"
                  className="source-retry"
                  onClick={() =>
                    dispatch({
                      type: 'ENQUEUE_WRITE',
                      draft: {
                        objectId,
                        kind: '重试抽取',
                        sourceId: s.id,
                        headline: '重试抽取？',
                        evidence: `确认后将再次开始抽取「${s.title}」。`,
                      },
                    })
                  }
                >
                  重试
                </button>
              )}
            </div>
            {isOpen && <pre className="source-body small">{renderBody(s.id, s.body)}</pre>}
            {isOpen && (
              <div className="source-bind dim">
                绑定对象：
                {s.boundObjectIds
                  .map((id) => state.objects.find((o) => o.id === id)?.name)
                  .join('、')}
              </div>
            )}
            {isOpen && (
              // 0027：右栏只留入口，解绑/删除/设角色都进主栏确认卡，不在此落账。
              <div className="source-actions">
                <button
                  type="button"
                  className="btn outline sm"
                  onClick={() => {
                    const nextRole: SourceRole =
                      bindingRole(s, objectId) === '主键' ? '转述' : '主键';
                    dispatch({
                      type: 'ENQUEUE_WRITE',
                      draft: {
                        objectId,
                        kind: '设角色',
                        sourceId: s.id,
                        role: nextRole,
                        headline: nextRole === '主键' ? '标为主键？' : '改为转述？',
                        evidence: `来源「${s.title}」当前是${bindingRole(s, objectId)}。确认后只改当前对象上的角色。`,
                      },
                    });
                  }}
                >
                  {bindingRole(s, objectId) === '主键' ? '改为转述' : '标为主键'}
                </button>
                <button
                  type="button"
                  className="btn outline sm"
                  onClick={() => {
                    const objectClaimCount = state.claims.filter(
                      (claim) => claim.sourceId === s.id && claim.objectId === objectId,
                    ).length;
                    const lastBinding = s.boundObjectIds.length === 1;
                    dispatch({
                      type: 'ENQUEUE_WRITE',
                      draft: {
                        objectId,
                        kind: '解绑',
                        sourceId: s.id,
                        headline: '解绑当前对象？',
                        evidence: [
                          `经此来源挂在当前对象上的 ${objectClaimCount} 条主张会离开该对象。`,
                          lastBinding
                            ? '这是最后一个绑定，解绑后回来源 Inbox。'
                            : '来源仍可留在其他对象上。',
                        ].join(''),
                      },
                    });
                  }}
                >
                  解绑当前对象
                </button>
                <button
                  type="button"
                  className="btn outline sm danger-hover"
                  onClick={() => {
                    const claimCount = state.claims.filter(
                      (claim) => claim.sourceId === s.id && claim.status === '成立',
                    ).length;
                    const bindingCount = s.boundObjectIds.length;
                    dispatch({
                      type: 'ENQUEUE_WRITE',
                      draft: {
                        objectId,
                        kind: '删除来源',
                        sourceId: s.id,
                        headline: '删除来源？',
                        evidence: `删除「${s.title}」将移除 ${bindingCount} 个绑定，并把 ${claimCount} 条相关主张关窗为「来源删除」。历史简报保持不变，此操作不提供一键撤销。`,
                      },
                    });
                  }}
                >
                  删除来源
                </button>
              </div>
            )}
          </div>
        );
      })}
      {sources.length > 0 && (
        <button
          className="link pad"
          onClick={() => dispatch({ type: 'SET_VIEW', view: { kind: 'inbox' } })}
        >
          Inbox
        </button>
      )}
    </aside>
  );
}
