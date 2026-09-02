import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, _electron as electron } from '@playwright/test';

// 审计 D1：罐头检索注入永不返回的 search/open（STAFFDESK_E2E_REACH_HANG），
// 配小墙钟档（STAFFDESK_E2E_WALL_MS）断言任务限时收口、不卡「进行中」。
// 隔离照旧：隔离 brain + 罐头检索，不触外网、不配模型。

const appDir = join(import.meta.dirname, '..');
type ElectronApp = Awaited<ReturnType<typeof electron.launch>>;
type Window = Awaited<ReturnType<ElectronApp['firstWindow']>>;

type TimeoutState = {
  objects: Array<{ id: string; name: string }>;
  tasks: Array<{ id: string; status: string; stopReason?: string; kind: string }>;
  taskAudits: Array<{ taskId: string; kind: string; payload: unknown }>;
};

type StaffdeskApiForTimeout = {
  dispatch: (action: unknown) => Promise<TimeoutState>;
  snapshot: () => Promise<TimeoutState>;
  startResearch: (objectId: string, gear?: string) => Promise<TimeoutState>;
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

async function launchWith(dir: string, hang: 'search' | 'open'): Promise<ElectronApp> {
  return electron.launch({
    args: ['.', `--user-data-dir=${join(dir, 'user-data')}`],
    cwd: appDir,
    env: {
      ...process.env,
      STAFFDESK_BRAIN: join(dir, 'brain.db'),
      STAFFDESK_E2E_REACH: '1',
      STAFFDESK_E2E_REACH_HANG: hang,
      STAFFDESK_E2E_WALL_MS: '2000',
    },
  });
}

test('搜索路挂死：墙钟内折搜索超时，任务失败收口不卡「进行中」', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'staffdesk-reach-timeout-e2e-'));
  const app = await launchWith(dir, 'search');

  try {
    const win = await app.firstWindow();
    await skipWizardIfAny(win);
    const after = await win.evaluate(async () => {
      const api = (globalThis as unknown as { staffdesk: StaffdeskApiForTimeout }).staffdesk;
      await api.dispatch({ type: 'ADD_WORKSPACE', name: '超时验收区', scenario: '求职面试' });
      const created = await api.dispatch({
        type: 'ADD_OBJECT',
        kind: '组织',
        name: '超时验收组织',
      });
      const object = created.objects.find((item) => item.name === '超时验收组织');
      if (!object) throw new Error('missing object');
      return api.startResearch(object.id, '快搜');
    });

    const task = after.tasks.find((item) => item.kind === '调研');
    expect(task?.status).toBe('已停止');
    expect(task?.stopReason).toBe('失败');
    const searchFailures = after.taskAudits.filter(
      (audit) => audit.taskId === task?.id && audit.kind === '搜索失败',
    );
    expect(searchFailures.length).toBeGreaterThan(0);
    expect(JSON.stringify(searchFailures)).toMatch(/搜索超时/);
    expect(after.taskAudits.some((audit) => audit.kind === '停止')).toBe(true);
  } finally {
    await quitApp(app);
  }
});

test('打开路挂死：墙钟内折打开超时进失败 URL，任务按触顶收口不卡「进行中」', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'staffdesk-reach-timeout-e2e-'));
  const app = await launchWith(dir, 'open');

  try {
    const win = await app.firstWindow();
    await skipWizardIfAny(win);
    const after = await win.evaluate(async () => {
      const api = (globalThis as unknown as { staffdesk: StaffdeskApiForTimeout }).staffdesk;
      await api.dispatch({ type: 'ADD_WORKSPACE', name: '超时验收区', scenario: '求职面试' });
      const created = await api.dispatch({
        type: 'ADD_OBJECT',
        kind: '组织',
        name: '超时验收组织',
      });
      const object = created.objects.find((item) => item.name === '超时验收组织');
      if (!object) throw new Error('missing object');
      return api.startResearch(object.id, '快搜');
    });

    const task = after.tasks.find((item) => item.kind === '调研');
    expect(task?.status).not.toBe('进行中');
    expect(task?.stopReason).toBe('触顶');
    const openFailures = after.taskAudits.filter(
      (audit) => audit.taskId === task?.id && audit.kind === '打开失败',
    );
    expect(openFailures.length).toBeGreaterThan(0);
    expect(JSON.stringify(openFailures)).toMatch(/打开超时/);
  } finally {
    await quitApp(app);
  }
});
