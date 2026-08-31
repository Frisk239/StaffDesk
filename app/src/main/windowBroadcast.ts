import { BrowserWindow } from 'electron';

/** 向全部窗口广播账本态（'state:changed'）。ipc 与主进程启动逻辑共用，防两份实现漂移。 */
export function broadcastState(next: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('state:changed', next);
  }
}
