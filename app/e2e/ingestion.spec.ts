import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, _electron as electron } from '@playwright/test';
import { simplePdf } from '../tests/helpers/pdf';
import { closeServer, installStubModel, serveStubModel } from './stub-model';

const appDir = join(import.meta.dirname, '..');
type ElectronApp = Awaited<ReturnType<typeof electron.launch>>;
type Window = Awaited<ReturnType<ElectronApp['firstWindow']>>;

type StaffdeskApiForSeed = {
  snapshot: () => Promise<{
    sources: Array<{
      id: string;
      title: string;
      virtual?: boolean;
      boundObjectIds: string[];
      origin?: { kind?: string; pageCount?: number };
    }>;
    ingestJobs: Array<{ status: string; failureKind?: string; sourceId?: string }>;
    extractJobs: Array<{ sourceId: string; status: string }>;
  }>;
  dispatch: (action: unknown) => Promise<{
    objects: Array<{ id: string; name: string }>;
  }>;
  ingestUrl: (url: string) => Promise<unknown>;
  chooseAndIngestFiles: () => Promise<unknown>;
  runExtract: (sourceId: string) => Promise<unknown>;
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

async function serve(): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer((req, res) => {
    if (req.url === '/ok') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(
        '<html><head><title>真实导入材料</title></head><body><main>真实导入组织使用 Rust。</main></body></html>',
      );
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('missing');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server listen failed');
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

test('Inbox URL 导入失败不造来源，成功后可绑定并触发抽取', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'staffdesk-ingestion-e2e-'));
  const { server, baseUrl } = await serve();
  // 自足桩模型 + 隔离 userData：抽取链路不依赖本机真实模型配置，CI 干净机器同样成立。
  const stub = await serveStubModel([
    {
      objectName: '真实导入组织',
      predicate: '使用技术',
      text: '真实导入组织使用 Rust',
      span: '使用 Rust',
    },
  ]);
  const app = await electron.launch({
    args: ['.', `--user-data-dir=${join(dir, 'userData')}`],
    cwd: appDir,
    env: {
      ...process.env,
      STAFFDESK_BRAIN: join(dir, 'brain.db'),
    },
  });

  try {
    const win = await app.firstWindow();
    await skipWizardIfAny(win);
    await installStubModel(win, stub.baseUrl);
    await win.evaluate(async () => {
      const api = (globalThis as unknown as { staffdesk: StaffdeskApiForSeed }).staffdesk;
      await api.dispatch({ type: 'ADD_WORKSPACE', name: '导入验收区', scenario: '求职面试' });
      await api.dispatch({ type: 'ADD_OBJECT', kind: '组织', name: '真实导入组织' });
      await api.dispatch({ type: 'SET_VIEW', view: { kind: 'inbox' } });
    });

    await expect(win.getByPlaceholder('粘贴文本或 URL')).toBeVisible();
    await win.evaluate(async (url) => {
      const api = (globalThis as unknown as { staffdesk: StaffdeskApiForSeed }).staffdesk;
      await api.ingestUrl(url);
    }, `${baseUrl}/missing`);
    await expect(win.locator('.ingest-job.failed')).toContainText('导入失败');
    let state = await win.evaluate(async () => {
      const api = (globalThis as unknown as { staffdesk: StaffdeskApiForSeed }).staffdesk;
      return api.snapshot();
    });
    expect(state.sources.filter((source) => !source.virtual)).toHaveLength(0);
    expect(state.ingestJobs.some((job) => job.failureKind === 'fetch-failed')).toBe(true);

    await win.evaluate(async (url) => {
      const api = (globalThis as unknown as { staffdesk: StaffdeskApiForSeed }).staffdesk;
      await api.ingestUrl(url);
    }, `${baseUrl}/ok`);
    const sourceCard = win.getByRole('button', { name: /真实导入材料/ });
    await expect(sourceCard).toBeVisible();
    await sourceCard.click();
    await expect(win.locator('.source-body')).toContainText('真实导入组织使用 Rust');

    await win.getByRole('button', { name: '绑定', exact: true }).click();
    await win.getByLabel('真实导入组织').check();
    await win.getByRole('button', { name: /确认绑定/ }).click();
    await expect(win.getByText('真实导入组织').first()).toBeVisible();
    await expect
      .poll(async () => {
        return win.evaluate(async () => {
          const api = (globalThis as unknown as { staffdesk: StaffdeskApiForSeed }).staffdesk;
          const snapshot = await api.snapshot();
          const status = snapshot.extractJobs[0]?.status;
          // 桩模型下自动抽取可能很快完成，只要走上抽取路径（而非未配置）即算数。
          return status === '抽取中' || status === '完成' ? 'engaged' : (status ?? '');
        });
      })
      .toBe('engaged');

    await win.evaluate(async () => {
      const api = (globalThis as unknown as { staffdesk: StaffdeskApiForSeed }).staffdesk;
      const snapshot = await api.snapshot();
      const source = snapshot.sources.find((item) => !item.virtual);
      if (!source) throw new Error('missing source');
      await api.runExtract(source.id);
    });
    await expect
      .poll(async () => {
        return win.evaluate(async () => {
          const api = (globalThis as unknown as { staffdesk: StaffdeskApiForSeed }).staffdesk;
          const snapshot = await api.snapshot();
          const status = snapshot.extractJobs[0]?.status;
          return Boolean(status && status !== '抽取中');
        });
      })
      .toBe(true);

    state = await win.evaluate(async () => {
      const api = (globalThis as unknown as { staffdesk: StaffdeskApiForSeed }).staffdesk;
      return api.snapshot();
    });
    expect(state.sources.filter((source) => !source.virtual)).toHaveLength(1);
    expect(state.sources[0]?.boundObjectIds).toHaveLength(1);
  } finally {
    await quitApp(app);
    await new Promise((resolve) => server.close(resolve));
    await closeServer(stub.server);
  }
});

test('Inbox 文本、TXT 与 PDF 导入都会写入真实正文', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'staffdesk-ingestion-e2e-'));
  const txt = join(dir, '真实材料.txt');
  const pdf = join(dir, 'pdf-material.pdf');
  writeFileSync(txt, '真实 TXT 材料包含岗位画像。');
  writeFileSync(pdf, simplePdf('PDF material says Acme uses Rust.'));
  const app = await electron.launch({
    args: ['.'],
    cwd: appDir,
    env: {
      ...process.env,
      STAFFDESK_BRAIN: join(dir, 'brain.db'),
    },
  });

  try {
    await app.evaluate(
      ({ dialog }, filePaths) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths });
      },
      [txt, pdf],
    );
    const win = await app.firstWindow();
    await skipWizardIfAny(win);
    await win.evaluate(async () => {
      const api = (globalThis as unknown as { staffdesk: StaffdeskApiForSeed }).staffdesk;
      await api.dispatch({ type: 'ADD_WORKSPACE', name: '文件进料验收区', scenario: '求职面试' });
      await api.dispatch({ type: 'SET_VIEW', view: { kind: 'inbox' } });
    });
    await expect(win.getByText('文件进料验收区').first()).toBeVisible();
    await expect(win.getByText('没有未绑定材料')).toBeVisible();

    await win.getByPlaceholder('粘贴文本或 URL').fill('真实粘贴材料包含候选人画像。');
    const addButton = win.getByRole('button', { name: '加入 Inbox' });
    await expect(addButton).toBeEnabled();
    await addButton.click();
    const textCard = win.getByRole('button', { name: /真实粘贴材料/ });
    await expect(textCard).toBeVisible();
    await textCard.click();
    await expect(win.locator('.source-body')).toContainText('真实粘贴材料包含候选人画像');

    await win.getByRole('button', { name: '选择文件' }).click();
    const fileCard = win.getByRole('button', { name: /真实材料.txt/ });
    await expect(fileCard).toBeVisible();
    await fileCard.click();
    await expect(win.locator('.source-body')).toContainText('真实 TXT 材料包含岗位画像');

    const pdfCard = win.getByRole('button', { name: /pdf-material.pdf/ });
    await expect(pdfCard).toBeVisible();
    await pdfCard.click();
    await expect(win.locator('.source-body')).toContainText('PDF material says Acme uses Rust');
    await expect(win.getByText('1 页')).toBeVisible();

    const state = await win.evaluate(async () => {
      const api = (globalThis as unknown as { staffdesk: StaffdeskApiForSeed }).staffdesk;
      return api.snapshot();
    });
    expect(state.sources.filter((source) => !source.virtual)).toHaveLength(3);
    expect(
      state.sources.find((source) => source.title === 'pdf-material.pdf')?.origin,
    ).toMatchObject({
      kind: 'file',
      pageCount: 1,
    });
  } finally {
    await quitApp(app);
    rmSync(dir, { recursive: true, force: true });
  }
});
