import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, _electron as electron } from '@playwright/test';

const appDir = join(import.meta.dirname, '..');
type ElectronApp = Awaited<ReturnType<typeof electron.launch>>;
type Window = Awaited<ReturnType<ElectronApp['firstWindow']>>;

type PrimaryState = {
  objects: Array<{ id: string; name: string }>;
  sources: Array<{
    id: string;
    title: string;
    virtual?: boolean;
    boundObjectIds: string[];
    bindingRoles?: Record<string, string>;
  }>;
  claims: Array<{
    id: string;
    sourceId: string;
    status: string;
    closeReason?: string;
    text: string;
  }>;
  writeQueue: Array<{ id: string; kind: string; headline: string; role?: string }>;
  proposals: Array<{ id: string; title: string; pending: boolean }>;
};

type StaffdeskApi = {
  dispatch: (action: unknown) => Promise<PrimaryState>;
  snapshot: () => Promise<PrimaryState>;
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

test('绑材料建议卡确认主键可见，主键新旧冲突确认过时', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'staffdesk-primary-e2e-'));
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

    await win.evaluate(async () => {
      const api = (globalThis as unknown as { staffdesk: StaffdeskApi }).staffdesk;
      await api.dispatch({ type: 'ADD_WORKSPACE', name: '主键验收区', scenario: '求职面试' });
      const created = await api.dispatch({
        type: 'ADD_OBJECT',
        kind: '组织',
        name: '主键验收组织',
      });
      const object = created.objects.find((item) => item.name === '主键验收组织');
      if (!object) throw new Error('missing object');
      await api.dispatch({
        type: 'SET_OBJECT_NOTE',
        objectId: object.id,
        note: '官网 https://zhanqiao.dev',
      });
      await api.dispatch({
        type: 'ADD_SOURCE',
        title: 'https://zhanqiao.dev/about',
        body: '主键验收组织主栈是 Go。',
      });
      await api.dispatch({ type: 'SET_VIEW', view: { kind: 'inbox' } });
    });

    await win.getByRole('button', { name: /https:\/\/zhanqiao\.dev\/about/ }).click();
    await win.getByRole('button', { name: '绑定', exact: true }).click();
    await win.getByLabel('主键验收组织').check();
    await win.getByRole('button', { name: /确认绑定/ }).click();

    await expect(win.getByText('建议标为主键？')).toBeVisible();
    await win.getByRole('button', { name: '标为主键' }).click();

    await win.getByRole('button', { name: '来源', exact: true }).click();
    await expect(win.locator('.source-card .tag.role').first()).toHaveText('主键');

    await win.evaluate(async () => {
      const api = (globalThis as unknown as { staffdesk: StaffdeskApi }).staffdesk;
      const snap = await api.snapshot();
      const object = snap.objects.find((item) => item.name === '主键验收组织');
      const oldSource = snap.sources.find(
        (item) => item.title === 'https://zhanqiao.dev/about' && !item.virtual,
      );
      if (!object || !oldSource) throw new Error('missing bound source');
      await api.dispatch({
        type: 'EXTRACT_DONE',
        sourceId: oldSource.id,
        claims: [
          {
            id: 'cl-old-primary',
            objectId: object.id,
            predicate: '后端主栈',
            text: '主键验收组织主栈是 Go',
            status: '成立',
            unverified: true,
            sourceId: oldSource.id,
            span: '主栈是 Go',
            validFrom: '2024-01-01',
            createdAt: '2024-01-01',
          },
        ],
      });
      await api.dispatch({
        type: 'ADD_SOURCE',
        title: 'https://zhanqiao.dev/changelog',
        body: '主键验收组织主栈是 Rust。',
      });
      const withNew = await api.snapshot();
      const newSource = withNew.sources.find(
        (item) => item.title === 'https://zhanqiao.dev/changelog' && !item.virtual,
      );
      if (!newSource) throw new Error('missing new source');
      await api.dispatch({
        type: 'BIND_CONFIRMED',
        sourceId: newSource.id,
        objectIds: [object.id],
      });
      const queued = (await api.snapshot()).writeQueue.find(
        (write) => write.kind === '设角色' && write.role === '主键',
      );
      if (queued) await api.dispatch({ type: 'CONFIRM_WRITE', writeId: queued.id });
      await api.dispatch({
        type: 'SET_SOURCE_ROLE',
        sourceId: newSource.id,
        objectId: object.id,
        role: '主键',
      });
      await api.dispatch({
        type: 'EXTRACT_DONE',
        sourceId: newSource.id,
        claims: [
          {
            id: 'cl-new-primary',
            objectId: object.id,
            predicate: '后端主栈',
            text: '主键验收组织主栈是 Rust',
            status: '成立',
            unverified: true,
            sourceId: newSource.id,
            span: '主栈是 Rust',
            validFrom: '2026-06-01',
            createdAt: '2026-06-01',
          },
        ],
      });
    });

    await win.getByTitle('待确认').click();
    await expect(win.getByText('建议：旧版过时？')).toBeVisible();
    await win.getByRole('button', { name: '确认旧版过时（关窗）' }).click();

    await expect
      .poll(async () =>
        win.evaluate(async () => {
          const api = (globalThis as unknown as { staffdesk: StaffdeskApi }).staffdesk;
          const snapshot = await api.snapshot();
          const old = snapshot.claims.find((claim) => claim.id === 'cl-old-primary');
          return { status: old?.status, closeReason: old?.closeReason };
        }),
      )
      .toEqual({ status: '过时', closeReason: '被主键新版取代' });
  } finally {
    await quitApp(app);
  }
});
