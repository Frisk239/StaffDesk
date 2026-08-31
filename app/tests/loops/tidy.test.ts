import { describe, expect, it } from 'vitest';
import { emptyUiFields } from '@shared/defaults';
import { DEFAULT_SLOT_DEFS } from '@shared/scenario';
import {
  proposeCatalogUncataloged,
  proposeDropUnverified,
  proposeMarkStale,
  proposeMergeDuplicates,
  STALE_AFTER_DAYS,
} from '../../src/main/loops/tidy';
import type { Claim, Proposal, State } from '@shared/types';

function claimOf(partial: Partial<Claim> & Pick<Claim, 'id' | 'text'>): Claim {
  return {
    objectId: 'o1',
    predicate: '后端主栈',
    status: '成立',
    unverified: false,
    sourceId: 's',
    createdAt: '2026-08-29',
    ...partial,
  };
}

function stateWith(claims: State['claims'], proposals: Proposal[] = []): State {
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
    proposals,
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

describe('合并重复提议 0053', () => {
  it('同对象同受控槽、归一化等值（大小写与全半角）的成立主张成组，保留首条去掉其余', () => {
    const out = proposeMergeDuplicates(
      stateWith([
        claimOf({ id: 'a', text: '甲组织主栈是 Go。', predicate: '后端主栈' }),
        claimOf({ id: 'b', text: '甲组织主栈是 ｇｏ。', predicate: '后端主栈' }),
        claimOf({ id: 'c', text: '甲组织主栈是 go。', predicate: '后端主栈' }),
      ]),
      'o1',
      5,
    );
    expect(out).toHaveLength(1);
    const payload = out[0]?.payload;
    expect(payload).toEqual({ kind: '合并重复', keepId: 'a', dropIds: ['b', 'c'] });
  });

  it('归一化后不同值、不同槽、未编目、过时主张都不进组；单条不成组', () => {
    const out = proposeMergeDuplicates(
      stateWith([
        claimOf({ id: 'a', text: '主栈是 Go。' }),
        claimOf({ id: 'b', text: '主栈是 Java。' }),
        claimOf({ id: 'c', text: '主栈是 Go。', predicate: '使用技术' }),
        claimOf({ id: 'd', text: '主栈是 Go。', predicate: '未编目' }),
        claimOf({ id: 'e', text: '主栈是 Go。', status: '过时' }),
        claimOf({ id: 'f', text: '办公在望京。', predicate: '办公地点' }),
      ]),
      'o1',
      5,
    );
    expect(out).toEqual([]);
  });

  it('其他对象的主张不进本对象分组', () => {
    const out = proposeMergeDuplicates(
      stateWith([
        claimOf({ id: 'a', text: '主栈是 Go。' }),
        claimOf({ id: 'b', text: '主栈是 Go。', objectId: 'o2' }),
      ]),
      'o1',
      5,
    );
    expect(out).toEqual([]);
  });

  it('pending 里已有同 keep 同 drop 集合的提议不再重复提', () => {
    const proposals: Proposal[] = [
      {
        id: 'prop-merge-1-0',
        type: '整理',
        title: '旧',
        detail: '',
        payload: { kind: '合并重复', keepId: 'a', dropIds: ['b'] },
        pending: true,
      },
    ];
    const out = proposeMergeDuplicates(
      stateWith(
        [claimOf({ id: 'a', text: '主栈是 Go。' }), claimOf({ id: 'b', text: '主栈是 go。' })],
        proposals,
      ),
      'o1',
      7,
    );
    expect(out).toEqual([]);
  });

  it('已决定（非 pending）的旧提议不挡新提议', () => {
    const proposals: Proposal[] = [
      {
        id: 'prop-merge-1-0',
        type: '整理',
        title: '旧',
        detail: '',
        payload: { kind: '合并重复', keepId: 'a', dropIds: ['b'] },
        pending: false,
        decision: 'reject',
      },
    ];
    const out = proposeMergeDuplicates(
      stateWith(
        [claimOf({ id: 'a', text: '主栈是 Go。' }), claimOf({ id: 'b', text: '主栈是 go。' })],
        proposals,
      ),
      'o1',
      7,
    );
    expect(out).toHaveLength(1);
  });

  it('无重复时返回空数组', () => {
    expect(proposeMergeDuplicates(stateWith([]), 'o1', 1)).toEqual([]);
  });
});

describe('标过时提议', () => {
  it('validFrom 距 today 超过阈值天数才提，每条一卡', () => {
    const today = '2026-08-31';
    const old = new Date(Date.UTC(2026, 7, 31) - (STALE_AFTER_DAYS + 1) * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const out = proposeMarkStale(
      stateWith([claimOf({ id: 'a', text: '旧主张。', validFrom: old })]),
      'o1',
      4,
      today,
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.payload).toEqual({ kind: '标过时', claimId: 'a' });
  });

  it('恰好等于阈值天数不提（超过才提）', () => {
    const today = '2026-08-31';
    const edge = new Date(Date.UTC(2026, 7, 31) - STALE_AFTER_DAYS * 86_400_000)
      .toISOString()
      .slice(0, 10);
    expect(
      proposeMarkStale(
        stateWith([claimOf({ id: 'a', text: '旧主张。', validFrom: edge })]),
        'o1',
        4,
        today,
      ),
    ).toEqual([]);
  });

  it('无 validFrom、已过时、别的对象都不提', () => {
    const today = '2026-08-31';
    const old = '2025-01-01';
    expect(
      proposeMarkStale(
        stateWith([
          claimOf({ id: 'a', text: '无起点。' }),
          claimOf({ id: 'b', text: '已关窗。', validFrom: old, status: '过时' }),
          claimOf({ id: 'c', text: '别家。', validFrom: old, objectId: 'o2' }),
        ]),
        'o1',
        4,
        today,
      ),
    ).toEqual([]);
  });

  it('pending 同主张的旧提议去重', () => {
    const today = '2026-08-31';
    const proposals: Proposal[] = [
      {
        id: 'prop-stale-1-0',
        type: '整理',
        title: '旧',
        detail: '',
        payload: { kind: '标过时', claimId: 'a' },
        pending: true,
      },
    ];
    expect(
      proposeMarkStale(
        stateWith([claimOf({ id: 'a', text: '旧主张。', validFrom: '2025-01-01' })], proposals),
        'o1',
        4,
        today,
      ),
    ).toEqual([]);
  });
});

describe('未编目编目提议', () => {
  it('收集成立中的未编目残留主张，每条一卡且不带预选槽', () => {
    const out = proposeCatalogUncataloged(
      stateWith([
        claimOf({ id: 'a', text: '内部在推进平台化。', predicate: '未编目' }),
        claimOf({ id: 'b', text: '另有一条。', predicate: '未编目', unverified: true }),
        claimOf({ id: 'c', text: '已关窗的未编目。', predicate: '未编目', status: '过时' }),
        claimOf({ id: 'd', text: '已在槽里。' }),
      ]),
      'o1',
      6,
    );
    expect(out.map((p) => p.payload)).toEqual([
      { kind: '整理', claimId: 'a' },
      { kind: '整理', claimId: 'b' },
    ]);
  });

  it('pending 已有同主张的整理提议不再重复提', () => {
    const proposals: Proposal[] = [
      {
        id: 'prop-uncat-1-0',
        type: '整理',
        title: '旧',
        detail: '',
        payload: { kind: '整理', claimId: 'a' },
        pending: true,
      },
    ];
    expect(
      proposeCatalogUncataloged(
        stateWith(
          [claimOf({ id: 'a', text: '内部在推进平台化。', predicate: '未编目' })],
          proposals,
        ),
        'o1',
        6,
      ),
    ).toEqual([]);
  });

  it('无残留返回空数组', () => {
    expect(proposeCatalogUncataloged(stateWith([]), 'o1', 1)).toEqual([]);
  });
});
