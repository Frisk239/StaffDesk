import { describe, expect, it } from 'vitest';
import {
  fitWorkspaceLayout,
  MAIN_MIN_WIDTH,
  RIGHT_MIN_WIDTH,
  WORKSPACE_RAIL_WIDTH,
} from '../../src/shared/layout';

describe('workspace narrow-window layout', () => {
  it('keeps the main and details columns usable at an approximately 886px viewport', () => {
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

  it('reopens the details column by yielding the session column first', () => {
    const fitted = fitWorkspaceLayout(886, {
      sessionOpen: true,
      rightOpen: true,
      sessionWidth: 232,
      rightWidth: 400,
    });

    expect(fitted).toMatchObject({ sessionOpen: false, rightOpen: true, rightWidth: 400 });
  });

  it('shrinks details to its minimum before finally closing it', () => {
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
