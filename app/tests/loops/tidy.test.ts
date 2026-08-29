import { describe, expect, it } from 'vitest';
import { emptyUiFields } from '@shared/defaults';
import { DEFAULT_SLOT_DEFS } from '@shared/scenario';
import { proposeDropUnverified } from '../../src/main/loops/tidy';
import type { State } from '@shared/types';

function stateWith(claims: State['claims']): State {
  return {
    ...emptyUiFields(),
    workspaces: [{ id: 'ws', name: '区', scenario: '求职面试' }],
    currentWorkspaceId: 'ws',
    objects: [{ id: 'o1', kind: '组织', name: '甲', relationIds: [], workspaceId: 'ws' }],
    sources: [],
    claims,
    slotDefs: DEFAULT_SLOT_DEFS,
    briefs: [],
    memories: [],
    inbox: [],
    proposals: [],
    tasks: [],
    taskAudits: [],
    chatByObject: {},
    seq: 3,
    onboardingDone: true,
  };
}

describe('整理提议 0037', () => {
  it('有滞留未核时提议丢弃', () => {
    const p = proposeDropUnverified(
      stateWith([
        {
          id: 'c1',
          objectId: 'o1',
          predicate: '未编目',
          text: '平台化',
          status: '成立',
          unverified: true,
          sourceId: 's',
          createdAt: '2026-08-29',
        },
      ]),
      'o1',
      9,
    );
    expect(p?.payload.kind).toBe('丢弃未核');
    if (p?.payload.kind === '丢弃未核') expect(p.payload.claimIds).toEqual(['c1']);
  });

  it('没有未核不提议', () => {
    expect(proposeDropUnverified(stateWith([]), 'o1', 1)).toBeNull();
  });
});
