import { DEFAULT_LINGER_DAYS } from '@shared/lingerDays';

/** 0064：墙钟与 N 由 Brain.dispatch 在 I/O 边界注入，reducer 不读 userData。 */
export type LingerClock = { lingerDays: number; now: string };

let bound: LingerClock | null = null;

export function bindLingerClock(lingerDays: number, now: string): void {
  bound = { lingerDays, now };
}

export function lingerClock(): LingerClock {
  return bound ?? { lingerDays: DEFAULT_LINGER_DAYS, now: new Date().toISOString() };
}

export function resetLingerClock(): void {
  bound = null;
}
