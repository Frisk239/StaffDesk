import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FEE_AUDIT_KIND, MISSING_USAGE_NOTE, parseFeePayload } from '@shared/taskFee';
import type { State } from '@shared/types';
import type { ReachAdapter, ReachPath, SearchHit } from '../../src/main/adapters/reach';
import { openBrain, type Brain } from '../../src/main/brain';
import { applyResearchRun } from '../../src/main/tasks/applyResearchRun';

const dirs: string[] = [];
const brains: Brain[] = [];

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
      /* lock */
    }
  }
});

function seededBrain(): { brain: Brain; objectId: string } {
  const dir = mkdtempSync(join(tmpdir(), 'staffdesk-research-run-'));
  dirs.push(dir);
  const brain = openBrain(join(dir, 'brain.db'));
  brains.push(brain);
  brain.dispatch({ type: 'ADD_WORKSPACE', name: '区甲', scenario: '求职面试' });
  brain.dispatch({ type: 'ADD_OBJECT', kind: '组织', name: '甲组织' });
  const object = brain.snapshot().objects[0];
  if (!object) throw new Error('种子对象未落账');
  return { brain, objectId: object.id };
}

/** 单路假路径：体检恒绿，search 行为由调用方给定——两个假 reach 共用同一形状。 */
function fakeExaPath(search: (query: string) => Promise<SearchHit[]>): ReachPath {
  return {
    name: 'Exa',
    doctorCheck: async () => ({ ok: true, detail: 'ok' }),
    search,
  };
}

/** 空结果假 reach：一步走完循环，不产生来源、不触抽取。 */
function emptyReach(): ReachAdapter {
  return {
    paths: [fakeExaPath(async () => [])],
    doctor: async () => ({
      ok: true,
      detail: 'ok',
      paths: [{ name: 'Exa', ok: true, detail: 'ok' }],
    }),
    open: async (url) => ({ url, ok: false, body: '', error: '不应打开' }),
  };
}

/** 挂起在 search 的假 reach：测试可精确控制「引擎还活着」的窗口。 */
function pendingReach(): { reach: ReachAdapter; started: () => boolean; finish: () => void } {
  let called = false;
  let resolveSearch: ((hits: SearchHit[]) => void) | undefined;
  const reach: ReachAdapter = {
    paths: [
      fakeExaPath(() => {
        called = true;
        return new Promise<SearchHit[]>((resolve) => {
          resolveSearch = resolve;
        });
      }),
    ],
    doctor: async () => ({
      ok: true,
      detail: 'ok',
      paths: [{ name: 'Exa', ok: true, detail: 'ok' }],
    }),
    open: async (url) => ({ url, ok: false, body: '', error: '不应打开' }),
  };
  return { reach, started: () => called, finish: () => resolveSearch?.([]) };
}

async function waitUntil(cond: () => boolean, label: string): Promise<void> {
  for (let round = 0; round < 200 && !cond(); round += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  if (!cond()) throw new Error(`等待超时：${label}`);
}

function requireState(next: State | null): State {
  if (!next) throw new Error('应返回收尾态而不是让位');
  return next;
}

describe('调研收口编排', () => {
  it('空结果调研完整走完：任务与审计落账，锁随收尾释放', async () => {
    const { brain, objectId } = seededBrain();
    const current: Brain | null = brain;
    const getBrain = (): Brain | null => current;
    const onBusy = vi.fn();
    const state = requireState(
      await applyResearchRun({
        getBrain,
        publish: () => {},
        objectId,
        gear: '快搜',
        options: {},
        reach: emptyReach(),
        onBusy,
      }),
    );
    expect(onBusy).not.toHaveBeenCalled();
    const task = state.tasks.find((item) => item.objectId === objectId);
    expect(task?.status).toBe('已完成');
    expect(task?.stopReason).toBeUndefined();
    const kinds = state.taskAudits
      .filter((audit) => audit.taskId === task?.id)
      .map((audit) => audit.kind);
    for (const kind of ['开始', '体检', '搜索', '搜索结果', '空结果', '停止']) {
      expect(kinds).toContain(kind);
    }
    expect(state.sources.some((source) => source.origin?.kind === 'research')).toBe(false);
    // 收尾后锁已释放：同对象再来一次不走 busy。
    const again = await applyResearchRun({
      getBrain,
      publish: () => {},
      objectId,
      gear: '快搜',
      options: {},
      reach: emptyReach(),
      onBusy,
    });
    expect(onBusy).not.toHaveBeenCalled();
    expect(requireState(again).tasks.filter((item) => item.objectId === objectId)).toHaveLength(2);
  });

  it('同对象在跑时第二次调用走 onBusy 早退并返回 null，不双开任务', async () => {
    const { brain, objectId } = seededBrain();
    const current: Brain | null = brain;
    const getBrain = (): Brain | null => current;
    const pending = pendingReach();
    const onBusy = vi.fn();
    const first = applyResearchRun({
      getBrain,
      publish: () => {},
      objectId,
      gear: '快搜',
      options: {},
      reach: pending.reach,
    });
    await waitUntil(pending.started, '引擎进入 search');
    const second = await applyResearchRun({
      getBrain,
      publish: () => {},
      objectId,
      gear: '快搜',
      options: {},
      reach: emptyReach(),
      onBusy,
    });
    expect(onBusy).toHaveBeenCalledTimes(1);
    expect(second).toBeNull();
    expect(brain.snapshot().tasks.filter((item) => item.status === '进行中')).toHaveLength(1);
    pending.finish();
    const done = requireState(await first);
    expect(done.tasks.filter((item) => item.objectId === objectId)).toHaveLength(1);
    expect(done.tasks.some((item) => item.status === '进行中')).toBe(false);
  });

  it('锁建立后首笔广播抛错：调用 reject 但锁照 finally 释放（锁泄漏回归钉）', async () => {
    const { brain, objectId } = seededBrain();
    const current: Brain | null = brain;
    const getBrain = (): Brain | null => current;
    const onBusy = vi.fn();
    const exploding = vi.fn((): void => {
      throw new Error('广播失败');
    });
    // 修复前：TASK_RUN_STARTED 的 dispatch/publish 在 try 外抛出，finally 从未跑过，
    // 该对象永久 busy——本用例第二次调用就是回归钉。
    await expect(
      applyResearchRun({
        getBrain,
        publish: exploding,
        objectId,
        gear: '快搜',
        options: {},
        reach: emptyReach(),
        onBusy,
      }),
    ).rejects.toThrow('广播失败');
    expect(exploding).toHaveBeenCalledTimes(1);
    const state = requireState(
      await applyResearchRun({
        getBrain,
        publish: () => {},
        objectId,
        gear: '快搜',
        options: {},
        reach: emptyReach(),
        onBusy,
      }),
    );
    expect(onBusy).not.toHaveBeenCalled();
    expect(state.tasks.at(-1)?.status).toBe('已完成');
  });

  it('引擎抛出（体检 reject）时调用向上 reject，锁已释放', async () => {
    const { brain, objectId } = seededBrain();
    const current: Brain | null = brain;
    const getBrain = (): Brain | null => current;
    const onBusy = vi.fn();
    const boom: ReachAdapter = {
      doctor: () => Promise.reject(new Error('体检炸了')),
      paths: [],
      open: async (url) => ({ url, ok: false, body: '', error: '不应打开' }),
    };
    await expect(
      applyResearchRun({
        getBrain,
        publish: () => {},
        objectId,
        gear: '快搜',
        options: {},
        reach: boom,
        onBusy,
      }),
    ).rejects.toThrow('体检炸了');
    const state = requireState(
      await applyResearchRun({
        getBrain,
        publish: () => {},
        objectId,
        gear: '快搜',
        options: {},
        reach: emptyReach(),
        onBusy,
      }),
    );
    expect(onBusy).not.toHaveBeenCalled();
    expect(state.tasks.at(-1)?.status).toBe('已完成');
  });

  it('搜索抛错按失败收尾不抛：任务已停止记失败，审计记搜索失败', async () => {
    const { brain, objectId } = seededBrain();
    const current: Brain | null = brain;
    const failing: ReachAdapter = {
      paths: [
        {
          name: 'Exa',
          doctorCheck: async () => ({ ok: true, detail: 'ok' }),
          search: async () => {
            throw new Error('检索不可用');
          },
        },
      ],
      doctor: async () => ({
        ok: true,
        detail: 'ok',
        paths: [{ name: 'Exa', ok: true, detail: 'ok' }],
      }),
      open: async (url) => ({ url, ok: false, body: '', error: '不应打开' }),
    };
    const state = requireState(
      await applyResearchRun({
        getBrain: () => current,
        publish: () => {},
        objectId,
        gear: '快搜',
        options: {},
        reach: failing,
      }),
    );
    const task = state.tasks.find((item) => item.objectId === objectId);
    expect(task?.status).toBe('已停止');
    expect(task?.stopReason).toBe('失败');
    expect(state.taskAudits.some((audit) => audit.kind === '搜索失败')).toBe(true);
    expect(state.sources.some((source) => source.origin?.kind === 'research')).toBe(false);
  });

  it('运行中恢复备份换库：余下写入落在新实例，不打已关闭的旧连接', async () => {
    const old = seededBrain();
    let current: Brain | null = old.brain;
    const getBrain = (): Brain | null => current;
    const pending = pendingReach();
    const published: State[] = [];
    const run = applyResearchRun({
      getBrain,
      publish: (state) => {
        published.push(state);
      },
      objectId: old.objectId,
      gear: '快搜',
      options: {},
      reach: pending.reach,
    });
    await waitUntil(pending.started, '引擎进入 search');
    // 模拟恢复备份：getBrain 换到新库实例，旧库连接关闭——此后任何写旧库的操作都会抛。
    const abandoned = old.brain.snapshot();
    const fresh = seededBrain();
    current = fresh.brain;
    old.brain.close();
    pending.finish();
    const state = requireState(await run);
    // 收尾（APPLY_RESEARCH）写在新库；旧库被弃在「进行中」半成品上，全程无人再打旧连接。
    const task = state.tasks.find((item) => item.objectId === old.objectId);
    expect(task?.status).toBe('已完成');
    expect(fresh.brain.snapshot().tasks.some((item) => item.id === task?.id)).toBe(true);
    expect(abandoned.tasks.some((item) => item.status === '进行中')).toBe(true);
    expect(published.length).toBeGreaterThan(1);
  });

  it('调研抽取把 usage 记入费用审计；未回传则标注且不当 0', async () => {
    const { brain, objectId } = seededBrain();
    const twoHits: ReachAdapter = {
      paths: [
        {
          name: 'Exa',
          doctorCheck: async () => ({ ok: true, detail: 'ok' }),
          search: async () => [
            { title: 'A', url: 'https://a.example/doc', snippet: 'ok' },
            { title: 'B', url: 'https://b.example/doc', snippet: 'ok' },
          ],
        },
      ],
      doctor: async () => ({
        ok: true,
        detail: 'ok',
        paths: [{ name: 'Exa', ok: true, detail: 'ok' }],
      }),
      open: async (url) => ({ url, ok: true, body: '甲组织主栈是 Go。' }),
    };
    const withUsage = requireState(
      await applyResearchRun({
        getBrain: () => brain,
        publish: () => {},
        objectId,
        gear: '快搜',
        options: {},
        reach: twoHits,
        complete: async () => ({
          content: JSON.stringify({ claims: [] }),
          toolCalls: [],
          usage: { promptTokens: 10, completionTokens: 2 },
        }),
      }),
    );
    const task = withUsage.tasks.find((item) => item.objectId === objectId);
    const feeRows = withUsage.taskAudits.filter(
      (audit) => audit.taskId === task?.id && audit.kind === FEE_AUDIT_KIND,
    );
    expect(feeRows).toHaveLength(2);
    expect(parseFeePayload(feeRows[1]?.payload)?.totalTokens).toBe(24);
    expect(task?.stopReason).toBeUndefined();

    const other = seededBrain();
    const missing = requireState(
      await applyResearchRun({
        getBrain: () => other.brain,
        publish: () => {},
        objectId: other.objectId,
        gear: '快搜',
        options: {},
        reach: twoHits,
        complete: async () => ({
          content: JSON.stringify({ claims: [] }),
          toolCalls: [],
        }),
      }),
    );
    const missingTask = missing.tasks.find((item) => item.objectId === other.objectId);
    const missingFee = missing.taskAudits.filter(
      (audit) => audit.taskId === missingTask?.id && audit.kind === FEE_AUDIT_KIND,
    );
    expect(missingFee).toHaveLength(2);
    expect(parseFeePayload(missingFee[0]?.payload)?.note).toBe(MISSING_USAGE_NOTE);
    expect(parseFeePayload(missingFee[1]?.payload)?.totalTokens).toBe(0);
    expect(parseFeePayload(missingFee[1]?.payload)?.missingUsageCalls).toBe(2);
    expect(missingTask?.stopReason).toBeUndefined();
  });

  it('抽取累计超 tokens 顶则费用触顶：已打开照写，未抽的保持未知', async () => {
    const { brain, objectId } = seededBrain();
    const twoHits: ReachAdapter = {
      paths: [
        {
          name: 'Exa',
          doctorCheck: async () => ({ ok: true, detail: 'ok' }),
          search: async () => [
            { title: 'A', url: 'https://a.example/doc', snippet: 'ok' },
            { title: 'B', url: 'https://b.example/doc', snippet: 'ok' },
          ],
        },
      ],
      doctor: async () => ({
        ok: true,
        detail: 'ok',
        paths: [{ name: 'Exa', ok: true, detail: 'ok' }],
      }),
      open: async (url) => ({ url, ok: true, body: '甲组织主栈是 Go。' }),
    };
    const state = requireState(
      await applyResearchRun({
        getBrain: () => brain,
        publish: () => {},
        objectId,
        gear: '快搜',
        options: {},
        reach: twoHits,
        complete: async () => ({
          content: JSON.stringify({ claims: [] }),
          toolCalls: [],
          usage: { promptTokens: 100_000, completionTokens: 30_000 },
        }),
      }),
    );
    const task = state.tasks.find((item) => item.objectId === objectId);
    expect(task?.stopReason).toBe('费用触顶');
    expect(task?.status).toBe('已完成');
    expect(state.sources.filter((source) => source.origin?.kind === 'research')).toHaveLength(2);
    const feeRows = state.taskAudits.filter(
      (audit) => audit.taskId === task?.id && audit.kind === FEE_AUDIT_KIND,
    );
    expect(feeRows).toHaveLength(1);
    expect(state.taskAudits.some((audit) => audit.kind === '费用触顶')).toBe(true);
    expect(parseFeePayload(feeRows[0]?.payload)?.totalTokens).toBe(130_000);
  });
});
