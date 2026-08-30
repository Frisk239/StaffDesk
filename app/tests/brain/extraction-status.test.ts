import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openBrain, type Brain } from '../../src/main/brain';

const dirs: string[] = [];
const brains: Brain[] = [];

afterEach(() => {
  while (brains.length) brains.pop()?.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'staffdesk-extraction-status-'));
  dirs.push(dir);
  const brain = openBrain(join(dir, 'brain.db'));
  brains.push(brain);
  brain.dispatch({ type: 'ADD_WORKSPACE', name: '真实测试区', scenario: '求职面试' });
  brain.dispatch({ type: 'ADD_OBJECT', kind: '组织', name: '测试组织' });
  const object = brain.snapshot().objects[0]!;
  brain.dispatch({ type: 'ADD_SOURCE', title: '材料', body: '测试组织使用 Rust。' });
  const source = brain.snapshot().sources.find((item) => !item.virtual)!;
  brain.dispatch({ type: 'BIND_CONFIRMED', sourceId: source.id, objectIds: [object.id] });
  return { brain, object, source };
}

describe('抽取终态', () => {
  it('失败、重试和未配置保持为不同状态与结果说明', () => {
    const { brain, object, source } = setup();
    brain.dispatch({
      type: 'EXTRACT_DONE',
      sourceId: source.id,
      outcome: 'invalid-output',
      detail: '模型没有返回可解析的 JSON',
    });
    expect(brain.snapshot().extractJobs[0]).toMatchObject({
      sourceId: source.id,
      status: '失败',
    });
    expect(brain.snapshot().chatByObject[object.id]?.at(-1)?.text).toContain('抽取未完成');

    brain.dispatch({ type: 'RETRY_EXTRACTION', sourceId: source.id });
    expect(brain.snapshot().extractJobs[0]?.status).toBe('抽取中');

    brain.dispatch({
      type: 'EXTRACT_DONE',
      sourceId: source.id,
      outcome: 'unconfigured',
      detail: '尚未配置可调用的模型',
    });
    expect(brain.snapshot().extractJobs[0]?.status).toBe('未配置');
    expect(brain.snapshot().chatByObject[object.id]?.at(-1)?.text).toContain('还没有可调用的模型');
    expect(brain.snapshot().claims).toHaveLength(0);
  });
});
