import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { DEFAULT_LINGER_DAYS, normalizeLingerDays } from '@shared/lingerDays';
import { logWarn } from './logging';

export {
  DEFAULT_LINGER_DAYS,
  MAX_LINGER_DAYS,
  MIN_LINGER_DAYS,
  normalizeLingerDays,
} from '@shared/lingerDays';

export interface LingerDaysStore {
  load: () => number;
  save: (days: number) => number;
}

interface LingerDaysFile {
  version: 1;
  lingerDays: number;
}

export function createJsonLingerDaysStore(filePath: string): LingerDaysStore {
  return {
    load() {
      if (!existsSync(filePath)) return DEFAULT_LINGER_DAYS;
      try {
        const parsed: unknown = JSON.parse(readFileSync(filePath, 'utf8'));
        return normalizeLingerDays(isRecord(parsed) ? parsed.lingerDays : undefined);
      } catch (error) {
        logWarn(
          'linger-days',
          `配置损坏回落默认：${error instanceof Error ? error.message : String(error)}`,
        );
        return DEFAULT_LINGER_DAYS;
      }
    },
    save(days) {
      const lingerDays = normalizeLingerDays(days);
      mkdirSync(dirname(filePath), { recursive: true });
      const payload: LingerDaysFile = { version: 1, lingerDays };
      const temporaryPath = `${filePath}.tmp`;
      writeFileSync(temporaryPath, `${JSON.stringify(payload, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      });
      renameSync(temporaryPath, filePath);
      return lingerDays;
    },
  };
}

export function createMemoryLingerDaysStore(initial?: number): LingerDaysStore {
  let current = normalizeLingerDays(initial ?? DEFAULT_LINGER_DAYS);
  return {
    load: () => current,
    save(days) {
      current = normalizeLingerDays(days);
      return current;
    },
  };
}

let activeStore: LingerDaysStore = createMemoryLingerDaysStore();

export function setActiveLingerDaysStore(store: LingerDaysStore): void {
  activeStore = store;
}

export function resetLingerDaysStore(): void {
  activeStore = createMemoryLingerDaysStore();
}

export function readLingerDays(): number {
  return activeStore.load();
}

export function writeLingerDays(days: number): number {
  return activeStore.save(days);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
