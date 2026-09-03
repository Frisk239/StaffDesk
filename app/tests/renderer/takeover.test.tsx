// @vitest-environment happy-dom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { StoreProvider } from '../../src/renderer/src/store';
import { Takeover } from '../../src/renderer/src/components/Takeover';
import { installStaffdeskStub, makeState } from './helpers/stubStaffdesk';
import type { Claim, WriteProposal } from '@shared/types';

afterEach(cleanup);

const OBJECT_A = 'obj-a';
const OBJECT_B = 'obj-b';

function claim(id: string, objectId: string, text: string): Claim {
  return {
    id,
    objectId,
    predicate: '后端主栈',
    text,
    status: '成立',
    unverified: true,
    sourceId: 's1',
    createdAt: '2026-09-01',
  };
}

function write(partial: Omit<WriteProposal, 'id'> & { id: string }): WriteProposal {
  return partial;
}

async function renderTakeover(state: ReturnType<typeof makeState>, objectId = OBJECT_A) {
  installStaffdeskStub(state);
  render(
    <StoreProvider>
      <Takeover objectId={objectId} />
    </StoreProvider>,
  );
  await act(async () => {});
}

describe('待确认卡计数口径', () => {
  it('单条：还有 0 个待确认操作，本操作含 1 条主张', async () => {
    await renderTakeover(
      makeState({
        objects: [{ id: OBJECT_A, kind: '组织', name: '甲', relationIds: [], workspaceId: 'ws-1' }],
        claims: [claim('cl-1', OBJECT_A, '主栈是 Go')],
        writeQueue: [
          write({
            id: 'wr-1',
            objectId: OBJECT_A,
            kind: '晋升',
            claimId: 'cl-1',
            headline: '晋升这条主张',
            evidence: '主栈是 Go',
          }),
        ],
      }),
    );
    expect(screen.getByText(/还有 0 个待确认操作/)).toBeTruthy();
    expect(screen.getByText(/本操作含 1 条主张/)).toBeTruthy();
    expect(screen.queryByText(/本对象还有/)).toBeNull();
    expect(screen.queryByText(/还有 0 条/)).toBeNull();
  });

  it('批量：还有 0 个待确认操作，本操作含 3 条主张，不用条同时数队列', async () => {
    await renderTakeover(
      makeState({
        objects: [{ id: OBJECT_A, kind: '组织', name: '甲', relationIds: [], workspaceId: 'ws-1' }],
        claims: [
          claim('cl-1', OBJECT_A, '主栈是 Go'),
          claim('cl-2', OBJECT_A, '在招后端'),
          claim('cl-3', OBJECT_A, '地点杭州'),
        ],
        writeQueue: [
          write({
            id: 'wr-batch',
            objectId: OBJECT_A,
            kind: '批量晋升',
            claimIds: ['cl-1', 'cl-2', 'cl-3'],
            headline: '本任务未核 3 条主张：全部晋升，还是全部保持？',
            evidence: '· 主栈是 Go',
            outbound: true,
          }),
        ],
      }),
    );
    expect(screen.getByText(/还有 0 个待确认操作/)).toBeTruthy();
    expect(screen.getByText(/本操作含 3 条主张/)).toBeTruthy();
    expect(screen.getByText(/本任务未核 3 条主张/)).toBeTruthy();
    expect(screen.queryByText('本对象还有 0 条')).toBeNull();
  });

  it('其他对象仍有队列：区分本对象剩余操作与其他对象操作', async () => {
    await renderTakeover(
      makeState({
        objects: [
          { id: OBJECT_A, kind: '组织', name: '甲', relationIds: [], workspaceId: 'ws-1' },
          { id: OBJECT_B, kind: '组织', name: '乙', relationIds: [], workspaceId: 'ws-1' },
        ],
        claims: [claim('cl-1', OBJECT_A, '主栈是 Go'), claim('cl-2', OBJECT_B, '乙在招')],
        writeQueue: [
          write({
            id: 'wr-1',
            objectId: OBJECT_A,
            kind: '晋升',
            claimId: 'cl-1',
            headline: '晋升这条主张',
            evidence: '主栈是 Go',
          }),
          write({
            id: 'wr-2',
            objectId: OBJECT_A,
            kind: '纠正',
            claimId: 'cl-1',
            headline: '纠正这条主张',
            evidence: '主栈其实是 Rust',
          }),
          write({
            id: 'wr-3',
            objectId: OBJECT_B,
            kind: '晋升',
            claimId: 'cl-2',
            headline: '晋升乙的主张',
            evidence: '乙在招',
          }),
        ],
      }),
    );
    const other = screen.getByRole('button', { name: /其他对象还有 1 个待确认操作（乙）/ });
    expect(other).toBeTruthy();
    expect(other.parentElement?.textContent).toMatch(/还有 1 个待确认操作/);
    expect(other.parentElement?.textContent).toMatch(/本操作含 1 条主张/);
    expect(screen.queryByText(/其他对象还有 1 条/)).toBeNull();
  });
});
