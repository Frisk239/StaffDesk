import { useState } from 'react';
import { useStore } from '../store';
import { briefToMarkdown } from '@shared/briefMarkdown';

export function BriefView({ objectId }: { objectId: string }) {
  const { state, dispatch } = useStore();
  const [picked, setPicked] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const history = state.briefs.filter((b) => b.objectId === objectId);
  const latestId = history[history.length - 1]?.id ?? null;
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

  // 审计 F4：复制与导出共用同一份 Markdown 组装，两处出口不漂移。
  const markdown = () =>
    briefToMarkdown({
      brief,
      objectName: obj.name,
      headLine: task
        ? `${task.kind} · ${task.id} · ${brief.createdAt}`
        : `${brief.taskId} · ${brief.createdAt}`,
      claims: state.claims,
      sources: state.sources,
    });

  const copyMarkdown = async () => {
    try {
      // 审计 F4：复制走主进程 clipboard IPC——0047 权限全拒会拦下 navigator.clipboard。
      await window.staffdesk.copyBrief(markdown());
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      /* 复制失败时保持原状态，不打断阅读。 */
    }
  };

  const exportMarkdown = async () => {
    try {
      const result = await window.staffdesk.exportBrief(markdown(), obj.name);
      // 用户取消保存对话框返回 null——那是用户主动行为，不弹提示。
      if (result) {
        dispatch({ type: 'TOAST', text: `简报已导出：${result.filePath}` });
      }
    } catch (error) {
      // 审计五轮（M35 期间两度目击静默失败）：导出异常必须给用户反馈，不许吞。
      const detail = error instanceof Error ? error.message : String(error);
      dispatch({ type: 'TOAST', text: `导出失败：${detail}` });
    }
  };

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
          <div className="brief-actions">
            <button type="button" className="btn outline sm" onClick={() => void copyMarkdown()}>
              {copied ? '已复制' : '复制 Markdown'}
            </button>
            <button type="button" className="btn outline sm" onClick={() => void exportMarkdown()}>
              导出 .md
            </button>
          </div>
        </header>

        {brief.blocks.map((block) => (
          <section className="brief-block" key={block.title}>
            <h2>{block.title}</h2>
            {block.sentences.map((s, i) => (
              <div className={`brief-sentence ${s.kind}`} key={i}>
                {s.kind === 'unknown' && <span className="unknown-mark">未知</span>}
                {s.kind === 'synthesis' && <span className="tag grey">综合</span>}
                {s.flag && (
                  <span className={`tag ${s.flag.includes('冲突') ? 'red' : 'grey'}`}>
                    {s.flag}
                  </span>
                )}
                {s.primarySourceIds && s.primarySourceIds.length > 0 && (
                  <span className="tag role" title="句内主张出自主键来源绑定">
                    主键来源
                  </span>
                )}
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
                    <button
                      key={cid}
                      className="ref-chip"
                      onClick={() => dispatch({ type: 'OPEN_AUDIT_CARD', claimId: cid })}
                    >
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
