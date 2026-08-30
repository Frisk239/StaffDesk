import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { app, BrowserWindow, safeStorage, shell } from 'electron';
import { openBrain, type Brain } from './brain';
import { registerIpc, unregisterIpc } from './ipc';
import { createSafeStorageSecrets } from './keychain';
import { destroyTray, installTray, isQuitting, markQuitting } from './tray';
import { lateAuditPayload, latestDueRadar } from './tasks/radar';
import { createJsonModelSettingsStore } from './llm/settings';

let mainWindow: BrowserWindow | null = null;
let brain: Brain | null = null;

function brainPath(): string {
  if (process.env.STAFFDESK_BRAIN) return process.env.STAFFDESK_BRAIN;
  if (!app.isPackaged) {
    const dir = join(app.getAppPath(), 'data');
    mkdirSync(dir, { recursive: true });
    return join(dir, 'brain.db');
  }
  return join(app.getPath('userData'), 'brain.db');
}

function secretsDir(): string {
  const dir = join(app.getPath('userData'), 'secrets');
  mkdirSync(dir, { recursive: true });
  return dir;
}

function createWindow(): void {
  const e2eWidth = Number(process.env.STAFFDESK_E2E_WINDOW_WIDTH);
  mainWindow = new BrowserWindow({
    width: Number.isFinite(e2eWidth) && e2eWidth >= 900 ? e2eWidth : 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: 'StaffDesk',
    webPreferences: {
      preload: existsSync(join(__dirname, '../preload/index.js'))
        ? join(__dirname, '../preload/index.js')
        : join(__dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show();
  });

  mainWindow.webContents.setWindowOpenHandler((details) => {
    void shell.openExternal(details.url);
    return { action: 'deny' };
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

app.whenReady().then(() => {
  try {
    const Database = require('better-sqlite3') as unknown;
    console.log('better-sqlite3 loaded in main process', typeof Database);
  } catch (err) {
    console.error('better-sqlite3 failed to load in main process', err);
    throw err;
  }

  const dir = secretsDir();
  const secrets = createSafeStorageSecrets(safeStorage, {
    read: (id) => {
      const p = join(dir, `${id}.bin`);
      return existsSync(p) ? readFileSync(p) : null;
    },
    write: (id, buf) => {
      writeFileSync(join(dir, `${id}.bin`), buf);
    },
    remove: (id) => {
      const p = join(dir, `${id}.bin`);
      if (existsSync(p)) rmSync(p);
    },
  });

  const path = brainPath();
  console.log('brain file', path, 'exists_before', existsSync(path));
  const modelSettings = createJsonModelSettingsStore(
    join(app.getPath('userData'), 'model-settings.json'),
  );
  brain = openBrain(path, secrets, modelSettings);
  console.log('brain file created', existsSync(path));
  registerIpc(brain);
  createWindow();
  installTray(
    () => mainWindow,
    () => {
      brain?.dispatch({
        type: 'TOAST',
        text: '已最小化到托盘，右键托盘图标可彻底退出',
      });
    },
  );

  const due = latestDueRadar(brain.snapshot().tasks);
  if (due) {
    const payload = lateAuditPayload(due.id);
    brain.dispatch({
      type: 'APPLY_RESEARCH',
      task: {
        id: due.id,
        objectId: due.objectId,
        kind: due.kind,
        status: '已完成',
        createdAt: due.createdAt,
      },
      audits: [
        {
          taskId: due.id,
          seq: 1,
          kind: '迟跑',
          payload,
          ts: new Date().toISOString(),
        },
      ],
      sources: [],
    });
    console.log('radar catchup latest only', due.id);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else mainWindow?.show();
  });
});

app.on('window-all-closed', () => {
  if (isQuitting() && process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  markQuitting();
  unregisterIpc();
  destroyTray();
  brain?.close();
  brain = null;
});
