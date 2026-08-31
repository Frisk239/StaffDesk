import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, _electron as electron } from '@playwright/test';

const appDir = join(import.meta.dirname, '..');

type Window = Awaited<ReturnType<Awaited<ReturnType<typeof electron.launch>>['firstWindow']>>;
type TidyState = {
  objects: Array<{ id: string; name: string; kind?: string }>;
  sources: Array<{ id: string; title: string; virtual?: boolean }>;
  claims: Array<{ id: string; predicate: string; text: string }>;
};
type StaffdeskTidyApi = {
  dispatch: (action: unknown) => Promise<TidyState>;
  snapshot: () => Promise<TidyState>;
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

test('整理提议卡出现且合并与编目交互全链落地', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'staffdesk-tidy-e2e-'));
  const brainFile = join(dir, 'brain.db');
  const app = await electron.launch({
    args: ['.'],
    cwd: appDir,
    env: {
      ...process.env,
      STAFFDESK_BRAIN: brainFile,
    },
  });
  const win = await app.firstWindow();
  await skipWizardIfAny(win);

  await win.evaluate(async () => {
    const api = (globalThis as unknown as { staffdesk: StaffdeskTidyApi }).staffdesk;
    await api.dispatch({ type: 'ADD_WORKSPACE', name: '整理验收区', scenario: '求职面试' });
    const created = await api.dispatch({ type: 'ADD_OBJECT', kind: '组织', name: '整理验收组织' });
    const object = created.objects.find((item) => item.name === '整理验收组织');
    if (!object) throw new Error('missing object');
    await api.dispatch({ type: 'ADD_SOURCE', title: '整理材料', body: '甲组织的材料。' });
    const withSource = await api.snapshot();
    const source = withSource.sources.find((item) => item.title === '整理材料' && !item.virtual);
    if (!source) throw new Error('missing source');
    await api.dispatch({ type: 'BIND_CONFIRMED', sourceId: source.id, objectIds: [object.id] });
    // 两条归一化等值主张（大小写差异）+ 一条未编目主张。
    await api.dispatch({
      type: 'EXTRACT_DONE',
      sourceId: source.id,
      claims: [
        {
          id: 'cl-tidy-keep',
          objectId: object.id,
          predicate: '使用技术',
          text: '甲组织主栈是 Go。',
          status: '成立',
          unverified: true,
          sourceId: source.id,
          span: '主栈是 Go',
          createdAt: '2026-08-30',
        },
        {
          id: 'cl-tidy-dup',
          objectId: object.id,
          predicate: '使用技术',
          text: '甲组织主栈是 go。',
          status: '成立',
          unverified: true,
          sourceId: source.id,
          span: '主栈为 go',
          createdAt: '2026-08-30',
        },
        {
          id: 'cl-tidy-uncat',
          objectId: object.id,
          predicate: '未编目',
          text: '内部在推进平台化。',
          status: '成立',
          unverified: true,
          sourceId: source.id,
          span: '内部在推进平台化',
          createdAt: '2026-08-30',
        },
      ],
    });
  });

  await win.getByTitle('待确认').click();
  await expect(win.getByText('建议合并 2 条重复主张（使用技术）')).toBeVisible();
  await expect(win.getByText('建议为未编目主张编目')).toBeVisible();
  await expect(win.getByText('保留', { exact: true })).toBeVisible();
  await expect(win.getByText('去掉', { exact: true })).toBeVisible();

  await win.getByRole('button', { name: '合并（保留首条，去掉 1 条重复）' }).click();
  await expect
    .poll(async () =>
      win.evaluate(async () => {
        const api = (globalThis as unknown as { staffdesk: StaffdeskTidyApi }).staffdesk;
        const snapshot = await api.snapshot();
        return {
          total: snapshot.claims.length,
          inSlot: snapshot.claims.filter((claim) => claim.predicate === '使用技术').length,
        };
      }),
    )
    .toEqual({ total: 2, inSlot: 1 });

  // 编目卡：先选拖槽，未选时并入按钮禁用。
  await win.getByTitle('待确认').click();
  const uncatCard = win.locator('.proposal-card', { hasText: '建议为未编目主张编目' });
  const mergeIntoSlot = uncatCard.getByRole('button', { name: /接受 · 并入/ });
  await expect(mergeIntoSlot).toBeDisabled();
  await uncatCard.locator('.proposal-select').selectOption('使用技术');
  await expect(mergeIntoSlot).toBeEnabled();
  await mergeIntoSlot.click();
  await expect
    .poll(async () =>
      win.evaluate(async () => {
        const api = (globalThis as unknown as { staffdesk: StaffdeskTidyApi }).staffdesk;
        const snapshot = await api.snapshot();
        return snapshot.claims.find((claim) => claim.id === 'cl-tidy-uncat')?.predicate;
      }),
    )
    .toBe('使用技术');

  // 决策结果卡把视图带回对象页：该槽下能看到并入的主张文本。
  await expect(win.getByText('内部在推进平台化。').first()).toBeVisible();
  await quitApp(app);
});

test('建对象提议：抽取发现的新主体选种类确认后进入对象列表', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'staffdesk-newobj-e2e-'));
  const brainFile = join(dir, 'brain.db');
  const app = await electron.launch({
    args: ['.'],
    cwd: appDir,
    env: {
      ...process.env,
      STAFFDESK_BRAIN: brainFile,
    },
  });
  const win = await app.firstWindow();
  await skipWizardIfAny(win);

  // 零主张 + 未知名：走 EXTRACT_DONE 早退分支，也必须产建对象提议（0052）。
  await win.evaluate(async () => {
    const api = (globalThis as unknown as { staffdesk: StaffdeskTidyApi }).staffdesk;
    await api.dispatch({ type: 'ADD_WORKSPACE', name: '建对象验收区', scenario: '求职面试' });
    const created = await api.dispatch({
      type: 'ADD_OBJECT',
      kind: '组织',
      name: '建对象锚点组织',
    });
    const object = created.objects.find((item) => item.name === '建对象锚点组织');
    if (!object) throw new Error('missing object');
    await api.dispatch({ type: 'ADD_SOURCE', title: '建对象材料', body: 'JD 里出现了新公司。' });
    const withSource = await api.snapshot();
    const source = withSource.sources.find((item) => item.title === '建对象材料' && !item.virtual);
    if (!source) throw new Error('missing source');
    await api.dispatch({ type: 'BIND_CONFIRMED', sourceId: source.id, objectIds: [object.id] });
    await api.dispatch({
      type: 'EXTRACT_DONE',
      sourceId: source.id,
      claims: [],
      unknownObjectNames: ['建对象新主体公司'],
    });
  });

  await win.getByTitle('待确认').click();
  const newObjectCard = win.locator('.proposal-card', {
    hasText: '建议新建对象「建对象新主体公司」',
  });
  await expect(newObjectCard).toBeVisible();
  // 种类下拉默认「组织」；改选「项目」后确认。
  await newObjectCard.locator('.proposal-select').selectOption('项目');
  await newObjectCard
    .getByRole('button', { name: '确认 · 建立项目对象「建对象新主体公司」' })
    .click();
  await expect
    .poll(async () =>
      win.evaluate(async () => {
        const api = (globalThis as unknown as { staffdesk: StaffdeskTidyApi }).staffdesk;
        const snapshot = await api.snapshot();
        const created = snapshot.objects.find((item) => item.name === '建对象新主体公司');
        return created ? `${created.kind}:${created.id.startsWith('proj-')}` : 'missing';
      }),
    )
    .toBe('项目:true');

  // 确认结果卡落在锚对象账页，提示不自动绑定。
  await expect(win.getByText('来源不会自动绑定到新对象', { exact: false })).toBeVisible();
  await quitApp(app);
});
