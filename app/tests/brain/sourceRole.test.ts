import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openBrain, type Brain } from '../../src/main/brain';
import { bindingRole, primaryBackedClaimsNoLongerLive } from '@shared/primarySource';
import { completeExtraction } from '../helpers/extraction';

const dirs: string[] = [];
const brains: Brain[] = [];

function tmpBrain() {
  const dir = mkdtempSync(join(tmpdir(), 'staffdesk-role-'));
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

function setup(name = '甲组织') {
  const brain = track(openBrain(tmpBrain()));
  brain.dispatch({ type: 'ADD_WORKSPACE', name: '区甲', scenario: '求职面试' });
  brain.dispatch({ type: 'ADD_OBJECT', kind: '组织', name });
  const obj = brain.snapshot().objects[0];
  if (!obj) throw new Error('无对象');
  return { brain, obj };
}

describe('绑定级主键角色 0062', () => {
  it('新绑定默认转述；SET_SOURCE_ROLE 只改当前对象，operations 留痕，可补偿撤销', () => {
    const { brain, obj } = setup();
    brain.dispatch({ type: 'ADD_OBJECT', kind: '组织', name: '乙组织' });
    const other = brain.snapshot().objects.find((item) => item.name === '乙组织');
    if (!other) throw new Error('无乙');
    brain.dispatch({
      type: 'ADD_SOURCE',
      title: '同一材料',
      body: '两边都能用的材料。',
    });
    const source = brain.snapshot().sources.find((item) => !item.virtual);
    if (!source) throw new Error('无来源');
    brain.dispatch({
      type: 'BIND_CONFIRMED',
      sourceId: source.id,
      objectIds: [obj.id, other.id],
    });
    let st = brain.snapshot();
    const bound = st.sources.find((item) => item.id === source.id);
    if (!bound) throw new Error('无绑定');
    expect(bindingRole(bound, obj.id)).toBe('转述');
    expect(bindingRole(bound, other.id)).toBe('转述');

    brain.dispatch({
      type: 'SET_SOURCE_ROLE',
      sourceId: source.id,
      objectId: obj.id,
      role: '主键',
    });
    st = brain.snapshot();
    const after = st.sources.find((item) => item.id === source.id);
    if (!after) throw new Error('无来源');
    expect(bindingRole(after, obj.id)).toBe('主键');
    expect(bindingRole(after, other.id)).toBe('转述');
    const ops = brain.db
      .prepare("SELECT action FROM operations WHERE action = 'SET_SOURCE_ROLE'")
      .all() as { action: string }[];
    expect(ops.length).toBeGreaterThan(0);

    const card = [...(st.chatByObject[obj.id] ?? [])].reverse().find((m) => m.card?.undo);
    if (!card?.card?.undo || !('kind' in card.card.undo)) throw new Error('无撤销卡');
    brain.dispatch({ type: 'UNDO_RESULT', objectId: obj.id, messageId: card.id });
    const undone = brain.snapshot().sources.find((item) => item.id === source.id);
    expect(undone && bindingRole(undone, obj.id)).toBe('转述');
  });

  it('域名一致时绑定只出建议卡，确认才标主键，拒绝保持转述', () => {
    const { brain, obj } = setup();
    brain.dispatch({
      type: 'SET_OBJECT_NOTE',
      objectId: obj.id,
      note: '官网 https://zhanqiao.dev',
    });
    brain.dispatch({
      type: 'ADD_SOURCE',
      title: 'https://zhanqiao.dev/about',
      body: '栈桥科技官网摘录。',
    });
    const source = brain.snapshot().sources.find((item) => !item.virtual);
    if (!source) throw new Error('无来源');
    brain.dispatch({ type: 'BIND_CONFIRMED', sourceId: source.id, objectIds: [obj.id] });
    let st = brain.snapshot();
    const bound = st.sources.find((item) => item.id === source.id);
    expect(bound && bindingRole(bound, obj.id)).toBe('转述');
    const write = st.writeQueue.find((w) => w.kind === '设角色' && w.role === '主键');
    expect(write?.headline).toBe('建议标为主键？');
    if (!write) throw new Error('无建议卡');

    brain.dispatch({ type: 'REJECT_WRITE', writeId: write.id });
    st = brain.snapshot();
    const still = st.sources.find((item) => item.id === source.id);
    expect(still && bindingRole(still, obj.id)).toBe('转述');

    brain.dispatch({
      type: 'ENQUEUE_WRITE',
      draft: {
        objectId: obj.id,
        kind: '设角色',
        sourceId: source.id,
        role: '主键',
        headline: '建议标为主键？',
        evidence: '重试',
      },
    });
    const again = brain.snapshot().writeQueue.find((w) => w.kind === '设角色');
    if (!again) throw new Error('无第二张建议卡');
    brain.dispatch({ type: 'CONFIRM_WRITE', writeId: again.id });
    const marked = brain.snapshot().sources.find((item) => item.id === source.id);
    expect(marked && bindingRole(marked, obj.id)).toBe('主键');
  });

  it('角色落在绑定表，重开大脑仍按对象读回，不回头写到来源行', () => {
    const file = tmpBrain();
    const brain = track(openBrain(file));
    brain.dispatch({ type: 'ADD_WORKSPACE', name: '区甲', scenario: '求职面试' });
    brain.dispatch({ type: 'ADD_OBJECT', kind: '组织', name: '甲组织' });
    const obj = brain.snapshot().objects[0];
    if (!obj) throw new Error('无对象');
    brain.dispatch({ type: 'ADD_SOURCE', title: '材料', body: '正文' });
    const source = brain.snapshot().sources.find((item) => !item.virtual);
    if (!source) throw new Error('无来源');
    brain.dispatch({ type: 'BIND_CONFIRMED', sourceId: source.id, objectIds: [obj.id] });
    brain.dispatch({
      type: 'SET_SOURCE_ROLE',
      sourceId: source.id,
      objectId: obj.id,
      role: '主键',
    });
    const row = brain.db
      .prepare('SELECT role FROM source_bindings WHERE source_id = ? AND object_id = ?')
      .get(source.id, obj.id) as { role: string };
    expect(row.role).toBe('主键');
    const sourceRow = brain.db.prepare('SELECT role FROM sources WHERE id = ?').get(source.id) as {
      role: string | null;
    };
    expect(sourceRow.role).toBeNull();
    brain.close();
    const again = track(openBrain(file));
    const reloaded = again.snapshot().sources.find((item) => item.id === source.id);
    expect(reloaded && bindingRole(reloaded, obj.id)).toBe('主键');
  });
});

describe('主键新版过时 0062', () => {
  it('人确认才关窗，关闭原因是被主键新版取代，补偿可重开', () => {
    const { brain, obj } = setup();
    brain.dispatch({ type: 'ADD_SOURCE', title: '旧官网', body: '主栈是 Go。' });
    brain.dispatch({ type: 'ADD_SOURCE', title: '新官网', body: '主栈是 Rust。' });
    const st0 = brain.snapshot();
    const oldSrc = st0.sources.find((item) => item.title === '旧官网' && !item.virtual);
    const newSrc = st0.sources.find((item) => item.title === '新官网' && !item.virtual);
    if (!oldSrc || !newSrc) throw new Error('无来源');
    brain.dispatch({ type: 'BIND_CONFIRMED', sourceId: oldSrc.id, objectIds: [obj.id] });
    brain.dispatch({
      type: 'SET_SOURCE_ROLE',
      sourceId: oldSrc.id,
      objectId: obj.id,
      role: '主键',
    });
    brain.dispatch({
      type: 'EXTRACT_DONE',
      sourceId: oldSrc.id,
      claims: [
        {
          id: 'cl-old',
          objectId: obj.id,
          predicate: '后端主栈',
          text: '主栈是 Go',
          status: '成立',
          unverified: false,
          sourceId: oldSrc.id,
          span: '主栈是 Go',
          validFrom: '2024-01-01',
          createdAt: '2024-01-01',
        },
      ],
    });
    brain.dispatch({ type: 'BIND_CONFIRMED', sourceId: newSrc.id, objectIds: [obj.id] });
    brain.dispatch({
      type: 'SET_SOURCE_ROLE',
      sourceId: newSrc.id,
      objectId: obj.id,
      role: '主键',
    });
    brain.dispatch({
      type: 'EXTRACT_DONE',
      sourceId: newSrc.id,
      claims: [
        {
          id: 'cl-new',
          objectId: obj.id,
          predicate: '后端主栈',
          text: '主栈是 Rust',
          status: '成立',
          unverified: false,
          sourceId: newSrc.id,
          span: '主栈是 Rust',
          validFrom: '2026-06-01',
          createdAt: '2026-06-01',
        },
      ],
    });
    const prop = brain
      .snapshot()
      .proposals.find((p) => p.pending && p.payload.kind === '主键新版过时');
    expect(prop?.title).toBe('建议：旧版过时？');
    if (!prop) throw new Error('无提议');
    brain.dispatch({ type: 'PROPOSAL_DECIDE', proposalId: prop.id, decision: 'accept-close' });
    const closed = brain.snapshot().claims.find((c) => c.id === 'cl-old');
    expect(closed?.status).toBe('过时');
    expect(closed?.closeReason).toBe('被主键新版取代');
    const card = [...(brain.snapshot().chatByObject[obj.id] ?? [])]
      .reverse()
      .find((m) => m.card?.result === '关窗' && m.card.undo);
    if (!card) throw new Error('无关窗撤销卡');
    brain.dispatch({ type: 'UNDO_RESULT', objectId: obj.id, messageId: card.id });
    expect(brain.snapshot().claims.find((c) => c.id === 'cl-old')?.status).toBe('成立');
  });
});

describe('转述不得关窗主键主张 0062', () => {
  it('抽取转述来源的冲突主张后，主键背书的旧主张仍成立', () => {
    const { brain, obj } = setup();
    brain.dispatch({ type: 'ADD_SOURCE', title: '官网', body: '主栈是 Go。' });
    brain.dispatch({ type: 'ADD_SOURCE', title: '媒体报道', body: '主栈是 Java。' });
    const st0 = brain.snapshot();
    const primary = st0.sources.find((item) => item.title === '官网' && !item.virtual);
    const transcript = st0.sources.find((item) => item.title === '媒体报道' && !item.virtual);
    if (!primary || !transcript) throw new Error('无来源');
    brain.dispatch({ type: 'BIND_CONFIRMED', sourceId: primary.id, objectIds: [obj.id] });
    brain.dispatch({
      type: 'SET_SOURCE_ROLE',
      sourceId: primary.id,
      objectId: obj.id,
      role: '主键',
    });
    completeExtraction(brain, primary.id, [
      { predicate: '后端主栈', text: '主栈是 Go', span: '主栈是 Go' },
    ]);
    const live = brain.snapshot().claims.find((c) => c.sourceId === primary.id);
    if (!live) throw new Error('无主键主张');
    expect(live.status).toBe('成立');

    brain.dispatch({ type: 'BIND_CONFIRMED', sourceId: transcript.id, objectIds: [obj.id] });
    const prev = brain.snapshot();
    completeExtraction(brain, transcript.id, [
      { predicate: '后端主栈', text: '主栈是 Java', span: '主栈是 Java' },
    ]);
    const next = brain.snapshot();
    expect(primaryBackedClaimsNoLongerLive(prev, next)).toEqual([]);
    expect(next.claims.find((c) => c.id === live.id)?.status).toBe('成立');
    expect(
      next.claims.filter((c) => c.predicate === '后端主栈' && c.status === '成立'),
    ).toHaveLength(2);
  });
});
