import { BrowserWindow, Menu, Tray, app, nativeImage } from 'electron';

let tray: Tray | null = null;
let quitting = false;
let hinted = false;

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

export function installTray(getWindow: () => BrowserWindow | null, onFirstHide: () => void): void {
  if (tray) return;
  const icon = nativeImage.createFromBuffer(PNG_16);
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
  tray.setToolTip('StaffDesk');
  tray.on('click', () => {
    const win = getWindow();
    if (!win) return;
    win.show();
    win.focus();
  });
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: '打开 StaffDesk',
        click: () => {
          getWindow()?.show();
        },
      },
      { type: 'separator' },
      {
        label: '退出',
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ]),
  );

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

export function destroyTray(): void {
  tray?.destroy();
  tray = null;
}
