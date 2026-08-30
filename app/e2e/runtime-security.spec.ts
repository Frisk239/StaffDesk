import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, _electron as electron } from '@playwright/test';

const appDir = join(import.meta.dirname, '..');
type ElectronApp = Awaited<ReturnType<typeof electron.launch>>;
type Window = Awaited<ReturnType<ElectronApp['firstWindow']>>;
type OpenExternal = (url: string) => Promise<void>;
type ExternalRecorderGlobal = typeof globalThis & {
  __staffdeskOpenedExternal?: string[];
  __staffdeskOriginalOpenExternal?: OpenExternal;
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

async function installExternalOpenRecorder(app: ElectronApp): Promise<void> {
  await app.evaluate(({ shell }) => {
    const mainGlobal = globalThis as ExternalRecorderGlobal;
    mainGlobal.__staffdeskOpenedExternal = [];
    mainGlobal.__staffdeskOriginalOpenExternal = shell.openExternal;
    shell.openExternal = async (url: string) => {
      mainGlobal.__staffdeskOpenedExternal?.push(url);
    };
  });
}

async function openedExternal(app: ElectronApp): Promise<string[]> {
  return app.evaluate(() => {
    const mainGlobal = globalThis as ExternalRecorderGlobal;
    return [...(mainGlobal.__staffdeskOpenedExternal ?? [])];
  });
}

async function restoreExternalOpen(app: ElectronApp): Promise<void> {
  await app.evaluate(({ shell }) => {
    const mainGlobal = globalThis as ExternalRecorderGlobal;
    if (mainGlobal.__staffdeskOriginalOpenExternal) {
      shell.openExternal = mainGlobal.__staffdeskOriginalOpenExternal;
    }
  });
}

test('运行时边界阻止 renderer 离开应用壳层', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'staffdesk-runtime-security-e2e-'));
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
    await installExternalOpenRecorder(app);
    await skipWizardIfAny(win);
    await expect(win.getByTitle('继续设置')).toBeVisible();

    const initialUrl = win.url();
    const surface = await win.evaluate(async () => {
      const page = globalThis as unknown as {
        require?: unknown;
        staffdesk?: { snapshot?: () => Promise<unknown> };
      };
      const snapshot = await page.staffdesk?.snapshot?.();
      return {
        hasStaffdeskApi: typeof page.staffdesk?.snapshot === 'function',
        hasNodeRequire: typeof page.require === 'function',
        canReadState: Boolean(snapshot),
      };
    });
    expect(surface).toEqual({
      hasStaffdeskApi: true,
      hasNodeRequire: false,
      canReadState: true,
    });

    await win.evaluate(() => {
      const page = globalThis as unknown as { location: { href: string } };
      page.location.href = 'https://example.com/staffdesk-escape';
    });
    await win.waitForTimeout(300);
    expect(win.url()).toBe(initialUrl);
    await expect.poll(() => openedExternal(app)).toEqual(['https://example.com/staffdesk-escape']);

    await win.evaluate(() => {
      const page = globalThis as unknown as { open: (url: string) => unknown };
      page.open('file:///C:/Windows/win.ini');
      page.open('javascript:alert(1)');
      page.open('data:text/html,<h1>escape</h1>');
      page.open('https://example.com/staffdesk-safe-link');
    });
    await expect
      .poll(() => openedExternal(app))
      .toEqual(['https://example.com/staffdesk-escape', 'https://example.com/staffdesk-safe-link']);
    expect(app.windows()).toHaveLength(1);
    expect(win.url()).toBe(initialUrl);
  } finally {
    await restoreExternalOpen(app);
    await quitApp(app);
  }
});
