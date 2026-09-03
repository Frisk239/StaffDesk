import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, _electron as electron } from '@playwright/test';
import { dismissOnboarding } from './helpers';

// F7/F3（审计 2026-09-02）：设置「记忆」节分区浏览与删除（REMOVE_MEMORY 文案按种类出），
// 「诊断」节展示日志目录并导出合并诊断日志（内容写入口已掩码）。无模型，不触外网。

const appDir = join(import.meta.dirname, '..');

type MemoryState = {
  objects: Array<{ id: string; name: string }>;
  sources: Array<{ id: string; title: string; virtual?: boolean }>;
  memories: Array<{ id: string; kind: string }>;
  writeQueue: Array<{ id: string }>;
};
type StaffdeskApiForMemory = {
  dispatch: (action: unknown) => Promise<MemoryState>;
  snapshot: () => Promise<MemoryState>;
};

test('设置-记忆节按范围分区浏览并可删除；诊断节导出合并日志', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'staffdesk-memory-settings-e2e-'));
  const exportedLogsPath = join(dir, '诊断日志导出.txt');
  const app = await electron.launch({
    args: ['.', `--user-data-dir=${join(dir, 'userData')}`],
    cwd: appDir,
    env: { ...process.env, STAFFDESK_BRAIN: join(dir, 'brain.db') },
  });

  try {
    const win = await app.firstWindow();
    await dismissOnboarding(win);

    // 种子：全局偏好 + 全局习惯（「简报」触发习惯分类）+ 纠正产生的全局禁写（带 0054 三元组）。
    await win.evaluate(async () => {
      const api = (globalThis as unknown as { staffdesk: StaffdeskApiForMemory }).staffdesk;
      await api.dispatch({ type: 'ADD_WORKSPACE', name: '记忆验收区', scenario: '求职面试' });
      const created = await api.dispatch({
        type: 'ADD_OBJECT',
        kind: '组织',
        name: '记忆验收组织',
      });
      const object = created.objects.find((item) => item.name === '记忆验收组织');
      if (!object) throw new Error('missing object');
      await api.dispatch({ type: 'CHAT_SEND', objectId: object.id, text: '记下来：沟通走邮件' });
      await api.dispatch({ type: 'CHAT_SEND', objectId: object.id, text: '记下来：简报要短' });
      await api.dispatch({
        type: 'ADD_SOURCE',
        title: '记忆材料',
        body: '该公司在招后端实习。',
      });
      const seeded = await api.snapshot();
      const source = seeded.sources.find((item) => item.title === '记忆材料' && !item.virtual);
      if (!source) throw new Error('missing source');
      await api.dispatch({ type: 'BIND_CONFIRMED', sourceId: source.id, objectIds: [object.id] });
      await api.dispatch({
        type: 'EXTRACT_DONE',
        sourceId: source.id,
        claims: [
          {
            id: 'cl-mem-e2e',
            objectId: object.id,
            predicate: '在招岗位',
            text: '该公司在招后端实习',
            status: '成立',
            unverified: true,
            sourceId: source.id,
            span: '该公司在招后端实习',
            createdAt: '2026-09-01',
          },
        ],
      });
      await api.dispatch({ type: 'PROMOTE_CLAIM', claimId: 'cl-mem-e2e' });
      await api.dispatch({ type: 'OPEN_CORRECT_CARD', claimId: 'cl-mem-e2e' });
      const queued = await api.snapshot();
      const write = queued.writeQueue[0];
      if (!write) throw new Error('missing correct write');
      await api.dispatch({
        type: 'CONFIRM_WRITE',
        writeId: write.id,
        closeReason: '从未成立',
        newText: '已停止招聘。',
      });
    });

    await win.locator('button[title="设置"]').click();
    await win.getByRole('button', { name: '记忆', exact: true }).click();

    // 全局记忆分区：偏好/习惯/禁写三类各一行，禁写行展示结构化匹配三元组（0054）。
    await expect(win.getByText('全局记忆')).toBeVisible();
    await expect(
      win.locator('.memory-row', { hasText: '沟通走邮件' }).getByText('偏好'),
    ).toBeVisible();
    await expect(
      win.locator('.memory-row', { hasText: '简报要短' }).getByText('习惯'),
    ).toBeVisible();
    await expect(
      win.locator('.memory-row', { hasText: '出站不得再写' }).getByText('禁写', { exact: true }),
    ).toBeVisible();
    await expect(win.getByText(/禁写匹配：记忆验收组织 · 在招岗位/)).toBeVisible();

    // 删除偏好：文案按种类出（F7），不再硬编码「禁写」。
    await win
      .locator('.memory-row', { hasText: '沟通走邮件' })
      .getByRole('button', { name: '移除' })
      .click();
    await expect(win.getByText('已移除这条偏好')).toBeVisible();
    await expect(win.locator('.memory-row', { hasText: '沟通走邮件' })).toHaveCount(0);
    await expect(win.locator('.memory-row', { hasText: '简报要短' })).toHaveCount(1);

    // 诊断节：日志目录可见，导出走保存对话框（stub 注入路径，同简报导出姿势）。
    await win.getByRole('button', { name: '诊断', exact: true }).click();
    await expect(win.locator('.dim.mono').filter({ hasText: /logs/ })).toBeVisible();
    await app.evaluate(({ dialog }, filePath: string) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath });
    }, exportedLogsPath);
    await win.getByRole('button', { name: '导出诊断日志' }).click();
    await expect(win.getByText(/已导出诊断日志/)).toBeVisible();
    const exported = readFileSync(exportedLogsPath, 'utf8');
    expect(exported).toContain('===== main-');
    expect(exported).toContain('诊断日志导出');
    // 0040：诊断日志不含密钥形态的原文。
    expect(exported).not.toMatch(/sk-[A-Za-z0-9_-]{8,}/);
  } finally {
    await app.evaluate(({ app: electronApp }) => electronApp.quit());
    await app.close();
  }
});
