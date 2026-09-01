import { describe, expect, it } from 'vitest';
import { emptyUiFields } from '@shared/defaults';
import { builtinScenarioTemplates, DEFAULT_SLOT_DEFS } from '@shared/scenario';
import {
  proposeCatalogUncataloged,
  proposeDropUnverified,
  proposeMarkStale,
  proposeMergeDuplicates,
  proposeNewObjects,
  proposeRelations,
  proposeSupersedeByPrimary,
  STALE_AFTER_DAYS,
} from '../../src/main/loops/tidy';
import type { Claim, DeskObject, Proposal, Source, State } from '@shared/types';

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

function objectOf(
  partial: Partial<DeskObject> & Pick<DeskObject, 'id' | 'kind' | 'name'>,
): DeskObject {
  return { relationIds: [], workspaceId: 'ws', ...partial };
}

function stateWith(
  claims: State['claims'],
  proposals: Proposal[] = [],
  objects: DeskObject[] = [objectOf({ id: 'o1', kind: '组织', name: '甲' })],
  sources: Source[] = [],
): State {
  return {
    ...emptyUiFields(),
    workspaces: [{ id: 'ws', name: '区', scenario: '求职面试' }],
    currentWorkspaceId: 'ws',
    objects,
    sources,
    claims,
    slotDefs: DEFAULT_SLOT_DEFS,
    // 0058：场景模板是账本数据——用种子基线构造（断言依赖内置 spec 的场景必须带内置模板）。
    scenarioTemplates: builtinScenarioTemplates(),
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

describe('建新对象提议 0052', () => {
  it('未知名去重后每名一卡，payload 挂抽取语境对象', () => {
    const out = proposeNewObjects(stateWith([]), 'o1', 8, ['乙公司', '乙公司', ' 丙团队 ']);
    expect(out).toHaveLength(2);
    expect(out[0]?.payload).toEqual({ kind: '建对象', name: '乙公司', fromObjectId: 'o1' });
    expect(out[1]?.payload).toEqual({ kind: '建对象', name: '丙团队', fromObjectId: 'o1' });
    expect(out.every((p) => p.type === '整理' && p.pending)).toBe(true);
  });

  it('与既有对象撞名（含已归档）不提', () => {
    const state = stateWith(
      [],
      [],
      [
        objectOf({ id: 'o1', kind: '组织', name: '甲' }),
        objectOf({ id: 'o2', kind: '人', name: '乙', archived: true }),
      ],
    );
    expect(proposeNewObjects(state, 'o1', 8, ['甲', '乙', '丙'])).toHaveLength(1);
  });

  it('pending 已有同名提议不再重复提；已决定的不挡', () => {
    const proposals: Proposal[] = [
      {
        id: 'prop-newobj-1-0',
        type: '整理',
        title: '旧',
        detail: '',
        payload: { kind: '建对象', name: '乙公司', fromObjectId: 'o1' },
        pending: true,
      },
    ];
    expect(proposeNewObjects(stateWith([], proposals), 'o1', 8, ['乙公司'])).toEqual([]);
    proposals[0]!.pending = false;
    proposals[0]!.decision = 'reject';
    expect(proposeNewObjects(stateWith([], proposals), 'o1', 8, ['乙公司'])).toHaveLength(1);
  });

  it('无名单或全空名返回空数组', () => {
    expect(proposeNewObjects(stateWith([]), 'o1', 8)).toEqual([]);
    expect(proposeNewObjects(stateWith([]), 'o1', 8, [])).toEqual([]);
    expect(proposeNewObjects(stateWith([]), 'o1', 8, ['  '])).toEqual([]);
  });
});

describe('补关系提议', () => {
  const objects = (): DeskObject[] => [
    objectOf({ id: 'o1', kind: '组织', name: '甲组织' }),
    objectOf({ id: 'o2', kind: '人', name: '乙同事' }),
    objectOf({ id: 'o3', kind: '项目', name: '丙项目' }),
    objectOf({ id: 'o4', kind: '组织', name: '丁组织' }),
    objectOf({ id: 'o5', kind: '人', name: '戌' }),
    objectOf({ id: 'o6', kind: '人', name: '己同事', archived: true }),
  ];

  it('成立主张文本包含另一对象全名 → 每对一卡，payload 带两端', () => {
    const out = proposeRelations(
      stateWith([claimOf({ id: 'c1', text: '乙同事在甲组织负责丙项目的迁移。' })], [], objects()),
      'o1',
      6,
    );
    expect(out.map((p) => p.payload)).toEqual([
      { kind: '建关系', objectId: 'o1', targetId: 'o2' },
      { kind: '建关系', objectId: 'o1', targetId: 'o3' },
    ]);
    expect(out.every((p) => p.type === '整理' && p.pending)).toBe(true);
  });

  it('同种类不提、单字名不提、已归档不提、已有双边不提、过时主张不提', () => {
    const linked = objects().map((o) =>
      o.id === 'o1'
        ? { ...o, relationIds: ['o2'] }
        : o.id === 'o2'
          ? { ...o, relationIds: ['o1'] }
          : o,
    );
    const out = proposeRelations(
      stateWith(
        [
          claimOf({ id: 'c1', text: '丁组织和甲组织同场。' }),
          claimOf({ id: 'c2', text: '戌也在场。' }),
          claimOf({ id: 'c3', text: '己同事也在场。' }),
          claimOf({ id: 'c4', text: '乙同事早已离开。', status: '过时' }),
        ],
        [],
        linked,
      ),
      'o1',
      6,
    );
    expect(out).toEqual([]);
  });

  it('全名匹配防前缀误配：出现「阿里巴巴」不当作提到了「阿里」', () => {
    const state = stateWith(
      [claimOf({ id: 'c1', text: '甲组织与阿里巴巴签了约。' })],
      [],
      [
        objectOf({ id: 'o1', kind: '组织', name: '甲组织' }),
        objectOf({ id: 'o2', kind: '人', name: '阿里' }),
        objectOf({ id: 'o3', kind: '项目', name: '阿里巴巴' }),
      ],
    );
    expect(proposeRelations(state, 'o1', 6).map((p) => p.payload)).toEqual([
      { kind: '建关系', objectId: 'o1', targetId: 'o3' },
    ]);
  });

  it('pending 里已有同对（含反向）提议不再重复提', () => {
    const proposals: Proposal[] = [
      {
        id: 'prop-rel-1-0',
        type: '整理',
        title: '旧',
        detail: '',
        payload: { kind: '建关系', objectId: 'o2', targetId: 'o1' },
        pending: true,
      },
    ];
    expect(
      proposeRelations(
        stateWith([claimOf({ id: 'c1', text: '乙同事在甲组织任职。' })], proposals, objects()),
        'o1',
        6,
      ),
    ).toEqual([]);
  });

  it('锚对象不存在或已归档时不出提议；只扫本对象的成立主张', () => {
    const base = objects();
    expect(proposeRelations(stateWith([]), 'missing', 6)).toEqual([]);
    const archivedAnchor = base.map((o) => (o.id === 'o1' ? { ...o, archived: true } : o));
    expect(
      proposeRelations(
        stateWith([claimOf({ id: 'c1', text: '乙同事在场。' })], [], archivedAnchor),
        'o1',
        6,
      ),
    ).toEqual([]);
    expect(
      proposeRelations(
        stateWith([claimOf({ id: 'c1', text: '乙同事在场。', objectId: 'o4' })], [], objects()),
        'o1',
        6,
      ),
    ).toEqual([]);
  });
});

describe('主键新版过时提议 0062', () => {
  const sources: Source[] = [
    {
      id: 's-old',
      title: '旧官网',
      body: '主栈是 Go',
      path: '手给',
      boundObjectIds: ['o1'],
      bindingRoles: { o1: '主键' },
      fetchedAt: '2024-01-01T00:00:00.000Z',
    },
    {
      id: 's-new',
      title: '新官网',
      body: '主栈是 Rust',
      path: '手给',
      boundObjectIds: ['o1'],
      bindingRoles: { o1: '主键' },
      fetchedAt: '2026-06-01T00:00:00.000Z',
    },
    {
      id: 's-press',
      title: '媒体',
      body: '主栈是 Java',
      path: '调研',
      boundObjectIds: ['o1'],
      fetchedAt: '2026-08-01T00:00:00.000Z',
    },
  ];

  it('双方都是主键且来源时间可辨时提议关窗旧版', () => {
    const out = proposeSupersedeByPrimary(
      stateWith(
        [
          claimOf({
            id: 'c-old',
            text: '主栈是 Go',
            sourceId: 's-old',
            validFrom: '2024-01-01',
          }),
          claimOf({
            id: 'c-new',
            text: '主栈是 Rust',
            sourceId: 's-new',
            validFrom: '2026-06-01',
          }),
        ],
        [],
        [objectOf({ id: 'o1', kind: '组织', name: '甲' })],
        sources,
      ),
      'o1',
      9,
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.title).toBe('建议：旧版过时？');
    expect(out[0]?.payload).toEqual({
      kind: '主键新版过时',
      oldClaimId: 'c-old',
      newClaimId: 'c-new',
    });
  });

  it('转述一侧不提议；时间不可辨不提议', () => {
    const objects = [objectOf({ id: 'o1', kind: '组织', name: '甲' })];
    expect(
      proposeSupersedeByPrimary(
        stateWith(
          [
            claimOf({ id: 'c-old', text: '主栈是 Go', sourceId: 's-old' }),
            claimOf({ id: 'c-press', text: '主栈是 Java', sourceId: 's-press' }),
          ],
          [],
          objects,
          sources,
        ),
        'o1',
        9,
      ),
    ).toEqual([]);
    const noTime: Source[] = sources.map((s) => ({
      ...s,
      fetchedAt: undefined,
      origin: undefined,
    }));
    expect(
      proposeSupersedeByPrimary(
        stateWith(
          [
            claimOf({ id: 'c-old', text: '主栈是 Go', sourceId: 's-old' }),
            claimOf({ id: 'c-new', text: '主栈是 Rust', sourceId: 's-new' }),
          ],
          [],
          objects,
          noTime,
        ),
        'o1',
        9,
      ),
    ).toEqual([]);
  });
});
