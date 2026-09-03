import { useEffect, useState } from 'react';
import {
  Brain,
  Cpu,
  Cube,
  Eye,
  EyeSlash,
  GearSix,
  Heartbeat,
  Moon,
  Monitor,
  PencilSimple,
  Plugs,
  Plus,
  SquaresFour,
  Sun,
  Trash,
  X,
} from '@phosphor-icons/react';
import { DEFAULT_LINGER_DAYS, MAX_LINGER_DAYS, MIN_LINGER_DAYS } from '@shared/lingerDays';
import { useStore } from '../store';
import { briefSpecPredicates } from '@shared/scenario';
import type {
  BriefBlockKind,
  BriefSpecBlock,
  LlmModel,
  LlmProvider,
  Memory,
  ObjectKind,
  Predicate,
  ScenarioKind,
  ScenarioTemplate,
  SlotDef,
  ThemePreference,
} from '@shared/types';

// 0058：简报说明块四类（background / slots / synthesis / gaps），下拉只给人看的中文标签。
const BLOCK_KIND_LABELS: Record<BriefBlockKind, string> = {
  background: '背景（非槽主张）',
  slots: '槽位（指定字段）',
  synthesis: '综合（须指回主张）',
  gaps: '材料缺口',
};

const CUBES: { id: ThemePreference; label: string; Icon: typeof Sun }[] = [
  { id: 'light', label: '明亮', Icon: Sun },
  { id: 'dark', label: '暗色', Icon: Moon },
  { id: 'system', label: '跟随系统', Icon: Monitor },
];

function fmtCtx(n: number) {
  if (n >= 1000000) return `${Math.round(n / 1000000)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}K`;
  return String(n);
}

/**
 * F3（审计 2026-09-01）：mini 对话框的 Esc 分层。外层设置面板与内层对话框各挂 document keydown，
 * 同为冒泡监听时按注册顺序触发（外层随面板先开先注册、先触发），内层 stopImmediatePropagation
 * 拦不住已触发的外层——按 Esc 会内外同关。改挂捕获阶段：同一事件在 document 的捕获先于冒泡，
 * 内层先接住并 stopPropagation，事件不再抵达外层的冒泡监听，Esc 只关最上层对话框。
 */
function useMiniDialogEscape(onClose: () => void): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      onClose();
    };
    document.addEventListener('keydown', onKeyDown, { capture: true });
    return () => document.removeEventListener('keydown', onKeyDown, { capture: true });
  }, [onClose]);
}

export type SettingsSection = '通用' | '记忆' | '谓词表' | '模型' | '场景模板' | '诊断';

export function SettingsModal({
  open,
  onClose,
  initialSection = '通用',
}: {
  open: boolean;
  onClose: () => void;
  initialSection?: SettingsSection;
}) {
  const [section, setSection] = useState<SettingsSection>(initialSection);

  // 打开时落到调用方指定的节（如未认证徽章直达「模型」）；人手切节后不被覆盖，直到下次打开。
  useEffect(() => {
    if (open) setSection(initialSection);
  }, [open, initialSection]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="settings-overlay" role="presentation">
      <div className="settings-mask" onClick={onClose} />
      <div className="settings-panel" role="dialog" aria-modal="true" aria-label="设置">
        <nav className="settings-nav">
          <div className="settings-nav-title">设置</div>
          <button className={section === '通用' ? 'on' : ''} onClick={() => setSection('通用')}>
            <GearSix size={16} /> 通用
          </button>
          <button className={section === '记忆' ? 'on' : ''} onClick={() => setSection('记忆')}>
            <Brain size={16} /> 记忆
          </button>
          <button className={section === '谓词表' ? 'on' : ''} onClick={() => setSection('谓词表')}>
            <Cube size={16} /> 谓词表
          </button>
          <button className={section === '模型' ? 'on' : ''} onClick={() => setSection('模型')}>
            <Cpu size={16} /> 模型
          </button>
          <button
            className={section === '场景模板' ? 'on' : ''}
            onClick={() => setSection('场景模板')}
          >
            <SquaresFour size={16} /> 场景模板
          </button>
          <button className={section === '诊断' ? 'on' : ''} onClick={() => setSection('诊断')}>
            <Heartbeat size={16} /> 诊断
          </button>
        </nav>
        <div className="settings-content">
          <div className="settings-content-head">
            {section === '通用' && <h2 className="settings-h">通用设置</h2>}
            {section === '记忆' && <h2 className="settings-h">记忆</h2>}
            {section === '模型' && <h2 className="settings-h">模型设置</h2>}
            {section === '谓词表' && <h2 className="settings-h">受控谓词表</h2>}
            {section === '场景模板' && <h2 className="settings-h">场景模板</h2>}
            {section === '诊断' && <h2 className="settings-h">诊断</h2>}
            <button className="settings-close" type="button" onClick={onClose} aria-label="关闭">
              <X size={14} />
            </button>
          </div>
          {section === '通用' && (
            <div className="settings-body">
              <div className="settings-block">
                <div className="settings-label">外观</div>
                <div className="theme-cubes">
                  {CUBES.map(({ id, label, Icon }) => (
                    <ThemeCube key={id} id={id} label={label} Icon={Icon} />
                  ))}
                </div>
              </div>
              <LingerDaysField />
              <BrainFilePanel />
              <DeletedSourceRecoveryPanel />
            </div>
          )}
          {section === '谓词表' && <SlotTable />}
          {section === '模型' && <ModelsWorkbench />}
          {section === '场景模板' && <ScenarioTemplates />}
          {section === '记忆' && <MemoryBrowser />}
          {section === '诊断' && <DiagnosticsPanel />}
        </div>
      </div>
    </div>
  );
}

function LingerDaysField() {
  const [days, setDays] = useState(DEFAULT_LINGER_DAYS);
  const [draft, setDraft] = useState(String(DEFAULT_LINGER_DAYS));

  useEffect(() => {
    void window.staffdesk.getLingerDays().then((value) => {
      setDays(value);
      setDraft(String(value));
    });
  }, []);

  const commit = (raw: string) => {
    const parsed = Number(raw);
    void window.staffdesk.setLingerDays(parsed).then((next) => {
      setDays(next);
      setDraft(String(next));
    });
  };

  return (
    <div className="settings-block">
      <div className="settings-label">滞留未核</div>
      <p className="dim">
        成立且未核的主张，自入库起满多少天，整理可提议丢弃。默认 {DEFAULT_LINGER_DAYS} 天，范围{' '}
        {MIN_LINGER_DAYS}–{MAX_LINGER_DAYS}。
      </p>
      <label className="field">
        滞留天数
        <input
          type="number"
          min={MIN_LINGER_DAYS}
          max={MAX_LINGER_DAYS}
          step={1}
          value={draft}
          aria-label="滞留天数"
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => commit(draft)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit(draft);
          }}
        />
      </label>
      <p className="dim">
        当前 {days} 天。改完后打开待确认会按新天数扫描刷新。跟这台机器走，不进大脑备份。
      </p>
    </div>
  );
}

function BrainFilePanel() {
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState<'export' | 'restore' | null>(null);
  const [confirmRestore, setConfirmRestore] = useState(false);

  const exportBackup = async () => {
    setBusy('export');
    try {
      const result = await window.staffdesk.exportBrain();
      setStatus(result ? `已导出大脑备份：${result.filePath}` : '已取消导出');
    } catch (error) {
      setStatus(`导出失败：${errorMessage(error)}`);
    } finally {
      setBusy(null);
    }
  };

  const restoreBackup = async () => {
    if (!confirmRestore) {
      setConfirmRestore(true);
      setStatus(null);
      return;
    }
    setBusy('restore');
    try {
      const result = await window.staffdesk.restoreBrain();
      setStatus(result ? `已恢复大脑备份；恢复前副本：${result.safetyCopyPath}` : '已取消恢复');
      setConfirmRestore(false);
    } catch (error) {
      setStatus(`恢复失败：${errorMessage(error)}`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="settings-block brain-file-card">
      <div>
        <div className="settings-label">大脑文件</div>
        <p className="dim">
          备份只包含对象、来源、主张、记忆、任务、简报与操作账本。不包含模型端点、API
          Key、资格认证、滞留天数或构建产物。
        </p>
      </div>
      <div className="brain-file-rules">
        <span>换机器后在「模型」页重新配置端点。</span>
        <span>恢复前自动保留当前大脑副本。</span>
        <span>只接受 StaffDesk 生成并校验通过的备份 zip。</span>
      </div>
      <div className="brain-file-actions">
        <button
          type="button"
          className="primary small"
          disabled={busy !== null}
          onClick={() => void exportBackup()}
        >
          {busy === 'export' ? '导出中…' : '导出大脑备份'}
        </button>
        <button
          type="button"
          className={confirmRestore ? 'primary danger small' : 'ghost small'}
          disabled={busy !== null}
          onClick={() => void restoreBackup()}
        >
          {busy === 'restore' ? '恢复中…' : confirmRestore ? '确认恢复并替换' : '恢复大脑备份'}
        </button>
        {confirmRestore && (
          <button
            type="button"
            className="ghost small"
            disabled={busy !== null}
            onClick={() => {
              setConfirmRestore(false);
              setStatus('已取消恢复');
            }}
          >
            取消
          </button>
        )}
      </div>
      {confirmRestore && (
        <div className="restore-confirm" role="alert">
          <strong>恢复会替换当前大脑文件。</strong>
          <span>系统会先导出当前大脑安全副本；模型端点、API Key 和资格认证不会被备份覆盖。</span>
        </div>
      )}
      {status && <p className="backup-status">{status}</p>}
    </div>
  );
}

function errorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/^Error invoking remote method '[^']+':\s*/, '').slice(0, 180);
}

function DeletedSourceRecoveryPanel() {
  const { state, dispatch } = useStore();
  return (
    <div className="settings-block">
      <div className="settings-label">已删除来源</div>
      {state.deletedSourceRecoveries.length === 0 ? (
        <p className="dim">没有可恢复的已删除来源。</p>
      ) : (
        <div className="source-recovery-list">
          {state.deletedSourceRecoveries.map((recovery) => (
            <div className="source-recovery-row" key={recovery.source.id}>
              <span className="source-recovery-main">
                <strong>{recovery.source.title}</strong>
                <span className="dim">
                  {recovery.source.boundObjectIds.length} 个绑定 · {recovery.claims.length} 条主张
                </span>
              </span>
              <button
                type="button"
                className="ghost small"
                onClick={() => dispatch({ type: 'RESTORE_DELETED_SOURCE', recovery })}
              >
                恢复来源
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** F7（审计 2026-09-02）：记忆管理面——按范围分区浏览，对象区按对象分组显示对象名；
 *  禁写行展示结构化匹配三元组（0054）。删除走既有 REMOVE_MEMORY，纯 UI 不新增守卫语义。 */
function MemoryBrowser() {
  const { state, dispatch } = useStore();
  const objectName = (objectId: string | undefined): string =>
    objectId ? (state.objects.find((o) => o.id === objectId)?.name ?? '已删除对象') : '未指定对象';

  const objectGroups = new Map<string, Memory[]>();
  for (const memory of state.memories) {
    if (memory.scope !== '对象') continue;
    const key = memory.objectId ?? '';
    const bucket = objectGroups.get(key);
    if (bucket) bucket.push(memory);
    else objectGroups.set(key, [memory]);
  }

  const groups: { key: string; title: string; memories: Memory[] }[] = [
    { key: '全局', title: '全局记忆', memories: state.memories.filter((m) => m.scope === '全局') },
    ...[...objectGroups.entries()].map(([objectId, memories]) => ({
      key: `对象:${objectId}`,
      title: `对象记忆 · ${objectName(objectId || undefined)}`,
      memories,
    })),
    { key: '会话', title: '会话记忆', memories: state.memories.filter((m) => m.scope === '会话') },
  ].filter((group) => group.memories.length > 0);

  return (
    <div className="settings-body">
      {groups.length === 0 ? (
        <div className="settings-block">
          <p className="dim">还没有记忆。纠正与「记下来：…」会立刻写入。</p>
        </div>
      ) : (
        groups.map((group) => (
          <div className="settings-block" key={group.key}>
            <div className="settings-label">
              {group.title}
              <span className="dim"> · {group.memories.length} 条</span>
            </div>
            {group.memories.map((m) => (
              <div className="memory-row" key={m.id}>
                <span className={`tag ${m.kind === '禁写' ? 'red' : 'grey'}`}>{m.kind}</span>
                <span>{m.text}</span>
                {m.kind === '禁写' && (m.bannedObjectId || m.bannedPredicate || m.bannedValue) && (
                  <span className="dim">
                    禁写匹配：{objectName(m.bannedObjectId)} · {m.bannedPredicate ?? '任意谓词'} ·{' '}
                    {m.bannedValue ?? '任意取值'}
                  </span>
                )}
                <button
                  type="button"
                  className="ghost small"
                  title={`移除这条${m.kind}`}
                  onClick={() => dispatch({ type: 'REMOVE_MEMORY', id: m.id })}
                >
                  移除
                </button>
              </div>
            ))}
          </div>
        ))
      )}
    </div>
  );
}

/** F3（审计 2026-09-02）：诊断节——展示日志目录、合并导出诊断日志；内容在写入口已掩码（0040）。 */
function DiagnosticsPanel() {
  const [dir, setDir] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    void window.staffdesk.logsDir().then(setDir);
  }, []);

  const exportLogs = async () => {
    setBusy(true);
    try {
      const result = await window.staffdesk.exportLogs();
      setStatus(result ? `已导出诊断日志：${result.filePath}` : '已取消导出');
    } catch (error) {
      setStatus(`导出失败：${errorMessage(error)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="settings-body">
      <div className="settings-block brain-file-card">
        <div>
          <div className="settings-label">诊断日志</div>
          <p className="dim">
            运行日志按天落在本机日志目录，只包含掩码后的信息：不含 API Key，也不含发出去的请求原文。
          </p>
        </div>
        <p className="dim mono">{dir === null ? '正在读取日志目录…' : dir || '日志未启用'}</p>
        <div className="brain-file-actions">
          <button
            type="button"
            className="primary small"
            disabled={busy || !dir}
            onClick={() => void exportLogs()}
          >
            {busy ? '导出中…' : '导出诊断日志'}
          </button>
        </div>
        {status && <p className="backup-status">{status}</p>}
      </div>
    </div>
  );
}

function SlotTable() {
  const { state, dispatch } = useStore();
  const [name, setName] = useState('');
  const [kind, setKind] = useState<ObjectKind>('组织');
  const [arity, setArity] = useState<'单值' | '多值'>('单值');
  // 0057：行内编辑/删除入口；受保护槽（内置简报说明引用）仍可改取值与场景，禁改名禁删。
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [deletingKey, setDeletingKey] = useState<string | null>(null);

  const kinds: ObjectKind[] = ['人', '组织', '项目'];
  const scenarioLabel = (s: string[]) => (s.length === 0 ? '通用' : s.join('、'));
  const slotKey = (d: SlotDef) => `${d.kind}\u0000${d.name}`;
  const editing = state.slotDefs.find((d) => slotKey(d) === editingKey) ?? null;
  const deleting = state.slotDefs.find((d) => slotKey(d) === deletingKey) ?? null;

  return (
    <div className="slot-editor">
      <div className="slot-scroll">
        <p className="models-lead">抽取只使用表内字段。单值字段出现不同取值时，系统会标记冲突。</p>
        {kinds.map((k) => (
          <section className="slot-group" key={k}>
            <div className="slot-group-head">
              <span>{k}</span>
              <span>{state.slotDefs.filter((d) => d.kind === k).length} 个字段</span>
            </div>
            <div className="slot-table">
              {state.slotDefs
                .filter((d) => d.kind === k)
                .map((d) => {
                  // 0058：模板集已是数据行，「简报引用」只作提示标记（reducer 改名/删除走级联改写）。
                  const lockedTag = briefSpecPredicates(state.scenarioTemplates).has(d.name);
                  return (
                    <div className="slot-table-row" key={`${d.kind}-${d.name}`}>
                      <span className="slot-name">
                        {d.name}
                        {lockedTag && <span className="tag grey">简报引用</span>}
                      </span>
                      <span className="tag grey">{d.arity}</span>
                      <span className="slot-scenarios">{scenarioLabel(d.scenarios)}</span>
                      <span className="slot-row-actions">
                        <button
                          type="button"
                          className="icon-ghost"
                          aria-label={`编辑槽 ${d.name}`}
                          title="编辑槽"
                          onClick={() => setEditingKey(slotKey(d))}
                        >
                          <PencilSimple size={14} />
                        </button>
                        <button
                          type="button"
                          className="icon-ghost danger"
                          aria-label={`删除槽 ${d.name}`}
                          title="删除槽"

                          onClick={() => setDeletingKey(slotKey(d))}
                        >
                          <Trash size={14} />
                        </button>
                      </span>
                    </div>
                  );
                })}
            </div>
          </section>
        ))}
      </div>
      <form
        className="slot-add-panel"
        onSubmit={(e) => {
          e.preventDefault();
          if (!name.trim()) return;
          dispatch({ type: 'ADD_SLOT', name, kind, arity });
          setName('');
        }}
      >
        <div className="slot-add-copy">
          <strong>添加字段</strong>
          <span>新字段默认用于全部场景</span>
        </div>
        <div className="slot-add-controls">
          <label className="slot-name-field">
            <span>字段名</span>
            <input
              value={name}
              placeholder="例如：竞对动态"
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <fieldset className="slot-choice">
            <legend>归属</legend>
            <div>
              {kinds.map((k) => (
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
          </fieldset>
          <fieldset className="slot-choice">
            <legend>取值</legend>
            <div>
              {(['单值', '多值'] as const).map((a) => (
                <button
                  key={a}
                  type="button"
                  className={arity === a ? 'on' : ''}
                  onClick={() => setArity(a)}
                >
                  {a}
                </button>
              ))}
            </div>
          </fieldset>
          <button type="submit" className="primary" disabled={!name.trim()}>
            添加
          </button>
        </div>
      </form>
      {editing && (
        <SlotEditDialog
          slot={editing}
          onClose={() => setEditingKey(null)}
          onRequestDelete={() => {
            setEditingKey(null);
            setDeletingKey(slotKey(editing));
          }}
        />
      )}
      {deleting && <SlotDeleteDialog slot={deleting} onClose={() => setDeletingKey(null)} />}
    </div>
  );
}

/** 0057：槽编辑 mini-dialog——改名（受保护槽禁用）、单值/多值切换、场景适用勾选（空选 = 通用）。 */
function SlotEditDialog({
  slot,
  onClose,
  onRequestDelete,
}: {
  slot: SlotDef;
  onClose: () => void;
  onRequestDelete: () => void;
}) {
  // 0058：briefSpecPredicates 改吃模板集；场景勾选候选也改读模板名清单（数据行）。
  const { state, dispatch } = useStore();
  const [draftName, setDraftName] = useState(slot.name);
  const [arity, setArity] = useState<'单值' | '多值'>(slot.arity);
  const [sceneSet, setSceneSet] = useState<Set<ScenarioKind>>(new Set(slot.scenarios));
  // 0058：被简报说明引用不再上锁——改名/删除走 reducer 级联改写（重写模板谓词 / 撤空块），
  // 此处只保留提示性标记（lockedTag），不禁用任何操作。
  const lockedTag = briefSpecPredicates(state.scenarioTemplates).has(slot.name);

  useMiniDialogEscape(onClose);

  const toggleScene = (scenario: ScenarioKind) => {
    setSceneSet((prev) => {
      const next = new Set(prev);
      if (next.has(scenario)) next.delete(scenario);
      else next.add(scenario);
      return next;
    });
  };

  const save = () => {
    dispatch({
      type: 'UPDATE_SLOT',
      name: slot.name,
      kind: slot.kind,
      next: {
        ...(draftName.trim() === slot.name ? {} : { name: draftName }),
        arity,
        scenarios: [...sceneSet],
      },
    });
    onClose();
  };

  return (
    <div className="mini-overlay" role="presentation" onMouseDown={onClose}>
      <div
        className="mini-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="编辑槽"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="mini-head">
          编辑字段
          <button type="button" className="icon-ghost" onClick={onClose} aria-label="关闭">
            <X size={14} />
          </button>
        </div>
        <label className="field">
          字段名
          <input
            value={draftName}

            aria-label="槽名"
            onChange={(e) => setDraftName(e.target.value)}
          />
        </label>
        {lockedTag && (
          <p className="bind-hint">
            简报说明引用此字段：改名会同步改写各场景的简报说明，删除会从块中移除并撤下空块。
          </p>
        )}
        <fieldset className="slot-choice">
          <legend>取值</legend>
          <div>
            {(['单值', '多值'] as const).map((a) => (
              <button
                key={a}
                type="button"
                className={arity === a ? 'on' : ''}
                onClick={() => setArity(a)}
              >
                {a}
              </button>
            ))}
          </div>
        </fieldset>
        <fieldset className="slot-choice">
          <legend>适用场景（全不勾 = 通用）</legend>
          <div className="slot-scene-grid">
            <label className={`bind-option${sceneSet.size === 0 ? ' on' : ''}`}>
              <input
                type="checkbox"
                checked={sceneSet.size === 0}
                onChange={() => setSceneSet(new Set())}
              />
              <span>通用（全部场景）</span>
            </label>
            {/* 0058：候选改读 state.scenarioTemplates 名清单——场景是数据行，含自定义模板。 */}
            {state.scenarioTemplates.map((t) => (
              <label key={t.name} className={`bind-option${sceneSet.has(t.name) ? ' on' : ''}`}>
                <input
                  type="checkbox"
                  checked={sceneSet.has(t.name)}
                  onChange={() => toggleScene(t.name)}
                />
                <span>{t.name}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <div className="mini-foot">
          <button
            type="button"
            className="icon-ghost danger"
            aria-label="删除槽"
            title="删除槽"
            onClick={onRequestDelete}
          >
            <Trash size={16} />
          </button>
          <button type="button" className="ghost" onClick={onClose}>
            取消
          </button>
          <button type="button" className="primary" onClick={save} disabled={!draftName.trim()}>
            保存
          </button>
        </div>
      </div>
    </div>
  );
}

/** 0057：删除确认——先把影响数说清（成立主张 N 条将降为未编目、涉及对象 M 个），danger 确认。 */
function SlotDeleteDialog({ slot, onClose }: { slot: SlotDef; onClose: () => void }) {
  const { state, dispatch } = useStore();

  useMiniDialogEscape(onClose);

  const claimCount = state.claims.filter(
    (claim) =>
      claim.predicate === slot.name &&
      claim.status === '成立' &&
      (state.objects.some((o) => o.id === claim.objectId && o.kind === slot.kind) ||
        !state.objects.some((o) => o.id === claim.objectId)),
  );
  const objectCount = new Set(claimCount.map((claim) => claim.objectId)).size;

  return (
    <div className="mini-overlay" role="presentation" onMouseDown={onClose}>
      <div
        className="mini-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="delete-slot-title"
        aria-describedby="delete-slot-detail"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="mini-head" id="delete-slot-title">
          删除字段
        </div>
        <p className="dim" id="delete-slot-detail">
          删除「{slot.name}」会把 {claimCount.length} 条成立主张降为「未编目」（涉及 {objectCount}{' '}
          个对象）：不再参与冲突判定，简报只作「材料提到」，整理会提议编目。
          已关窗主张保留原名作历史。此操作不提供一键撤销。
        </p>
        <div className="mini-foot">
          <button type="button" className="ghost" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="primary danger"
            onClick={() => {
              dispatch({ type: 'REMOVE_SLOT', name: slot.name, kind: slot.kind });
              onClose();
            }}
          >
            确认删除
          </button>
        </div>
      </div>
    </div>
  );
}

/** 0058：场景模板管理区——列表（名称 + 内置标记 + 建对象引导摘要）与新建/编辑/删除入口。 */
function ScenarioTemplates() {
  const { state, dispatch } = useStore();
  // 'new' = 新建空模板；ScenarioTemplate = 编辑既有（改名走 previousName，由 reducer 守卫）。
  const [draft, setDraft] = useState<'new' | ScenarioTemplate | null>(null);

  return (
    <div className="settings-body">
      <div className="settings-block">
        <p className="models-lead">
          场景模板决定建区后的字段预设、简报说明、建对象引导与说明书。内置基线可改内容、不可删除；被工作区引用的模板先移除或改区再删。
        </p>
        <div className="tpl-list">
          {state.scenarioTemplates.map((t) => (
            <div className="tpl-row" key={t.name}>
              <span className="slot-name">
                {t.name}
                {t.builtin && <span className="tag grey">内置</span>}
              </span>
              <span className="slot-scenarios">{t.hint}</span>
              <span className="slot-row-actions">
                <button
                  type="button"
                  className="icon-ghost"
                  aria-label={`编辑模板 ${t.name}`}
                  title="编辑模板"
                  onClick={() => setDraft(t)}
                >
                  <PencilSimple size={14} />
                </button>
                <button
                  type="button"
                  className="icon-ghost danger"
                  aria-label={`删除模板 ${t.name}`}
                  title={t.builtin ? '内置基线，不可删除' : '删除模板'}
                  disabled={t.builtin}
                  onClick={() => dispatch({ type: 'REMOVE_SCENARIO_TEMPLATE', name: t.name })}
                >
                  <Trash size={14} />
                </button>
              </span>
            </div>
          ))}
        </div>
        <div>
          <button type="button" className="primary small" onClick={() => setDraft('new')}>
            <Plus size={12} /> 新建模板
          </button>
        </div>
      </div>
      {draft && (
        <ScenarioTemplateDialog
          template={draft === 'new' ? null : draft}
          onClose={() => setDraft(null)}
        />
      )}
    </div>
  );
}

/**
 * 0058：模板编辑 mini-dialog——名称（内置禁改）、建对象引导、说明书、简报说明块编辑。
 * 块标题/表外谓词/撞名等守卫在 reducer（applyAction），失败只 toast，不在 UI 重复实现。
 */
function ScenarioTemplateDialog({
  template,
  onClose,
}: {
  template: ScenarioTemplate | null;
  onClose: () => void;
}) {
  const { state, dispatch } = useStore();
  const [name, setName] = useState(template?.name ?? '');
  const [hint, setHint] = useState(template?.hint ?? '');
  const [playbook, setPlaybook] = useState(template?.playbook ?? '');
  const [blocks, setBlocks] = useState<BriefSpecBlock[]>(() =>
    template
      ? template.briefSpec.map((b) => ({
          ...b,
          predicates: b.predicates ? [...b.predicates] : undefined,
        }))
      : [
          // 空模板默认两块，对齐「自定义」基线：背景 + 材料缺口。
          { title: '关键事实', kind: 'background' },
          { title: '材料缺口', kind: 'gaps' },
        ],
  );

  useMiniDialogEscape(onClose);

  const patchBlock = (index: number, patch: Partial<BriefSpecBlock>) => {
    setBlocks((prev) => prev.map((b, i) => (i === index ? { ...b, ...patch } : b)));
  };
  const togglePredicate = (index: number, predicate: Predicate) => {
    setBlocks((prev) =>
      prev.map((b, i) => {
        if (i !== index) return b;
        const set = new Set(b.predicates ?? []);
        if (set.has(predicate)) set.delete(predicate);
        else set.add(predicate);
        return { ...b, predicates: [...set] };
      }),
    );
  };
  const changeKind = (index: number, kind: BriefBlockKind) => {
    // 谓词只装 slots 块（0033 组装口径），切走即弃，不留语义错位的数组。
    patchBlock(index, kind === 'slots' ? { kind } : { kind, predicates: undefined });
  };

  // 0025：候选 = 受控谓词表全部槽名（同槽名跨种类只展示一次），不许自开槽。
  const slotNames = [...new Set(state.slotDefs.map((d) => d.name))];

  const save = () => {
    dispatch({
      type: 'UPSERT_SCENARIO_TEMPLATE',
      template: {
        name,
        builtin: template?.builtin ?? false,
        hint,
        playbook,
        briefSpec: blocks,
      },
      previousName: template?.name,
    });
    onClose();
  };

  return (
    <div className="mini-overlay" role="presentation" onMouseDown={onClose}>
      <div
        className="mini-dialog tpl-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={template ? `编辑场景模板 ${template.name}` : '新建场景模板'}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="mini-head">
          {template ? '编辑场景模板' : '新建场景模板'}
          <button type="button" className="icon-ghost" onClick={onClose} aria-label="关闭">
            <X size={14} />
          </button>
        </div>
        <label className="field">
          模板名称
          <input
            value={name}
            disabled={template?.builtin ?? false}
            aria-label="模板名称"
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        {template?.builtin && <p className="bind-hint">内置基线，名称不可改；内容仍可编辑。</p>}
        <label className="field">
          建对象引导
          <input
            value={hint}
            aria-label="建对象引导"
            placeholder="建对象时的提示语，例如：公司或岗位名"
            onChange={(e) => setHint(e.target.value)}
          />
        </label>
        <label className="field">
          说明书
          <textarea
            rows={4}
            value={playbook}
            aria-label="说明书"
            placeholder="每次开场必读的规矩：出站纪律、未知占位、简报说明"
            onChange={(e) => setPlaybook(e.target.value)}
          />
        </label>
        <div className="field">
          简报说明
          <div className="tpl-blocks">
            {blocks.map((block, index) => (
              <div className="tpl-block" key={index}>
                <div className="tpl-block-head">
                  <input
                    value={block.title}
                    aria-label={`块 ${index + 1} 标题`}
                    placeholder="块标题"
                    onChange={(e) => patchBlock(index, { title: e.target.value })}
                  />
                  <select
                    value={block.kind}
                    aria-label={`块 ${index + 1} 类型`}
                    onChange={(e) => changeKind(index, e.target.value as BriefBlockKind)}
                  >
                    {(Object.keys(BLOCK_KIND_LABELS) as BriefBlockKind[]).map((kind) => (
                      <option key={kind} value={kind}>
                        {BLOCK_KIND_LABELS[kind]}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="icon-ghost danger"
                    aria-label={`删除块 ${index + 1}`}
                    title="删除块"
                    disabled={blocks.length <= 1}
                    onClick={() => setBlocks((prev) => prev.filter((_, i) => i !== index))}
                  >
                    <Trash size={14} />
                  </button>
                </div>
                {block.kind === 'slots' && (
                  <div className="slot-scene-grid">
                    {slotNames.map((slotName) => (
                      <label
                        key={slotName}
                        className={`bind-option${block.predicates?.includes(slotName) ? ' on' : ''}`}
                      >
                        <input
                          type="checkbox"
                          checked={block.predicates?.includes(slotName) ?? false}
                          onChange={() => togglePredicate(index, slotName)}
                        />
                        <span>{slotName}</span>
                      </label>
                    ))}
                  </div>
                )}
              </div>
            ))}
            <button
              type="button"
              className="ghost small"
              onClick={() => setBlocks((prev) => [...prev, { title: '', kind: 'background' }])}
            >
              <Plus size={12} /> 加块
            </button>
          </div>
        </div>
        <div className="mini-foot">
          <button type="button" className="ghost" onClick={onClose}>
            取消
          </button>
          <button type="button" className="primary" onClick={save} disabled={!name.trim()}>
            保存
          </button>
        </div>
      </div>
    </div>
  );
}

function ThemeCube({ id, label, Icon }: { id: ThemePreference; label: string; Icon: typeof Sun }) {
  const { state, dispatch } = useStore();
  return (
    <button
      type="button"
      className={`theme-cube${state.themePreference === id ? ' on' : ''}`}
      aria-pressed={state.themePreference === id}
      onClick={() => dispatch({ type: 'SET_THEME', preference: id })}
    >
      <Icon size={20} />
      {label}
    </button>
  );
}

function ModelsWorkbench() {
  const { state, dispatch } = useStore();
  const [selectedId, setSelectedId] = useState(state.activeProviderId);
  const [adding, setAdding] = useState(false);
  const selected = adding
    ? null
    : (state.providers.find((p) => p.id === selectedId) ?? state.providers[0] ?? null);
  const currentProvider = state.providers.find(
    (provider) => provider.id === state.activeProviderId,
  );
  const currentModel = currentProvider?.models.find((model) => model.id === state.activeModelId);

  return (
    <div className="models-work">
      <p className="models-lead">
        这里是产品唯一的模型配置入口。配置一次后，所有工作区和大脑文件共用。
      </p>
      <QualificationSummary provider={currentProvider} model={currentModel} />
      <div className="models-card">
        <aside className="models-rail">
          <div className="models-rail-label">供应商</div>
          {state.providers.map((p) => (
            <button
              key={p.id}
              type="button"
              className={`models-rail-item${p.id === selected?.id && !adding ? ' on' : ''}`}
              onClick={() => {
                setAdding(false);
                setSelectedId(p.id);
              }}
            >
              <Cube size={14} />
              <span>{p.name}</span>
              <span className={`cred-dot${p.apiKey.trim() ? ' ok' : ' miss'}`} />
            </button>
          ))}
          <button
            type="button"
            className={`models-add-prov${adding ? ' on' : ''}`}
            onClick={() => setAdding(true)}
          >
            <Plus size={14} /> 添加供应商
          </button>
        </aside>
        <div className="models-main">
          {adding ? (
            <AddProviderForm
              onCancel={() => setAdding(false)}
              onCreate={(p) => {
                dispatch({ type: 'UPSERT_PROVIDER', provider: p });
                dispatch({ type: 'SET_ACTIVE_PROVIDER', id: p.id });
                setAdding(false);
                setSelectedId(p.id);
              }}
            />
          ) : selected ? (
            <ProviderDetail
              provider={selected}
              onChange={(p) => dispatch({ type: 'UPSERT_PROVIDER', provider: p })}
              onDelete={() => {
                dispatch({ type: 'REMOVE_PROVIDER', id: selected.id });
                setSelectedId(state.providers.find((x) => x.id !== selected.id)?.id ?? '');
              }}
            />
          ) : (
            <div className="dim pad">没有供应商</div>
          )}
        </div>
      </div>
    </div>
  );
}

function QualificationSummary({
  provider,
  model,
}: {
  provider: LlmProvider | undefined;
  model: LlmModel | undefined;
}) {
  const { state } = useStore();
  const qualification = state.qualification;
  const metrics = qualification.report?.metrics;
  const running = qualification.status === '认证中';
  const ready = Boolean(provider?.apiKey.trim() && model && !running);
  return (
    <section className="cert-panel" aria-label="当前模型资格认证">
      <div className="prov-title">
        <strong>当前模型资格</strong>
        <span className={`pill ${qualification.status === '已认证' ? 'on' : ''}`}>
          {qualification.status}
        </span>
        {qualification.connect && (
          <span className={`tag ${qualification.connect.status === '通过' ? 'green' : 'red'}`}>
            连通{qualification.connect.status}
          </span>
        )}
        {qualification.capability && (
          <span className={`tag ${qualification.capability.status === '通过' ? 'green' : 'red'}`}>
            能力{qualification.capability.status}
          </span>
        )}
        <button
          type="button"
          className="primary small"
          disabled={!ready}
          onClick={() => {
            if (provider && model) void window.staffdesk.testProvider(provider.id, model.id);
          }}
        >
          {running ? '认证运行中…' : '运行资格认证'}
        </button>
      </div>
      <p className="dim">
        {provider && model
          ? `${qualification.endpointIdentity ?? provider.baseUrl} · ${model.id}`
          : '先启用一个端点并选择模型。未认证仍可使用。'}
      </p>
      {qualification.report && (
        <div className="cert-chips">
          {qualification.report.stages.map((stage) => (
            <span key={stage.name} className={`tag ${stage.status === '通过' ? 'green' : 'red'}`}>
              {stage.name}：{stage.status}
            </span>
          ))}
        </div>
      )}
      {qualification.report?.stages
        .filter((stage) => stage.status !== '通过')
        .map((stage) => (
          <p className="dim" key={stage.name}>
            失败位置：{stage.name} · {stage.detail ?? '未运行'}
          </p>
        ))}
      {qualification.detail && <p className="dim">{qualification.detail}</p>}
      {metrics && (
        <div className="cert-chips">
          <span className="tag green">抽取召回 {metrics.extractionRecall}%</span>
          <span className="tag green">出处命中 {metrics.spanHit}%</span>
          <span className="tag green">Recall@k {metrics.ftsRecallAtK}%</span>
          <span className="tag green">Precision@k {metrics.ftsPrecisionAtK}%</span>
          <span className="tag green">MRR {metrics.mrr}</span>
          <span className="tag green">简报忠实 {metrics.briefFaithfulness}%</span>
          <span className="tag green">未知遵守 {metrics.unknownAdherence}%</span>
          <span className="tag green">冲突检出 {metrics.conflictDetection}%</span>
          <span className="tag green">纠正复发 {metrics.correctionRecurrence}%</span>
          <span className="tag green">未编目纪律 {metrics.uncatDiscipline}%</span>
          <span className="tag green">撤销补偿 {metrics.undoCompensation}%</span>
          <span className={`tag ${metrics.fabrication > 5 ? 'red' : 'green'}`}>
            编造率 {metrics.fabrication}%（红线 5%）
          </span>
        </div>
      )}
    </section>
  );
}

function AddProviderForm({
  onCancel,
  onCreate,
}: {
  onCancel: () => void;
  onCreate: (p: LlmProvider) => void;
}) {
  const [name, setName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [models, setModels] = useState<LlmModel[]>([]);
  const [showKey, setShowKey] = useState(false);

  const ready = name.trim() && baseUrl.trim() && models.length > 0;

  return (
    <div className="prov-detail">
      <h3>添加模型供应商</h3>
      <p className="dim">配置 API 端点和至少一个模型。</p>
      <label className="field">
        名称
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="如：DeepSeek" />
      </label>
      <label className="field">
        Base URL
        <input
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder="https://你的端点/v1"
        />
      </label>
      <label className="field">
        API Key
        <span className="key-row">
          <input
            type={showKey ? 'text' : 'password'}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="输入 API Key"
            autoComplete="off"
          />
          <button
            type="button"
            className="icon-ghost"
            onClick={() => setShowKey((v) => !v)}
            aria-label="显示密钥"
          >
            {showKey ? <EyeSlash size={16} /> : <Eye size={16} />}
          </button>
        </span>
      </label>
      <p className="models-hint">当前支持 OpenAI-compatible Chat Completions 接口。</p>
      <ModelList models={models} onChange={setModels} />
      {!models.length && <p className="models-hint">添加供应商前，请至少添加一个模型。</p>}
      <div className="prov-foot">
        <button type="button" className="ghost" onClick={onCancel}>
          取消
        </button>
        <button
          type="button"
          className="primary"
          disabled={!ready}
          onClick={() =>
            onCreate({
              id: newProviderId(),
              name: name.trim(),
              baseUrl: baseUrl.trim(),
              apiKey: apiKey.trim(),
              enabled: true,
              models,
            })
          }
        >
          添加供应商
        </button>
      </div>
    </div>
  );
}

function newProviderId(): string {
  return `p-${globalThis.crypto.randomUUID()}`;
}

function ProviderDetail({
  provider,
  onChange,
  onDelete,
}: {
  provider: LlmProvider;
  onChange: (p: LlmProvider) => void;
  onDelete: () => void;
}) {
  const { state } = useStore();
  const [showKey, setShowKey] = useState(false);
  const [nameEdit, setNameEdit] = useState(false);
  const current = state.activeProviderId === provider.id && provider.enabled;

  return (
    <div className="prov-detail">
      <div className="prov-title">
        {nameEdit ? (
          <input
            className="prov-name-input"
            value={provider.name}
            autoFocus
            onChange={(e) => onChange({ ...provider, name: e.target.value })}
            onBlur={() => setNameEdit(false)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') setNameEdit(false);
            }}
          />
        ) : (
          <h3>
            {provider.name}
            <button
              type="button"
              className="icon-ghost"
              onClick={() => setNameEdit(true)}
              aria-label="改名"
            >
              <PencilSimple size={14} />
            </button>
          </h3>
        )}
        <span className={`pill ${provider.enabled ? 'on' : ''}`}>
          {provider.enabled ? '已启用' : '已禁用'}
        </span>
        <button
          type="button"
          className="ghost small"
          onClick={() => onChange({ ...provider, enabled: !provider.enabled })}
        >
          {provider.enabled ? '禁用' : '启用'}
        </button>
        {current && <span className="tag green">当前</span>}
        <button
          type="button"
          className="icon-ghost danger"
          onClick={onDelete}
          aria-label="删除供应商"
          style={{ marginLeft: 'auto' }}
        >
          <Trash size={16} />
        </button>
      </div>
      <label className="field">
        Base URL
        <input
          value={provider.baseUrl}
          onChange={(e) => onChange({ ...provider, baseUrl: e.target.value })}
        />
      </label>
      <p className="models-hint">OpenAI-compatible Chat Completions</p>
      <label className="field">
        API Key
        <span className="key-row">
          <input
            type={showKey ? 'text' : 'password'}
            value={provider.apiKey}
            onChange={(e) => onChange({ ...provider, apiKey: e.target.value })}
            placeholder="输入 API Key"
            autoComplete="off"
          />
          <button
            type="button"
            className="icon-ghost"
            onClick={() => setShowKey((v) => !v)}
            aria-label="显示密钥"
          >
            {showKey ? <EyeSlash size={16} /> : <Eye size={16} />}
          </button>
        </span>
      </label>
      <ModelList
        models={provider.models}
        onChange={(models) => onChange({ ...provider, models })}
        onTest={
          provider.enabled && provider.apiKey.trim()
            ? async (modelId) => {
                await window.staffdesk.dispatch({
                  type: 'SET_ACTIVE_MODEL',
                  providerId: provider.id,
                  modelId,
                });
                await window.staffdesk.testProvider(provider.id, modelId);
              }
            : undefined
        }
      />
    </div>
  );
}

function ModelList({
  models,
  onChange,
  onTest,
}: {
  models: LlmModel[];
  onChange: (models: LlmModel[]) => void;
  onTest?: ((modelId: string) => void | Promise<void>) | undefined;
}) {
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<LlmModel | null>(null);
  const [draftName, setDraftName] = useState('');

  return (
    <div className="field">
      模型列表
      <div className="model-list">
        {models.map((m) => (
          <div className="model-row" key={m.id}>
            <span className="model-name">{m.name}</span>
            <span className="model-ctx">{fmtCtx(m.contextWindow)}</span>
            <button
              type="button"
              className="icon-ghost"
              title="三级自检（连通 / 能力探测 / 资格认证）"
              onClick={() => void onTest?.(m.id)}
              disabled={!onTest}
            >
              <Plugs size={14} />
            </button>
            <button type="button" className="icon-ghost" title="编辑" onClick={() => setEditing(m)}>
              <PencilSimple size={14} />
            </button>
            <button
              type="button"
              className="icon-ghost danger"
              title="删除"
              onClick={() => onChange(models.filter((x) => x.id !== m.id))}
            >
              <Trash size={14} />
            </button>
          </div>
        ))}
        {adding ? (
          <form
            className="model-add"
            onSubmit={(e) => {
              e.preventDefault();
              const name = draftName.trim();
              if (!name) return;
              onChange([...models, { id: name, name, contextWindow: 128000, maxOutput: 8192 }]);
              setDraftName('');
              setAdding(false);
            }}
          >
            <input
              autoFocus
              value={draftName}
              placeholder="模型 ID"
              onChange={(e) => setDraftName(e.target.value)}
            />
            <button type="submit" className="primary small" disabled={!draftName.trim()}>
              添加
            </button>
            <button type="button" className="ghost small" onClick={() => setAdding(false)}>
              取消
            </button>
          </form>
        ) : (
          <button type="button" className="ghost small" onClick={() => setAdding(true)}>
            <Plus size={12} /> 添加模型
          </button>
        )}
      </div>
      {editing && (
        <ModelEditDialog
          model={editing}
          onClose={() => setEditing(null)}
          onSave={(next) => {
            onChange(models.map((x) => (x.id === editing.id ? next : x)));
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

function ModelEditDialog({
  model,
  onClose,
  onSave,
}: {
  model: LlmModel;
  onClose: () => void;
  onSave: (m: LlmModel) => void;
}) {
  const [draft, setDraft] = useState(model);
  return (
    <div className="mini-overlay">
      <div className="mini-dialog">
        <div className="mini-head">
          编辑模型配置
          <button type="button" className="icon-ghost" onClick={onClose} aria-label="关闭">
            <X size={14} />
          </button>
        </div>
        <label className="field">
          模型 ID
          <input
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, id: e.target.value, name: e.target.value })}
          />
        </label>
        <label className="field">
          上下文窗口
          <input
            type="number"
            value={draft.contextWindow}
            onChange={(e) => setDraft({ ...draft, contextWindow: Number(e.target.value) || 0 })}
          />
        </label>
        <label className="field">
          最大输出 Token
          <input
            type="number"
            value={draft.maxOutput}
            onChange={(e) => setDraft({ ...draft, maxOutput: Number(e.target.value) || 0 })}
          />
        </label>
        <div className="mini-foot">
          <button type="button" className="ghost" onClick={onClose}>
            取消
          </button>
          <button type="button" className="primary" onClick={() => onSave(draft)}>
            保存
          </button>
        </div>
      </div>
    </div>
  );
}
