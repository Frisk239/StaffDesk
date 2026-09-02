import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { app, BrowserWindow, dialog, powerMonitor, safeStorage } from 'electron';
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
import { initLogging, logError } from './logging';
import { broadcastState } from './windowBroadcast';
import { createJsonModelSettingsStore } from './llm/settings';
import { createJsonQualificationStore } from './eval/qualificationStore';
import {
  backupInfoFromManifest,
  createBrainBackupArchive,
  quarantineBrainFile,
  readBrainBackupArchive,
  replaceBrainDatabaseFile,
  writeBrainBackupFile,
} from './brainBackup';

let mainWindow: BrowserWindow | null = null;
let brain: Brain | null = null;
let radarWatchdog: RadarWatchdog | null = null;
let onPowerResume: (() => void) | null = null;

// F2/F3（审计 2026-09-02）：userData 不依赖 ready，日志目录最早可用；兜底 handler 挂在模块
// 加载期——whenReady 之前的异常也要有落点。handler 只记脱敏日志、不再抛（0040 掩码纪律）。
initLogging(join(app.getPath('userData'), 'logs'));
process.on('uncaughtException', (error) => {
  logError('uncaught', error);
});
process.on('unhandledRejection', (reason) => {
  logError('unhandledRejection', reason);
});
app.on('render-process-gone', (_event, _webContents, details) => {
  logError('render-process-gone', new Error(`renderer gone: ${details.reason}`));
});

/** F2：启动期致命错误的统一出口——原生错误框说清出路后退出进程（不做渲染层错误页）。
 *  实测 showErrorBox 非阻塞、无窗口时 showMessageBox 也立即返回，等不到用户点按；
 *  出路文案同时落日志（F3），「重启原位新建空大脑 / 备份 zip 恢复」是可自助走通的主路径。 */
function fatalStartupError(title: string, message: string): void {
  logError('startup', new Error(`${title}: ${message}`));
  dialog.showErrorBox(title, message);
  // Spec 评审（M33）：showErrorBox 在部分平台上不等用户关框——exit 前给一小段渲染窗口，
  // 否则原生框随进程销毁，用户看不到出路文案（日志与盘上旁置文件是第二道兜底）。
  const delayedExit = setTimeout(() => app.exit(1), 3_000);
  delayedExit.unref();
}

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
  // F2：启动路径任何一处抛错都不再变成无窗口的未处理 rejection——统一走错误框 + 退出。
  try {
    startup();
  } catch (error) {
    fatalStartupError('StaffDesk 无法启动', `启动失败：${safeDetail(error, 300)}`);
  }
});

function startup(): void {
  // 原生依赖在打开大脑文件之前先加载：ABI 不匹配要在最早处抛出，不拖到首次读写账本。
  try {
    require('better-sqlite3');
  } catch (error) {
    fatalStartupError('StaffDesk 无法启动', `本机原生组件加载失败：${String(error)}`);
    return;
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
  // F2（审计 2026-09-02）：损坏库不再裸抛成「双击无反应」——先旁置损坏文件（复用备份恢复的
  // rename/sidecar 纪律），错误框写明 brain 路径与两条出路，用户确认后退出；下次启动在原位
  // 新建空大脑，备份 zip 恢复入口照旧（0048：secrets 与备份目录不在此路径上被动）。
  try {
    brain = openBrain(path, secrets, modelSettings, qualificationStore);
  } catch (error) {
    const detail = safeDetail(error, 200);
    logError('startup', error);
    const quarantined = quarantineBrainFile(path);
    fatalStartupError(
      '大脑文件打不开',
      [
        `大脑文件无法打开，可能已损坏：\n${path}`,
        '',
        `原因：${detail}`,
        quarantined ? `\n损坏的文件已原样旁置为：\n${quarantined}` : '',
        '',
        '接下来可以：',
        '1. 重新打开 StaffDesk——会自动新建一个空大脑；',
        '2. 或在启动后的「设置 → 通用 → 恢复大脑备份」里，用之前导出的备份 zip 恢复。',
      ].join('\n'),
    );
    return;
  }
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
}

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
