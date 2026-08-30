import { describe, expect, it } from 'vitest';
import { createDeterministicEvalCompletion } from '../../src/main/eval/deterministic';
import { GOLD_PACKS } from '../../src/main/eval/goldPacks';
import { runQualityRegression } from '../../src/main/eval/runner';

describe('工程质量回归', () => {
  it('用确定性 adapter 穿过与设置页相同的 runner、金标和指标', async () => {
    const report = await runQualityRegression({
      packs: GOLD_PACKS,
      complete: createDeterministicEvalCompletion(GOLD_PACKS),
    });
    const summary = {
      suiteVersion: report.suiteVersion,
      stages: report.stages.map((stage) => ({ name: stage.name, status: stage.status })),
      metrics: report.metrics,
    };
    console.log(JSON.stringify(summary, null, 2));
    expect(report.stages.every((stage) => stage.status === '通过')).toBe(true);
    expect(report.metrics).toEqual({
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
    });
  });
});
