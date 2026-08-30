import { chatComplete, type FetchFn } from './chatCompletions';
// 自检 detail 是错误消息（可能内嵌密钥），直接用 redact 的正则掩码口径，不经 chatCompletions 的短值守卫转口。
import { safeDetail } from '../redact';

export type CheckLevel = 'connect' | 'capability';

export interface CheckResult {
  level: CheckLevel;
  ok: boolean;
  detail: string;
}

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

/** 一级连通：密钥非空 + GET /models（通常不计费）。 */
export async function checkConnect(args: {
  baseUrl: string;
  apiKey: string;
  fetch?: FetchFn;
  timeoutMs?: number;
}): Promise<CheckResult> {
  if (!args.apiKey.trim()) {
    return { level: 'connect', ok: false, detail: '密钥为空' };
  }
  const fetchFn = args.fetch ?? fetch;
  try {
    const res = await fetchFn(joinUrl(args.baseUrl, 'models'), {
      method: 'GET',
      headers: { Authorization: `Bearer ${args.apiKey}` },
      signal: AbortSignal.timeout(args.timeoutMs ?? 15_000),
    });
    if (res.ok || res.status === 404) {
      return { level: 'connect', ok: true, detail: `端点可达（HTTP ${res.status}）` };
    }
    if (res.status === 401 || res.status === 403) {
      return { level: 'connect', ok: false, detail: '密钥被拒绝' };
    }
    return { level: 'connect', ok: false, detail: `HTTP ${res.status}` };
  } catch (err) {
    return { level: 'connect', ok: false, detail: `连不上：${safeDetail(err, 120)}` };
  }
}

/** 二级能力探测：微型 JSON 结构化请求。 */
export async function checkCapability(args: {
  baseUrl: string;
  apiKey: string;
  model: string;
  fetch?: FetchFn;
  timeoutMs?: number;
}): Promise<CheckResult> {
  try {
    const result = await chatComplete({
      baseUrl: args.baseUrl,
      apiKey: args.apiKey,
      model: args.model,
      jsonMode: true,
      maxRetries: 2,
      timeoutMs: args.timeoutMs ?? 60_000,
      fetch: args.fetch,
      messages: [
        { role: 'system', content: '只输出 JSON。' },
        { role: 'user', content: '返回 {"ping":true} ，不要其它文字。' },
      ],
    });
    const parsed = JSON.parse(result.content) as { ping?: unknown };
    if (parsed.ping === true) {
      return { level: 'capability', ok: true, detail: '结构化输出可用' };
    }
    return { level: 'capability', ok: false, detail: 'JSON 不含 ping:true' };
  } catch (err) {
    return { level: 'capability', ok: false, detail: safeDetail(err, 160) };
  }
}
