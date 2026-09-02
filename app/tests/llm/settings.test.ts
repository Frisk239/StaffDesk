import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createJsonModelSettingsStore,
  normalizeLegacyModelSettings,
  normalizeModelSettings,
} from '../../src/main/llm/settings';

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

  it('损坏的配置文件回落默认而不是抛错——完好的 brain 不会被误旁置（评审 M33）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'staffdesk-model-settings-'));
    dirs.push(dir);
    const file = join(dir, 'model-settings.json');
    writeFileSync(file, '{ 不是 JSON', 'utf8');
    const store = createJsonModelSettingsStore(file);
    // F2：openBrain 的 hydrate 会调 load()——这里返回 null（回落默认）而不是抛错，
    // 启动 catch 才不会把 brain.db 当损坏旁置（0048：模型配置不属大脑数据）。
    expect(store.load()).toBeNull();
  });
});
