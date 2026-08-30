import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createJsonModelSettingsStore,
  normalizeLegacyModelSettings,
  normalizeModelSettings,
} from '../../src/main/llm/settings';
import { openBrain } from '../../src/main/brain';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('全局模型配置', () => {
  it('迁移时移除没有密钥且未经修改的原型供应商', () => {
    const settings = normalizeLegacyModelSettings({
      providers: [
        {
          id: 'p-deepseek',
          name: 'DeepSeek',
          baseUrl: 'https://api.deepseek.com/v1',
          apiKey: '',
          enabled: true,
          models: [
            { id: 'deepseek-chat', name: 'deepseek-chat', contextWindow: 128000, maxOutput: 8192 },
            {
              id: 'deepseek-reasoner',
              name: 'deepseek-reasoner',
              contextWindow: 128000,
              maxOutput: 8192,
            },
          ],
        },
      ],
      activeProviderId: 'p-deepseek',
      activeModelId: 'deepseek-chat',
    });

    expect(settings.providers).toEqual([]);
    expect(settings.activeProviderId).toBe('');
    expect(settings.activeModelId).toBe('');
  });

  it('保留真实自定义端点并修正无效的当前选择', () => {
    const settings = normalizeModelSettings({
      providers: [
        {
          id: 'p-real',
          name: '测试端点',
          baseUrl: 'https://models.example.test/v1/',
          apiKey: 'test-secret',
          enabled: true,
          models: [{ id: 'model-a', name: 'model-a', contextWindow: 1000, maxOutput: 100 }],
        },
      ],
      activeProviderId: 'missing',
      activeModelId: 'missing',
      thinkingEffort: '高',
    });

    expect(settings.providers[0]?.baseUrl).toBe('https://models.example.test/v1');
    expect(settings.activeProviderId).toBe('p-real');
    expect(settings.activeModelId).toBe('model-a');
    expect(settings.thinkingEffort).toBe('高');
  });

  it('用户级设置文件不保存 API Key', () => {
    const dir = mkdtempSync(join(tmpdir(), 'staffdesk-model-settings-'));
    dirs.push(dir);
    const file = join(dir, 'model-settings.json');
    const store = createJsonModelSettingsStore(file);
    store.save(
      normalizeModelSettings({
        providers: [
          {
            id: 'p-real',
            name: '测试端点',
            baseUrl: 'https://models.example.test/v1',
            apiKey: 'test-secret',
            enabled: true,
            models: [{ id: 'model-a', name: 'model-a', contextWindow: 1000, maxOutput: 100 }],
          },
        ],
      }),
    );
    store.save(store.load()!);

    expect(store.load()?.providers[0]?.apiKey).toBe('');
    expect(readFileSync(file, 'utf8')).not.toContain('test-secret');
  });

  it('全部禁用时不保留一个无法调用的当前模型', () => {
    const settings = normalizeModelSettings({
      providers: [
        {
          id: 'p-disabled',
          name: '暂停使用的端点',
          baseUrl: 'https://models.example.test/v1',
          apiKey: '',
          enabled: false,
          models: [{ id: 'model-a', name: 'model-a', contextWindow: 1000, maxOutput: 100 }],
        },
      ],
      activeProviderId: 'p-disabled',
      activeModelId: 'model-a',
    });

    expect(settings.providers).toHaveLength(1);
    expect(settings.activeProviderId).toBe('');
    expect(settings.activeModelId).toBe('');
  });

  it('标准供应商配置的密钥由密钥库托管后，元数据不会被误判成原型项', () => {
    const dir = mkdtempSync(join(tmpdir(), 'staffdesk-model-settings-'));
    dirs.push(dir);
    const file = join(dir, 'model-settings.json');
    const store = createJsonModelSettingsStore(file);
    store.save(
      normalizeModelSettings({
        providers: [
          {
            id: 'p-deepseek',
            name: 'DeepSeek',
            baseUrl: 'https://api.deepseek.com/v1',
            apiKey: 'configured-secret',
            enabled: true,
            models: [
              {
                id: 'deepseek-chat',
                name: 'deepseek-chat',
                contextWindow: 128000,
                maxOutput: 8192,
              },
              {
                id: 'deepseek-reasoner',
                name: 'deepseek-reasoner',
                contextWindow: 128000,
                maxOutput: 8192,
              },
            ],
          },
        ],
      }),
    );

    expect(store.load()?.providers.map((provider) => provider.id)).toEqual(['p-deepseek']);
  });

  it('端点或当前模型变更后认证状态回落', () => {
    const dir = mkdtempSync(join(tmpdir(), 'staffdesk-model-settings-'));
    dirs.push(dir);
    const brain = openBrain(join(dir, 'brain.db'));
    try {
      const provider = {
        id: 'p-real',
        name: '测试端点',
        baseUrl: 'https://models.example.test/v1',
        apiKey: 'test-secret',
        enabled: true,
        models: [
          { id: 'model-a', name: 'model-a', contextWindow: 1000, maxOutput: 100 },
          { id: 'model-b', name: 'model-b', contextWindow: 1000, maxOutput: 100 },
        ],
      };
      brain.dispatch({ type: 'UPSERT_PROVIDER', provider });
      brain.dispatch({ type: 'SET_ACTIVE_PROVIDER', id: provider.id });
      brain.dispatch({ type: 'SET_ACTIVE_MODEL', providerId: provider.id, modelId: 'model-a' });
      brain.dispatch({ type: 'CERT_DONE', id: provider.id });
      expect(brain.snapshot().certByProvider[provider.id]?.status).toBe('已认证');

      brain.dispatch({
        type: 'UPSERT_PROVIDER',
        provider: { ...provider, baseUrl: 'https://models-v2.example.test/v1' },
      });
      expect(brain.snapshot().certByProvider[provider.id]?.status).toBe('未认证');

      brain.dispatch({ type: 'CERT_DONE', id: provider.id });
      brain.dispatch({ type: 'SET_ACTIVE_MODEL', providerId: provider.id, modelId: 'model-b' });
      expect(brain.snapshot().certByProvider[provider.id]?.status).toBe('未认证');
    } finally {
      brain.close();
    }
  });

  it('切换供应商或移除当前供应商触发隐式选模时认证状态回落', () => {
    const dir = mkdtempSync(join(tmpdir(), 'staffdesk-model-settings-'));
    dirs.push(dir);
    const brain = openBrain(join(dir, 'brain.db'));
    try {
      const providerA = {
        id: 'p-a',
        name: '端点 A',
        baseUrl: 'https://a.example.test/v1',
        apiKey: 'secret-a',
        enabled: true,
        models: [{ id: 'model-a', name: 'model-a', contextWindow: 1000, maxOutput: 100 }],
      };
      const providerB = {
        id: 'p-b',
        name: '端点 B',
        baseUrl: 'https://b.example.test/v1',
        apiKey: 'secret-b',
        enabled: true,
        models: [
          { id: 'model-b1', name: 'model-b1', contextWindow: 1000, maxOutput: 100 },
          { id: 'model-b2', name: 'model-b2', contextWindow: 1000, maxOutput: 100 },
        ],
      };
      brain.dispatch({ type: 'UPSERT_PROVIDER', provider: providerA });
      brain.dispatch({ type: 'UPSERT_PROVIDER', provider: providerB });
      brain.dispatch({ type: 'SET_ACTIVE_MODEL', providerId: providerB.id, modelId: 'model-b2' });
      brain.dispatch({ type: 'CERT_DONE', id: providerB.id });
      brain.dispatch({ type: 'SET_ACTIVE_PROVIDER', id: providerA.id });
      brain.dispatch({ type: 'SET_ACTIVE_PROVIDER', id: providerB.id });
      expect(brain.snapshot().activeModelId).toBe('model-b1');
      expect(brain.snapshot().certByProvider[providerB.id]?.status).toBe('未认证');

      brain.dispatch({ type: 'CERT_DONE', id: providerB.id });
      brain.dispatch({ type: 'SET_ACTIVE_PROVIDER', id: providerA.id });
      brain.dispatch({ type: 'CERT_DONE', id: providerB.id });
      brain.dispatch({ type: 'REMOVE_PROVIDER', id: providerA.id });
      expect(brain.snapshot().activeProviderId).toBe(providerB.id);
      expect(brain.snapshot().certByProvider[providerB.id]?.status).toBe('未认证');
    } finally {
      brain.close();
    }
  });
});
