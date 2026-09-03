import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, _electron as electron } from '@playwright/test';
import { dismissOnboarding } from './helpers';
import { closeServer, installStubModel, serveStubModel } from './stub-model';

// D3（M34）：chat 失败兜底 e2e——单测只盖了 catch 分支的形状，这里在真实 Electron 窗口走
// 完整链路：chat:send → 用户消息先落账广播（CHAT_USER_ONLY）→ 模型端点连接失败
// （installStubModel 后 closeServer 注入 ECONNREFUSED，chatCompletions 重试 3 次后抛错）
// → ipc catch → TOAST「本轮回复失败」（0030：失败如实告知，不编造回复）。
// busy 随失败解除：失败轮次无打字机动画，composer 可直接再发。隔离照旧：独立 user-data-dir
// + STAFFDESK_BRAIN 临时目录，模型端点只指本地桩（关停后是拒绝连接，零外网）。

const appDir = join(import.meta.dirname, '..');

test('chat 端点连接失败：用户消息不丢、TOAST 如实告知、busy 解除后可再发', async () => {
  const stub = await serveStubModel([]);
  const dir = mkdtempSync(join(tmpdir(), 'staffdesk-chat-failure-e2e-'));
  const app = await electron.launch({
    args: ['.', `--user-data-dir=${join(dir, 'userData')}`],
    cwd: appDir,
    env: { ...process.env, STAFFDESK_BRAIN: join(dir, 'brain.db') },
  });

  try {
    const win = await app.firstWindow();
    await dismissOnboarding(win);
    await installStubModel(win, stub.baseUrl);
    // 端点配置完成即关停：后续 chat/completions 一律连接被拒（重试 3 次后失败）。
    await closeServer(stub.server);
    await win.evaluate(async () => {
      const api = (
        globalThis as unknown as {
          staffdesk: { dispatch: (action: unknown) => Promise<unknown> };
        }
      ).staffdesk;
      await api.dispatch({ type: 'ADD_WORKSPACE', name: '失败验收区', scenario: '求职面试' });
      const created = (await api.dispatch({
        type: 'ADD_OBJECT',
        kind: '组织',
        name: '失败验收对象',
      })) as { objects: Array<{ id: string; name: string }> };
      const object = created.objects.find((item) => item.name === '失败验收对象');
      if (!object) throw new Error('missing object');
      await api.dispatch({ type: 'SET_VIEW', view: { kind: 'object', objectId: object.id } });
    });

    const composer = win.locator('.composer textarea');
    await composer.fill('第一句：有什么主张');
    await composer.press('Enter');

    // 用户消息先广播（不悬挂、不丢），失败 TOAST 随后出现（重试 3 次共约 1s，留足余量）。
    await expect(win.locator('.bubble', { hasText: '第一句：有什么主张' })).toBeVisible({
      timeout: 15_000,
    });
    await expect(win.locator('.toast', { hasText: '本轮回复失败' })).toBeVisible({
      timeout: 15_000,
    });

    // busy 解除后可再发：失败轮次没有卡住 composer，第二条照样进入轮次并留下用户消息。
    await composer.fill('第二句：再问一句');
    await composer.press('Enter');
    await expect(win.locator('.bubble', { hasText: '第二句：再问一句' })).toBeVisible({
      timeout: 15_000,
    });
    // 第二轮同样如实失败（端点仍关着），界面不出现编造的回复。
    await expect(win.locator('.toast', { hasText: '本轮回复失败' })).toBeVisible({
      timeout: 15_000,
    });
    const bubbles = win.locator('.msg.user .bubble');
    await expect(bubbles).toHaveCount(2);
  } finally {
    await app.evaluate(({ app: electronApp }) => electronApp.quit());
    await app.close();
  }
});
