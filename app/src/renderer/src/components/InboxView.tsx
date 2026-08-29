import { useEffect, useRef, useState } from 'react';
import { UploadSimple } from '@phosphor-icons/react';
import { useStore } from '../store';

// Inbox：未绑定来源的进料口。上页必须走绑定，且必须人点「确认绑定」。
// 未绑定来源不投影、不进对象对话默认语境（reducer 保证）。
// 进料三路：粘贴文本/URL、拖入文件、选择文件。文本文件直接读正文；
// PDF/二进制收下但诚实标注「成品才解析」（与 URL 的「成品才抓」同构，不假装解析）。

const TEXT_FILE_RE = /\.(txt|md|markdown|csv|json|html?|htm|log|ya?ml|xml|ts|tsx|js|jsx)$/i;

function isTextFile(f: File): boolean {
  return f.type.startsWith('text/') || TEXT_FILE_RE.test(f.name);
}

const MAX_BODY = 200_000;

export function InboxView() {
  const { state, dispatch } = useStore();
  const [selectedId, setSelectedId] = useState<string | null>(state.inbox[0] ?? null);
  const [bindOpen, setBindOpen] = useState(false);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [draft, setDraft] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const looksUrl = /^https?:\/\//i.test(draft.trim());

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

  const handleFiles = async (files: FileList | File[]) => {
    const list = Array.from(files);
    if (list.length === 0) return;
    const start = state.seq;
    let added = 0;
    let lastBodyEmpty = false;
    for (const f of list) {
      let body: string;
      let unparsed = false;
      if (isTextFile(f)) {
        const text = await f.text();
        body = text.length > MAX_BODY ? `${text.slice(0, MAX_BODY)}\n…（超长截断）` : text;
        if (!body.trim()) {
          lastBodyEmpty = true;
          continue; // 空文本文件：没有可指向的原文，不写来源
        }
      } else if (f.type === 'application/pdf' || /\.pdf$/i.test(f.name)) {
        body = `（PDF「${f.name}」已收下。原型不解析 PDF，成品才解析并抽取；此处暂存文件名。）`;
        unparsed = true;
      } else {
        body = `（文件「${f.name}」已收下。原型不解析该格式，成品才解析；此处暂存文件名。）`;
        unparsed = true;
      }
      dispatch({ type: 'ADD_SOURCE', title: f.name, body, unparsed });
      added += 1;
    }
    // 投料后自动选中新来源；全被跳过（空文件）时不选。
    if (added > 0) setSelectedId(`src-${start + added - 1}`);
    else if (lastBodyEmpty) dispatch({ type: 'TOAST', text: '空文件没有可指向的原文，未收' });
  };

  const sources = state.sources.filter(
    (s) => state.inbox.includes(s.id) && !s.virtual && s.workspaceId === state.currentWorkspaceId,
  );
  const selected = sources.find((s) => s.id === selectedId) ?? null;

  const toggle = (id: string) => {
    const next = new Set(checked);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setChecked(next);
  };

  const confirmBind = () => {
    if (!selected || checked.size === 0) return; // 不点确认、不挑对象，就无法绑定
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
          aria-label="拖入文件或点击选择文件"
          onClick={() => fileInputRef.current?.click()}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') fileInputRef.current?.click();
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
            void handleFiles(e.dataTransfer.files);
          }}
        >
          <UploadSimple size={18} />
          <span>拖文件到这里，或点击选择文件</span>
          <span className="dim">文本文件直接读入 · PDF / 其他格式收下待成品解析</span>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files) void handleFiles(e.target.files);
            e.target.value = '';
          }}
        />
        <form
          className="inbox-drop"
          onSubmit={(e) => {
            e.preventDefault();
            const body = draft.trim();
            if (!body) return;
            dispatch({
              type: 'ADD_SOURCE',
              title: looksUrl ? (body.split(/[?#\s]/)[0] ?? body.slice(0, 32)) : body.slice(0, 32),
              body,
              fromUrl: looksUrl,
            });
            // 投料后自动选中新来源（id 规则：src-{seq}，见 store 的 nextId），不用再点一次卡片。
            setSelectedId(`src-${state.seq}`);
            setDraft('');
          }}
        >
          <textarea
            rows={3}
            value={draft}
            placeholder="粘贴文本或 URL"
            onChange={(e) => setDraft(e.target.value)}
          />
          <button type="submit" className="primary" disabled={!draft.trim()}>
            {looksUrl ? '收下（成品才抓）' : '加入 Inbox'}
          </button>
        </form>
        {sources.length === 0 ? (
          <div className="empty-guide">
            <div className="empty-big">没有未绑定材料</div>
          </div>
        ) : (
          sources.map((s) => (
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
                {s.role && <span className="tag role">{s.role}</span>}
                {s.unparsed && <span className="tag grey">成品才解析</span>}
                {!s.unparsed && /^https?:\/\//i.test(s.body.trim()) && <span className="tag grey">成品才抓</span>}
              </div>
            </button>
          ))
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
              {selected.role && <span className="tag role">{selected.role}</span>}
              {selected.unparsed && <span className="tag grey">成品才解析</span>}
            </div>
            <pre className="source-body">{selected.body}</pre>

            {!bindOpen ? (
              <div className="bind-entry">
                <button className="primary" onClick={() => setBindOpen(true)}>
                  绑定
                </button>
              </div>
            ) : (
              <div className="bind-panel">
                <div className="bind-panel-title">绑定到</div>
                {(['组织', '项目', '人'] as const).map((k) => (
                  <div className="bind-group" key={k}>
                    <div className="bind-group-title">{k}</div>
                    {state.objects
                      .filter((o) => o.workspaceId === state.currentWorkspaceId && !o.archived && o.kind === k)
                      .map((o) => {
                        const suggest =
                          selected.id === 'src-jd' &&
                          ((k === '组织' && o.id === 'org-zhanqiao') || (k === '项目' && o.id === 'proj-2026-autumn'));
                        return (
                          <label key={o.id} className={`bind-option${checked.has(o.id) ? ' on' : ''}`}>
                            <input type="checkbox" checked={checked.has(o.id)} onChange={() => toggle(o.id)} />
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
    </div>
  );
}
