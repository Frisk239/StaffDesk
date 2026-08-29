import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openBrain, type Brain } from '../../src/main/brain';
import { listOperations } from '../../src/main/brain/persist';
import { createMemorySecrets } from '../../src/main/keychain';
import { exportBrainZip } from '../../src/main/exportZip';
import { latestDueRadar } from '../../src/main/tasks/radar';

const dirs: string[] = [];
const brains: Brain[] = [];

function tmp() {
  const dir = mkdtempSync(join(tmpdir(), 'sd-undo-'));
  dirs.push(dir);
  return join(dir, 'brain.db');
}

afterEach(() => {
  while (brains.length) {
    try {
      brains.pop()?.close();
    } catch {
      /* closed */
    }
  }
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* lock */
    }
  }
});

describe('撤销补偿与重启', () => {
  it('晋升后关掉再打开，仍能一键撤回', () => {
    const file = tmp();
    let brain = openBrain(file);
    brains.push(brain);
    brain.dispatch({ type: 'ADD_WORKSPACE', name: '区', scenario: '求职面试' });
    brain.dispatch({ type: 'ADD_OBJECT', kind: '组织', name: '甲' });
    const obj = brain.snapshot().objects[0]!;
    brain.dispatch({ type: 'ADD_SOURCE', title: 't', body: '该公司在招后端实习。团队主栈是 Go。' });
    const src = brain.snapshot().sources.find((s) => !s.virtual)!;
    brain.dispatch({ type: 'BIND_CONFIRMED', sourceId: src.id, objectIds: [obj.id] });
    brain.dispatch({ type: 'EXTRACT_DONE', sourceId: src.id });
    const claim = brain.snapshot().claims[0]!;
    brain.dispatch({ type: 'PROMOTE_CLAIM', claimId: claim.id });
    const card = (brain.snapshot().chatByObject[obj.id] ?? []).find((m) => m.card?.undo?.kind === '晋升');
    expect(card).toBeTruthy();
    brain.close();

    brain = openBrain(file);
    brains.push(brain);
    const again = brain.snapshot();
    const card2 = (again.chatByObject[obj.id] ?? []).find((m) => m.card?.undo?.kind === '晋升');
    expect(card2).toBeTruthy();
    brain.dispatch({ type: 'UNDO_RESULT', objectId: obj.id, messageId: card2!.id });
    expect(brain.snapshot().claims.find((c) => c.id === claim.id)?.unverified).toBe(true);
    const ops = listOperations(brain.db);
    expect(ops.some((o) => o.action === 'UNDO_RESULT' && o.undo_of === 'compensating')).toBe(true);
  });

  it('永久删除对象不写撤销卡', () => {
    const brain = openBrain(tmp());
    brains.push(brain);
    brain.dispatch({ type: 'ADD_WORKSPACE', name: '区', scenario: '求职面试' });
    brain.dispatch({ type: 'ADD_OBJECT', kind: '组织', name: '甲' });
    const obj = brain.snapshot().objects[0]!;
    brain.dispatch({ type: 'ARCHIVE_OBJECT', id: obj.id });
    brain.dispatch({ type: 'DELETE_OBJECT', id: obj.id });
    const cards = Object.values(brain.snapshot().chatByObject).flat();
    expect(cards.every((m) => m.card?.undo === undefined)).toBe(true);
  });

  it('密钥不进导出包', () => {
    const secrets = createMemorySecrets();
    const file = tmp();
    const brain = openBrain(file, secrets);
    brains.push(brain);
    brain.dispatch({
      type: 'UPSERT_PROVIDER',
      provider: {
        id: 'p-deepseek',
        kind: 'deepseek',
        name: 'DeepSeek',
        baseUrl: 'https://api.deepseek.com/v1',
        apiKey: 'sk-should-not-leak',
        protocol: 'chat-completions',
        enabled: true,
        models: [{ id: 'deepseek-chat', name: 'deepseek-chat', contextWindow: 1, maxOutput: 1 }],
      },
    });
    brain.close();
    const zip = exportBrainZip(file);
    expect(zip.subarray(0, 2).toString()).toBe('PK');
    expect(zip.toString('utf8')).not.toContain('sk-should-not-leak');
    const again = openBrain(file, secrets);
    brains.push(again);
    expect(again.snapshot().providers.find((p) => p.id === 'p-deepseek')?.apiKey).toBe('sk-should-not-leak');
  });

  it('雷达只补最新一次', () => {
    expect(
      latestDueRadar(
        [
          { id: 'old', objectId: 'o', kind: '周期性雷达', status: '已完成', createdAt: '2020-01-01 00:00' },
          { id: 'new', objectId: 'o', kind: '周期性雷达', status: '已完成', createdAt: '2020-02-01 00:00' },
        ],
        Date.parse('2026-01-01'),
      )?.id,
    ).toBe('new');
  });
});
