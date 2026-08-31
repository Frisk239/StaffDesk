import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DeskTask } from '@shared/types';
import { openBrain, type Brain } from '../../src/main/brain';
import { createRadarWatchdog } from '../../src/main/tasks/radarWatchdog';

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

function seededBrain(): { brain: Brain; objectIdA: string; objectIdB: string } {
  const dir = mkdtempSync(join(tmpdir(), 'staffdesk-radar-watchdog-'));
  dirs.push(dir);
  const brain = openBrain(join(dir, 'brain.db'));
  brains.push(brain);
  brain.dispatch({ type: 'ADD_WORKSPACE', name: '区甲', scenario: '求职面试' });
  brain.dispatch({ type: 'ADD_OBJECT', kind: '组织', name: '甲组织' });
  brain.dispatch({ type: 'ADD_OBJECT', kind: '组织', name: '乙组织' });
  const [objectA, objectB] = brain.snapshot().objects;
  if (!objectA || !objectB) throw new Error('种子对象未落账');
  return { brain, objectIdA: objectA.id, objectIdB: objectB.id };
}

/** 建雷达并直接拨 tasks.next_due_at：绕开 CREATE_RADAR 的自动排期，精确控制到期/未到期。 */
function seededRadar(brain: Brain, objectId: string, nextDueAt: string): DeskTask {
  brain.dispatch({
    type: 'CREATE_RADAR',
    objectId,
    intervalDays: 1,
    budgetGear: '快搜',
  });
  const radar = brain
    .snapshot()
    .tasks.find((task) => task.objectId === objectId && task.kind === '周期性雷达');
  if (!radar) throw new Error('雷达未落账');
  brain.db.prepare('UPDATE tasks SET next_due_at = ? WHERE id = ?').run(nextDueAt, radar.id);
  return radar;
}

describe('雷达常驻心跳', () => {
  it('到期的雷达 tick 交给 run，未到期的静默跳过，tick 后回调托盘刷新', async () => {
    const { brain, objectIdA, objectIdB } = seededBrain();
    const due = seededRadar(brain, objectIdA, '2020-01-01 00:00');
    seededRadar(brain, objectIdB, '2999-01-01 00:00');
    const runs: string[] = [];
    const onTick = vi.fn();
    const watchdog = createRadarWatchdog({
      getBrain: () => brain,
      publish: () => {},
      run: async (radar) => {
        runs.push(radar.id);
      },
      onTick,
    });
    await watchdog.tick();
    expect(runs).toEqual([due.id]);
    expect(onTick).toHaveBeenCalledTimes(1);
    watchdog.stop();
  });

  it('多对象同时到期都跑，且串行：前一条未收口不启下一条', async () => {
    const { brain, objectIdA, objectIdB } = seededBrain();
    const firstRadar = seededRadar(brain, objectIdA, '2020-01-01 00:00');
    const secondRadar = seededRadar(brain, objectIdB, '2020-01-02 00:00');
    const calls: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const watchdog = createRadarWatchdog({
      getBrain: () => brain,
      publish: () => {},
      run: async (radar) => {
        calls.push(radar.id);
        if (calls.length === 1) await firstGate;
      },
    });
    const ticking = watchdog.tick();
    await new Promise((resolve) => setTimeout(resolve, 10));
    // dueRadars 按 due 降序：更晚到期（01-02）先进 run；首条挂起期间第二条不启动。
    expect(calls).toEqual([secondRadar.id]);
    releaseFirst?.();
    await ticking;
    expect(calls).toEqual([secondRadar.id, firstRadar.id]);
    watchdog.stop();
  });

  it('brain 为 null（恢复备份窗口/退出后）tick 空跳不炸，run 不触发', async () => {
    const run = vi.fn();
    const onTick = vi.fn();
    const watchdog = createRadarWatchdog({
      getBrain: () => null,
      publish: () => {},
      run,
      onTick,
    });
    await watchdog.tick();
    expect(run).not.toHaveBeenCalled();
    expect(onTick).toHaveBeenCalledTimes(1);
    watchdog.stop();
  });

  it('stop 之后 interval 不再触发 tick', async () => {
    const { brain } = seededBrain();
    vi.useFakeTimers();
    try {
      const onTick = vi.fn();
      const watchdog = createRadarWatchdog({
        getBrain: () => brain,
        publish: () => {},
        run: async () => {},
        intervalMs: 100,
        onTick,
      });
      await vi.advanceTimersByTimeAsync(250);
      expect(onTick.mock.calls.length).toBeGreaterThanOrEqual(2);
      watchdog.stop();
      const before = onTick.mock.calls.length;
      await vi.advanceTimersByTimeAsync(1_000);
      expect(onTick.mock.calls.length).toBe(before);
    } finally {
      vi.useRealTimers();
    }
  });

  it('run 抛错向上传播：watchdog 不吞错，装配方决定怎么收', async () => {
    const { brain, objectIdA } = seededBrain();
    seededRadar(brain, objectIdA, '2020-01-01 00:00');
    const watchdog = createRadarWatchdog({
      getBrain: () => brain,
      publish: () => {},
      run: async () => {
        throw new Error('编排炸了');
      },
    });
    await expect(watchdog.tick()).rejects.toThrow('编排炸了');
    watchdog.stop();
  });
});
