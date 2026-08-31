import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDeterministicEvalCompletion } from '../../src/main/eval/deterministic';
import { GOLD_PACKS, validateGoldPacks } from '../../src/main/eval/goldPacks';
import { runQualityRegression } from '../../src/main/eval/runner';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('质量回归 runner', () => {
  it('同一条主链跑通获取、抽取、召回与出站并计算全部指标', async () => {
    const report = await runQualityRegression({
      packs: GOLD_PACKS,
      complete: createDeterministicEvalCompletion(GOLD_PACKS),
    });

    expect(report.stages.map((stage) => [stage.name, stage.status])).toEqual([
      ['获取', '通过'],
      ['抽取', '通过'],
      ['召回', '通过'],
      ['出站', '通过'],
    ]);
    expect(report.metrics).toMatchObject({
      extractionRecall: 100,
      spanHit: 100,
      ftsRecallAtK: 100,
      ftsPrecisionAtK: 100,
      mrr: 1,
      briefFaithfulness: 100,
      unknownAdherence: 100,
      conflictDetection: 100,
      correctionRecurrence: 100,
      uncatDiscipline: 100,
      undoCompensation: 100,
      fabrication: 0,
    });
    expect(report.packResults).toHaveLength(GOLD_PACKS.length);
  });

  it('指标低于合格下限时对应阶段失败并在原因里点名差距', async () => {
    const report = await runQualityRegression({
      packs: GOLD_PACKS,
      complete: createDeterministicEvalCompletion(GOLD_PACKS, { mode: 'sabotaged' }),
    });

    const extraction = report.stages.find((stage) => stage.name === '抽取');
    expect(extraction?.status).toBe('失败');
    expect(extraction?.detail).toContain('extractionRecall');
    expect(extraction?.detail).toContain('低于下限');
    const recall = report.stages.find((stage) => stage.name === '召回');
    expect(recall?.status).toBe('失败');
    expect(report.stages.find((stage) => stage.name === '获取')?.status).toBe('通过');

    const sabotagedTech = report.packResults.find((result) => result.packId === 'gold-tech');
    const outboundDetail = sabotagedTech?.stages.find((stage) => stage.name === '出站')?.detail;
    expect(sabotagedTech?.stages.find((stage) => stage.name === '出站')?.status).toBe('失败');
    expect(outboundDetail).toContain('undoCompensation');
    expect(outboundDetail).toContain('低于下限');
  });

  it('健康金标下未编目降级与撤销补偿链路全部合规', async () => {
    const report = await runQualityRegression({
      packs: [GOLD_PACKS[2]!],
      complete: createDeterministicEvalCompletion(GOLD_PACKS),
    });

    expect(report.metrics.uncatDiscipline).toBe(100);
    expect(report.metrics.undoCompensation).toBe(100);
    expect(report.stages.every((stage) => stage.status === '通过')).toBe(true);
  });

  it('阶段失败会定位短原因并把下游标成未运行', async () => {
    const report = await runQualityRegression({
      packs: [GOLD_PACKS[0]!],
      complete: async () => ({ content: 'not-json', toolCalls: [] }),
    });

    expect(report.stages.map((stage) => stage.status)).toEqual([
      '通过',
      '失败',
      '未运行',
      '未运行',
    ]);
    expect(report.stages[1]?.detail).toContain('JSON');
  });

  it('获取失败会停在第一阶段，不把材料不足误算为质量低分', async () => {
    const base = GOLD_PACKS[0]!;
    const report = await runQualityRegression({
      packs: [
        {
          ...base,
          source: { ...base.source, body: `${base.source.body}${'字'.repeat(1_000_000)}` },
        },
      ],
      complete: createDeterministicEvalCompletion(GOLD_PACKS),
    });

    expect(report.stages.map((stage) => stage.status)).toEqual([
      '失败',
      '未运行',
      '未运行',
      '未运行',
    ]);
    expect(report.stages[0]?.detail).toContain('正文超过');
  });

  it('成功和失败都会清理独立临时大脑', async () => {
    const root = mkdtempSync(join(tmpdir(), 'staffdesk-eval-test-root-'));
    roots.push(root);

    await runQualityRegression({
      packs: [GOLD_PACKS[0]!],
      complete: createDeterministicEvalCompletion(GOLD_PACKS),
      tempRoot: root,
    });
    expect(readdirSync(root)).toEqual([]);

    const failed = await runQualityRegression({
      packs: [GOLD_PACKS[0]!],
      complete: async () => {
        throw new Error('sk-secret should be masked');
      },
      tempRoot: root,
    });
    expect(JSON.stringify(failed)).not.toContain('sk-secret');
    expect(JSON.stringify(failed)).toContain('sk-***');
    expect(existsSync(root)).toBe(true);
    expect(readdirSync(root)).toEqual([]);
  });

  it('金标包自检覆盖检索、出处、冲突与纠正，正文不含测试控制指令', () => {
    expect(validateGoldPacks(GOLD_PACKS)).toEqual([]);
    for (const pack of GOLD_PACKS) {
      expect(pack.retrievalCases.length).toBeGreaterThan(0);
      expect(pack.expected.every((item) => item.spanIncludes.length > 0)).toBe(true);
      expect(pack.source.body).not.toMatch(/不要写|必须输出|测试指令/);
    }
    expect(GOLD_PACKS.some((pack) => pack.conflicts.length > 0)).toBe(true);
    expect(GOLD_PACKS.some((pack) => pack.correctionCases.length > 0)).toBe(true);
    expect(GOLD_PACKS.some((pack) => (pack.uncatCases?.length ?? 0) > 0)).toBe(true);
    expect(GOLD_PACKS.some((pack) => (pack.undoCases?.length ?? 0) > 0)).toBe(true);
  });
});
