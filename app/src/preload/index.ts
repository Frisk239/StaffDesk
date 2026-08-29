import { contextBridge, ipcRenderer } from 'electron';
import type { StaffdeskApi } from '@shared/api';
import type { State } from '@shared/types';

const api: StaffdeskApi = {
  snapshot: () => ipcRenderer.invoke('brain:snapshot') as Promise<State>,
  dispatch: (action) => ipcRenderer.invoke('brain:dispatch', action) as Promise<State>,
  chatSend: (objectId, text) => ipcRenderer.invoke('chat:send', { objectId, text }) as Promise<State>,
  runExtract: (sourceId) => ipcRenderer.invoke('extract:run', sourceId) as Promise<State>,
  testProvider: (id) => ipcRenderer.invoke('settings:testProvider', id) as Promise<State>,
  startResearch: (objectId, gear) =>
    ipcRenderer.invoke('task:startResearch', { objectId, gear }) as Promise<State>,
  generateBrief: (objectId) => ipcRenderer.invoke('brief:generate', objectId) as Promise<State>,
  exportBrain: () => ipcRenderer.invoke('brain:export') as Promise<string | null>,
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
