import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openBrain, type Brain } from '../../src/main/brain';
import { runSessionTurn, stripClaimRefs } from '../../src/main/loops/session';
import { completeExtraction } from '../helpers/extraction';

const brains: Brain[] = [];
const dirs: string[] = [];

function track(b: Brain): Brain {
  brains.push(b);
  return b;
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
    const d = dirs.pop();
    if (d) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        /* lock */
      }
    }
  }
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'sd-session-'));
  dirs.push(dir);
  const brain = track(openBrain(join(dir, 'brain.db')));
  brain.dispatch({ type: 'ADD_WORKSPACE', name: '区', scenario: '求职面试' });
  brain.dispatch({ type: 'ADD_OBJECT', kind: '组织', name: '验收组织' });
  const obj = brain.snapshot().objects[0];
  if (!obj) throw new Error('无对象');
  brain.dispatch({
    type: 'ADD_SOURCE',
    title: '材料',
    body: '该公司在招后端实习。团队主栈是 Go。',
  });
  const src = brain.snapshot().sources.find((s) => !s.virtual);
  if (!src) throw new Error('无来源');
  brain.dispatch({ type: 'BIND_CONFIRMED', sourceId: src.id, objectIds: [obj.id] });
  completeExtraction(brain, src.id, [
    { predicate: '在招岗位', text: '该公司在招后端实习', span: '该公司在招后端实习' },
    { predicate: '后端主栈', text: '团队主栈是 Go', span: '团队主栈是 Go' },
  ]);
  return { brain, obj };
}

describe('主会话循环', () => {
  it('闲聊不写主张；引用只能是已有主张 ID', async () => {
    const { brain, obj } = setup();
    const before = brain.snapshot();
    const n = before.claims.length;
    expect(n).toBeGreaterThan(0);
    const fakeId = 'cl-forged';
    const reply = await runSessionTurn(before, obj.id, '技术栈是什么？', {
      db: brain.db,
      complete: async () => ({
        content: `按账本，主栈相关见 [ref:${before.claims[0]?.id}] 和 [ref:${fakeId}]`,
        toolCalls: [],
      }),
    });
    expect(reply.claimRefs).toContain(before.claims[0]?.id);
    expect(reply.claimRefs).not.toContain(fakeId);
    expect(reply.replyText).not.toContain('[ref:');
    expect(reply.replyText).toContain('按账本，主栈相关见');
    expect(brain.snapshot().claims.length).toBe(n);
    brain.dispatch({ type: 'CHAT_SEND', objectId: obj.id, text: '随便聊聊天气' });
    expect(brain.snapshot().claims.length).toBe(n);
  });

  it('只读工具 recall_claims 不把未绑定来源带进语境', async () => {
    const { brain, obj } = setup();
    const state = brain.snapshot();
    const sawUnbound = false;
    await runSessionTurn(state, obj.id, '召回一下', {
      complete: async (req) => {
        if (req.messages.some((m) => m.role === 'tool')) {
          return { content: '好', toolCalls: [] };
        }
        return {
          content: '',
          toolCalls: [
            {
              id: 'c1',
              type: 'function',
              function: { name: 'recall_claims', arguments: '{"query":"主栈"}' },
            },
          ],
        };
      },
    });
    expect(sawUnbound).toBe(false);
  });
});

describe('会话正文剥离引用标记', () => {
  it('合法引用从正文剥离，引用卡仍能解析', async () => {
    const { brain, obj } = setup();
    const state = brain.snapshot();
    const claimId = state.claims[0]?.id;
    if (!claimId) throw new Error('无主张');
    const reply = await runSessionTurn(state, obj.id, '办公地点在哪？', {
      complete: async () => ({
        content: `走查样例的办公地点在杭州。[ref:${claimId}]`,
        toolCalls: [],
      }),
    });
    expect(reply.replyText).toBe('走查样例的办公地点在杭州。');
    expect(reply.replyText).not.toContain('[ref:');
    expect(reply.claimRefs).toEqual([claimId]);
  });

  it('非法引用不能原样泄漏', () => {
    expect(stripClaimRefs('地点在杭州。[ref:cl-forged]')).toBe('地点在杭州。');
    expect(stripClaimRefs('地点在杭州。[ref:]')).toBe('地点在杭州。');
    expect(stripClaimRefs('地点在杭州。[ref:not an id!]')).toBe('地点在杭州。');
  });

  it('重复引用全部剥离，白名单仍只收合法 ID', async () => {
    const { brain, obj } = setup();
    const state = brain.snapshot();
    const claimId = state.claims[0]?.id;
    if (!claimId) throw new Error('无主张');
    const reply = await runSessionTurn(state, obj.id, '主栈？', {
      complete: async () => ({
        content: `主栈是 Go。[ref:${claimId}] 详见 [ref:${claimId}][ref:cl-forged]`,
        toolCalls: [],
      }),
    });
    expect(reply.replyText).toBe('主栈是 Go。详见');
    expect(reply.replyText).not.toContain('[ref:');
    expect(reply.claimRefs).toEqual([claimId, claimId]);
  });

  it('紧邻标点的引用剥离后标点仍在', () => {
    expect(stripClaimRefs('杭州[ref:cl-1]。')).toBe('杭州。');
    expect(stripClaimRefs('杭州。[ref:cl-1]')).toBe('杭州。');
    expect(stripClaimRefs('杭州 [ref:cl-1]。')).toBe('杭州。');
    expect(stripClaimRefs('杭州，[ref:cl-a]上海。[ref:cl-b]')).toBe('杭州，上海。');
  });
});
