import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openBrain, type Brain } from '../../src/main/brain';
import { trackLedgerReads, trackRecoveryScans } from '../../src/main/brain/persist';

const dirs: string[] = [];
const brains: Brain[] = [];

function tmpBrain() {
  const dir = mkdtempSync(join(tmpdir(), 'staffdesk-dispatch-read-'));
  dirs.push(dir);
  return join(dir, 'brain.db');
}

afterEach(() => {
  while (brains.length) {
    try {
      brains.pop()?.close();
    } catch {
      /* already closed */
    }
  }
  while (dirs.length) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('dispatch 单次读账本（0051）', () => {
  it('单次 dispatch 只触发一次全量读；snapshot 不再扫 operations', () => {
    const brain = openBrain(tmpBrain());
    brains.push(brain);
    const reads = trackLedgerReads(brain.db);
    const scans = trackRecoveryScans(brain.db);

    brain.dispatch({ type: 'TOAST', text: '读路径债' });
    expect(reads.count).toBe(1);
    expect(scans.count).toBe(0);

    brain.snapshot();
    expect(reads.count).toBe(2);
    expect(scans.count).toBe(0);
  });
});
