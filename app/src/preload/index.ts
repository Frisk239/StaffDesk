import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { StaffdeskApi } from '@shared/api';
import type { State } from '@shared/types';

function pathForDroppedFile(file: unknown): string | null {
  try {
    const path = webUtils.getPathForFile(file as Parameters<typeof webUtils.getPathForFile>[0]);
    return path || null;
  } catch {
    return null;
  }
}

const api: StaffdeskApi = {
  snapshot: () => ipcRenderer.invoke('brain:snapshot') as Promise<State>,
  dispatch: (action) => ipcRenderer.invoke('brain:dispatch', action) as Promise<State>,
  chatSend: (objectId, text) =>
    ipcRenderer.invoke('chat:send', { objectId, text }) as Promise<State>,
  ingestText: (text, suggestedTitle) =>
    ipcRenderer.invoke('ingest:text', { text, suggestedTitle }) as Promise<State>,
  ingestUrl: (url) => ipcRenderer.invoke('ingest:url', { url }) as Promise<State>,
  chooseAndIngestFiles: () => ipcRenderer.invoke('ingest:chooseFiles') as Promise<State>,
  ingestDroppedFiles: (files) => {
    const filePaths = files.map(pathForDroppedFile).filter((path): path is string => Boolean(path));
    return ipcRenderer.invoke('ingest:files', { filePaths }) as Promise<State>;
  },
  retryIngest: (jobId) => ipcRenderer.invoke('ingest:retry', jobId) as Promise<State>,
  runExtract: (sourceId) => ipcRenderer.invoke('extract:run', sourceId) as Promise<State>,
  testProvider: (providerId, modelId) =>
    ipcRenderer.invoke('settings:testProvider', { providerId, modelId }) as Promise<State>,
  startResearch: (objectId, gear, options) =>
    ipcRenderer.invoke('task:startResearch', { objectId, gear, ...options }) as Promise<State>,
  stopTask: (taskId) => ipcRenderer.invoke('task:stop', { taskId }) as Promise<State>,
  createRadar: (objectId, intervalDays) =>
    ipcRenderer.invoke('task:createRadar', { objectId, intervalDays }) as Promise<State>,
  runRadar: (radarTaskId) => ipcRenderer.invoke('task:runRadar', { radarTaskId }) as Promise<State>,
  generateBrief: (objectId) => ipcRenderer.invoke('brief:generate', objectId) as Promise<State>,
  exportBrain: () => ipcRenderer.invoke('brain:export') as ReturnType<StaffdeskApi['exportBrain']>,
  restoreBrain: () =>
    ipcRenderer.invoke('brain:restore') as ReturnType<StaffdeskApi['restoreBrain']>,
  exportBrief: (markdown, objectName) =>
    ipcRenderer.invoke('brief:export', { markdown, objectName }) as ReturnType<
      StaffdeskApi['exportBrief']
    >,
  copyBrief: (markdown) =>
    ipcRenderer.invoke('brief:copy', { markdown }) as ReturnType<StaffdeskApi['copyBrief']>,
  logsDir: () => ipcRenderer.invoke('logs:dir') as Promise<string>,
  exportLogs: () => ipcRenderer.invoke('logs:export') as ReturnType<StaffdeskApi['exportLogs']>,
  getLingerDays: () => ipcRenderer.invoke('settings:getLingerDays') as Promise<number>,
  setLingerDays: (days) => ipcRenderer.invoke('settings:setLingerDays', days) as Promise<number>,
  onStateChanged: (cb) => {
    const listener = (_event: unknown, state: State) => {
      cb(state);
    };
    ipcRenderer.on('state:changed', listener);
    return () => {
      ipcRenderer.removeListener('state:changed', listener);
    };
  },
};

contextBridge.exposeInMainWorld('staffdesk', api);
