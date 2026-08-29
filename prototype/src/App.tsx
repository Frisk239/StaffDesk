import { useCallback, useEffect, useRef, useState } from 'react';
import { StoreProvider, useStore } from './store';
import { ChatTopbar, IconRail, SessionList, ThemeSync, TitleBar, Toast } from './components/Chrome';
import { InboxView } from './components/InboxView';
import { PendingView } from './components/PendingView';
import { AllObjectsView } from './components/AllObjects';
import { ChatPane } from './components/ChatPane';
import { RightPanel } from './components/RightPanel';
import { SettingsModal } from './components/Settings';
import { DragHandle } from './components/DragHandle';

const RAIL = 56;
const SESSION_MIN = 180;
const SESSION_MAX = 360;
const SESSION_DEFAULT = 232;
const RIGHT_MIN = 280;
const RIGHT_MAX = 560;
const RIGHT_DEFAULT = 400;
const CHAT_MIN = 420;

function clamp(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, Math.round(n)));
}

function Effects() {
  const { state, dispatch } = useStore();
  const scheduled = useRef<Set<string>>(new Set());
  const certScheduled = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    // 调度集合与当前「抽取中」作业对齐：作业消失（如绑定被撤销）就解除占用，重新绑定能再次调度。
    const pending = new Set(state.extractJobs.filter((j) => j.status === '抽取中').map((j) => j.sourceId));
    for (const id of [...scheduled.current]) if (!pending.has(id)) scheduled.current.delete(id);
    for (const id of pending) {
      if (!scheduled.current.has(id)) {
        scheduled.current.add(id);
        window.setTimeout(() => dispatch({ type: 'EXTRACT_DONE', sourceId: id }), 1000);
      }
    }
  }, [state.extractJobs, dispatch]);

  // 0039：认证中 → 2 秒后出分（按 startedAt 防重，重复测试可再跑）。
  useEffect(() => {
    for (const [id, cert] of Object.entries(state.certByProvider)) {
      if (cert.status === '认证中' && cert.startedAt && certScheduled.current.get(id) !== cert.startedAt) {
        certScheduled.current.set(id, cert.startedAt);
        window.setTimeout(() => dispatch({ type: 'CERT_DONE', id }), 2000);
      }
    }
  }, [state.certByProvider, dispatch]);

  useEffect(() => {
    if (!state.briefDraftingFor) return;
    const t = window.setTimeout(() => dispatch({ type: 'GENERATE_BRIEF_DONE' }), 700);
    return () => window.clearTimeout(t);
  }, [state.briefDraftingFor, dispatch]);

  useEffect(() => {
    if (!state.toast) return;
    const t = window.setTimeout(() => dispatch({ type: 'TOAST', text: null }), 3200);
    return () => window.clearTimeout(t);
  }, [state.toast, dispatch]);

  return null;
}

function Workspace() {
  const { state } = useStore();
  const [settings, setSettings] = useState(false);
  const [sessionOpen, setSessionOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);
  const [sessionW, setSessionW] = useState(SESSION_DEFAULT);
  const [rightW, setRightW] = useState(RIGHT_DEFAULT);
  const [dragging, setDragging] = useState(false);
  const sessionBase = useRef(SESSION_DEFAULT);
  const rightBase = useRef(RIGHT_DEFAULT);
  const view = state.view;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.altKey && (e.key === 'b' || e.key === 'B')) {
        e.preventDefault();
        setRightOpen((v) => !v);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  // 窄窗主栏优先：resize 时若主栏会被挤到 420px 以下，自动收起右栏。不监听 rightOpen，以免挡手动展开。
  useEffect(() => {
    const fit = () => {
      const session = sessionOpen ? sessionW : 0;
      const chatSpace = window.innerWidth - RAIL - session - rightW;
      if (chatSpace < CHAT_MIN) setRightOpen(false);
    };
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, [sessionOpen, sessionW, rightW]);

  const onSessionStart = useCallback(() => {
    sessionBase.current = sessionW;
    setDragging(true);
  }, [sessionW]);

  const onSessionDrag = useCallback((dx: number) => {
    setSessionW(clamp(sessionBase.current + dx, SESSION_MIN, SESSION_MAX));
  }, []);

  const onSessionEnd = useCallback(() => {
    setDragging(false);
  }, []);

  const onRightStart = useCallback(() => {
    rightBase.current = rightW;
    setDragging(true);
  }, [rightW]);

  const onRightDrag = useCallback((dx: number) => {
    setRightW(clamp(rightBase.current - dx, RIGHT_MIN, RIGHT_MAX));
  }, []);

  const onRightEnd = useCallback(() => {
    setDragging(false);
  }, []);

  return (
    <div className="desktop">
      <div className="window">
        <TitleBar />
        <div className={`body${dragging ? ' dragging' : ''}`}>
          <IconRail
            onSettings={() => setSettings(true)}
            sessionOpen={sessionOpen}
            onToggleSession={() => setSessionOpen((v) => !v)}
          />
          <SessionList width={sessionW} open={sessionOpen} />
          {sessionOpen && (
            <DragHandle
              side="session"
              style={{ left: RAIL + sessionW - 4 }}
              onStart={onSessionStart}
              onDrag={onSessionDrag}
              onEnd={onSessionEnd}
            />
          )}
          <div className="main" key={state.currentWorkspaceId}>
            {view.kind === 'inbox' && <InboxView />}
            {view.kind === 'pending' && <PendingView />}
            {view.kind === 'all' && <AllObjectsView />}
            {view.kind === 'object' && (
              <>
                <ChatTopbar rightOpen={rightOpen} onToggleRight={() => setRightOpen((v) => !v)} />
                <div className="work-row">
                  <ChatPane objectId={view.objectId} />
                  <RightPanel objectId={view.objectId} width={rightW} open={rightOpen} />
                  {rightOpen && (
                    <DragHandle
                      side="details"
                      style={{ right: rightW - 4 }}
                      onStart={onRightStart}
                      onDrag={onRightDrag}
                      onEnd={onRightEnd}
                    />
                  )}
                </div>
              </>
            )}
          </div>
        </div>
        <SettingsModal open={settings} onClose={() => setSettings(false)} />
      </div>
      <Toast />
    </div>
  );
}

export default function App() {
  return (
    <StoreProvider>
      <ThemeSync />
      <Effects />
      <Workspace />
    </StoreProvider>
  );
}
