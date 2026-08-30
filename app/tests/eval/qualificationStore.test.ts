import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createJsonQualificationStore } from '../../src/main/eval/qualificationStore';
import { createMemoryQualificationStore } from '../../src/main/eval/qualificationStore';
import { openBrain } from '../../src/main/brain';
import { createMemoryModelSettingsStore } from '../../src/main/llm/settings';
import {
  buildQualificationTarget,
  qualificationFingerprint,
} from '../../src/main/eval/fingerprint';
import type { LlmProvider } from '../../src/shared/types';
import type { QualityQualificationRecord } from '../../src/shared/types';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function record(): QualityQualificationRecord {
  return {
    fingerprint: 'fingerprint-a',
    endpointIdentity: 'models.example.test/v1',
    modelId: 'model-a',
    suiteVersion: 'suite-v1',
    completedAt: '2026-08-30T00:00:00.000Z',
    connect: { status: '通过', detail: '端点可达' },
    capability: { status: '通过', detail: '结构化输出可用' },
    report: {
      suiteVersion: 'suite-v1',
      startedAt: '2026-08-30T00:00:00.000Z',
      completedAt: '2026-08-30T00:00:01.000Z',
      stages: [
        { name: '获取', status: '通过', durationMs: 1 },
        { name: '抽取', status: '通过', durationMs: 1 },
        { name: '召回', status: '通过', durationMs: 1 },
        { name: '出站', status: '通过', durationMs: 1 },
      ],
      metrics: {
        extractionRecall: 100,
        spanHit: 100,
        ftsRecallAtK: 100,
        ftsPrecisionAtK: 100,
        mrr: 1,
        briefFaithfulness: 100,
        unknownAdherence: 100,
        conflictDetection: 100,
        correctionRecurrence: 100,
        fabrication: 0,
      },
      packResults: [],
    },
  };
}

describe('产品全局资格记录', () => {
  it('重启后仍能读取同一指纹，且文件不含密钥或金标正文', () => {
    const dir = mkdtempSync(join(tmpdir(), 'staffdesk-qualification-'));
    dirs.push(dir);
    const file = join(dir, 'qualification.json');
    createJsonQualificationStore(file).save(record());

    expect(createJsonQualificationStore(file).find('fingerprint-a')).toEqual(record());
    const persisted = readFileSync(file, 'utf8');
    expect(persisted).not.toContain('sk-');
    expect(persisted).not.toContain('青浦书院');
  });

  it('旧指纹历史保留，但不能认证新配置', () => {
    const dir = mkdtempSync(join(tmpdir(), 'staffdesk-qualification-'));
    dirs.push(dir);
    const store = createJsonQualificationStore(join(dir, 'qualification.json'));
    store.save(record());

    expect(store.find('fingerprint-a')?.modelId).toBe('model-a');
    expect(store.find('fingerprint-b')).toBeNull();
  });

  it('重启并切换大脑仍投影同一全局资格；思考强度变化立即未认证', () => {
    const dir = mkdtempSync(join(tmpdir(), 'staffdesk-qualification-brains-'));
    dirs.push(dir);
    const provider: LlmProvider = {
      id: 'provider-local',
      name: '本机端点',
      baseUrl: 'https://models.example.test/v1',
      apiKey: '',
      enabled: true,
      models: [{ id: 'model-a', name: '模型 A', contextWindow: 128000, maxOutput: 8192 }],
    };
    const settings = createMemoryModelSettingsStore({
      version: 1,
      providers: [provider],
      activeProviderId: provider.id,
      activeModelId: 'model-a',
      thinkingEffort: '中',
    });
    const target = buildQualificationTarget(provider, 'model-a', '中');
    const baseRecord = record();
    const stored = {
      ...baseRecord,
      fingerprint: qualificationFingerprint(target),
      suiteVersion: target.suiteVersion,
      report: { ...baseRecord.report!, suiteVersion: target.suiteVersion },
    };
    const qualifications = createMemoryQualificationStore([stored]);

    const first = openBrain(join(dir, 'first.db'), undefined, settings, qualifications);
    expect(first.snapshot().qualification.status).toBe('已认证');
    first.close();

    const second = openBrain(join(dir, 'second.db'), undefined, settings, qualifications);
    expect(second.snapshot().qualification.status).toBe('已认证');
    second.dispatch({ type: 'SET_THINKING', effort: '高' });
    expect(second.snapshot().qualification.status).toBe('未认证');
    expect(qualifications.find(stored.fingerprint)).not.toBeNull();
    second.close();
  });
});
