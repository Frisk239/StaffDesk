import { describe, expect, it } from 'vitest';
import { chatComplete, maskSecret } from '../../src/main/llm/chatCompletions';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('chat-completions 客户端', () => {
  it('密钥在错误文本里被掩码', () => {
    // 长值不再露出首尾片段（原 'sk-***jk' 会泄漏内容轮廓）：统一走 redact 正则掩码。
    expect(maskSecret('sk-abcdefghijk')).toBe('sk-***');
    // 短值守卫保留：整条短密钥仍全隐。
    expect(maskSecret('k')).toBe('sk-***');
  });

  it('非流式成功返回 content，绝不把密钥写进结果', async () => {
    const result = await chatComplete({
      baseUrl: 'https://api.example.test/v1',
      apiKey: 'sk-secret-key',
      model: 'demo',
      messages: [{ role: 'user', content: 'hi' }],
      fetch: async (input, init) => {
        const auth = (init?.headers as Record<string, string>).Authorization;
        expect(auth).toBe('Bearer sk-secret-key');
        expect(String(input)).toContain('/chat/completions');
        return jsonResponse({
          choices: [{ message: { content: '未知，不编。 [ref:cl-1]' } }],
        });
      },
    });
    expect(result.content).toContain('未知');
    expect(result.content).not.toContain('sk-secret');
  });

  it('429 会重试，第三次成功', async () => {
    let n = 0;
    const result = await chatComplete({
      baseUrl: 'https://api.example.test/v1',
      apiKey: 'k',
      model: 'demo',
      maxRetries: 3,
      messages: [{ role: 'user', content: 'hi' }],
      fetch: async () => {
        n += 1;
        if (n < 3) return jsonResponse({ error: 'busy' }, 429);
        return jsonResponse({ choices: [{ message: { content: 'ok' } }] });
      },
    });
    expect(n).toBe(3);
    expect(result.content).toBe('ok');
  });

  it('JSON mode 请求带 response_format', async () => {
    let body = '';
    await chatComplete({
      baseUrl: 'https://api.example.test/v1',
      apiKey: 'k',
      model: 'demo',
      jsonMode: true,
      messages: [{ role: 'user', content: 'x' }],
      fetch: async (_url, init) => {
        body = String(init?.body);
        return jsonResponse({ choices: [{ message: { content: '{"ping":true}' } }] });
      },
    });
    expect(body).toContain('json_object');
  });

  it('请求超时会结束并返回可行动错误，不无限挂起', async () => {
    await expect(
      chatComplete({
        baseUrl: 'https://api.example.test/v1',
        apiKey: 'k',
        model: 'demo',
        timeoutMs: 10,
        messages: [{ role: 'user', content: 'x' }],
        fetch: async (_url, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
          }),
      }),
    ).rejects.toThrow('请求超时');
  });
});
