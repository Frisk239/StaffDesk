import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { outboundBrief } from '../brain/briefOut';
import { openBrain } from '../brain';
import { draftsToClaims } from '../loops/extract';
import type { GoldPack } from './goldPacks';
import { packForScenario } from './goldPacks';
import type { ScenarioKind } from '@shared/types';

export interface CertScores {
  recall: number;
  faithful: number;
  unknown: number;
  fabrication: number;
}

const FABRICATION_LINE = 5;

export function fabricationLine(): number {
  return FABRICATION_LINE;
}

/** 在临时大脑里跑金标：抽主张、出简报、打分。不写进用户库。 */
export function runCert(pack: GoldPack, extraNegatives: string[] = []): CertScores {
  const dir = mkdtempSync(join(tmpdir(), 'staffdesk-cert-'));
  const brain = openBrain(join(dir, 'brain.db'));
  try {
    brain.dispatch({ type: 'ADD_WORKSPACE', name: '金标', scenario: pack.scenario });
    brain.dispatch({ type: 'ADD_OBJECT', kind: pack.object.kind, name: pack.object.name });
    const obj = brain.snapshot().objects[0];
    if (!obj) throw new Error('金标对象未建');
    brain.dispatch({ type: 'ADD_SOURCE', title: pack.source.title, body: pack.source.body });
    const src = brain.snapshot().sources.find((s) => !s.virtual);
    if (!src) throw new Error('金标来源未建');
    brain.dispatch({ type: 'BIND_CONFIRMED', sourceId: src.id, objectIds: [obj.id] });
    const drafts = [
      ...pack.expected.map((e) => ({
        predicate: e.predicate,
        text: `${pack.object.name}${e.textIncludes}。`,
        span: e.spanIncludes,
      })),
      ...extraNegatives.map((text) => ({
        predicate: '未编目',
        text,
        span: pack.expected[0]?.spanIncludes ?? pack.source.body.slice(0, 8),
      })),
    ];
    const extracted = draftsToClaims({
      drafts,
      source: { ...src, boundObjectIds: [obj.id], body: pack.source.body },
      objects: [obj],
      slotDefs: brain.snapshot().slotDefs,
      existing: [],
      now: '2026-08-29',
    });
    brain.dispatch({ type: 'EXTRACT_DONE', sourceId: src.id, claims: extracted });
    const state = brain.snapshot();
    const brief = outboundBrief(state, obj.id, 'brief-cert', 'task-cert');
    return scorePack(pack, state.claims, brief, extraNegatives);
  } finally {
    brain.close();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* windows lock */
    }
  }
}

export function runCertForScenario(scenario: ScenarioKind): CertScores {
  return runCert(packForScenario(scenario));
}

export function scorePack(
  pack: GoldPack,
  claims: { predicate: string; text: string; status: string; sourceId: string }[],
  brief: { blocks: { sentences: { claimIds: string[]; kind: string }[] }[] },
  extraNegatives: string[] = [],
): CertScores {
  const live = claims.filter((c) => c.status === '成立');
  const hitExpected = pack.expected.filter((e) =>
    live.some((c) => c.predicate === e.predicate && c.text.includes(e.textIncludes)),
  ).length;
  const recall = pct(hitExpected, pack.expected.length);

  const sentences = brief.blocks.flatMap((b) => b.sentences);
  const claimSentences = sentences.filter((s) => s.kind !== 'unknown');
  const faithful = pct(
    claimSentences.filter((s) => s.claimIds.length > 0).length,
    Math.max(claimSentences.length, 1),
  );

  const unknownOk = pack.unknownSlots.length
    ? pack.unknownSlots.filter((slot) => !live.some((c) => c.predicate === slot)).length
    : 1;
  const unknown = pct(unknownOk, Math.max(pack.unknownSlots.length, 1));

  const negatives = [...pack.negatives, ...extraNegatives];
  const fabricated = live.filter((c) => negatives.some((n) => c.text.includes(n))).length;
  const fabrication = Number(((fabricated / Math.max(live.length, 1)) * 100).toFixed(1));

  return { recall, faithful, unknown, fabrication };
}

function pct(num: number, den: number): number {
  if (den <= 0) return 100;
  return Math.round((num / den) * 100);
}
