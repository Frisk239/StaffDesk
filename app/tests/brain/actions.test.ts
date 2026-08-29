import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { closedClaims, conflictsOf, isExtracting, openBrain, type Brain } from '../../src/main/brain';
import { listUserTables } from '../../src/main/brain/migrate';

const dirs: string[] = [];
const brains: Brain[] = [];

function tmpBrain() {
  const dir = mkdtempSync(join(tmpdir(), 'staffdesk-act-'));
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

function setup() {
  const brain = track(openBrain(tmpBrain()));
  brain.dispatch({ type: 'ADD_WORKSPACE', name: '区甲', scenario: '求职面试' });
  brain.dispatch({ type: 'ADD_OBJECT', kind: '组织', name: '甲组织' });
  const obj = brain.snapshot().objects[0];
  if (!obj) throw new Error('无对象');
  brain.dispatch({
    type: 'ADD_SOURCE',
    title: 'JD',
    body: '该公司在招后端实习。团队主栈是 Go。团队也在评估 Java 方向。内部在推进平台化建设。办公地点未写。',
  });
  const source = brain.snapshot().sources.find((s) => !s.virtual);
  if (!source) throw new Error('无来源');
  brain.dispatch({ type: 'BIND_CONFIRMED', sourceId: source.id, objectIds: [obj.id] });
  expect(isExtracting(brain.snapshot(), obj.id)).toBe(true);
  brain.dispatch({ type: 'EXTRACT_DONE', sourceId: source.id });
  return { brain, obj, source };
}

describe('账本动作覆盖', () => {
  it('走完对象生命周期、槽、简报、晋升撤销、纠正、记忆', () => {
    const { brain, obj, source } = setup();
    let st = brain.snapshot();
    expect(st.claims.length).toBeGreaterThan(0);
    expect(isExtracting(st, obj.id)).toBe(false);

    const claim = st.claims[0];
    if (!claim) throw new Error('无主张');
    brain.dispatch({ type: 'OPEN_AUDIT_CARD', claimId: claim.id });
    brain.dispatch({ type: 'SELECT_CLAIM', claimId: claim.id });
    brain.dispatch({ type: 'FOCUS_SOURCE', sourceId: source.id });
    brain.dispatch({ type: 'OPEN_RIGHT_TAB', objectId: obj.id, kind: '档案' });
    brain.dispatch({ type: 'OPEN_RIGHT_TAB', objectId: obj.id, kind: '来源' });
    const tab = brain.snapshot().rightTabsByObject[obj.id]?.[0];
    if (tab) {
      brain.dispatch({ type: 'FOCUS_RIGHT_TAB', objectId: obj.id, id: tab.id });
      brain.dispatch({ type: 'CLOSE_RIGHT_TAB', objectId: obj.id, id: tab.id });
    }

    brain.dispatch({ type: 'PROMOTE_CLAIM', claimId: claim.id });
    expect(brain.snapshot().claims.find((c) => c.id === claim.id)?.unverified).toBe(false);
    const promoteCard = (brain.snapshot().chatByObject[obj.id] ?? []).find(
      (m) => m.card?.result === '晋升' && m.card.undo,
    );
    if (!promoteCard) throw new Error('无晋升卡');
    brain.dispatch({ type: 'UNDO_RESULT', objectId: obj.id, messageId: promoteCard.id });
    expect(brain.snapshot().claims.find((c) => c.id === claim.id)?.unverified).toBe(true);

    brain.dispatch({ type: 'PROMOTE_CLAIM', claimId: claim.id });
    brain.dispatch({ type: 'OPEN_CORRECT_CARD', claimId: claim.id });
    const write = brain.snapshot().writeQueue[0];
    if (!write) throw new Error('无纠正提议');
    brain.dispatch({
      type: 'CONFIRM_WRITE',
      writeId: write.id,
      closeReason: '从未成立',
      newText: '主栈其实是 Rust。',
    });
    st = brain.snapshot();
    expect(st.claims.find((c) => c.id === claim.id)?.status).toBe('过时');
    expect(closedClaims(st, obj.id).length).toBeGreaterThan(0);
    expect(st.memories.some((m) => m.kind === '禁写')).toBe(true);
    const other = st.claims.find((c) => c.id !== claim.id && c.status === '成立');
    if (other) {
      expect(conflictsOf(st, other.id).every((c) => c.id !== claim.id)).toBe(true);
    }

    const mem = st.memories.find((m) => m.kind === '禁写');
    if (mem) brain.dispatch({ type: 'REMOVE_MEMORY', id: mem.id });

    brain.dispatch({ type: 'CHAT_SEND', objectId: obj.id, text: '记下来：简报用条目' });
    expect(brain.snapshot().memories.some((m) => m.text.includes('简报用条目'))).toBe(true);

    brain.dispatch({ type: 'CHAT_SEND', objectId: obj.id, text: '这句不对' });
    brain.dispatch({ type: 'GENERATE_BRIEF_START', objectId: obj.id });
    brain.dispatch({ type: 'GENERATE_BRIEF_DONE' });
    expect(brain.snapshot().briefs.length).toBeGreaterThan(0);

    const remaining = brain.snapshot().claims.filter((c) => c.unverified && c.status === '成立');
    if (remaining.length > 0) {
      const batch = brain.snapshot().writeQueue.find((w) => w.kind === '批量晋升');
      if (batch) {
        brain.dispatch({ type: 'CONFIRM_WRITE', writeId: batch.id });
        const batchCard = (brain.snapshot().chatByObject[obj.id] ?? []).find(
          (m) => m.card?.result === '批量晋升' && m.card.undo,
        );
        if (batchCard) {
          brain.dispatch({ type: 'UNDO_RESULT', objectId: obj.id, messageId: batchCard.id });
          const back = brain.snapshot().writeQueue.find((w) => w.kind === '批量回退');
          if (back) brain.dispatch({ type: 'CONFIRM_WRITE', writeId: back.id });
        }
      }
    }

    brain.dispatch({ type: 'ADD_SLOT', name: '自定义槽', kind: '组织', arity: '单值' });
    expect(brain.snapshot().slotDefs.some((s) => s.name === '自定义槽')).toBe(true);
    brain.dispatch({ type: 'ADD_SLOT', name: '', kind: '组织', arity: '单值' });
    brain.dispatch({ type: 'ADD_SLOT', name: '未编目', kind: '组织', arity: '单值' });
    brain.dispatch({ type: 'ADD_SLOT', name: '自定义槽', kind: '组织', arity: '单值' });

    brain.dispatch({ type: 'ADD_SOURCE', title: 'url', body: 'https://example.com/jd', fromUrl: true });
    brain.dispatch({ type: 'ADD_SOURCE', title: 'pdf', body: 'binary', unparsed: true });
    brain.dispatch({ type: 'ADD_SOURCE', title: '', body: '   ' });

    brain.dispatch({ type: 'SET_VIEW', view: { kind: 'inbox' } });
    brain.dispatch({ type: 'SET_VIEW', view: { kind: 'object', objectId: obj.id } });
    brain.dispatch({ type: 'SET_THEME', preference: 'dark' });
    brain.dispatch({ type: 'SET_THINKING', effort: '高' });
    brain.dispatch({ type: 'TOAST', text: 'hello' });
    brain.dispatch({ type: 'TOAST', text: null });

    brain.dispatch({
      type: 'UPSERT_PROVIDER',
      provider: {
        id: 'p-custom',
        kind: 'custom',
        name: '自建',
        baseUrl: 'http://localhost:1234/v1',
        apiKey: '',
        protocol: 'chat-completions',
        enabled: true,
        models: [{ id: 'local', name: 'local', contextWindow: 8, maxOutput: 8 }],
      },
    });
    brain.dispatch({ type: 'SET_ACTIVE_PROVIDER', id: 'p-custom' });
    brain.dispatch({ type: 'SET_ACTIVE_MODEL', id: 'local' });
    brain.dispatch({ type: 'TEST_PROVIDER', id: 'p-custom' });
    brain.dispatch({ type: 'CERT_DONE', id: 'p-custom' });
    brain.dispatch({
      type: 'UPSERT_PROVIDER',
      provider: {
        id: 'p-custom',
        kind: 'custom',
        name: '自建改',
        baseUrl: 'http://localhost:1234/v1',
        apiKey: '',
        protocol: 'chat-completions',
        enabled: true,
        models: [{ id: 'local', name: 'local', contextWindow: 8, maxOutput: 8 }],
      },
    });
    brain.dispatch({ type: 'REMOVE_PROVIDER', id: 'p-custom' });

    brain.dispatch({ type: 'ADD_WORKSPACE', name: '区乙', scenario: '技术选型' });
    const wsB = brain.snapshot().workspaces.find((w) => w.name === '区乙');
    if (!wsB) throw new Error('无区乙');
    brain.dispatch({ type: 'SWITCH_WORKSPACE', id: wsB.id });
    brain.dispatch({ type: 'ADD_OBJECT', kind: '项目', name: '选型项目' });
    brain.dispatch({ type: 'ADD_OBJECT', kind: '人', name: '联系人' });
    const extra = brain.snapshot().objects.find((o) => o.name === '选型项目');
    if (!extra) throw new Error('无项目');
    brain.dispatch({ type: 'ARCHIVE_OBJECT', id: extra.id });
    brain.dispatch({ type: 'UNARCHIVE_OBJECT', id: extra.id });
    brain.dispatch({ type: 'ARCHIVE_OBJECT', id: extra.id });
    brain.dispatch({ type: 'DELETE_OBJECT', id: extra.id });
    expect(brain.snapshot().objects.some((o) => o.id === extra.id)).toBe(false);

    const person = brain.snapshot().objects.find((o) => o.kind === '人');
    if (person) {
      brain.dispatch({ type: 'ARCHIVE_OBJECT', id: person.id });
      brain.dispatch({ type: 'RESTORE_OBJECT', id: person.id });
    }

    brain.dispatch({ type: 'REMOVE_WORKSPACE', id: wsB.id });
    brain.dispatch({ type: 'ADD_WORKSPACE', name: '', scenario: '自定义' });
    brain.dispatch({ type: 'SWITCH_WORKSPACE', id: 'no-such' });
    brain.dispatch({ type: 'ADD_OBJECT', kind: '组织', name: '' });

    const card = (brain.snapshot().chatByObject[obj.id] ?? [])[0];
    if (card) brain.dispatch({ type: 'DISMISS_CARD', objectId: obj.id, messageId: card.id });

    brain.dispatch({
      type: 'ENQUEUE_WRITE',
      draft: {
        objectId: obj.id,
        kind: '晋升',
        headline: '空',
        evidence: 'x',
      },
    });
    const queued = brain.snapshot().writeQueue.find((w) => w.kind === '晋升');
    if (queued) brain.dispatch({ type: 'REJECT_WRITE', writeId: queued.id });

    const live = brain.snapshot().claims.find((c) => c.status === '成立' && c.unverified);
    if (live) {
      brain.dispatch({
        type: 'ENQUEUE_WRITE',
        draft: {
          objectId: obj.id,
          kind: '晋升',
          claimId: live.id,
          headline: `晋升「${live.text}」`,
          evidence: live.text,
        },
      });
      const wr = brain.snapshot().writeQueue.find((w) => w.claimId === live.id);
      if (wr) brain.dispatch({ type: 'CONFIRM_WRITE', writeId: wr.id });
    }

    brain.dispatch({
      type: 'SELF_CHECK',
      id: 'p-deepseek',
      connect: 'ok',
      capability: 'ok',
      detail: '连通与能力探测通过',
    });
    brain.dispatch({
      type: 'APPLY_RESEARCH',
      task: {
        id: 'task-test',
        objectId: obj.id,
        kind: '调研',
        status: '已完成',
        createdAt: '2026-08-29',
        budgetGear: '快搜',
      },
      audits: [{ taskId: 'task-test', seq: 1, kind: '搜索', payload: { query: 'x' }, ts: '2026-08-29' }],
      sources: [],
    });
    brain.dispatch({ type: 'SET_VIEW', view: { kind: 'replay', taskId: 'task-test' } });
    expect(brain.snapshot().taskAudits.length).toBeGreaterThan(0);
    expect(listUserTables(brain.db).length).toBeGreaterThan(5);
  });

  it('整理提议并入与丢弃、候选记忆、解绑撤销', () => {
    const { brain, obj } = setup();
    const uncat = brain.snapshot().claims.find((c) => c.predicate === '未编目');
    const claimId = uncat?.id ?? brain.snapshot().claims[0]?.id;
    if (!claimId) throw new Error('无主张');
    brain.db
      .prepare(
        `INSERT INTO proposals (id, type, payload, pending, decision, created_at, title, detail)
         VALUES (?, '整理', ?, 1, NULL, ?, '编目', '并入使用技术')`,
      )
      .run(
        'prop-tidy',
        JSON.stringify({ kind: '整理', claimId, targetPredicate: '使用技术' }),
        new Date().toISOString(),
      );
    brain.dispatch({ type: 'OPEN_PROPOSAL_CARD', proposalId: 'prop-tidy' });
    const wr = brain.snapshot().writeQueue.find((w) => w.kind === '整理');
    if (wr) brain.dispatch({ type: 'CONFIRM_WRITE', writeId: wr.id });

    brain.db
      .prepare(
        `INSERT INTO proposals (id, type, payload, pending, decision, created_at, title, detail)
         VALUES (?, '整理', ?, 1, NULL, ?, '丢弃', '丢弃未核')`,
      )
      .run(
        'prop-drop',
        JSON.stringify({
          kind: '丢弃未核',
          claimIds: [brain.snapshot().claims[0]?.id ?? claimId],
        }),
        new Date().toISOString(),
      );
    brain.dispatch({
      type: 'PROPOSAL_DECIDE',
      proposalId: 'prop-drop',
      decision: 'accept-drop',
    });

    brain.db
      .prepare(
        `INSERT INTO proposals (id, type, payload, pending, decision, created_at, title, detail)
         VALUES (?, '候选记忆', ?, 1, NULL, ?, '偏好', '短回复')`,
      )
      .run(
        'prop-mem',
        JSON.stringify({
          kind: '候选记忆',
          text: '回复偏短',
          memoryKind: '偏好',
          fromObjectId: obj.id,
          scope: '全局',
        }),
        new Date().toISOString(),
      );
    brain.dispatch({ type: 'PROPOSAL_DECIDE', proposalId: 'prop-mem', decision: 'accept-merge' });
    brain.db
      .prepare(
        `INSERT INTO proposals (id, type, payload, pending, decision, created_at, title, detail)
         VALUES (?, '候选记忆', ?, 1, NULL, ?, '偏好2', '驳回')`,
      )
      .run(
        'prop-mem2',
        JSON.stringify({
          kind: '候选记忆',
          text: '另一条',
          memoryKind: '偏好',
          fromObjectId: obj.id,
          scope: '对象',
        }),
        new Date().toISOString(),
      );
    brain.dispatch({ type: 'PROPOSAL_DECIDE', proposalId: 'prop-mem2', decision: 'reject' });

    const bindCard = (brain.snapshot().chatByObject[obj.id] ?? []).find((m) => m.card?.undo?.kind === '绑定');
    if (bindCard) {
      brain.dispatch({ type: 'UNDO_RESULT', objectId: obj.id, messageId: bindCard.id });
    }

    brain.dispatch({ type: 'CHAT_SEND', objectId: obj.id, text: '删掉这个对象' });
    brain.dispatch({ type: 'MARK_TURN_PLAYED', objectId: obj.id, messageId: 'nope' });
  });
});
