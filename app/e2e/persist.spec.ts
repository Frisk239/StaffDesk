import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, _electron as electron } from '@playwright/test';

const appDir = join(import.meta.dirname, '..');

type Window = Awaited<ReturnType<Awaited<ReturnType<typeof electron.launch>>['firstWindow']>>;
type PersistState = {
  objects: Array<{ id: string; name: string }>;
  sources: Array<{ id: string; title: string; virtual?: boolean }>;
  claims: Array<{ id: string; unverified: boolean }>;
  writeQueue: Array<{ id: string; claimId?: string }>;
};
type StaffdeskPersistApi = {
  dispatch: (action: unknown) => Promise<PersistState>;
  snapshot: () => Promise<PersistState>;
};

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

test('待确认写提议重启后仍显示并可确认', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'staffdesk-write-queue-e2e-'));
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
  await win.evaluate(async () => {
    const api = (globalThis as unknown as { staffdesk: StaffdeskPersistApi }).staffdesk;
    await api.dispatch({ type: 'ADD_WORKSPACE', name: '提议恢复区', scenario: '求职面试' });
    const created = await api.dispatch({ type: 'ADD_OBJECT', kind: '组织', name: '提议恢复组织' });
    const object = created.objects.find((item) => item.name === '提议恢复组织');
    if (!object) throw new Error('missing object');
    await api.dispatch({ type: 'ADD_SOURCE', title: '恢复材料', body: '团队主栈是 Rust。' });
    const withSource = await api.snapshot();
    const source = withSource.sources.find((item) => item.title === '恢复材料' && !item.virtual);
    if (!source) throw new Error('missing source');
    await api.dispatch({ type: 'BIND_CONFIRMED', sourceId: source.id, objectIds: [object.id] });
    await api.dispatch({
      type: 'EXTRACT_DONE',
      sourceId: source.id,
      claims: [
        {
          id: 'cl-write-queue-e2e',
          objectId: object.id,
          predicate: '使用技术',
          text: '团队主栈是 Rust',
          status: '成立',
          unverified: true,
          sourceId: source.id,
          span: '团队主栈是 Rust',
          createdAt: '2026-08-30',
        },
      ],
    });
    await api.dispatch({
      type: 'ENQUEUE_WRITE',
      draft: {
        objectId: object.id,
        kind: '晋升',
        claimId: 'cl-write-queue-e2e',
        headline: '晋升「团队主栈是 Rust」',
        evidence: '团队主栈是 Rust',
        outbound: true,
      },
    });
  });
  await quitApp(first);

  const second = await launch();
  const win2 = await second.firstWindow();
  await skipWizardIfAny(win2);
  await win2.evaluate(async () => {
    const api = (globalThis as unknown as { staffdesk: StaffdeskPersistApi }).staffdesk;
    const snapshot = await api.snapshot();
    const object = snapshot.objects.find((item) => item.name === '提议恢复组织');
    if (!object) throw new Error('missing object after restart');
    await api.dispatch({ type: 'SET_VIEW', view: { kind: 'object', objectId: object.id } });
  });

  await expect(win2.getByText('晋升「团队主栈是 Rust」')).toBeVisible();
  await expect(win2.getByText('通过后可出站当定论')).toBeVisible();
  await win2.getByRole('button', { name: '确认' }).click();
  await expect
    .poll(async () =>
      win2.evaluate(async () => {
        const api = (globalThis as unknown as { staffdesk: StaffdeskPersistApi }).staffdesk;
        const snapshot = await api.snapshot();
        return {
          unverified: snapshot.claims.find((claim) => claim.id === 'cl-write-queue-e2e')
            ?.unverified,
          queued: snapshot.writeQueue.length,
        };
      }),
    )
    .toEqual({ unverified: false, queued: 0 });
  await quitApp(second);
});
