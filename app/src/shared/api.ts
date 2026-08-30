import type { Action } from './actions';
import type { State } from './types';

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
  testProvider: (id: string) => Promise<State>;
  startResearch: (objectId: string, gear?: '快搜' | '深挖') => Promise<State>;
  generateBrief: (objectId: string) => Promise<State>;
  exportBrain: () => Promise<string | null>;
}
