// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { StoreProvider } from '../../src/renderer/src/store';
import { SettingsModal } from '../../src/renderer/src/components/Settings';
import { installStaffdeskStub, makeState } from './helpers/stubStaffdesk';

// F5/D3（M34，Spec 评审补）：设置「谓词表」节行为测试——行级编辑弹层打开与保存走
// UPDATE_SLOT、删除确认走 REMOVE_SLOT。mock 边界是 window.staffdesk（IPC），不触主进程与外网。

afterEach(cleanup);

function seedSlotState() {
  return makeState({
    slotDefs: [
      {
        kind: '组织',
        name: '主营业务',
        arity: '单值',
        scenarios: ['求职面试'],
      },
    ],
  });
}

describe('设置-谓词表交互（M34 F5/D3）', () => {
  it('编辑槽：弹层打开、改名保存派发 UPDATE_SLOT', async () => {
    const stub = installStaffdeskStub(seedSlotState());
    render(
      <StoreProvider>
        <SettingsModal open initialSection="谓词表" onClose={() => undefined} />
      </StoreProvider>,
    );
    await act(async () => {});

    fireEvent.click(screen.getByRole('button', { name: '编辑槽 主营业务' }));
    const nameInput = await screen.findByLabelText(/槽名/);
    expect((nameInput as HTMLInputElement).value).toBe('主营业务');
    fireEvent.change(nameInput, { target: { value: '主营业务口径' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    const update = stub.actions.find((a) => a.type === 'UPDATE_SLOT');
    expect(update).toMatchObject({ name: '主营业务', kind: '组织' });
  });

  it('删除槽：确认弹层走 REMOVE_SLOT，取消不派发', async () => {
    const stub = installStaffdeskStub(seedSlotState());
    render(
      <StoreProvider>
        <SettingsModal open initialSection="谓词表" onClose={() => undefined} />
      </StoreProvider>,
    );
    await act(async () => {});

    fireEvent.click(screen.getByRole('button', { name: '删除槽 主营业务' }));
    fireEvent.click(screen.getByRole('button', { name: '确认删除' }));
    expect(stub.actions.some((a) => a.type === 'REMOVE_SLOT' && a.name === '主营业务')).toBe(true);

    // 取消路径：再开一次确认层点取消，不产生第二个 REMOVE_SLOT。
    fireEvent.click(screen.getByRole('button', { name: '删除槽 主营业务' }));
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(stub.actions.filter((a) => a.type === 'REMOVE_SLOT')).toHaveLength(1);
  });
});
