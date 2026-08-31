import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deriveConflicts, openBrain, type Brain } from '../brain';
import { outboundBrief } from '../brain/briefOut';
import { resolveFtsHits, searchClaimsFts } from '../brain/fts';
import { listOperations } from '../brain/persist';
import { parseIngestInput } from '../ingestion';
import type { ModelCompletion } from '../llm/runtime';
import { safeDetail } from '../redact';
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
import { QUALITY_METRIC_FLOORS, QUALITY_SUITE_VERSION, STAGE_FLOORED_METRICS } from './fingerprint';
import type { GoldPack } from './goldPacks';
import { validateGoldPacks } from './goldPacks';

const STAGES: QualityStageName[] = ['获取', '抽取', '召回', '出站'];

/** 展示名与设置页指标标签、CONTEXT.md 词条逐字一致；括号内为接口字段名。 */
const METRIC_LABELS: Record<keyof QualityMetricSet, string> = {
  extractionRecall: '抽取召回',
  spanHit: '出处命中',
  ftsRecallAtK: 'Recall@k',
  ftsPrecisionAtK: 'Precision@k',
  mrr: 'MRR',
  briefFaithfulness: '简报忠实',
  unknownAdherence: '未知遵守',
  conflictDetection: '冲突检出',
  correctionRecurrence: '纠正复发',
  uncatDiscipline: '未编目纪律',
  undoCompensation: '撤销补偿',
  fabrication: '编造率',
};

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
    settle(stages, '抽取', extractionStarted, metrics);

    const recallStarted = Date.now();
    try {
      const recall = scoreRecall(brain, object.id, pack);
      metrics.ftsRecallAtK = recall.recall;
      metrics.ftsPrecisionAtK = recall.precision;
      metrics.mrr = recall.mrr;
      settle(stages, '召回', recallStarted, metrics);
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
      metrics.uncatDiscipline = uncatDiscipline(pack, beforeCorrection.claims, brief);
      // 纠正与撤销都会写账本；撤销补偿放最后，保证 UNDO_RESULT 是本包末笔操作。
      metrics.correctionRecurrence = correctionRecurrence(pack, brain, object.id);
      metrics.undoCompensation = undoCompensation(pack, brain, object.id);
      settle(stages, '出站', outboundStarted, metrics);
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

/** 未编目纪律（0037）：引用未编目主张的简报句必须带「未编目·不作定论」降级，不许当单边定论。 */
function uncatDiscipline(pack: GoldPack, claims: Claim[], brief: Brief): number {
  const cases = pack.uncatCases ?? [];
  if (cases.length === 0) return 100;
  const sentences = brief.blocks.flatMap((block) => block.sentences);
  let obeyed = 0;
  for (const uncat of cases) {
    const uncataloged = claims.filter(
      (claim) => claim.predicate === '未编目' && claim.text.includes(uncat.textIncludes),
    );
    const violated = sentences.some(
      (sentence) =>
        sentence.kind === 'claim' &&
        sentence.flag !== '未编目·不作定论' &&
        uncataloged.some((claim) => sentence.claimIds.includes(claim.id)),
    );
    if (!violated) obeyed += 1;
  }
  return percent(obeyed, cases.length);
}

/**
 * 撤销补偿（0034）：晋升提议走 takeover 写队列 → 确认后结果卡必须带 undo 载荷 →
 * 撤销后主张回到未核、operations 留下补偿写审计、重出简报不再单边定论。
 */
function undoCompensation(pack: GoldPack, brain: Brain, objectId: string): number {
  const cases = pack.undoCases ?? [];
  if (cases.length === 0) return 100;
  let obeyed = 0;
  for (const undoCase of cases) {
    const claim = brain
      .snapshot()
      .claims.find(
        (candidate) =>
          candidate.status === '成立' && candidate.text.includes(undoCase.claimTextIncludes),
      );
    if (!claim) continue;
    brain.dispatch({
      type: 'ENQUEUE_WRITE',
      draft: {
        objectId,
        kind: '晋升',
        claimId: claim.id,
        headline: `晋升「${claim.text}」`,
        evidence: `撤销补偿评测剧本 · ${pack.id}`,
      },
    });
    const queued = brain.snapshot().writeQueue.at(-1);
    if (!queued || queued.kind !== '晋升' || queued.claimId !== claim.id) continue;
    brain.dispatch({ type: 'CONFIRM_WRITE', writeId: queued.id });
    const confirmed = brain.snapshot();
    const promoted = confirmed.claims.find((candidate) => candidate.id === claim.id);
    const undoCard = (confirmed.chatByObject[objectId] ?? []).find(
      (message) =>
        message.card?.kind === '结果' &&
        message.card.result === '晋升' &&
        message.card.claimId === claim.id &&
        message.card.undo?.kind === '晋升',
    );
    if (!promoted || promoted.unverified || !undoCard) continue;
    brain.dispatch({ type: 'UNDO_RESULT', objectId, messageId: undoCard.id });
    const after = brain.snapshot();
    const undone = after.claims.find((candidate) => candidate.id === claim.id);
    // 末笔操作断言用「补偿行」而非位置：同毫秒 dispatch 下 created_at 排序对并列行不保证稳定。
    const operations = listOperations(brain.db);
    const compensating = operations.filter((row) => row.undo_of === 'compensating');
    const briefBefore = outboundBrief(
      confirmed,
      objectId,
      `brief-undo-before-${pack.id}`,
      `task-undo-before-${pack.id}`,
    );
    const briefAfter = outboundBrief(
      after,
      objectId,
      `brief-undo-${pack.id}`,
      `task-undo-${pack.id}`,
    );
    const claimSentenceIn = (source: Brief, claimId: string) =>
      source.blocks
        .flatMap((block) => block.sentences)
        .find((sentence) => sentence.kind === 'claim' && sentence.claimIds.includes(claimId));
    const settledSentence = claimSentenceIn(briefBefore, claim.id);
    const undoneSentence = claimSentenceIn(briefAfter, claim.id);
    if (
      undone &&
      undone.status === '成立' &&
      undone.unverified &&
      compensating.length === 1 &&
      compensating[0]?.action === 'UNDO_RESULT' &&
      settledSentence &&
      undoneSentence &&
      !settledSentence.unverified &&
      undoneSentence.unverified
    )
      obeyed += 1;
  }
  return percent(obeyed, cases.length);
}

function unrunStages(): QualityStageResult[] {
  return STAGES.map((name) => ({ name, status: '未运行', durationMs: 0 }));
}

function pass(stages: QualityStageResult[], name: QualityStageName, started: number): void {
  replaceStage(stages, { name, status: '通过', durationMs: Math.max(Date.now() - started, 0) });
}

/**
 * 0045：stage 收尾既查异常也查分数线——该 stage 名下任一指标未达 QUALITY_METRIC_FLOORS
 * 即失败，detail 点名指标、实际值、下限与差距。fabrication 的 floor 语义是上限。
 */
function settle(
  stages: QualityStageResult[],
  name: QualityStageName,
  started: number,
  metrics: QualityMetricSet,
): void {
  const breaches: string[] = [];
  for (const key of STAGE_FLOORED_METRICS[name]) {
    const floor = QUALITY_METRIC_FLOORS[key];
    const value = metrics[key];
    if (key === 'fabrication' ? value > floor : value < floor) {
      const gap = round(Math.abs(value - floor), 3);
      const direction = key === 'fabrication' ? '超过上限' : '低于下限';
      breaches.push(`${METRIC_LABELS[key]} ${key}=${value}，${direction} ${floor}（差 ${gap}）`);
    }
  }
  if (breaches.length === 0) pass(stages, name, started);
  else fail(stages, name, started, new Error(`指标未达合格线：${breaches.join('；')}`));
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
    uncatDiscipline: 0,
    undoCompensation: 0,
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
