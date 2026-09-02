import { mkdtempSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { expect, test, _electron as electron } from '@playwright/test';

// 审计 F8：旧库遗留的 unparsed 占位可「重新获取」原文（预填从占位标题/正文里提 URL），
// 「删除占位」入口常驻（Spec 评审：URL 已死的占位也必须能删，不与重导成败挂钩），走既有删除确认，不自动删。
// 正文从本地 http 服务真实抓取，不出外网。

const appDir = join(import.meta.dirname, '..');
type ElectronApp = Awaited<ReturnType<typeof electron.launch>>;
type Window = Awaited<ReturnType<ElectronApp['firstWindow']>>;

type InboxState = {
  inbox: string[];
  sources: Array<{ id: string; title: string; unparsed?: boolean }>;
};

type StaffdeskApiForInbox = {
  dispatch: (action: unknown) => Promise<InboxState>;
  snapshot: () => Promise<InboxState>;
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

async function serveLegacyPage(): Promise<{ server: Server; url: string }> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(
      '<html><head><title>重导正文页</title></head><body><p>重导验收组织主栈是 Go。</p></body></html>',
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('legacy page listen failed');
  return { server, url: `http://127.0.0.1:${address.port}/legacy-doc` };
}

test('unparsed 旧占位：预填 URL 重新获取原文，成功后可删除占位', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'staffdesk-unparsed-e2e-'));
  const legacy = await serveLegacyPage();
  const launch = () =>
    electron.launch({
      args: ['.', `--user-data-dir=${join(dir, 'user-data')}`],
      cwd: appDir,
      env: {
        ...process.env,
        STAFFDESK_BRAIN: join(dir, 'brain.db'),
      },
    });

  let app = await launch();
  try {
    const win = await app.firstWindow();
    await skipWizardIfAny(win);
    await win.evaluate(async (url) => {
      const api = (globalThis as unknown as { staffdesk: StaffdeskApiForInbox }).staffdesk;
      await api.dispatch({ type: 'ADD_WORKSPACE', name: '重导验收区', scenario: '求职面试' });
      await api.dispatch({
        type: 'ADD_SOURCE',
        title: url,
        body: `旧版 PDF 占位说明，原文见 ${url}`,
      });
      await api.dispatch({ type: 'SET_VIEW', view: { kind: 'inbox' } });
    }, legacy.url);
  } finally {
    await quitApp(app);
  }

  // unparsed 只可能来自旧库：直接把这条来源标成旧版占位，再重启加载。
  const db = new Database(join(dir, 'brain.db'));
  db.prepare('UPDATE sources SET unparsed = 1 WHERE title = ?').run(legacy.url);
  db.close();

  app = await launch();
  try {
    const win = await app.firstWindow();
    await skipWizardIfAny(win);
    await win.evaluate(async () => {
      const api = (globalThis as unknown as { staffdesk: StaffdeskApiForInbox }).staffdesk;
      await api.dispatch({ type: 'SET_VIEW', view: { kind: 'inbox' } });
    });

    await win.getByRole('button', { name: new RegExp(legacy.url.replaceAll('/', '\\/')) }).click();
    await expect(win.getByText('旧版待重新导入').first()).toBeVisible();

    // 预填：占位标题里的 URL 被提出来，走既有主进程 URL 进料。
    const refetchBox = win.getByPlaceholder('粘贴原文链接重新获取');
    await expect(refetchBox).toHaveValue(legacy.url);
    await win.getByRole('button', { name: '重新获取', exact: true }).click();

    // 新来源落进 Inbox（真实抓取本地服务），占位行给「删除占位」入口。
    await expect(win.getByRole('button', { name: /重导正文页/ })).toBeVisible({ timeout: 15_000 });
    await expect(win.getByRole('button', { name: '删除占位' })).toBeVisible();
    expect(
      await win.evaluate(async () => {
        const api = (globalThis as unknown as { staffdesk: StaffdeskApiForInbox }).staffdesk;
        const snap = await api.snapshot();
        return snap.sources.filter((source) => source.unparsed).length;
      }),
    ).toBe(1);

    await win.getByRole('button', { name: '删除占位' }).click();
    await win.getByRole('button', { name: '确认删除' }).click();
    await expect
      .poll(async () =>
        win.evaluate(async () => {
          const api = (globalThis as unknown as { staffdesk: StaffdeskApiForInbox }).staffdesk;
          const snap = await api.snapshot();
          return snap.sources.filter((source) => source.unparsed).length;
        }),
      )
      .toBe(0);
  } finally {
    await quitApp(app);
    await new Promise<void>((resolve) => legacy.server.close(() => resolve()));
  }
});
