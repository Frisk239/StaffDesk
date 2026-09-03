import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { logWarn } from './logging';

/** 0064：滞留天数跟机器走，默认 7；0 禁止（否则抽取当下就能清掉刚入库的未核）。 */
export const DEFAULT_LINGER_DAYS = 7;
export const MIN_LINGER_DAYS = 1;
export const MAX_LINGER_DAYS = 90;

export interface LingerDaysStore {
  load: () => number;
  save: (days: number) => number;
}

interface LingerDaysFile {
  version: 1;
  lingerDays: number;
}

export function normalizeLingerDays(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_LINGER_DAYS;
  const n = Math.round(value);
  if (n < MIN_LINGER_DAYS) return DEFAULT_LINGER_DAYS;
  if (n > MAX_LINGER_DAYS) return MAX_LINGER_DAYS;
  return n;
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
