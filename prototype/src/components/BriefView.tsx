import { useState } from 'react';
import { useStore } from '../store';

export function BriefView({ objectId }: { objectId: string }) {
  const { state, dispatch } = useStore();
  const history = state.briefs.filter((b) => b.objectId === objectId);
  const latestId = history[history.length - 1]?.id ?? null;
  const [picked, setPicked] = useState<string | null>(null);
  const briefId = picked && history.some((b) => b.id === picked) ? picked : latestId;
  const brief = state.briefs.find((b) => b.id === briefId);
  if (!brief) {
    return (
      <div className="empty-guide">
        <div className="empty-big">还没有简报</div>
      </div>
    );
  }
  const obj = state.objects.find((o) => o.id === brief.objectId);
  if (!obj) return null;
  const task = state.tasks.find((t) => t.id === brief.taskId);

  return (
    <div className="brief-view embedded">
      {history.length > 1 && (
        <div className="brief-history">
          {history.map((b) => {
            const t = state.tasks.find((x) => x.id === b.taskId);
            return (
              <button
                key={b.id}
                type="button"
                className={`chip${b.id === brief.id ? ' on' : ''}`}
                onClick={() => setPicked(b.id)}
              >
                {t?.kind ?? '出简报'} · {b.createdAt}
              </button>
            );
          })}
        </div>
      )}

      <div className="brief-main">
        <header className="brief-head">
          <h1>{obj.name}</h1>
          <div className="dim mono">
            {task ? `${task.kind} · ${task.id}` : brief.taskId} · {brief.createdAt}
          </div>
        </header>

        {brief.blocks.map((block) => (
          <section className="brief-block" key={block.title}>
            <h2>{block.title}</h2>
            {block.sentences.map((s, i) => (
              <div className={`brief-sentence ${s.kind}`} key={i}>
                {s.kind === 'unknown' && <span className="unknown-mark">未知</span>}
                {s.kind === 'synthesis' && <span className="tag grey">综合</span>}
                {s.flag && <span className={`tag ${s.flag.includes('冲突') ? 'red' : 'grey'}`}>{s.flag}</span>}
                <span className="sentence-text">
                  {s.lines && s.lines.length > 0
                    ? s.lines.map((line, li) => (
                        <span key={li} className="sentence-line">
                          {line}
                        </span>
                      ))
                    : s.text}
                </span>
                {s.unverified && <span className="tag amber">未核</span>}
                {s.claimIds.map((cid) => {
                  const c = state.claims.find((x) => x.id === cid);
                  return c ? (
                    <button key={cid} className="ref-chip" onClick={() => dispatch({ type: 'OPEN_AUDIT_CARD', claimId: cid })}>
                      〔{c.predicate}〕{c.text.slice(0, 12)}…
                    </button>
                  ) : null;
                })}
              </div>
            ))}
          </section>
        ))}
      </div>
    </div>
  );
}
