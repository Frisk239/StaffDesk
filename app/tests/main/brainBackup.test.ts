import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openBrain, type Brain } from '../../src/main/brain';
import {
  createBrainBackupArchive,
  readBrainBackupArchive,
  replaceBrainDatabaseFile,
  writeBrainBackupFile,
} from '../../src/main/brainBackup';
import { createMemorySecrets } from '../../src/main/keychain';
import { createMemoryModelSettingsStore } from '../../src/main/llm/settings';

const dirs: string[] = [];
const brains: Brain[] = [];

function tmpBrainPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'staffdesk-brain-backup-test-'));
  dirs.push(dir);
  return join(dir, 'brain.db');
}

function track(brain: Brain): Brain {
  brains.push(brain);
  return brain;
}

afterEach(() => {
  while (brains.length) {
    try {
      brains.pop()?.close();
    } catch {
      /* already closed */
    }
  }
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('大脑备份与恢复', () => {
  it('备份包只带大脑文件和清单，不带密钥或全局模型配置', async () => {
    const secrets = createMemorySecrets();
    const modelSettings = createMemoryModelSettingsStore();
    const brain = track(openBrain(tmpBrainPath(), secrets, modelSettings));
    brain.dispatch({
      type: 'UPSERT_PROVIDER',
      provider: {
        id: 'p-source',
        name: '真实测试端点',
        baseUrl: 'https://models.example.test/v1',
        apiKey: 'sk-should-not-leak',
        enabled: true,
        models: [{ id: 'test-model', name: 'test-model', contextWindow: 1, maxOutput: 1 }],
      },
    });

    const archive = await createBrainBackupArchive(brain, {
      createdAt: '2026-08-30T00:00:00.000Z',
    });
    const restored = readBrainBackupArchive(archive.buffer);

    expect(archive.buffer.subarray(0, 2).toString()).toBe('PK');
    expect(restored.manifest.excludes).toContain('apiKeys');
    expect(restored.manifest.excludes).toContain('modelSettings');
    expect(restored.database.toString('utf8')).not.toContain('sk-should-not-leak');
    expect(restored.database.toString('utf8')).not.toContain('https://models.example.test/v1');
    expect(brain.snapshot().providers.find((provider) => provider.id === 'p-source')?.apiKey).toBe(
      'sk-should-not-leak',
    );
  });

  it('恢复替换账本内容，但沿用当前机器的模型端点与 Key', async () => {
    const source = track(
      openBrain(tmpBrainPath(), createMemorySecrets(), createMemoryModelSettingsStore()),
    );
    source.dispatch({ type: 'ADD_WORKSPACE', name: '源区', scenario: '求职面试' });
    source.dispatch({ type: 'ADD_OBJECT', kind: '组织', name: '备份里的组织' });
    source.dispatch({
      type: 'UPSERT_PROVIDER',
      provider: {
        id: 'p-source',
        name: '源机器端点',
        baseUrl: 'https://source.example.test/v1',
        apiKey: 'sk-source-key',
        enabled: true,
        models: [{ id: 'source-model', name: 'source-model', contextWindow: 1, maxOutput: 1 }],
      },
    });
    const sourceArchive = await createBrainBackupArchive(source);
    const sourceZipPath = join(dirname(source.filePath), 'source-backup.zip');
    writeBrainBackupFile(sourceZipPath, sourceArchive);

    const targetSecrets = createMemorySecrets();
    const targetModelSettings = createMemoryModelSettingsStore();
    let target = track(openBrain(tmpBrainPath(), targetSecrets, targetModelSettings));
    target.dispatch({ type: 'ADD_WORKSPACE', name: '目标区', scenario: '求职面试' });
    target.dispatch({ type: 'ADD_OBJECT', kind: '组织', name: '恢复前的组织' });
    target.dispatch({
      type: 'UPSERT_PROVIDER',
      provider: {
        id: 'p-target',
        name: '当前机器端点',
        baseUrl: 'https://target.example.test/v1',
        apiKey: 'sk-target-key',
        enabled: true,
        models: [{ id: 'target-model', name: 'target-model', contextWindow: 1, maxOutput: 1 }],
      },
    });
    const safetyArchive = await createBrainBackupArchive(target);
    const safetyZipPath = join(dirname(target.filePath), 'before-restore.zip');
    writeBrainBackupFile(safetyZipPath, safetyArchive);
    const targetPath = target.filePath;
    target.close();

    const incoming = readBrainBackupArchive(readFileSync(sourceZipPath));
    replaceBrainDatabaseFile(targetPath, incoming.database);
    target = track(openBrain(targetPath, targetSecrets, targetModelSettings));
    const restored = target.snapshot();

    expect(restored.objects.map((object) => object.name)).toContain('备份里的组织');
    expect(restored.objects.map((object) => object.name)).not.toContain('恢复前的组织');
    expect(restored.providers).toHaveLength(1);
    expect(restored.providers[0]).toMatchObject({
      id: 'p-target',
      name: '当前机器端点',
      baseUrl: 'https://target.example.test/v1',
      apiKey: 'sk-target-key',
    });
    expect(readBrainBackupArchive(readFileSync(safetyZipPath)).database.toString('utf8')).toContain(
      '恢复前的组织',
    );
  });

  it('替换大脑文件时清理旧 WAL/SHM sidecar', async () => {
    const source = track(openBrain(tmpBrainPath()));
    source.dispatch({ type: 'ADD_WORKSPACE', name: '源区', scenario: '求职面试' });
    source.dispatch({ type: 'ADD_OBJECT', kind: '组织', name: '备份对象' });
    const archive = await createBrainBackupArchive(source);

    const target = track(openBrain(tmpBrainPath()));
    const targetPath = target.filePath;
    target.close();
    writeFileSync(`${targetPath}-wal`, 'stale wal');
    writeFileSync(`${targetPath}-shm`, 'stale shm');

    replaceBrainDatabaseFile(targetPath, readBrainBackupArchive(archive.buffer).database);

    expect(existsSync(`${targetPath}-wal`)).toBe(false);
    expect(existsSync(`${targetPath}-shm`)).toBe(false);
  });

  it('拒绝损坏备份，且不会改写当前大脑文件', () => {
    const target = track(openBrain(tmpBrainPath()));
    target.dispatch({ type: 'ADD_WORKSPACE', name: '目标区', scenario: '求职面试' });
    target.dispatch({ type: 'ADD_OBJECT', kind: '组织', name: '仍应存在' });
    const targetPath = target.filePath;
    target.close();
    const before = readFileSync(targetPath);

    expect(() => readBrainBackupArchive(Buffer.from('not a staffdesk zip'))).toThrow(/zip/);
    expect(readFileSync(targetPath).equals(before)).toBe(true);

    const reopened = track(openBrain(targetPath));
    expect(reopened.snapshot().objects.map((object) => object.name)).toContain('仍应存在');
  });
});
