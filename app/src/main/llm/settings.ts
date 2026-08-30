import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { LlmModel, LlmProvider, ThinkingEffort } from '@shared/types';

export interface ModelSettings {
  version: 1;
  providers: LlmProvider[];
  activeProviderId: string;
  activeModelId: string;
  thinkingEffort: ThinkingEffort;
}

export interface ModelSettingsStore {
  load: () => ModelSettings | null;
  save: (settings: ModelSettings) => void;
}

const LEGACY_PROTOTYPE_PROVIDERS = new Map<
  string,
  { name: string; baseUrl: string; models: readonly string[] }
>([
  [
    'p-deepseek',
    {
      name: 'DeepSeek',
      baseUrl: 'https://api.deepseek.com/v1',
      models: ['deepseek-chat', 'deepseek-reasoner'],
    },
  ],
  ['p-openai', { name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', models: ['gpt-4o'] }],
  [
    'p-anthropic',
    {
      name: 'Anthropic',
      baseUrl: 'https://api.anthropic.com',
      models: ['claude-sonnet-4-5'],
    },
  ],
] as const);

export function emptyModelSettings(): ModelSettings {
  return {
    version: 1,
    providers: [],
    activeProviderId: '',
    activeModelId: '',
    thinkingEffort: '中',
  };
}

export function normalizeModelSettings(input: Partial<ModelSettings>): ModelSettings {
  return normalizeModelSettingsInternal(input, false);
}

/** 仅用于从旧业务库迁移：丢弃当时随原型写入、且从未配置过密钥的默认项。 */
export function normalizeLegacyModelSettings(input: Partial<ModelSettings>): ModelSettings {
  return normalizeModelSettingsInternal(input, true);
}

function normalizeModelSettingsInternal(
  input: Partial<ModelSettings>,
  removePrototypeProviders: boolean,
): ModelSettings {
  const byId = new Map<string, LlmProvider>();
  for (const raw of Array.isArray(input.providers) ? input.providers : []) {
    const provider = normalizeProvider(raw);
    if (!provider || (removePrototypeProviders && isLegacyPrototypeProvider(provider))) continue;
    byId.set(provider.id, provider);
  }
  const providers = [...byId.values()];
  const requested = providers.find((provider) => provider.id === input.activeProviderId);
  const activeProvider =
    (requested?.enabled ? requested : undefined) ?? providers.find((provider) => provider.enabled);
  const requestedModel = activeProvider?.models.find((model) => model.id === input.activeModelId);
  const activeModel = requestedModel ?? activeProvider?.models[0];

  return {
    version: 1,
    providers,
    activeProviderId: activeProvider?.id ?? '',
    activeModelId: activeModel?.id ?? '',
    thinkingEffort: isThinkingEffort(input.thinkingEffort) ? input.thinkingEffort : '中',
  };
}

export function modelSettingsFromState(input: {
  providers: LlmProvider[];
  activeProviderId: string;
  activeModelId: string;
  thinkingEffort: ThinkingEffort;
}): ModelSettings {
  return normalizeModelSettings(input);
}

export function createJsonModelSettingsStore(filePath: string): ModelSettingsStore {
  return {
    load() {
      if (!existsSync(filePath)) return null;
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(filePath, 'utf8'));
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`模型配置文件无法读取：${detail}`);
      }
      return normalizeModelSettings(isRecord(parsed) ? (parsed as Partial<ModelSettings>) : {});
    },
    save(settings) {
      mkdirSync(dirname(filePath), { recursive: true });
      const clean = normalizeModelSettings(settings);
      const temporaryPath = `${filePath}.tmp`;
      writeFileSync(
        temporaryPath,
        `${JSON.stringify(
          {
            ...clean,
            providers: clean.providers.map((provider) => ({ ...provider, apiKey: '' })),
          },
          null,
          2,
        )}\n`,
        { encoding: 'utf8', mode: 0o600 },
      );
      renameSync(temporaryPath, filePath);
    },
  };
}

export function createMemoryModelSettingsStore(
  initial: ModelSettings | null = null,
): ModelSettingsStore {
  let current = initial ? withoutKeys(normalizeModelSettings(initial)) : null;
  return {
    load: () => (current ? structuredClone(current) : null),
    save(settings) {
      current = withoutKeys(normalizeModelSettings(settings));
    },
  };
}

function withoutKeys(settings: ModelSettings): ModelSettings {
  return {
    ...settings,
    providers: settings.providers.map((provider) => ({ ...provider, apiKey: '' })),
  };
}

function normalizeProvider(value: unknown): LlmProvider | null {
  if (!isRecord(value)) return null;
  const id = stringValue(value.id);
  const name = stringValue(value.name);
  const baseUrl = stringValue(value.baseUrl).replace(/\/+$/, '');
  if (!id || !name || !baseUrl) return null;

  const models: LlmModel[] = [];
  const seen = new Set<string>();
  for (const raw of Array.isArray(value.models) ? value.models : []) {
    if (!isRecord(raw)) continue;
    const modelId = stringValue(raw.id);
    if (!modelId || seen.has(modelId)) continue;
    seen.add(modelId);
    models.push({
      id: modelId,
      name: stringValue(raw.name) || modelId,
      contextWindow: positiveNumber(raw.contextWindow, 128000),
      maxOutput: positiveNumber(raw.maxOutput, 8192),
    });
  }
  if (models.length === 0) return null;

  return {
    id,
    name,
    baseUrl,
    apiKey: stringValue(value.apiKey),
    enabled: value.enabled !== false,
    models,
  };
}

function isLegacyPrototypeProvider(provider: LlmProvider): boolean {
  if (provider.apiKey) return false;
  const legacy = LEGACY_PROTOTYPE_PROVIDERS.get(provider.id);
  if (!legacy) return false;
  return (
    provider.name === legacy.name &&
    provider.baseUrl === legacy.baseUrl &&
    provider.models.length === legacy.models.length &&
    provider.models.every((model, index) => model.id === legacy.models[index])
  );
}

function positiveNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function isThinkingEffort(value: unknown): value is ThinkingEffort {
  return value === '关闭' || value === '低' || value === '中' || value === '高';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
