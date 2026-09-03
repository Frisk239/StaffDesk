// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { StoreProvider } from '../../src/renderer/src/store';
import { SettingsModal } from '../../src/renderer/src/components/Settings';
import { installStaffdeskStub, makeState } from './helpers/stubStaffdesk';

afterEach(cleanup);

describe('设置-滞留天数 0064', () => {
  it('通用节用滞留/未核/整理文案，数字框默认 7', async () => {
    installStaffdeskStub(makeState());
    render(
      <StoreProvider>
        <SettingsModal open initialSection="通用" onClose={() => undefined} />
      </StoreProvider>,
    );
    await act(async () => {});
    expect(screen.getByText('滞留未核')).toBeTruthy();
    expect(screen.getByText(/整理可提议丢弃/)).toBeTruthy();
    const input = screen.getByLabelText('滞留天数') as HTMLInputElement;
    expect(input.value).toBe('7');
    expect(input.min).toBe('1');
    expect(input.max).toBe('90');
  });

  it('改天数走 setLingerDays，展示钳制后的值', async () => {
    const stub = installStaffdeskStub(makeState());
    let stored = 7;
    window.staffdesk.getLingerDays = () => Promise.resolve(stored);
    window.staffdesk.setLingerDays = (days) => {
      stored = days > 90 ? 90 : days < 1 ? 7 : days;
      return Promise.resolve(stored);
    };
    render(
      <StoreProvider>
        <SettingsModal open initialSection="通用" onClose={() => undefined} />
      </StoreProvider>,
    );
    await act(async () => {});
    const input = screen.getByLabelText('滞留天数') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '91' } });
    fireEvent.blur(input);
    await act(async () => {});
    expect(stored).toBe(90);
    expect(input.value).toBe('90');
    expect(stub.actions).toEqual([]);
  });
});
