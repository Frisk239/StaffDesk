import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openBrain, type Brain } from '../../src/main/brain';

const dirs: string[] = [];
const brains: Brain[] = [];

function tmpFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'staffdesk-relations-'));
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

function relIds(brain: Brain, id: string): string[] {
  return brain.snapshot().objects.find((o) => o.id === id)?.relationIds ?? [];
}

function seedOrgPerson() {
  const file = tmpFile();
  const brain = track(openBrain(file));
  brain.dispatch({ type: 'ADD_WORKSPACE', name: '关系验收区', scenario: '求职面试' });
  brain.dispatch({ type: 'ADD_OBJECT', kind: '组织', name: '甲组织' });
  brain.dispatch({ type: 'ADD_OBJECT', kind: '人', name: '甲人物' });
  const objects = brain.snapshot().objects;
  const org = objects.find((o) => o.kind === '组织');
  const person = objects.find((o) => o.kind === '人');
  if (!org || !person) throw new Error('对象未写入');
  return { file, brain, org, person };
}

describe('对象关系 M22（裸边、对称双侧、仅跨种类）', () => {
  it('建关系两端 relationIds 互含对方', () => {
    const { brain, org, person } = seedOrgPerson();
    brain.dispatch({ type: 'ADD_RELATION', objectId: org.id, targetId: person.id });
    expect(relIds(brain, org.id)).toEqual([person.id]);
    expect(relIds(brain, person.id)).toEqual([org.id]);
  });

  it('重复建关系（含反向）被拒且不加边', () => {
    const { brain, org, person } = seedOrgPerson();
    brain.dispatch({ type: 'ADD_RELATION', objectId: org.id, targetId: person.id });
    const dup = brain.dispatch({ type: 'ADD_RELATION', objectId: person.id, targetId: org.id });
    expect(dup.toast?.text).toBe('这两个对象已经关联');
    expect(relIds(brain, org.id)).toEqual([person.id]);
    expect(relIds(brain, person.id)).toEqual([org.id]);
  });

  it('自指被拒', () => {
    const { brain, org } = seedOrgPerson();
    const state = brain.dispatch({ type: 'ADD_RELATION', objectId: org.id, targetId: org.id });
    expect(state.toast?.text).toBe('不能和对象自己建关系');
    expect(relIds(brain, org.id)).toEqual([]);
  });

  it('同种类对象之间不建关系', () => {
    const { brain } = seedOrgPerson();
    brain.dispatch({ type: 'ADD_OBJECT', kind: '组织', name: '乙组织' });
    const others = brain.snapshot().objects.filter((o) => o.kind === '组织');
    const [a, b] = others;
    if (!a || !b) throw new Error('缺少两个组织');
    const state = brain.dispatch({ type: 'ADD_RELATION', objectId: a.id, targetId: b.id });
    expect(state.toast?.text).toBe('同种类对象之间不建关系');
    expect(relIds(brain, a.id)).toEqual([]);
  });

  it('目标已归档被拒', () => {
    const { brain, org, person } = seedOrgPerson();
    brain.dispatch({ type: 'ARCHIVE_OBJECT', id: person.id });
    const state = brain.dispatch({ type: 'ADD_RELATION', objectId: org.id, targetId: person.id });
    expect(state.toast?.text).toBe('已归档对象不能建关系');
    expect(relIds(brain, org.id)).toEqual([]);
  });

  it('对象不存在被拒', () => {
    const { brain, org } = seedOrgPerson();
    const state = brain.dispatch({
      type: 'ADD_RELATION',
      objectId: org.id,
      targetId: 'org-不存在',
    });
    expect(state.toast?.text).toBe('对象不存在，无法建关系');
    expect(relIds(brain, org.id)).toEqual([]);
  });

  it('解除关系双侧都清；没有关系时提示且不写', () => {
    const { brain, org, person } = seedOrgPerson();
    brain.dispatch({ type: 'ADD_RELATION', objectId: org.id, targetId: person.id });
    brain.dispatch({ type: 'REMOVE_RELATION', objectId: org.id, targetId: person.id });
    expect(relIds(brain, org.id)).toEqual([]);
    expect(relIds(brain, person.id)).toEqual([]);
    const again = brain.dispatch({
      type: 'REMOVE_RELATION',
      objectId: person.id,
      targetId: org.id,
    });
    expect(again.toast?.text).toBe('这两个对象之间没有关系');
  });

  it('永久删除对象清掉对端悬边（0032 不留幽灵）', () => {
    const { brain, org, person } = seedOrgPerson();
    brain.dispatch({ type: 'ADD_RELATION', objectId: org.id, targetId: person.id });
    brain.dispatch({ type: 'ARCHIVE_OBJECT', id: org.id });
    brain.dispatch({ type: 'DELETE_OBJECT', id: org.id });
    expect(brain.snapshot().objects.some((o) => o.id === org.id)).toBe(false);
    expect(relIds(brain, person.id)).toEqual([]);
  });

  it('关系 close→reopen 持久化往返', () => {
    const { file, brain, org, person } = seedOrgPerson();
    brain.dispatch({ type: 'ADD_RELATION', objectId: org.id, targetId: person.id });
    brain.close();
    const reopened = track(openBrain(file));
    expect(relIds(reopened, org.id)).toEqual([person.id]);
    expect(relIds(reopened, person.id)).toEqual([org.id]);
  });

  it('note 设值 trim、清空写 null，reopen 往返读不回空串', () => {
    const { file, brain, org } = seedOrgPerson();
    brain.dispatch({ type: 'SET_OBJECT_NOTE', objectId: org.id, note: '  重点要搞清楚的雇主  ' });
    expect(brain.snapshot().objects.find((o) => o.id === org.id)?.note).toBe('重点要搞清楚的雇主');
    brain.close();

    const reopened = track(openBrain(file));
    expect(reopened.snapshot().objects.find((o) => o.id === org.id)?.note).toBe(
      '重点要搞清楚的雇主',
    );
    reopened.dispatch({ type: 'SET_OBJECT_NOTE', objectId: org.id, note: '   ' });
    expect(reopened.snapshot().objects.find((o) => o.id === org.id)?.note).toBeUndefined();
    reopened.close();
    expect(
      track(openBrain(file))
        .snapshot()
        .objects.find((o) => o.id === org.id)?.note,
    ).toBeUndefined();
  });

  it('note 对对象不存在只提示，不写账本', () => {
    const { brain } = seedOrgPerson();
    const before = brain.snapshot().objects.length;
    const state = brain.dispatch({ type: 'SET_OBJECT_NOTE', objectId: 'org-不存在', note: 'x' });
    expect(state.toast?.text).toBe('对象不存在，无法写备注');
    expect(brain.snapshot().objects.length).toBe(before);
  });
});
