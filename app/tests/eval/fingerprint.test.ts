import { describe, expect, it } from 'vitest';
import {
  buildQualificationTarget,
  qualificationFingerprint,
  QUALITY_METRIC_FLOORS,
  QUALITY_POLICY_VERSIONS,
} from '../../src/main/eval/fingerprint';
import type { LlmProvider } from '../../src/shared/types';

function provider(overrides: Partial<LlmProvider> = {}): LlmProvider {
  return {
    id: 'provider-a',
    name: '端点 A',
    baseUrl: 'HTTPS://Models.Example.Test:443/v1/',
    apiKey: 'sk-first-secret',
    enabled: true,
    models: [{ id: 'model-a', name: '模型 A', contextWindow: 128000, maxOutput: 8192 }],
    ...overrides,
  };
}

describe('资格认证配置指纹', () => {
  it('规范化同一端点并排除密钥、供应商 ID 与显示名称', () => {
    const left = buildQualificationTarget(provider(), 'model-a', '中');
    const right = buildQualificationTarget(
      provider({
        id: 'provider-renamed',
        name: '改过名字',
        baseUrl: 'https://models.example.test/v1',
        apiKey: 'sk-second-secret',
      }),
      'model-a',
      '中',
    );

    expect(qualificationFingerprint(left)).toBe(qualificationFingerprint(right));
    expect(JSON.stringify(left)).not.toContain('secret');
    expect(JSON.stringify(left)).not.toContain('provider-a');
  });

  it('模型、思考强度、有效模型参数或策略版本变化都会失效', () => {
    const base = buildQualificationTarget(provider(), 'model-a', '中');
    const changedModel = { ...base, modelId: 'model-b' };
    const changedThinking = { ...base, thinkingEffort: '高' as const };
    const changedParams = { ...base, modelParams: { ...base.modelParams, maxOutput: 4096 } };
    const changedPolicy = {
      ...base,
      policyVersions: { ...base.policyVersions, recall: 'recall-v-next' },
    };

    const fingerprints = [base, changedModel, changedThinking, changedParams, changedPolicy].map(
      qualificationFingerprint,
    );
    expect(new Set(fingerprints).size).toBe(fingerprints.length);
  });

  it('出站政策版本已升至含未编目纪律与撤销补偿的 v2', () => {
    expect(QUALITY_POLICY_VERSIONS.outbound).toBe('ledger-outbound-v2');
  });

  it('每个指标都有合格下限，编造率的下限语义是上限', () => {
    const keys = Object.keys(QUALITY_METRIC_FLOORS);
    expect(keys).toHaveLength(12);
    expect(QUALITY_METRIC_FLOORS.extractionRecall).toBe(70);
    expect(QUALITY_METRIC_FLOORS.mrr).toBe(0.5);
    expect(QUALITY_METRIC_FLOORS.uncatDiscipline).toBe(90);
    expect(QUALITY_METRIC_FLOORS.undoCompensation).toBe(90);
    expect(QUALITY_METRIC_FLOORS.fabrication).toBe(10);
  });

  it('模型行显式指定 modelId，不回退到 active 或首个模型', () => {
    const configured = provider({
      models: [
        { id: 'model-a', name: '模型 A', contextWindow: 1000, maxOutput: 100 },
        { id: 'model-b', name: '模型 B', contextWindow: 2000, maxOutput: 200 },
      ],
    });
    const target = buildQualificationTarget(configured, 'model-b', '低');

    expect(target.modelId).toBe('model-b');
    expect(target.modelParams).toEqual({ contextWindow: 2000, maxOutput: 200 });
  });
});
