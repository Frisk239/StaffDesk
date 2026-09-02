import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  createReachAdapter,
  type FetchFn,
  type ReachAdapter,
  type SpawnFn,
} from '../../src/main/adapters/reach';

function fakeSpawn(
  stdout: string,
  code = 0,
  seen?: { command?: string; args?: string[]; options?: unknown },
): SpawnFn {
  return ((cmd, args, options) => {
    if (seen) {
      seen.command = String(cmd);
      seen.args = args ? [...args] : [];
      seen.options = options;
    }
    const child = new EventEmitter() as unknown as ReturnType<SpawnFn>;
    (child as unknown as { stdout: EventEmitter }).stdout = new EventEmitter();
    (child as unknown as { stderr: EventEmitter }).stderr = new EventEmitter();
    (child as unknown as { kill: () => boolean }).kill = () => true;
    queueMicrotask(() => {
      (child as unknown as { stdout: EventEmitter }).stdout.emit('data', Buffer.from(stdout));
      child.emit('close', code);
    });
    return child;
  }) as SpawnFn;
}

function fakeResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

/** 约定：GitHub 路是 paths 里的第二路（Exa 第一路）。 */
function githubPathOf(adapter: ReachAdapter) {
  return adapter.paths.find((p) => p.name === 'GitHub');
}

function exaPathOf(adapter: ReachAdapter) {
  return adapter.paths.find((p) => p.name === 'Exa');
}

describe('检索适配层', () => {
  it('体检聚合逐路红绿：Exa 红不挡 GitHub 绿，detail 列出各路状态', async () => {
    const adapter = createReachAdapter(fakeSpawn('', 1));
    const r = await adapter.doctor();
    expect(r.ok).toBe(true);
    expect(r.paths.find((p) => p.name === 'Exa')?.ok).toBe(false);
    expect(r.paths.find((p) => p.name === 'GitHub')?.ok).toBe(true);
    expect(r.detail).toContain('Exa 不可用');
    expect(r.detail).toContain('GitHub 可用');
    // 有绿路就不给安装引导；引导挂在红路自己的体检结论上。
    expect(r.hint).toBeUndefined();
    expect(r.paths.find((p) => p.name === 'Exa')?.hint).toMatch(/Agent Reach/);
  });

  it('spawn 不使用 shell:true', async () => {
    const seen: { options?: { shell?: boolean } } = {};
    const adapter = createReachAdapter(fakeSpawn('', 1, seen));
    await adapter.doctor();
    expect(seen.options?.shell).not.toBe(true);
  });

  it('Exa 路解析 mcporter JSON 命中且参数逐字对齐', async () => {
    const seen: { command?: string; args?: string[] } = {};
    const adapter = createReachAdapter(
      fakeSpawn(
        JSON.stringify({ results: [{ title: 'A', url: 'https://a.example', snippet: 's' }] }),
        0,
        seen,
      ),
    );
    const hits = (await exaPathOf(adapter)?.search('验收组织')) ?? [];
    expect(hits[0]?.url).toBe('https://a.example');
    expect(seen.command).toBe('mcporter');
    expect(seen.args).toEqual(['call', 'exa.web_search_exa', '验收组织']);
  });

  it('Exa 路不可用时抛错，不吞成成功空结果', async () => {
    const adapter = createReachAdapter(fakeSpawn('boom', 1));
    await expect(exaPathOf(adapter)?.search('验收组织')).rejects.toThrow(/boom|检索适配/);
  });

  it('GitHub 路体检零配置恒绿，不触外网', async () => {
    const exploding: FetchFn = async () => {
      throw new Error('体检不该发网络请求');
    };
    const adapter = createReachAdapter(fakeSpawn('boom', 1), exploding);
    const check = await githubPathOf(adapter)?.doctorCheck();
    expect(check?.ok).toBe(true);
  });

  it('GitHub 路映射 items 到命中：full_name/html_url/description，缺 URL 的条目丢弃', async () => {
    const fetchFn: FetchFn = async () =>
      fakeResponse(200, {
        items: [
          { full_name: 'a/b', html_url: 'https://github.com/a/b', description: '仓库简介' },
          { full_name: 'no-url', html_url: '', description: '编不成命中' },
          { full_name: 'no-desc', html_url: 'https://github.com/c/d' },
        ],
      });
    const adapter = createReachAdapter(fakeSpawn('boom', 1), fetchFn);
    const hits = (await githubPathOf(adapter)?.search('验收组织')) ?? [];
    expect(hits).toEqual([
      { title: 'a/b', url: 'https://github.com/a/b', snippet: '仓库简介' },
      { title: 'no-desc', url: 'https://github.com/c/d', snippet: '' },
    ]);
  });

  it('GitHub 路 403 限速抛带原因的错误，不编造命中', async () => {
    const fetchFn: FetchFn = async () => fakeResponse(403, {});
    const adapter = createReachAdapter(fakeSpawn('boom', 1), fetchFn);
    await expect(githubPathOf(adapter)?.search('验收组织')).rejects.toThrow(
      /GitHub 匿名额度用尽（HTTP 403）/,
    );
  });

  it('GitHub 路非 200 与网络错误都抛带原因的错误', async () => {
    const serverError: FetchFn = async () => fakeResponse(500, {});
    const adapter = createReachAdapter(fakeSpawn('boom', 1), serverError);
    await expect(githubPathOf(adapter)?.search('验收组织')).rejects.toThrow(
      /GitHub 搜索失败（HTTP 500）/,
    );
    const networkError: FetchFn = async () => {
      throw new Error('fetch failed');
    };
    const offline = createReachAdapter(fakeSpawn('boom', 1), networkError);
    await expect(githubPathOf(offline)?.search('验收组织')).rejects.toThrow(/fetch failed/);
  });

  it('open 的 Jina reader 是真实打开路径', async () => {
    const fetchFn: FetchFn = (async () =>
      ({
        ok: true,
        status: 200,
        text: async () => '真实正文',
      }) as Response) as FetchFn;
    const adapter = createReachAdapter(fakeSpawn('不应调用 cli', 1), fetchFn);
    const opened = await adapter.open('https://example.com/doc');
    expect(opened.ok).toBe(true);
    expect(opened.body).toBe('真实正文');
  });

  // 审计 D1：注入永不主动 settle、但如实响应 abort 信号的 fetchFn——与真实 fetch 一致，
  // AbortSignal.timeout 到点才中断。没有限时实现时这两个用例会挂到测试超时红，这就是断言点。
  // 毫秒数注入只为测试提速，产品口径 25s/20s。
  function hangingFetch(): FetchFn {
    return ((_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const err = new Error('The operation was aborted due to timeout');
          err.name = 'TimeoutError';
          reject(err);
        });
      })) as FetchFn;
  }

  it('审计 D1：GitHub 搜索挂死时限时抛超时错误，不永久悬挂', async () => {
    const adapter = createReachAdapter(fakeSpawn('boom', 1), hangingFetch(), {
      githubSearchMs: 1_500,
    });
    await expect(githubPathOf(adapter)?.search('验收组织')).rejects.toThrow(/GitHub 搜索超时/u);
  });

  it('审计 D1：open 挂死时限时折失败结果（与 HTTP 失败同形状），不永久悬挂', async () => {
    const adapter = createReachAdapter(fakeSpawn('boom', 1), hangingFetch(), { jinaOpenMs: 1_500 });
    const opened = await adapter.open('https://example.com/hang');
    expect(opened.ok).toBe(false);
    expect(opened.error).toMatch(/打开超时/u);
  });
});
