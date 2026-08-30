import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deriveConflicts, openBrain, type Brain } from '../brain';
import { outboundBrief } from '../brain/briefOut';
import { resolveFtsHits, searchClaimsFts } from '../brain/fts';
import { parseIngestInput } from '../ingestion';
import type { ModelCompletion } from '../llm/runtime';
import { runExtractLoop } from '../loops/extract';
import type {
  Brief,
  Claim,
  QualityMetricSet,
  QualityPackResult,
  QualityRegressionReport,
  QualityStageName,
  QualityStageResult,
} from '@shared/types';
import { QUALITY_SUITE_VERSION } from './fingerprint';
import type { GoldPack } from './goldPacks';
import { validateGoldPacks } from './goldPacks';

const STAGES: QualityStageName[] = ['获取', '抽取', '召回', '出站'];

export interface QualityRegressionOptions {
  packs: readonly GoldPack[];
  complete: ModelCompletion;
  tempRoot?: string | undefined;
  now?: (() => Date) | undefined;
}

/** 四段回归的唯一 interface。调用方只替换 completion adapter。 */
export async function runQualityRegression(
  options: QualityRegressionOptions,
): Promise<QualityRegressionReport> {
  const errors = validateGoldPacks(options.packs);
  if (errors.length > 0) throw new Error(`金标包无效：${errors.join('；')}`);
  const now = options.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const packResults: QualityPackResult[] = [];
  for (const pack of options.packs) {
    packResults.push(await runPack(pack, options.complete, options.tempRoot));
  }
  return {
    suiteVersion: QUALITY_SUITE_VERSION,
    startedAt,
    completedAt: now().toISOString(),
    stages: aggregateStages(packResults),
    metrics: averageMetrics(packResults.map((result) => result.metrics)),
    packResults,
  };
}

async function runPack(
  pack: GoldPack,
  complete: ModelCompletion,
  tempRoot: string | undefined,
): Promise<QualityPackResult> {
  const dir = mkdtempSync(join(tempRoot ?? tmpdir(), 'staffdesk-eval-'));
  let brain: Brain | undefined;
  const stages = unrunStages();
  const metrics = emptyMetrics();
  try {
    brain = openBrain(join(dir, 'brain.db'));
    const acquisitionStarted = Date.now();
    let material: Awaited<ReturnType<typeof parseIngestInput>>;
    try {
      material = await parseIngestInput(
        { kind: 'text', text: pack.source.body, suggestedTitle: pack.source.title },
        { now: () => new Date('2026-08-30T00:00:00.000Z') },
      );
      seedMaterial(brain, pack, material);
      pass(stages, '获取', acquisitionStarted);
    } catch (error) {
      fail(stages, '获取', acquisitionStarted, error);
      return { packId: pack.id, stages, metrics };
    }

    const state = brain.snapshot();
    const object = state.objects[0];
    const source = state.sources.find((item) => !item.virtual);
    if (!object || !source) {
      fail(stages, '获取', acquisitionStarted, new Error('隔离材料没有落入大脑'));
      return { packId: pack.id, stages, metrics };
    }

    const extractionStarted = Date.now();
    const extraction = await runExtractLoop({
      source,
      objects: [object],
      slotDefs: state.slotDefs,
      existing: [],
      complete,
    });
    if (extraction.status !== 'success') {
      fail(
        stages,
        '抽取',
        extractionStarted,
        new Error(extraction.detail ?? `抽取未完成：${extraction.status}`),
      );
      return { packId: pack.id, stages, metrics };
    }
    brain.dispatch({
      type: 'EXTRACT_DONE',
      sourceId: source.id,
      claims: extraction.claims,
      outcome: 'success',
      draftCount: extraction.draftCount,
      rejectedCount: extraction.rejectedCount,
    });
    const extracted = brain.snapshot().claims.filter((claim) => claim.sourceId === source.id);
    metrics.extractionRecall = extractionRecall(pack, extracted);
    metrics.spanHit = spanHit(pack, extracted, source.body);
    metrics.fabrication = fabrication(pack, extracted);
    pass(stages, '抽取', extractionStarted);

    const recallStarted = Date.now();
    try {
      const recall = scoreRecall(brain, object.id, pack);
      metrics.ftsRecallAtK = recall.recall;
      metrics.ftsPrecisionAtK = recall.precision;
      metrics.mrr = recall.mrr;
      pass(stages, '召回', recallStarted);
    } catch (error) {
      fail(stages, '召回', recallStarted, error);
      return { packId: pack.id, stages, metrics };
    }

    const outboundStarted = Date.now();
    try {
      const beforeCorrection = brain.snapshot();
      const brief = outboundBrief(
        beforeCorrection,
        object.id,
        `brief-${pack.id}`,
        `task-${pack.id}`,
      );
      metrics.briefFaithfulness = briefFaithfulness(brief, beforeCorrection.claims);
      metrics.unknownAdherence = unknownAdherence(pack, beforeCorrection.claims, brief);
      metrics.conflictDetection = conflictDetection(
        pack,
        beforeCorrection.claims,
        beforeCorrection.slotDefs,
      );
      metrics.correctionRecurrence = correctionRecurrence(pack, brain, object.id);
      pass(stages, '出站', outboundStarted);
    } catch (error) {
      fail(stages, '出站', outboundStarted, error);
    }
    return { packId: pack.id, stages, metrics };
  } finally {
    brain?.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function seedMaterial(
  brain: Brain,
  pack: GoldPack,
  material: Awaited<ReturnType<typeof parseIngestInput>>,
): void {
  const stamp = '2026-08-30T00:00:00.000Z';
  brain.dispatch({ type: 'ADD_WORKSPACE', name: '隔离评测', scenario: pack.scenario });
  brain.dispatch({ type: 'ADD_OBJECT', kind: pack.object.kind, name: pack.object.name });
  brain.dispatch({
    type: 'INGEST_STARTED',
    job: {
      id: `ing-${pack.id}`,
      inputKind: 'text',
      status: '解析中',
      attempt: 1,
      createdAt: stamp,
      updatedAt: stamp,
    },
  });
  brain.dispatch({
    type: 'INGEST_SUCCEEDED',
    jobId: `ing-${pack.id}`,
    title: material.title,
    body: material.body,
    origin: material.origin,
    segments: material.segments,
    contentHash: material.contentHash,
  });
  const state = brain.snapshot();
  const object = state.objects[0];
  const source = state.sources.find((item) => !item.virtual);
  if (!object || !source) throw new Error('隔离材料无法绑定');
  brain.dispatch({ type: 'BIND_CONFIRMED', sourceId: source.id, objectIds: [object.id] });
}

function scoreRecall(
  brain: Brain,
  objectId: string,
  pack: GoldPack,
): { recall: number; precision: number; mrr: number } {
  const claims = brain.snapshot().claims;
  const recalls: number[] = [];
  const precisions: number[] = [];
  const reciprocalRanks: number[] = [];
  for (const test of pack.retrievalCases) {
    const hits = searchClaimsFts(brain.db, objectId, test.query, test.k);
    const resolved = resolveFtsHits(claims, hits).slice(0, test.k);
    const relevant = resolved.filter((claim) =>
      test.expectedRanking.some((needle) => claim.text.includes(needle)),
    );
    recalls.push(percent(relevant.length, test.expectedRanking.length));
    precisions.push(percent(relevant.length, Math.max(Math.min(test.k, resolved.length), 1)));
    const firstRank = resolved.findIndex((claim) =>
      test.expectedRanking.some((needle) => claim.text.includes(needle)),
    );
    reciprocalRanks.push(firstRank >= 0 ? 1 / (firstRank + 1) : 0);
  }
  return {
    recall: average(recalls, 100),
    precision: average(precisions, 100),
    mrr: round(average(reciprocalRanks, 1), 3),
  };
}

function extractionRecall(pack: GoldPack, claims: Claim[]): number {
  const hits = pack.expected.filter((expected) =>
    claims.some(
      (claim) =>
        claim.predicate === expected.predicate && claim.text.includes(expected.textIncludes),
    ),
  ).length;
  return percent(hits, pack.expected.length);
}

function spanHit(pack: GoldPack, claims: Claim[], body: string): number {
  const hits = pack.expected.filter((expected) =>
    claims.some((claim) => {
      if (!claim.text.includes(expected.textIncludes)) return false;
      if (typeof claim.sourceStart !== 'number' || typeof claim.sourceEnd !== 'number')
        return false;
      return body.slice(claim.sourceStart, claim.sourceEnd).includes(expected.spanIncludes);
    }),
  ).length;
  return percent(hits, pack.expected.length);
}

function fabrication(pack: GoldPack, claims: Claim[]): number {
  const fabricated = claims.filter((claim) =>
    pack.negatives.some((negative) => claim.text.includes(negative)),
  ).length;
  return percent(fabricated, Math.max(claims.length, 1));
}

function briefFaithfulness(brief: Brief, claims: Claim[]): number {
  const live = new Set(claims.filter((claim) => claim.status === '成立').map((claim) => claim.id));
  const outbound = brief.blocks
    .flatMap((block) => block.sentences)
    .filter((sentence) => sentence.kind !== 'unknown');
  const faithful = outbound.filter(
    (sentence) => sentence.claimIds.length > 0 && sentence.claimIds.every((id) => live.has(id)),
  ).length;
  return percent(faithful, Math.max(outbound.length, 1));
}

function unknownAdherence(pack: GoldPack, claims: Claim[], brief: Brief): number {
  if (pack.unknownSlots.length === 0) return 100;
  const live = claims.filter((claim) => claim.status === '成立');
  const sentences = brief.blocks.flatMap((block) => block.sentences);
  const obeyed = pack.unknownSlots.filter(
    (slot) =>
      !live.some((claim) => claim.predicate === slot) &&
      sentences.some((sentence) => sentence.kind === 'unknown'),
  ).length;
  return percent(obeyed, pack.unknownSlots.length);
}

function conflictDetection(
  pack: GoldPack,
  claims: Claim[],
  slotDefs: Parameters<typeof deriveConflicts>[1],
): number {
  if (pack.conflicts.length === 0) return 100;
  const conflicts = deriveConflicts(claims, slotDefs);
  const detected = pack.conflicts.filter((expected) => {
    const left = claims.find(
      (claim) =>
        claim.predicate === expected.predicate && claim.text.includes(expected.textIncludes[0]),
    );
    const right = claims.find(
      (claim) =>
        claim.predicate === expected.predicate && claim.text.includes(expected.textIncludes[1]),
    );
    return Boolean(
      left &&
      right &&
      conflicts.some(
        (conflict) =>
          (conflict.claimIdA === left.id && conflict.claimIdB === right.id) ||
          (conflict.claimIdA === right.id && conflict.claimIdB === left.id),
      ),
    );
  }).length;
  return percent(detected, pack.conflicts.length);
}

function correctionRecurrence(pack: GoldPack, brain: Brain, objectId: string): number {
  if (pack.correctionCases.length === 0) return 100;
  let obeyed = 0;
  for (const correction of pack.correctionCases) {
    const claim = brain
      .snapshot()
      .claims.find(
        (candidate) =>
          candidate.status === '成立' && candidate.text.includes(correction.claimTextIncludes),
      );
    if (!claim) continue;
    brain.dispatch({ type: 'PROMOTE_CLAIM', claimId: claim.id });
    brain.dispatch({
      type: 'CORRECT_CLAIM',
      claimId: claim.id,
      closeReason: '从未成立',
      newText: correction.replacementText,
    });
    const after = brain.snapshot();
    const brief = outboundBrief(
      after,
      objectId,
      `brief-correct-${pack.id}`,
      `task-correct-${pack.id}`,
    );
    const text = brief.blocks
      .flatMap((block) => block.sentences)
      .map((sentence) => sentence.text)
      .join('\n');
    const oldIsLive = after.claims.some(
      (candidate) => candidate.id === claim.id && candidate.status === '成立',
    );
    const hasBan = after.memories.some(
      (memory) => memory.kind === '禁写' && memory.text.includes(claim.text.replace(/。$/, '')),
    );
    if (!oldIsLive && hasBan && !text.includes(claim.text.replace(/。$/, ''))) obeyed += 1;
  }
  return percent(obeyed, pack.correctionCases.length);
}

function unrunStages(): QualityStageResult[] {
  return STAGES.map((name) => ({ name, status: '未运行', durationMs: 0 }));
}

function pass(stages: QualityStageResult[], name: QualityStageName, started: number): void {
  replaceStage(stages, { name, status: '通过', durationMs: Math.max(Date.now() - started, 0) });
}

function fail(
  stages: QualityStageResult[],
  name: QualityStageName,
  started: number,
  error: unknown,
): void {
  replaceStage(stages, {
    name,
    status: '失败',
    durationMs: Math.max(Date.now() - started, 0),
    detail: safeDetail(error),
  });
}

function replaceStage(stages: QualityStageResult[], next: QualityStageResult): void {
  const index = stages.findIndex((stage) => stage.name === next.name);
  if (index >= 0) stages[index] = next;
}

function aggregateStages(results: QualityPackResult[]): QualityStageResult[] {
  return STAGES.map((name) => {
    const listed = results.map((result) => result.stages.find((stage) => stage.name === name)!);
    const failed = listed.filter((stage) => stage.status === '失败');
    const unrun = listed.filter((stage) => stage.status === '未运行');
    const status =
      failed.length > 0
        ? '失败'
        : unrun.length === listed.length
          ? '未运行'
          : unrun.length > 0
            ? '失败'
            : '通过';
    return {
      name,
      status,
      durationMs: listed.reduce((sum, stage) => sum + stage.durationMs, 0),
      ...(failed[0]?.detail
        ? {
            detail: `${results.find((result) => result.stages.includes(failed[0]!))?.packId ?? '金标'}：${failed[0].detail}`,
          }
        : unrun.length > 0 && status === '失败'
          ? { detail: `${unrun.length} 个金标包未运行此阶段` }
          : {}),
    };
  });
}

function emptyMetrics(): QualityMetricSet {
  return {
    extractionRecall: 0,
    spanHit: 0,
    ftsRecallAtK: 0,
    ftsPrecisionAtK: 0,
    mrr: 0,
    briefFaithfulness: 0,
    unknownAdherence: 0,
    conflictDetection: 0,
    correctionRecurrence: 0,
    fabrication: 0,
  };
}

function averageMetrics(list: QualityMetricSet[]): QualityMetricSet {
  const fallback = emptyMetrics();
  if (list.length === 0) return fallback;
  const keys = Object.keys(fallback) as (keyof QualityMetricSet)[];
  for (const key of keys)
    fallback[key] = round(
      average(
        list.map((metrics) => metrics[key]),
        0,
      ),
      key === 'mrr' ? 3 : 1,
    );
  return fallback;
}

function percent(numerator: number, denominator: number): number {
  if (denominator <= 0) return 100;
  return round((numerator / denominator) * 100, 1);
}

function average(values: number[], fallback: number): number {
  return values.length > 0
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : fallback;
}

function round(value: number, digits: number): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function safeDetail(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/Bearer\s+\S+/gi, 'Bearer ***')
    .replace(/sk-[A-Za-z0-9_-]+/g, 'sk-***')
    .slice(0, 180);
}
