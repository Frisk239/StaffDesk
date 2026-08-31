import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openBrain, type Brain } from '../../src/main/brain';
import type { Claim, Proposal } from '../../src/shared/types';

const dirs: string[] = [];
const brains: Brain[] = [];

function tmpBrain(): string {
  const dir = mkdtempSync(join(tmpdir(), 'staffdesk-tidy-decide-'));
  dirs.push(dir);
  return join(dir, 'brain.db');
}

function track(brain: Brain): Brain {
  brains.push(brain);
  return brain;
}

afterEach(() => {
  while (brains.length) {
    try {
      brains.pop()?.close();
    } catch {
      /* closed */
    }
  }
  while (dirs.length) {
    const dir = dirs.pop();
    if (dir) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* lock */
      }
    }
  }
});

function injectedClaim(
  id: string,
  sourceId: string,
  objectId: string,
  partial: Partial<Claim> & Pick<Claim, 'predicate' | 'text'>,
): Claim {
  return {
    id,
    objectId,
    status: '成立',
    unverified: true,
    validFrom: '2026-08-29',
    sourceId,
    span: partial.span ?? partial.text,
    createdAt: '2026-08-29',
    ...partial,
  };
}

interface Rig {
  brain: Brain;
  objectId: string;
  sourceId: string;
}

/** 建区、建组织、绑来源后按注入主张完成抽取（EXTRACT_DONE 直落账，tidy 钩子随之触发）。 */
function rigWith(
  claims: (sourceId: string, objectId: string) => Claim[],
  unknownObjectNames?: string[],
): Rig {
  const brain = track(openBrain(tmpBrain()));
  brain.dispatch({ type: 'ADD_WORKSPACE', name: '整理验收区', scenario: '求职面试' });
  brain.dispatch({ type: 'ADD_OBJECT', kind: '组织', name: '甲组织' });
  const objectId = brain.snapshot().objects[0]!.id;
  brain.dispatch({ type: 'ADD_SOURCE', title: '材料', body: '甲组织的材料。' });
  const sourceId = brain.snapshot().sources.find((s) => !s.virtual)!.id;
  brain.dispatch({ type: 'BIND_CONFIRMED', sourceId, objectIds: [objectId] });
  brain.dispatch({
    type: 'EXTRACT_DONE',
    sourceId,
    claims: claims(sourceId, objectId),
    unknownObjectNames,
  });
  return { brain, objectId, sourceId };
}

function undoCard(brain: Brain, objectId: string, kind: string) {
  return (brain.snapshot().chatByObject[objectId] ?? []).find((m) => m.card?.undo?.kind === kind);
}

function insertProposal(brain: Brain, proposal: Proposal): void {
  brain.db
    .prepare(
      `INSERT INTO proposals (id, type, payload, pending, decision, created_at, title, detail)
       VALUES (?, ?, ?, 1, NULL, ?, ?, '')`,
    )
    .run(
      proposal.id,
      proposal.type,
      JSON.stringify(proposal.payload),
      new Date().toISOString(),
      proposal.title,
    );
}

describe('整理三提议器决策', () => {
  it('抽取落账自动生成四类提议钩子：合并重复 + 未编目编目同场出现', () => {
    const { brain } = rigWith((sourceId, objectId) => [
      injectedClaim('cl-keep', sourceId, objectId, {
        predicate: '使用技术',
        text: '甲组织主栈是 Go。',
        span: '甲组织主栈是 Go',
      }),
      injectedClaim('cl-dup', sourceId, objectId, {
        predicate: '使用技术',
        text: '甲组织主栈是 go。',
        span: '甲组织主栈是 go（另一段）',
      }),
      injectedClaim('cl-uncat', sourceId, objectId, {
        predicate: '未编目',
        text: '内部在推进平台化。',
        span: '内部在推进平台化',
      }),
    ]);
    const kinds = brain
      .snapshot()
      .proposals.filter((p) => p.pending)
      .map((p) => p.payload.kind);
    expect(kinds).toContain('丢弃未核');
    expect(kinds).toContain('合并重复');
    expect(kinds).toContain('整理');
  });

  it('合并重复 accept-merge 删其余留首条，撤销可整批恢复', () => {
    const { brain, objectId } = rigWith((sourceId, oid) => [
      injectedClaim('cl-keep', sourceId, oid, {
        predicate: '使用技术',
        text: '甲组织主栈是 Go。',
        span: '甲组织主栈是 Go',
      }),
      injectedClaim('cl-dup', sourceId, oid, {
        predicate: '使用技术',
        text: '甲组织主栈是 go。',
        span: '甲组织主栈是 go（另一段）',
      }),
      injectedClaim('cl-other', sourceId, oid, {
        predicate: '在招岗位',
        text: '甲组织在招后端。',
        span: '甲组织在招后端',
      }),
    ]);
    const merge = brain
      .snapshot()
      .proposals.find((p) => p.pending && p.payload.kind === '合并重复');
    if (!merge || merge.payload.kind !== '合并重复') throw new Error('合并提议未生成');
    expect(merge.payload).toEqual({ kind: '合并重复', keepId: 'cl-keep', dropIds: ['cl-dup'] });

    brain.dispatch({ type: 'PROPOSAL_DECIDE', proposalId: merge.id, decision: 'accept-merge' });
    const st = brain.snapshot();
    expect(st.claims.map((c) => c.id).sort()).toEqual(['cl-keep', 'cl-other']);
    expect(st.proposals.find((p) => p.id === merge.id)?.decision).toBe('accept-merge');

    const card = undoCard(brain, objectId, '整理丢弃');
    if (!card) throw new Error('合并撤销卡未生成');
    brain.dispatch({ type: 'UNDO_RESULT', objectId, messageId: card.id });
    expect(
      brain
        .snapshot()
        .claims.map((c) => c.id)
        .sort(),
    ).toEqual(['cl-dup', 'cl-keep', 'cl-other']);
  });

  it('合并重复驳回则不动账本，非 accept-merge 一律落驳回', () => {
    const { brain } = rigWith((sourceId, oid) => [
      injectedClaim('cl-keep', sourceId, oid, {
        predicate: '使用技术',
        text: '甲组织主栈是 Go。',
        span: '甲组织主栈是 Go',
      }),
      injectedClaim('cl-dup', sourceId, oid, {
        predicate: '使用技术',
        text: '甲组织主栈是 go。',
        span: '甲组织主栈是 go（另一段）',
      }),
    ]);
    const merge = brain
      .snapshot()
      .proposals.find((p) => p.pending && p.payload.kind === '合并重复');
    if (!merge) throw new Error('合并提议未生成');
    brain.dispatch({ type: 'PROPOSAL_DECIDE', proposalId: merge.id, decision: 'accept-drop' });
    const st = brain.snapshot();
    expect(st.claims).toHaveLength(2);
    expect(st.proposals.find((p) => p.id === merge.id)?.decision).toBe('reject');
  });

  it('标过时 accept-close 关窗（世界已变），撤销重开且不改写历史', () => {
    const { brain, objectId } = rigWith((sourceId, oid) => [
      injectedClaim('cl-stale', sourceId, oid, {
        predicate: '后端主栈',
        text: '甲组织主栈是 Go。',
        span: '甲组织主栈是 Go',
        validFrom: '2025-01-01',
      }),
    ]);
    const stale = brain.snapshot().proposals.find((p) => p.pending && p.payload.kind === '标过时');
    if (!stale || stale.payload.kind !== '标过时') throw new Error('标过时提议未生成');
    expect(stale.payload.claimId).toBe('cl-stale');

    brain.dispatch({ type: 'PROPOSAL_DECIDE', proposalId: stale.id, decision: 'accept-close' });
    const closed = brain.snapshot().claims.find((c) => c.id === 'cl-stale');
    expect(closed?.status).toBe('过时');
    expect(closed?.closeReason).toBe('世界已变');
    expect(closed?.validTo).toBe(new Date().toISOString().slice(0, 10));
    expect(closed?.validFrom).toBe('2025-01-01'); // 历史起点不改写
    expect(brain.snapshot().proposals.find((p) => p.id === stale.id)?.decision).toBe(
      'accept-close',
    );

    const card = undoCard(brain, objectId, '关窗');
    if (!card) throw new Error('关窗撤销卡未生成');
    brain.dispatch({ type: 'UNDO_RESULT', objectId, messageId: card.id });
    const reopened = brain.snapshot().claims.find((c) => c.id === 'cl-stale');
    expect(reopened?.status).toBe('成立');
    expect(reopened?.validTo).toBeUndefined();
    expect(reopened?.closeReason).toBeUndefined();
    expect(reopened?.validFrom).toBe('2025-01-01');
  });

  it('未编目编目：无选择被拒、自开槽被拒、选受控槽并入成功', () => {
    const { brain } = rigWith((sourceId, oid) => [
      injectedClaim('cl-uncat', sourceId, oid, {
        predicate: '未编目',
        text: '内部在推进平台化。',
        span: '内部在推进平台化',
      }),
    ]);
    const uncat = brain.snapshot().proposals.find((p) => p.pending && p.payload.kind === '整理');
    if (!uncat || uncat.payload.kind !== '整理') throw new Error('编目提议未生成');
    expect(uncat.payload.targetPredicate).toBeUndefined();

    brain.dispatch({ type: 'PROPOSAL_DECIDE', proposalId: uncat.id, decision: 'accept-merge' });
    expect(brain.snapshot().toast?.text).toBe('请先选择要并入的槽');
    expect(brain.snapshot().proposals.find((p) => p.id === uncat.id)?.pending).toBe(true);

    brain.dispatch({
      type: 'PROPOSAL_DECIDE',
      proposalId: uncat.id,
      decision: 'accept-merge',
      targetPredicate: '自家新槽',
    });
    expect(brain.snapshot().toast?.text).toBe('不许自开谓词槽，只能并入已有槽');
    expect(brain.snapshot().proposals.find((p) => p.id === uncat.id)?.pending).toBe(true);

    brain.dispatch({
      type: 'PROPOSAL_DECIDE',
      proposalId: uncat.id,
      decision: 'accept-merge',
      targetPredicate: '使用技术',
    });
    const st = brain.snapshot();
    expect(st.claims.find((c) => c.id === 'cl-uncat')?.predicate).toBe('使用技术');
    expect(st.proposals.find((p) => p.id === uncat.id)?.decision).toBe('accept-merge');
    expect(st.toast?.text).toBe('已并入「使用技术」');
  });

  it('决策载荷的槽优先于 payload 预选槽', () => {
    const { brain } = rigWith((sourceId, oid) => [
      injectedClaim('cl-uncat', sourceId, oid, {
        predicate: '未编目',
        text: '内部在推进平台化。',
        span: '内部在推进平台化',
      }),
    ]);
    insertProposal(brain, {
      id: 'prop-tidy-preset',
      type: '整理',
      title: '预选槽编目',
      detail: '并入使用技术',
      payload: { kind: '整理', claimId: 'cl-uncat', targetPredicate: '使用技术' },
      pending: true,
    });
    brain.dispatch({
      type: 'PROPOSAL_DECIDE',
      proposalId: 'prop-tidy-preset',
      decision: 'accept-merge',
      targetPredicate: '在招岗位',
    });
    expect(brain.snapshot().claims.find((c) => c.id === 'cl-uncat')?.predicate).toBe('在招岗位');
  });

  it('登记面回归：DELETE_OBJECT 清理合并/标过时/编目三类新提议', () => {
    const { brain, objectId } = rigWith((sourceId, oid) => [
      injectedClaim('cl-keep', sourceId, oid, {
        predicate: '使用技术',
        text: '甲组织主栈是 Go。',
        span: '甲组织主栈是 Go',
      }),
      injectedClaim('cl-dup', sourceId, oid, {
        predicate: '使用技术',
        text: '甲组织主栈是 go。',
        span: '甲组织主栈是 go（另一段）',
      }),
      injectedClaim('cl-stale', sourceId, oid, {
        predicate: '后端主栈',
        text: '甲组织主栈是 Go。',
        span: '甲组织主栈是 Go（旧）',
        validFrom: '2025-01-01',
      }),
      injectedClaim('cl-uncat', sourceId, oid, {
        predicate: '未编目',
        text: '内部在推进平台化。',
        span: '内部在推进平台化',
      }),
    ]);
    const kinds = brain
      .snapshot()
      .proposals.filter((p) => p.pending)
      .map((p) => p.payload.kind);
    for (const expected of ['合并重复', '标过时', '整理', '丢弃未核']) {
      expect(kinds).toContain(expected);
    }
    brain.dispatch({ type: 'ARCHIVE_OBJECT', id: objectId });
    brain.dispatch({ type: 'DELETE_OBJECT', id: objectId });
    expect(brain.snapshot().proposals.filter((p) => p.pending)).toHaveLength(0);
  });
});

describe('建新对象提议 0052', () => {
  it('抽取带未知名即产建对象提议；确认按人选种类建立且不抢视图、免 undo、不自动绑定', () => {
    const { brain, objectId, sourceId } = rigWith(
      (sid, oid) => [
        injectedClaim('cl-any', sid, oid, {
          predicate: '使用技术',
          text: '甲组织主栈是 Go。',
          span: '甲组织主栈是 Go',
        }),
      ],
      ['乙组织'],
    );
    const prop = brain.snapshot().proposals.find((p) => p.pending && p.payload.kind === '建对象');
    if (!prop || prop.payload.kind !== '建对象') throw new Error('建对象提议未生成');
    expect(prop.type).toBe('整理');
    expect(prop.payload).toEqual({ kind: '建对象', name: '乙组织', fromObjectId: objectId });

    brain.dispatch({
      type: 'PROPOSAL_DECIDE',
      proposalId: prop.id,
      decision: 'accept-merge',
      objectKind: '项目',
    });
    const st = brain.snapshot();
    const created = st.objects.find((o) => o.name === '乙组织');
    expect(created?.kind).toBe('项目');
    expect(created?.workspaceId).toBe(st.currentWorkspaceId);
    expect(created?.relationIds).toEqual([]);
    // 不抢视图：还停在抽取语境对象页，没有被新建对象带走；来源也没被自动绑定。
    expect(st.view).toEqual({ kind: 'object', objectId });
    expect(st.sources.find((s) => s.id === sourceId)?.boundObjectIds).toEqual([objectId]);
    expect(st.proposals.find((p) => p.id === prop.id)?.decision).toBe('accept-merge');
    expect(st.toast?.text).toBe('已建立对象「乙组织」');
    const cards = (st.chatByObject[objectId] ?? []).filter((m) => m.card?.result === '整理');
    expect(cards).toHaveLength(1);
    expect(cards[0]?.card?.undo).toBeUndefined(); // 免 undo：对象可归档回退，不进补偿载荷
  });

  it('未选种类被拒；重复名确认被拒且提议保持待确认', () => {
    const { brain, objectId } = rigWith(() => [], ['乙组织']);
    const prop = brain.snapshot().proposals.find((p) => p.pending && p.payload.kind === '建对象');
    if (!prop || prop.payload.kind !== '建对象') throw new Error('建对象提议未生成');

    brain.dispatch({ type: 'PROPOSAL_DECIDE', proposalId: prop.id, decision: 'accept-merge' });
    expect(brain.snapshot().toast?.text).toBe('请先选择对象种类');
    expect(brain.snapshot().proposals.find((p) => p.id === prop.id)?.pending).toBe(true);

    insertProposal(brain, {
      id: 'prop-newobj-dup',
      type: '整理',
      title: '撞名提议',
      detail: '',
      payload: { kind: '建对象', name: '甲组织', fromObjectId: objectId },
      pending: true,
    });
    const before = brain.snapshot().objects.length;
    brain.dispatch({
      type: 'PROPOSAL_DECIDE',
      proposalId: 'prop-newobj-dup',
      decision: 'accept-merge',
      objectKind: '组织',
    });
    expect(brain.snapshot().toast?.text).toBe('已存在同名对象，未建立');
    expect(brain.snapshot().objects).toHaveLength(before);
    expect(brain.snapshot().proposals.find((p) => p.id === 'prop-newobj-dup')?.pending).toBe(true);
  });

  it('驳回不建对象；删除挂靠对象时登记面清掉建对象提议', () => {
    const { brain, objectId } = rigWith(() => [], ['乙组织']);
    const prop = brain.snapshot().proposals.find((p) => p.pending && p.payload.kind === '建对象');
    if (!prop) throw new Error('建对象提议未生成');
    brain.dispatch({ type: 'PROPOSAL_DECIDE', proposalId: prop.id, decision: 'reject' });
    const st = brain.snapshot();
    expect(st.objects.some((o) => o.name === '乙组织')).toBe(false);
    expect(st.proposals.find((p) => p.id === prop.id)?.decision).toBe('reject');

    insertProposal(brain, {
      id: 'prop-newobj-keep',
      type: '整理',
      title: '待清提议',
      detail: '',
      payload: { kind: '建对象', name: '丙公司', fromObjectId: objectId },
      pending: true,
    });
    brain.dispatch({ type: 'ARCHIVE_OBJECT', id: objectId });
    brain.dispatch({ type: 'DELETE_OBJECT', id: objectId });
    expect(brain.snapshot().proposals.filter((p) => p.id === 'prop-newobj-keep')).toHaveLength(0);
  });

  it('早退分支（零主张落账）同样产建对象提议', () => {
    const { brain } = rigWith(() => [], ['丙公司']);
    const st = brain.snapshot();
    const prop = st.proposals.find((p) => p.pending && p.payload.kind === '建对象');
    if (!prop || prop.payload.kind !== '建对象') throw new Error('早退分支未产建对象提议');
    expect(prop.payload.name).toBe('丙公司');
    // 零主张：没有落任何账本主张，也没有其他整理提议混入。
    expect(st.claims).toHaveLength(0);
    expect(st.proposals.filter((p) => p.pending && p.payload.kind !== '建对象')).toHaveLength(0);
  });
});

describe('补关系提议决策', () => {
  function relationRig(): { brain: Brain; orgId: string; personId: string } {
    const brain = track(openBrain(tmpBrain()));
    brain.dispatch({ type: 'ADD_WORKSPACE', name: '关系验收区', scenario: '求职面试' });
    brain.dispatch({ type: 'ADD_OBJECT', kind: '组织', name: '甲组织' });
    brain.dispatch({ type: 'ADD_OBJECT', kind: '人', name: '乙同事' });
    const objects = brain.snapshot().objects;
    const orgId = objects.find((o) => o.name === '甲组织')!.id;
    const personId = objects.find((o) => o.name === '乙同事')!.id;
    brain.dispatch({ type: 'ADD_SOURCE', title: '材料', body: '乙同事在甲组织任职。' });
    const sourceId = brain.snapshot().sources.find((s) => !s.virtual)!.id;
    brain.dispatch({ type: 'BIND_CONFIRMED', sourceId, objectIds: [orgId] });
    brain.dispatch({
      type: 'EXTRACT_DONE',
      sourceId,
      claims: [
        injectedClaim('cl-rel', sourceId, orgId, {
          predicate: '未编目',
          text: '乙同事在甲组织任职。',
          span: '乙同事在甲组织任职',
        }),
      ],
    });
    return { brain, orgId, personId };
  }

  it('抽取落账自动提议建关系；确认后双侧落边、免 undo', () => {
    const { brain, orgId, personId } = relationRig();
    const prop = brain.snapshot().proposals.find((p) => p.pending && p.payload.kind === '建关系');
    if (!prop || prop.payload.kind !== '建关系') throw new Error('建关系提议未生成');
    expect(prop.payload).toEqual({ kind: '建关系', objectId: orgId, targetId: personId });
    expect(prop.type).toBe('整理');

    brain.dispatch({ type: 'PROPOSAL_DECIDE', proposalId: prop.id, decision: 'accept-merge' });
    const st = brain.snapshot();
    expect(st.objects.find((o) => o.id === orgId)?.relationIds).toEqual([personId]);
    expect(st.objects.find((o) => o.id === personId)?.relationIds).toEqual([orgId]);
    expect(st.proposals.find((p) => p.id === prop.id)?.decision).toBe('accept-merge');
    expect(st.toast?.text).toBe('已建立「甲组织」与「乙同事」的关系');
    const card = (st.chatByObject[orgId] ?? []).find(
      (m) => m.card?.result === '整理' && m.card.undo === undefined,
    );
    expect(card?.text).toContain('已建立「甲组织」与「乙同事」的关系');
  });

  it('对端归档后确认被拒：不动边、提议保持待确认', () => {
    const { brain, orgId, personId } = relationRig();
    const prop = brain.snapshot().proposals.find((p) => p.pending && p.payload.kind === '建关系');
    if (!prop) throw new Error('建关系提议未生成');
    brain.dispatch({ type: 'ARCHIVE_OBJECT', id: personId });
    brain.dispatch({ type: 'PROPOSAL_DECIDE', proposalId: prop.id, decision: 'accept-merge' });
    const st = brain.snapshot();
    expect(st.toast?.text).toBe('已归档对象不能建关系');
    expect(st.objects.find((o) => o.id === orgId)?.relationIds).toEqual([]);
    expect(st.objects.find((o) => o.id === personId)?.relationIds).toEqual([]);
    expect(st.proposals.find((p) => p.id === prop.id)?.pending).toBe(true);
  });

  it('驳回不动账本', () => {
    const { brain, orgId, personId } = relationRig();
    const prop = brain.snapshot().proposals.find((p) => p.pending && p.payload.kind === '建关系');
    if (!prop) throw new Error('建关系提议未生成');
    brain.dispatch({ type: 'PROPOSAL_DECIDE', proposalId: prop.id, decision: 'reject' });
    const st = brain.snapshot();
    expect(st.objects.find((o) => o.id === orgId)?.relationIds).toEqual([]);
    expect(st.objects.find((o) => o.id === personId)?.relationIds).toEqual([]);
    expect(st.proposals.find((p) => p.id === prop.id)?.decision).toBe('reject');
  });

  it('删除任一端对象时登记面清掉建关系提议', () => {
    const { brain, orgId, personId } = relationRig();
    const prop = brain.snapshot().proposals.find((p) => p.pending && p.payload.kind === '建关系');
    if (!prop) throw new Error('建关系提议未生成');
    brain.dispatch({ type: 'ARCHIVE_OBJECT', id: personId });
    brain.dispatch({ type: 'DELETE_OBJECT', id: personId });
    expect(brain.snapshot().proposals.find((p) => p.id === prop.id)).toBeUndefined();
    expect(brain.snapshot().objects.find((o) => o.id === orgId)?.relationIds).toEqual([]);
  });
});

describe('候选记忆范围 0055', () => {
  it('确认载荷的范围优先：选「对象」落 objectId；不选回落 payload 默认', () => {
    const { brain, objectId } = rigWith(() => []);
    insertProposal(brain, {
      id: 'prop-mem-scope',
      type: '候选记忆',
      title: '候选一',
      detail: '',
      payload: {
        kind: '候选记忆',
        text: '简报先给结论。',
        memoryKind: '偏好',
        fromObjectId: objectId,
        fromMessageIds: ['m1'],
        sourceExcerpt: '先给结论',
        scope: '全局',
      },
      pending: true,
    });
    insertProposal(brain, {
      id: 'prop-mem-default',
      type: '候选记忆',
      title: '候选二',
      detail: '',
      payload: {
        kind: '候选记忆',
        text: '本周只聊会话内的事。',
        memoryKind: '习惯',
        fromObjectId: objectId,
        fromMessageIds: ['m2'],
        sourceExcerpt: '只聊会话内',
        scope: '会话',
      },
      pending: true,
    });

    brain.dispatch({
      type: 'PROPOSAL_DECIDE',
      proposalId: 'prop-mem-scope',
      decision: 'accept-merge',
      scope: '对象',
    });
    brain.dispatch({
      type: 'PROPOSAL_DECIDE',
      proposalId: 'prop-mem-default',
      decision: 'accept-merge',
    });

    const st = brain.snapshot();
    const overridden = st.memories.find((m) => m.text === '简报先给结论。');
    expect(overridden?.scope).toBe('对象');
    expect(overridden?.objectId).toBe(objectId);
    const fallback = st.memories.find((m) => m.text === '本周只聊会话内的事。');
    expect(fallback?.scope).toBe('会话');
    expect(fallback?.objectId).toBeUndefined();
    expect(st.toast?.text).toBe('已写入会话记忆');
  });
});
