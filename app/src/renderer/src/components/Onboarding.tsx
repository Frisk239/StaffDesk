import { useState } from 'react';
import {
  Buildings,
  Check,
  CheckCircle,
  Code,
  FolderOpen,
  GraduationCap,
  MagnifyingGlass,
  PlugsConnected,
  ShieldCheck,
  Sparkle,
  Tray,
  UploadSimple,
  User,
} from '@phosphor-icons/react';
import type { LlmProvider, ObjectKind, ScenarioKind } from '@shared/types';
import { useStore } from '../store';

const STEPS = ['选择用途', '连接模型', '检查连接', '建立对象', '放入材料'] as const;

// 0058：场景是数据行——图标表只认内置键，未知模板（自定义）回落通用图标；
// 「自定义」键保留作其一。hint/名称一律来自 state.scenarioTemplates。
const SCENARIO_ICONS: Record<string, typeof Buildings> = {
  求职面试: Buildings,
  求学申请: GraduationCap,
  技术选型: Code,
  尽调研究: MagnifyingGlass,
  自定义: Sparkle,
};

const OBJECTS: { kind: ObjectKind; title: string; hint: string; Icon: typeof User }[] = [
  { kind: '组织', title: '组织', hint: '公司、学校或机构', Icon: Buildings },
  { kind: '项目', title: '项目', hint: '岗位、产品或研究课题', Icon: FolderOpen },
  { kind: '人', title: '人', hint: '联系人、面试官或导师', Icon: User },
];

function providerDraft(provider: LlmProvider | undefined): LlmProvider {
  return (
    provider ?? {
      id: `p-${globalThis.crypto.randomUUID()}`,
      name: '自定义端点',
      baseUrl: '',
      apiKey: '',
      enabled: true,
      models: [{ id: '', name: '', contextWindow: 128000, maxOutput: 8192 }],
    }
  );
}

export function Onboarding({ onClose }: { onClose: () => void }) {
  const { state } = useStore();
  const currentWorkspace = state.workspaces.find((w) => w.id === state.currentWorkspaceId);
  const initialProvider =
    state.providers.find((item) => item.id === state.activeProviderId) ?? state.providers[0];
  const [step, setStep] = useState(0);
  const [scenario, setScenario] = useState<ScenarioKind>(currentWorkspace?.scenario ?? '求职面试');
  const [wsName, setWsName] = useState(currentWorkspace?.name ?? '我的工作区');
  const [workspaceReady, setWorkspaceReady] = useState(Boolean(currentWorkspace));
  const [provider, setProvider] = useState<LlmProvider>(() => providerDraft(initialProvider));
  const [checking, setChecking] = useState(false);
  const [objectNames, setObjectNames] = useState<Record<ObjectKind, string>>({
    人: '',
    组织: '',
    项目: '',
  });
  const [sourceDraft, setSourceDraft] = useState('');
  const [sourceBusy, setSourceBusy] = useState(false);

  const cert = state.qualification;
  const modelId = provider.models[0]?.id ?? '';
  const canSaveProvider = Boolean(
    provider.name.trim() && provider.baseUrl.trim() && modelId.trim(),
  );
  const createdCount = Object.values(objectNames).filter((name) => name.trim()).length;

  const finish = async () => {
    await window.staffdesk.dispatch({ type: 'SET_VIEW', view: { kind: 'inbox' } });
    await window.staffdesk.dispatch({ type: 'SET_ONBOARDING', done: true });
    onClose();
  };

  // 跳过只关闭本次向导；完成状态必须由真正完成向导写入，保留“继续设置”入口。
  const skip = () => onClose();

  const saveWorkspace = async () => {
    if (!workspaceReady) {
      const name = wsName.trim();
      if (!name) return;
      await window.staffdesk.dispatch({ type: 'ADD_WORKSPACE', name, scenario });
      setWorkspaceReady(true);
    }
    setStep(1);
  };

  const selectProvider = (id: string) => {
    const next = state.providers.find((item) => item.id === id);
    if (next) setProvider({ ...next, models: next.models.map((model) => ({ ...model })) });
  };

  const saveProvider = async () => {
    if (!canSaveProvider) return;
    const name = provider.models[0]?.id.trim() ?? '';
    const next = {
      ...provider,
      name: provider.name.trim(),
      baseUrl: provider.baseUrl.trim(),
      apiKey: provider.apiKey.trim(),
      enabled: true,
      models: provider.models.length
        ? [{ ...provider.models[0]!, id: name, name }, ...provider.models.slice(1)]
        : [],
    };
    await window.staffdesk.dispatch({ type: 'UPSERT_PROVIDER', provider: next });
    await window.staffdesk.dispatch({ type: 'SET_ACTIVE_PROVIDER', id: next.id });
    await window.staffdesk.dispatch({
      type: 'SET_ACTIVE_MODEL',
      providerId: next.id,
      modelId: name,
    });
    setProvider(next);
    setStep(2);
  };

  const runCheck = async () => {
    if (!provider.apiKey.trim()) return;
    setChecking(true);
    try {
      await window.staffdesk.testProvider(provider.id, modelId);
    } finally {
      setChecking(false);
    }
  };

  const createObjects = async () => {
    for (const item of OBJECTS) {
      const name = objectNames[item.kind].trim();
      if (name) await window.staffdesk.dispatch({ type: 'ADD_OBJECT', kind: item.kind, name });
    }
    setStep(4);
  };

  const addSourceAndFinish = async () => {
    const body = sourceDraft.trim();
    setSourceBusy(true);
    let finished = false;
    try {
      if (body) {
        const fromUrl = /^https?:\/\//i.test(body);
        if (fromUrl) await window.staffdesk.ingestUrl(body);
        else await window.staffdesk.ingestText(body, body.slice(0, 32));
      }
      await finish();
      finished = true;
    } finally {
      if (!finished) setSourceBusy(false);
    }
  };

  const chooseFilesAndFinish = async () => {
    setSourceBusy(true);
    let finished = false;
    try {
      const before = state.sources.length + state.ingestJobs.length;
      const next = await window.staffdesk.chooseAndIngestFiles();
      const after = next.sources.length + next.ingestJobs.length;
      if (after > before) {
        await finish();
        finished = true;
      }
    } finally {
      if (!finished) setSourceBusy(false);
    }
  };

  return (
    <div className="onboarding-overlay">
      <div className="onboarding-mask" />
      <section
        className="onboarding-panel"
        role="dialog"
        aria-modal="true"
        aria-label="开始使用 StaffDesk"
      >
        <aside className="onboarding-rail">
          <div className="onboarding-brand">
            <span className="onboarding-brand-mark">
              <ShieldCheck size={17} weight="fill" />
            </span>
            <span>
              <strong>StaffDesk</strong>
              <small>把材料变成可核对的判断</small>
            </span>
          </div>

          <nav className="onboarding-steps" aria-label="设置进度">
            {STEPS.map((title, index) => {
              const done = index < step;
              const active = index === step;
              return (
                <button
                  key={title}
                  type="button"
                  className={`${active ? 'on' : ''}${done ? ' done' : ''}`}
                  aria-current={active ? 'step' : undefined}
                  disabled={!done}
                  onClick={() => setStep(index)}
                >
                  <span className="onboarding-step-index">
                    {done ? <Check size={12} weight="bold" /> : index + 1}
                  </span>
                  <strong>{title}</strong>
                </button>
              );
            })}
          </nav>

          <button type="button" className="onboarding-skip" onClick={() => void skip()}>
            跳过向导
          </button>
        </aside>

        <main className="onboarding-main">
          <div className="onboarding-head">
            <span>
              {step + 1} / {STEPS.length}
            </span>
            {currentWorkspace && step > 0 && (
              <span className="onboarding-context">{currentWorkspace.name}</span>
            )}
          </div>

          <div className="onboarding-content">
            {step === 0 && (
              <>
                <div className="onboarding-copy">
                  <h1>你准备关注什么？</h1>
                  <p>选择用途后，StaffDesk 会加载对应的字段与简报结构。以后仍可调整。</p>
                </div>
                <div className="scenario-grid">
                  {/* 0058：场景清单改读 state.scenarioTemplates；图标按名取，未知模板用通用图标。 */}
                  {state.scenarioTemplates.map((item) => {
                    const Icon = SCENARIO_ICONS[item.name] ?? Sparkle;
                    return (
                      <button
                        key={item.name}
                        type="button"
                        className={scenario === item.name ? 'on' : ''}
                        aria-pressed={scenario === item.name}
                        onClick={() => setScenario(item.name)}
                      >
                        <Icon size={18} />
                        <span>
                          <strong>{item.name}</strong>
                          <small>{item.hint}</small>
                        </span>
                        {scenario === item.name && <CheckCircle size={17} weight="fill" />}
                      </button>
                    );
                  })}
                </div>
                <label className="onboarding-field">
                  工作区名称
                  <input
                    value={wsName}
                    disabled={workspaceReady}
                    placeholder="给这个工作区起个名字"
                    onChange={(event) => setWsName(event.target.value)}
                  />
                </label>
              </>
            )}

            {step === 1 && (
              <>
                <div className="onboarding-copy">
                  <h1>连接你自己的模型</h1>
                  <p>模型配置与 API Key 只保存在本机。这里填写的内容会同步到设置页。</p>
                </div>
                {state.providers.length > 0 ? (
                  <div className="provider-options" aria-label="已配置的模型供应商">
                    {state.providers.map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        className={provider.id === item.id ? 'on' : ''}
                        aria-pressed={provider.id === item.id}
                        onClick={() => selectProvider(item.id)}
                      >
                        <span className="provider-option-icon">
                          <PlugsConnected size={16} />
                        </span>
                        <span>{item.name}</span>
                        {provider.id === item.id && <Check size={13} weight="bold" />}
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className="provider-options-empty">
                    <PlugsConnected size={16} />
                    尚未配置模型。这里填写的端点会成为产品的全局模型配置。
                  </div>
                )}
                <div className="onboarding-form-grid">
                  <label className="onboarding-field span-2">
                    Base URL
                    <input
                      value={provider.baseUrl}
                      placeholder="https://你的模型端点/v1"
                      onChange={(event) =>
                        setProvider({ ...provider, baseUrl: event.target.value })
                      }
                    />
                  </label>
                  <label className="onboarding-field">
                    API Key
                    <input
                      type="password"
                      value={provider.apiKey}
                      placeholder="输入 API Key"
                      autoComplete="off"
                      onChange={(event) => setProvider({ ...provider, apiKey: event.target.value })}
                    />
                  </label>
                  <label className="onboarding-field">
                    模型 ID
                    <input
                      value={modelId}
                      placeholder="模型 ID"
                      onChange={(event) => {
                        const name = event.target.value;
                        const first = provider.models[0] ?? {
                          id: name,
                          name,
                          contextWindow: 128000,
                          maxOutput: 8192,
                        };
                        setProvider({
                          ...provider,
                          models: [{ ...first, id: name, name }, ...provider.models.slice(1)],
                        });
                      }}
                    />
                  </label>
                </div>
                <p className="onboarding-note">你也可以暂时不填，之后从设置里的“模型”继续。</p>
              </>
            )}

            {step === 2 && (
              <>
                <div className="onboarding-copy">
                  <h1>确认这套配置可用</h1>
                  <p>检查会真实访问端点，并用隔离测试样本验证结构化抽取，不会写入你的工作区。</p>
                </div>
                <div className="check-summary">
                  <div>
                    <span
                      className={`check-state${cert.connect?.status === '通过' ? ' ok' : cert.connect?.status === '失败' ? ' fail' : ''}`}
                    >
                      {cert.connect?.status === '通过' ? <Check size={13} /> : '1'}
                    </span>
                    <span>
                      <strong>端点连通</strong>
                      <small>{cert.connect?.detail ?? '确认地址与密钥可以访问'}</small>
                    </span>
                  </div>
                  <div>
                    <span
                      className={`check-state${cert.capability?.status === '通过' ? ' ok' : cert.capability?.status === '失败' ? ' fail' : ''}`}
                    >
                      {cert.capability?.status === '通过' ? <Check size={13} /> : '2'}
                    </span>
                    <span>
                      <strong>结构化能力</strong>
                      <small>{cert.capability?.detail ?? '确认模型能稳定返回结构化结果'}</small>
                    </span>
                  </div>
                  <div>
                    <span className={`check-state${cert.status === '已认证' ? ' ok' : ''}`}>
                      {cert.status === '已认证' ? <Check size={13} /> : '3'}
                    </span>
                    <span>
                      <strong>隔离样本验证</strong>
                      <small>
                        {cert.status === '已认证'
                          ? '已完成真实模型测试'
                          : (cert.detail ?? '样本数据不会进入你的大脑文件')}
                      </small>
                    </span>
                  </div>
                </div>
                {cert.status === '已认证' && cert.report && (
                  <div className="check-metrics">
                    <div>
                      <strong>{cert.report.metrics.ftsRecallAtK}%</strong>
                      <span>证据召回</span>
                    </div>
                    <div>
                      <strong>{cert.report.metrics.briefFaithfulness}%</strong>
                      <span>简报忠实</span>
                    </div>
                    <div>
                      <strong>{cert.report.metrics.unknownAdherence}%</strong>
                      <span>未知遵守</span>
                    </div>
                    <div className={cert.report.metrics.fabrication > 5 ? 'warn' : ''}>
                      <strong>{cert.report.metrics.fabrication}%</strong>
                      <span>编造率</span>
                    </div>
                  </div>
                )}
                {!provider.apiKey.trim() && (
                  <div className="onboarding-inline-message">
                    尚未填写 API Key。可以返回上一步填写，也可以稍后再检查。
                  </div>
                )}
              </>
            )}

            {step === 3 && (
              <>
                <div className="onboarding-copy">
                  <h1>建立第一个关注对象</h1>
                  <p>对象是材料、主张和简报的归属。填写一个即可，空白项不会创建。</p>
                </div>
                <div className="object-setup-grid">
                  {OBJECTS.map(({ kind, title, hint, Icon }) => (
                    <label key={kind} className="object-setup-card">
                      <span className="object-setup-title">
                        <Icon size={17} />
                        <strong>{title}</strong>
                      </span>
                      <small>{hint}</small>
                      <input
                        value={objectNames[kind]}
                        placeholder={`${title}名称`}
                        onChange={(event) =>
                          setObjectNames({ ...objectNames, [kind]: event.target.value })
                        }
                      />
                    </label>
                  ))}
                </div>
              </>
            )}

            {step === 4 && (
              <>
                <div className="onboarding-copy">
                  <h1>放入第一份真实材料</h1>
                  <p>
                    粘贴一段文字、链接，或选择 TXT/PDF 文件。它会先进入
                    Inbox；只有你确认绑定后，内容才会进入对象。
                  </p>
                </div>
                <label className="onboarding-source">
                  <span>
                    <Tray size={18} /> 材料内容
                  </span>
                  <textarea
                    rows={8}
                    value={sourceDraft}
                    placeholder="粘贴文本或 URL"
                    onChange={(event) => setSourceDraft(event.target.value)}
                  />
                </label>
                <div className="onboarding-source-actions">
                  <button
                    type="button"
                    className="btn outline"
                    disabled={sourceBusy}
                    onClick={() => void chooseFilesAndFinish()}
                  >
                    <UploadSimple size={16} /> 选择 TXT / PDF 文件
                  </button>
                  <span>文件正文只在主进程读取与解析，不会在界面里伪造成占位材料。</span>
                </div>
                <p className="onboarding-note">现在没有材料也没关系，可以直接进入 StaffDesk。</p>
              </>
            )}
          </div>

          <footer className="onboarding-actions">
            <button
              type="button"
              className="ghost"
              disabled={step === 0}
              onClick={() => setStep((value) => Math.max(0, value - 1))}
            >
              上一步
            </button>
            <div>
              {step === 1 && (
                <button type="button" className="onboarding-later" onClick={() => setStep(2)}>
                  稍后配置
                </button>
              )}
              {step === 2 && cert?.status !== '已认证' && (
                <button type="button" className="onboarding-later" onClick={() => setStep(3)}>
                  稍后检查
                </button>
              )}
              {step === 3 && createdCount === 0 && (
                <button type="button" className="onboarding-later" onClick={() => setStep(4)}>
                  稍后创建
                </button>
              )}
              {step === 0 && (
                <button
                  type="button"
                  className="primary"
                  disabled={!workspaceReady && !wsName.trim()}
                  onClick={() => void saveWorkspace()}
                >
                  {workspaceReady ? '继续' : '创建工作区'}
                </button>
              )}
              {step === 1 && (
                <button
                  type="button"
                  className="primary"
                  disabled={!canSaveProvider}
                  onClick={() => void saveProvider()}
                >
                  保存并继续
                </button>
              )}
              {step === 2 && cert?.status !== '已认证' && (
                <button
                  type="button"
                  className="primary"
                  disabled={checking || !provider.apiKey.trim()}
                  onClick={() => void runCheck()}
                >
                  {checking ? '检查中…' : '开始检查'}
                </button>
              )}
              {step === 2 && cert?.status === '已认证' && (
                <button type="button" className="primary" onClick={() => setStep(3)}>
                  继续
                </button>
              )}
              {step === 3 && (
                <button
                  type="button"
                  className="primary"
                  disabled={createdCount === 0}
                  onClick={() => void createObjects()}
                >
                  创建 {createdCount} 个对象
                </button>
              )}
              {step === 4 && (
                <button
                  type="button"
                  className="primary"
                  disabled={sourceBusy}
                  onClick={() => void addSourceAndFinish()}
                >
                  {sourceBusy
                    ? '处理中…'
                    : sourceDraft.trim()
                      ? '加入 Inbox 并开始'
                      : '进入 StaffDesk'}
                </button>
              )}
            </div>
          </footer>
        </main>
      </section>
    </div>
  );
}
