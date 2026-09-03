/** 0064：滞留天数是产品偏好，不是账本事实。默认 7；0 禁止（否则刚抽出就能丢弃）。 */
export const DEFAULT_LINGER_DAYS = 7;
export const MIN_LINGER_DAYS = 1;
export const MAX_LINGER_DAYS = 90;

export function normalizeLingerDays(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_LINGER_DAYS;
  const n = Math.round(value);
  if (n < MIN_LINGER_DAYS) return DEFAULT_LINGER_DAYS;
  if (n > MAX_LINGER_DAYS) return MAX_LINGER_DAYS;
  return n;
}
