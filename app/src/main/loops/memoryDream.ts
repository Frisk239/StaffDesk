import { normalizeValue } from '@shared/scenario';
import type { Proposal, State } from '@shared/types';

export interface MemoryDreamResult {
  proposals: Proposal[];
  changed: boolean;
}

// 0053：文本归一化收口到 normalizeValue；全半角折叠只影响键值，不改变判重语义（行为超集安全）。
function normalizeMemoryText(text: string): string {
  return normalizeValue(text);
}

function candidateKey(proposal: Proposal): string | null {
  if (proposal.payload.kind !== '候选记忆') return null;
  return [
    proposal.payload.scope,
    proposal.payload.memoryKind,
    proposal.payload.fromObjectId ?? '',
    normalizeMemoryText(proposal.payload.text),
  ].join('\0');
}

function decidedDuplicate(proposal: Proposal): Proposal {
  return {
    ...proposal,
    pending: false,
    decision: 'reject',
    detail: `${proposal.detail}\n\n已识别为重复候选，未写入记忆。`.trim(),
  };
}

/** dream 只整理记忆候选：精确去重，绝不改 claims / sources。 */
export function dreamMemoryProposals(state: State): MemoryDreamResult {
  const existing = new Set(
    state.memories.map((memory) =>
      [
        memory.scope,
        memory.kind,
        memory.scope === '对象' ? (memory.objectId ?? '') : '',
        normalizeMemoryText(memory.text),
      ].join('\0'),
    ),
  );
  const pending = new Set<string>();
  let changed = false;

  const proposals = state.proposals.map((proposal) => {
    const key = candidateKey(proposal);
    if (!proposal.pending || !key) return proposal;
    if (existing.has(key) || pending.has(key)) {
      changed = true;
      return decidedDuplicate(proposal);
    }
    pending.add(key);
    return proposal;
  });

  return { proposals, changed };
}
