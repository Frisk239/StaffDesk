import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, _electron as electron } from '@playwright/test';

const appDir = join(import.meta.dirname, '..');
type ElectronApp = Awaited<ReturnType<typeof electron.launch>>;
type Window = Awaited<ReturnType<ElectronApp['firstWindow']>>;

type StaffdeskApiForSeed = {
  snapshot: () => Promise<{
    objects: Array<{ name: string }>;
    providers: Array<{ id: string; name: string; baseUrl: string; apiKey: string }>;
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

test('设置页可以导出并恢复大脑备份，模型配置不被备份覆盖', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'staffdesk-brain-backup-e2e-'));
  const backupZip = join(dir, 'staffdesk-export.zip');
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
    await app.evaluate(({ dialog }, filePath) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath });
    }, backupZip);
    const win = await app.firstWindow();
    await skipWizardIfAny(win);
    await win.evaluate(async () => {
      const api = (globalThis as unknown as { staffdesk: StaffdeskApiForSeed }).staffdesk;
      await api.dispatch({ type: 'ADD_WORKSPACE', name: '备份验收区', scenario: '求职面试' });
      await api.dispatch({ type: 'ADD_OBJECT', kind: '组织', name: '备份里的组织' });
      await api.dispatch({
        type: 'UPSERT_PROVIDER',
        provider: {
          id: 'p-backup-e2e',
          name: '备份时端点',
          baseUrl: 'https://backup.example.test/v1',
          apiKey: 'sk-backup-e2e',
          enabled: true,
          models: [{ id: 'backup-model', name: 'backup-model', contextWindow: 1, maxOutput: 1 }],
        },
      });
    });

    await win.locator('button[title="设置"]').click();
    const settings = win.getByRole('dialog', { name: '设置' });
    await settings.getByRole('button', { name: '导出大脑备份' }).click();
    await expect(settings).toContainText('已导出大脑备份');
    expect(existsSync(backupZip)).toBe(true);

    await app.evaluate(({ dialog }, filePath) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] });
    }, backupZip);
    await win.evaluate(async () => {
      const api = (globalThis as unknown as { staffdesk: StaffdeskApiForSeed }).staffdesk;
      await api.dispatch({ type: 'ADD_OBJECT', kind: '组织', name: '恢复后应消失' });
      await api.dispatch({
        type: 'UPSERT_PROVIDER',
        provider: {
          id: 'p-backup-e2e',
          name: '当前机器端点',
          baseUrl: 'https://current-machine.example.test/v1',
          apiKey: 'sk-current-e2e',
          enabled: true,
          models: [{ id: 'current-model', name: 'current-model', contextWindow: 1, maxOutput: 1 }],
        },
      });
    });

    await settings.getByRole('button', { name: '恢复大脑备份' }).click();
    await expect(settings.locator('.restore-confirm')).toContainText('恢复会替换当前大脑文件');
    await settings.getByRole('button', { name: '确认恢复并替换' }).click();
    await expect(settings).toContainText('已恢复大脑备份');

    const state = await win.evaluate(async () => {
      const api = (globalThis as unknown as { staffdesk: StaffdeskApiForSeed }).staffdesk;
      return api.snapshot();
    });
    expect(state.objects.map((object) => object.name)).toContain('备份里的组织');
    expect(state.objects.map((object) => object.name)).not.toContain('恢复后应消失');
    expect(state.providers).toHaveLength(1);
    expect(state.providers[0]).toMatchObject({
      id: 'p-backup-e2e',
      name: '当前机器端点',
      baseUrl: 'https://current-machine.example.test/v1',
      apiKey: 'sk-current-e2e',
    });
    expect(
      readdirSync(join(userDataDir, 'brain-backups')).some((name) => name.endsWith('.zip')),
    ).toBe(true);
  } finally {
    await quitApp(app);
  }
});
