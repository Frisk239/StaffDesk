import { describe, expect, it } from 'vitest';
import type { State } from '@shared/types';
import { emptyUiFields } from '@shared/defaults';
import { DEFAULT_SLOT_DEFS } from '@shared/scenario';
import type { ReachAdapter } from '../../src/main/adapters/reach';
import { runResearchTask } from '../../src/main/tasks/engine';
import { planRadarRun } from '../../src/main/tasks/radar';

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
    expect(result.audits.some((a) => a.kind === '体检')).toBe(true);
    expect(result.audits.some((a) => a.kind === '搜索')).toBe(true);
    expect(result.audits.some((a) => a.kind === '打开尝试')).toBe(true);
    expect(result.audits.some((a) => a.kind === '打开失败')).toBe(true);
    expect(result.sources.every((s) => s.path === '调研')).toBe(true);
    expect(result.sources[0]?.origin?.kind).toBe('research');
    expect(result.sources[0]?.origin?.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.sources[0]?.segments?.[0]?.id).toBe('body');
    expect(JSON.stringify(result.sources)).not.toMatch(/没有这家公司/);
  });

  it('搜索空结果如实回放，不写来源也不算失败', async () => {
    const reach: ReachAdapter = {
      doctor: async () => ({ ok: true, detail: 'ok' }),
      search: async () => [],
      open: async (url) => ({ url, ok: false, body: '', error: '不应打开' }),
    };
    const result = await runResearchTask(baseState(), 'org-1', '快搜', {
      reach,
      now: () => Date.parse('2026-08-30T00:00:00.000Z'),
      queryFor: () => '验收组织',
    });
    expect(result.sources).toEqual([]);
    expect(result.task.status).toBe('已完成');
    expect(result.task.stopReason).toBeUndefined();
    expect(result.audits.some((audit) => audit.kind === '空结果')).toBe(true);
  });

  it('检索不可用时体检和停止原因进审计', async () => {
    const reach: ReachAdapter = {
      doctor: async () => ({ ok: false, detail: 'missing binary', hint: 'install Agent Reach' }),
      search: async () => {
        throw new Error('不应搜索');
      },
      open: async (url) => ({ url, ok: false, body: '', error: '不应打开' }),
    };
    const result = await runResearchTask(baseState(), 'org-1', '快搜', {
      reach,
      now: () => Date.parse('2026-08-30T00:00:00.000Z'),
      queryFor: () => '验收组织',
    });
    expect(result.task.status).toBe('已停止');
    expect(result.task.stopReason).toBe('失败');
    expect(result.audits.map((audit) => audit.kind)).toEqual(['体检', '停止']);
    expect(JSON.stringify(result.audits)).toMatch(/install Agent Reach/);
  });

  it('雷达补跑走同一调研路径并记录迟跑', async () => {
    const radar = {
      id: 'radar-1',
      objectId: 'org-1',
      kind: '周期性雷达' as const,
      status: '待启动' as const,
      budgetGear: '快搜' as const,
      query: '验收组织 官方',
      intervalDays: 1,
      nextDueAt: '2026-08-28 00:00',
      createdAt: '2026-08-27 00:00',
    };
    const state = { ...baseState(), tasks: [radar] };
    const plan = planRadarRun(radar, Date.parse('2026-08-30T00:00:00.000Z'));
    const reach: ReachAdapter = {
      doctor: async () => ({ ok: true, detail: 'ok' }),
      search: async () => [{ title: 'A', url: 'https://a.example/doc', snippet: 'ok' }],
      open: async (url) => ({ url, ok: true, body: '雷达打开正文' }),
    };
    const result = await runResearchTask(
      state,
      'org-1',
      '快搜',
      {
        reach,
        now: () => Date.parse('2026-08-30T00:00:00.000Z'),
        queryFor: () => '不应使用',
      },
      plan.options,
    );
    expect(result.task.kind).toBe('再搜一轮');
    expect(result.task.parentTaskId).toBe('radar-1');
    expect(result.task.dueAt).toBe('2026-08-30 00:00');
    expect(result.task.query).toBe('验收组织 官方');
    expect(result.audits[0]?.kind).toBe('未跑');
    expect(result.audits[1]?.kind).toBe('迟跑');
    expect(result.sources).toHaveLength(1);
  });
});
