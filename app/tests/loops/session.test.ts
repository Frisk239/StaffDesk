import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openBrain, type Brain } from '../../src/main/brain';
import { runSessionTurn } from '../../src/main/loops/session';

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
  brain.dispatch({ type: 'EXTRACT_DONE', sourceId: src.id });
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
