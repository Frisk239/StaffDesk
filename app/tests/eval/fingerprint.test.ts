import { describe, expect, it } from 'vitest';
import {
  buildQualificationTarget,
  qualificationFingerprint,
  QUALITY_METRIC_FLOORS,
  QUALITY_POLICY_VERSIONS,
  STAGE_FLOORED_METRICS,
} from '../../src/main/eval/fingerprint';
import type { LlmProvider, QualityMetricSet } from '../../src/shared/types';

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

  it('出站政策版本已升至含禁写双路的 v3', () => {
    expect(QUALITY_POLICY_VERSIONS.outbound).toBe('ledger-outbound-v3');
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

  it('各 stage 闸门指标并集恰等于合格线全集：无重复无遗漏', () => {
    // 0045：新指标若没挂进任何 stage 的闸门就永远不会被分数线拦住——这条钉住并集恒等。
    const gated = Object.values(STAGE_FLOORED_METRICS).flat();
    expect(new Set(gated).size).toBe(gated.length);
    expect([...gated].sort()).toEqual(Object.keys(QUALITY_METRIC_FLOORS).sort());
  });

  it('G9 守护：门槛与政策面绑定——反向全覆盖、门槛全为正、fabrication 上限语义不丢', () => {
    // 评测集「改后必须复跑」靠指纹机制自觉执行；这里把政策面（0045）钉成不变量，
    // 门槛或闸门被删被挂错，评测资格认证就静默放水——先让测试红。
    const floors = Object.entries(QUALITY_METRIC_FLOORS) as [keyof QualityMetricSet, number][];
    expect(floors.length).toBeGreaterThan(0);
    for (const [key, floor] of floors) {
      // fabrication 的 floor 是上限、其余是下限，方向不同但都不许 0/负值静默放水。
      expect(Number.isFinite(floor), `门槛 ${key} 必须是有限数`).toBe(true);
      expect(floor, `门槛 ${key} 必须为正`).toBeGreaterThan(0);
    }
    // 反向全覆盖（并集断言的加强版）：任一门槛键必须挂进至少一个 stage 的闸门集合。
    const stageSets = Object.values(STAGE_FLOORED_METRICS);
    for (const [key] of floors) {
      expect(
        stageSets.some((set) => set.includes(key)),
        `门槛 ${key} 没挂进任何 stage 闸门，永远不会被分数线拦住`,
      ).toBe(true);
    }
    // fabrication 的上限语义绑定在闸门上（runner settle 特判该键）：键名不得改名移位出闸门。
    expect(stageSets.some((set) => set.includes('fabrication'))).toBe(true);
    // 政策版本与门槛存在性绑定：三路版本非空——版本空串会让指纹对政策演进失明。
    for (const [name, version] of Object.entries(QUALITY_POLICY_VERSIONS)) {
      expect(version.length, `政策版本 ${name} 不能为空`).toBeGreaterThan(0);
    }
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
