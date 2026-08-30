import { describe, expect, it } from 'vitest';
import { checkCapability, checkConnect } from '../../src/main/llm/selfCheck';

describe('设置自检 1–2 级', () => {
  it('密钥为空则连通失败，不发请求', async () => {
    let called = 0;
    const r = await checkConnect({
      baseUrl: 'https://api.example.test/v1',
      apiKey: '  ',
      fetch: async () => {
        called += 1;
        return new Response('no', { status: 200 });
      },
    });
    expect(r.ok).toBe(false);
    expect(called).toBe(0);
  });

  it('GET /models 200 视为连通', async () => {
    const r = await checkConnect({
      baseUrl: 'https://api.example.test/v1',
      apiKey: 'sk-1',
      fetch: async (url) => {
        expect(String(url)).toMatch(/\/models$/);
        return new Response('{}', { status: 200 });
      },
    });
    expect(r.ok).toBe(true);
  });

  it('能力探测要求 JSON ping:true', async () => {
    const ok = await checkCapability({
      baseUrl: 'https://api.example.test/v1',
      apiKey: 'sk-1',
      model: 'demo',
      fetch: async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: '{"ping":true}' } }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    });
    expect(ok.ok).toBe(true);
    const bad = await checkCapability({
      baseUrl: 'https://api.example.test/v1',
      apiKey: 'sk-1',
      model: 'demo',
      fetch: async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: 'not json' } }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    });
    expect(bad.ok).toBe(false);
  });

  it('连通检查有硬超时', async () => {
    const result = await checkConnect({
      baseUrl: 'https://api.example.test/v1',
      apiKey: 'sk-1',
      timeoutMs: 10,
      fetch: async (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        }),
    });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('连不上');
  });
});
