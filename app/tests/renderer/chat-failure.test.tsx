// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../../src/renderer/src/App';
import { installStaffdeskStub, makeState, type StaffdeskStub } from './helpers/stubStaffdesk';

// D3（M34）：chat 失败兜底行为测试。数据流与主进程一致（ipc.ts chat:send catch → TOAST）：
// 失败 TOAST 出现、用户消息不丢（CHAT_USER_ONLY 先广播）、3.2s 自动消散（App Effects）、
// busy（打字机播放中）期间发送禁用（ChatPane send 守卫与按钮 disabled）。mock 边界是
// window.staffdesk，不触外网。

const OBJECT_ID = 'obj-chat';

function chatState(partial: Partial<ReturnType<typeof makeState>> = {}) {
  return makeState({
    objects: [
      { id: OBJECT_ID, kind: '组织', name: '失败验收对象', relationIds: [], workspaceId: 'ws-1' },
    ],
    view: { kind: 'object', objectId: OBJECT_ID },
    ...partial,
  });
}

let stub: StaffdeskStub;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

async function renderApp(initial: ReturnType<typeof makeState>): Promise<void> {
  stub = installStaffdeskStub(initial);
  render(<App />);
  // flush snapshot promise：StoreProvider 从「加载中」落到真实状态。
  await act(async () => {});
}

describe('chat 失败兜底行为', () => {
  it('模型调用失败：TOAST「本轮回复失败」出现、用户消息可见、3.2 秒自动消散', async () => {
    await renderApp(chatState());
    stub.respondChat = (_objectId, text) =>
      chatState({
        // 0030：失败如实告知，用户消息先落账广播（CHAT_USER_ONLY），这句话不悬挂、不丢。
        chatByObject: {
          [OBJECT_ID]: [{ id: 'msg-u1', role: 'user', text }],
        },
        toast: { text: '本轮回复失败：fetch failed', id: 2 },
      });

    const composer = screen.getByPlaceholderText('问 失败验收对象');
    fireEvent.change(composer, { target: { value: '有什么主张' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '发送' }));
    });

    expect(stub.chatCalls).toEqual([{ objectId: OBJECT_ID, text: '有什么主张' }]);
    // 用户消息可见 + 失败 TOAST 出现（不编造回复）。
    expect(screen.getByText('有什么主张')).toBeTruthy();
    expect(screen.getByText('本轮回复失败：fetch failed')).toBeTruthy();

    // 3.2s 消散（App.tsx Effects 计时器 → TOAST null）。
    await act(async () => {
      vi.advanceTimersByTime(3200);
    });
    expect(stub.actions).toContainEqual({ type: 'TOAST', text: null });
    expect(screen.queryByText('本轮回复失败：fetch failed')).toBeNull();
    // 消散后用户消息仍在（消的只是 TOAST，不是轮次）。
    expect(screen.getByText('有什么主张')).toBeTruthy();
  });

  it('busy 解除后可再发：失败轮次不永久卡住 composer', async () => {
    await renderApp(chatState());
    let fail = true;
    stub.respondChat = (_objectId, text) => {
      if (fail) {
        return chatState({
          chatByObject: { [OBJECT_ID]: [{ id: 'msg-u1', role: 'user', text }] },
          toast: { text: '本轮回复失败：fetch failed', id: 2 },
        });
      }
      return chatState({
        chatByObject: {
          [OBJECT_ID]: [
            { id: 'msg-u1', role: 'user', text: '第一句' },
            { id: 'msg-u2', role: 'user', text },
          ],
        },
      });
    };

    const composer = screen.getByPlaceholderText('问 失败验收对象');
    fireEvent.change(composer, { target: { value: '第一句' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '发送' }));
    });
    await act(async () => {
      vi.advanceTimersByTime(3200);
    });

    // busy 已随失败解除（失败轮次无打字机动画）：composer 可再输入再发。
    fail = false;
    fireEvent.change(screen.getByPlaceholderText('问 失败验收对象'), {
      target: { value: '第二句' },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '发送' }));
    });
    expect(stub.chatCalls).toEqual([
      { objectId: OBJECT_ID, text: '第一句' },
      { objectId: OBJECT_ID, text: '第二句' },
    ]);
    expect(screen.getByText('第二句')).toBeTruthy();
  });
});

describe('chat busy 期间发送禁用', () => {
  it('打字机播放中（stream）发送按钮禁用，播完恢复；空文本始终禁发', async () => {
    await renderApp(
      chatState({
        thinkingEffort: '关闭',
        chatByObject: {
          [OBJECT_ID]: [
            {
              id: 'msg-d1',
              role: 'desk',
              text: '短回答',
              turn: {
                tools: [],
                think: { runningTitle: '', doneTitle: '', summary: '', body: '' },
                played: false,
              },
            },
          ],
        },
      }),
    );

    const send = screen.getByRole('button', { name: '发送' });
    // 空文本禁发（按钮 disabled）；且此刻打字机已起播（useEffect 同步 setStream）。
    expect(send.hasAttribute('disabled')).toBe(true);

    // 有文本但 stream 播放中：仍然禁发（发送按钮 disabled={!text || stream}）。
    fireEvent.change(screen.getByPlaceholderText('问 失败验收对象'), {
      target: { value: '追问' },
    });
    expect(send.hasAttribute('disabled')).toBe(true);

    // 播完（「短回答」3 字 × 20ms/字 + 缓冲）：stream 清空，按钮恢复。
    await act(async () => {
      vi.advanceTimersByTime(500);
    });
    expect(send.hasAttribute('disabled')).toBe(false);
  });
});
