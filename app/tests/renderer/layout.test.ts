import { describe, expect, it } from 'vitest';
import {
  fitWorkspaceLayout,
  MAIN_MIN_WIDTH,
  RIGHT_MIN_WIDTH,
  WORKSPACE_RAIL_WIDTH,
} from '../../src/shared/layout';

describe('工作区窄窗口布局', () => {
  it('约 886px 视口下主列与详情列仍可用', () => {
    const fitted = fitWorkspaceLayout(886, {
      sessionOpen: true,
      rightOpen: true,
      sessionWidth: 232,
      rightWidth: 400,
    });

    expect(fitted.sessionOpen).toBe(false);
    expect(fitted.rightOpen).toBe(true);
    expect(fitted.rightWidth).toBeGreaterThanOrEqual(RIGHT_MIN_WIDTH);
    expect(886 - WORKSPACE_RAIL_WIDTH - fitted.rightWidth).toBeGreaterThanOrEqual(MAIN_MIN_WIDTH);
  });

  it('重开详情列时先让位会话列', () => {
    const fitted = fitWorkspaceLayout(886, {
      sessionOpen: true,
      rightOpen: true,
      sessionWidth: 232,
      rightWidth: 400,
    });

    expect(fitted).toMatchObject({ sessionOpen: false, rightOpen: true, rightWidth: 400 });
  });

  it('详情列先缩到最小宽度，实在放不下才关闭', () => {
    const shrunk = fitWorkspaceLayout(756, {
      sessionOpen: true,
      rightOpen: true,
      sessionWidth: 232,
      rightWidth: 400,
    });
    expect(shrunk).toMatchObject({ sessionOpen: false, rightOpen: true, rightWidth: 280 });

    const impossible = fitWorkspaceLayout(755, {
      sessionOpen: false,
      rightOpen: true,
      sessionWidth: 232,
      rightWidth: 400,
    });
    expect(impossible.rightOpen).toBe(false);
  });
});
