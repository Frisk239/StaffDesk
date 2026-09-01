import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, _electron as electron } from '@playwright/test';

const appDir = join(import.meta.dirname, '..');
type ElectronApp = Awaited<ReturnType<typeof electron.launch>>;
type Window = Awaited<ReturnType<ElectronApp['firstWindow']>>;

/** 首启向导（0041）盖在主界面上：全新库必弹，出现就跳过。 */
async function skipWizardIfAny(win: Window): Promise<void> {
  const skip = win.getByRole('button', { name: '跳过向导' });
  try {
    await skip.waitFor({ state: 'visible', timeout: 8_000 });
    await skip.click();
  } catch {
    // 非首启库不弹向导
  }
}

/** 0038 托盘语义下 close() 只是收进托盘，进程不退；测试必须走 app.quit()。 */
async function quitApp(app: ElectronApp): Promise<void> {
  await app.evaluate(({ app: electronApp }) => electronApp.quit());
  await app.close();
}

/** 打开设置并切到「场景模板」节，返回设置面板 locator。 */
async function openScenarioSection(win: Window) {
  await win.locator('button[title="设置"]').click();
  const settings = win.getByRole('dialog', { name: '设置' });
  await settings.getByRole('button', { name: '场景模板' }).click();
  return settings;
}

test('设置页可新建自定义场景模板并在建区时可选', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'staffdesk-scenario-tpl-e2e-'));
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

    // 新建模板：名称 + 建对象引导 + 一块（标题自定），保存后列表出现。
    let settings = await openScenarioSection(win);
    await settings.getByRole('button', { name: '新建模板' }).click();
    const dialog = win.getByRole('dialog', { name: '新建场景模板' });
    await dialog.getByLabel('模板名称').fill('秋招冲刺');
    await dialog.getByLabel('建对象引导').fill('公司或岗位名');
    await dialog.getByLabel('块 1 标题').fill('公司速览');
    await dialog.getByRole('button', { name: '保存' }).click();
    await expect(settings.locator('.tpl-list')).toContainText('秋招冲刺');
    await expect(settings.locator('.tpl-list')).toContainText('公司或岗位名');

    // 关设置，建工作区：场景下拉出现「秋招冲刺」，选中建区后工作区 tag 显示。
    await settings.getByRole('button', { name: '关闭' }).click();
    await win.locator('.ws-switch').click();
    await win.getByRole('button', { name: '新建工作区' }).click();
    await win.getByRole('button', { name: '秋招冲刺', exact: true }).click();
    await win.locator('.ws-draft input').fill('秋招主区');
    await win.getByRole('button', { name: '创建' }).click();
    await expect(win.locator('.ws-switch')).toContainText('秋招主区');
    await expect(win.locator('.ws-switch .tag')).toHaveText('秋招冲刺');

    // 被工作区引用的模板删除被拒：toast 说明，模板仍在列表。
    settings = await openScenarioSection(win);
    const row = settings.locator('.tpl-row', { hasText: '秋招冲刺' });
    await row.getByRole('button', { name: '删除模板 秋招冲刺' }).click();
    await expect(win.locator('.toast')).toContainText('先移除或改区再删');
    await expect(settings.locator('.tpl-list')).toContainText('秋招冲刺');

    // 内置基线删除禁用（title 说明）。
    const builtinRow = settings.locator('.tpl-row', { hasText: '求职面试' });
    await expect(builtinRow.getByRole('button', { name: '删除模板 求职面试' })).toBeDisabled();

    if (process.env.STAFFDESK_E2E_SCREENSHOT_PATH) {
      await win.screenshot({ path: process.env.STAFFDESK_E2E_SCREENSHOT_PATH, fullPage: true });
    }
  } finally {
    await quitApp(app);
  }
});

test('建对象 placeholder 按场景引导', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'staffdesk-scenario-hint-e2e-'));
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

    // 建区选内置「尽调研究」：建对象表单 placeholder = 该模板的建对象引导。
    await win.locator('.ws-switch').click();
    await win.getByRole('button', { name: '新建工作区' }).click();
    await win.getByRole('button', { name: '尽调研究', exact: true }).click();
    await win.locator('.ws-draft input').fill('尽调区');
    await win.getByRole('button', { name: '创建' }).click();
    await expect(win.locator('.ws-switch')).toContainText('尽调区');

    await win.getByTitle('新建对象').click();
    await expect(win.locator('.ws-draft input')).toHaveAttribute(
      'placeholder',
      '盯一个标的：业务、团队、风险',
    );
    await win.getByRole('button', { name: '取消' }).click();

    // 切到「自定义」基线工作区：placeholder 回落基线引导。
    await win.locator('.ws-switch').click();
    await win.getByRole('button', { name: '新建工作区' }).click();
    await win.getByRole('button', { name: '自定义', exact: true }).click();
    await win.locator('.ws-draft input').fill('基线区');
    await win.getByRole('button', { name: '创建' }).click();
    await expect(win.locator('.ws-switch')).toContainText('基线区');

    await win.getByTitle('新建对象').click();
    await expect(win.locator('.ws-draft input')).toHaveAttribute(
      'placeholder',
      '自己配槽表和简报说明',
    );

    if (process.env.STAFFDESK_E2E_SCREENSHOT_PATH) {
      await win.screenshot({ path: process.env.STAFFDESK_E2E_SCREENSHOT_PATH, fullPage: true });
    }
  } finally {
    await quitApp(app);
  }
});
