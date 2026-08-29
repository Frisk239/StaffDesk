import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { createReachAdapter, type SpawnFn } from '../../src/main/adapters/reach';

function fakeSpawn(stdout: string, code = 0): SpawnFn {
  return ((_cmd, _args) => {
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

  it('search 能解析 JSON 命中', async () => {
    const adapter = createReachAdapter(
      fakeSpawn(JSON.stringify({ results: [{ title: 'A', url: 'https://a.example', snippet: 's' }] })),
    );
    const hits = await adapter.search('验收组织');
    expect(hits[0]?.url).toBe('https://a.example');
  });
});
