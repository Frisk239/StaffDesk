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
import type { ApiProtocol, LlmModel, LlmProvider, ObjectKind, ThemePreference } from '../types';

const CUBES: { id: ThemePreference; label: string; Icon: typeof Sun }[] = [
  { id: 'light', label: '明亮', Icon: Sun },
  { id: 'dark', label: '暗色', Icon: Moon },
  { id: 'system', label: '跟随系统', Icon: Monitor },
];

const PROTOCOLS: { id: ApiProtocol; label: string }[] = [
  { id: 'chat-completions', label: 'Chat Completions (/chat/completions)' },
  { id: 'anthropic-messages', label: 'Anthropic Messages (/v1/messages)' },
  { id: 'responses', label: 'Responses (/responses)' },
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
            </div>
          )}
          {section === '谓词表' && <SlotTable />}
          {section === '模型' && <ModelsWorkbench />}
        </div>
      </div>
    </div>
  );
}

function SlotTable() {
  const { state, dispatch } = useStore();
  const [name, setName] = useState('');
  const [kind, setKind] = useState<ObjectKind>('组织');
  const [arity, setArity] = useState<'单值' | '多值'>('单值');

  const kinds: ObjectKind[] = ['人', '组织', '项目'];
  const scenarioLabel = (s: string[]) => (s.length === 0 ? '通用' : s.join('、'));

  return (
    <div className="settings-body">
      <p className="models-lead">
        谓词表由人维护（0025）：抽取必须映射到表内，缺了由人加。单值槽上的不同取值才构成冲突（0029）。
      </p>
      {kinds.map((k) => (
        <div className="settings-block" key={k}>
          <div className="settings-label">{k}</div>
          <div className="slot-table">
            {state.slotDefs
              .filter((d) => d.kind === k)
              .map((d) => (
                <div className="slot-table-row" key={`${d.kind}-${d.name}`}>
                  <span className="slot-name">{d.name}</span>
                  <span className="tag grey">{d.arity}</span>
                  <span className="dim">{scenarioLabel(d.scenarios)}</span>
                </div>
              ))}
          </div>
        </div>
      ))}
      <div className="settings-block">
        <div className="settings-label">加槽（新槽默认通用）</div>
        <form
          className="slot-add"
          onSubmit={(e) => {
            e.preventDefault();
            if (!name.trim()) return;
            dispatch({ type: 'ADD_SLOT', name, kind, arity });
            setName('');
          }}
        >
          <input value={name} placeholder="槽名，如：竞对动态" onChange={(e) => setName(e.target.value)} />
          <div className="ws-kinds">
            {kinds.map((k) => (
              <button key={k} type="button" className={kind === k ? 'on' : ''} onClick={() => setKind(k)}>
                {k}
              </button>
            ))}
          </div>
          <div className="ws-kinds">
            {(['单值', '多值'] as const).map((a) => (
              <button key={a} type="button" className={arity === a ? 'on' : ''} onClick={() => setArity(a)}>
                {a}
              </button>
            ))}
          </div>
          <button type="submit" className="primary small" disabled={!name.trim()}>
            加槽
          </button>
        </form>
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
  const selected = adding ? null : state.providers.find((p) => p.id === selectedId) ?? state.providers[0] ?? null;

  return (
    <div className="models-work">
      <p className="models-lead">管理模型供应商，配置后可在对话里选用。</p>
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

function AddProviderForm({ onCancel, onCreate }: { onCancel: () => void; onCreate: (p: LlmProvider) => void }) {
  const { state } = useStore();
  const [name, setName] = useState('');
  const [baseUrl, setBaseUrl] = useState('https://api.example.com/v1');
  const [apiKey, setApiKey] = useState('');
  const [protocol, setProtocol] = useState<ApiProtocol>('chat-completions');
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
        <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
      </label>
      <label className="field">
        API Key
        <span className="key-row">
          <input type={showKey ? 'text' : 'password'} value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="输入 API Key" autoComplete="off" />
          <button type="button" className="icon-ghost" onClick={() => setShowKey((v) => !v)} aria-label="显示密钥">
            {showKey ? <EyeSlash size={16} /> : <Eye size={16} />}
          </button>
        </span>
      </label>
      <label className="field">
        API 格式
        <select value={protocol} onChange={(e) => setProtocol(e.target.value as ApiProtocol)}>
          {PROTOCOLS.map((x) => (
            <option key={x.id} value={x.id}>
              {x.label}
            </option>
          ))}
        </select>
      </label>
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
              id: `p-custom-${state.seq}`,
              kind: 'custom',
              name: name.trim(),
              baseUrl: baseUrl.trim(),
              apiKey: apiKey.trim(),
              protocol,
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

function ProviderDetail({
  provider,
  onChange,
  onDelete,
}: {
  provider: LlmProvider;
  onChange: (p: LlmProvider) => void;
  onDelete: () => void;
}) {
  const { state, dispatch } = useStore();
  const [showKey, setShowKey] = useState(false);
  const [nameEdit, setNameEdit] = useState(false);
  const current = state.activeProviderId === provider.id && provider.enabled;
  const cert = state.certByProvider[provider.id];

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
            <button type="button" className="icon-ghost" onClick={() => setNameEdit(true)} aria-label="改名">
              <PencilSimple size={14} />
            </button>
          </h3>
        )}
        <span className={`pill ${provider.enabled ? 'on' : ''}`}>{provider.enabled ? '已启用' : '已禁用'}</span>
        <button type="button" className="ghost small" onClick={() => onChange({ ...provider, enabled: !provider.enabled })}>
          {provider.enabled ? '禁用' : '启用'}
        </button>
        {current && <span className="tag green">当前</span>}
        {/* 0039：认证徽章——未认证灰、认证中琥珀、已认证绿；编造率超标另标红。 */}
        <span className={`pill ${cert?.status === '已认证' ? 'on' : ''}`}>
          {cert?.status ?? '未认证'}
        </span>
        {cert?.status === '已认证' && cert.fabrication != null && cert.fabrication > 5 && (
          <span className="tag red">编造率超标</span>
        )}
        {provider.kind === 'custom' && (
          <button type="button" className="icon-ghost danger" onClick={onDelete} aria-label="删除供应商" style={{ marginLeft: 'auto' }}>
            <Trash size={16} />
          </button>
        )}
      </div>
      {cert?.status === '认证中' && (
        <div className="cert-panel">
          <span className="pulse-dot" /> 三级自检：连通 → 能力探测 → 资格认证（原型模拟，不真连）
        </div>
      )}
      {cert?.status === '已认证' && (
        <div className="cert-panel">
          <div className="cert-chips">
            <span className="tag green">证据召回 {cert.recall}%</span>
            <span className="tag green">简报忠实 {cert.faithful}%</span>
            <span className="tag green">未知遵守 {cert.unknown}%</span>
            <span className={`tag ${(cert.fabrication ?? 0) > 5 ? 'red' : 'green'}`}>
              编造率 {cert.fabrication}%（唯一红线 5%）
            </span>
          </div>
          {cert.fabrication != null && cert.fabrication > 5 && (
            <p className="dim">该配置会系统性编造来源没说的命题，不适合跑参谋台；其余指标只展示不设闸。</p>
          )}
        </div>
      )}
      <label className="field">
        Base URL
        <input value={provider.baseUrl} onChange={(e) => onChange({ ...provider, baseUrl: e.target.value })} />
      </label>
      <label className="field">
        API 格式
        <select value={provider.protocol} onChange={(e) => onChange({ ...provider, protocol: e.target.value as ApiProtocol })}>
          {PROTOCOLS.map((x) => (
            <option key={x.id} value={x.id}>
              {x.label}
            </option>
          ))}
        </select>
      </label>
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
          <button type="button" className="icon-ghost" onClick={() => setShowKey((v) => !v)} aria-label="显示密钥">
            {showKey ? <EyeSlash size={16} /> : <Eye size={16} />}
          </button>
        </span>
      </label>
      <ModelList
        models={provider.models}
        onChange={(models) => onChange({ ...provider, models })}
        onTest={() => dispatch({ type: 'TEST_PROVIDER', id: provider.id })}
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
  onTest?: () => void;
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
            <button type="button" className="icon-ghost" title="三级自检（连通 / 能力探测 / 资格认证）" onClick={onTest}>
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
            <input autoFocus value={draftName} placeholder="模型 ID" onChange={(e) => setDraftName(e.target.value)} />
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
          <input value={draft.name} onChange={(e) => setDraft({ ...draft, id: e.target.value, name: e.target.value })} />
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
          <input type="number" value={draft.maxOutput} onChange={(e) => setDraft({ ...draft, maxOutput: Number(e.target.value) || 0 })} />
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
