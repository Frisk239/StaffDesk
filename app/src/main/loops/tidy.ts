import type { Claim, Proposal, State } from '@shared/types';

/** 抽取后若有滞留未核，提议丢弃（0037）。人确认才改账本。 */
export function proposeDropUnverified(state: State, objectId: string, seq: number): Proposal | null {
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

function sameIds(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((id) => set.has(id));
}

export function unverifiedOf(state: State, objectId: string): Claim[] {
  return state.claims.filter((c) => c.objectId === objectId && c.unverified && c.status === '成立');
}
