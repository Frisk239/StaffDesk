import { deriveConflicts, slotsForScene, scenarioOfWorkspace } from '@shared/scenario';
import type { Claim, Source, State } from '@shared/types';
import { projectionFrom } from '../brain/projection';

export const READONLY_TOOL_NAMES = [
  'recall_claims',
  'read_source_span',
  'list_conflicts',
  'read_brief',
  'list_empty_slots',
] as const;

export type ReadonlyToolName = (typeof READONLY_TOOL_NAMES)[number];

/** 0028 只读工具：不写账本。作用域绑在当前对象，未绑定来源不进语境。 */
export function executeReadonlyTool(
  state: State,
  objectId: string,
  name: string,
  argsJson: string,
): string {
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(argsJson || '{}') as Record<string, unknown>;
  } catch {
    return JSON.stringify({ error: '参数不是 JSON' });
  }
  switch (name) {
    case 'recall_claims':
      return JSON.stringify(recallClaims(state, objectId, String(args.query ?? '')));
    case 'read_source_span':
      return JSON.stringify(
        readSourceSpan(state, objectId, String(args.sourceId ?? ''), String(args.span ?? '')),
      );
    case 'list_conflicts':
      return JSON.stringify(listConflicts(state, objectId));
    case 'read_brief':
      return JSON.stringify(readBrief(state, objectId));
    case 'list_empty_slots':
      return JSON.stringify(listEmptySlots(state, objectId));
    default:
      return JSON.stringify({ error: '未知工具' });
  }
}

/** 召回条目：一跳（关联对象）条目带 objectName 标明来源对象；本对象条目不带。 */
export interface RecallEntry {
  id: string;
  text: string;
  predicate: string;
  unverified: boolean;
  objectName?: string | undefined;
}

export const RECALL_LIMIT = 12;

/**
 * CONTEXT「关系」：一跳邻居 = 与本对象有边的对象。边对称双侧存储，
 * 但读时任一方向命中即算邻居（容错旧库或半写状态），并跳过悬边 id。
 */
export function relatedObjectIds(state: State, objectId: string): string[] {
  const out: string[] = [];
  const self = state.objects.find((o) => o.id === objectId);
  for (const id of self?.relationIds ?? []) {
    if (id !== objectId && state.objects.some((o) => o.id === id) && !out.includes(id)) {
      out.push(id);
    }
  }
  for (const o of state.objects) {
    if (o.id !== objectId && o.relationIds.includes(objectId) && !out.includes(o.id)) {
      out.push(o.id);
    }
  }
  return out;
}

function claimMatches(c: Claim, q: string): boolean {
  return !q || c.text.includes(q) || c.predicate.includes(q) || (c.span ?? '').includes(q);
}

function toEntry(c: Claim, objectName?: string): RecallEntry {
  return objectName === undefined
    ? { id: c.id, text: c.text, predicate: c.predicate, unverified: c.unverified }
    : { id: c.id, text: c.text, predicate: c.predicate, unverified: c.unverified, objectName };
}

/** 本对象优先、一跳补位到上限；projectionFrom 已按各自对象过滤绑定来源，未绑定来源不进语境。 */
export function fillOneHop(
  state: State,
  objectId: string,
  query: string,
  own: RecallEntry[],
): RecallEntry[] {
  const q = query.trim();
  const out = own.slice(0, RECALL_LIMIT);
  if (out.length >= RECALL_LIMIT) return out;
  for (const rid of relatedObjectIds(state, objectId)) {
    const rel = state.objects.find((o) => o.id === rid);
    if (!rel) continue;
    const extra = projectionFrom(state.claims, state.sources, rid).filter((c) =>
      claimMatches(c, q),
    );
    for (const c of extra) {
      if (out.length >= RECALL_LIMIT) return out;
      out.push(toEntry(c, rel.name));
    }
  }
  return out;
}

export function recallClaims(state: State, objectId: string, query: string): RecallEntry[] {
  const q = query.trim();
  const live = projectionFrom(state.claims, state.sources, objectId);
  const ranked = q ? live.filter((c) => claimMatches(c, q)) : live;
  return fillOneHop(
    state,
    objectId,
    q,
    ranked.slice(0, RECALL_LIMIT).map((c) => toEntry(c)),
  );
}

export function readSourceSpan(
  state: State,
  objectId: string,
  sourceId: string,
  span: string,
): { title?: string; path?: string; excerpt: string } | { error: string } {
  const src = state.sources.find((s) => s.id === sourceId);
  if (!src) return { error: '没有这条来源' };
  if (!src.virtual && !src.boundObjectIds.includes(objectId)) {
    return { error: '未绑定来源不进对象语境' };
  }
  const excerpt = pickExcerpt(src, span);
  return { title: src.title, path: src.path, excerpt };
}

export function listConflicts(state: State, objectId: string): { a: Claim; b: Claim }[] {
  const pairs = deriveConflicts(state.claims, state.slotDefs);
  const out: { a: Claim; b: Claim }[] = [];
  for (const p of pairs) {
    const a = state.claims.find((c) => c.id === p.claimIdA);
    const b = state.claims.find((c) => c.id === p.claimIdB);
    if (a && b && a.objectId === objectId && b.objectId === objectId) out.push({ a, b });
  }
  return out;
}

export function readBrief(state: State, objectId: string): unknown {
  const briefs = state.briefs.filter((b) => b.objectId === objectId);
  const latest = briefs[briefs.length - 1];
  if (!latest) return { error: '还没有简报' };
  return { id: latest.id, createdAt: latest.createdAt, blocks: latest.blocks };
}

export function listEmptySlots(state: State, objectId: string): string[] {
  const obj = state.objects.find((o) => o.id === objectId);
  if (!obj) return [];
  const scenario = scenarioOfWorkspace(state.workspaces, obj.workspaceId);
  const slots = slotsForScene(state.slotDefs, obj.kind, scenario);
  const live = projectionFrom(state.claims, state.sources, objectId);
  return slots.filter((name) => !live.some((c) => c.predicate === name));
}

function pickExcerpt(src: Source, span: string): string {
  if (span && src.body.includes(span)) {
    const i = src.body.indexOf(span);
    return src.body.slice(Math.max(0, i - 40), i + span.length + 40);
  }
  return src.body.slice(0, 240);
}

export const READONLY_TOOL_DEFS = [
  {
    type: 'function' as const,
    function: {
      name: 'recall_claims',
      description:
        '在当前对象已绑定来源的主张里召回；本对象优先，不足时也会带出关联对象的主张补位，跳对象来的条目标注来源对象 objectName。',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'read_source_span',
      description: '读一条已绑定来源的原文片段。',
      parameters: {
        type: 'object',
        properties: { sourceId: { type: 'string' }, span: { type: 'string' } },
        required: ['sourceId'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'list_conflicts',
      description: '列出当前对象单值槽上的派生冲突。',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'read_brief',
      description: '读当前对象最新一份简报。',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'list_empty_slots',
      description: '列出当前场景下没有主张的槽（未知格子）。',
      parameters: { type: 'object', properties: {} },
    },
  },
];
