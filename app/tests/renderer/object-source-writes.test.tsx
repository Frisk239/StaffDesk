// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { StoreProvider } from '../../src/renderer/src/store';
import { InboxView } from '../../src/renderer/src/components/InboxView';
import { SourcesPane } from '../../src/renderer/src/components/ObjectPage';
import { installStaffdeskStub, makeState } from './helpers/stubStaffdesk';
import type { Source } from '@shared/types';

afterEach(cleanup);

const OBJECT_A = 'obj-a';

function boundSource(partial: Partial<Source> = {}): Source {
  return {
    id: 'src-1',
    title: '双对象材料',
    body: '甲组织主栈是 Go。',
    path: '手给',
    boundObjectIds: [OBJECT_A],
    workspaceId: 'ws-1',
    ...partial,
  };
}

async function renderSources(source: Source = boundSource()) {
  const stub = installStaffdeskStub(
    makeState({
      objects: [
        { id: OBJECT_A, kind: '组织', name: '甲组织', relationIds: [], workspaceId: 'ws-1' },
      ],
      sources: [source],
      claims: [
        {
          id: 'cl-1',
          objectId: OBJECT_A,
          predicate: '后端主栈',
          text: '甲组织主栈是 Go',
          status: '成立',
          unverified: true,
          sourceId: source.id,
          createdAt: '2026-09-01',
        },
      ],
      extractJobs: [{ sourceId: source.id, status: '失败', detail: 'boom' }],
    }),
  );
  render(
    <StoreProvider>
      <SourcesPane objectId={OBJECT_A} />
    </StoreProvider>,
  );
  await act(async () => {});
  return stub;
}

describe('对象页来源面板只入队不落账 0027', () => {
  it('解绑、删除、重试都派发 ENQUEUE_WRITE，不直接解绑删除或重试', async () => {
    const stub = await renderSources();
    fireEvent.click(screen.getByRole('button', { name: /双对象材料/ }));
    fireEvent.click(screen.getByRole('button', { name: '解绑当前对象' }));
    fireEvent.click(screen.getByRole('button', { name: '删除来源' }));
    fireEvent.click(screen.getByRole('button', { name: '重试' }));

    const enqueued = stub.actions.filter((action) => action.type === 'ENQUEUE_WRITE');
    expect(enqueued.map((action) => action.draft.kind)).toEqual(['解绑', '删除来源', '重试抽取']);
    expect(enqueued.every((action) => action.draft.sourceId === 'src-1')).toBe(true);
    expect(enqueued.find((action) => action.draft.kind === '解绑')?.draft.evidence).toMatch(
      /会离开该对象/,
    );
    expect(enqueued.find((action) => action.draft.kind === '删除来源')?.draft.evidence).toMatch(
      /不提供一键撤销/,
    );
    expect(stub.actions.some((action) => action.type === 'UNBIND_SOURCE')).toBe(false);
    expect(stub.actions.some((action) => action.type === 'DELETE_SOURCE')).toBe(false);
    expect(stub.actions.some((action) => action.type === 'RETRY_EXTRACTION')).toBe(false);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('Inbox 删除来源仍走对话框 0027', () => {
  it('Inbox 点删除来源打开确认层，确认才派发 DELETE_SOURCE', async () => {
    const source = boundSource({ boundObjectIds: [] });
    const stub = installStaffdeskStub(
      makeState({
        inbox: [source.id],
        sources: [source],
        view: { kind: 'inbox' },
      }),
    );
    render(
      <StoreProvider>
        <InboxView />
      </StoreProvider>,
    );
    await act(async () => {});

    fireEvent.click(screen.getByRole('button', { name: '删除来源' }));
    expect(screen.getByRole('dialog', { name: '删除来源' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '确认删除' }));
    expect(stub.actions).toEqual([{ type: 'DELETE_SOURCE', sourceId: source.id }]);
  });
});
