import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { createReachAdapter, type FetchFn, type SpawnFn } from '../../src/main/adapters/reach';

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

describe('检索适配层', () => {
  it('doctor 失败时给出安装引导，不抛', async () => {
    const adapter = createReachAdapter(fakeSpawn('', 1));
    const r = await adapter.doctor();
    expect(r.ok).toBe(false);
    expect(r.hint).toMatch(/Agent Reach/);
  });

  it('spawn 不使用 shell:true', async () => {
    const seen: { options?: { shell?: boolean } } = {};
    const adapter = createReachAdapter(fakeSpawn('', 1, seen));
    await adapter.doctor();
    expect(seen.options?.shell).not.toBe(true);
  });

  it('search 能解析 JSON 命中', async () => {
    const seen: { command?: string; args?: string[] } = {};
    const adapter = createReachAdapter(
      fakeSpawn(
        JSON.stringify({ results: [{ title: 'A', url: 'https://a.example', snippet: 's' }] }),
        0,
        seen,
      ),
    );
    const hits = await adapter.search('验收组织');
    expect(hits[0]?.url).toBe('https://a.example');
    expect(seen.command).toBe('mcporter');
    expect(seen.args).toEqual(['call', 'exa.web_search_exa', '验收组织']);
  });

  it('search 不可用时抛错，不吞成成功空结果', async () => {
    const adapter = createReachAdapter(fakeSpawn('boom', 1));
    await expect(adapter.search('验收组织')).rejects.toThrow(/boom|检索适配/);
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
});
