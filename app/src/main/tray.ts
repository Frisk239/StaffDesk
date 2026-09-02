import {
  BrowserWindow,
  Menu,
  Tray,
  app,
  nativeImage,
  type MenuItemConstructorOptions,
} from 'electron';
import { safeDetail } from './redact';
import { logWarn } from './logging';

let tray: Tray | null = null;
let quitting = false;
let hinted = false;
let getWindowRef: (() => BrowserWindow | null) | null = null;

const PNG_16 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAADUlEQVQYV2NgGAWjYBQAAQEAAAH+gP8AAAAASUVORK5CYII=',
  'base64',
);

export function isQuitting(): boolean {
  return quitting;
}

/** 任何 quit 路径（托盘菜单、app.quit()、系统退出）都要先过这里，否则 close 拦截会让进程永不退出。 */
export function markQuitting(): void {
  quitting = true;
}

export interface TrayRadarStatus {
  /** 下次到期的展示文案（与窗口内雷达 tag 同格式）；null 表示没有任何雷达计划。 */
  nextDueText: string | null;
  /** 「立即补跑下一班」入口：由 index.ts 组装到同一套雷达 run 编排。 */
  runNow: () => void;
}

// Electron 菜单不可变：雷达状态变化必须整模板重建再 setContextMenu——tray.test 不存在，
// Electron 菜单造不出有意义的单测，菜单行为靠 e2e/手测兜底。
function buildMenu(radar: TrayRadarStatus | null): Menu {
  const radarItems: MenuItemConstructorOptions[] = radar?.nextDueText
    ? [
        { label: `下次 ${radar.nextDueText}`, enabled: false },
        { label: '立即补跑下一班', click: () => radar.runNow() },
      ]
    : [{ label: '没有雷达计划', enabled: false }];
  return Menu.buildFromTemplate([
    {
      label: '打开 StaffDesk',
      click: () => {
        getWindowRef?.()?.show();
      },
    },
    { type: 'separator' },
    ...radarItems,
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        quitting = true;
        app.quit();
      },
    },
  ]);
}

export function installTray(getWindow: () => BrowserWindow | null, onFirstHide: () => void): void {
  if (tray) return;
  getWindowRef = getWindow;
  const icon = nativeImage.createFromBuffer(PNG_16);
  // 无任务栏环境（CI runner、精简桌面）创建 Tray 会抛——托盘是增强不是前提，
  // 失败时降级为普通关窗行为，绝不让应用起不来。
  try {
    tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
  } catch (error) {
    getWindowRef = null;
    // F3（审计 2026-09-02）：降级原因落持久日志（脱敏），不再只进 console。
    logWarn('tray', `tray unavailable, running without tray: ${safeDetail(error, 200)}`);
    return;
  }
  tray.setToolTip('StaffDesk');
  tray.on('click', () => {
    const win = getWindow();
    if (!win) return;
    win.show();
    win.focus();
  });
  tray.setContextMenu(buildMenu(null));

  const win = getWindow();
  win?.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    win.hide();
    if (!hinted) {
      hinted = true;
      onFirstHide();
    }
  });
}

/** 雷达状态变化后的菜单重建入口（0038：常驻期间托盘可见下次到期与手动补跑）。 */
export function refreshTrayMenu(status: TrayRadarStatus): void {
  if (!tray) return;
  tray.setContextMenu(buildMenu(status));
}

export function destroyTray(): void {
  tray?.destroy();
  tray = null;
  getWindowRef = null;
}
