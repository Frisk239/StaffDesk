import type { LlmProvider, State } from './types';

export const DEFAULT_PROVIDERS: LlmProvider[] = [
  {
    id: 'p-deepseek',
    kind: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: '',
    protocol: 'chat-completions',
    enabled: true,
    models: [
      { id: 'deepseek-chat', name: 'deepseek-chat', contextWindow: 128000, maxOutput: 8192 },
      { id: 'deepseek-reasoner', name: 'deepseek-reasoner', contextWindow: 128000, maxOutput: 8192 },
    ],
  },
  {
    id: 'p-openai',
    kind: 'openai',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    protocol: 'chat-completions',
    enabled: true,
    models: [{ id: 'gpt-4o', name: 'gpt-4o', contextWindow: 128000, maxOutput: 16384 }],
  },
  {
    id: 'p-anthropic',
    kind: 'anthropic',
    name: 'Anthropic',
    baseUrl: 'https://api.anthropic.com',
    apiKey: '',
    protocol: 'anthropic-messages',
    enabled: true,
    models: [
      { id: 'claude-sonnet-4-5', name: 'claude-sonnet-4-5', contextWindow: 200000, maxOutput: 16384 },
    ],
  },
];

export function emptyUiFields(): Pick<
  State,
  | 'view'
  | 'selectedClaimId'
  | 'sourceFocusId'
  | 'toast'
  | 'briefDraftingFor'
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
> {
  return {
    view: { kind: 'inbox' },
    selectedClaimId: null,
    sourceFocusId: null,
    toast: null,
    briefDraftingFor: null,
    extractJobs: [],
    pendingClaims: [],
    themePreference: 'system',
    providers: DEFAULT_PROVIDERS,
    activeProviderId: 'p-deepseek',
    activeModelId: 'deepseek-chat',
    thinkingEffort: '中',
    writeQueue: [],
    rightTabsByObject: {},
    activeRightTabByObject: {},
    certByProvider: {},
  };
}

export function emptyTaskAudits(): import('./types').TaskAudit[] {
  return [];
}
