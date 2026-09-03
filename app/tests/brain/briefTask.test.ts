import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openBrain, type Brain } from '../../src/main/brain';

const dirs: string[] = [];
const brains: Brain[] = [];

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
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* lock */
    }
  }
});

function seed(): { brain: Brain; objectId: string } {
  const dir = mkdtempSync(join(tmpdir(), 'sd-brief-task-'));
  dirs.push(dir);
  const brain = track(openBrain(join(dir, 'brain.db')));
  brain.dispatch({ type: 'ADD_WORKSPACE', name: '区', scenario: '求职面试' });
  brain.dispatch({ type: 'ADD_OBJECT', kind: '组织', name: '验收组织' });
  const objectId = brain.snapshot().objects[0]?.id;
  if (!objectId) throw new Error('无对象');
  return { brain, objectId };
}

describe('出简报任务审计（0018/0049）', () => {
  it('生成简报落稳定顺序的审计步骤，回放数据非空', () => {
    const { brain, objectId } = seed();
    brain.dispatch({ type: 'GENERATE_BRIEF_START', objectId });
    brain.dispatch({ type: 'GENERATE_BRIEF_DONE' });
    const state = brain.snapshot();
    const task = state.tasks.find((item) => item.kind === '出简报');
    expect(task?.status).toBe('已完成');
    expect(task?.id).toBe(state.briefs[0]?.taskId);
    const rows = state.taskAudits
      .filter((audit) => audit.taskId === task?.id)
      .sort((a, b) => a.seq - b.seq);
    expect(rows.map((row) => row.kind)).toEqual(['开始', '组装', '出站校验', '完成']);
    expect(rows.map((row) => row.seq)).toEqual([1, 2, 3, 4]);
    expect(rows.every((row) => typeof row.ts === 'string' && row.ts.length > 0)).toBe(true);
  });

  it('失败的简报任务记下失败阶段与脱敏摘要', () => {
    const { brain, objectId } = seed();
    brain.dispatch({ type: 'GENERATE_BRIEF_START', objectId });
    brain.dispatch({ type: 'GENERATE_BRIEF_DONE', error: '模型超时' });
    const state = brain.snapshot();
    const task = state.tasks.find((item) => item.kind === '出简报');
    expect(task?.status).toBe('已停止');
    expect(task?.stopReason).toBe('失败');
    expect(state.briefs).toHaveLength(0);
    const rows = state.taskAudits
      .filter((audit) => audit.taskId === task?.id)
      .sort((a, b) => a.seq - b.seq);
    expect(rows.map((row) => row.kind)).toEqual(['开始', '失败']);
    expect(rows[1]?.payload).toMatchObject({ stage: '组装', detail: '模型超时' });
    expect(state.toast?.text).toContain('简报生成失败');
    expect(state.briefDraftingFor).toBeNull();
  });
});
