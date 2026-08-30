// 0040：密钥不入日志、不入 UI 文案。所有出站字符串（TOAST、审计 detail、console.warn）的
// Bearer/sk- 掩码与截断统一从这里出，禁止再内联正则副本。

/** 掩码 Bearer 头与 sk- 前缀密钥；纯文本替换，不做截断，不保证短值全隐。 */
export function maskSecret(value: string): string {
  return value.replace(/Bearer\s+\S+/gi, 'Bearer ***').replace(/sk-[A-Za-z0-9_-]+/g, 'sk-***');
}

/** 掩码后截断到 maxLen。用于日志里可能带查询参数的 URL 等定长展示。 */
export function maskTruncated(value: string, maxLen: number): string {
  return maskSecret(value).slice(0, maxLen);
}

/** 取 error 的 message（无则 String）→ 掩码 → 截断，用于 TOAST/审计 detail。 */
export function safeDetail(error: unknown, maxLen = 180): string {
  const raw = error instanceof Error ? error.message : String(error);
  return maskTruncated(raw, maxLen);
}
