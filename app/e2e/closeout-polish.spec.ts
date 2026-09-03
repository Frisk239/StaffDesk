import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, _electron as electron } from '@playwright/test';
import { dismissOnboarding } from './helpers';
import { closeServer, installStubModel, serveStubModel } from './stub-model';

// M27 收口体验验收：任务列表打磨（筛选 / 进行中置顶 / 雷达下次 / 失败重跑入口）、
// 未认证徽章（未配置不显示、点击直达设置模型节）、向导检查步默认跑。
// 全程零网络：调研与资格检查的真实 IPC handler 在主进程侧换成只记录的桩。

const appDir = join(import.meta.dirname, '..');
type ElectronApp = Awaited<ReturnType<typeof electron.launch>>;
type Window = Awaited<ReturnType<ElectronApp['firstWindow']>>;

type CloseoutState = {
  objects: Array<{ id: string; name: string }>;
};

type StaffdeskApiForCloseout = {
  dispatch: (action: unknown) => Promise<CloseoutState>;
};

async function quitApp(app: ElectronApp): Promise<void> {
  await app.evaluate(({ app: electronApp }) => electronApp.quit());
  await app.close();
}

async function launchApp(
  label: string,
  options: { skipWizard?: boolean } = {},
): Promise<{ app: ElectronApp; win: Window }> {
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
  if (options.skipWizard !== false) await dismissOnboarding(win);
  return { app, win };
}

// contextBridge 暴露对象在渲染侧只读，spy 只能装在主进程：摘掉真实 handler 换记录桩。
async function stubIpc(app: ElectronApp, channel: string, sink: string): Promise<void> {
  await app.evaluate(
    ({ ipcMain }, args: { channel: string; sink: string }) => {
      const g = globalThis as unknown as Record<string, unknown[]>;
      g[args.sink] = [];
      ipcMain.removeHandler(args.channel);
      ipcMain.handle(args.channel, (_event: unknown, payload: unknown) => {
        g[args.sink]!.push(payload);
        return null;
      });
    },
    { channel, sink },
  );
}

test('任务列表：筛选生效、进行中置顶、雷达显示下次、失败行可再搜一轮', async () => {
  const { app, win } = await launchApp('closeout-tasks');
  try {
    const objectId = await win.evaluate(async () => {
      const api = (globalThis as unknown as { staffdesk: StaffdeskApiForCloseout }).staffdesk;
      await api.dispatch({ type: 'ADD_WORKSPACE', name: '收口验收区', scenario: '求职面试' });
      const created = await api.dispatch({
        type: 'ADD_OBJECT',
        kind: '组织',
        name: '收口组织',
      });
      const object = created.objects.find((item) => item.name === '收口组织');
      if (!object) throw new Error('missing object');

      const apply = (task: Record<string, unknown>) =>
        api.dispatch({ type: 'APPLY_RESEARCH', task, audits: [], sources: [] });
      // 进行中的任务故意给较早的 createdAt：置顶与否一目了然。
      await api.dispatch({
        type: 'TASK_RUN_STARTED',
        task: {
          id: 't-running',
          objectId: object.id,
          kind: '调研',
          status: '进行中',
          createdAt: '2026-09-01 08:00',
          budgetGear: '快搜',
          query: '正在跑的这一轮',
        },
      });
      await apply({
        id: 't-done',
        objectId: object.id,
        kind: '调研',
        status: '已完成',
        createdAt: '2026-09-01 09:00',
        budgetGear: '快搜',
        query: '顺利收尾的一轮',
      });
      await apply({
        id: 't-failed',
        objectId: object.id,
        kind: '再搜一轮',
        status: '已完成',
        stopReason: '失败',
        createdAt: '2026-08-30 10:00',
        budgetGear: '深挖',
        query: '上轮失败的查询',
      });
      await apply({
        id: 't-stopped',
        objectId: object.id,
        kind: '调研',
        status: '已停止',
        stopReason: '手动',
        createdAt: '2026-08-29 10:00',
        budgetGear: '快搜',
        query: '被手动停下的一轮',
      });
      await apply({
        id: 't-radar',
        objectId: object.id,
        kind: '周期性雷达',
        status: '待启动',
        createdAt: '2026-08-28 10:00',
        intervalDays: 1,
        nextDueAt: '2026-08-30 09:00',
        query: '收口组织 官方',
      });
      await api.dispatch({ type: 'SET_VIEW', view: { kind: 'tasks' } });
      return object.id;
    });

    await expect(win.getByRole('heading', { name: '任务' })).toBeVisible();
    const rows = win.locator('.all-object-row');
    await expect(rows).toHaveCount(5);

    // 进行中置顶：createdAt 更早的进行中排在最前，其后按时间倒序。
    await expect(rows.nth(0)).toContainText('进行中');
    await expect(rows.nth(0)).toContainText('正在跑的这一轮');
    await expect(rows.nth(1)).toContainText('2026-09-01 09:00');
    await expect(rows.nth(4)).toContainText('2026-08-28 10:00');

    // 雷达行显示下次到点，到期如实标注。
    const radarRow = rows.filter({ hasText: '周期性雷达' });
    await expect(radarRow).toContainText('已到期 · 08-30 09:00');

    // 失败（已完成·失败）与已停止的调研行有「再搜一轮」入口；完成顺利的一轮没有。
    await expect(rows.filter({ hasText: '上轮失败的查询' })).toContainText('再搜一轮');
    await expect(rows.filter({ hasText: '被手动停下的一轮' })).toContainText('再搜一轮');
    await expect(rows.filter({ hasText: '顺利收尾的一轮' })).not.toContainText('再搜一轮');

    // 种类筛选：只剩三条调研（进行中 + 顺利完成 + 手动停止），再搜一轮与雷达被滤掉。
    const kindGroup = win.getByRole('group', { name: '按种类筛选' });
    await kindGroup.getByRole('button', { name: '调研' }).click();
    await expect(rows).toHaveCount(3);
    await expect(rows.filter({ hasText: '上轮失败的查询' })).toHaveCount(0);
    await expect(rows.filter({ hasText: '收口组织 官方' })).toHaveCount(0);

    // 状态筛选叠加：只剩手动停止那条。
    const statusGroup = win.getByRole('group', { name: '按状态筛选' });
    await statusGroup.getByRole('button', { name: '已停止' }).click();
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText('已停止 · 手动');

    // 组合出空集有空态文案；雷达 + 全部状态能单独看雷达行。
    await kindGroup.getByRole('button', { name: '周期性雷达' }).click();
    await expect(win.getByText('没有符合筛选的任务')).toBeVisible();
    await statusGroup.getByRole('button', { name: '全部' }).click();
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText('已到期 · 08-30 09:00');

    // 点击「再搜一轮」绝不触真实调研链路：主进程已换成记录桩。
    await stubIpc(app, 'task:startResearch', '__researchCalls');
    await kindGroup.getByRole('button', { name: '再搜一轮' }).click();
    await expect(rows).toHaveCount(1);
    await rows.first().getByRole('button', { name: '再搜一轮' }).click();
    await expect
      .poll(async () =>
        app.evaluate(
          () => (globalThis as unknown as { __researchCalls?: unknown[] }).__researchCalls ?? [],
        ),
      )
      .toEqual([
        {
          objectId,
          gear: '深挖',
          kind: '再搜一轮',
          fromTaskId: 't-failed',
        },
      ]);
  } finally {
    await quitApp(app);
  }
});

test('说起草场景：确认卡四件套预览，创建后模板进设置列表', async () => {
  // M27 AI 提议起草链路：模型调用走本地桩（loopback，零外网）——
  // 起草循环的 system 提示带「场景模板起草器」标记，桩据此给出场景草稿。
  const stub = await serveStubModel([], {
    name: '供应商尽调',
    hint: '盯一个供应商：履约、账期、风险',
    playbook: '出站纪律：只根据账本里已有主张回答，每句能指回主张。',
    blocks: [
      { title: '关键事实', kind: 'background' },
      { title: '风险与冲突', kind: 'slots', predicates: ['风险信号'] },
      { title: '材料缺口', kind: 'gaps' },
    ],
  });
  const { app, win } = await launchApp('closeout-scenario-draft');
  try {
    await installStubModel(win, stub.baseUrl);
    await win.evaluate(async () => {
      const api = (globalThis as unknown as { staffdesk: StaffdeskApiForCloseout }).staffdesk;
      await api.dispatch({ type: 'ADD_WORKSPACE', name: '起草验收区', scenario: '求职面试' });
      const created = await api.dispatch({ type: 'ADD_OBJECT', kind: '组织', name: '起草对象' });
      const object = created.objects.find((item) => item.name === '起草对象');
      if (!object) throw new Error('missing object');
      await api.dispatch({ type: 'SET_VIEW', view: { kind: 'object', objectId: object.id } });
    });

    const composer = win.locator('.composer textarea');
    await composer.fill('起草场景「供应商尽调」，盯履约风险');
    await composer.press('Enter');

    // 确认卡：标题 + 四件套预览 + 0025 提示行 + 专用按钮文案。
    const card = win.locator('.takeover-card');
    await expect(card).toBeVisible();
    await expect(card).toContainText('起草场景模板「供应商尽调」');
    await expect(card).toContainText('盯一个供应商：履约、账期、风险');
    await expect(card).toContainText('风险与冲突：风险信号');
    await expect(card).toContainText('简报块只引用现有字段，新字段请先在谓词表添加');
    await expect(card.getByRole('button', { name: '创建场景模板' })).toBeVisible();

    await card.getByRole('button', { name: '创建场景模板' }).click();
    await expect(win.locator('.chat-pane')).toContainText('已创建场景模板「供应商尽调」');

    // 模板在设置的场景模板列表里可见。
    await win.locator('button[title="设置"]').click();
    const settings = win.getByRole('dialog', { name: '设置' });
    await settings.getByRole('button', { name: '场景模板' }).click();
    await expect(settings.locator('.tpl-list')).toContainText('供应商尽调');
  } finally {
    await quitApp(app);
    await closeServer(stub.server);
  }
});

test('未认证徽章：未配置不显示，配置后常驻并直达设置模型节', async () => {
  const { app, win } = await launchApp('closeout-badge');
  try {
    await win.evaluate(async () => {
      const api = (globalThis as unknown as { staffdesk: StaffdeskApiForCloseout }).staffdesk;
      await api.dispatch({ type: 'ADD_WORKSPACE', name: '徽章验收区', scenario: '求职面试' });
      const created = await api.dispatch({
        type: 'ADD_OBJECT',
        kind: '组织',
        name: '徽章组织',
      });
      const object = created.objects.find((item) => item.name === '徽章组织');
      if (!object) throw new Error('missing object');
      await api.dispatch({ type: 'SET_VIEW', view: { kind: 'object', objectId: object.id } });
    });

    // 未配置不提示：设置与向导已在引导，不喧宾夺主。
    await expect(win.locator('.cert-badge')).toHaveCount(0);

    await win.evaluate(async () => {
      const api = (globalThis as unknown as { staffdesk: StaffdeskApiForCloseout }).staffdesk;
      await api.dispatch({
        type: 'UPSERT_PROVIDER',
        provider: {
          id: 'p-e2e-closeout',
          name: '收口本机端点',
          baseUrl: 'https://models.example.test/v1/',
          apiKey: 'e2e-secret',
          enabled: true,
          models: [
            { id: 'e2e-model-a', name: 'e2e-model-a', contextWindow: 128000, maxOutput: 8192 },
          ],
        },
      });
      await api.dispatch({
        type: 'SET_ACTIVE_MODEL',
        providerId: 'p-e2e-closeout',
        modelId: 'e2e-model-a',
      });
    });

    // 未认证配置的徽章持续可见，点击直达设置的「模型」节。
    const badge = win.getByRole('button', { name: '未认证' });
    await expect(badge).toBeVisible();
    await badge.click();
    const settings = win.getByRole('dialog', { name: '设置' });
    await expect(settings).toBeVisible();
    await expect(settings.getByRole('heading', { name: '模型设置' })).toBeVisible();
    await expect(settings.getByLabel('当前模型资格认证')).toBeVisible();
  } finally {
    await quitApp(app);
  }
});

test('向导检查步默认跑一次资格检查，稍后检查仍可跳过', async () => {
  // 默认跑会真实访问端点——先在主进程把 settings:testProvider 换成记录桩，保证零网络。
  const { app, win } = await launchApp('closeout-autorun', { skipWizard: false });
  try {
    await stubIpc(app, 'settings:testProvider', '__testProviderCalls');

    // 步 0：默认工作区名已预填，直接创建。
    await win.getByRole('button', { name: '创建工作区' }).click();
    // 步 1：填一套本机端点配置并保存（只进 safeStorage 与产品配置，不出网）。
    await win.getByPlaceholder('https://你的模型端点/v1').fill('https://models.example.test/v1');
    await win.getByPlaceholder('输入 API Key').fill('e2e-secret');
    await win.getByPlaceholder('模型 ID').fill('e2e-model-a');
    await win.getByRole('button', { name: '保存并继续' }).click();

    // 步 2：无需点「开始检查」，默认跑已触发一次。
    await expect
      .poll(async () =>
        app.evaluate(
          () =>
            (globalThis as unknown as { __testProviderCalls?: unknown[] }).__testProviderCalls ??
            [],
        ),
      )
      .toEqual([{ providerId: expect.any(String), modelId: 'e2e-model-a' }]);
    await expect(win.getByRole('button', { name: '稍后检查' })).toBeVisible();
    await win.getByRole('button', { name: '稍后检查' }).click();
    await expect(win.getByRole('heading', { name: '建立第一个关注对象' })).toBeVisible();
  } finally {
    await quitApp(app);
  }
});
