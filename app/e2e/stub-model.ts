import type { Page } from '@playwright/test';
import { createServer, type Server } from 'node:http';

/**
 * e2e 专用的自足桩模型：本地 http 服务实现 OpenAI 兼容的 chat/completions，
 * 返回固定 claims 草稿。e2e 不依赖开发机 userData 里的真实模型配置——
 * 干净机器（CI runner）上抽取链路照样真实走完。
 */
export interface StubClaimDraft {
  objectName: string;
  predicate: string;
  text: string;
  span: string;
}

/** M27：场景模板起草循环的桩应答（结构对齐 loops/scenarioDraft 的 zod schema）。 */
export interface StubScenarioDraft {
  name: string;
  hint: string;
  playbook: string;
  blocks: Array<{ title: string; kind: string; predicates?: string[] }>;
}

export type StubUsage = { prompt_tokens: number; completion_tokens: number } | false;

export async function serveStubModel(
  claims: StubClaimDraft[],
  scenario?: StubScenarioDraft,
  usage: StubUsage = { prompt_tokens: 12, completion_tokens: 4 },
): Promise<{
  server: Server;
  baseUrl: string;
}> {
  const server = createServer((req, res) => {
    if (req.method === 'POST' && req.url?.endsWith('/chat/completions')) {
      // 起草循环的 system 提示带「场景模板起草器」标记：给出场景草稿，否则按抽取桩应答。
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        const content =
          scenario && body.includes('场景模板起草器')
            ? JSON.stringify(scenario)
            : JSON.stringify({ claims });
        const payload: Record<string, unknown> = {
          id: 'stub-completion',
          choices: [{ message: { role: 'assistant', content } }],
        };
        if (usage) payload.usage = usage;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      });
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('stub model listen failed');
  return { server, baseUrl: `http://127.0.0.1:${address.port}/v1` };
}

/** 在应用内配置并激活指向桩端点的供应商（产品级设置，随隔离的 user-data-dir 落盘）。 */
export async function installStubModel(win: Page, baseUrl: string): Promise<void> {
  await win.evaluate(async (url) => {
    const api = (
      globalThis as unknown as {
        staffdesk: { dispatch: (action: unknown) => Promise<unknown> };
      }
    ).staffdesk;
    await api.dispatch({
      type: 'UPSERT_PROVIDER',
      provider: {
        id: 'e2e-stub',
        name: 'E2E 桩模型',
        baseUrl: url,
        apiKey: 'sk-e2e-stub',
        enabled: true,
        models: [{ id: 'stub-1', name: 'stub-1', contextWindow: 8192, maxOutput: 2048 }],
      },
    });
    await api.dispatch({ type: 'SET_ACTIVE_PROVIDER', id: 'e2e-stub' });
    await api.dispatch({ type: 'SET_ACTIVE_MODEL', providerId: 'e2e-stub', modelId: 'stub-1' });
  }, baseUrl);
}

export function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}
