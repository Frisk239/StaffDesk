import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, _electron as electron } from '@playwright/test';
import { dismissOnboarding } from './helpers';

const appDir = join(import.meta.dirname, '..');
type ElectronApp = Awaited<ReturnType<typeof electron.launch>>;

async function quitApp(app: ElectronApp): Promise<void> {
  await app.evaluate(({ app: electronApp }) => electronApp.quit());
  await app.close();
}

test('900px 首屏保留可用右栏，档案和来源入口均可达', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'staffdesk-layout-e2e-'));
  const app = await electron.launch({
    // user-data-dir 指到临时目录：机器级产品设置不落真实用户 profile。
    args: ['.', `--user-data-dir=${join(dir, 'userData')}`],
    cwd: appDir,
    env: {
      ...process.env,
      STAFFDESK_BRAIN: join(dir, 'brain.db'),
      STAFFDESK_E2E_WINDOW_WIDTH: '900',
    },
  });

  try {
    const win = await app.firstWindow();
    await dismissOnboarding(win);
    await expect(win.getByTitle('继续设置')).toBeVisible();
    const viewportWidth = (await win.evaluate('window.innerWidth')) as number;
    expect(viewportWidth).toBeGreaterThanOrEqual(880);
    expect(viewportWidth).toBeLessThanOrEqual(900);

    await win.locator('.ws-switch').click();
    await win.getByRole('button', { name: '新建工作区' }).click();
    await win.locator('input').first().fill('窄窗验收区');
    await win.getByRole('button', { name: '创建' }).click();
    await win.getByTitle('新建对象').click();
    await win.locator('input').first().fill('窄窗验收组织');
    await win.getByRole('button', { name: '创建' }).click();

    const session = win.locator('.session-list');
    const panel = win.locator('.right-panel');
    const chat = win.locator('.chat-pane');
    await expect(session).toHaveAttribute('aria-hidden', 'true');
    await expect(panel).toHaveAttribute('aria-hidden', 'false');
    await expect(panel).toBeVisible();
    await expect(win.getByRole('button', { name: /档案/ }).first()).toBeVisible();

    const panelBox = await panel.boundingBox();
    const chatBox = await chat.boundingBox();
    expect(panelBox?.width ?? 0).toBeGreaterThanOrEqual(280);
    expect(chatBox?.width ?? 0).toBeGreaterThanOrEqual(420);

    await win.getByRole('button', { name: '打开标签页' }).click();
    await expect(win.getByRole('button', { name: '来源' })).toBeVisible();
    await win.getByRole('button', { name: '来源' }).click();
    await expect(win.getByRole('button', { name: /来源/ }).first()).toBeVisible();
    if (process.env.STAFFDESK_E2E_SCREENSHOT_PATH) {
      await win.screenshot({ path: process.env.STAFFDESK_E2E_SCREENSHOT_PATH, fullPage: true });
    }

    await win.getByRole('button', { name: '切换面板' }).click();
    await expect(panel).toHaveAttribute('aria-hidden', 'true');
    await win.getByRole('button', { name: '切换面板' }).click();
    await expect(panel).toHaveAttribute('aria-hidden', 'false');
    await expect
      .poll(async () => (await panel.boundingBox())?.width ?? 0)
      .toBeGreaterThanOrEqual(280);
  } finally {
    await quitApp(app);
  }
});
