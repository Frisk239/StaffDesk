import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, _electron as electron } from '@playwright/test';

// 审计 F4 + 0062：简报出站出口（复制 Markdown / 导出 .md，引用转脚注）与主键标注。
// 无模型：brief:generate 走账本组装器；隔离 brain，不触外网。

const appDir = join(import.meta.dirname, '..');
type ElectronApp = Awaited<ReturnType<typeof electron.launch>>;
type Window = Awaited<ReturnType<ElectronApp['firstWindow']>>;

type BriefExportState = {
  objects: Array<{ id: string; name: string }>;
  sources: Array<{ id: string; title: string }>;
};

type StaffdeskApiForBrief = {
  dispatch: (action: unknown) => Promise<BriefExportState>;
  generateBrief: (objectId: string) => Promise<BriefExportState>;
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

test('简报可复制与导出 Markdown（引用转脚注），主键主张带主键来源标注', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'staffdesk-brief-export-e2e-'));
  const exportedPath = join(dir, '导出的简报.md');
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
      const api = (globalThis as unknown as { staffdesk: StaffdeskApiForBrief }).staffdesk;
      await api.dispatch({ type: 'ADD_WORKSPACE', name: '简报导出验收区', scenario: '求职面试' });
      const created = await api.dispatch({
        type: 'ADD_OBJECT',
        kind: '组织',
        name: '简报导出组织',
      });
      const object = created.objects.find((item) => item.name === '简报导出组织');
      if (!object) throw new Error('missing object');
      await api.dispatch({
        type: 'ADD_SOURCE',
        title: 'https://primary.example/about',
        body: '简报导出组织主栈是 Go。',
      });
      const withSource = await api.dispatch({ type: 'SET_VIEW', view: { kind: 'inbox' } });
      const source = withSource.sources.find(
        (item) => item.title === 'https://primary.example/about',
      );
      if (!source) throw new Error('missing source');
      await api.dispatch({ type: 'BIND_CONFIRMED', sourceId: source.id, objectIds: [object.id] });
      await api.dispatch({
        type: 'SET_SOURCE_ROLE',
        sourceId: source.id,
        objectId: object.id,
        role: '主键',
      });
      await api.dispatch({
        type: 'EXTRACT_DONE',
        sourceId: source.id,
        claims: [
          {
            id: 'cl-brief-export',
            objectId: object.id,
            predicate: '后端主栈',
            text: '简报导出组织主栈是 Go',
            status: '成立',
            unverified: false,
            sourceId: source.id,
            span: '主栈是 Go',
            validFrom: '2026-01-01',
            createdAt: '2026-01-01',
          },
        ],
      });
      await api.generateBrief(object.id);
      await api.dispatch({ type: 'SET_VIEW', view: { kind: 'object', objectId: object.id } });
      await api.dispatch({ type: 'OPEN_RIGHT_TAB', objectId: object.id, kind: '简报' });
    });

    // 0062：主键绑定来源的主张句在简报里带「主键来源」标注。
    await expect(win.getByText('主键来源').first()).toBeVisible({ timeout: 15_000 });
    // 打开简报标签会异步再生成一份简报（新历史 chip 落位、布局随之位移）——慢速 CI 上
    // 直接点按钮会追着移动的布局拦截 30s（PR #29 CI）；再生成本身偶发超默认 5s（PR #32
    // 合并首跑目击）。两处都放宽到 15s：环境余量，非掩盖失败（后续断言仍抓真错）。
    await expect(win.locator('.brief-history .chip.on')).toBeVisible({ timeout: 15_000 });

    // 剪贴板是全局系统资源：CI 会话的剪贴板锁被占时 writeText/readText 会阻塞主进程
    // （PR #28 首次 CI 挂：60s 测试超时 + 60s teardown 超时的双卡死）。测试里 stub 成
    // 捕获函数（与 brain-backup spec stub dialog 同款姿势），不依赖真剪贴板。
    await app.evaluate(({ clipboard }) => {
      const store = { text: '' };
      clipboard.writeText = async (text: string) => {
        store.text = text;
      };
      (globalThis as { __briefClipboard?: { text: string } }).__briefClipboard = store;
    });

    // 复制 Markdown：捕获的内容是脚注化的简报。
    await win.getByRole('button', { name: '复制 Markdown' }).click();
    await expect(win.getByRole('button', { name: '已复制' })).toBeVisible();
    const clipboardText = await app.evaluate(
      () => (globalThis as { __briefClipboard?: { text: string } }).__briefClipboard?.text ?? '',
    );
    expect(clipboardText).toContain('# 简报导出组织');
    expect(clipboardText).toMatch(/\[\^1\]/u);
    expect(clipboardText).toContain(
      '〔后端主栈〕简报导出组织主栈是 Go —— 来源：https://primary.example/about，片段「主栈是 Go」',
    );

    // 导出 .md：保存对话框照 brain-backup spec 的 stub 姿势注入路径。
    await app.evaluate(({ dialog }, filePath) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath });
    }, exportedPath);
    await win.getByRole('button', { name: '导出 .md' }).click();
    // 导出链 = IPC + 保存对话框 stub + 文件写盘：慢盘 CI 上偶发超默认 5s（PR #31 两连挂、
    // 同树 main 运行过）——放宽到 15s，属环境余量非掩盖失败（后续断言仍会抓真错）。
    await expect(win.getByText(/简报已导出/)).toBeVisible({ timeout: 15_000 });
    const exported = readFileSync(exportedPath, 'utf8');
    expect(exported).toContain('# 简报导出组织');
    expect(exported).toContain('（主键来源）[^1]');
    expect(exported).toContain('---');
  } finally {
    await quitApp(app);
  }
});
