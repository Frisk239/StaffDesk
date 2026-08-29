import { useCallback, useEffect, useRef, useState } from 'react';
import { StoreProvider, useStore } from './store';
import { ChatTopbar, IconRail, SessionList, ThemeSync, TitleBar, Toast } from './components/Chrome';
import { InboxView } from './components/InboxView';
import { ReplayView } from './components/ReplayView';
import { PendingView } from './components/PendingView';
import { AllObjectsView } from './components/AllObjects';
import { ChatPane } from './components/ChatPane';
import { RightPanel } from './components/RightPanel';
import { SettingsModal } from './components/Settings';
import { Onboarding } from './components/Onboarding';
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

  useEffect(() => {
    // 调度集合与当前「抽取中」作业对齐：作业消失（如绑定被撤销）就解除占用，重新绑定能再次调度。
    const pending = new Set(state.extractJobs.filter((j) => j.status === '抽取中').map((j) => j.sourceId));
    for (const id of [...scheduled.current]) if (!pending.has(id)) scheduled.current.delete(id);
    for (const id of pending) {
      if (!scheduled.current.has(id)) {
        scheduled.current.add(id);
        void window.staffdesk.runExtract(id);
      }
    }
  }, [state.extractJobs, dispatch]);

  useEffect(() => {
    if (!state.briefDraftingFor) return;
    void window.staffdesk.generateBrief(state.briefDraftingFor);
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
  const [onboarding, setOnboarding] = useState(!state.onboardingDone);
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
            onContinueSetup={() => setOnboarding(true)}
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
            {view.kind === 'replay' && <ReplayView taskId={view.taskId} />}
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
      {(onboarding && !state.onboardingDone) && <Onboarding onClose={() => setOnboarding(false)} />}
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
