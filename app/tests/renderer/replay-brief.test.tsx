// @vitest-environment happy-dom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { StoreProvider } from '../../src/renderer/src/store';
import { ReplayView } from '../../src/renderer/src/components/ReplayView';
import { installStaffdeskStub, makeState } from './helpers/stubStaffdesk';

afterEach(cleanup);

describe('简报任务回放', () => {
  it('已完成的出简报任务展示审计步骤，而不是还没有步骤', async () => {
    installStaffdeskStub(
      makeState({
        objects: [
          { id: 'obj-1', kind: '组织', name: '验收组织', relationIds: [], workspaceId: 'ws-1' },
        ],
        tasks: [
          {
            id: 'task-1',
            objectId: 'obj-1',
            kind: '出简报',
            status: '已完成',
            createdAt: '2026-09-03T06:23:00.000Z',
          },
        ],
        taskAudits: [
          {
            taskId: 'task-1',
            seq: 1,
            kind: '开始',
            payload: { objectId: 'obj-1' },
            ts: '2026-09-03T06:23:00.000Z',
          },
          {
            taskId: 'task-1',
            seq: 2,
            kind: '组装',
            payload: { blocks: 5 },
            ts: '2026-09-03T06:23:01.000Z',
          },
          {
            taskId: 'task-1',
            seq: 3,
            kind: '出站校验',
            payload: { sentences: 4 },
            ts: '2026-09-03T06:23:02.000Z',
          },
          {
            taskId: 'task-1',
            seq: 4,
            kind: '完成',
            payload: { briefId: 'brief-1' },
            ts: '2026-09-03T06:23:03.000Z',
          },
        ],
        view: { kind: 'replay', taskId: 'task-1' },
      }),
    );
    render(
      <StoreProvider>
        <ReplayView taskId="task-1" />
      </StoreProvider>,
    );
    await act(async () => {});
    expect(screen.queryByText('还没有步骤。')).toBeNull();
    expect(screen.getByText('1. 开始')).toBeTruthy();
    expect(screen.getByText('2. 组装')).toBeTruthy();
    expect(screen.getByText('3. 出站校验')).toBeTruthy();
    expect(screen.getByText('4. 完成')).toBeTruthy();
  });
});
