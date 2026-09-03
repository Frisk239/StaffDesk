import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, _electron as electron } from '@playwright/test';
import { dismissOnboarding } from './helpers';

const appDir = join(import.meta.dirname, '..');
type ElectronApp = Awaited<ReturnType<typeof electron.launch>>;

type TaskRunState = {
  objects: Array<{ id: string; name: string }>;
  tasks: Array<{ id: string; status: string; stopReason?: string }>;
  taskAudits: Array<{ taskId: string; seq: number; kind: string }>;
  claims: Array<{ id: string; unverified: boolean }>;
  writeQueue: Array<{ id: string; kind: string; taskId?: string }>;
};

type StaffdeskApiForTaskRun = {
  dispatch: (action: unknown) => Promise<TaskRunState>;
  snapshot: () => Promise<TaskRunState>;
  stopTask: (taskId: string) => Promise<TaskRunState>;
};

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
    await dismissOnboarding(win);
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

test('调研抽取结束后出现本任务批量晋升或保持入口', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'staffdesk-task-review-e2e-'));
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
    await dismissOnboarding(win);
    await win.evaluate(async () => {
      const api = (globalThis as unknown as { staffdesk: StaffdeskApiForTaskRun }).staffdesk;
      await api.dispatch({ type: 'ADD_WORKSPACE', name: '批量决策验收区', scenario: '求职面试' });
      const created = await api.dispatch({
        type: 'ADD_OBJECT',
        kind: '组织',
        name: '批量决策组织',
      });
      const object = created.objects.find((item) => item.name === '批量决策组织');
      if (!object) throw new Error('missing object');
      const task = {
        id: 'task-review-e2e',
        objectId: object.id,
        kind: '调研',
        status: '已完成',
        createdAt: '2026-08-30 16:30',
        budgetGear: '快搜',
        query: '批量决策组织 官方',
      };
      const source = {
        id: `src-res-${task.id}-1`,
        title: '调研来源',
        body: '招聘页称主栈是 Rust。',
        path: '调研',
        boundObjectIds: [object.id],
        workspaceId: 'ws-e2e',
        origin: {
          kind: 'research',
          taskId: task.id,
          locator: 'https://example.test/research',
          finalUrl: 'https://example.test/research',
          contentHash: 'hash-e2e',
          fetchedAt: '2026-08-30T16:30:00.000Z',
        },
        segments: [{ id: 'body', start: 0, end: 13, label: '调研来源' }],
        contentHash: 'hash-e2e',
        fetchedAt: '2026-08-30T16:30:00.000Z',
      };
      await api.dispatch({
        type: 'APPLY_RESEARCH',
        task,
        audits: [
          {
            taskId: task.id,
            seq: 1,
            kind: '打开',
            payload: { url: 'https://example.test/research' },
            ts: '2026-08-30T16:30:01.000Z',
          },
        ],
        sources: [source],
      });
      await api.dispatch({ type: 'BIND_CONFIRMED', sourceId: source.id, objectIds: [object.id] });
      const afterExtraction = await api.dispatch({
        type: 'EXTRACT_DONE',
        sourceId: source.id,
        claims: [
          {
            id: 'cl-review-e2e',
            objectId: object.id,
            predicate: '使用技术',
            text: '主栈是 Rust',
            status: '成立',
            unverified: true,
            sourceId: source.id,
            span: '主栈是 Rust',
            createdAt: '2026-08-30',
          },
        ],
      });
      if (!afterExtraction.writeQueue.some((write) => write.taskId === task.id)) {
        throw new Error('EXTRACT_DONE 没有入队本任务批量晋升');
      }
      await api.dispatch({ type: 'SET_VIEW', view: { kind: 'object', objectId: object.id } });
    });

    await expect(win.getByText('本次调研新增未核 1 条')).toBeVisible();
    await expect(win.getByText('全部晋升后可出站当定论')).toBeVisible();
    await win.getByRole('button', { name: '全部保持' }).click();
    await expect(win.getByText('已全部保持未核 1 条')).toBeVisible();
    await expect
      .poll(async () =>
        win.evaluate(async () => {
          const api = (globalThis as unknown as { staffdesk: StaffdeskApiForTaskRun }).staffdesk;
          const snapshot = await api.snapshot();
          return snapshot.claims.find((claim) => claim.id === 'cl-review-e2e')?.unverified;
        }),
      )
      .toBe(true);
  } finally {
    await quitApp(app);
  }
});
