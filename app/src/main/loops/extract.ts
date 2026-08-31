import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Claim, DeskObject, ExtractionOutcomeKind, SlotDef, Source } from '@shared/types';
import type { ChatMessageParam, CompleteResult } from '../llm/chatCompletions';
import { safeDetail } from '../redact';

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

export interface ExtractionOutcome {
  status: ExtractionOutcomeKind;
  claims: Claim[];
  draftCount: number;
  rejectedCount: number;
  detail?: string | undefined;
}

export interface ExtractionChunk {
  id: string;
  start: number;
  end: number;
  text: string;
  page?: number | undefined;
  label?: string | undefined;
}

export function idempotencyKey(
  sourceId: string,
  objectId: string,
  predicate: string,
  span: string,
): string {
  return `${sourceId}\0${objectId}\0${predicate}\0${span.trim()}`;
}

function evidenceKey(span: string, start: number | undefined): string {
  return typeof start === 'number' ? `${span.trim()}\0${start}` : span.trim();
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
  chunk?: ExtractionChunk | undefined;
}): Claim[] {
  const bound = args.objects.filter((o) => args.source.boundObjectIds.includes(o.id));
  if (bound.length === 0) return [];
  const seen = new Set(
    args.existing.map((c) =>
      idempotencyKey(
        c.sourceId,
        c.objectId,
        c.predicate,
        evidenceKey(c.span ?? c.text, c.sourceStart),
      ),
    ),
  );
  const out: Claim[] = [];
  for (const draft of args.drafts) {
    const span = draft.span.trim();
    const text = draft.text.trim();
    if (!span || !text) continue;
    const found = locateSpan(args.source, span, args.chunk);
    if (!found) continue;
    const obj =
      (draft.objectName ? bound.find((o) => o.name === draft.objectName) : undefined) ?? bound[0];
    if (!obj) continue;
    const predicate = mapPredicate(draft.predicate, obj.kind, args.slotDefs);
    const key = idempotencyKey(args.source.id, obj.id, predicate, evidenceKey(span, found.start));
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      // 幂等性由 source/object/predicate/span 键承担；PK 只负责不透明唯一。
      id: `cl-x-${randomUUID()}`,
      objectId: obj.id,
      predicate,
      text: /[。！？]$/.test(text) ? text : `${text}。`,
      status: '成立',
      unverified: true,
      validFrom: args.now.slice(0, 10),
      sourceId: args.source.id,
      span,
      sourceStart: found.start,
      sourceEnd: found.end,
      sourceLocator: found.locator,
      createdAt: args.now.slice(0, 10),
    });
  }
  return out;
}

export function buildExtractionChunks(
  source: Source,
  maxChars = 8_000,
  overlapChars = 400,
): ExtractionChunk[] {
  if (source.body.length <= maxChars) {
    const segment = segmentForRange(source, 0, source.body.length);
    return [
      {
        id: `${source.id}:0-${source.body.length}`,
        start: 0,
        end: source.body.length,
        text: source.body,
        page: segment?.page,
        label: segment?.label,
      },
    ];
  }
  const ranges =
    source.segments && source.segments.length > 0
      ? source.segments.map((segment) => ({ start: segment.start, end: segment.end }))
      : [{ start: 0, end: source.body.length }];
  const chunks: ExtractionChunk[] = [];
  const step = Math.max(1, maxChars - overlapChars);
  for (const range of ranges) {
    let start = range.start;
    while (start < range.end) {
      const naturalEnd = Math.min(start + maxChars, range.end);
      const end = naturalEnd < range.end ? softenEnd(source.body, start, naturalEnd) : naturalEnd;
      const segment = segmentForRange(source, start, end);
      chunks.push({
        id: `${source.id}:${start}-${end}`,
        start,
        end,
        text: source.body.slice(start, end),
        page: segment?.page,
        label: segment?.label,
      });
      if (end >= range.end) break;
      start = Math.max(start + step, end - overlapChars);
    }
  }
  return chunks;
}

export async function runExtractLoop(args: {
  source: Source;
  objects: DeskObject[];
  slotDefs: SlotDef[];
  existing: Claim[];
  complete?:
    | ((req: {
        messages: ChatMessageParam[];
        jsonMode?: boolean | undefined;
      }) => Promise<CompleteResult>)
    | undefined;
}): Promise<ExtractionOutcome> {
  const now = new Date().toISOString();
  if (!args.complete) {
    return outcome('unconfigured', [], 0, 0, '尚未配置可调用的模型');
  }
  const boundObjects = args.objects.filter((object) =>
    args.source.boundObjectIds.includes(object.id),
  );
  const kinds = new Set(boundObjects.map((object) => object.kind));
  const slots = [...kinds]
    .map((kind) => {
      const names = args.slotDefs
        .filter((slot) => slot.kind === kind)
        .map((slot) => slot.name)
        .join('、');
      return `${kind}可用槽名：${names || '无'}`;
    })
    .join('\n');
  const chunks = buildExtractionChunks(args.source);
  const claims: Claim[] = [];
  let draftCount = 0;
  for (const chunk of chunks) {
    let result: CompleteResult;
    try {
      result = await args.complete({
        jsonMode: true,
        messages: extractionMessages(args.source.title, chunk, boundObjects, slots),
      });
    } catch (error) {
      return outcome('failed', [], 0, 0, safeDetail(error));
    }

    const parsed = parseDrafts(result.content);
    if (!parsed.ok) {
      return outcome('invalid-output', [], 0, 0, parsed.detail);
    }
    draftCount += parsed.drafts.length;
    const chunkClaims = draftsToClaims({
      drafts: parsed.drafts,
      source: args.source,
      objects: args.objects,
      slotDefs: args.slotDefs,
      existing: [...args.existing, ...claims],
      now,
      chunk,
    });
    claims.push(...chunkClaims);
  }
  return outcome('success', claims, draftCount, Math.max(draftCount - claims.length, 0));
}

function extractionMessages(
  title: string,
  chunk: ExtractionChunk,
  boundObjects: DeskObject[],
  slots: string,
): ChatMessageParam[] {
  return [
    {
      role: 'system',
      content: [
        '你是主张抽取器。从原文抽出可单独核对的原子命题。',
        '每条 text 必须写成离开上下文仍成立的完整句子，并明确写出对象。',
        'span 必须逐字复制当前原文片段中的一段连续文本；不要改写、不要补标点。',
        'predicate 只能使用允许槽名；映射不上填「未编目」，不准自开槽。',
        `允许对象：${boundObjects.map((object) => `${object.kind}「${object.name}」`).join('、') || '无'}`,
        slots || '可用槽名：无',
        'objectName 必须与允许对象名称完全一致。原文没说的推论不准写。',
        '只输出一个 JSON 对象，不要 Markdown、解释或思考过程：',
        '{"claims":[{"objectName":"对象原名","predicate":"槽名或未编目","text":"完整命题","span":"原文连续片段"}]}',
        '没有可核对命题时输出 {"claims":[]}。',
      ].join('\n'),
    },
    {
      role: 'user',
      content: [
        `来源标题：${title}`,
        `片段位置：${chunk.label ?? chunk.id}，全文字符 ${chunk.start}-${chunk.end}`,
        '原文片段：',
        chunk.text,
      ].join('\n'),
    },
  ];
}

function locateSpan(
  source: Source,
  span: string,
  chunk: ExtractionChunk | undefined,
): { start: number; end: number; locator: NonNullable<Claim['sourceLocator']> } | undefined {
  const haystack = chunk?.text ?? source.body;
  const local = haystack.indexOf(span);
  if (local < 0) return undefined;
  const start = (chunk?.start ?? 0) + local;
  const end = start + span.length;
  const segment = segmentForRange(source, start, end);
  return {
    start,
    end,
    locator: {
      id: segment?.id ?? `range-${start}-${end}`,
      start,
      end,
      page: segment?.page,
      label: segment?.label,
    },
  };
}

function segmentForRange(source: Source, start: number, end: number) {
  return source.segments?.find((segment) => start >= segment.start && end <= segment.end);
}

function softenEnd(body: string, start: number, preferredEnd: number): number {
  const floor = start + Math.floor((preferredEnd - start) * 0.7);
  for (let i = preferredEnd; i > floor; i -= 1) {
    const char = body[i];
    if (char === '\n' || char === '。' || char === '！' || char === '？' || char === '.') {
      return i + 1;
    }
  }
  return preferredEnd;
}

function outcome(
  status: ExtractionOutcomeKind,
  claims: Claim[],
  draftCount: number,
  rejectedCount: number,
  detail?: string,
): ExtractionOutcome {
  return { status, claims, draftCount, rejectedCount, ...(detail ? { detail } : {}) };
}

function parseDrafts(
  content: string,
): { ok: true; drafts: ExtractDraft[] } | { ok: false; detail: string } {
  const trimmed = content.trim().replace(/^\uFEFF/, '');
  if (!trimmed) return { ok: false, detail: '模型返回了空内容' };
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  const sliced =
    firstBrace >= 0 && lastBrace > firstBrace ? trimmed.slice(firstBrace, lastBrace + 1) : '';
  const candidates = [trimmed, fenced, sliced].filter((candidate): candidate is string =>
    Boolean(candidate),
  );
  let sawJson = false;
  for (const candidate of candidates) {
    try {
      const json: unknown = JSON.parse(candidate);
      sawJson = true;
      const parsed = DraftSchema.safeParse(json);
      if (parsed.success) return { ok: true, drafts: parsed.data.claims };
    } catch {
      // 继续尝试下一个安全截取候选。
    }
  }
  return {
    ok: false,
    detail: sawJson ? '模型返回的 JSON 不符合主张结构' : '模型没有返回可解析的 JSON',
  };
}
