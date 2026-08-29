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
  fetch?: FetchFn | undefined;
}

export interface CompleteResult {
  content: string;
  toolCalls: ToolCallDelta[];
}

const RETRY_STATUS = new Set([429, 500, 502, 503]);

export function maskSecret(value: string): string {
  if (!value) return '';
  if (value.length <= 6) return 'sk-***';
  return `${value.slice(0, 3)}***${value.slice(-2)}`;
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
  };
  const message = json.choices?.[0]?.message;
  return { content: message?.content ?? '', toolCalls: message?.tool_calls ?? [] };
}

async function readStream(res: Response, onDelta?: (chunk: string) => void): Promise<CompleteResult> {
  const body = res.body;
  if (!body) return { content: '', toolCalls: [] };
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let content = '';
  const toolCalls: ToolCallDelta[] = [];
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
        };
        const delta = json.choices?.[0]?.delta;
        if (delta?.content) {
          content += delta.content;
          onDelta?.(delta.content);
        }
        if (delta?.tool_calls) toolCalls.push(...delta.tool_calls);
      } catch {
        /* skip malformed sse line */
      }
    }
  }
  return { content, toolCalls };
}
