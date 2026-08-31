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
function rigWith(claims: (sourceId: string, objectId: string) => Claim[]): Rig {
  const brain = track(openBrain(tmpBrain()));
  brain.dispatch({ type: 'ADD_WORKSPACE', name: '整理验收区', scenario: '求职面试' });
  brain.dispatch({ type: 'ADD_OBJECT', kind: '组织', name: '甲组织' });
  const objectId = brain.snapshot().objects[0]!.id;
  brain.dispatch({ type: 'ADD_SOURCE', title: '材料', body: '甲组织的材料。' });
  const sourceId = brain.snapshot().sources.find((s) => !s.virtual)!.id;
  brain.dispatch({ type: 'BIND_CONFIRMED', sourceId, objectIds: [objectId] });
  brain.dispatch({ type: 'EXTRACT_DONE', sourceId, claims: claims(sourceId, objectId) });
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
