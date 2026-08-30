import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, _electron as electron } from '@playwright/test';

const appDir = join(import.meta.dirname, '..');
type ElectronApp = Awaited<ReturnType<typeof electron.launch>>;
type Window = Awaited<ReturnType<ElectronApp['firstWindow']>>;

type TaskRunState = {
  objects: Array<{ id: string; name: string }>;
  tasks: Array<{ id: string; status: string; stopReason?: string }>;
  taskAudits: Array<{ taskId: string; seq: number; kind: string }>;
};

type StaffdeskApiForTaskRun = {
  dispatch: (action: unknown) => Promise<TaskRunState>;
  snapshot: () => Promise<TaskRunState>;
  stopTask: (taskId: string) => Promise<TaskRunState>;
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

test('对象页可停止进行中的调研并打开任务回放', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'staffdesk-task-run-e2e-'));
  const userDataDir = join(dir, 'user-data');
  const app = await electron.launch({
    args: ['.', `--user-data-dir=${userDataDir}`],
    cwd: appDir,
    env: {
      ...process.env,
      STAFFDESK_BRAIN: join(dir, 'brain.db'),
    },
  });

  try {
    const win = await app.firstWindow();
    await skipWizardIfAny(win);
    await win.evaluate(async () => {
      const api = (globalThis as unknown as { staffdesk: StaffdeskApiForTaskRun }).staffdesk;
      await api.dispatch({ type: 'ADD_WORKSPACE', name: '任务验收区', scenario: '求职面试' });
      const created = await api.dispatch({
        type: 'ADD_OBJECT',
        kind: '组织',
        name: '任务验收组织',
      });
      const object = created.objects.find((item) => item.name === '任务验收组织');
      if (!object) throw new Error('missing object');
      const task = {
        id: 'task-live-e2e',
        objectId: object.id,
        kind: '调研',
        status: '进行中',
        createdAt: '2026-08-30 15:00',
        budgetGear: '快搜',
        query: '任务验收组织 官方',
      };
      await api.dispatch({ type: 'TASK_RUN_STARTED', task });
      await api.dispatch({
        type: 'TASK_AUDIT_APPENDED',
        taskId: task.id,
        audits: [
          {
            taskId: task.id,
            seq: 1,
            kind: '搜索',
            payload: { query: task.query },
            ts: '2026-08-30T15:00:01.000Z',
          },
        ],
      });
      await api.dispatch({ type: 'SET_VIEW', view: { kind: 'object', objectId: object.id } });
    });

    await expect(win.getByText('任务验收组织').first()).toBeVisible();
    await expect(win.getByRole('button', { name: '调研中' })).toBeDisabled();
    await expect(win.getByText('调研 · 快搜')).toBeVisible();
    await win.getByRole('button', { name: '停止任务' }).click();
    await expect
      .poll(async () => {
        return win.evaluate(async () => {
          const api = (globalThis as unknown as { staffdesk: StaffdeskApiForTaskRun }).staffdesk;
          const snapshot = await api.snapshot();
          return snapshot.tasks.find((task) => task.id === 'task-live-e2e')?.stopReason;
        });
      })
      .toBe('手动');

    await win.getByRole('button', { name: '回放' }).click();
    await expect(win.getByRole('heading', { name: '任务回放' })).toBeVisible();
    await expect(win.getByText('已停止 · 手动')).toBeVisible();
    await expect(win.getByText('1. 搜索')).toBeVisible();
    await expect(win.getByRole('button', { name: '返回对象' })).toBeVisible();
  } finally {
    await quitApp(app);
  }
});
