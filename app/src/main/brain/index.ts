import type Database from 'better-sqlite3';
import { emptyUiFields } from '@shared/defaults';
import type { LlmProvider, State } from '@shared/types';
import type { Action } from '@shared/actions';
import { applyAction } from './applyAction';
import { openDatabase } from './migrate';
import {
  appendOperation,
  clearLegacyModelMeta,
  listDeletedSourceRecoveries,
  loadLedger,
  persistLedger,
} from './persist';
import { listBriefSpecs, listSlotDefs } from './presets';
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

export type { Action };
export { deriveConflicts, listBriefSpecs, listSlotDefs, projectionClaims, REQUIRED_TABLES };

export class Brain {
  readonly db: Database.Database;
  readonly filePath: string;
  readonly secrets: SecretStore;
  readonly modelSettings: ModelSettingsStore;
  private ui: ReturnType<typeof emptyUiFields>;

  constructor(
    filePath: string,
    secrets: SecretStore = createMemorySecrets(),
    modelSettings: ModelSettingsStore = createMemoryModelSettingsStore(),
  ) {
    this.filePath = filePath;
    this.secrets = secrets;
    this.modelSettings = modelSettings;
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
    return {
      ...this.ui,
      workspaces: ledger.workspaces,
      currentWorkspaceId: ledger.currentWorkspaceId,
      objects: ledger.objects,
      sources,
      deletedSourceRecoveries: listDeletedSourceRecoveries(this.db, ledger.sources),
      claims: ledger.claims,
      slotDefs: ledger.slotDefs,
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
      writeQueue: this.ui.writeQueue,
      rightTabsByObject: this.ui.rightTabsByObject,
      activeRightTabByObject: this.ui.activeRightTabByObject,
      certByProvider: this.ui.certByProvider,
      providers: hydrateProviders(this.ui.providers, '', this.secrets),
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
    persistLedger(this.db, next);
    appendOperation(
      this.db,
      loggedAction.type,
      loggedAction,
      loggedAction.type === 'UNDO_RESULT' ? 'compensating' : null,
    );
    this.ui = {
      view: next.view,
      selectedClaimId: next.selectedClaimId,
      sourceFocusId: next.sourceFocusId,
      toast: next.toast,
      briefDraftingFor: next.briefDraftingFor,
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
      certByProvider: next.certByProvider,
      deletedSourceRecoveries: next.deletedSourceRecoveries,
    };
    return this.snapshot();
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
): Brain {
  return new Brain(filePath, secrets, modelSettings);
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
