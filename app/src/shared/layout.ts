export const WORKSPACE_RAIL_WIDTH = 56;
export const SESSION_MIN_WIDTH = 180;
export const SESSION_MAX_WIDTH = 360;
export const SESSION_DEFAULT_WIDTH = 232;
export const RIGHT_MIN_WIDTH = 280;
export const RIGHT_MAX_WIDTH = 560;
export const RIGHT_DEFAULT_WIDTH = 400;
export const MAIN_MIN_WIDTH = 420;

export interface WorkspaceLayout {
  sessionOpen: boolean;
  rightOpen: boolean;
  sessionWidth: number;
  rightWidth: number;
}

/**
 * Fit the three workspace columns without hiding the useful details panel at the
 * minimum desktop width. The session list is navigation and therefore yields
 * first; the details panel only closes when even its minimum width cannot coexist
 * with a usable main column.
 */
export function fitWorkspaceLayout(
  viewportWidth: number,
  desired: WorkspaceLayout,
): WorkspaceLayout {
  let sessionOpen = desired.sessionOpen;
  let rightOpen = desired.rightOpen;
  const sessionWidth = clamp(desired.sessionWidth, SESSION_MIN_WIDTH, SESSION_MAX_WIDTH);
  let rightWidth = clamp(desired.rightWidth, RIGHT_MIN_WIDTH, RIGHT_MAX_WIDTH);
  const contentWidth = Math.max(0, Math.floor(viewportWidth) - WORKSPACE_RAIL_WIDTH);

  if (rightOpen) {
    const desiredMain = contentWidth - (sessionOpen ? sessionWidth : 0) - rightWidth;
    if (desiredMain < MAIN_MIN_WIDTH) sessionOpen = false;

    const availableForRight = contentWidth - (sessionOpen ? sessionWidth : 0) - MAIN_MIN_WIDTH;
    if (availableForRight >= RIGHT_MIN_WIDTH) {
      rightWidth = Math.min(rightWidth, availableForRight);
    } else {
      rightOpen = false;
    }
  }

  if (!rightOpen && sessionOpen && contentWidth - sessionWidth < MAIN_MIN_WIDTH) {
    sessionOpen = false;
  }

  return { sessionOpen, rightOpen, sessionWidth, rightWidth };
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(n)));
}
