import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, _electron as electron } from '@playwright/test';

const appDir = join(import.meta.dirname, '..');
type ElectronApp = Awaited<ReturnType<typeof electron.launch>>;
type Window = Awaited<ReturnType<ElectronApp['firstWindow']>>;

type StaffdeskApiForSeed = {
  snapshot: () => Promise<{
    activeProviderId: string;
    activeModelId: string;
    qualification: { status: string; endpointIdentity?: string; modelId?: string };
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

test('设置页模型资格卡展示当前全局配置并保留显式运行入口', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'staffdesk-qualification-e2e-'));
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
    const seeded = await win.evaluate(async () => {
      const api = (globalThis as unknown as { staffdesk: StaffdeskApiForSeed }).staffdesk;
      await api.dispatch({
        type: 'UPSERT_PROVIDER',
        provider: {
          id: 'p-e2e-qualification',
          name: 'E2E 本机端点',
          baseUrl: 'https://models.example.test/v1/',
          apiKey: 'e2e-secret',
          enabled: true,
          models: [
            {
              id: 'e2e-model-a',
              name: 'e2e-model-a',
              contextWindow: 128000,
              maxOutput: 8192,
            },
          ],
        },
      });
      await api.dispatch({
        type: 'SET_ACTIVE_MODEL',
        providerId: 'p-e2e-qualification',
        modelId: 'e2e-model-a',
      });
      return api.snapshot();
    });

    expect(seeded.activeProviderId).toBe('p-e2e-qualification');
    expect(seeded.activeModelId).toBe('e2e-model-a');
    expect(seeded.qualification.status).toBe('未认证');
    expect(seeded.qualification.endpointIdentity).toBe('models.example.test/v1');
    expect(seeded.qualification.modelId).toBe('e2e-model-a');

    await win.locator('button[title="设置"]').click();
    const settings = win.getByRole('dialog', { name: '设置' });
    await settings.getByRole('button', { name: '模型' }).click();

    const card = settings.getByLabel('当前模型资格认证');
    await expect(card).toBeVisible();
    await expect(card).toContainText('当前模型资格');
    await expect(card).toContainText('未认证');
    await expect(card).toContainText('models.example.test/v1 · e2e-model-a');
    await expect(card.getByRole('button', { name: '运行资格认证' })).toBeEnabled();
    await expect(settings.locator('.models-rail-item.on')).toContainText('E2E 本机端点');
    await expect(settings.locator('.model-row')).toContainText('e2e-model-a');
    await expect(settings.locator('.model-row').getByRole('button').first()).toBeEnabled();

    const cardBox = await card.boundingBox();
    const settingsBox = await settings.boundingBox();
    expect(cardBox?.width ?? 0).toBeGreaterThan(520);
    expect(settingsBox?.width ?? 0).toBeGreaterThan(880);

    if (process.env.STAFFDESK_E2E_SCREENSHOT_PATH) {
      await win.screenshot({ path: process.env.STAFFDESK_E2E_SCREENSHOT_PATH, fullPage: true });
    }
  } finally {
    await quitApp(app);
  }
});
