import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { app, BrowserWindow, safeStorage } from 'electron';
import { openBrain, type Brain } from './brain';
import { registerIpc, unregisterIpc } from './ipc';
import { createSafeStorageSecrets } from './keychain';
import {
  assertTrustedIpcSender,
  createRuntimeSecurityPolicy,
  installRuntimeSecurity,
  trustedRendererDevServerUrl,
} from './runtimeSecurity';
import { destroyTray, installTray, isQuitting, markQuitting } from './tray';
import { latestDueRadar, planRadarRun } from './tasks/radar';
import { createReachAdapter } from './adapters/reach';
import { createExtractionJobExecutor } from './extraction';
import { defaultQuery, runResearchTask } from './tasks/engine';
import { createJsonModelSettingsStore } from './llm/settings';
import { createJsonQualificationStore } from './eval/qualificationStore';

let mainWindow: BrowserWindow | null = null;
let brain: Brain | null = null;

function broadcastState(next: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('state:changed', next);
  }
}

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

function rendererFilePath(): string {
  return join(__dirname, '../renderer/index.html');
}

type RuntimeSecurityPolicy = ReturnType<typeof createRuntimeSecurityPolicy>;

function createWindow(securityPolicy: RuntimeSecurityPolicy): void {
  const e2eWidth = Number(process.env.STAFFDESK_E2E_WINDOW_WIDTH);
  const win = new BrowserWindow({
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
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });
  mainWindow = win;

  win.on('ready-to-show', () => {
    win.show();
  });

  installRuntimeSecurity(win, securityPolicy);

  const devServerUrl = trustedRendererDevServerUrl(process.env.ELECTRON_RENDERER_URL);
  if (devServerUrl) {
    void win.loadURL(devServerUrl);
  } else {
    void win.loadFile(securityPolicy.rendererFilePath);
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
  const qualificationStore = createJsonQualificationStore(
    join(app.getPath('userData'), 'quality-qualification.json'),
  );
  brain = openBrain(path, secrets, modelSettings, qualificationStore);
  console.log('brain file created', existsSync(path));
  const securityPolicy = createRuntimeSecurityPolicy({
    rendererFilePath: rendererFilePath(),
    devServerUrl: process.env.ELECTRON_RENDERER_URL,
  });
  registerIpc(brain, {
    assertTrustedSender: (event) => assertTrustedIpcSender(event, mainWindow, securityPolicy),
  });
  createWindow(securityPolicy);
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
    const executeExtractionJob = createExtractionJobExecutor({ brain, publish: broadcastState });
    void runDueRadarCatchup(due, executeExtractionJob).catch((error) => {
      const detail = error instanceof Error ? error.message : String(error);
      const next = brain?.dispatch({
        type: 'TOAST',
        text: `雷达补跑失败：${detail.slice(0, 120)}`,
      });
      if (next) broadcastState(next);
    });
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      const securityPolicy = createRuntimeSecurityPolicy({
        rendererFilePath: rendererFilePath(),
        devServerUrl: process.env.ELECTRON_RENDERER_URL,
      });
      createWindow(securityPolicy);
    } else mainWindow?.show();
  });
});

async function runDueRadarCatchup(
  due: NonNullable<ReturnType<typeof latestDueRadar>>,
  executeExtractionJob: (sourceId: string) => Promise<ReturnType<Brain['snapshot']>>,
): Promise<void> {
  if (!brain) return;
  const plan = planRadarRun(due);
  const result = await runResearchTask(
    brain.snapshot(),
    due.objectId,
    due.budgetGear ?? '快搜',
    {
      reach: createReachAdapter(),
      queryFor: defaultQuery,
    },
    plan.options,
  );
  let next = brain.dispatch({
    type: 'APPLY_RESEARCH',
    task: result.task,
    audits: result.audits,
    sources: result.sources,
  });
  for (const src of result.sources) {
    if (src.boundObjectIds.length === 0) continue;
    next = brain.dispatch({
      type: 'BIND_CONFIRMED',
      sourceId: src.id,
      objectIds: src.boundObjectIds,
    });
    next = await executeExtractionJob(src.id);
  }
  broadcastState(next);
  console.log('radar catchup latest only', due.id);
}

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
