import type { Claim, Proposal, Source, State } from '@shared/types';
import { deriveConflicts, normalizeValue } from '@shared/scenario';
import { bindingRole } from '@shared/primarySource';
import { DEFAULT_LINGER_DAYS, MIN_LINGER_DAYS } from '../lingerDays';

/**
 * 复核提示阈值（天）：validFrom 距今天超过该天数才提议「标过时」。
 * 只是提示，不是主张状态——人确认 accept-close 才关窗（世界已变），历史不改写（0034）。
 */
export const STALE_AFTER_DAYS = 180;

/**
 * 0064：滞留是这条主张的属性——成立且未核，且入库（createdAt）满 N 天。
 * 不用 validFrom；打开档案 / 提问 / 抽新材料都不清零。N<1 视为不出卡（0 会回流 P1）。
 */
export function lingeringUnverifiedClaims(
  state: State,
  objectId: string,
  lingerDays: number,
  now: string,
): Claim[] {
  if (!Number.isInteger(lingerDays) || lingerDays < MIN_LINGER_DAYS) return [];
  return state.claims.filter(
    (c) =>
      c.objectId === objectId &&
      c.status === '成立' &&
      c.unverified &&
      daysSinceCreated(c.createdAt, now) >= lingerDays,
  );
}

/** 抽取后若有滞留未核，提议丢弃（0037/0064）。人确认才改账本。now + lingerDays 由调用方注入。 */
export function proposeDropUnverified(
  state: State,
  objectId: string,
  seq: number,
  lingerDays: number = DEFAULT_LINGER_DAYS,
  now: string = new Date().toISOString(),
): Proposal | null {
  const lingering = lingeringUnverifiedClaims(state, objectId, lingerDays, now);
  if (lingering.length === 0) return null;
  const ids = lingering.map((c) => c.id);
  if (hasDropCardForIds(state, objectId, ids, { pending: true })) return null;
  // 0064：驳回后滞留集合不变就不再出卡；集合变了（有人新满 N 天或有人离开）才出新卡。
  if (hasDropCardForIds(state, objectId, ids, { pending: false, decision: 'reject' })) return null;
  if (pendingDropCardsForObject(state, objectId).length > 0) return null;
  return makeDropProposal(lingering, objectId, seq);
}

/**
 * 0064：挂起的丢弃未核卡按 live 滞留集合刷新；一个不剩才撤（pending:false，不记决策）。
 * goneClaimIds：解绑/删来源后主张已不在账本，仍靠旧 id 把卡认回该对象。
 */
export function refreshPendingDropUnverified(
  state: State,
  objectId: string,
  lingerDays: number,
  now: string,
  goneClaimIds: ReadonlySet<string> = new Set(),
): State {
  const pending = pendingDropCardsForObject(state, objectId, goneClaimIds);
  if (pending.length === 0) return state;
  const lingering = lingeringUnverifiedClaims(state, objectId, lingerDays, now);
  const liveIds = lingering.map((c) => c.id);
  const head = pending[0]!;
  const restIds = new Set(pending.slice(1).map((p) => p.id));
  if (lingering.length === 0) {
    return {
      ...state,
      proposals: state.proposals.map((p) =>
        pending.some((card) => card.id === p.id) ? withdrawDropCard(p, objectId) : p,
      ),
    };
  }
  if (
    pending.length === 1 &&
    head.payload.kind === '丢弃未核' &&
    sameIds(head.payload.claimIds, liveIds)
  ) {
    return state;
  }
  const fields = dropProposalFields(lingering, objectId);
  return {
    ...state,
    proposals: state.proposals.map((p) => {
      if (p.id === head.id) return { ...p, ...fields, pending: true };
      if (restIds.has(p.id)) return withdrawDropCard(p, objectId);
      return p;
    }),
  };
}

/** 打开待确认 / 抽取钩子：先刷新挂起卡，再按 live 滞留集合生成（或缺席）。默认扫当前工作区。 */
export function scanLingerUnverified(
  state: State,
  lingerDays: number,
  now: string,
  objectIds?: readonly string[],
): State {
  const ids =
    objectIds ??
    state.objects
      .filter((o) => o.workspaceId === state.currentWorkspaceId && !o.archived)
      .map((o) => o.id);
  let next = state;
  let seq = state.seq;
  for (const objectId of ids) {
    next = refreshPendingDropUnverified(next, objectId, lingerDays, now);
    const proposed = proposeDropUnverified(next, objectId, seq, lingerDays, now);
    if (!proposed) continue;
    next = { ...next, proposals: [...next.proposals, proposed], seq: seq + 1 };
    seq += 1;
  }
  return next;
}

function makeDropProposal(lingering: Claim[], objectId: string, seq: number): Proposal {
  return {
    id: `prop-drop-${objectId}-${seq}`,
    type: '整理',
    pending: true,
    ...dropProposalFields(lingering, objectId),
  };
}

function dropProposalFields(lingering: Claim[], objectId: string) {
  return {
    title: `建议丢弃滞留未核 ${lingering.length} 条`,
    detail: lingering.map((c) => `· ${c.text}`).join('\n'),
    payload: {
      kind: '丢弃未核' as const,
      claimIds: lingering.map((c) => c.id),
      objectId,
    },
  };
}

function withdrawDropCard(proposal: Proposal, objectId: string): Proposal {
  return {
    ...proposal,
    pending: false,
    title: '建议丢弃滞留未核 0 条',
    detail: '',
    payload: { kind: '丢弃未核', claimIds: [], objectId },
  };
}

function pendingDropCardsForObject(
  state: State,
  objectId: string,
  goneClaimIds: ReadonlySet<string> = new Set(),
): Proposal[] {
  return state.proposals.filter(
    (p) =>
      p.pending &&
      p.payload.kind === '丢弃未核' &&
      dropCardBelongsTo(state, p, objectId, goneClaimIds),
  );
}

function hasDropCardForIds(
  state: State,
  objectId: string,
  ids: string[],
  match: { pending: boolean; decision?: Proposal['decision'] },
): boolean {
  return state.proposals.some((p) => {
    if (p.payload.kind !== '丢弃未核') return false;
    if (p.pending !== match.pending) return false;
    if (match.decision !== undefined && p.decision !== match.decision) return false;
    if (!dropCardBelongsTo(state, p, objectId)) return false;
    return sameIds(p.payload.claimIds, ids);
  });
}

function dropCardBelongsTo(
  state: State,
  proposal: Proposal,
  objectId: string,
  goneClaimIds: ReadonlySet<string> = new Set(),
): boolean {
  if (proposal.payload.kind !== '丢弃未核') return false;
  if (proposal.payload.objectId === objectId) return true;
  return proposal.payload.claimIds.some((id) => {
    if (goneClaimIds.has(id)) return true;
    return state.claims.find((c) => c.id === id)?.objectId === objectId;
  });
}

function daysSinceCreated(createdAt: string, now: string): number {
  const age = dayIndex(now) - dayIndex(createdAt);
  return Number.isFinite(age) ? age : Number.NaN;
}

/**
 * 合并重复（0053）：成立主张按（对象、受控谓词槽、normalizeValue(text)）分组，
 * 组内 ≥2 条即同一值写了两遍——提议保留首条、去掉其余。
 * 判重与 deriveConflicts 用同一把归一化尺（大小写、空白、全半角），不做语义判断。
 */
export function proposeMergeDuplicates(state: State, objectId: string, seq: number): Proposal[] {
  const controlled = new Set(state.slotDefs.map((d) => d.name));
  const groups = new Map<string, Claim[]>();
  for (const c of state.claims) {
    if (c.objectId !== objectId || c.status !== '成立' || !controlled.has(c.predicate)) continue;
    const key = `${c.predicate}\0${normalizeValue(c.text)}`;
    const bucket = groups.get(key);
    if (bucket) bucket.push(c);
    else groups.set(key, [c]);
  }
  const out: Proposal[] = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const keep = group[0]!;
    const dropIds = group.slice(1).map((c) => c.id);
    const already = state.proposals.some(
      (p) =>
        p.pending &&
        p.payload.kind === '合并重复' &&
        p.payload.keepId === keep.id &&
        sameIds(p.payload.dropIds, dropIds),
    );
    if (already) continue;
    out.push({
      id: `prop-merge-${seq}-${out.length}`,
      type: '整理',
      title: `建议合并 ${group.length} 条重复主张（${keep.predicate}）`,
      detail: [`保留：· ${keep.text}`, ...group.slice(1).map((c) => `去掉：· ${c.text}`)].join(
        '\n',
      ),
      payload: { kind: '合并重复', keepId: keep.id, dropIds },
      pending: true,
    });
  }
  return out;
}

/** 标过时：成立且有 validFrom、距今超过 STALE_AFTER_DAYS 天的主张，每条一卡提请复核。 */
export function proposeMarkStale(
  state: State,
  objectId: string,
  seq: number,
  today?: string | undefined,
): Proposal[] {
  const day = today ?? new Date().toISOString().slice(0, 10);
  const stale = state.claims.filter(
    (c) =>
      c.objectId === objectId &&
      c.status === '成立' &&
      c.validFrom !== undefined &&
      dayIndex(day) - dayIndex(c.validFrom) > STALE_AFTER_DAYS &&
      !state.proposals.some(
        (p) => p.pending && p.payload.kind === '标过时' && p.payload.claimId === c.id,
      ),
  );
  return stale.map((c, index) => ({
    id: `prop-stale-${seq}-${index}`,
    type: '整理' as const,
    title: `建议复核：主张已超过 ${STALE_AFTER_DAYS} 天未更新`,
    detail: `· ${c.text}\n（自 ${c.validFrom} 起有效；若世界已变，确认后关窗，历史仍保留）`,
    payload: { kind: '标过时', claimId: c.id },
    pending: true,
  }));
}

/** 未编目编目：残留的成立未编目主张每条一卡，槽由人在卡上选（0025 只能并入受控槽）。 */
export function proposeCatalogUncataloged(state: State, objectId: string, seq: number): Proposal[] {
  const residue = state.claims.filter(
    (c) =>
      c.objectId === objectId &&
      c.predicate === '未编目' &&
      c.status === '成立' &&
      !state.proposals.some(
        (p) => p.pending && p.payload.kind === '整理' && p.payload.claimId === c.id,
      ),
  );
  return residue.map((c, index) => ({
    id: `prop-uncat-${seq}-${index}`,
    type: '整理' as const,
    title: '建议为未编目主张编目',
    detail: `· ${c.text}\n（选择要并入的槽后确认）`,
    payload: { kind: '整理', claimId: c.id },
    pending: true,
  }));
}

/**
 * 建新对象（0052）：抽取发现、未命中任何既有对象名的名字，每名一卡。
 * 撞名（含已归档对象）不提——对象身份只由人确认，先排除重复档案。
 * 名字命中与否与 draftsToClaims 的归属回落无关：这里只产提议信号。
 */
export function proposeNewObjects(
  state: State,
  objectId: string,
  seq: number,
  names?: string[] | undefined,
): Proposal[] {
  if (!names || names.length === 0) return [];
  const existingNames = new Set(state.objects.map((o) => o.name));
  const out: Proposal[] = [];
  const seen = new Set<string>();
  for (const raw of names) {
    const name = raw.trim();
    if (!name || seen.has(name) || existingNames.has(name)) continue;
    if (
      state.proposals.some(
        (p) => p.pending && p.payload.kind === '建对象' && p.payload.name === name,
      )
    ) {
      continue;
    }
    seen.add(name);
    out.push({
      id: `prop-newobj-${seq}-${out.length}`,
      type: '整理',
      title: `建议新建对象「${name}」`,
      detail: `抽取发现的新主体「${name}」。\n确认时选定种类（人/组织/项目）才建立；来源不会自动绑定到新对象，需要手动绑定。`,
      payload: { kind: '建对象', name, fromObjectId: objectId },
      pending: true,
    });
  }
  return out;
}

/**
 * 补关系：本对象成立主张的文本里出现另一既有对象的全名 → 提议建边。
 * 只提跨种类、未归档、名字 ≥2 字、双边无边的对（reducer 复刻仍会再校验一遍）；
 * 同种类的对在提议层先滤掉，省噪声。名字匹配要求出现完整名，且该次出现不被
 * 更长的既有对象名盖住（防「阿里」误配进「阿里巴巴」）。
 */
export function proposeRelations(state: State, objectId: string, seq: number): Proposal[] {
  const anchor = state.objects.find((o) => o.id === objectId);
  // 锚对象已归档时边也建不成（ADD_RELATION 同款校验），提议层直接不出。
  if (!anchor || anchor.archived) return [];
  const candidates = state.objects.filter(
    (o) => o.id !== objectId && !o.archived && o.kind !== anchor.kind && o.name.trim().length >= 2,
  );
  if (candidates.length === 0) return [];
  const texts = state.claims
    .filter((c) => c.objectId === objectId && c.status === '成立')
    .map((c) => c.text);
  const out: Proposal[] = [];
  for (const other of candidates) {
    if (anchor.relationIds.includes(other.id) || other.relationIds.includes(anchor.id)) continue;
    const mentioned = texts.some((text) => mentionsName(state.objects, text, other.name));
    if (!mentioned) continue;
    const pairKey = [objectId, other.id].sort().join('\0');
    const already = state.proposals.some(
      (p) =>
        p.pending &&
        p.payload.kind === '建关系' &&
        [p.payload.objectId, p.payload.targetId].sort().join('\0') === pairKey,
    );
    if (already) continue;
    out.push({
      id: `prop-rel-${seq}-${out.length}`,
      type: '整理',
      title: `建议建立关系：「${anchor.name}」 ↔ 「${other.name}」`,
      detail: `「${anchor.name}」的成立主张里提到了「${other.name}」。\n确认后在这两个对象之间建立可跳转的关系；不会动任何主张。`,
      payload: { kind: '建关系', objectId, targetId: other.id },
      pending: true,
    });
  }
  return out;
}

/**
 * 0062：冲突双方均出自主键绑定且来源时间可辨（新 v 旧）时，提议关窗旧版。
 * 人确认才关窗；生成提议本身不消解冲突（0029）。转述一侧永不进入此卡。
 */
export function proposeSupersedeByPrimary(state: State, objectId: string, seq: number): Proposal[] {
  const pairs = deriveConflicts(state.claims, state.slotDefs);
  const out: Proposal[] = [];
  for (const pair of pairs) {
    const a = state.claims.find((c) => c.id === pair.claimIdA);
    const b = state.claims.find((c) => c.id === pair.claimIdB);
    if (!a || !b || a.objectId !== objectId || b.objectId !== objectId) continue;
    const srcA = state.sources.find((s) => s.id === a.sourceId);
    const srcB = state.sources.find((s) => s.id === b.sourceId);
    if (!srcA || !srcB) continue;
    if (bindingRole(srcA, objectId) !== '主键' || bindingRole(srcB, objectId) !== '主键') continue;
    const ordered = orderBySourceTime(a, srcA, b, srcB);
    if (!ordered) continue;
    const [older, newer] = ordered;
    const already = state.proposals.some(
      (p) =>
        p.pending &&
        p.payload.kind === '主键新版过时' &&
        p.payload.oldClaimId === older.id &&
        p.payload.newClaimId === newer.id,
    );
    if (already) continue;
    if (
      out.some(
        (p) =>
          p.payload.kind === '主键新版过时' &&
          p.payload.oldClaimId === older.id &&
          p.payload.newClaimId === newer.id,
      )
    ) {
      continue;
    }
    out.push({
      id: `prop-primary-${seq}-${out.length}`,
      type: '整理',
      title: '建议：旧版过时？',
      detail: [
        `旧版：· ${older.text}`,
        `新版：· ${newer.text}`,
        '两侧都出自主键。确认后关窗旧版，关闭原因「被主键新版取代」；冲突不自动消解，关窗后派生关系才消失。',
      ].join('\n'),
      payload: { kind: '主键新版过时', oldClaimId: older.id, newClaimId: newer.id },
      pending: true,
    });
  }
  return out;
}

/** 来源时间：fetchedAt / origin.fetchedAt，否则主张 validFrom。缺一侧或相等则不可辨。 */
function orderBySourceTime(a: Claim, srcA: Source, b: Claim, srcB: Source): [Claim, Claim] | null {
  const timeA = sourceTime(srcA, a);
  const timeB = sourceTime(srcB, b);
  if (!timeA || !timeB || timeA === timeB) return null;
  return timeA < timeB ? [a, b] : [b, a];
}

function sourceTime(source: Source, claim: Claim): string | undefined {
  return source.fetchedAt ?? source.origin?.fetchedAt ?? claim.validFrom;
}

/** 文本是否出现该全名；出现位置若被更长的既有对象名盖住则不算（前缀误配）。 */
function mentionsName(objects: State['objects'], text: string, name: string): boolean {
  const longer = objects.filter((o) => o.name.length > name.length && o.name.includes(name));
  let from = 0;
  for (;;) {
    const at = text.indexOf(name, from);
    if (at < 0) return false;
    const end = at + name.length;
    const shadowed = longer.some((o) => {
      let scan = 0;
      for (;;) {
        const hostAt = text.indexOf(o.name, scan);
        if (hostAt < 0) return false;
        if (hostAt <= at && end <= hostAt + o.name.length) return true;
        scan = hostAt + 1;
      }
    });
    if (!shadowed) return true;
    from = at + 1;
  }
}

function sameIds(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((id) => set.has(id));
}

/** 'YYYY-MM-DD' → UTC 天序号；只服务 180 天阈值比较，不做历法展示。 */
function dayIndex(iso: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!match) return Number.NaN;
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) / 86_400_000;
}

export function unverifiedOf(state: State, objectId: string): Claim[] {
  return state.claims.filter((c) => c.objectId === objectId && c.unverified && c.status === '成立');
}
