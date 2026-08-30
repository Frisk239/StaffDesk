import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, _electron as electron } from '@playwright/test';

const appDir = join(import.meta.dirname, '..');
type ElectronApp = Awaited<ReturnType<typeof electron.launch>>;
type Window = Awaited<ReturnType<ElectronApp['firstWindow']>>;

type TaskEntriesState = {
  objects: Array<{ id: string; name: string }>;
  tasks: Array<{ id: string; status: string; stopReason?: string }>;
};

type StaffdeskApiForTaskEntries = {
  dispatch: (action: unknown) => Promise<TaskEntriesState>;
  snapshot: () => Promise<TaskEntriesState>;
  startResearch: (
    objectId: string,
    gear?: string,
    options?: { kind?: string; fromTaskId?: string },
  ) => Promise<TaskEntriesState>;
};

async function skipWizardIfAny(win: Window): Promise<void> {
  const skip = win.getByRole('button', { name: '跳过向导' });
  try {
    await skip.waitFor({ state: 'visible', timeout: 8_000 });
    await skip.click();
  } catch {
    // Existing brains do not show onboarding.
  }
}

async function quitApp(app: ElectronApp): Promise<void> {
  await app.evaluate(({ app: electronApp }) => electronApp.quit());
  await app.close();
}

async function launchApp(label: string): Promise<{ app: ElectronApp; win: Window }> {
  const dir = mkdtempSync(join(tmpdir(), `staffdesk-${label}-e2e-`));
  const app = await electron.launch({
    args: ['.', `--user-data-dir=${join(dir, 'user-data')}`],
    cwd: appDir,
    env: {
      ...process.env,
      STAFFDESK_BRAIN: join(dir, 'brain.db'),
    },
  });
  const win = await app.firstWindow();
  await skipWizardIfAny(win);
  return { app, win };
}

test('任务列表页汇总已完成任务并可打开回放', async () => {
  const { app, win } = await launchApp('task-entries-list');
  try {
    await win.evaluate(async () => {
      const api = (globalThis as unknown as { staffdesk: StaffdeskApiForTaskEntries }).staffdesk;
      await api.dispatch({ type: 'ADD_WORKSPACE', name: '任务列表验收区', scenario: '求职面试' });
      const created = await api.dispatch({
        type: 'ADD_OBJECT',
        kind: '组织',
        name: '任务列表组织',
      });
      const object = created.objects.find((item) => item.name === '任务列表组织');
      if (!object) throw new Error('missing object');
      const task = {
        id: 'task-list-e2e',
        objectId: object.id,
        kind: '调研',
        status: '已完成',
        createdAt: '2026-08-30 17:00',
        budgetGear: '深挖',
        query: '任务列表组织 官方',
      };
      // APPLY_RESEARCH 是既有的「调研收尾入库」动作；空来源表示零入库的完成态。
      await api.dispatch({
        type: 'APPLY_RESEARCH',
        task,
        audits: [
          {
            taskId: task.id,
            seq: 1,
            kind: '搜索',
            payload: { query: task.query },
            ts: '2026-08-30T17:00:01.000Z',
          },
        ],
        sources: [],
      });
      await api.dispatch({ type: 'SET_VIEW', view: { kind: 'tasks' } });
    });

    await expect(win.getByRole('heading', { name: '任务' })).toBeVisible();
    await expect(win.getByText('任务列表组织').first()).toBeVisible();
    await expect(win.getByText('调研', { exact: true })).toBeVisible();
    await expect(win.getByText('已完成', { exact: true })).toBeVisible();
    await expect(win.getByText('深挖', { exact: true })).toBeVisible();
    await expect(win.getByText('2026-08-30 17:00')).toBeVisible();

    await win.getByRole('button', { name: '打开回放' }).click();
    await expect(win.getByRole('heading', { name: '任务回放' })).toBeVisible();
    await expect(win.getByText('任务列表组织').first()).toBeVisible();
    await expect(win.getByText('1. 搜索')).toBeVisible();
  } finally {
    await quitApp(app);
  }
});

test('调研下拉可选快搜与深挖档位', async () => {
  const { app, win } = await launchApp('task-entries-gear');
  try {
    const objectId = await win.evaluate(async () => {
      const api = (globalThis as unknown as { staffdesk: StaffdeskApiForTaskEntries }).staffdesk;
      await api.dispatch({ type: 'ADD_WORKSPACE', name: '档位验收区', scenario: '求职面试' });
      const created = await api.dispatch({
        type: 'ADD_OBJECT',
        kind: '组织',
        name: '档位验收组织',
      });
      const object = created.objects.find((item) => item.name === '档位验收组织');
      if (!object) throw new Error('missing object');
      await api.dispatch({ type: 'SET_VIEW', view: { kind: 'object', objectId: object.id } });
      return object.id;
    });

    // contextBridge 暴露的对象在页面上下文只读（实测 set 被静默丢弃、属性不可重定义），
    //  spy 无法装在渲染侧；改在主进程摘掉真实调研 handler，换成只记录 payload 的桩，
    // 绝不触真实 Agent Reach 链路。
    await app.evaluate(({ ipcMain }) => {
      (globalThis as unknown as { __researchCalls: unknown[] }).__researchCalls = [];
      ipcMain.removeHandler('task:startResearch');
      ipcMain.handle('task:startResearch', (_event, payload: unknown) => {
        (globalThis as unknown as { __researchCalls: unknown[] }).__researchCalls.push(payload);
        return null;
      });
    });

    await win.getByRole('button', { name: '选择调研档位' }).click();
    await expect(win.getByRole('option', { name: '快搜' })).toBeVisible();
    await expect(win.getByRole('option', { name: '深挖' })).toBeVisible();
    await win.getByRole('option', { name: '深挖' }).click();

    await expect
      .poll(async () => {
        const calls = await app.evaluate(
          () => (globalThis as unknown as { __researchCalls?: unknown[] }).__researchCalls ?? [],
        );
        return JSON.stringify(calls);
      })
      .toBe(JSON.stringify([{ objectId, gear: '深挖' }]));
  } finally {
    await quitApp(app);
  }
});

test('没有上轮任务时再搜一轮禁用', async () => {
  const { app, win } = await launchApp('task-entries-again-disabled');
  try {
    await win.evaluate(async () => {
      const api = (globalThis as unknown as { staffdesk: StaffdeskApiForTaskEntries }).staffdesk;
      await api.dispatch({ type: 'ADD_WORKSPACE', name: '再搜验收区', scenario: '求职面试' });
      const created = await api.dispatch({
        type: 'ADD_OBJECT',
        kind: '组织',
        name: '再搜验收组织',
      });
      const object = created.objects.find((item) => item.name === '再搜验收组织');
      if (!object) throw new Error('missing object');
      await api.dispatch({ type: 'SET_VIEW', view: { kind: 'object', objectId: object.id } });
    });

    await win.getByRole('button', { name: '选择调研档位' }).click();
    await expect(win.getByRole('option', { name: '再搜一轮' })).toBeDisabled();
  } finally {
    await quitApp(app);
  }
});
