import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IpcMainInvokeEvent } from 'electron';
import type { Action } from '../../src/shared/actions';
import type { State } from '../../src/shared/types';
import type { ModelCompletion } from '../../src/main/llm/runtime';
import { openBrain, type Brain } from '../../src/main/brain';
import { registerIpc, researchOptionsFor, unregisterIpc } from '../../src/main/ipc';
import { initLogging, resetLogging } from '../../src/main/logging';

type IpcHandler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;

// electron 造假：handle 把通道存进 Map，测试直接从 Map 取入口调用；removeHandler 记账。
const registry = vi.hoisted(() => ({
  handlers: new Map<string, IpcHandler>(),
  removed: [] as string[],
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: IpcHandler) => {
      registry.handlers.set(channel, fn);
    },
    removeHandler: (channel: string) => {
      registry.removed.push(channel);
      registry.handlers.delete(channel);
    },
  },
  BrowserWindow: {
    getAllWindows: () => [],
  },
  dialog: {
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
    showSaveDialog: async () => ({ canceled: true, filePath: undefined }),
  },
}));

// 模型出口造假：只有需要的用例注入 complete，其余用例保持未配置（不触模型、不出网）。
const llm = vi.hoisted(() => ({ completion: null as ModelCompletion | null }));

vi.mock('../../src/main/llm/runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/llm/runtime')>();
  const activeModelCompletion = (_state: State): ModelCompletion | undefined => {
    const injected = llm.completion;
    if (!injected) return undefined;
    return (request) => injected(request);
  };
  return { ...actual, activeModelCompletion };
});

const dirs: string[] = [];
const brains: Brain[] = [];

function tmpBrainPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'staffdesk-ipc-test-'));
  dirs.push(dir);
  return join(dir, 'brain.db');
}

function fakeEvent(): IpcMainInvokeEvent {
  return { sender: { id: 1 } } as unknown as IpcMainInvokeEvent;
}

async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  const handler = registry.handlers.get(channel);
  if (!handler) throw new Error(`通道未注册：${channel}`);
  return (await handler(fakeEvent(), ...args)) as T;
}

function setupBrain(): Brain {
  const brain = openBrain(tmpBrainPath());
  brains.push(brain);
  brain.dispatch({ type: 'ADD_WORKSPACE', name: '区甲', scenario: '求职面试' });
  brain.dispatch({ type: 'ADD_OBJECT', kind: '组织', name: '甲组织' });
  registerIpc(brain, { assertTrustedSender: () => undefined });
  return brain;
}

afterEach(() => {
  unregisterIpc();
  llm.completion = null;
  while (brains.length) {
    try {
      brains.pop()?.close();
    } catch {
      /* already closed */
    }
  }
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* lock */
    }
  }
});

describe('主进程 IPC 契约', () => {
  beforeEach(() => {
    registry.removed.length = 0;
  });

  it('brain:snapshot 返回带视图与任务清单的账本态', async () => {
    const brain = setupBrain();
    const state = await invoke<State>('brain:snapshot');
    expect(state.objects.map((item) => item.name)).toContain('甲组织');
    expect(state.view).toBeTruthy();
    expect(state.tasks).toEqual([]);
    expect(state).toEqual(brain.snapshot());
  });

  it('brain:dispatch 走 TOAST 往返，快照可见', async () => {
    setupBrain();
    const action: Action = { type: 'TOAST', text: '提示已入账' };
    const next = await invoke<State>('brain:dispatch', action);
    expect(next.toast?.text).toBe('提示已入账');
    const after = await invoke<State>('brain:snapshot');
    expect(after.toast?.text).toBe('提示已入账');
  });

  it('ingest:text 粘贴文本纯主进程建来源，作业记完成', async () => {
    setupBrain();
    const next = await invoke<State>('ingest:text', {
      text: '该公司在招后端实习。团队主栈是 Go。',
      suggestedTitle: 'JD 片段',
    });
    const source = next.sources.find((item) => item.origin?.kind === 'text');
    expect(source?.body).toContain('后端实习');
    expect(source?.title).toBe('JD 片段');
    expect(next.ingestJobs.at(-1)).toMatchObject({ status: '完成' });
  });

  it('logs:dir 返回初始化的日志目录；logs:export 未选路径时返回 null（F3）', async () => {
    setupBrain();
    const logsDir = mkdtempSync(join(tmpdir(), 'sd-ipc-logs-'));
    dirs.push(dirname(logsDir));
    initLogging(logsDir);
    try {
      await expect(invoke<unknown>('logs:dir')).resolves.toBe(logsDir);
      // dialog mock 默认取消：导出静默返回 null，不炸不写盘。
      await expect(invoke<unknown>('logs:export')).resolves.toBeNull();
    } finally {
      resetLogging();
    }
  });

  it('chat:send 写意图走脚本路径，不触模型', async () => {
    const brain = setupBrain();
    const obj = brain.snapshot().objects[0]!;
    let completionCalls = 0;
    llm.completion = async () => {
      completionCalls += 1;
      throw new Error('写意图不该走到模型');
    };
    const state = await invoke<State>('chat:send', {
      objectId: obj.id,
      text: '记下来：简报要简洁',
    });
    expect(completionCalls).toBe(0);
    expect(state.memories.some((memory) => memory.text === '简报要简洁')).toBe(true);
    const messages = state.chatByObject[obj.id] ?? [];
    expect(messages.some((message) => message.text === '记下来：简报要简洁')).toBe(true);
    expect(messages.some((message) => message.role === 'desk')).toBe(true);
  });

  it('chat:send 起草场景意图：草稿进 takeover 队列；未配置 toast 引导设置', async () => {
    const brain = setupBrain();
    const obj = brain.snapshot().objects[0]!;

    // 未配置模型：不伪造草稿，落 toast，用户消息不悬挂。
    const unconfigured = await invoke<State>('chat:send', {
      objectId: obj.id,
      text: '起草场景「供应商尽调」，盯履约风险',
    });
    expect(unconfigured.toast?.text).toBe('起草场景需要先在设置里配置模型');
    expect(
      (unconfigured.chatByObject[obj.id] ?? []).some((m) => m.text.includes('供应商尽调')),
    ).toBe(true);

    llm.completion = async () => ({
      content: JSON.stringify({
        name: '供应商尽调',
        hint: '盯一个供应商',
        playbook: '出站纪律：只根据账本里已有主张回答，每句能指回主张。',
        blocks: [
          { title: '关键事实', kind: 'background', predicates: [] },
          { title: '风险与冲突', kind: 'slots', predicates: ['风险信号'] },
        ],
      }),
      toolCalls: [],
    });
    const state = await invoke<State>('chat:send', {
      objectId: obj.id,
      text: '起草场景「供应商尽调」，盯履约风险',
    });
    const row = state.writeQueue.find((w) => w.kind === '场景');
    expect(row?.template?.name).toBe('供应商尽调');
    expect(row?.template?.builtin).toBe(false);
    expect(row?.evidence).toBe('起草场景，盯履约风险');
    const messages = state.chatByObject[obj.id] ?? [];
    expect(messages.some((m) => m.role === 'desk' && m.text.includes('草稿已备好'))).toBe(true);
  });

  it('注册与卸载共用同一份通道清单，卸载后不留挂着的 handle', async () => {
    setupBrain();
    const registered = [...registry.handlers.keys()];
    expect(registered).toContain('chat:send');
    expect(registered).toContain('task:startResearch');
    unregisterIpc();
    expect(registry.handlers.size).toBe(0);
    expect(registry.removed.sort()).toEqual([...registered].sort());
  });

  it('chat:send 模型失败：invoke 正常返回，用户消息不悬挂，TOAST 脱敏告知', async () => {
    const brain = setupBrain();
    const obj = brain.snapshot().objects[0]!;
    llm.completion = async () => {
      throw new Error('上游模型错误 HTTP 502 Authorization: Bearer sk-abc123supersecret');
    };
    const state = await invoke<State>('chat:send', { objectId: obj.id, text: '办公地点在哪？' });
    expect(state.toast?.text.startsWith('本轮回复失败：')).toBe(true);
    expect(state.toast?.text).not.toContain('sk-abc123supersecret');
    expect(state.toast?.text).not.toContain('Bearer sk-');
    const messages = state.chatByObject[obj.id] ?? [];
    expect(messages.some((message) => message.role === 'user')).toBe(true);
    expect(messages.some((message) => message.role === 'desk')).toBe(false);
  });
});

describe('researchOptionsFor 纯函数', () => {
  it('缺省 kind 或普通调研返回空选项，即普通调研', () => {
    const state = { tasks: [] } as unknown as State;
    expect(researchOptionsFor(state, { objectId: 'obj-1' })).toEqual({});
    expect(researchOptionsFor(state, { objectId: 'obj-1', kind: '调研' })).toEqual({});
  });

  it('再搜一轮：父任务在账本里时带 parentTaskId 与 query，不带雷达语义', () => {
    const parent = {
      id: 'task-parent',
      objectId: 'obj-1',
      kind: '再搜一轮' as const,
      status: '已完成' as const,
      createdAt: '2026-08-29 10:00',
      query: '甲组织 官方 介绍',
    };
    const state = { tasks: [parent] } as unknown as State;
    const options = researchOptionsFor(state, {
      objectId: 'obj-1',
      kind: '再搜一轮',
      fromTaskId: 'task-parent',
    });
    expect(options).toEqual({
      kind: '再搜一轮',
      parentTaskId: 'task-parent',
      query: '甲组织 官方 介绍',
    });
    expect(options).not.toHaveProperty('dueAt');
    expect(options).not.toHaveProperty('missedRuns');
    expect(options).not.toHaveProperty('late');
  });

  it('fromTaskId 找不到目标任务时回落普通调研', () => {
    const state = { tasks: [] } as unknown as State;
    expect(
      researchOptionsFor(state, { objectId: 'obj-1', kind: '再搜一轮', fromTaskId: 'no-such' }),
    ).toEqual({});
    expect(researchOptionsFor(state, { objectId: 'obj-1', kind: '再搜一轮' })).toEqual({});
  });
});
