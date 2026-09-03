import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Action } from '@shared/actions';
import { openBrain, type Brain } from '../../src/main/brain';
import { listOperations } from '../../src/main/brain/persist';
import { draftsToClaims } from '../../src/main/loops/extract';
import { completeExtraction } from '../helpers/extraction';

const dirs: string[] = [];
const brains: Brain[] = [];

function tmpBrain(): string {
  const dir = mkdtempSync(join(tmpdir(), 'staffdesk-source-life-'));
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
      /* already closed */
    }
  }
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* Windows may still hold the database briefly. */
    }
  }
});

function seedTwoObjects(brain: Brain) {
  brain.dispatch({ type: 'ADD_WORKSPACE', name: '验收区', scenario: '求职面试' });
  brain.dispatch({ type: 'ADD_OBJECT', kind: '组织', name: '甲组织' });
  brain.dispatch({ type: 'ADD_OBJECT', kind: '组织', name: '乙组织' });
  const [a, b] = brain.snapshot().objects;
  if (!a || !b) throw new Error('对象未写入');
  brain.dispatch({
    type: 'ADD_SOURCE',
    title: '双对象材料',
    body: '甲组织主栈是 Go。乙组织主栈是 Java。',
  });
  const source = brain.snapshot().sources.find((item) => !item.virtual);
  if (!source) throw new Error('来源未写入');
  brain.dispatch({ type: 'BIND_CONFIRMED', sourceId: source.id, objectIds: [a.id, b.id] });
  return { a, b, source };
}

function extractForBoth(brain: Brain, sourceId: string) {
  return completeExtraction(brain, sourceId, [
    {
      objectName: '甲组织',
      predicate: '后端主栈',
      text: '甲组织主栈是 Go',
      span: '甲组织主栈是 Go',
    },
    {
      objectName: '乙组织',
      predicate: '后端主栈',
      text: '乙组织主栈是 Java',
      span: '乙组织主栈是 Java',
    },
  ]);
}

describe('来源生命周期 0031/0034', () => {
  it('解绑只影响指定对象，重启后仍可撤销；最后一个绑定移除才回 Inbox', () => {
    const file = tmpBrain();
    let brain = track(openBrain(file));
    const { a, b, source } = seedTwoObjects(brain);
    extractForBoth(brain, source.id);

    brain.dispatch({ type: 'UNBIND_SOURCE', sourceId: source.id, objectId: a.id });
    let state = brain.snapshot();
    expect(state.sources.find((item) => item.id === source.id)?.boundObjectIds).toEqual([b.id]);
    expect(
      state.claims.some((claim) => claim.sourceId === source.id && claim.objectId === a.id),
    ).toBe(false);
    expect(
      state.claims.some((claim) => claim.sourceId === source.id && claim.objectId === b.id),
    ).toBe(true);
    expect(state.inbox).not.toContain(source.id);
    brain.close();

    brain = track(openBrain(file));
    const undoCard = (brain.snapshot().chatByObject[a.id] ?? []).find(
      (message) => message.card?.undo?.kind === '解绑',
    );
    if (!undoCard) throw new Error('解绑撤销卡未持久化');
    brain.dispatch({ type: 'UNDO_RESULT', objectId: a.id, messageId: undoCard.id });
    state = brain.snapshot();
    expect(state.sources.find((item) => item.id === source.id)?.boundObjectIds).toEqual([
      b.id,
      a.id,
    ]);
    expect(state.claims.filter((claim) => claim.sourceId === source.id)).toHaveLength(2);

    brain.dispatch({ type: 'UNBIND_SOURCE', sourceId: source.id, objectId: a.id });
    brain.dispatch({ type: 'UNBIND_SOURCE', sourceId: source.id, objectId: b.id });
    state = brain.snapshot();
    expect(state.sources.find((item) => item.id === source.id)?.boundObjectIds).toEqual([]);
    expect(state.inbox).toContain(source.id);
  });

  it('迟到的 EXTRACT_DONE 不给已解绑对象或已删来源重新写主张', () => {
    const brain = track(openBrain(tmpBrain()));
    const { a, b, source } = seedTwoObjects(brain);
    const before = brain.snapshot();
    const incoming = draftsToClaims({
      drafts: [
        {
          objectName: '甲组织',
          predicate: '后端主栈',
          text: '甲组织主栈是 Go',
          span: '甲组织主栈是 Go',
        },
        {
          objectName: '乙组织',
          predicate: '后端主栈',
          text: '乙组织主栈是 Java',
          span: '乙组织主栈是 Java',
        },
      ],
      source: before.sources.find((item) => item.id === source.id)!,
      objects: before.objects,
      slotDefs: before.slotDefs,
      existing: [],
      now: '2026-08-29T00:00:00.000Z',
    });

    brain.dispatch({ type: 'UNBIND_SOURCE', sourceId: source.id, objectId: a.id });
    brain.dispatch({ type: 'EXTRACT_DONE', sourceId: source.id, claims: incoming });
    let state = brain.snapshot();
    expect(state.claims.some((claim) => claim.objectId === a.id)).toBe(false);
    expect(state.claims.some((claim) => claim.objectId === b.id)).toBe(true);

    brain.dispatch({ type: 'DELETE_SOURCE', sourceId: source.id });
    brain.dispatch({ type: 'EXTRACT_DONE', sourceId: source.id, claims: incoming });
    state = brain.snapshot();
    expect(state.sources.some((item) => item.id === source.id)).toBe(false);
    expect(
      state.claims.filter((claim) => claim.sourceId === source.id && claim.status === '成立'),
    ).toHaveLength(0);
  });

  it('解绑后重绑产生的并发抽取结果按当前账本幂等落账', () => {
    const brain = track(openBrain(tmpBrain()));
    const { a, source } = seedTwoObjects(brain);
    const before = brain.snapshot();
    const [claim] = draftsToClaims({
      drafts: [
        {
          objectName: '甲组织',
          predicate: '后端主栈',
          text: '甲组织主栈是 Go',
          span: '甲组织主栈是 Go',
        },
      ],
      source: before.sources.find((item) => item.id === source.id)!,
      objects: before.objects,
      slotDefs: before.slotDefs,
      existing: [],
      now: '2026-08-29T00:00:00.000Z',
    });
    if (!claim) throw new Error('抽取主张缺失');

    brain.dispatch({ type: 'UNBIND_SOURCE', sourceId: source.id, objectId: a.id });
    brain.dispatch({ type: 'BIND_CONFIRMED', sourceId: source.id, objectIds: [a.id] });
    brain.dispatch({ type: 'EXTRACT_DONE', sourceId: source.id, claims: [claim] });
    brain.dispatch({
      type: 'EXTRACT_DONE',
      sourceId: source.id,
      claims: [{ ...claim, id: 'cl-second-inflight-result' }],
    });

    expect(
      brain
        .snapshot()
        .claims.filter(
          (item) =>
            item.sourceId === source.id &&
            item.objectId === a.id &&
            item.predicate === claim.predicate &&
            item.span === claim.span,
        ),
    ).toHaveLength(1);
  });

  it('删除来源后主张关窗且绑定消失，历史简报不改，重启后仍保持', () => {
    const file = tmpBrain();
    let brain = track(openBrain(file));
    const { a, b, source } = seedTwoObjects(brain);
    extractForBoth(brain, source.id);
    const alreadyClosed = brain
      .snapshot()
      .claims.find((claim) => claim.sourceId === source.id && claim.objectId === a.id);
    if (!alreadyClosed) throw new Error('预置关窗主张缺失');
    brain.dispatch({ type: 'PROMOTE_CLAIM', claimId: alreadyClosed.id });
    brain.dispatch({ type: 'CORRECT_CLAIM', claimId: alreadyClosed.id, closeReason: '从未成立' });
    brain.dispatch({ type: 'GENERATE_BRIEF_START', objectId: a.id });
    brain.dispatch({ type: 'GENERATE_BRIEF_DONE' });
    const briefBefore = JSON.stringify(brain.snapshot().briefs);
    const claimCount = brain
      .snapshot()
      .claims.filter((claim) => claim.sourceId === source.id).length;
    const activeBeforeDelete = brain
      .snapshot()
      .claims.filter((claim) => claim.sourceId === source.id && claim.status === '成立').length;

    brain.dispatch({ type: 'DELETE_SOURCE', sourceId: source.id });
    let state = brain.snapshot();
    const recovery = state.deletedSourceRecoveries.find((item) => item.source.id === source.id);
    expect(recovery?.source.body).toContain('甲组织主栈是 Go');
    expect(recovery?.source.boundObjectIds).toEqual([a.id, b.id]);
    expect(recovery?.claims).toHaveLength(claimCount);
    expect(state.sources.some((item) => item.id === source.id)).toBe(false);
    expect(state.claims.filter((claim) => claim.sourceId === source.id)).toHaveLength(claimCount);
    expect(
      state.claims
        .filter((claim) => claim.sourceId === source.id && claim.id !== alreadyClosed.id)
        .every(
          (claim) => claim.status === '过时' && claim.closeReason === '来源删除' && claim.validTo,
        ),
    ).toBe(true);
    expect(state.claims.find((claim) => claim.id === alreadyClosed.id)?.closeReason).toBe(
      '从未成立',
    );
    expect(JSON.stringify(state.briefs)).toBe(briefBefore);
    expect(
      Object.values(state.chatByObject)
        .flat()
        .some((message) => message.card?.result === '删除来源' && message.card.undo),
    ).toBe(false);
    const oldBindUndo = (state.chatByObject[a.id] ?? []).find(
      (message) => message.card?.undo?.kind === '绑定',
    );
    if (!oldBindUndo) throw new Error('历史绑定卡缺失');
    brain.dispatch({ type: 'UNDO_RESULT', objectId: a.id, messageId: oldBindUndo.id });
    state = brain.snapshot();
    expect(state.sources.some((item) => item.id === source.id)).toBe(false);
    expect(state.inbox).not.toContain(source.id);
    expect(state.claims.filter((claim) => claim.sourceId === source.id)).toHaveLength(claimCount);
    brain.close();

    brain = track(openBrain(file));
    state = brain.snapshot();
    expect(state.sources.some((item) => item.id === source.id)).toBe(false);
    const persistedRecovery = state.deletedSourceRecoveries.find(
      (item) => item.source.id === source.id,
    );
    expect(persistedRecovery?.source.title).toBe('双对象材料');
    expect(state.claims.filter((claim) => claim.sourceId === source.id)).toHaveLength(claimCount);
    expect(
      state.claims
        .filter((claim) => claim.sourceId === source.id && claim.id !== alreadyClosed.id)
        .every((claim) => claim.status === '过时' && claim.closeReason === '来源删除'),
    ).toBe(true);
    expect(state.claims.find((claim) => claim.id === alreadyClosed.id)?.closeReason).toBe(
      '从未成立',
    );
    expect(JSON.stringify(state.briefs)).toBe(briefBefore);

    if (!persistedRecovery) throw new Error('删除来源恢复快照未持久化');
    brain.dispatch({ type: 'RESTORE_DELETED_SOURCE', recovery: persistedRecovery });
    state = brain.snapshot();
    expect(state.deletedSourceRecoveries.some((item) => item.source.id === source.id)).toBe(false);
    expect(state.sources.find((item) => item.id === source.id)?.boundObjectIds).toEqual([
      a.id,
      b.id,
    ]);
    expect(state.claims.filter((claim) => claim.sourceId === source.id)).toHaveLength(claimCount);
    expect(
      state.claims.filter((claim) => claim.sourceId === source.id && claim.status === '成立'),
    ).toHaveLength(activeBeforeDelete);
    expect(state.claims.find((claim) => claim.id === alreadyClosed.id)?.closeReason).toBe(
      '从未成立',
    );
  });

  it('失败抽取即使误带 claims 也只落失败终态，不写主张', () => {
    const brain = track(openBrain(tmpBrain()));
    const { a, source } = seedTwoObjects(brain);
    const before = brain.snapshot();
    const incoming = draftsToClaims({
      drafts: [
        {
          objectName: '甲组织',
          predicate: '后端主栈',
          text: '甲组织主栈是 Go',
          span: '甲组织主栈是 Go',
        },
      ],
      source: before.sources.find((item) => item.id === source.id)!,
      objects: before.objects,
      slotDefs: before.slotDefs,
      existing: [],
      now: '2026-08-29T00:00:00.000Z',
    });

    brain.dispatch({
      type: 'EXTRACT_DONE',
      sourceId: source.id,
      outcome: 'failed',
      detail: 'boom',
      claims: incoming,
    } as unknown as Action);
    const state = brain.snapshot();
    expect(state.claims).toHaveLength(0);
    expect(state.extractJobs.find((job) => job.sourceId === source.id)?.status).toBe('失败');
    expect(state.chatByObject[a.id]?.some((message) => message.text.includes('抽取失败'))).toBe(
      true,
    );
  });
});

describe('对象页来源生命周期写入走确认卡 0027', () => {
  it('解绑入队不落账，确认才解绑，拒绝保持绑定', () => {
    const file = tmpBrain();
    let brain = track(openBrain(file));
    const { a, b, source } = seedTwoObjects(brain);
    extractForBoth(brain, source.id);
    const before = brain.snapshot();
    const claimCount = before.claims.length;
    const bindings = before.sources.find((item) => item.id === source.id)?.boundObjectIds;

    brain.dispatch({
      type: 'ENQUEUE_WRITE',
      draft: {
        objectId: a.id,
        kind: '解绑',
        sourceId: source.id,
        headline: '解绑当前对象？',
        evidence: '经此来源挂在当前对象上的主张会离开该对象。',
      },
    });
    let state = brain.snapshot();
    const queued = state.writeQueue.find((write) => write.kind === '解绑');
    expect(queued?.sourceId).toBe(source.id);
    expect(state.sources.find((item) => item.id === source.id)?.boundObjectIds).toEqual(bindings);
    expect(state.claims).toHaveLength(claimCount);

    brain.close();
    brain = track(openBrain(file));
    const persisted = brain.snapshot().writeQueue.find((write) => write.kind === '解绑');
    if (!persisted) throw new Error('解绑确认卡未持久化');

    brain.dispatch({ type: 'REJECT_WRITE', writeId: persisted.id });
    state = brain.snapshot();
    expect(state.writeQueue.some((write) => write.kind === '解绑')).toBe(false);
    expect(state.sources.find((item) => item.id === source.id)?.boundObjectIds).toEqual(bindings);
    expect(state.claims).toHaveLength(claimCount);

    brain.dispatch({
      type: 'ENQUEUE_WRITE',
      draft: {
        objectId: a.id,
        kind: '解绑',
        sourceId: source.id,
        headline: '解绑当前对象？',
        evidence: '经此来源挂在当前对象上的主张会离开该对象。',
      },
    });
    const again = brain.snapshot().writeQueue.find((write) => write.kind === '解绑');
    if (!again) throw new Error('解绑确认卡未入队');
    brain.dispatch({ type: 'CONFIRM_WRITE', writeId: again.id });
    state = brain.snapshot();
    expect(state.sources.find((item) => item.id === source.id)?.boundObjectIds).toEqual([b.id]);
    expect(
      state.claims.some((claim) => claim.sourceId === source.id && claim.objectId === a.id),
    ).toBe(false);
    expect(
      state.claims.some((claim) => claim.sourceId === source.id && claim.objectId === b.id),
    ).toBe(true);
    expect(state.writeQueue.some((write) => write.kind === '解绑')).toBe(false);
  });

  it('删除来源入队不落账，确认才删除，拒绝留下来源', () => {
    const brain = track(openBrain(tmpBrain()));
    const { a, source } = seedTwoObjects(brain);
    extractForBoth(brain, source.id);
    const before = brain.snapshot();
    const claimCount = before.claims.filter((claim) => claim.sourceId === source.id).length;

    brain.dispatch({
      type: 'ENQUEUE_WRITE',
      draft: {
        objectId: a.id,
        kind: '删除来源',
        sourceId: source.id,
        headline: '删除来源？',
        evidence: '删除将关窗相关主张，不提供一键撤销。',
      },
    });
    let state = brain.snapshot();
    const queued = state.writeQueue.find((write) => write.kind === '删除来源');
    if (!queued) throw new Error('删除来源确认卡未入队');
    expect(queued.sourceId).toBe(source.id);
    expect(state.sources.some((item) => item.id === source.id)).toBe(true);
    expect(state.claims.filter((claim) => claim.sourceId === source.id)).toHaveLength(claimCount);

    brain.dispatch({ type: 'REJECT_WRITE', writeId: queued.id });
    state = brain.snapshot();
    expect(state.sources.some((item) => item.id === source.id)).toBe(true);
    expect(
      state.claims.filter((claim) => claim.sourceId === source.id && claim.status === '成立'),
    ).toHaveLength(claimCount);

    brain.dispatch({
      type: 'ENQUEUE_WRITE',
      draft: {
        objectId: a.id,
        kind: '删除来源',
        sourceId: source.id,
        headline: '删除来源？',
        evidence: '删除将关窗相关主张，不提供一键撤销。',
      },
    });
    const again = brain.snapshot().writeQueue.find((write) => write.kind === '删除来源');
    if (!again) throw new Error('删除来源确认卡未入队');
    brain.dispatch({ type: 'CONFIRM_WRITE', writeId: again.id });
    state = brain.snapshot();
    expect(state.sources.some((item) => item.id === source.id)).toBe(false);
    expect(
      state.claims.filter((claim) => claim.sourceId === source.id && claim.status === '成立'),
    ).toHaveLength(0);
    expect(
      state.claims
        .filter((claim) => claim.sourceId === source.id)
        .every((claim) => claim.closeReason === '来源删除'),
    ).toBe(true);
  });

  it('重试抽取入队不改 extractJobs，确认才进入抽取中', () => {
    const brain = track(openBrain(tmpBrain()));
    const { a, source } = seedTwoObjects(brain);
    brain.dispatch({
      type: 'EXTRACT_DONE',
      sourceId: source.id,
      outcome: 'failed',
      detail: '模型没有返回可解析的 JSON',
    });
    const failed = brain.snapshot().extractJobs.find((job) => job.sourceId === source.id);
    expect(failed?.status).toBe('失败');

    brain.dispatch({
      type: 'ENQUEUE_WRITE',
      draft: {
        objectId: a.id,
        kind: '重试抽取',
        sourceId: source.id,
        headline: '重试抽取？',
        evidence: '确认后将再次开始抽取。',
      },
    });
    let state = brain.snapshot();
    const queued = state.writeQueue.find((write) => write.kind === '重试抽取');
    expect(queued?.sourceId).toBe(source.id);
    expect(state.extractJobs.find((job) => job.sourceId === source.id)?.status).toBe('失败');

    if (!queued) throw new Error('重试抽取确认卡未入队');
    brain.dispatch({ type: 'CONFIRM_WRITE', writeId: queued.id });
    state = brain.snapshot();
    expect(state.extractJobs.find((job) => job.sourceId === source.id)?.status).toBe('抽取中');
    expect(state.writeQueue.some((write) => write.kind === '重试抽取')).toBe(false);
  });

  it('缺 sourceId 的来源写提议不许入队', () => {
    const brain = track(openBrain(tmpBrain()));
    const { a } = seedTwoObjects(brain);
    for (const kind of ['解绑', '删除来源', '重试抽取'] as const) {
      brain.dispatch({
        type: 'ENQUEUE_WRITE',
        draft: {
          objectId: a.id,
          kind,
          headline: kind,
          evidence: '无出处',
        },
      });
    }
    const state = brain.snapshot();
    expect(state.writeQueue).toHaveLength(0);
    expect(state.toast?.text).toBe('无出处的写提议不许生成');
  });
});

describe('批量整理补偿 0034', () => {
  it('一次丢弃多条未核，重启后撤销会原子恢复整批', () => {
    const file = tmpBrain();
    let brain = track(openBrain(file));
    brain.dispatch({ type: 'ADD_WORKSPACE', name: '验收区', scenario: '求职面试' });
    brain.dispatch({ type: 'ADD_OBJECT', kind: '组织', name: '甲组织' });
    const object = brain.snapshot().objects[0]!;
    brain.dispatch({
      type: 'ADD_SOURCE',
      title: '材料',
      body: '甲组织主栈是 Go。甲组织在招后端。',
    });
    const source = brain.snapshot().sources.find((item) => !item.virtual)!;
    brain.dispatch({ type: 'BIND_CONFIRMED', sourceId: source.id, objectIds: [object.id] });
    completeExtraction(brain, source.id, [
      { predicate: '后端主栈', text: '甲组织主栈是 Go', span: '甲组织主栈是 Go' },
      { predicate: '在招岗位', text: '甲组织在招后端', span: '甲组织在招后端' },
    ]);
    const proposal = brain
      .snapshot()
      .proposals.find((item) => item.pending && item.payload.kind === '丢弃未核');
    if (!proposal) throw new Error('批量丢弃提议未生成');
    brain.dispatch({ type: 'PROPOSAL_DECIDE', proposalId: proposal.id, decision: 'accept-drop' });
    expect(brain.snapshot().claims).toHaveLength(0);
    brain.close();

    brain = track(openBrain(file));
    const undoCard = (brain.snapshot().chatByObject[object.id] ?? []).find(
      (message) => message.card?.undo?.kind === '整理丢弃',
    );
    if (!undoCard) throw new Error('批量丢弃撤销卡未持久化');
    brain.dispatch({ type: 'UNDO_RESULT', objectId: object.id, messageId: undoCard.id });
    expect(brain.snapshot().claims).toHaveLength(2);
    expect(
      listOperations(brain.db).some(
        (operation) => operation.action === 'UNDO_RESULT' && operation.undo_of === 'compensating',
      ),
    ).toBe(true);
  });

  it('已持久化的旧 {claim} 整理撤销载荷仍能恢复', () => {
    const file = tmpBrain();
    let brain = track(openBrain(file));
    brain.dispatch({ type: 'ADD_WORKSPACE', name: '验收区', scenario: '求职面试' });
    brain.dispatch({ type: 'ADD_OBJECT', kind: '组织', name: '甲组织' });
    const object = brain.snapshot().objects[0]!;
    brain.dispatch({ type: 'ADD_SOURCE', title: '材料', body: '甲组织主栈是 Go。' });
    const source = brain.snapshot().sources.find((item) => !item.virtual)!;
    brain.dispatch({ type: 'BIND_CONFIRMED', sourceId: source.id, objectIds: [object.id] });
    completeExtraction(brain, source.id, [
      { predicate: '后端主栈', text: '甲组织主栈是 Go', span: '甲组织主栈是 Go' },
    ]);
    const claim = brain.snapshot().claims[0]!;
    brain.dispatch({ type: 'CORRECT_CLAIM', claimId: claim.id, closeReason: '从未成立' });
    const card = (brain.snapshot().chatByObject[object.id] ?? []).find(
      (message) => message.card?.undo?.kind === '整理丢弃',
    );
    if (!card?.card) throw new Error('整理撤销卡缺失');
    brain.db
      .prepare('UPDATE chat_messages SET card = ? WHERE id = ?')
      .run(JSON.stringify({ ...card.card, undo: { kind: '整理丢弃', claim } }), card.id);
    brain.close();

    brain = track(openBrain(file));
    const legacyCard = (brain.snapshot().chatByObject[object.id] ?? []).find(
      (message) => message.id === card.id,
    );
    if (!legacyCard) throw new Error('旧撤销卡未读出');
    brain.dispatch({ type: 'UNDO_RESULT', objectId: object.id, messageId: legacyCard.id });
    expect(brain.snapshot().claims.some((item) => item.id === claim.id)).toBe(true);
  });
});
