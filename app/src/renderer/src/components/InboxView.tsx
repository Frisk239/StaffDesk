import { useEffect, useState } from 'react';
import { UploadSimple } from '@phosphor-icons/react';
import type { Source, State } from '@shared/types';
import { useStore } from '../store';
import { SourceDeleteDialog } from './SourceDeleteDialog';

// Inbox：未绑定来源的进料口。上页必须走绑定，且必须人点「确认绑定」。
// 未绑定来源不投影、不进对象对话默认语境（reducer 保证）。
// 进料三路：粘贴文本/URL、选择文件。读取、抓取、解析全部在主进程完成；
// 失败只留导入任务，不会把 URL 或 PDF 占位写成业务来源。

// 审计 F8：旧库遗留的 unparsed 占位只有说明文字——从 origin 定位或标题/正文里提
// 第一个 http(s) URL 作重导预填；提不出交给用户手粘。宁可空着，不猜协议。
function recoverableUrl(source: Source): string {
  const locator = source.origin?.locator ?? '';
  if (/^https?:\/\//i.test(locator.trim())) return locator.trim();
  const hit = `${source.title}\n${source.body}`.match(/https?:\/\/[^\s<>"']+/i);
  return hit?.[0] ?? '';
}

function originLabel(kind: string | undefined): string {
  if (kind === 'url') return 'URL';
  if (kind === 'file') return '文件';
  if (kind === 'text') return '文本';
  if (kind === 'research') return '调研';
  return '旧版';
}

/** F8：重导预填与输入校验共用的 URL 判定（评审收口：三处字面量提一）。 */
const URL_RE = /^https?:\/\//i;

function latestInboxSourceId(state: State): string | null {
  const ids = state.sources
    .filter(
      (source) =>
        state.inbox.includes(source.id) &&
        !source.virtual &&
        source.workspaceId === state.currentWorkspaceId,
    )
    .map((source) => source.id);
  return ids.at(-1) ?? null;
}

export function InboxView() {
  const { state, dispatch } = useStore();
  const [selectedId, setSelectedId] = useState<string | null>(state.inbox[0] ?? null);
  const [bindOpen, setBindOpen] = useState(false);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [draft, setDraft] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const [deleteSourceId, setDeleteSourceId] = useState<string | null>(null);
  const [refetchUrl, setRefetchUrl] = useState('');
  const looksUrl = URL_RE.test(draft.trim());

  // 拖到窗口其他位置时拦掉浏览器默认行为（打开文件会覆盖整个应用）。
  useEffect(() => {
    const prevent = (e: DragEvent) => e.preventDefault();
    window.addEventListener('dragover', prevent);
    window.addEventListener('drop', prevent);
    return () => {
      window.removeEventListener('dragover', prevent);
      window.removeEventListener('drop', prevent);
    };
  }, []);

  const submitDraft = async () => {
    const body = draft.trim();
    if (!body) return;
    const next = looksUrl
      ? await window.staffdesk.ingestUrl(body)
      : await window.staffdesk.ingestText(body, body.slice(0, 32));
    setSelectedId(latestInboxSourceId(next));
    setDraft('');
  };

  const chooseFiles = async () => {
    const next = await window.staffdesk.chooseAndIngestFiles();
    setSelectedId(latestInboxSourceId(next));
  };

  const ingestDroppedFiles = async (files: FileList) => {
    const droppedFiles = Array.from(files);
    if (droppedFiles.length === 0) return;
    const next = await window.staffdesk.ingestDroppedFiles(droppedFiles);
    setSelectedId(latestInboxSourceId(next));
  };

  const sources = state.sources.filter(
    (s) => state.inbox.includes(s.id) && !s.virtual && s.workspaceId === state.currentWorkspaceId,
  );
  const ingestJobs = state.ingestJobs.filter(
    (job) =>
      job.status !== '完成' && (!job.workspaceId || job.workspaceId === state.currentWorkspaceId),
  );
  const selected = sources.find((s) => s.id === selectedId) ?? null;
  const selectedCanBind = Boolean(selected && !selected.unparsed);

  // 选中变化时刷新重导预填：优先 origin 定位，其次标题/正文里提到的第一个 URL。
  // 预填种子是原始字符串（值比较），effect 不直接引用 selected，避免每次渲染重跑。
  const refetchSeed = selected?.unparsed ? recoverableUrl(selected) : '';
  useEffect(() => {
    setRefetchUrl(refetchSeed);
  }, [refetchSeed]);

  const refetchLegacy = async () => {
    if (!selected?.unparsed) return;
    const url = refetchUrl.trim();
    if (!URL_RE.test(url)) return;
    await window.staffdesk.ingestUrl(url);
  };

  const toggle = (id: string) => {
    const next = new Set(checked);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setChecked(next);
  };

  const confirmBind = () => {
    if (!selected || selected.unparsed || checked.size === 0) return; // 不点确认、不挑对象，就无法绑定
    dispatch({ type: 'BIND_CONFIRMED', sourceId: selected.id, objectIds: [...checked] });
    setBindOpen(false);
    setChecked(new Set());
  };

  return (
    <div className="inbox-layout">
      <div className="inbox-list">
        <div className="pane-title">Inbox</div>
        <div
          className={`inbox-dropzone${dragOver ? ' over' : ''}`}
          role="button"
          tabIndex={0}
          aria-label="选择文件"
          onClick={() => void chooseFiles()}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') void chooseFiles();
          }}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragOver(false);
          }}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            void ingestDroppedFiles(e.dataTransfer.files);
          }}
        >
          <UploadSimple size={18} />
          <span>点击选择文件</span>
          <span className="dim">TXT / Markdown / HTML / PDF 由主进程解析</span>
        </div>
        <form
          className="inbox-drop"
          onSubmit={(e) => {
            e.preventDefault();
            void submitDraft();
          }}
        >
          <textarea
            rows={3}
            value={draft}
            placeholder="粘贴文本或 URL"
            onChange={(e) => setDraft(e.target.value)}
          />
          <button type="submit" className="primary" disabled={!draft.trim()}>
            {looksUrl ? '获取链接' : '加入 Inbox'}
          </button>
        </form>
        {sources.length === 0 && ingestJobs.length === 0 ? (
          <div className="empty-guide">
            <div className="empty-big">没有未绑定材料</div>
          </div>
        ) : (
          <>
            {ingestJobs.map((job) => (
              <div
                key={job.id}
                className={`inbox-card ingest-job${job.status === '失败' ? ' failed' : ''}`}
              >
                <div className="inbox-card-title">{job.title ?? job.locator ?? '导入材料'}</div>
                <div className="inbox-card-meta">
                  <span className={`tag ${job.status === '失败' ? 'red' : 'amber'}`}>
                    {job.status === '失败' ? '导入失败' : job.status}
                  </span>
                  <span className="tag grey">{originLabel(job.inputKind)}</span>
                  {job.failureKind && <span className="tag grey">{job.failureKind}</span>}
                </div>
                {job.detail && <div className="ingest-job-detail">{job.detail}</div>}
                {job.status === '失败' && (
                  <button
                    type="button"
                    className="btn outline sm"
                    onClick={() => void window.staffdesk.retryIngest(job.id)}
                  >
                    重试
                  </button>
                )}
              </div>
            ))}
            {sources.map((s) => (
              <button
                key={s.id}
                className={`inbox-card${selected?.id === s.id ? ' active' : ''}`}
                onClick={() => {
                  setSelectedId(s.id);
                  setBindOpen(false);
                  setChecked(new Set());
                }}
              >
                <div className="inbox-card-title">{s.title}</div>
                <div className="inbox-card-meta">
                  <span className="tag">未绑定</span>
                  <span className="tag path">{s.path}</span>
                  <span className="tag grey">{originLabel(s.origin?.kind)}</span>
                  {s.unparsed && <span className="tag grey">旧版待重新导入</span>}
                </div>
              </button>
            ))}
          </>
        )}
      </div>

      <div className="inbox-detail">
        {!selected ? (
          <div className="empty-guide">
            <p>选一份材料</p>
          </div>
        ) : (
          <>
            <div className="pane-title row">
              <span>{selected.title}</span>
              <span className="tag path">{selected.path}</span>
              <span className="tag grey">{originLabel(selected.origin?.kind)}</span>
              {selected.origin?.pageCount && (
                <span className="tag grey">{selected.origin.pageCount} 页</span>
              )}
              {selected.unparsed && <span className="tag grey">旧版待重新导入</span>}
            </div>
            {selected.origin?.locator && <div className="bind-hint">{selected.origin.locator}</div>}
            <pre className="source-body">{selected.body}</pre>

            {!bindOpen ? (
              selected.unparsed ? (
                <div className="bind-entry">
                  <form
                    className="inbox-drop"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void refetchLegacy();
                    }}
                  >
                    <textarea
                      rows={2}
                      value={refetchUrl}
                      placeholder="粘贴原文链接重新获取"
                      onChange={(e) => setRefetchUrl(e.target.value)}
                    />
                    <button
                      type="submit"
                      className="primary"
                      disabled={!URL_RE.test(refetchUrl.trim())}
                    >
                      重新获取
                    </button>
                  </form>
                  <span className="bind-hint">
                    旧版占位只有说明文字，重新获取原文后才能绑定抽取
                  </span>
                  {/* Spec 评审（M32）：删除出口无条件——原 URL 已死的占位也必须能删（坏了能救），不与重导成败挂钩。 */}
                  <button
                    type="button"
                    className="btn outline sm danger-hover"
                    onClick={() => setDeleteSourceId(selected.id)}
                  >
                    删除占位
                  </button>
                </div>
              ) : (
                <div className="bind-entry">
                  <button
                    className="primary"
                    disabled={!selectedCanBind}
                    onClick={() => setBindOpen(true)}
                  >
                    绑定
                  </button>
                  <button
                    type="button"
                    className="btn outline sm danger-hover"
                    onClick={() => setDeleteSourceId(selected.id)}
                  >
                    删除来源
                  </button>
                </div>
              )
            ) : (
              <div className="bind-panel">
                <div className="bind-panel-title">绑定到</div>
                {(['组织', '项目', '人'] as const).map((k) => (
                  <div className="bind-group" key={k}>
                    <div className="bind-group-title">{k}</div>
                    {state.objects
                      .filter(
                        (o) =>
                          o.workspaceId === state.currentWorkspaceId && !o.archived && o.kind === k,
                      )
                      .map((o) => {
                        const suggest =
                          selected.body.includes(o.name) || selected.title.includes(o.name);
                        return (
                          <label
                            key={o.id}
                            className={`bind-option${checked.has(o.id) ? ' on' : ''}`}
                          >
                            <input
                              type="checkbox"
                              checked={checked.has(o.id)}
                              onChange={() => toggle(o.id)}
                            />
                            <span>{o.name}</span>
                            {o.note && <span className="dim">{o.note}</span>}
                            {suggest && <span className="tag suggest">系统建议</span>}
                          </label>
                        );
                      })}
                  </div>
                ))}
                <div className="bind-actions">
                  <button className="ghost" onClick={() => setBindOpen(false)}>
                    取消
                  </button>
                  <button className="primary" disabled={checked.size === 0} onClick={confirmBind}>
                    确认绑定（{checked.size}）
                  </button>
                </div>
                {checked.size === 0 && <div className="bind-warn">至少选一个对象</div>}
              </div>
            )}
          </>
        )}
      </div>
      {deleteSourceId && (
        <SourceDeleteDialog sourceId={deleteSourceId} onClose={() => setDeleteSourceId(null)} />
      )}
    </div>
  );
}
