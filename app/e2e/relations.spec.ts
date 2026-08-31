import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, _electron as electron } from '@playwright/test';

const appDir = join(import.meta.dirname, '..');
type ElectronApp = Awaited<ReturnType<typeof electron.launch>>;
type Window = Awaited<ReturnType<ElectronApp['firstWindow']>>;

type RelationsState = {
  objects: Array<{ id: string; name: string; relationIds: string[] }>;
};

type StaffdeskApi = {
  dispatch: (action: unknown) => Promise<RelationsState>;
  snapshot: () => Promise<RelationsState>;
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

// 0038 托盘语义下 close() 只是收进托盘；测试必须走 app.evaluate quit。
async function quitApp(app: ElectronApp): Promise<void> {
  await app.evaluate(({ app: electronApp }) => electronApp.quit());
  await app.close();
}

async function launchApp(label: string): Promise<{ app: ElectronApp; win: Window }> {
  const dir = mkdtempSync(join(tmpdir(), `staffdesk-${label}-e2e-`));
  const app = await electron.launch({
    args: ['.', `--user-data-dir=${join(dir, 'user-data')}`],
    cwd: appDir,
    env: {
      ...process.env,
      STAFFDESK_BRAIN: join(dir, 'brain.db'),
    },
  });
  const win = await app.firstWindow();
  await skipWizardIfAny(win);
  return { app, win };
}

test('对象页可添加关系、点 chip 跳转到对端并可移除', async () => {
  const { app, win } = await launchApp('relations-crud');
  try {
    const ids = await win.evaluate(async () => {
      const a = (globalThis as unknown as { staffdesk: StaffdeskApi }).staffdesk;
      await a.dispatch({ type: 'ADD_WORKSPACE', name: '关系验收区', scenario: '求职面试' });
      await a.dispatch({ type: 'ADD_OBJECT', kind: '组织', name: '关系验收组织' });
      // 第二次 ADD_OBJECT 会把视图开到新对象上：先建人，再显式回组织页。
      await a.dispatch({ type: 'ADD_OBJECT', kind: '人', name: '关系验收人物' });
      const state = await a.snapshot();
      const org = state.objects.find((item) => item.name === '关系验收组织');
      const person = state.objects.find((item) => item.name === '关系验收人物');
      if (!org || !person) throw new Error('missing object');
      await a.dispatch({ type: 'SET_VIEW', view: { kind: 'object', objectId: org.id } });
      return { orgId: org.id, personId: person.id };
    });

    await expect(win.getByText('还没有关系')).toBeVisible();
    await win.getByRole('button', { name: '添加关系' }).click();
    await win.locator('.bind-panel').getByText('关系验收人物').click();
    await win.getByRole('button', { name: '确认添加（1）' }).click();

    const chip = win.locator('.rel-chip');
    await expect(chip).toHaveCount(1);
    await expect(chip).toContainText('关系验收人物');
    await expect(chip).toContainText('人');

    await chip.locator('.rel-jump').click();
    await expect(win.locator('.proj-name')).toHaveText('关系验收人物');
    await expect(win.locator('.rel-chip')).toHaveCount(1);
    await expect(win.locator('.rel-chip')).toContainText('关系验收组织');

    await win.evaluate((orgId) => {
      const a = (globalThis as unknown as { staffdesk: StaffdeskApi }).staffdesk;
      return a.dispatch({ type: 'SET_VIEW', view: { kind: 'object', objectId: orgId } });
    }, ids.orgId);
    await win.locator('.rel-chip .rel-remove').click();
    await expect(win.getByText('还没有关系')).toBeVisible();

    // 对称双侧：回到人对象页，那条边同样消失。
    await win.evaluate((personId) => {
      const a = (globalThis as unknown as { staffdesk: StaffdeskApi }).staffdesk;
      return a.dispatch({ type: 'SET_VIEW', view: { kind: 'object', objectId: personId } });
    }, ids.personId);
    await expect(win.locator('.proj-name')).toHaveText('关系验收人物');
    await expect(win.getByText('还没有关系')).toBeVisible();
  } finally {
    await quitApp(app);
  }
});

test('对象 note 可由 dispatch 显示并支持行内编辑提交', async () => {
  const { app, win } = await launchApp('relations-note');
  try {
    const orgId = await win.evaluate(async () => {
      const a = (globalThis as unknown as { staffdesk: StaffdeskApi }).staffdesk;
      await a.dispatch({ type: 'ADD_WORKSPACE', name: '备注验收区', scenario: '求职面试' });
      const created = await a.dispatch({ type: 'ADD_OBJECT', kind: '组织', name: '备注验收组织' });
      const org = created.objects.find((item) => item.name === '备注验收组织');
      if (!org) throw new Error('missing object');
      return org.id;
    });

    await expect(win.getByRole('button', { name: '加备注' })).toBeVisible();
    await win.evaluate((id) => {
      const a = (globalThis as unknown as { staffdesk: StaffdeskApi }).staffdesk;
      return a.dispatch({ type: 'SET_OBJECT_NOTE', objectId: id, note: '重点要搞清楚的雇主' });
    }, orgId);
    await expect(win.locator('.proj-note')).toHaveText('重点要搞清楚的雇主');

    // 点击进入行内编辑，Enter 提交。
    await win.locator('.proj-note').click();
    await win.locator('.note-edit-input').fill('重点客户');
    await win.keyboard.press('Enter');
    await expect(win.locator('.proj-note')).toHaveText('重点客户');

    // 失焦提交；空输入提交即清空，回到「加备注」入口。
    await win.locator('.proj-note').click();
    await win.locator('.note-edit-input').fill('失焦提交');
    await win.locator('.proj-name').click();
    await expect(win.locator('.proj-note')).toHaveText('失焦提交');
    await win.locator('.proj-note').click();
    await win.locator('.note-edit-input').fill('   ');
    await win.locator('.proj-name').click();
    await expect(win.getByRole('button', { name: '加备注' })).toBeVisible();
  } finally {
    await quitApp(app);
  }
});
