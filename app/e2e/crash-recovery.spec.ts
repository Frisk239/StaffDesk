import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, _electron as electron } from '@playwright/test';

// F2（审计 2026-09-02）：中断一致性与损坏库恢复引导。
// WAL + 每 dispatch 单事务是既有纪律；这里补的是「强杀主进程 → 同一 brain 重开一致」
// 与「损坏 brain.db 旁置后可原位新建」两个口子。无模型、隔离 brain，不触外网。

const appDir = join(import.meta.dirname, '..');
type ElectronApp = Awaited<ReturnType<typeof electron.launch>>;
type Window = Awaited<ReturnType<ElectronApp['firstWindow']>>;

type CrashState = {
  objects: Array<{ id: string; name: string }>;
  sources: Array<{ id: string; title: string; virtual?: boolean }>;
  claims: Array<{ id: string; status: string }>;
  memories: Array<{ id: string; kind: string; text: string }>;
  writeQueue: Array<{ id: string }>;
  seq: number;
};
type StaffdeskApiForCrash = {
  dispatch: (action: unknown) => Promise<CrashState>;
  snapshot: () => Promise<CrashState>;
};

async function skipWizardIfAny(win: Window): Promise<void> {
  const skip = win.getByRole('button', { name: '跳过向导' });
  try {
    await skip.waitFor({ state: 'visible', timeout: 8_000 });
    await skip.click();
  } catch {
    // 非首启库不弹向导
  }
}

async function quitApp(app: ElectronApp): Promise<void> {
  await app.evaluate(({ app: electronApp }) => electronApp.quit());
  await app.close();
}

function launch(brainFile: string, userDataDir: string, extraEnv: Record<string, string> = {}) {
  return electron.launch({
    // user-data-dir 指到临时目录：机器级产品设置（含日志目录）不落真实用户 profile。
    args: ['.', `--user-data-dir=${userDataDir}`],
    cwd: appDir,
    env: { ...process.env, STAFFDESK_BRAIN: brainFile, ...extraEnv },
  });
}

test('强杀主进程后重开，账本一致无半写', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'staffdesk-crash-e2e-'));
  const brainFile = join(dir, 'brain.db');

  const first = await launch(brainFile, join(dir, 'userData'));
  const win = await first.firstWindow();
  await skipWizardIfAny(win);
  const before = await win.evaluate(async () => {
    const api = (globalThis as unknown as { staffdesk: StaffdeskApiForCrash }).staffdesk;
    await api.dispatch({ type: 'ADD_WORKSPACE', name: '强杀验收区', scenario: '求职面试' });
    const created = await api.dispatch({ type: 'ADD_OBJECT', kind: '组织', name: '强杀组织' });
    const object = created.objects.find((item) => item.name === '强杀组织');
    if (!object) throw new Error('missing object');
    await api.dispatch({
      type: 'ADD_SOURCE',
      title: '强杀材料',
      body: '团队主栈是 Rust。该公司在招后端实习。',
    });
    const withSource = await api.snapshot();
    const source = withSource.sources.find((item) => item.title === '强杀材料' && !item.virtual);
    if (!source) throw new Error('missing source');
    await api.dispatch({ type: 'BIND_CONFIRMED', sourceId: source.id, objectIds: [object.id] });
    await api.dispatch({
      type: 'EXTRACT_DONE',
      sourceId: source.id,
      claims: [
        {
          id: 'cl-crash-1',
          objectId: object.id,
          predicate: '使用技术',
          text: '团队主栈是 Rust',
          status: '成立',
          unverified: true,
          sourceId: source.id,
          span: '团队主栈是 Rust',
          createdAt: '2026-09-01',
        },
        {
          id: 'cl-crash-2',
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
    await api.dispatch({ type: 'CHAT_SEND', objectId: object.id, text: '记下来：沟通走邮件' });
    const snapshot = await api.snapshot();
    return {
      objects: snapshot.objects.map((item) => item.name),
      claims: snapshot.claims.map((item) => ({ id: item.id, status: item.status })),
      sources: snapshot.sources.length,
      memories: snapshot.memories.map((item) => item.kind),
      writeQueue: snapshot.writeQueue.length,
      seq: snapshot.seq,
    };
  });
  expect(before.claims).toHaveLength(2);
  expect(before.memories).toContain('偏好');

  // 强杀：绕过 before-quit/优雅关闭——WAL 留在盘上，由下一次打开恢复（这正是被测语义）。
  first.process().kill();
  await first.close().catch(() => undefined);
  expect(existsSync(brainFile)).toBe(true);

  const second = await launch(brainFile, join(dir, 'userData'));
  const win2 = await second.firstWindow();
  await skipWizardIfAny(win2);
  const after = await win2.evaluate(async () => {
    const api = (globalThis as unknown as { staffdesk: StaffdeskApiForCrash }).staffdesk;
    return api.snapshot();
  });
  expect(after.objects.map((item) => item.name)).toEqual(before.objects);
  expect(after.claims.map((item) => ({ id: item.id, status: item.status }))).toEqual(before.claims);
  expect(after.sources.length).toBe(before.sources);
  expect(after.memories.map((item) => item.kind)).toEqual(before.memories);
  expect(after.writeQueue).toHaveLength(0);
  expect(after.seq).toBe(before.seq);
  await quitApp(second);
});

test('损坏的大脑文件被旁置，重启后在原位新建空大脑', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'staffdesk-corrupt-e2e-'));
  const brainFile = join(dir, 'brain.db');
  writeFileSync(brainFile, Buffer.from('这不是一个 SQLite 数据库。'.repeat(16)), 'utf8');
  writeFileSync(`${brainFile}-wal`, 'stale wal');
  writeFileSync(`${brainFile}-shm`, 'stale shm');

  // 启动失败路径：不建窗口、走原生错误框 + app.exit(1)。旁置与退出都是可观察的——
  // 盘上出现 .corrupt- 文件、进程以 1 退出。CI 无人会话上 showErrorBox 会阻塞主线程
  // 等人点框（PR #29 双 60s 超时的根因），e2e 里抑制原生框走日志证据链。
  const app = await launch(brainFile, join(dir, 'userData'), {
    STAFFDESK_E2E_SUPPRESS_ERROR_BOX: '1',
  });
  const proc = app.process();
  const exited = new Promise<number | null>((resolve) => {
    if (proc.exitCode !== null) resolve(proc.exitCode);
    else proc.once('exit', (code) => resolve(code));
  });
  await expect
    .poll(() => readdirSync(dir).some((name) => name.startsWith('brain.db.corrupt-')), {
      timeout: 15_000,
    })
    .toBe(true);
  expect(await exited).toBe(1);
  await app.close().catch(() => undefined);

  expect(existsSync(brainFile)).toBe(false);
  expect(existsSync(`${brainFile}-wal`)).toBe(false);
  expect(existsSync(`${brainFile}-shm`)).toBe(false);
  const quarantined = readdirSync(dir).find((name) => name.startsWith('brain.db.corrupt-'));
  expect(quarantined).toBeTruthy();

  // 同一 STAFFDESK_BRAIN 重启：原位新建空大脑，正常出窗口。
  const second = await launch(brainFile, join(dir, 'userData'));
  const win2 = await second.firstWindow();
  await skipWizardIfAny(win2);
  const fresh = await win2.evaluate(async () => {
    const api = (globalThis as unknown as { staffdesk: StaffdeskApiForCrash }).staffdesk;
    return api.snapshot();
  });
  expect(fresh.objects).toHaveLength(0);
  expect(fresh.claims).toHaveLength(0);
  await quitApp(second);
});
