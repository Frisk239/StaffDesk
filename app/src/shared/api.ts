import type { Action } from './actions';
import type { BudgetGear, State } from './types';

export interface BrainBackupInfo {
  createdAt: string;
  schemaVersion: number;
  sizeBytes: number;
  sha256: string;
}

export interface BrainBackupExportResult {
  filePath: string;
  backup: BrainBackupInfo;
}

// 审计 F4：简报导出 .md 的落点；null = 用户取消保存对话框。
export interface BriefExportResult {
  filePath: string;
}

// F3（审计 2026-09-02）：诊断日志合并导出的落点；null = 用户取消或日志未启用。
export interface LogsExportResult {
  filePath: string;
}

export interface BrainRestoreResult {
  filePath: string;
  safetyCopyPath: string;
  backup: BrainBackupInfo;
  state: State;
}

export interface StaffdeskApi {
  snapshot: () => Promise<State>;
  dispatch: (action: Action) => Promise<State>;
  onStateChanged: (cb: (state: State) => void) => () => void;
  chatSend: (objectId: string, text: string) => Promise<State>;
  ingestText: (text: string, suggestedTitle?: string) => Promise<State>;
  ingestUrl: (url: string) => Promise<State>;
  chooseAndIngestFiles: () => Promise<State>;
  ingestDroppedFiles: (files: readonly unknown[]) => Promise<State>;
  retryIngest: (jobId: string) => Promise<State>;
  runExtract: (sourceId: string) => Promise<State>;
  testProvider: (providerId: string, modelId: string) => Promise<State>;
  startResearch: (
    objectId: string,
    gear?: BudgetGear,
    options?: { kind?: '调研' | '再搜一轮'; fromTaskId?: string },
  ) => Promise<State>;
  stopTask: (taskId: string) => Promise<State>;
  createRadar: (objectId: string, intervalDays?: number) => Promise<State>;
  runRadar: (radarTaskId: string) => Promise<State>;
  generateBrief: (objectId: string) => Promise<State>;
  exportBrain: () => Promise<BrainBackupExportResult | null>;
  restoreBrain: () => Promise<BrainRestoreResult | null>;
  exportBrief: (markdown: string, objectName?: string) => Promise<BriefExportResult | null>;
  copyBrief: (markdown: string) => Promise<void>;
  logsDir: () => Promise<string>;
  exportLogs: () => Promise<LogsExportResult | null>;
}
