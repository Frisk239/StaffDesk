import { describe, expect, it } from 'vitest';
import { emptyUiFields } from '@shared/defaults';
import { builtinScenarioTemplates, DEFAULT_SLOT_DEFS } from '@shared/scenario';
import { emptyFeeSpend } from '@shared/taskFee';
import type { State } from '@shared/types';
import type { ReachAdapter } from '../../src/main/adapters/reach';
import { BUDGETS, capHit, runResearchTask } from '../../src/main/tasks/engine';
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
    // 0058：场景模板是账本数据——用种子基线构造（断言依赖内置 spec 的场景必须带内置模板）。
    scenarioTemplates: builtinScenarioTemplates(),
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
  it('预算有 tokens 顶且没有 hops 维度', () => {
    expect(BUDGETS.快搜.tokens).toBe(120_000);
    expect(BUDGETS.深挖.tokens).toBe(400_000);
    expect('hops' in BUDGETS.快搜).toBe(false);
    expect('hops' in BUDGETS.深挖).toBe(false);
  });

  it('token 累计或缺失次数达顶判费用触顶，搜索打开达顶仍是触顶', () => {
    const spend = {
      ...emptyFeeSpend(),
      totalTokens: 120_000,
      promptTokens: 120_000,
    };
    expect(
      capHit({
        budget: BUDGETS.快搜,
        searches: 0,
        opens: 0,
        steps: 0,
        elapsedMs: 0,
        spend,
      }),
    ).toBe('费用触顶');
    expect(
      capHit({
        budget: BUDGETS.快搜,
        searches: 0,
        opens: 0,
        steps: 0,
        elapsedMs: 0,
        spend: { ...emptyFeeSpend(), missingUsageCalls: 8, lastMissingUsage: true },
      }),
    ).toBe('费用触顶');
    expect(
      capHit({
        budget: BUDGETS.快搜,
        searches: 8,
        opens: 0,
        steps: 0,
        elapsedMs: 0,
        spend: emptyFeeSpend(),
      }),
    ).toBe('触顶');
  });

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
    expect(result.audits.map((audit) => audit.kind)).toEqual(['开始', '体检', '停止']);
    expect(JSON.stringify(result.audits)).toMatch(/install Agent Reach/);
  });

  it('收到手动停止后不再打开搜索命中，过程审计可增量观察', async () => {
    let stop = false;
    let opens = 0;
    const streamed: string[] = [];
    const reach: ReachAdapter = {
      doctor: async () => ({ ok: true, detail: 'ok' }),
      search: async () => [
        { title: 'A', url: 'https://a.example/doc', snippet: 'ok' },
        { title: 'B', url: 'https://b.example/doc', snippet: 'ok' },
      ],
      open: async (url) => {
        opens += 1;
        return { url, ok: true, body: '不应写入' };
      },
    };
    const result = await runResearchTask(baseState(), 'org-1', '快搜', {
      reach,
      now: () => Date.parse('2026-08-30T00:00:00.000Z'),
      queryFor: () => '验收组织',
      onAudit: (audit) => {
        streamed.push(audit.kind);
        if (audit.kind === '搜索结果') stop = true;
      },
      shouldStop: () => stop,
    });
    expect(opens).toBe(0);
    expect(result.task.status).toBe('已停止');
    expect(result.task.stopReason).toBe('手动');
    expect(result.sources).toEqual([]);
    expect(streamed).toEqual(['开始', '体检', '搜索', '搜索结果', '停止']);
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
    expect(result.audits[0]?.kind).toBe('开始');
    expect(result.audits[1]?.kind).toBe('未跑');
    expect(result.audits[2]?.kind).toBe('迟跑');
    expect(result.sources).toHaveLength(1);
  });

  it('任务内 token 累计触顶记费用触顶，已打开的照写，不编负事实', async () => {
    let tokens = 0;
    const reach: ReachAdapter = {
      doctor: async () => ({ ok: true, detail: 'ok' }),
      search: async () => [
        { title: 'A', url: 'https://a.example/doc', snippet: 'ok' },
        { title: 'B', url: 'https://b.example/skip', snippet: 'y' },
      ],
      open: async (url) => {
        tokens = Number.MAX_SAFE_INTEGER;
        return { url, ok: true, body: `${url} 官方正文` };
      },
    };
    const result = await runResearchTask(baseState(), 'org-1', '快搜', {
      reach,
      now: () => Date.parse('2026-08-30T00:00:00.000Z'),
      queryFor: () => '验收组织',
      usageSpend: () => ({
        ...emptyFeeSpend(),
        totalTokens: tokens,
        promptTokens: tokens,
      }),
    });
    expect(result.task.stopReason).toBe('费用触顶');
    expect(result.task.status).toBe('已完成');
    expect(result.sources).toHaveLength(1);
    expect(result.audits.some((audit) => audit.kind === '费用触顶')).toBe(true);
    expect(JSON.stringify(result.sources)).not.toMatch(/没有这家公司/);
  });

  it('端点未回传 usage 计入调用次数近似，达独立小上限则费用触顶', async () => {
    let missing = 0;
    const reach: ReachAdapter = {
      doctor: async () => ({ ok: true, detail: 'ok' }),
      search: async () =>
        Array.from({ length: 10 }, (_, i) => ({
          title: `H${i}`,
          url: `https://h${i}.example/doc`,
          snippet: 'ok',
        })),
      open: async (url) => {
        missing += 1;
        return { url, ok: true, body: `${url} 官方正文` };
      },
    };
    const result = await runResearchTask(baseState(), 'org-1', '快搜', {
      reach,
      now: () => Date.parse('2026-08-30T00:00:00.000Z'),
      queryFor: () => '验收组织',
      usageSpend: () => ({
        ...emptyFeeSpend(),
        missingUsageCalls: missing,
        lastMissingUsage: true,
      }),
    });
    expect(result.task.stopReason).toBe('费用触顶');
    expect(result.sources.length).toBeGreaterThan(0);
    expect(result.sources.length).toBeLessThan(10);
    expect(result.audits.some((audit) => audit.kind === '费用触顶')).toBe(true);
  });
});
