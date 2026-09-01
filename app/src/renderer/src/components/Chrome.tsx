import { useEffect, useRef, useState } from 'react';
import {
  Archive,
  Buildings,
  CaretDown,
  CaretRight,
  ClipboardText,
  FileText,
  FolderOpen,
  GearSix,
  ListChecks,
  Plus,
  SidebarSimple,
  Stack,
  StopCircle,
  Tray,
  Trash,
  Users,
} from '@phosphor-icons/react';
import { useStore } from '../store';
import type { DeskTask, ObjectKind, ScenarioKind, View } from '@shared/types';

function currentTitle(view: View, objects: { id: string; name: string }[]): string {
  if (view.kind === 'object')
    return objects.find((o) => o.id === view.objectId)?.name ?? 'StaffDesk';
  if (view.kind === 'pending') return '待确认';
  if (view.kind === 'all') return '全部对象';
  if (view.kind === 'tasks') return '任务';
  if (view.kind === 'replay') return '任务回放';
  return 'Inbox';
}

export function ThemeSync() {
  const { state } = useStore();
  useEffect(() => {
    const apply = () => {
      const dark =
        state.themePreference === 'dark' ||
        (state.themePreference === 'system' &&
          window.matchMedia('(prefers-color-scheme: dark)').matches);
      document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    };
    apply();
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [state.themePreference]);
  return null;
}

export function TitleBar() {
  const { state } = useStore();
  return (
    <div className="titlebar">
      <div className="titlebar-left">
        <span className="titlebar-logo">
          <Stack size={13} weight="bold" />
        </span>
        <span className="titlebar-title">StaffDesk</span>
        <span className="titlebar-sep">/</span>
        <span>{currentTitle(state.view, state.objects)}</span>
      </div>
      <div className="titlebar-right" />
    </div>
  );
}

export function IconRail({
  onSettings,
  onContinueSetup,
  sessionOpen,
  onToggleSession,
}: {
  onSettings: () => void;
  onContinueSetup?: () => void;
  sessionOpen: boolean;
  onToggleSession: () => void;
}) {
  const { state, dispatch } = useStore();
  const pendingCount = state.proposals.filter((p) => p.pending).length;
  const nav = (view: View) => dispatch({ type: 'SET_VIEW', view });

  return (
    <nav className="icon-rail">
      <button
        title={sessionOpen ? '收起会话栏' : '展开会话栏'}
        className={sessionOpen ? 'on' : ''}
        onClick={onToggleSession}
      >
        <SidebarSimple size={18} />
      </button>
      <button
        className={state.view.kind === 'inbox' ? 'on' : ''}
        title="Inbox"
        onClick={() => nav({ kind: 'inbox' })}
      >
        <Tray size={18} />
        {state.inbox.length > 0 && <span className="rail-dot">{state.inbox.length}</span>}
      </button>
      <button
        className={state.view.kind === 'pending' ? 'on' : ''}
        title="待确认"
        onClick={() => nav({ kind: 'pending' })}
      >
        <FileText size={18} />
        {pendingCount > 0 && <span className="rail-dot">{pendingCount}</span>}
      </button>
      <button
        className={state.view.kind === 'all' ? 'on' : ''}
        title="全部对象（含已归档、含无工作区）"
        onClick={() => nav({ kind: 'all' })}
      >
        <Stack size={18} />
      </button>
      <button
        className={state.view.kind === 'tasks' ? 'on' : ''}
        title="任务"
        onClick={() => nav({ kind: 'tasks' })}
      >
        <ClipboardText size={18} />
      </button>
      {!state.onboardingDone && (
        <button className="rail-foot" title="继续设置" onClick={onContinueSetup}>
          <ListChecks size={18} weight="bold" />
        </button>
      )}
      <button className="rail-foot" title="设置" onClick={onSettings}>
        <GearSix size={18} />
      </button>
    </nav>
  );
}

export function SessionList({ width, open }: { width: number; open: boolean }) {
  const { state, dispatch } = useStore();
  const [menu, setMenu] = useState(false);
  const [draft, setDraft] = useState<null | 'workspace' | 'object'>(null);
  const [name, setName] = useState('');
  const [kind, setKind] = useState<ObjectKind>('组织');
  const [scenario, setScenario] = useState<ScenarioKind>('求职面试');
  const [showArchived, setShowArchived] = useState(false);
  const [confirm, setConfirm] = useState<null | {
    kind: 'workspace' | 'object';
    id: string;
    name: string;
  }>(null);
  const ws = state.workspaces.find((w) => w.id === state.currentWorkspaceId);
  const inWs = state.objects.filter((o) => o.workspaceId === state.currentWorkspaceId);
  const objects = inWs.filter((o) => !o.archived);
  const archived = inWs.filter((o) => o.archived);
  const icon = (k: ObjectKind) =>
    k === '人' ? (
      <Users size={14} />
    ) : k === '组织' ? (
      <Buildings size={14} />
    ) : (
      <FolderOpen size={14} />
    );

  const closeDraft = () => {
    setDraft(null);
    setName('');
    setKind('组织');
    setScenario('求职面试');
  };

  return (
    <aside className="session-list" style={{ width: open ? width : 0 }} aria-hidden={!open}>
      <div className="session-inner" style={{ width }}>
        <div className="ws-head">
          <button
            type="button"
            className="ws-switch"
            onClick={() => {
              setMenu((v) => !v);
              closeDraft();
            }}
          >
            <FolderOpen size={14} />
            <span>{ws?.name ?? '工作区'}</span>
            {ws && <span className="tag grey">{ws.scenario}</span>}
            <CaretDown size={10} />
          </button>
          <button
            type="button"
            className="ws-plus"
            title="新建对象"
            onClick={() => {
              setDraft('object');
              setMenu(false);
            }}
          >
            <Plus size={14} />
          </button>
        </div>
        {menu && (
          <div className="ws-menu">
            {state.workspaces.map((w) => (
              <div
                key={w.id}
                className={`ws-menu-row${w.id === state.currentWorkspaceId ? ' on' : ''}`}
              >
                <button
                  type="button"
                  onClick={() => {
                    dispatch({ type: 'SWITCH_WORKSPACE', id: w.id });
                    setMenu(false);
                  }}
                >
                  {w.name}
                  <span className="tag grey">{w.scenario}</span>
                </button>
                <button
                  type="button"
                  className="ws-menu-x"
                  title="移除工作区"
                  disabled={state.workspaces.length <= 1}
                  onClick={(e) => {
                    e.stopPropagation();
                    setMenu(false);
                    setConfirm({ kind: 'workspace', id: w.id, name: w.name });
                  }}
                >
                  <Trash size={12} />
                </button>
              </div>
            ))}
            <button
              type="button"
              className="ws-menu-new"
              onClick={() => {
                setMenu(false);
                setDraft('workspace');
              }}
            >
              新建工作区
            </button>
          </div>
        )}
        {draft && (
          <form
            className="ws-draft"
            onSubmit={(e) => {
              e.preventDefault();
              if (!name.trim()) return;
              if (draft === 'workspace') dispatch({ type: 'ADD_WORKSPACE', name, scenario });
              else dispatch({ type: 'ADD_OBJECT', kind, name });
              closeDraft();
            }}
          >
            {draft === 'object' && (
              <div className="ws-kinds">
                {(['人', '组织', '项目'] as const).map((k) => (
                  <button
                    key={k}
                    type="button"
                    className={kind === k ? 'on' : ''}
                    onClick={() => setKind(k)}
                  >
                    {k}
                  </button>
                ))}
              </div>
            )}
            {draft === 'workspace' && (
              <div className="ws-kinds scenario-kinds">
                {/* 0058：场景清单改读 state.scenarioTemplates（数据行），名称 + hint 来自模板。 */}
                {state.scenarioTemplates.map((t) => (
                  <button
                    key={t.name}
                    type="button"
                    className={scenario === t.name ? 'on' : ''}
                    onClick={() => setScenario(t.name)}
                  >
                    {t.name}
                  </button>
                ))}
                <span className="dim scenario-hint">
                  {state.scenarioTemplates.find((t) => t.name === scenario)?.hint ?? ''}
                </span>
              </div>
            )}
            <input
              autoFocus
              value={name}
              placeholder={
                draft === 'workspace'
                  ? '工作区名称'
                  : // 0058：建对象引导按当前工作区场景模板差异化；缺模板或空引导回落基线。
                    state.scenarioTemplates.find((t) => t.name === ws?.scenario)?.hint || '对象名称'
              }
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') closeDraft();
              }}
            />
            <div className="ws-draft-actions">
              <button type="button" className="ghost small" onClick={closeDraft}>
                取消
              </button>
              <button type="submit" className="primary small" disabled={!name.trim()}>
                创建
              </button>
            </div>
          </form>
        )}
        <div className="session-scroll">
          {objects.length === 0 && !draft && <div className="dim pad">没有对象</div>}
          {objects.map((o) => {
            const active = state.view.kind === 'object' && state.view.objectId === o.id;
            const n = state.chatByObject[o.id]?.length ?? 0;
            return (
              <div key={o.id} className={`session-row${active ? ' on' : ''}`}>
                <button
                  type="button"
                  className="session-row-main"
                  onClick={() =>
                    dispatch({ type: 'SET_VIEW', view: { kind: 'object', objectId: o.id } })
                  }
                >
                  <span className="session-ico">{icon(o.kind)}</span>
                  <span className="session-meta">
                    <span className="session-name">{o.name}</span>
                    <span className="session-sub">
                      {o.kind}
                      {n > 0 ? ` · ${n}` : ''}
                    </span>
                  </span>
                </button>
                <button
                  type="button"
                  className="session-row-act"
                  title="归档"
                  onClick={() => dispatch({ type: 'ARCHIVE_OBJECT', id: o.id })}
                >
                  <Archive size={14} />
                </button>
              </div>
            );
          })}
          {archived.length > 0 && (
            <div className="archived-block">
              <button
                type="button"
                className="archived-toggle"
                onClick={() => setShowArchived((v) => !v)}
              >
                <CaretRight
                  size={12}
                  style={{ transform: showArchived ? 'rotate(90deg)' : undefined }}
                />
                已归档 {archived.length}
              </button>
              {showArchived &&
                archived.map((o) => (
                  <div key={o.id} className="session-row archived">
                    <button
                      type="button"
                      className="session-row-main"
                      onClick={() =>
                        dispatch({ type: 'SET_VIEW', view: { kind: 'object', objectId: o.id } })
                      }
                    >
                      <span className="session-ico">{icon(o.kind)}</span>
                      <span className="session-meta">
                        <span className="session-name">{o.name}</span>
                        <span className="session-sub">{o.kind} · 已归档</span>
                      </span>
                    </button>
                    <button
                      type="button"
                      className="session-row-act"
                      title="取消归档"
                      onClick={() => dispatch({ type: 'UNARCHIVE_OBJECT', id: o.id })}
                    >
                      <Archive size={14} weight="fill" />
                    </button>
                    <button
                      type="button"
                      className="session-row-act danger"
                      title="永久删除"
                      onClick={() => setConfirm({ kind: 'object', id: o.id, name: o.name })}
                    >
                      <Trash size={14} />
                    </button>
                  </div>
                ))}
            </div>
          )}
        </div>
      </div>
      {confirm && (
        <div className="mini-overlay">
          <div className="mini-dialog">
            <div className="mini-head">
              {confirm.kind === 'workspace' ? '移除工作区' : '永久删除'}
            </div>
            <p className="dim">
              {confirm.kind === 'workspace'
                ? `移除「${confirm.name}」？区内未归档对象会先归档，之后不在任何工作区可见；可从图标轨「全部对象」找回。主张仍留在账本。`
                : `永久删除「${confirm.name}」？名下主张会全部关窗（对象误建）、对话一并删除、简报留为孤儿快照，无法恢复。`}
            </p>
            <div className="mini-foot">
              <button type="button" className="ghost" onClick={() => setConfirm(null)}>
                取消
              </button>
              <button
                type="button"
                className="primary danger"
                onClick={() => {
                  if (confirm.kind === 'workspace')
                    dispatch({ type: 'REMOVE_WORKSPACE', id: confirm.id });
                  else dispatch({ type: 'DELETE_OBJECT', id: confirm.id });
                  setConfirm(null);
                }}
              >
                {confirm.kind === 'workspace' ? '移除' : '删除'}
              </button>
            </div>
          </div>
        </div>
      )}
    </aside>
  );
}

// M19 调研档位入口：主按钮点击仍是快搜；箭头下拉给快搜 / 深挖 / 再搜一轮。
// 词条见 CONTEXT：「深挖」是更高预算的一轮，「再搜一轮」是带上轮语境的新任务（0036），
// 必须挂最近一条非雷达任务作为上轮。界面不出现任何内部机制名。
function GearMenu({
  objectId,
  disabled,
  lastRoundTask,
}: {
  objectId: string;
  disabled: boolean;
  lastRoundTask: DeskTask | undefined;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="cmenu" ref={root}>
      <button
        type="button"
        className={`btn outline sm gear-caret${open ? ' open' : ''}`}
        aria-label="选择调研档位"
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
      >
        <CaretDown size={10} weight="bold" />
      </button>
      {open && (
        <div className="cmenu-pop gear-pop" role="listbox">
          <button
            type="button"
            role="option"
            aria-selected={false}
            title="调研任务的默认档"
            onClick={() => {
              setOpen(false);
              void window.staffdesk.startResearch(objectId, '快搜');
            }}
          >
            快搜
          </button>
          <button
            type="button"
            role="option"
            aria-selected={false}
            title="更高预算的一轮"
            onClick={() => {
              setOpen(false);
              void window.staffdesk.startResearch(objectId, '深挖');
            }}
          >
            深挖
          </button>
          <button
            type="button"
            role="option"
            aria-selected={false}
            disabled={!lastRoundTask}
            title={lastRoundTask ? '带着上轮语境新开一轮' : '该对象还没有可作为上轮的任务'}
            onClick={() => {
              setOpen(false);
              if (!lastRoundTask) return;
              void window.staffdesk.startResearch(objectId, lastRoundTask.budgetGear ?? '快搜', {
                kind: '再搜一轮',
                fromTaskId: lastRoundTask.id,
              });
            }}
          >
            再搜一轮
          </button>
        </div>
      )}
    </div>
  );
}

// M24 雷达周期入口：主按钮仍是每日档；箭头下拉给每日 / 每 3 天 / 每周三档（0038 常驻后按档跑）。
// 词条口径：周期性雷达须显式创建，不是隐式爬虫；界面不出现内部机制名。
const RADAR_INTERVALS = [
  { days: 1, label: '每日', title: '每天自动搜一轮' },
  { days: 3, label: '每 3 天', title: '每 3 天自动搜一轮' },
  { days: 7, label: '每周', title: '每周自动搜一轮' },
] as const;

function RadarMenu({ objectId }: { objectId: string }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="cmenu" ref={root}>
      <button
        type="button"
        className={`btn outline sm gear-caret${open ? ' open' : ''}`}
        aria-label="选择雷达周期"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <CaretDown size={10} weight="bold" />
      </button>
      {open && (
        <div className="cmenu-pop gear-pop" role="listbox">
          {RADAR_INTERVALS.map(({ days, label, title }) => (
            <button
              key={days}
              type="button"
              role="option"
              aria-selected={false}
              title={title}
              onClick={() => {
                setOpen(false);
                void window.staffdesk.createRadar(objectId, days);
              }}
            >
              {label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function ChatTopbar({
  rightOpen,
  onToggleRight,
  onOpenSettings,
}: {
  rightOpen: boolean;
  onToggleRight: () => void;
  onOpenSettings: () => void;
}) {
  const { state, dispatch } = useStore();
  const view = state.view;
  if (view.kind !== 'object') return null;
  const obj = state.objects.find((o) => o.id === view.objectId);
  if (!obj) return null;
  const briefDisabled = state.briefDraftingFor !== null;
  const objectTasks = state.tasks.filter((task) => task.objectId === obj.id);
  const runningTask = [...objectTasks]
    .reverse()
    .find((task) => task.status === '进行中' && (task.kind === '调研' || task.kind === '再搜一轮'));
  // 最近一条非雷达任务：回放兜底目标，也是「再搜一轮」的上轮语境来源。
  const lastRoundTask = [...objectTasks].reverse().find((task) => task.kind !== '周期性雷达');
  const replayTarget = runningTask ?? lastRoundTask;
  const radar = state.tasks.find(
    (task) => task.objectId === obj.id && task.kind === '周期性雷达' && task.status !== '已停止',
  );
  // 0041「未认证的配置徽章持续可见」：未配置不提示（设置/向导已在引导），不达标态常驻小徽章；
  // 不进消息流，点击直达设置的模型节补跑资格认证。
  const certStatus = state.qualification.status;

  return (
    <div className="chat-topbar">
      <div className="topbar-ctx">
        <span className="kind-chip">{obj.kind}</span>
        <strong>{obj.name}</strong>
        {(certStatus === '未认证' || certStatus === '认证中') && (
          <button
            type="button"
            className="tag amber cert-badge"
            title={
              certStatus === '认证中'
                ? '正在跑资格认证，完成后这里会更新'
                : '当前模型配置未通过资格认证，点击查看'
            }
            onClick={onOpenSettings}
          >
            {certStatus}
          </button>
        )}
      </div>
      <div className="action-cluster">
        <button
          type="button"
          className="btn outline sm"
          disabled={Boolean(runningTask)}
          onClick={() => void window.staffdesk.startResearch(obj.id, '快搜')}
        >
          {runningTask ? '调研中' : '调研'}
        </button>
        <GearMenu
          key={obj.id}
          objectId={obj.id}
          disabled={Boolean(runningTask)}
          lastRoundTask={lastRoundTask}
        />
        {runningTask && (
          <>
            <span className="tag grey" title={runningTask.query}>
              {runningTask.kind} · {runningTask.budgetGear ?? '快搜'}
            </span>
            <button
              type="button"
              className="btn outline sm danger-hover"
              aria-label="停止任务"
              onClick={() => void window.staffdesk.stopTask(runningTask.id)}
            >
              <StopCircle size={14} />
              停止
            </button>
          </>
        )}
        {radar ? (
          <>
            <span className="tag grey" title={radar.query}>
              雷达 {radar.nextDueAt ? `下次 ${radar.nextDueAt.slice(5)}` : '已计划'}
            </span>
            <button
              type="button"
              className="btn outline sm"
              onClick={() => void window.staffdesk.runRadar(radar.id)}
            >
              补跑
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className="btn outline sm"
              onClick={() => void window.staffdesk.createRadar(obj.id)}
            >
              每日雷达
            </button>
            <RadarMenu key={obj.id} objectId={obj.id} />
          </>
        )}
        <button
          type="button"
          className="btn outline sm"
          onClick={() => {
            if (!replayTarget) {
              dispatch({ type: 'TOAST', text: '还没有可回放的任务' });
              return;
            }
            dispatch({ type: 'SET_VIEW', view: { kind: 'replay', taskId: replayTarget.id } });
          }}
        >
          回放
        </button>
        <button
          type="button"
          className="btn primary sm"
          disabled={briefDisabled}
          onClick={() => dispatch({ type: 'GENERATE_BRIEF_START', objectId: obj.id })}
        >
          {state.briefDraftingFor ? <span className="shimmer-text">组装中</span> : '出简报'}
        </button>
        <button
          type="button"
          className={`icon-only${rightOpen ? ' on' : ''}`}
          title="切换面板 Ctrl+Alt+B"
          aria-label="切换面板"
          onClick={onToggleRight}
        >
          <SidebarSimple size={16} />
        </button>
      </div>
    </div>
  );
}

export function Toast() {
  const { state, dispatch } = useStore();
  if (!state.toast) return null;
  return (
    <div className="toast" onClick={() => dispatch({ type: 'TOAST', text: null })}>
      {state.toast.text}
    </div>
  );
}
