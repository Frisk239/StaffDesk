// @vitest-environment happy-dom
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { StoreProvider } from '../../src/renderer/src/store';
import { PendingView } from '../../src/renderer/src/components/PendingView';
import { installStaffdeskStub, makeState } from './helpers/stubStaffdesk';

afterEach(cleanup);

describe('待确认打开扫描滞留 0064', () => {
  it('挂载时派发 SCAN_LINGER_UNVERIFIED，带当前滞留天数', async () => {
    const stub = installStaffdeskStub(makeState());
    window.staffdesk.getLingerDays = () => Promise.resolve(14);
    render(
      <StoreProvider>
        <PendingView />
      </StoreProvider>,
    );
    await act(async () => {});
    await act(async () => {});
    const scan = stub.actions.find((action) => action.type === 'SCAN_LINGER_UNVERIFIED');
    expect(scan).toMatchObject({ type: 'SCAN_LINGER_UNVERIFIED', lingerDays: 14 });
    if (scan?.type === 'SCAN_LINGER_UNVERIFIED') {
      expect(typeof scan.now).toBe('string');
    }
  });
});
