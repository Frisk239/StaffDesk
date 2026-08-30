import type { State } from './types';

export function emptyUiFields(): Pick<
  State,
  | 'view'
  | 'selectedClaimId'
  | 'sourceFocusId'
  | 'toast'
  | 'briefDraftingFor'
  | 'ingestJobs'
  | 'extractJobs'
  | 'pendingClaims'
  | 'themePreference'
  | 'providers'
  | 'activeProviderId'
  | 'activeModelId'
  | 'thinkingEffort'
  | 'writeQueue'
  | 'rightTabsByObject'
  | 'activeRightTabByObject'
  | 'certByProvider'
  | 'deletedSourceRecoveries'
> {
  return {
    view: { kind: 'inbox' },
    selectedClaimId: null,
    sourceFocusId: null,
    toast: null,
    briefDraftingFor: null,
    ingestJobs: [],
    extractJobs: [],
    pendingClaims: [],
    themePreference: 'system',
    providers: [],
    activeProviderId: '',
    activeModelId: '',
    thinkingEffort: '中',
    writeQueue: [],
    rightTabsByObject: {},
    activeRightTabByObject: {},
    certByProvider: {},
    deletedSourceRecoveries: [],
  };
}

export function emptyTaskAudits(): import('./types').TaskAudit[] {
  return [];
}
