import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  ArrowUp,
  BookOpen,
  Brain,
  CaretRight,
  FileText,
  FloppyDisk,
  Lightbulb,
  MagnifyingGlass,
  WarningCircle,
} from '@phosphor-icons/react';
import { Markdown } from '../markdown';
import { ComposerMenu } from './ComposerMenu';
import { AuditCard } from './cards/AuditCard';
import { ResultCard } from './cards/ResultCard';
import { Takeover } from './Takeover';
import { useStore } from '../store';
import { thinkMs } from '../turn';
import type { ThinkCopy, ThinkingEffort, ToolCall } from '../types';

// 对话面：视觉对齐 DSH（用户 22px 淡蓝气泡、assistant 无气泡叙述流、
// DisclosureRow 思考行、ToolRow 扫光 + IN/OUT 卡、22px composer、流式 markdown）。
// 工具行是展示层：只读账本，不把假检索灌进去。

export function ChatPane({ objectId }: { objectId: string }) {
  const { state, dispatch } = useStore();
  const [text, setText] = useState('');
  const [stream, setStream] = useState<StreamState | null>(null);
  const seenIds = useRef<Set<string>>(new Set());
  const localQueued = state.writeQueue.some((w) => w.objectId === objectId);
  const otherQueued = state.writeQueue.some((w) => w.objectId !== objectId);
  const scrollRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const obj = state.objects.find((o) => o.id === objectId)!;
  const messages = state.chatByObject[objectId] ?? [];
  const selected = state.claims.find((c) => c.id === state.selectedClaimId);
  const lastMsg = messages[messages.length - 1];
  // 空态引导：从已有主张的谓词生成建议问题，零主张时给通用问法。
  const suggestQuestions = (() => {
    const preds = [
      ...new Set(
        state.claims
          .filter((c) => c.objectId === objectId && c.status !== '过时' && c.predicate !== '未编目')
          .map((c) => c.predicate),
      ),
    ];
    if (preds.length >= 2) return preds.slice(0, 2).map((p) => `${p}是什么`);
    if (preds.length === 1) return [`${preds[0]}是什么`, '有什么主张'];
    return ['有什么主张', '你是谁'];
  })();

  useEffect(() => {
    setStream(null);
  }, [objectId]);

  useEffect(() => {
    if (!lastMsg || lastMsg.role !== 'desk' || seenIds.current.has(lastMsg.id)) return;
    seenIds.current.add(lastMsg.id);
    if (lastMsg.turn && !lastMsg.turn.played) {
      dispatch({ type: 'MARK_TURN_PLAYED', objectId, messageId: lastMsg.id });
    }
    const tools = lastMsg.turn?.tools ?? [];
    const thinkWait = thinkMs(state.thinkingEffort);
    const think = lastMsg.turn?.think ?? { runningTitle: '', doneTitle: '', summary: '', body: '' };
    const msgId = lastMsg.id;
    const total = lastMsg.text.length;
    let cancelled = false;
    let iv = 0;

    const wait = (ms: number) =>
      new Promise<void>((resolve) => {
        window.setTimeout(resolve, ms);
      });

    const run = async () => {
      if (thinkWait > 0) {
        setStream({ msgId, phase: 'think', tools, running: -1, shown: 0, think });
        await wait(thinkWait);
        if (cancelled) return;
      }
      for (let i = 0; i < tools.length; i++) {
        setStream({ msgId, phase: 'tools', tools, running: i, shown: 0, think });
        await wait(540);
        if (cancelled) return;
      }
      setStream({ msgId, phase: 'type', tools, running: -1, shown: 0, think });
      const step = Math.max(1, Math.ceil(total / 52));
      await new Promise<void>((resolve) => {
        iv = window.setInterval(() => {
          if (cancelled) {
            window.clearInterval(iv);
            resolve();
            return;
          }
          setStream((cur) => {
            if (!cur || cur.msgId !== msgId) return cur;
            const shown = cur.shown + step;
            if (shown >= total) {
              window.clearInterval(iv);
              resolve();
              return { ...cur, shown: total, phase: 'done' };
            }
            return { ...cur, shown };
          });
        }, 20);
      });
      if (cancelled) return;
      setStream(null);
    };
    void run();
    return () => {
      cancelled = true;
      if (iv) window.clearInterval(iv);
    };
    // 只跟新 desk 消息走；state 在发送当下冻结进 planTools
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastMsg?.id]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages.length, stream?.shown, stream?.phase, stream?.running]);

  const send = () => {
    if (!text.trim() || stream || localQueued) return;
    dispatch({ type: 'CHAT_SEND', objectId, text: text.trim() });
    setText('');
    if (taRef.current) {
      taRef.current.style.height = 'auto';
    }
  };

  const grow = () => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 216)}px`;
  };

  return (
    <section className="chat-pane">
          <div className="chat-scroll" ref={scrollRef}>
            {messages.length === 0 && (
              <div className="chat-empty">
                <div className="chat-empty-name">{obj.name}</div>
                <div className="chat-empty-questions">
                  {suggestQuestions.map((q) => (
                    <button key={q} type="button" className="chip" onClick={() => { setText(q); taRef.current?.focus(); }}>
                      {q}
                    </button>
                  ))}
                </div>
                <div className="dim">
                  默认只问、只解释、带引用；写账本走「记下来 / 这句不对」。没材料就答未知，先去 Inbox 绑材料。
                </div>
                {selected && (
                  <div>
                    <button className="btn ghost sm" onClick={() => dispatch({ type: 'OPEN_AUDIT_CARD', claimId: selected.id })}>
                      {selected.text.slice(0, 24)}
                    </button>
                  </div>
                )}
              </div>
            )}
            {messages.map((m) => {
              if (m.role === 'card' && m.card) {
                return (
                  <div key={m.id} className="msg desk">
                    <div className="desk-flow">
                      {m.card.kind === '审计' && m.card.claimId && <AuditCard claimId={m.card.claimId} />}
                      {m.card.kind === '结果' && (
                        <ResultCard card={m.card} text={m.text} objectId={objectId} messageId={m.id} />
                      )}
                    </div>
                  </div>
                );
              }
              if (m.role !== 'desk' && m.role !== 'user') return null;
              if (m.role === 'user') {
                return (
                  <div key={m.id} className="msg user">
                    <div className="user-stack">
                      <div className="bubble">{m.text}</div>
                    </div>
                  </div>
                );
              }
              const live = stream && stream.msgId === m.id ? stream : null;
              const settled = m.turn;
              const tools = live?.tools ?? settled?.tools ?? [];
              const think = live?.think ?? settled?.think;
              const showThink = Boolean(think?.doneTitle);
              const thinkRunning = live?.phase === 'think';
              const typed = live && (live.phase === 'type' || live.phase === 'done') ? m.text.slice(0, live.shown) : live ? '' : m.text;
              const showAnswer = !live || live.phase === 'type' || live.phase === 'done';
              const showRefs = !live && m.claimRefs && m.claimRefs.length > 0;
              return (
                <div key={m.id} className="msg desk">
                  <div className="desk-flow">
                    {showThink && think && (
                      <ReasoningRow
                        running={thinkRunning}
                        title={thinkRunning ? think.runningTitle : think.doneTitle}
                        summary={think.summary}
                        body={think.body}
                      />
                    )}
                    {(live?.phase === 'tools' || live?.phase === 'type' || live?.phase === 'done' || settled) &&
                      tools.map((tool, i) => {
                        const running = live?.phase === 'tools' && live.running === i;
                        const visible = !live || live.phase !== 'tools' || i <= live.running;
                        if (!visible) return null;
                        return <ToolRowView key={tool.id} tool={tool} running={running} />;
                      })}
                    {live?.phase === 'think' && (
                      <div className="turn-status">
                        正在从账本里挑主张
                        <span className="turn-status-clock">核对中</span>
                      </div>
                    )}
                    {showAnswer && typed && (
                      <div className="desk-answer">
                        <Markdown text={typed} caret={Boolean(live && live.phase === 'type' && live.shown < m.text.length)} />
                        {m.note && !live && <div className="msg-note">{m.note}</div>}
                        {showRefs && (
                          <div className="msg-refs">
                            {m.claimRefs!.map((cid, i) => {
                              const c = state.claims.find((x) => x.id === cid);
                              if (!c) return null;
                              return (
                                <span key={cid}>
                                  <button
                                    className="ref-chip"
                                    style={{ animationDelay: `${i * 60}ms` }}
                                    onClick={() => dispatch({ type: 'OPEN_AUDIT_CARD', claimId: cid })}
                                  >
                                    〔{c.predicate}〕{c.text.slice(0, 14)}…
                                  </button>
                                  <button
                                    className="ref-wrong"
                                    style={{ animationDelay: `${i * 60}ms` }}
                                    title="这句不对：走纠正"
                                    onClick={() => dispatch({ type: 'OPEN_CORRECT_CARD', claimId: cid })}
                                  >
                                    ✗
                                  </button>
                                </span>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
          {localQueued ? (
            <Takeover objectId={objectId} />
          ) : (
          <>
          {otherQueued && <Takeover objectId={objectId} />}
          <div className="composer">
            <div className="composer-card">
              <textarea
                ref={taRef}
                rows={1}
                value={text}
                placeholder={`问 ${obj.name}`}
                onChange={(e) => {
                  setText(e.target.value);
                  grow();
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    send();
                  }
                }}
              />
              <div className="composer-row">
                <span className="composer-hint">Enter 发送</span>
                <div className="composer-trailing">
                  <ComposerMenu
                    label="模型"
                    value={state.activeModelId}
                    options={state.providers
                      .filter((p) => p.enabled)
                      .flatMap((p) => p.models.map((m) => ({ id: m.id, label: m.name })))}
                    onChange={(id) => {
                      const owner = state.providers.find((p) => p.models.some((m) => m.id === id));
                      if (owner && owner.id !== state.activeProviderId) {
                        dispatch({ type: 'SET_ACTIVE_PROVIDER', id: owner.id });
                      }
                      dispatch({ type: 'SET_ACTIVE_MODEL', id });
                    }}
                  />
                  <ComposerMenu
                    label="思考强度"
                    icon={<Brain size={14} />}
                    value={state.thinkingEffort}
                    options={[
                      { id: '关闭', label: '关闭' },
                      { id: '低', label: '低' },
                      { id: '中', label: '中' },
                      { id: '高', label: '高' },
                    ]}
                    onChange={(id) => dispatch({ type: 'SET_THINKING', effort: id as ThinkingEffort })}
                  />
                  <button
                    className="composer-send"
                    type="button"
                    disabled={!text.trim() || Boolean(stream)}
                    onClick={send}
                    aria-label="发送"
                  >
                    <ArrowUp size={16} weight="bold" />
                  </button>
                </div>
              </div>
            </div>
          </div>
          </>
          )}
    </section>
  );
}

interface StreamState {
  msgId: string;
  phase: 'think' | 'tools' | 'type' | 'done';
  tools: ToolCall[];
  running: number;
  shown: number;
  think: ThinkCopy;
}

function toolIcon(kind: ToolCall['icon']): ReactNode {
  switch (kind) {
    case 'book':
      return <BookOpen size={14} />;
    case 'file':
      return <FileText size={14} />;
    case 'disk':
      return <FloppyDisk size={14} />;
    case 'warn':
      return <WarningCircle size={14} />;
    case 'search':
      return <MagnifyingGlass size={14} />;
  }
}

function StateMark({ running, done }: { running: boolean; done: boolean }) {
  if (running) {
    return (
      <svg className="state-matrix" width="10" height="10" viewBox="0 0 10 10" shapeRendering="crispEdges" aria-hidden>
        {[
          [0, 0],
          [4, 0],
          [8, 0],
          [8, 4],
          [8, 8],
          [4, 8],
          [0, 8],
          [0, 4],
        ].map(([x, y], i) => (
          <rect key={`${x}-${y}`} className="state-cell" x={x} y={y} width="2" height="2" style={{ animationDelay: `${(i - 8) * 125}ms` }} />
        ))}
      </svg>
    );
  }
  if (done) return <span className="state-dot" data-state="done" />;
  return null;
}

function ReasoningRow({
  running,
  title,
  summary,
  body,
}: {
  running: boolean;
  title: string;
  summary: string;
  body: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`flow-row${running ? ' running' : ''}`}>
      <button className="flow-row-head" type="button" onClick={() => setOpen((v) => !v)}>
        <span className="flow-leading">
          <span className="flow-icon-idle">
            {running ? <StateMark running done={false} /> : <Lightbulb size={14} />}
          </span>
          <span className="flow-chevron">
            <CaretRight size={12} style={{ transform: open ? 'rotate(90deg)' : undefined }} />
          </span>
        </span>
        <span className="flow-title">{title}</span>
        <span className="flow-sep" />
        <span className="flow-summary">{summary}</span>
      </button>
      {open && <div className="think-body">{body}</div>}
    </div>
  );
}

function ToolRowView({ tool, running }: { tool: ToolCall; running: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`flow-row${running ? ' running' : ''}`} data-state={running ? 'running' : 'done'}>
      <button className="flow-row-head" type="button" onClick={() => !running && setOpen((v) => !v)}>
        <span className="flow-leading">
          <span className="flow-icon-idle">{running ? <StateMark running done={false} /> : toolIcon(tool.icon)}</span>
          <span className="flow-chevron">
            <CaretRight size={12} style={{ transform: open ? 'rotate(90deg)' : undefined }} />
          </span>
        </span>
        <span className="flow-title">{tool.title}</span>
        <span className="flow-sep" />
        <span className="flow-tail">
          <span className="flow-summary">{tool.summary}</span>
          {!running && <StateMark running={false} done />}
        </span>
      </button>
      {open && !running && (
        <div className="io-card">
          <div className="io-section">
            <span className="io-label">IN</span>
            <pre className="io-text">{tool.input}</pre>
          </div>
          <div className="io-divider" />
          <div className="io-section">
            <span className="io-label">OUT</span>
            <pre className="io-text">{tool.output}</pre>
          </div>
        </div>
      )}
    </div>
  );
}
