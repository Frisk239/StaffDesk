import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, _electron as electron } from '@playwright/test';

const appDir = join(import.meta.dirname, '..');

type Window = Awaited<ReturnType<Awaited<ReturnType<typeof electron.launch>>['firstWindow']>>;

/** 首启向导（0041）盖在主界面上：全新库必弹，出现就跳过。 */
async function skipWizardIfAny(win: Window) {
  const skip = win.getByRole('button', { name: '跳过向导' });
  try {
    await skip.waitFor({ state: 'visible', timeout: 8_000 });
    await skip.click();
  } catch {
    // 非首启库不弹向导
  }
}

/** 0038 托盘语义下 close() 只是收进托盘，进程不退；测试必须走 app.quit()。 */
async function quitApp(app: Awaited<ReturnType<typeof electron.launch>>) {
  await app.evaluate(({ app: electronApp }) => electronApp.quit());
  await app.close();
}

test('建对象后重启对象仍在', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'staffdesk-e2e-'));
  const brainFile = join(dir, 'brain.db');
  const launch = () =>
    electron.launch({
      args: ['.'],
      cwd: appDir,
      env: {
        ...process.env,
        STAFFDESK_BRAIN: brainFile,
      },
    });

  const first = await launch();
  const win = await first.firstWindow();
  await skipWizardIfAny(win);
  await win.locator('.ws-switch').click();
  const createWs = win.getByRole('button', { name: '新建工作区' });
  if (await createWs.isVisible()) {
    await createWs.click();
    await win.locator('input').first().fill('验收区');
    await win.getByRole('button', { name: '创建' }).click();
    await win.waitForTimeout(300);
  }
  await win.getByTitle('新建对象').click();
  await win.locator('input').first().fill('验收组织');
  await win.getByRole('button', { name: '创建' }).click();
  await expect(win.getByText('验收组织').first()).toBeVisible();
  await quitApp(first);

  const second = await launch();
  const win2 = await second.firstWindow();
  await skipWizardIfAny(win2); // 跳过过的库不再弹；这里兜底，防误弹挡住断言
  await expect(win2.getByText('验收组织').first()).toBeVisible();
  await quitApp(second);
});
