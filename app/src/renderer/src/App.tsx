import { useCallback, useEffect, useRef, useState } from 'react';
import { StoreProvider, useStore } from './store';
import { ChatTopbar, IconRail, SessionList, ThemeSync, TitleBar, Toast } from './components/Chrome';
import { InboxView } from './components/InboxView';
import { ReplayView } from './components/ReplayView';
import { TasksView } from './components/TasksView';
import { PendingView } from './components/PendingView';
import { AllObjectsView } from './components/AllObjects';
import { ChatPane } from './components/ChatPane';
import { RightPanel } from './components/RightPanel';
import { SettingsModal, type SettingsSection } from './components/Settings';
import { Onboarding } from './components/Onboarding';
import { DragHandle } from './components/DragHandle';
import {
  fitWorkspaceLayout,
  RIGHT_DEFAULT_WIDTH,
  RIGHT_MAX_WIDTH,
  RIGHT_MIN_WIDTH,
  SESSION_DEFAULT_WIDTH,
  SESSION_MAX_WIDTH,
  SESSION_MIN_WIDTH,
  WORKSPACE_RAIL_WIDTH,
} from '@shared/layout';

function clamp(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, Math.round(n)));
}

function Effects() {
  const { state, dispatch } = useStore();
  const scheduled = useRef<Set<string>>(new Set());

  useEffect(() => {
    // 调度集合与当前「抽取中」作业对齐：作业消失（如绑定被撤销）就解除占用，重新绑定能再次调度。
    const pending = new Set(
      state.extractJobs.filter((j) => j.status === '抽取中').map((j) => j.sourceId),
    );
    for (const id of [...scheduled.current]) if (!pending.has(id)) scheduled.current.delete(id);
    for (const id of pending) {
      if (!scheduled.current.has(id)) {
        scheduled.current.add(id);
        void window.staffdesk
          .runExtract(id)
          .catch(() => {
            dispatch({
              type: 'EXTRACT_DONE',
              sourceId: id,
              outcome: 'failed',
              detail: '抽取请求意外中断，请重试',
            });
          })
          .finally(() => scheduled.current.delete(id));
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
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('通用');
  // 0041：未认证徽章直达设置「模型」节；图标轨照旧落在「通用」。
  const openSettings = useCallback((section: SettingsSection) => {
    setSettingsSection(section);
    setSettings(true);
  }, []);
  const [onboarding, setOnboarding] = useState(!state.onboardingDone);
  const [sessionOpen, setSessionOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);
  const [sessionW, setSessionW] = useState(SESSION_DEFAULT_WIDTH);
  const [rightW, setRightW] = useState(RIGHT_DEFAULT_WIDTH);
  const [dragging, setDragging] = useState(false);
  const sessionBase = useRef(SESSION_DEFAULT_WIDTH);
  const rightBase = useRef(RIGHT_DEFAULT_WIDTH);
  const view = state.view;
  const objectView = view.kind === 'object';

  const applyFit = useCallback(
    (desiredRightOpen = rightOpen) => {
      const fitted = fitWorkspaceLayout(window.innerWidth, {
        sessionOpen,
        rightOpen: objectView && desiredRightOpen,
        sessionWidth: sessionW,
        rightWidth: rightW,
      });
      setSessionOpen(fitted.sessionOpen);
      if (objectView) setRightOpen(fitted.rightOpen);
      setSessionW(fitted.sessionWidth);
      setRightW(fitted.rightWidth);
    },
    [objectView, rightOpen, rightW, sessionOpen, sessionW],
  );

  const toggleRight = useCallback(() => {
    if (rightOpen) {
      setRightOpen(false);
      return;
    }
    applyFit(true);
  }, [applyFit, rightOpen]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.altKey && (e.key === 'b' || e.key === 'B')) {
        e.preventDefault();
        toggleRight();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [toggleRight]);

  // 首次 mount 立即 fit；随后 resize 复用同一规则。窄窗先收会话栏，保留主栏和右栏。
  useEffect(() => {
    applyFit();
    const onResize = () => applyFit();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [applyFit]);

  const onSessionStart = useCallback(() => {
    sessionBase.current = sessionW;
    setDragging(true);
  }, [sessionW]);

  const onSessionDrag = useCallback((dx: number) => {
    setSessionW(clamp(sessionBase.current + dx, SESSION_MIN_WIDTH, SESSION_MAX_WIDTH));
  }, []);

  const onSessionEnd = useCallback(() => {
    setDragging(false);
  }, []);

  const onRightStart = useCallback(() => {
    rightBase.current = rightW;
    setDragging(true);
  }, [rightW]);

  const onRightDrag = useCallback((dx: number) => {
    setRightW(clamp(rightBase.current - dx, RIGHT_MIN_WIDTH, RIGHT_MAX_WIDTH));
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
            onSettings={() => openSettings('通用')}
            onContinueSetup={() => setOnboarding(true)}
            sessionOpen={sessionOpen}
            onToggleSession={() => setSessionOpen((v) => !v)}
          />
          <SessionList width={sessionW} open={sessionOpen} />
          {sessionOpen && (
            <DragHandle
              side="session"
              style={{ left: WORKSPACE_RAIL_WIDTH + sessionW - 4 }}
              onStart={onSessionStart}
              onDrag={onSessionDrag}
              onEnd={onSessionEnd}
            />
          )}
          <div className="main" key={state.currentWorkspaceId}>
            {view.kind === 'inbox' && <InboxView />}
            {view.kind === 'pending' && <PendingView />}
            {view.kind === 'all' && <AllObjectsView />}
            {view.kind === 'tasks' && <TasksView />}
            {view.kind === 'replay' && <ReplayView taskId={view.taskId} />}
            {view.kind === 'object' && (
              <>
                <ChatTopbar
                  rightOpen={rightOpen}
                  onToggleRight={toggleRight}
                  onOpenSettings={() => openSettings('模型')}
                />
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
        <SettingsModal
          open={settings}
          initialSection={settingsSection}
          onClose={() => setSettings(false)}
        />
      </div>
      {onboarding && !state.onboardingDone && <Onboarding onClose={() => setOnboarding(false)} />}
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
