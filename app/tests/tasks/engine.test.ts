import { describe, expect, it } from 'vitest';
import type { State } from '@shared/types';
import { emptyUiFields } from '@shared/defaults';
import { DEFAULT_SLOT_DEFS } from '@shared/scenario';
import type { ReachAdapter } from '../../src/main/adapters/reach';
import { runResearchTask } from '../../src/main/tasks/engine';

function baseState(): State {
  return {
    ...emptyUiFields(),
    workspaces: [{ id: 'ws-1', name: '区', scenario: '求职面试' }],
    currentWorkspaceId: 'ws-1',
    objects: [
      { id: 'org-1', kind: '组织', name: '验收组织', relationIds: [], workspaceId: 'ws-1' },
    ],
    sources: [],
    claims: [],
    slotDefs: DEFAULT_SLOT_DEFS,
    briefs: [],
    memories: [],
    inbox: [],
    proposals: [],
    tasks: [],
    taskAudits: [],
    chatByObject: {},
    seq: 1,
    onboardingDone: true,
  };
}

describe('调研任务引擎', () => {
  it('触顶后已打开的来源入库，失败 URL 进审计，不编负事实', async () => {
    const reach: ReachAdapter = {
      doctor: async () => ({ ok: true, detail: 'ok' }),
      search: async () => [
        { title: 'A', url: 'https://a.example/doc', snippet: 'ok' },
        { title: 'B', url: 'https://b.example/fail', snippet: 'x' },
        { title: 'C', url: 'https://c.example/skip', snippet: 'y' },
      ],
      open: async (url) => {
        if (url.includes('fail')) return { url, ok: false, body: '', error: '404' };
        return { url, ok: true, body: `${url} 官方正文` };
      },
    };
    const result = await runResearchTask(baseState(), 'org-1', '快搜', {
      reach,
      now: (() => {
        let t = 0;
        return () => {
          t += 1;
          return t;
        };
      })(),
      queryFor: () => '验收组织',
    });
    expect(result.sources.length).toBeGreaterThan(0);
    expect(result.failedUrls.some((u) => u.includes('fail'))).toBe(true);
    expect(result.audits.some((a) => a.kind === '失败')).toBe(true);
    expect(result.sources.every((s) => s.path === '调研')).toBe(true);
    expect(JSON.stringify(result.sources)).not.toMatch(/没有这家公司/);
  });
});
