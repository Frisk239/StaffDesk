import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, _electron as electron } from '@playwright/test';
import { closeServer, installStubModel, serveStubModel } from './stub-model';

const appDir = join(import.meta.dirname, '..');
type ElectronApp = Awaited<ReturnType<typeof electron.launch>>;
type Window = Awaited<ReturnType<ElectronApp['firstWindow']>>;

type FeeCapState = {
  objects: Array<{ id: string; name: string }>;
  tasks: Array<{ id: string; status: string; stopReason?: string; kind: string }>;
  taskAudits: Array<{ taskId: string; kind: string; payload: unknown }>;
  sources: Array<{ id: string; origin?: { kind?: string; taskId?: string } }>;
};

type StaffdeskApiForFeeCap = {
  dispatch: (action: unknown) => Promise<FeeCapState>;
  snapshot: () => Promise<FeeCapState>;
  startResearch: (objectId: string, gear?: string) => Promise<FeeCapState>;
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

test('小预算深挖费用触顶：已打开照写、审计有费用行、任务行显示 token', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'staffdesk-fee-cap-e2e-'));
  const stub = await serveStubModel(
    [
      {
        objectName: '费用触顶组织',
        predicate: '后端主栈',
        text: '费用触顶组织主栈是 Rust',
        span: '主栈是 Rust',
      },
    ],
    undefined,
    { prompt_tokens: 800, completion_tokens: 200 },
  );
  const app = await electron.launch({
    args: ['.', `--user-data-dir=${join(dir, 'user-data')}`],
    cwd: appDir,
    env: {
      ...process.env,
      STAFFDESK_BRAIN: join(dir, 'brain.db'),
      STAFFDESK_E2E_REACH: '1',
      STAFFDESK_E2E_TOKEN_BUDGET: '500',
    },
  });

  try {
    const win = await app.firstWindow();
    await skipWizardIfAny(win);
    await installStubModel(win, stub.baseUrl);

    const after = await win.evaluate(async () => {
      const api = (globalThis as unknown as { staffdesk: StaffdeskApiForFeeCap }).staffdesk;
      await api.dispatch({ type: 'ADD_WORKSPACE', name: '费用触顶验收区', scenario: '求职面试' });
      const created = await api.dispatch({
        type: 'ADD_OBJECT',
        kind: '组织',
        name: '费用触顶组织',
      });
      const object = created.objects.find((item) => item.name === '费用触顶组织');
      if (!object) throw new Error('missing object');
      return api.startResearch(object.id, '深挖');
    });

    const task = after.tasks.find((item) => item.kind === '调研');
    expect(task?.stopReason).toBe('费用触顶');
    expect(task?.status).toBe('已完成');
    const researchSources = after.sources.filter(
      (source) => source.origin?.kind === 'research' && source.origin.taskId === task?.id,
    );
    // 双路罐头（0061）：Exa 两命中 + GitHub 两命中去重一条 → 合并 3 条唯一来源。
    expect(researchSources.length).toBe(3);
    expect(after.taskAudits.some((audit) => audit.kind === '费用')).toBe(true);

    await win.evaluate(async () => {
      const api = (globalThis as unknown as { staffdesk: StaffdeskApiForFeeCap }).staffdesk;
      await api.dispatch({ type: 'SET_VIEW', view: { kind: 'tasks' } });
    });
    await expect(win.getByRole('heading', { name: '任务' })).toBeVisible();
    await expect(win.getByText('1.0k token')).toBeVisible();
    await expect(win.getByText('已完成 · 费用触顶')).toBeVisible();

    await win.getByRole('button', { name: '打开回放' }).click();
    await expect(win.getByRole('heading', { name: '任务回放' })).toBeVisible();
    await expect(win.getByText(/累计 1\.0k token/)).toBeVisible();
    await expect(win.getByText(/输入 800 token/)).toBeVisible();
    await expect(win.getByText(/输出 200 token/)).toBeVisible();
  } finally {
    await quitApp(app);
    await closeServer(stub.server);
  }
});
