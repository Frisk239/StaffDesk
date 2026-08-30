import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { app, BrowserWindow, safeStorage } from 'electron';
import type { BrainRestoreResult } from '@shared/api';
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
import { createResearchTask, defaultQuery, runResearchTask } from './tasks/engine';
import { createJsonModelSettingsStore } from './llm/settings';
import { createJsonQualificationStore } from './eval/qualificationStore';
import {
  backupInfoFromManifest,
  createBrainBackupArchive,
  readBrainBackupArchive,
  replaceBrainDatabaseFile,
  writeBrainBackupFile,
} from './brainBackup';

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

function brainBackupsDir(): string {
  const dir = join(app.getPath('userData'), 'brain-backups');
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

function requireBrain(): Brain {
  if (!brain) throw new Error('大脑文件尚未打开');
  return brain;
}

async function writeBeforeRestoreBackup(current: Brain): Promise<string> {
  const archive = await createBrainBackupArchive(current);
  const stamp = archive.manifest.createdAt.replace(/[:.]/g, '-');
  const filePath = join(brainBackupsDir(), `staffdesk-before-restore-${stamp}.zip`);
  writeBrainBackupFile(filePath, archive);
  return filePath;
}

async function restoreBrainBackup(archivePath: string): Promise<BrainRestoreResult> {
  const restored = readBrainBackupArchive(readFileSync(archivePath));
  const current = requireBrain();
  const targetPath = current.filePath;
  const stores = {
    secrets: current.secrets,
    modelSettings: current.modelSettings,
    qualificationStore: current.qualificationStore,
  };
  const safetyCopyPath = await writeBeforeRestoreBackup(current);
  current.close();
  brain = null;
  try {
    replaceBrainDatabaseFile(targetPath, restored.database);
    brain = openBrain(targetPath, stores.secrets, stores.modelSettings, stores.qualificationStore);
    return {
      filePath: archivePath,
      safetyCopyPath,
      backup: backupInfoFromManifest(restored.manifest),
      state: brain.snapshot(),
    };
  } catch (error) {
    try {
      const fallback = readBrainBackupArchive(readFileSync(safetyCopyPath));
      replaceBrainDatabaseFile(targetPath, fallback.database);
      brain = openBrain(
        targetPath,
        stores.secrets,
        stores.modelSettings,
        stores.qualificationStore,
      );
      broadcastState(brain.snapshot());
    } catch (rollbackError) {
      throw new Error(
        `恢复失败，且无法自动回滚；恢复前安全副本仍在 ${safetyCopyPath}。原因：${safeErrorMessage(
          error,
        )}；回滚失败：${safeErrorMessage(rollbackError)}`,
      );
    }
    throw error;
  }
}

function safeErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/Bearer\s+\S+/gi, 'Bearer ***')
    .replace(/sk-[A-Za-z0-9_-]+/g, 'sk-***')
    .slice(0, 160);
}

app.whenReady().then(() => {
  // 原生依赖在打开大脑文件之前先加载：ABI 不匹配要在最早处抛出，不拖到首次读写账本。
  try {
    require('better-sqlite3');
  } catch (error) {
    throw new Error(`better-sqlite3 在主进程加载失败：${String(error)}`);
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
  const modelSettings = createJsonModelSettingsStore(
    join(app.getPath('userData'), 'model-settings.json'),
  );
  const qualificationStore = createJsonQualificationStore(
    join(app.getPath('userData'), 'quality-qualification.json'),
  );
  brain = openBrain(path, secrets, modelSettings, qualificationStore);
  const securityPolicy = createRuntimeSecurityPolicy({
    rendererFilePath: rendererFilePath(),
    devServerUrl: process.env.ELECTRON_RENDERER_URL,
  });
  registerIpc(
    requireBrain,
    {
      assertTrustedSender: (event) => assertTrustedIpcSender(event, mainWindow, securityPolicy),
    },
    { restoreBrainBackup },
  );
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
  const reach = createReachAdapter();
  const task = createResearchTask(
    brain.snapshot(),
    due.objectId,
    due.budgetGear ?? '快搜',
    {
      reach,
      queryFor: defaultQuery,
    },
    plan.options,
  );
  let next = brain.dispatch({ type: 'TASK_RUN_STARTED', task });
  broadcastState(next);
  const result = await runResearchTask(
    brain.snapshot(),
    due.objectId,
    due.budgetGear ?? '快搜',
    {
      reach,
      queryFor: defaultQuery,
      onAudit: (audit) => {
        if (!brain) return;
        const updated = brain.dispatch({
          type: 'TASK_AUDIT_APPENDED',
          taskId: task.id,
          audits: [audit],
        });
        broadcastState(updated);
      },
      shouldStop: () => {
        const current = brain?.snapshot().tasks.find((item) => item.id === task.id);
        return current?.status === '已停止' && current.stopReason === '手动';
      },
    },
    { ...plan.options, task },
  );
  next = brain.dispatch({
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
