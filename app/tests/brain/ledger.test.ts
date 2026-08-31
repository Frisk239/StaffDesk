import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_SLOT_DEFS, deriveConflicts } from '@shared/scenario';
import type { Claim, SlotDef } from '@shared/types';
import { openBrain, projectionClaims, type Brain } from '../../src/main/brain';
import { sentenceIsUnknownPlaceholder } from '../../src/main/brain/briefOut';
import { completeExtraction } from '../helpers/extraction';

const dirs: string[] = [];
const brains: Brain[] = [];

function tmpBrain() {
  const dir = mkdtempSync(join(tmpdir(), 'staffdesk-ledger-'));
  dirs.push(dir);
  return join(dir, 'brain.db');
}

function track(brain: Brain): Brain {
  brains.push(brain);
  return brain;
}

afterEach(() => {
  while (brains.length) {
    const b = brains.pop();
    try {
      b?.close();
    } catch {
      /* already closed */
    }
  }
  while (dirs.length) {
    const dir = dirs.pop();
    if (dir) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* windows lock */
      }
    }
  }
});

function claim(
  partial: Omit<Claim, 'status' | 'unverified' | 'createdAt'> & Partial<Claim>,
): Claim {
  return {
    status: '成立',
    unverified: true,
    createdAt: '2026-08-01',
    ...partial,
  };
}

function seedWorkspace(brain: Brain) {
  brain.dispatch({ type: 'ADD_WORKSPACE', name: '验收区', scenario: '求职面试' });
  const ws = brain.snapshot().workspaces[0];
  if (!ws) throw new Error('工作区未写入');
  brain.dispatch({ type: 'ADD_OBJECT', kind: '组织', name: '验收组织' });
  const obj = brain.snapshot().objects[0];
  if (!obj) throw new Error('对象未写入');
  return { ws, obj };
}

describe('出荷写入与重启', () => {
  it('写入工作区+对象+来源+主张+会话后关闭再打开仍在', () => {
    const file = tmpBrain();
    let brain = track(openBrain(file));
    const { obj } = seedWorkspace(brain);
    brain.dispatch({
      type: 'ADD_SOURCE',
      title: '手给材料.txt',
      body: '该公司在招后端实习。团队主栈是 Go。办公地点未写。',
    });
    const source = brain.snapshot().sources.find((s) => !s.virtual);
    if (!source) throw new Error('来源未写入');
    expect(brain.snapshot().claims).toHaveLength(0);

    brain.dispatch({ type: 'BIND_CONFIRMED', sourceId: source.id, objectIds: [obj.id] });
    expect(brain.snapshot().claims).toHaveLength(0);

    completeExtraction(brain, source.id, [
      { predicate: '在招岗位', text: '该公司在招后端实习', span: '该公司在招后端实习' },
      { predicate: '后端主栈', text: '团队主栈是 Go', span: '团队主栈是 Go' },
    ]);
    const afterExtract = brain.snapshot();
    expect(afterExtract.claims.length).toBeGreaterThan(0);
    brain.dispatch({ type: 'CHAT_SEND', objectId: obj.id, text: '这家组织在招什么？' });
    const before = brain.snapshot();
    const claimCount = before.claims.length;
    const msgCount = (before.chatByObject[obj.id] ?? []).length;
    expect(msgCount).toBeGreaterThan(0);
    brain.close();

    brain = track(openBrain(file));
    const again = brain.snapshot();
    expect(again.workspaces.map((w) => w.name)).toEqual(['验收区']);
    expect(again.objects.map((o) => o.name)).toEqual(['验收组织']);
    expect(
      again.sources.some((s) => s.title === '手给材料.txt' && s.boundObjectIds.includes(obj.id)),
    ).toBe(true);
    expect(again.claims.length).toBe(claimCount);
    expect((again.chatByObject[obj.id] ?? []).length).toBe(msgCount);
    brain.close();
  });
});

describe('deriveConflicts 0029', () => {
  const slots: SlotDef[] = DEFAULT_SLOT_DEFS;

  it('正例：同对象同单值槽双方成立、有效期重叠、text 不同 → 一条冲突', () => {
    const claims = [
      claim({
        id: 'a',
        objectId: 'o1',
        predicate: '后端主栈',
        text: '主栈是 Go。',
        sourceId: 's1',
      }),
      claim({
        id: 'b',
        objectId: 'o1',
        predicate: '后端主栈',
        text: '主栈是 Java。',
        sourceId: 's2',
      }),
    ];
    expect(deriveConflicts(claims, slots)).toEqual([{ claimIdA: 'a', claimIdB: 'b' }]);
  });

  it('0053 反例：归一化等值（大小写、全半角、空白差）不算互斥，不建冲突', () => {
    const claims = [
      claim({
        id: 'a',
        objectId: 'o1',
        predicate: '后端主栈',
        text: '主栈是 Go。',
        sourceId: 's1',
      }),
      claim({
        id: 'b',
        objectId: 'o1',
        predicate: '后端主栈',
        text: '主栈是 ｇｏ。',
        sourceId: 's2',
      }),
      claim({
        id: 'c',
        objectId: 'o1',
        predicate: '后端主栈',
        text: ' 主栈是 Go。 ',
        sourceId: 's3',
      }),
    ];
    expect(deriveConflicts(claims, slots)).toEqual([]);
  });

  it('0053 正例：归一化后仍不同（北京 vs 北京市）照建冲突，由人消解', () => {
    const claims = [
      claim({
        id: 'a',
        objectId: 'o1',
        predicate: '办公地点',
        text: '办公地点是北京。',
        sourceId: 's1',
      }),
      claim({
        id: 'b',
        objectId: 'o1',
        predicate: '办公地点',
        text: '办公地点是北京市。',
        sourceId: 's2',
      }),
    ];
    expect(deriveConflicts(claims, slots)).toEqual([{ claimIdA: 'a', claimIdB: 'b' }]);
  });

  it('反例：多值槽不建冲突', () => {
    const claims = [
      claim({ id: 'a', objectId: 'o1', predicate: '在招岗位', text: '招后端。', sourceId: 's1' }),
      claim({ id: 'b', objectId: 'o1', predicate: '在招岗位', text: '招前端。', sourceId: 's1' }),
    ];
    expect(deriveConflicts(claims, slots)).toEqual([]);
  });

  it('反例：未编目不建冲突', () => {
    const claims = [
      claim({ id: 'a', objectId: 'o1', predicate: '未编目', text: '平台化。', sourceId: 's1' }),
      claim({ id: 'b', objectId: 'o1', predicate: '未编目', text: '内部中台。', sourceId: 's1' }),
    ];
    expect(deriveConflicts(claims, slots)).toEqual([]);
  });

  it('反例：过时后派生对消失', () => {
    const claims = [
      claim({
        id: 'a',
        objectId: 'o1',
        predicate: '后端主栈',
        text: '主栈是 Go。',
        sourceId: 's1',
        status: '过时',
        closeReason: '从未成立',
      }),
      claim({
        id: 'b',
        objectId: 'o1',
        predicate: '后端主栈',
        text: '主栈是 Java。',
        sourceId: 's2',
      }),
    ];
    expect(deriveConflicts(claims, slots)).toEqual([]);
  });

  it('反例：有效期不重叠不建冲突', () => {
    const claims = [
      claim({
        id: 'a',
        objectId: 'o1',
        predicate: '后端主栈',
        text: '主栈是 Go。',
        sourceId: 's1',
        validFrom: '2020-01-01',
        validTo: '2021-01-01',
      }),
      claim({
        id: 'b',
        objectId: 'o1',
        predicate: '后端主栈',
        text: '主栈是 Java。',
        sourceId: 's2',
        validFrom: '2022-01-01',
      }),
    ];
    expect(deriveConflicts(claims, slots)).toEqual([]);
  });

  it('反例：text 相同不建冲突', () => {
    const claims = [
      claim({
        id: 'a',
        objectId: 'o1',
        predicate: '后端主栈',
        text: '主栈是 Go。',
        sourceId: 's1',
      }),
      claim({
        id: 'b',
        objectId: 'o1',
        predicate: '后端主栈',
        text: '主栈是 Go。',
        sourceId: 's2',
      }),
    ];
    expect(deriveConflicts(claims, slots)).toEqual([]);
  });
});

describe('绑定、抽取、闲聊、纠正', () => {
  it('未确认绑定不写主张，确认后只写明确传入的抽取结果', () => {
    const brain = track(openBrain(tmpBrain()));
    const { obj } = seedWorkspace(brain);
    brain.dispatch({
      type: 'ADD_SOURCE',
      title: '材料',
      body: '该公司在招后端实习。团队主栈是 Go。',
    });
    const source = brain.snapshot().sources.find((s) => !s.virtual);
    if (!source) throw new Error('来源未写入');
    completeExtraction(brain, source.id, [
      { predicate: '在招岗位', text: '该公司在招后端实习', span: '该公司在招后端实习' },
      { predicate: '后端主栈', text: '团队主栈是 Go', span: '团队主栈是 Go' },
    ]);
    expect(brain.snapshot().claims).toHaveLength(0);
    brain.dispatch({ type: 'BIND_CONFIRMED', sourceId: source.id, objectIds: [obj.id] });
    expect(brain.snapshot().claims).toHaveLength(0);
    completeExtraction(brain, source.id, [
      { predicate: '在招岗位', text: '该公司在招后端实习', span: '该公司在招后端实习' },
      { predicate: '后端主栈', text: '团队主栈是 Go', span: '团队主栈是 Go' },
    ]);
    expect(brain.snapshot().claims.length).toBeGreaterThan(0);
    brain.close();
  });

  it('未绑定来源的主张不出现在该对象投影', () => {
    const brain = track(openBrain(tmpBrain()));
    const { obj } = seedWorkspace(brain);
    brain.dispatch({
      type: 'ADD_SOURCE',
      title: '材料',
      body: '该公司在招后端实习。团队主栈是 Go。',
    });
    const source = brain.snapshot().sources.find((s) => !s.virtual);
    if (!source) throw new Error('来源未写入');
    brain.dispatch({ type: 'BIND_CONFIRMED', sourceId: source.id, objectIds: [obj.id] });
    completeExtraction(brain, source.id, [
      { predicate: '在招岗位', text: '该公司在招后端实习', span: '该公司在招后端实习' },
    ]);
    const boundSnap = brain.snapshot();
    expect(projectionClaims(boundSnap, obj.id).length).toBeGreaterThan(0);

    const bindCard = (boundSnap.chatByObject[obj.id] ?? []).find(
      (m) => m.card?.undo?.kind === '绑定',
    );
    if (!bindCard) throw new Error('绑定结果卡缺失');
    brain.dispatch({ type: 'UNDO_RESULT', objectId: obj.id, messageId: bindCard.id });
    const unbound = brain.snapshot();
    expect(unbound.sources.find((s) => s.id === source.id)?.boundObjectIds).toEqual([]);
    expect(projectionClaims(unbound, obj.id)).toHaveLength(0);
    brain.close();
  });

  it('一次闲聊发送后 claims 数量不变', () => {
    const brain = track(openBrain(tmpBrain()));
    const { obj } = seedWorkspace(brain);
    brain.dispatch({
      type: 'ADD_SOURCE',
      title: '材料',
      body: '该公司在招后端实习。团队主栈是 Go。',
    });
    const source = brain.snapshot().sources.find((s) => !s.virtual);
    if (!source) throw new Error('来源未写入');
    brain.dispatch({ type: 'BIND_CONFIRMED', sourceId: source.id, objectIds: [obj.id] });
    completeExtraction(brain, source.id, [
      { predicate: '在招岗位', text: '该公司在招后端实习', span: '该公司在招后端实习' },
      { predicate: '后端主栈', text: '团队主栈是 Go', span: '团队主栈是 Go' },
      { predicate: '后端主栈', text: '团队也在评估 Java 方向', span: '团队也在评估 Java 方向' },
    ]);
    const n = brain.snapshot().claims.length;
    brain.dispatch({ type: 'CHAT_SEND', objectId: obj.id, text: '今天天气怎么样？' });
    expect(brain.snapshot().claims.length).toBe(n);
    brain.close();
  });

  it('纠正未核不新增禁写，纠正已晋升后 status=过时且有禁写', () => {
    const brain = track(openBrain(tmpBrain()));
    const { obj } = seedWorkspace(brain);
    brain.dispatch({
      type: 'ADD_SOURCE',
      title: '材料',
      body: '该公司在招后端实习。团队主栈是 Go。团队也在评估 Java 方向。',
    });
    const source = brain.snapshot().sources.find((s) => !s.virtual);
    if (!source) throw new Error('来源未写入');
    brain.dispatch({ type: 'BIND_CONFIRMED', sourceId: source.id, objectIds: [obj.id] });
    completeExtraction(brain, source.id, [
      { predicate: '在招岗位', text: '该公司在招后端实习', span: '该公司在招后端实习' },
      { predicate: '后端主栈', text: '团队主栈是 Go', span: '团队主栈是 Go' },
      {
        predicate: '后端主栈',
        text: '团队也在评估 Java 方向',
        span: '团队也在评估 Java 方向',
      },
    ]);
    const claims = brain.snapshot().claims;
    expect(claims.length).toBeGreaterThanOrEqual(2);
    const first = claims[0];
    const second = claims[1];
    if (!first || !second) throw new Error('主张不足');

    const bansBefore = brain.snapshot().memories.filter((m) => m.kind === '禁写').length;
    brain.dispatch({ type: 'CORRECT_CLAIM', claimId: first.id, closeReason: '从未成立' });
    const afterDrop = brain.snapshot();
    expect(afterDrop.claims.some((c) => c.id === first.id)).toBe(false);
    expect(afterDrop.memories.filter((m) => m.kind === '禁写').length).toBe(bansBefore);

    brain.dispatch({ type: 'PROMOTE_CLAIM', claimId: second.id });
    expect(brain.snapshot().claims.find((c) => c.id === second.id)?.unverified).toBe(false);
    brain.dispatch({ type: 'CORRECT_CLAIM', claimId: second.id, closeReason: '从未成立' });
    const afterClose = brain.snapshot();
    const closed = afterClose.claims.find((c) => c.id === second.id);
    expect(closed?.status).toBe('过时');
    expect(afterClose.memories.some((m) => m.kind === '禁写' && m.text.includes(second.text))).toBe(
      true,
    );
    brain.close();
  });

  it('简报组句无 claimId 的句子只能是未知占位', () => {
    const brain = track(openBrain(tmpBrain()));
    const { obj } = seedWorkspace(brain);
    brain.dispatch({ type: 'GENERATE_BRIEF_START', objectId: obj.id });
    brain.dispatch({ type: 'GENERATE_BRIEF_DONE' });
    const brief = brain.snapshot().briefs[0];
    expect(brief).toBeTruthy();
    const sentences = brief?.blocks.flatMap((b) => b.sentences) ?? [];
    expect(sentences.length).toBeGreaterThan(0);
    for (const s of sentences) {
      if (s.claimIds.length === 0) {
        expect(sentenceIsUnknownPlaceholder(s)).toBe(true);
      }
    }
    brain.close();
  });
});
