import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, _electron as electron } from '@playwright/test';
import { dismissOnboarding } from './helpers';
import { closeServer, installStubModel, serveStubModel } from './stub-model';

const appDir = join(import.meta.dirname, '..');
type ElectronApp = Awaited<ReturnType<typeof electron.launch>>;

type MultiPathState = {
  objects: Array<{ id: string; name: string }>;
  tasks: Array<{ id: string; status: string; stopReason?: string; kind: string }>;
  taskAudits: Array<{ taskId: string; kind: string; payload: unknown }>;
  sources: Array<{
    id: string;
    origin?: { kind?: string; taskId?: string; locator?: string };
  }>;
};

type StaffdeskApiForMultiPath = {
  dispatch: (action: unknown) => Promise<MultiPathState>;
  snapshot: () => Promise<MultiPathState>;
  startResearch: (objectId: string, gear?: string) => Promise<MultiPathState>;
};

async function quitApp(app: ElectronApp): Promise<void> {
  await app.evaluate(({ app: electronApp }) => electronApp.quit());
  await app.close();
}

/** 起一个隔离实例，建对象并跑一轮快搜；返回收尾态与回放窗口。 */
async function researchOnce(extraEnv: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'staffdesk-multi-path-e2e-'));
  const stub = await serveStubModel([
    {
      objectName: '多路验收组织',
      predicate: '后端主栈',
      text: '多路验收组织主栈是 Rust',
      span: '主栈是 Rust',
    },
  ]);
  const app = await electron.launch({
    args: ['.', `--user-data-dir=${join(dir, 'user-data')}`],
    cwd: appDir,
    env: {
      ...process.env,
      STAFFDESK_BRAIN: join(dir, 'brain.db'),
      STAFFDESK_E2E_REACH: '1',
      ...extraEnv,
    },
  });
  const win = await app.firstWindow();
  await dismissOnboarding(win);
  await installStubModel(win, stub.baseUrl);
  const after = await win.evaluate(async () => {
    const api = (globalThis as unknown as { staffdesk: StaffdeskApiForMultiPath }).staffdesk;
    await api.dispatch({ type: 'ADD_WORKSPACE', name: '多路验收区', scenario: '求职面试' });
    const created = await api.dispatch({
      type: 'ADD_OBJECT',
      kind: '组织',
      name: '多路验收组织',
    });
    const object = created.objects.find((item) => item.name === '多路验收组织');
    if (!object) throw new Error('missing object');
    return api.startResearch(object.id, '快搜');
  });
  return { app, win, after, stub };
}

test('双路并行：命中去重可见、审计记路径、回放出人读摘要', async () => {
  const { app, win, after, stub } = await researchOnce({});
  try {
    const task = after.tasks.find((item) => item.kind === '调研');
    expect(task?.status).toBe('已完成');
    expect(task?.stopReason).toBeUndefined();
    // Exa 两命中 + GitHub 两命中（一条同 URL 去重）→ 三条唯一来源。
    const locators = after.sources
      .filter((source) => source.origin?.kind === 'research' && source.origin.taskId === task?.id)
      .map((source) => source.origin?.locator)
      .sort();
    expect(locators).toEqual([
      'https://e2e.staffdesk.test/a',
      'https://e2e.staffdesk.test/b',
      'https://e2e.staffdesk.test/c',
    ]);
    const searchAudit = after.taskAudits.find(
      (audit) => audit.taskId === task?.id && audit.kind === '搜索',
    );
    expect((searchAudit?.payload as { paths?: Array<{ name: string }> }).paths).toEqual([
      { name: 'Exa' },
      { name: 'GitHub' },
    ]);
    const resultAudit = after.taskAudits.find(
      (audit) => audit.taskId === task?.id && audit.kind === '搜索结果',
    );
    expect(resultAudit?.payload).toMatchObject({
      count: 3,
      duplicates: 1,
      paths: [
        { name: 'Exa', ok: true, count: 2 },
        { name: 'GitHub', ok: true, count: 2 },
      ],
    });

    await win.evaluate(async () => {
      const api = (globalThis as unknown as { staffdesk: StaffdeskApiForMultiPath }).staffdesk;
      await api.dispatch({ type: 'SET_VIEW', view: { kind: 'tasks' } });
    });
    await win.getByRole('button', { name: '打开回放' }).click();
    await expect(win.getByRole('heading', { name: '任务回放' })).toBeVisible();
    await expect(win.getByText('Exa ✓ 2 条 · GitHub ✓ 2 条')).toBeVisible();
  } finally {
    await quitApp(app);
    await closeServer(stub.server);
  }
});

test('单路失败另一路照常：审计记该路失败，任务仍完成', async () => {
  const { app, win, after, stub } = await researchOnce({ STAFFDESK_E2E_REACH_FAIL: 'GitHub' });
  try {
    const task = after.tasks.find((item) => item.kind === '调研');
    expect(task?.status).toBe('已完成');
    expect(task?.stopReason).toBeUndefined();
    // GitHub 路失败：只剩 Exa 的两命中。
    const locators = after.sources
      .filter((source) => source.origin?.kind === 'research' && source.origin.taskId === task?.id)
      .map((source) => source.origin?.locator)
      .sort();
    expect(locators).toEqual(['https://e2e.staffdesk.test/a', 'https://e2e.staffdesk.test/b']);
    const failure = after.taskAudits.find(
      (audit) => audit.taskId === task?.id && audit.kind === '搜索失败',
    );
    expect(failure?.payload).toMatchObject({ path: 'GitHub', error: /403/ });

    await win.evaluate(async () => {
      const api = (globalThis as unknown as { staffdesk: StaffdeskApiForMultiPath }).staffdesk;
      await api.dispatch({ type: 'SET_VIEW', view: { kind: 'tasks' } });
    });
    await win.getByRole('button', { name: '打开回放' }).click();
    await expect(win.getByRole('heading', { name: '任务回放' })).toBeVisible();
    await expect(win.getByText(/Exa ✓ 2 条 · GitHub × /)).toBeVisible();
  } finally {
    await quitApp(app);
    await closeServer(stub.server);
  }
});

test('单路失败另一路照常（Exa 失败方向）：对称注入同样成立', async () => {
  const { app, win, after, stub } = await researchOnce({ STAFFDESK_E2E_REACH_FAIL: 'Exa' });
  try {
    const task = after.tasks.find((item) => item.kind === '调研');
    expect(task?.status).toBe('已完成');
    expect(task?.stopReason).toBeUndefined();
    // Exa 路失败：只剩 GitHub 的两命中（a 与 c——a 原是 Exa 的镜像，此刻由 GitHub 独供）。
    const locators = after.sources
      .filter((source) => source.origin?.kind === 'research' && source.origin.taskId === task?.id)
      .map((source) => source.origin?.locator)
      .sort();
    expect(locators).toEqual(['https://e2e.staffdesk.test/a', 'https://e2e.staffdesk.test/c']);
    const failure = after.taskAudits.find(
      (audit) => audit.taskId === task?.id && audit.kind === '搜索失败',
    );
    expect(failure?.payload).toMatchObject({ path: 'Exa', error: /故障注入/ });

    await win.evaluate(async () => {
      const api = (globalThis as unknown as { staffdesk: StaffdeskApiForMultiPath }).staffdesk;
      await api.dispatch({ type: 'SET_VIEW', view: { kind: 'tasks' } });
    });
    await win.getByRole('button', { name: '打开回放' }).click();
    await expect(win.getByRole('heading', { name: '任务回放' })).toBeVisible();
    await expect(win.getByText(/Exa × .* · GitHub ✓ 2 条/)).toBeVisible();
  } finally {
    await quitApp(app);
    await closeServer(stub.server);
  }
});
