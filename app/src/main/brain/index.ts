import type Database from 'better-sqlite3';
import { emptyUiFields } from '@shared/defaults';
import type {
  CurrentQualification,
  LlmProvider,
  QualityQualificationRecord,
  State,
} from '@shared/types';
import type { Action } from '@shared/actions';
import { applyAction } from './applyAction';
import { openDatabase } from './migrate';
import {
  appendOperation,
  clearLegacyModelMeta,
  clearModelSettingsOperations,
  interruptActiveIngestJobs,
  listDeletedSourceRecoveries,
  loadLedger,
  persistLedger,
  persistLedgerDiff,
  type PersistMode,
} from './persist';
import { listSlotDefs } from './presets';
import { REQUIRED_TABLES } from './schema';
import {
  closedClaims,
  conflictsOf,
  deriveConflicts,
  isExtracting,
  projectionClaims,
} from './projection';
import { createMemorySecrets, type SecretStore } from '../keychain';
import {
  createMemoryModelSettingsStore,
  modelSettingsFromState,
  normalizeLegacyModelSettings,
  type ModelSettings,
  type ModelSettingsStore,
} from '../llm/settings';
import {
  createMemoryQualificationStore,
  type QualificationStore,
} from '../eval/qualificationStore';
import {
  buildQualificationTarget,
  qualificationFingerprint,
  type QualificationTarget,
} from '../eval/fingerprint';

export type { Action };
export { deriveConflicts, listSlotDefs, projectionClaims, REQUIRED_TABLES };

export interface BrainOptions {
  /** 0056：默认按脏表差异写入；'full' 全量重写只留修复与等价对照通道。 */
  persistMode?: PersistMode;
}

export class Brain {
  readonly db: Database.Database;
  readonly filePath: string;
  readonly secrets: SecretStore;
  readonly modelSettings: ModelSettingsStore;
  readonly qualificationStore: QualificationStore;
  readonly persistMode: PersistMode;
  private ui: ReturnType<typeof emptyUiFields>;
  private runningQualification: { fingerprint: string; startedAt: string } | null = null;

  constructor(
    filePath: string,
    secrets: SecretStore = createMemorySecrets(),
    modelSettings: ModelSettingsStore = createMemoryModelSettingsStore(),
    qualificationStore: QualificationStore = createMemoryQualificationStore(),
    options: BrainOptions = {},
  ) {
    this.filePath = filePath;
    this.secrets = secrets;
    this.modelSettings = modelSettings;
    this.qualificationStore = qualificationStore;
    this.persistMode = options.persistMode ?? 'diff';
    this.db = openDatabase(filePath);
    const legacy = loadLedger(this.db);
    const stored = modelSettings.load();
    const legacyConfigured = normalizeLegacyModelSettings({
      providers: hydrateProviders([], legacy.providersJson, secrets),
      activeProviderId: legacy.activeProviderId,
      activeModelId: legacy.activeModelId,
      thinkingEffort: legacy.thinkingEffort,
    });
    const shouldMigrateLegacy =
      !stored || (stored.providers.length === 0 && legacyConfigured.providers.length > 0);
    const configured = shouldMigrateLegacy ? legacyConfigured : stored;
    if (shouldMigrateLegacy) modelSettings.save(configured);
    clearLegacyModelMeta(this.db);
    clearModelSettingsOperations(this.db);
    interruptActiveIngestJobs(this.db);
    this.ui = { ...emptyUiFields(), ...hydrateModelSettings(configured, secrets) };
  }

  snapshot(): State {
    const ledger = loadLedger(this.db);
    const sources = [...ledger.sources];
    if (!sources.some((s) => s.id === 'user-stmt')) {
      sources.push({
        id: 'user-stmt',
        title: '使用者陈述',
        body: '',
        path: '手给',
        boundObjectIds: [],
        virtual: true,
      });
    }
    const providers = hydrateProviders(this.ui.providers, '', this.secrets);
    return {
      ...this.ui,
      workspaces: ledger.workspaces,
      currentWorkspaceId: ledger.currentWorkspaceId,
      objects: ledger.objects,
      sources,
      ingestJobs: ledger.ingestJobs,
      deletedSourceRecoveries: listDeletedSourceRecoveries(this.db, ledger.sources),
      claims: ledger.claims,
      slotDefs: ledger.slotDefs,
      scenarioTemplates: ledger.scenarioTemplates,
      briefs: ledger.briefs,
      memories: ledger.memories,
      inbox: sources.filter((s) => !s.virtual && s.boundObjectIds.length === 0).map((s) => s.id),
      proposals: ledger.proposals,
      tasks: ledger.tasks,
      taskAudits: ledger.taskAudits,
      chatByObject: ledger.chatByObject,
      seq: ledger.seq,
      themePreference: ledger.themePreference,
      activeProviderId: this.ui.activeProviderId,
      activeModelId: this.ui.activeModelId,
      thinkingEffort: this.ui.thinkingEffort,
      extractJobs: this.ui.extractJobs,
      pendingClaims: this.ui.pendingClaims,
      view: this.ui.view,
      selectedClaimId: this.ui.selectedClaimId,
      sourceFocusId: this.ui.sourceFocusId,
      toast: this.ui.toast,
      briefDraftingFor: this.ui.briefDraftingFor,
      writeQueue: ledger.writeQueue,
      rightTabsByObject: this.ui.rightTabsByObject,
      activeRightTabByObject: this.ui.activeRightTabByObject,
      qualification: this.qualificationFor(providers),
      providers,
      onboardingDone: ledger.onboardingDone,
    };
  }

  dispatch(action: Action): State {
    const prev = this.snapshot();
    if (action.type === 'UPSERT_PROVIDER') {
      this.secrets.set(action.provider.id, action.provider.apiKey);
    }
    if (action.type === 'REMOVE_PROVIDER') {
      this.secrets.remove(action.id);
    }
    const loggedAction = withRecoveryPayload(action, prev);
    const next = applyAction(prev, loggedAction);
    if (isModelSettingsAction(loggedAction)) {
      this.modelSettings.save(modelSettingsFromState(next));
    }
    // 0056：dispatch 是唯一写漏斗，prev 是本次起点从库现读的快照，diff(prev,next) ≡ diff(DB,next)。
    if (this.persistMode === 'full') {
      persistLedger(this.db, next);
    } else {
      persistLedgerDiff(this.db, prev, next);
    }
    if (!isModelSettingsAction(loggedAction)) {
      appendOperation(
        this.db,
        loggedAction.type,
        loggedAction,
        loggedAction.type === 'UNDO_RESULT' ? 'compensating' : null,
      );
    }
    this.ui = {
      view: next.view,
      selectedClaimId: next.selectedClaimId,
      sourceFocusId: next.sourceFocusId,
      toast: next.toast,
      briefDraftingFor: next.briefDraftingFor,
      ingestJobs: next.ingestJobs,
      extractJobs: next.extractJobs,
      pendingClaims: next.pendingClaims,
      themePreference: next.themePreference,
      providers: next.providers,
      activeProviderId: next.activeProviderId,
      activeModelId: next.activeModelId,
      thinkingEffort: next.thinkingEffort,
      writeQueue: next.writeQueue,
      rightTabsByObject: next.rightTabsByObject,
      activeRightTabByObject: next.activeRightTabByObject,
      qualification: next.qualification,
      deletedSourceRecoveries: next.deletedSourceRecoveries,
    };
    return this.snapshot();
  }

  startQualification(target: QualificationTarget): State {
    this.runningQualification = {
      fingerprint: qualificationFingerprint(target),
      startedAt: new Date().toISOString(),
    };
    return this.snapshot();
  }

  finishQualification(record: QualityQualificationRecord): State {
    this.qualificationStore.save(record);
    if (this.runningQualification?.fingerprint === record.fingerprint) {
      this.runningQualification = null;
    }
    return this.snapshot();
  }

  private qualificationFor(providers: LlmProvider[]): CurrentQualification {
    const provider = providers.find(
      (candidate) => candidate.id === this.ui.activeProviderId && candidate.enabled,
    );
    if (!provider || !this.ui.activeModelId) return { status: '未配置' };
    let target: QualificationTarget;
    try {
      target = buildQualificationTarget(provider, this.ui.activeModelId, this.ui.thinkingEffort);
    } catch {
      return { status: '未配置' };
    }
    const fingerprint = qualificationFingerprint(target);
    if (this.runningQualification?.fingerprint === fingerprint) {
      return {
        status: '认证中',
        fingerprint,
        endpointIdentity: target.endpointIdentity,
        modelId: target.modelId,
        startedAt: this.runningQualification.startedAt,
      };
    }
    const record = this.qualificationStore.find(fingerprint);
    if (!record) {
      return {
        status: '未认证',
        fingerprint,
        endpointIdentity: target.endpointIdentity,
        modelId: target.modelId,
      };
    }
    const complete =
      record.suiteVersion === target.suiteVersion &&
      record.connect.status === '通过' &&
      record.capability.status === '通过' &&
      Boolean(record.report) &&
      record.report?.suiteVersion === target.suiteVersion &&
      record.report?.stages.every((stage) => stage.status === '通过');
    return {
      status: complete ? '已认证' : '未认证',
      fingerprint,
      endpointIdentity: record.endpointIdentity,
      modelId: record.modelId,
      completedAt: record.completedAt,
      connect: record.connect,
      capability: record.capability,
      report: record.report,
      detail: record.detail,
    };
  }

  /**
   * Last-resort recovery for an extraction terminal dispatch that could not be
   * persisted. Extract jobs are ephemeral UI state, so keeping this small escape
   * hatch here prevents a recoverable persistence error from showing forever as
   * 「抽取中」 without weakening normal ledger writes.
   */
  recoverExtractionFailure(sourceId: string, detail: string): State {
    const hasJob = this.ui.extractJobs.some((job) => job.sourceId === sourceId);
    this.ui = {
      ...this.ui,
      extractJobs: hasJob
        ? this.ui.extractJobs.map((job) =>
            job.sourceId === sourceId ? { ...job, status: '失败', detail } : job,
          )
        : [...this.ui.extractJobs, { sourceId, status: '失败', detail }],
      toast: { text: detail, id: Date.now() },
    };
    return this.snapshot();
  }

  close(): void {
    this.db.close();
  }
}

export function openBrain(
  filePath: string,
  secrets?: SecretStore,
  modelSettings?: ModelSettingsStore,
  qualificationStore?: QualificationStore,
  options?: BrainOptions,
): Brain {
  return new Brain(filePath, secrets, modelSettings, qualificationStore, options);
}

function hydrateProviders(
  current: LlmProvider[],
  json: string,
  secrets: SecretStore,
): LlmProvider[] {
  let listed = current;
  if (json) {
    try {
      listed = JSON.parse(json) as LlmProvider[];
    } catch {
      listed = current;
    }
  }
  return listed.map((p) => ({ ...p, apiKey: secrets.get(p.id) || p.apiKey || '' }));
}

function hydrateModelSettings(settings: ModelSettings, secrets: SecretStore) {
  return {
    providers: settings.providers.map((provider) => ({
      ...provider,
      apiKey: secrets.get(provider.id) || provider.apiKey || '',
    })),
    activeProviderId: settings.activeProviderId,
    activeModelId: settings.activeModelId,
    thinkingEffort: settings.thinkingEffort,
  };
}

function isModelSettingsAction(action: Action): boolean {
  return (
    action.type === 'UPSERT_PROVIDER' ||
    action.type === 'REMOVE_PROVIDER' ||
    action.type === 'SET_ACTIVE_PROVIDER' ||
    action.type === 'SET_ACTIVE_MODEL' ||
    action.type === 'SET_THINKING'
  );
}

function withRecoveryPayload(action: Action, prev: State): Action {
  if (action.type !== 'DELETE_SOURCE' || action.recovery) return action;
  const source = prev.sources.find((item) => item.id === action.sourceId);
  if (!source || source.virtual) return action;
  return {
    ...action,
    recovery: {
      source: {
        ...source,
        boundObjectIds: [...source.boundObjectIds],
      },
      claims: prev.claims
        .filter((claim) => claim.sourceId === action.sourceId)
        .map((claim) => ({ ...claim })),
      deletedAt: new Date().toISOString(),
    },
  };
}

export function tableNames(brain: Brain): string[] {
  const rows = brain.db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%'`,
    )
    .all() as { name: string }[];
  return rows.map((r) => r.name);
}

export function ftsExists(brain: Brain): boolean {
  const row = brain.db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'claims_fts'`)
    .get() as { name: string } | undefined;
  return row?.name === 'claims_fts';
}

export { closedClaims, conflictsOf, isExtracting };
