import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Action } from '../../src/shared/actions';
import { openBrain, type Brain } from '../../src/main/brain';
import { createExtractionJobExecutor } from '../../src/main/extraction';

const dirs: string[] = [];
const brains: Brain[] = [];

afterEach(() => {
  while (brains.length) brains.pop()?.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup(): { brain: Brain; sourceId: string } {
  const dir = mkdtempSync(join(tmpdir(), 'staffdesk-extraction-job-'));
  dirs.push(dir);
  const brain = openBrain(join(dir, 'brain.db'));
  brains.push(brain);
  brain.dispatch({ type: 'ADD_WORKSPACE', name: '抽取终态', scenario: '求职面试' });
  brain.dispatch({ type: 'ADD_OBJECT', kind: '组织', name: '示例公司' });
  const object = brain.snapshot().objects[0]!;
  brain.dispatch({ type: 'ADD_SOURCE', title: '材料', body: '示例公司使用 Rust。' });
  const source = brain.snapshot().sources.find((item) => !item.virtual)!;
  brain.dispatch({ type: 'BIND_CONFIRMED', sourceId: source.id, objectIds: [object.id] });
  return { brain, sourceId: source.id };
}

describe('抽取作业执行器', () => {
  it('意外的编排异常落为脱敏后的失败终态', async () => {
    const { brain, sourceId } = setup();
    const execute = createExtractionJobExecutor({
      brain,
      publish: () => undefined,
      extract: async () => {
        throw new Error('request failed with Bearer secret-value and sk-private-token');
      },
    });

    const next = await execute(sourceId);

    expect(next.extractJobs.find((job) => job.sourceId === sourceId)).toMatchObject({
      status: '失败',
    });
    const detail = next.extractJobs.find((job) => job.sourceId === sourceId)?.detail ?? '';
    expect(detail).toContain('抽取编排失败');
    expect(detail).not.toContain('secret-value');
    expect(detail).not.toContain('private-token');
  });

  it('正常与失败终态落库都抛错时，作业态仍能收口', async () => {
    const { brain, sourceId } = setup();
    brain.dispatch = ((_action: Action) => {
      throw new Error('persist unavailable');
    }) as Brain['dispatch'];
    const execute = createExtractionJobExecutor({
      brain,
      publish: () => undefined,
      extract: async () => {
        throw new Error('orchestration unavailable');
      },
    });

    const next = await execute(sourceId);

    expect(next.extractJobs.find((job) => job.sourceId === sourceId)).toMatchObject({
      status: '失败',
    });
    expect(next.extractJobs.some((job) => job.status === '抽取中')).toBe(false);
    expect(next.extractJobs.find((job) => job.sourceId === sourceId)?.detail).toContain(
      '终态落库失败',
    );
  });

  it('广播抛错时作业记失败，且不重复派发第二次结果', async () => {
    const { brain, sourceId } = setup();
    const originalDispatch = brain.dispatch.bind(brain);
    let terminalDispatches = 0;
    brain.dispatch = ((action: Action) => {
      if (action.type === 'EXTRACT_DONE') terminalDispatches += 1;
      return originalDispatch(action);
    }) as Brain['dispatch'];
    const execute = createExtractionJobExecutor({
      brain,
      publish: () => {
        throw new Error('window was destroyed');
      },
      extract: async () => ({
        status: 'success',
        claims: [],
        draftCount: 0,
        rejectedCount: 0,
      }),
    });

    const next = await execute(sourceId);

    expect(terminalDispatches).toBe(1);
    expect(next.extractJobs.find((job) => job.sourceId === sourceId)?.status).toBe('失败');
    expect(next.extractJobs.some((job) => job.status === '抽取中')).toBe(false);
  });
});
