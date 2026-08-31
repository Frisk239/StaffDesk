import type { Claim, Proposal, State } from '@shared/types';
import { normalizeValue } from '@shared/scenario';

/**
 * 复核提示阈值（天）：validFrom 距今天超过该天数才提议「标过时」。
 * 只是提示，不是主张状态——人确认 accept-close 才关窗（世界已变），历史不改写（0034）。
 */
export const STALE_AFTER_DAYS = 180;

/** 抽取后若有滞留未核，提议丢弃（0037）。人确认才改账本。 */
export function proposeDropUnverified(
  state: State,
  objectId: string,
  seq: number,
): Proposal | null {
  const lingering = state.claims.filter(
    (c) => c.objectId === objectId && c.unverified && c.status === '成立',
  );
  if (lingering.length === 0) return null;
  const ids = lingering.map((c) => c.id);
  const already = state.proposals.some(
    (p) => p.pending && p.payload.kind === '丢弃未核' && sameIds(p.payload.claimIds, ids),
  );
  if (already) return null;
  return {
    id: `prop-drop-${seq}`,
    type: '整理',
    title: `建议丢弃滞留未核 ${lingering.length} 条`,
    detail: lingering.map((c) => `· ${c.text}`).join('\n'),
    payload: { kind: '丢弃未核', claimIds: ids },
    pending: true,
  };
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
