import type Database from 'better-sqlite3';
import { emptyUiFields } from '@shared/defaults';
import type { LlmProvider, State } from '@shared/types';
import type { Action } from '@shared/actions';
import { applyAction } from './applyAction';
import { openDatabase } from './migrate';
import { appendOperation, loadLedger, persistLedger } from './persist';
import { listBriefSpecs, listSlotDefs } from './presets';
import { REQUIRED_TABLES } from './schema';
import { closedClaims, conflictsOf, deriveConflicts, isExtracting, projectionClaims } from './projection';
import { createMemorySecrets, type SecretStore } from '../keychain';

export type { Action };
export { deriveConflicts, listBriefSpecs, listSlotDefs, projectionClaims, REQUIRED_TABLES };

export class Brain {
  readonly db: Database.Database;
  readonly filePath: string;
  readonly secrets: SecretStore;
  private ui: ReturnType<typeof emptyUiFields>;

  constructor(filePath: string, secrets: SecretStore = createMemorySecrets()) {
    this.filePath = filePath;
    this.secrets = secrets;
    this.db = openDatabase(filePath);
    this.ui = emptyUiFields();
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
      activeProviderId: ledger.activeProviderId,
      activeModelId: ledger.activeModelId,
      thinkingEffort: ledger.thinkingEffort,
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
      providers: hydrateProviders(this.ui.providers, ledger.providersJson, this.secrets),
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
    const next = applyAction(prev, action);
    persistLedger(this.db, next);
    appendOperation(this.db, action.type, action, action.type === 'UNDO_RESULT' ? 'compensating' : null);
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
    };
    return this.snapshot();
  }

  close(): void {
    this.db.close();
  }
}

export function openBrain(filePath: string, secrets?: SecretStore): Brain {
  return new Brain(filePath, secrets);
}

function hydrateProviders(current: LlmProvider[], json: string, secrets: SecretStore): LlmProvider[] {
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
