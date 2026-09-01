import { useEffect, useState } from 'react';
import {
  Cpu,
  Cube,
  Eye,
  EyeSlash,
  GearSix,
  Moon,
  Monitor,
  PencilSimple,
  Plugs,
  Plus,
  Sun,
  Trash,
  X,
} from '@phosphor-icons/react';
import { useStore } from '../store';
import { briefSpecPredicates, SCENARIOS } from '@shared/scenario';
import type {
  LlmModel,
  LlmProvider,
  ObjectKind,
  ScenarioKind,
  SlotDef,
  ThemePreference,
} from '@shared/types';

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

export function SettingsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [section, setSection] = useState<'通用' | '谓词表' | '模型'>('通用');

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
          <button className={section === '谓词表' ? 'on' : ''} onClick={() => setSection('谓词表')}>
            <Cube size={16} /> 谓词表
          </button>
          <button className={section === '模型' ? 'on' : ''} onClick={() => setSection('模型')}>
            <Cpu size={16} /> 模型
          </button>
        </nav>
        <div className="settings-content">
          <div className="settings-content-head">
            {section === '通用' && <h2 className="settings-h">通用设置</h2>}
            {section === '模型' && <h2 className="settings-h">模型设置</h2>}
            {section === '谓词表' && <h2 className="settings-h">受控谓词表</h2>}
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
              <BrainFilePanel />
              <DeletedSourceRecoveryPanel />
            </div>
          )}
          {section === '谓词表' && <SlotTable />}
          {section === '模型' && <ModelsWorkbench />}
        </div>
      </div>
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
          Key、资格认证或构建产物。
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
                  const locked = briefSpecPredicates().has(d.name);
                  return (
                    <div className="slot-table-row" key={`${d.kind}-${d.name}`}>
                      <span className="slot-name">
                        {d.name}
                        {locked && <span className="tag grey">简报引用</span>}
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
                          title={locked ? '内置简报说明引用该槽，暂不能删除' : '删除槽'}
                          disabled={locked}
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
  const { dispatch } = useStore();
  const [draftName, setDraftName] = useState(slot.name);
  const [arity, setArity] = useState<'单值' | '多值'>(slot.arity);
  const [sceneSet, setSceneSet] = useState<Set<ScenarioKind>>(new Set(slot.scenarios));
  const locked = briefSpecPredicates().has(slot.name);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

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
        ...(locked ? {} : { name: draftName }),
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
            disabled={locked}
            aria-label="槽名"
            onChange={(e) => setDraftName(e.target.value)}
          />
        </label>
        {locked && (
          <p className="bind-hint">内置简报说明引用该字段，暂不能改名（场景数据化后解除）。</p>
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
            {SCENARIOS.map((scenario) => (
              <label key={scenario} className={`bind-option${sceneSet.has(scenario) ? ' on' : ''}`}>
                <input
                  type="checkbox"
                  checked={sceneSet.has(scenario)}
                  onChange={() => toggleScene(scenario)}
                />
                <span>{scenario}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <div className="mini-foot">
          <button
            type="button"
            className="icon-ghost danger"
            aria-label="删除槽"
            title={locked ? '内置简报说明引用该槽，暂不能删除' : '删除槽'}
            disabled={locked}
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

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

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
