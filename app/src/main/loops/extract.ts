import { z } from 'zod';
import type { Claim, DeskObject, SlotDef, Source } from '@shared/types';
import type { ChatMessageParam, CompleteResult } from '../llm/chatCompletions';
import { stubExtract } from '../brain/extractStub';

const DraftSchema = z.object({
  claims: z
    .array(
      z.object({
        objectName: z.string().optional(),
        predicate: z.string(),
        text: z.string(),
        span: z.string(),
      }),
    )
    .default([]),
});

export type ExtractDraft = z.infer<typeof DraftSchema>['claims'][number];

export function idempotencyKey(sourceId: string, objectId: string, predicate: string, span: string): string {
  return `${sourceId}\0${objectId}\0${predicate}\0${span.trim()}`;
}

export function mapPredicate(raw: string, kind: DeskObject['kind'], slotDefs: SlotDef[]): string {
  const name = raw.trim();
  if (!name || name === '未编目') return '未编目';
  const hit = slotDefs.find((d) => d.kind === kind && d.name === name);
  return hit ? hit.name : '未编目';
}

/** 0024：结构化草稿 → 主张。指不回片段的丢掉；映射不上记未编目；幂等键去重。 */
export function draftsToClaims(args: {
  drafts: ExtractDraft[];
  source: Source;
  objects: DeskObject[];
  slotDefs: SlotDef[];
  existing: Claim[];
  now: string;
}): Claim[] {
  const bound = args.objects.filter((o) => args.source.boundObjectIds.includes(o.id));
  if (bound.length === 0) return [];
  const seen = new Set(
    args.existing.map((c) => idempotencyKey(c.sourceId, c.objectId, c.predicate, c.span ?? c.text)),
  );
  const out: Claim[] = [];
  let i = 0;
  for (const draft of args.drafts) {
    const span = draft.span.trim();
    const text = draft.text.trim();
    if (!span || !text) continue;
    if (!args.source.body.includes(span)) continue;
    const obj =
      (draft.objectName
        ? bound.find((o) => o.name === draft.objectName)
        : undefined) ?? bound[0];
    if (!obj) continue;
    const predicate = mapPredicate(draft.predicate, obj.kind, args.slotDefs);
    const key = idempotencyKey(args.source.id, obj.id, predicate, span);
    if (seen.has(key)) continue;
    seen.add(key);
    i += 1;
    out.push({
      id: `cl-x-${args.source.id}-${obj.id}-${String(i)}`,
      objectId: obj.id,
      predicate,
      text: /[。！？]$/.test(text) ? text : `${text}。`,
      status: '成立',
      unverified: true,
      validFrom: args.now.slice(0, 10),
      sourceId: args.source.id,
      span,
      createdAt: args.now.slice(0, 10),
    });
  }
  return out;
}

export async function runExtractLoop(args: {
  source: Source;
  objects: DeskObject[];
  slotDefs: SlotDef[];
  existing: Claim[];
  complete?: ((req: { messages: ChatMessageParam[]; jsonMode?: boolean | undefined }) => Promise<CompleteResult>) | undefined;
}): Promise<Claim[]> {
  const now = new Date().toISOString();
  if (!args.complete) {
    return stubExtract({
      source: args.source,
      objects: args.objects,
      slotDefs: args.slotDefs,
      now,
      existing: args.existing,
    });
  }
  const slots = args.slotDefs.map((d) => `${d.kind}:${d.name}`).join('、');
  const result = await args.complete({
    jsonMode: true,
    messages: [
      {
        role: 'system',
        content: [
          '从原文抽出可单独核对的主张。每条必须带原文片段 span。',
          'predicate 必须是下列槽名之一，对不上就填「未编目」。不准自开槽。',
          slots,
          '只输出 JSON：{"claims":[{"objectName":"","predicate":"","text":"","span":""}]}',
          '原文没说的推论不准写。',
        ].join('\n'),
      },
      { role: 'user', content: args.source.body.slice(0, 8000) },
    ],
  });
  let parsed: ExtractDraft[] = [];
  try {
    const json: unknown = JSON.parse(result.content);
    parsed = DraftSchema.parse(json).claims;
  } catch {
    return [];
  }
  return draftsToClaims({
    drafts: parsed,
    source: args.source,
    objects: args.objects,
    slotDefs: args.slotDefs,
    existing: args.existing,
    now,
  });
}
