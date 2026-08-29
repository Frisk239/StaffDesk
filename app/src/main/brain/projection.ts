import { deriveConflicts } from '@shared/scenario';
import type { Claim, Source, State } from '@shared/types';

/** 未绑定来源不投影：主张必须挂在已绑定到该对象的来源上（使用者陈述除外）。 */
export function projectionClaims(state: State, objectId: string): Claim[] {
  return projectionFrom(state.claims, state.sources, objectId);
}

export function projectionFrom(claims: Claim[], sources: Source[], objectId: string): Claim[] {
  const bound = new Set(
    sources.filter((s) => s.boundObjectIds.includes(objectId)).map((s) => s.id),
  );
  bound.add('user-stmt');
  return claims.filter(
    (c) => c.objectId === objectId && c.status !== '过时' && bound.has(c.sourceId),
  );
}

export function closedClaims(state: State, objectId: string): Claim[] {
  return state.claims.filter((c) => c.objectId === objectId && c.status === '过时');
}

export function isExtracting(state: State, objectId: string): boolean {
  const bound = state.sources.filter((s) => s.boundObjectIds.includes(objectId)).map((s) => s.id);
  return state.extractJobs.some((j) => bound.includes(j.sourceId) && j.status === '抽取中');
}

/** 0029：冲突派生——同对象同单值槽互斥主张，关窗后自动消失。 */
export function conflictsOf(state: State, claimId: string): Claim[] {
  const self = state.claims.find((c) => c.id === claimId);
  if (!self || self.status === '过时') return [];
  const out: Claim[] = [];
  for (const pair of deriveConflicts(state.claims, state.slotDefs)) {
    if (pair.claimIdA === claimId) {
      const b = state.claims.find((x) => x.id === pair.claimIdB);
      if (b) out.push(b);
    }
    if (pair.claimIdB === claimId) {
      const a = state.claims.find((x) => x.id === pair.claimIdA);
      if (a) out.push(a);
    }
  }
  return out.filter((c) => c.status !== '过时');
}

export { deriveConflicts };
