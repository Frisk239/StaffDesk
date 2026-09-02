// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { StoreProvider } from '../../src/renderer/src/store';
import { SettingsModal } from '../../src/renderer/src/components/Settings';
import { installStaffdeskStub, makeState } from './helpers/stubStaffdesk';

// F5/D3（M34）：设置「记忆」节行为测试——分区渲染（全局/对象/会话）、删除走 REMOVE_MEMORY、
// 禁写行展示 0054 结构化三元组。mock 边界是 window.staffdesk（IPC），不触主进程与外网。

afterEach(cleanup);

/** StoreProvider 起播要等 snapshot promise 落地（加载中 → 真实状态）；返回 dispatch 记录面。 */
async function renderSettings(state: ReturnType<typeof makeState>) {
  const stub = installStaffdeskStub(state);
  render(
    <StoreProvider>
      <SettingsModal open initialSection="记忆" onClose={() => undefined} />
    </StoreProvider>,
  );
  await act(async () => {});
  return stub;
}

function seedMemoryState() {
  return makeState({
    objects: [
      {
        id: 'obj-1',
        kind: '组织',
        name: '记忆验收组织',
        relationIds: [],
        workspaceId: 'ws-1',
      },
    ],
    memories: [
      {
        id: 'mem-pref',
        scope: '全局',
        kind: '偏好',
        text: '沟通走邮件',
        createdAt: '2026-09-01',
      },
      {
        id: 'mem-ban',
        scope: '全局',
        kind: '禁写',
        text: '出站不得再写「在招岗位：后端实习」',
        createdAt: '2026-09-01',
        bannedObjectId: 'obj-1',
        bannedPredicate: '在招岗位',
        bannedValue: '后端实习',
      },
      {
        id: 'mem-obj',
        scope: '对象',
        kind: '习惯',
        text: '简报要短',
        createdAt: '2026-09-01',
        objectId: 'obj-1',
      },
      {
        id: 'mem-sess',
        scope: '会话',
        kind: '偏好',
        text: '称呼用「您」',
        createdAt: '2026-09-01',
      },
    ],
  });
}

describe('设置-记忆节行为', () => {
  it('按范围分区渲染：全局 / 对象（带对象名）/ 会话各归各区', async () => {
    await renderSettings(seedMemoryState());

    expect(screen.getByText('全局记忆')).toBeTruthy();
    expect(screen.getByText('对象记忆 · 记忆验收组织')).toBeTruthy();
    expect(screen.getByText('会话记忆')).toBeTruthy();
    // 各分区行数标注。
    expect(screen.getByText('· 2 条')).toBeTruthy();
    // 行归位：偏好在全局区、习惯在对象区、称呼在会话区。
    expect(screen.getByText('沟通走邮件')).toBeTruthy();
    expect(screen.getByText('简报要短')).toBeTruthy();
    expect(screen.getByText('称呼用「您」')).toBeTruthy();
  });

  it('禁写行展示结构化匹配三元组（0054）：对象名 · 谓词 · 取值', async () => {
    await renderSettings(seedMemoryState());

    const banRow = screen.getByText('出站不得再写「在招岗位：后端实习」').closest('.memory-row');
    expect(banRow).not.toBeNull();
    expect(banRow?.textContent).toContain('禁写匹配：记忆验收组织 · 在招岗位 · 后端实习');
  });

  it('移除按钮走既有 REMOVE_MEMORY：只发动作，不在渲染层改状态', async () => {
    const stub = await renderSettings(seedMemoryState());

    fireEvent.click(
      screen.getByText('沟通走邮件').closest('.memory-row')!.querySelector('button')!,
    );

    expect(stub.actions).toContainEqual({ type: 'REMOVE_MEMORY', id: 'mem-pref' });
  });

  it('零记忆时展示空态文案，不渲染分区', async () => {
    await renderSettings(makeState());

    expect(screen.getByText('还没有记忆。纠正与「记下来：…」会立刻写入。')).toBeTruthy();
    expect(screen.queryByText('全局记忆')).toBeNull();
  });
});
