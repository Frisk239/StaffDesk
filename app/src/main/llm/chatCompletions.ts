import type { TokenUsage } from '@shared/taskFee';
import { maskSecret as maskSecretText } from '../redact';

export type { TokenUsage };
export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ChatMessageParam {
  role: ChatRole;
  content: string;
  tool_call_id?: string;
  tool_calls?: ToolCallDelta[];
}

export interface ToolCallDelta {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ToolDef {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export type FetchFn = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface CompleteRequest {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: ChatMessageParam[];
  jsonMode?: boolean | undefined;
  tools?: ToolDef[] | undefined;
  stream?: boolean | undefined;
  onDelta?: ((chunk: string) => void) | undefined;
  maxRetries?: number | undefined;
  timeoutMs?: number | undefined;
  fetch?: FetchFn | undefined;
}

export interface CompleteResult {
  content: string;
  toolCalls: ToolCallDelta[];
  usage?: TokenUsage | undefined;
}

/** ADR 0059：字段缺失或非正数视为未回传，不得把整次调用静默当 0 token。 */
export function parseChatUsage(raw: unknown): TokenUsage | undefined {
  if (raw === null || typeof raw !== 'object') return undefined;
  const row = raw as { prompt_tokens?: unknown; completion_tokens?: unknown };
  const promptTokens = positiveTokenCount(row.prompt_tokens);
  const completionTokens = positiveTokenCount(row.completion_tokens);
  if (promptTokens === undefined && completionTokens === undefined) return undefined;
  return {
    promptTokens: promptTokens ?? 0,
    completionTokens: completionTokens ?? 0,
  };
}

function positiveTokenCount(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined;
  return Math.floor(value);
}

function withUsage(
  content: string,
  toolCalls: ToolCallDelta[],
  usage?: TokenUsage,
): CompleteResult {
  return usage ? { content, toolCalls, usage } : { content, toolCalls };
}

const RETRY_STATUS = new Set([429, 500, 502, 503]);

// 本模块可能被喂整条密钥值（短值必须全隐，不留首尾片段）；长文本走 redact 的统一正则掩码。
export function maskSecret(value: string): string {
  if (!value) return '';
  if (value.length <= 6) return 'sk-***';
  return maskSecretText(value);
}

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

export async function chatComplete(req: CompleteRequest): Promise<CompleteResult> {
  const fetchFn = req.fetch ?? fetch;
  const maxRetries = req.maxRetries ?? 3;
  let lastErr: Error | undefined;
  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    try {
      return await once(fetchFn, req);
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      if (lastErr.name === 'TimeoutError' || lastErr.name === 'AbortError') {
        throw new Error('chat-completions 请求超时');
      }
      const retryable =
        lastErr.message.startsWith('retry:') || lastErr.message.includes('fetch failed');
      if (!retryable || attempt === maxRetries) throw lastErr;
      await sleep(200 * attempt);
    }
  }
  throw lastErr ?? new Error('chat-completions 失败');
}

async function once(fetchFn: FetchFn, req: CompleteRequest): Promise<CompleteResult> {
  const url = joinUrl(req.baseUrl, 'chat/completions');
  const body: Record<string, unknown> = {
    model: req.model,
    messages: req.messages,
    stream: Boolean(req.stream && req.onDelta),
  };
  if (req.jsonMode) body.response_format = { type: 'json_object' };
  if (req.tools && req.tools.length > 0) body.tools = req.tools;

  const res = await fetchFn(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${req.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(req.timeoutMs ?? 60_000),
  });

  if (RETRY_STATUS.has(res.status)) {
    throw new Error(`retry: HTTP ${res.status}`);
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`chat-completions HTTP ${res.status}: ${maskSecret(text).slice(0, 240)}`);
  }

  if (body.stream) {
    return readStream(res, req.onDelta);
  }
  const json = (await res.json()) as {
    choices?: { message?: { content?: string; tool_calls?: ToolCallDelta[] } }[];
    usage?: unknown;
  };
  const message = json.choices?.[0]?.message;
  return withUsage(message?.content ?? '', message?.tool_calls ?? [], parseChatUsage(json.usage));
}

async function readStream(
  res: Response,
  onDelta?: (chunk: string) => void,
): Promise<CompleteResult> {
  const body = res.body;
  if (!body) return { content: '', toolCalls: [] };
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let content = '';
  const toolCalls: ToolCallDelta[] = [];
  let usage: TokenUsage | undefined;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const parts = buf.split('\n');
    buf = parts.pop() ?? '';
    for (const line of parts) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const data = trimmed.slice(5).trim();
      if (data === '[DONE]') continue;
      try {
        const json = JSON.parse(data) as {
          choices?: { delta?: { content?: string; tool_calls?: ToolCallDelta[] } }[];
          usage?: unknown;
        };
        const delta = json.choices?.[0]?.delta;
        if (delta?.content) {
          content += delta.content;
          onDelta?.(delta.content);
        }
        if (delta?.tool_calls) toolCalls.push(...delta.tool_calls);
        const chunkUsage = parseChatUsage(json.usage);
        if (chunkUsage) usage = chunkUsage;
      } catch {
        /* skip malformed sse line */
      }
    }
  }
  return withUsage(content, toolCalls, usage);
}
