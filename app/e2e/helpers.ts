import { expect, type Page } from '@playwright/test';

// 首启向导（0041）盖住整个 .desktop。skip() 只关本次 overlay、不写 onboardingDone。
// 旧 skipWizardIfAny 点完就返回，还把 click 失败吞掉——overlay 仍在时后续
// chrome 点击会被「跳过向导」拦截（main 68842d4：brain-backup / brief-export）。

export async function dismissOnboarding(win: Page): Promise<void> {
  const overlay = win.locator('.onboarding-overlay');
  const skip = win.getByRole('button', { name: '跳过向导' });
  try {
    await skip.waitFor({ state: 'visible', timeout: 15_000 });
  } catch {
    await expect(overlay).toHaveCount(0);
    return;
  }
  await skip.click({ force: true });
  await expect(overlay).toHaveCount(0, { timeout: 15_000 });
}
