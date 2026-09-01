import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, _electron as electron } from '@playwright/test';

const appDir = join(import.meta.dirname, '..');
type ElectronApp = Awaited<ReturnType<typeof electron.launch>>;
type Window = Awaited<ReturnType<ElectronApp['firstWindow']>>;

type StaffdeskApiForSeed = {
  snapshot: () => Promise<{
    objects: { id: string }[];
    sources: { id: string; virtual?: boolean }[];
  }>;
  dispatch: (action: unknown) => Promise<unknown>;
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

test('设置页谓词表：非保护槽可编辑改名、删除须先确认影响数', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'staffdesk-slot-edit-e2e-'));
  const app = await electron.launch({
    args: ['.', `--user-data-dir=${join(dir, 'user-data')}`],
    cwd: appDir,
    env: {
      ...process.env,
      STAFFDESK_BRAIN: join(dir, 'brain.db'),
    },
  });

  try {
    const win = await app.firstWindow();
    await skipWizardIfAny(win);

    // 造一条「教育背景」（人 · 非保护槽）下的成立主张，给删除确认对话框一个真实影响数。
    await win.evaluate(async () => {
      const api = (globalThis as unknown as { staffdesk: StaffdeskApiForSeed }).staffdesk;
      await api.dispatch({ type: 'ADD_WORKSPACE', name: '求职区', scenario: '求职面试' });
      await api.dispatch({ type: 'ADD_OBJECT', kind: '人', name: '王某' });
      const seeded = await api.snapshot();
      const objectId = seeded.objects[0]?.id;
      if (!objectId) throw new Error('e2e: 对象未建立');
      await api.dispatch({
        type: 'ADD_SOURCE',
        title: '履历',
        body: '教育背景为计算机硕士。',
      });
      const withSource = await api.snapshot();
      const source = withSource.sources.find((item) => !item.virtual);
      if (!source) throw new Error('e2e: 来源未建立');
      await api.dispatch({ type: 'BIND_CONFIRMED', sourceId: source.id, objectIds: [objectId] });
      await api.dispatch({
        type: 'EXTRACT_DONE',
        sourceId: source.id,
        claims: [
          {
            id: 'cl-e2e-slot-1',
            objectId,
            predicate: '教育背景',
            text: '教育背景为计算机硕士。',
            status: '成立',
            unverified: true,
            sourceId: source.id,
            createdAt: '2026-08-31',
          },
        ],
      });
    });

    await win.locator('button[title="设置"]').click();
    const settings = win.getByRole('dialog', { name: '设置' });
    await settings.getByRole('button', { name: '谓词表' }).click();

    // 编辑改名：非保护槽（教育背景）改槽名，列表出现新名。
    const row = settings.locator('.slot-table-row', { hasText: '教育背景' });
    await row.getByRole('button', { name: '编辑槽 教育背景' }).click();
    const editDialog = win.getByRole('dialog', { name: '编辑槽' });
    await editDialog.getByLabel('槽名').fill('教育履历');
    await editDialog.getByRole('button', { name: '保存' }).click();
    await expect(settings.locator('.slot-scroll')).toContainText('教育履历');

    // 删除：确认对话框先展示影响数，确认后列表消失。
    const renamedRow = settings.locator('.slot-table-row', { hasText: '教育履历' });
    await renamedRow.getByRole('button', { name: '删除槽 教育履历' }).click();
    const deleteDialog = win.getByRole('dialog', { name: '删除字段' });
    await expect(deleteDialog).toContainText('1 条成立主张');
    await expect(deleteDialog).toContainText('1 个对象');
    await deleteDialog.getByRole('button', { name: '确认删除' }).click();
    await expect(settings.locator('.slot-scroll')).not.toContainText('教育履历');

    if (process.env.STAFFDESK_E2E_SCREENSHOT_PATH) {
      await win.screenshot({ path: process.env.STAFFDESK_E2E_SCREENSHOT_PATH, fullPage: true });
    }
  } finally {
    await quitApp(app);
  }
});
