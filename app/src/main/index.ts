import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { app, BrowserWindow, powerMonitor, safeStorage } from 'electron';
import type { BrainRestoreResult } from '@shared/api';
import type { DeskTask } from '@shared/types';
import { openBrain, type Brain } from './brain';
import { registerIpc, unregisterIpc } from './ipc';
import { createSafeStorageSecrets } from './keychain';
import {
  assertTrustedIpcSender,
  createRuntimeSecurityPolicy,
  installRuntimeSecurity,
  trustedRendererDevServerUrl,
} from './runtimeSecurity';
import { destroyTray, installTray, isQuitting, markQuitting, refreshTrayMenu } from './tray';
import { dueRadars, latestDueRadar, planRadarRun } from './tasks/radar';
import { createRadarWatchdog, type RadarWatchdog } from './tasks/radarWatchdog';
import { applyResearchRun } from './tasks/applyResearchRun';
import { safeDetail } from './redact';
import { broadcastState } from './windowBroadcast';
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
let radarWatchdog: RadarWatchdog | null = null;
let onPowerResume: (() => void) | null = null;

/** 单条雷达的执行编排：启动一次性补跑、常驻心跳、托盘「立即补跑」共用同一 run（0038）。
 *  失败在 run 内收 TOAST 不外抛——watchdog 的 interval 不产生未处理 rejection。 */
function runDueRadar(target: DeskTask): Promise<unknown> {
  const plan = planRadarRun(target);
  return applyResearchRun({
    getBrain: () => brain,
    publish: broadcastState,
    objectId: target.objectId,
    gear: target.budgetGear ?? '快搜',
    options: plan.options,
    // 有意的语义收紧：补跑也纳入单飞锁——与用户手动调研撞同一对象时让位，不双开任务。
    onBusy: () => {
      const skipped = brain?.dispatch({
        type: 'TOAST',
        text: '雷达补跑跳过：该对象已有调研在跑',
      });
      if (skipped) broadcastState(skipped);
    },
  }).catch((error) => {
    // 泄密口收口：补跑失败文案走统一脱敏。
    const next = brain?.dispatch({
      type: 'TOAST',
      text: `雷达补跑失败：${safeDetail(error, 120)}`,
    });
    if (next) broadcastState(next);
  });
}

/** 最近的未停止雷达（按 nextDueAt 字典序，stamp 是 'YYYY-MM-DD HH:mm' 格式，字典序即时间序）。 */
function earliestScheduledRadar(tasks: DeskTask[]): DeskTask | undefined {
  return [...tasks]
    .filter((task) => task.kind === '周期性雷达' && task.status !== '已停止' && task.nextDueAt)
    .sort((a, b) => String(a.nextDueAt).localeCompare(String(b.nextDueAt)))[0];
}

/** 托盘雷达区刷新：下次到期文案与窗口内 tag 同格式；手动入口优先跑最早到期，
 *  无到期则提前跑最近一班（planRadarRun 对未到期 late=false，不记迟跑）。 */
function refreshRadarTray(): void {
  const next = earliestScheduledRadar(brain?.snapshot().tasks ?? []);
  refreshTrayMenu({
    nextDueText: next?.nextDueAt ? next.nextDueAt.slice(5) : null,
    runNow: () => {
      const tasks = brain?.snapshot().tasks ?? [];
      const target = dueRadars(tasks)[0] ?? earliestScheduledRadar(tasks);
      if (!target) return;
      void runDueRadar(target);
    },
  });
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
        `恢复失败，且无法自动回滚；恢复前安全副本仍在 ${safetyCopyPath}。原因：${safeDetail(
          error,
          160,
        )}；回滚失败：${safeDetail(rollbackError, 160)}`,
      );
    }
    throw error;
  }
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

  // 启动一次性补跑：latestDueRadar 只取最新一条（迟跑语义见 planRadarRun）；
  // 之后常驻心跳接管，按 due 全量——两条路径语义不同，不合并。
  const due = latestDueRadar(brain.snapshot().tasks);
  if (due) void runDueRadar(due);
  refreshRadarTray();

  // 0038 常驻雷达心跳：托盘驻留期间每分钟看一眼到期队列，多对象各自到期都跑。
  radarWatchdog = createRadarWatchdog({
    getBrain: () => brain,
    publish: broadcastState,
    run: runDueRadar,
    onTick: refreshRadarTray,
  });
  // 睡眠唤醒漏掉的周期不必等下一个整分钟 tick——resume 立刻补跑一次（0038）。
  onPowerResume = () => void radarWatchdog?.tick();
  powerMonitor.on('resume', onPowerResume);

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

app.on('window-all-closed', () => {
  if (isQuitting() && process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  markQuitting();
  radarWatchdog?.stop();
  radarWatchdog = null;
  if (onPowerResume) powerMonitor.removeListener('resume', onPowerResume);
  onPowerResume = null;
  unregisterIpc();
  destroyTray();
  brain?.close();
  brain = null;
});
