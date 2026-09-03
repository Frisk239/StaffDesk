import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openBrain, type Brain } from '../../src/main/brain';
import type { Claim, Proposal } from '../../src/shared/types';

const dirs: string[] = [];
const brains: Brain[] = [];

function tmpBrain(): string {
  const dir = mkdtempSync(join(tmpdir(), 'staffdesk-linger-drop-'));
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

function rigWith(claims: (sourceId: string, objectId: string) => Claim[]): {
  brain: Brain;
  objectId: string;
  sourceId: string;
} {
  const brain = track(openBrain(tmpBrain()));
  brain.dispatch({ type: 'ADD_WORKSPACE', name: '滞留验收区', scenario: '求职面试' });
  brain.dispatch({ type: 'ADD_OBJECT', kind: '组织', name: '甲组织' });
  const objectId = brain.snapshot().objects[0]!.id;
  brain.dispatch({ type: 'ADD_SOURCE', title: '材料', body: '甲组织的材料。' });
  const sourceId = brain.snapshot().sources.find((s) => !s.virtual)!.id;
  brain.dispatch({ type: 'BIND_CONFIRMED', sourceId, objectIds: [objectId] });
  brain.dispatch({
    type: 'EXTRACT_DONE',
    sourceId,
    claims: claims(sourceId, objectId),
  });
  return { brain, objectId, sourceId };
}

function backdateClaims(brain: Brain, createdAt: string): void {
  // 0056：created_at 是入库时钟，persist 的 UPDATE 故意不碰它。
  brain.db.prepare('UPDATE claims SET created_at = ?').run(createdAt);
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

function pendingDrop(brain: Brain): Proposal | undefined {
  return brain.snapshot().proposals.find((p) => p.pending && p.payload.kind === '丢弃未核');
}

describe('滞留未核扫描与接受 0064', () => {
  it('抽取当下的未核不产丢弃卡', () => {
    const { brain } = rigWith((sourceId, objectId) => [
      injectedClaim('cl-fresh', sourceId, objectId, {
        predicate: '使用技术',
        text: '甲组织主栈是 Go。',
        span: '甲组织主栈是 Go',
      }),
    ]);
    expect(pendingDrop(brain)).toBeUndefined();
  });

  it('打开扫描：入库满 N 天的未核才出卡', () => {
    const { brain, objectId } = rigWith((sourceId, oid) => [
      injectedClaim('cl-old', sourceId, oid, {
        predicate: '使用技术',
        text: '甲组织主栈是 Go。',
        span: '甲组织主栈是 Go',
      }),
    ]);
    backdateClaims(brain, '2026-08-01');
    brain.dispatch({
      type: 'SCAN_LINGER_UNVERIFIED',
      lingerDays: 7,
      now: '2026-09-05',
    });
    const drop = pendingDrop(brain);
    expect(drop?.payload).toEqual({
      kind: '丢弃未核',
      claimIds: [brain.snapshot().claims[0]!.id],
      objectId,
    });
  });

  it('晋升其中一条后挂起卡刷新不再列出它；接受不删已晋升的', () => {
    const { brain } = rigWith((sourceId, oid) => [
      injectedClaim('cl-a', sourceId, oid, {
        predicate: '使用技术',
        text: '甲组织主栈是 Go。',
        span: '甲组织主栈是 Go',
      }),
      injectedClaim('cl-b', sourceId, oid, {
        predicate: '在招岗位',
        text: '甲组织在招后端。',
        span: '甲组织在招后端',
      }),
    ]);
    backdateClaims(brain, '2026-08-01');
    brain.dispatch({ type: 'SCAN_LINGER_UNVERIFIED', lingerDays: 7, now: '2026-09-05' });
    const before = pendingDrop(brain);
    if (!before || before.payload.kind !== '丢弃未核') throw new Error('丢弃卡未生成');
    expect(before.payload.claimIds).toEqual(expect.arrayContaining(['cl-a', 'cl-b']));

    brain.dispatch({ type: 'PROMOTE_CLAIM', claimId: 'cl-a' });
    const refreshed = pendingDrop(brain);
    if (!refreshed || refreshed.payload.kind !== '丢弃未核') throw new Error('刷新后丢弃卡不见了');
    expect(refreshed.payload.claimIds).toEqual(['cl-b']);
    expect(refreshed.pending).toBe(true);

    brain.dispatch({ type: 'PROPOSAL_DECIDE', proposalId: refreshed.id, decision: 'accept-drop' });
    const st = brain.snapshot();
    expect(st.claims.map((c) => c.id)).toEqual(['cl-a']);
    expect(st.claims[0]?.unverified).toBe(false);
    expect(st.toast?.text).toBe('已丢弃 1 条滞留未核');
  });

  it('接受时载荷里有已晋升 id，只丢此刻仍滞留的', () => {
    const { brain, objectId } = rigWith((sourceId, oid) => [
      injectedClaim('cl-a', sourceId, oid, {
        predicate: '使用技术',
        text: '甲组织主栈是 Go。',
        span: '甲组织主栈是 Go',
      }),
      injectedClaim('cl-b', sourceId, oid, {
        predicate: '在招岗位',
        text: '甲组织在招后端。',
        span: '甲组织在招后端',
      }),
    ]);
    backdateClaims(brain, '2026-08-01');
    brain.dispatch({ type: 'PROMOTE_CLAIM', claimId: 'cl-a' });
    insertProposal(brain, {
      id: 'prop-drop-stale',
      type: '整理',
      title: '建议丢弃滞留未核 2 条',
      detail: '',
      payload: { kind: '丢弃未核', claimIds: ['cl-a', 'cl-b'], objectId },
      pending: true,
    });
    brain.dispatch({
      type: 'PROPOSAL_DECIDE',
      proposalId: 'prop-drop-stale',
      decision: 'accept-drop',
    });
    const st = brain.snapshot();
    expect(st.claims.map((c) => c.id)).toEqual(['cl-a']);
    expect(st.toast?.text).toBe('已丢弃 1 条滞留未核');
    const undo = (st.chatByObject[objectId] ?? []).find((m) => m.card?.undo?.kind === '整理丢弃');
    expect(undo?.card?.undo).toEqual({
      kind: '整理丢弃',
      claims: expect.arrayContaining([expect.objectContaining({ id: 'cl-b' })]),
    });
    expect(undo?.card?.claimIds).toEqual(['cl-b']);
  });

  it('驳回后同集合再扫描不出新卡；集合变了才出新卡', () => {
    const { brain, sourceId, objectId } = rigWith((sid, oid) => [
      injectedClaim('cl-a', sid, oid, {
        predicate: '使用技术',
        text: '甲组织主栈是 Go。',
        span: '甲组织主栈是 Go',
      }),
    ]);
    backdateClaims(brain, '2026-08-01');
    brain.dispatch({ type: 'SCAN_LINGER_UNVERIFIED', lingerDays: 7, now: '2026-09-05' });
    const first = pendingDrop(brain);
    if (!first) throw new Error('丢弃卡未生成');
    brain.dispatch({ type: 'PROPOSAL_DECIDE', proposalId: first.id, decision: 'reject' });

    brain.dispatch({ type: 'SCAN_LINGER_UNVERIFIED', lingerDays: 7, now: '2026-09-05' });
    expect(
      brain.snapshot().proposals.filter((p) => p.pending && p.payload.kind === '丢弃未核'),
    ).toHaveLength(0);

    brain.dispatch({
      type: 'EXTRACT_DONE',
      sourceId,
      claims: [
        injectedClaim('cl-b', sourceId, objectId, {
          predicate: '在招岗位',
          text: '甲组织在招后端。',
          span: '甲组织在招后端',
        }),
      ],
    });
    backdateClaims(brain, '2026-08-01');
    brain.dispatch({ type: 'SCAN_LINGER_UNVERIFIED', lingerDays: 7, now: '2026-09-05' });
    const again = pendingDrop(brain);
    if (!again || again.payload.kind !== '丢弃未核') throw new Error('集合变化后应出新卡');
    expect(again.id).not.toBe(first.id);
    expect(again.payload.claimIds).toEqual(expect.arrayContaining(['cl-a', 'cl-b']));
  });
});
