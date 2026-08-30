import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, _electron as electron } from '@playwright/test';

const appDir = join(import.meta.dirname, '..');
type ElectronApp = Awaited<ReturnType<typeof electron.launch>>;
type Window = Awaited<ReturnType<ElectronApp['firstWindow']>>;

type StaffdeskApiForSeed = {
  snapshot: () => Promise<{
    objects: Array<{ id: string; name: string }>;
    sources: Array<{ id: string; title: string }>;
    claims: Array<{
      sourceId: string;
      status: string;
      closeReason?: string;
      validTo?: string;
    }>;
  }>;
  dispatch: (action: unknown) => Promise<{
    objects: Array<{ id: string; name: string }>;
    sources: Array<{ id: string; title: string }>;
  }>;
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

test('删除来源需要确认并说明绑定和主张影响', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'staffdesk-source-e2e-'));
  const app = await electron.launch({
    args: ['.'],
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
      let state = await api.dispatch({
        type: 'ADD_WORKSPACE',
        name: '来源删除验收区',
        scenario: '求职面试',
      });
      state = await api.dispatch({ type: 'ADD_OBJECT', kind: '组织', name: '来源删除组织' });
      const object = state.objects.find((item) => item.name === '来源删除组织');
      if (!object) throw new Error('Object seed failed');
      state = await api.dispatch({
        type: 'ADD_SOURCE',
        title: '删除验证材料',
        body: '来源删除组织主栈是 Go。融资轮次为 A 轮。',
      });
      const source = state.sources.find((item) => item.title === '删除验证材料');
      if (!source) throw new Error('Source seed failed');
      await api.dispatch({ type: 'BIND_CONFIRMED', sourceId: source.id, objectIds: [object.id] });
      await api.dispatch({
        type: 'EXTRACT_DONE',
        sourceId: source.id,
        claims: [
          {
            id: 'claim-e2e-delete-source-1',
            objectId: object.id,
            predicate: '后端主栈',
            text: '来源删除组织主栈是 Go',
            status: '成立',
            unverified: true,
            sourceId: source.id,
            span: '来源删除组织主栈是 Go',
            createdAt: '2026-08-30T00:00:00.000Z',
          },
        ],
      });
      await api.dispatch({ type: 'SET_VIEW', view: { kind: 'object', objectId: object.id } });
      return { objectId: object.id, sourceId: source.id };
    });

    await expect(win.getByText('来源删除组织').first()).toBeVisible();
    await win.getByRole('button', { name: '打开标签页' }).click();
    await win.locator('.tab-picker-grid').getByRole('button', { name: '来源' }).click();
    await expect(win.locator('.sources-pane')).toContainText('删除验证材料');
    await win.locator('.source-head').filter({ hasText: '删除验证材料' }).click();
    await expect(win.locator('.sources-pane')).toContainText('已抽取 1 条');

    await win.locator('.source-actions').getByRole('button', { name: '删除来源' }).click();
    const dialog = win.getByRole('dialog', { name: '删除来源' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('移除 1 个绑定');
    await expect(dialog).toContainText('把 1 条相关主张关窗为「来源删除」');
    await win.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(win.locator('.sources-pane')).toContainText('删除验证材料');

    await win.locator('.source-actions').getByRole('button', { name: '删除来源' }).click();
    await win.getByRole('button', { name: '确认删除' }).click();
    await expect(dialog).toBeHidden();
    await expect(win.locator('.sources-pane')).not.toContainText('删除验证材料');

    const finalState = await win.evaluate(async () => {
      const api = (globalThis as unknown as { staffdesk: StaffdeskApiForSeed }).staffdesk;
      return api.snapshot();
    });
    expect(finalState.sources.some((item) => item.id === seeded.sourceId)).toBe(false);
    const closed = finalState.claims.filter((claim) => claim.sourceId === seeded.sourceId);
    expect(closed).toHaveLength(1);
    expect(closed[0]?.status).toBe('过时');
    expect(closed[0]?.closeReason).toBe('来源删除');
    expect(closed[0]?.validTo).toBeTruthy();

    await win.locator('button[title="设置"]').click();
    const settings = win.getByRole('dialog', { name: '设置' });
    await expect(settings).toContainText('删除验证材料');
    await expect(settings).toContainText('1 个绑定 · 1 条主张');
    await settings
      .locator('.source-recovery-row')
      .filter({ hasText: '删除验证材料' })
      .getByRole('button', { name: '恢复来源' })
      .click();
    await win.getByRole('button', { name: '关闭' }).click();
    await expect(win.locator('.sources-pane')).toContainText('删除验证材料');

    const restoredState = await win.evaluate(async () => {
      const api = (globalThis as unknown as { staffdesk: StaffdeskApiForSeed }).staffdesk;
      return api.snapshot();
    });
    expect(restoredState.sources.some((item) => item.id === seeded.sourceId)).toBe(true);
    const restored = restoredState.claims.filter((claim) => claim.sourceId === seeded.sourceId);
    expect(restored).toHaveLength(1);
    expect(restored[0]?.status).toBe('成立');
    expect(restored[0]?.closeReason).toBeUndefined();
  } finally {
    await quitApp(app);
  }
});
