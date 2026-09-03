import { describe, expect, it, vi } from 'vitest';
import { emptyUiFields } from '@shared/defaults';
import { builtinScenarioTemplates, DEFAULT_SLOT_DEFS } from '@shared/scenario';
import { emptyFeeSpend } from '@shared/taskFee';
import type { State } from '@shared/types';
import type { OpenResult, ReachAdapter, ReachPath, SearchHit } from '../../src/main/adapters/reach';
import {
  BUDGETS,
  budgetFor,
  capHit,
  mergeSearchHits,
  runResearchTask,
} from '../../src/main/tasks/engine';
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

const fixedNow = () => Date.parse('2026-08-30T00:00:00.000Z');

/** 单路假 reach：体检恒绿、只有 Exa 一路；测试只关心 search/open 行为。 */
function onePathReach(behavior: {
  search: ReachPath['search'];
  open: (url: string) => Promise<OpenResult>;
  doctor?: ReachAdapter['doctor'];
}): ReachAdapter {
  return {
    paths: [
      {
        name: 'Exa',
        doctorCheck: async () => ({ ok: true, detail: 'ok' }),
        search: behavior.search,
      },
    ],
    doctor:
      behavior.doctor ??
      (async () => ({
        ok: true,
        detail: 'ok',
        paths: [{ name: 'Exa', ok: true, detail: 'ok' }],
      })),
    open: behavior.open,
  };
}

/** 双路假 reach（0061）：Exa + GitHub，体检逐路红绿可配。 */
function twoPathReach(args: {
  exaSearch: ReachPath['search'];
  githubSearch: ReachPath['search'];
  githubDoctorOk?: boolean;
  open?: (url: string) => Promise<OpenResult>;
}): ReachAdapter {
  const githubOk = args.githubDoctorOk ?? true;
  return {
    paths: [
      {
        name: 'Exa',
        doctorCheck: async () => ({ ok: true, detail: 'ok' }),
        search: args.exaSearch,
      },
      {
        name: 'GitHub',
        doctorCheck: async () => ({ ok: githubOk, detail: githubOk ? 'ok' : '坏凭据' }),
        search: args.githubSearch,
      },
    ],
    doctor: async () => ({
      // 0061：聚合体检任一路绿即 ok——红路只体现在 paths 里，不挡绿路。
      ok: true,
      detail: 'ok',
      paths: [
        { name: 'Exa', ok: true, detail: 'ok' },
        { name: 'GitHub', ok: githubOk, detail: githubOk ? 'ok' : '坏凭据' },
      ],
    }),
    open: args.open ?? (async (url) => ({ url, ok: true, body: `${url} 官方正文` })),
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
    const reach = onePathReach({
      search: async () => [
        { title: 'A', url: 'https://a.example/doc', snippet: 'ok' },
        { title: 'B', url: 'https://b.example/fail', snippet: 'x' },
        { title: 'C', url: 'https://c.example/skip', snippet: 'y' },
      ],
      open: async (url) => {
        if (url.includes('fail')) return { url, ok: false, body: '', error: '404' };
        return { url, ok: true, body: `${url} 官方正文` };
      },
    });
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
    const reach = onePathReach({
      search: async () => [],
      open: async (url) => ({ url, ok: false, body: '', error: '不应打开' }),
    });
    const result = await runResearchTask(baseState(), 'org-1', '快搜', {
      reach,
      now: fixedNow,
      queryFor: () => '验收组织',
    });
    expect(result.sources).toEqual([]);
    expect(result.task.status).toBe('已完成');
    expect(result.task.stopReason).toBeUndefined();
    expect(result.audits.some((audit) => audit.kind === '空结果')).toBe(true);
  });

  it('检索不可用时体检和停止原因进审计', async () => {
    const reach = onePathReach({
      search: async () => {
        throw new Error('不应搜索');
      },
      open: async (url) => ({ url, ok: false, body: '', error: '不应打开' }),
      doctor: async () => ({
        ok: false,
        detail: 'missing binary',
        hint: 'install Agent Reach',
        paths: [{ name: 'Exa', ok: false, detail: 'missing binary', hint: 'install Agent Reach' }],
      }),
    });
    const result = await runResearchTask(baseState(), 'org-1', '快搜', {
      reach,
      now: fixedNow,
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
    const reach = onePathReach({
      search: async () => [
        { title: 'A', url: 'https://a.example/doc', snippet: 'ok' },
        { title: 'B', url: 'https://b.example/doc', snippet: 'ok' },
      ],
      open: async (url) => {
        opens += 1;
        return { url, ok: true, body: '不应写入' };
      },
    });
    const result = await runResearchTask(baseState(), 'org-1', '快搜', {
      reach,
      now: fixedNow,
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
    const reach = onePathReach({
      search: async () => [{ title: 'A', url: 'https://a.example/doc', snippet: 'ok' }],
      open: async (url) => ({ url, ok: true, body: '雷达打开正文' }),
    });
    const result = await runResearchTask(
      state,
      'org-1',
      '快搜',
      {
        reach,
        now: fixedNow,
        queryFor: () => '不应使用',
      },
      plan.options,
    );
    expect(result.task.kind).toBe('再搜一轮');
    expect(result.task.parentTaskId).toBe('radar-1');
    expect(result.task.dueAt).toBe('2026-08-30T00:00:00.000Z');
    expect(result.task.query).toBe('验收组织 官方');
    expect(result.audits[0]?.kind).toBe('开始');
    expect(result.audits[1]?.kind).toBe('未跑');
    expect(result.audits[2]?.kind).toBe('迟跑');
    expect(result.sources).toHaveLength(1);
  });

  it('任务内 token 累计触顶记费用触顶，已打开的照写，不编负事实', async () => {
    let tokens = 0;
    const reach = onePathReach({
      search: async () => [
        { title: 'A', url: 'https://a.example/doc', snippet: 'ok' },
        { title: 'B', url: 'https://b.example/skip', snippet: 'y' },
      ],
      open: async (url) => {
        tokens = Number.MAX_SAFE_INTEGER;
        return { url, ok: true, body: `${url} 官方正文` };
      },
    });
    const result = await runResearchTask(baseState(), 'org-1', '快搜', {
      reach,
      now: fixedNow,
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
    const reach = onePathReach({
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
    });
    const result = await runResearchTask(baseState(), 'org-1', '快搜', {
      reach,
      now: fixedNow,
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

describe('多路检索扇出（0061）', () => {
  it('mergeSearchHits 跨路同 URL 留先到并计去重数', () => {
    const { hits, duplicates } = mergeSearchHits([
      {
        name: 'Exa',
        hits: [
          { title: '甲', url: 'https://a.example/doc', snippet: 'exa 版' },
          { title: '乙', url: 'https://b.example/doc', snippet: '' },
        ],
      },
      {
        name: 'GitHub',
        hits: [
          { title: '甲镜像', url: 'https://a.example/doc', snippet: 'github 版' },
          { title: '丙', url: 'https://c.example/doc', snippet: '' },
        ],
      },
    ]);
    expect(hits.map((hit) => hit.url)).toEqual([
      'https://a.example/doc',
      'https://b.example/doc',
      'https://c.example/doc',
    ]);
    // 同 URL 留先到：Exa 版胜出，不混拼两路摘要。
    expect(hits.find((hit) => hit.url === 'https://a.example/doc')?.snippet).toBe('exa 版');
    expect(duplicates).toBe(1);
    expect(mergeSearchHits([])).toEqual({ hits: [], duplicates: 0 });
  });

  it('双路并行扇出：命中按 URL 去重合并，审计记录每路命中数', async () => {
    const searched: string[] = [];
    const reach = twoPathReach({
      exaSearch: async (query) => {
        searched.push(`Exa:${query}`);
        return [
          { title: '甲', url: 'https://a.example/doc', snippet: 'ok' },
          { title: '乙', url: 'https://b.example/doc', snippet: 'ok' },
        ];
      },
      githubSearch: async (query) => {
        searched.push(`GitHub:${query}`);
        return [
          { title: '甲镜像', url: 'https://a.example/doc', snippet: '镜像' },
          { title: '丙', url: 'https://c.example/doc', snippet: 'ok' },
        ];
      },
    });
    const result = await runResearchTask(baseState(), 'org-1', '快搜', {
      reach,
      now: fixedNow,
      queryFor: () => '验收组织',
    });
    expect(searched).toEqual(['Exa:验收组织', 'GitHub:验收组织']);
    expect(result.sources.map((source) => source.origin?.locator)).toEqual([
      'https://a.example/doc',
      'https://b.example/doc',
      'https://c.example/doc',
    ]);
    const searchAudit = result.audits.find((audit) => audit.kind === '搜索');
    expect(searchAudit?.payload).toMatchObject({
      query: '验收组织',
      paths: [{ name: 'Exa' }, { name: 'GitHub' }],
    });
    const resultAudit = result.audits.find((audit) => audit.kind === '搜索结果');
    expect(resultAudit?.payload).toMatchObject({
      count: 3,
      duplicates: 1,
      paths: [
        { name: 'Exa', ok: true, count: 2 },
        { name: 'GitHub', ok: true, count: 2 },
      ],
    });
    expect(result.task.stopReason).toBeUndefined();
  });

  it('单路搜索失败只记该路审计，另一路照常打开入库', async () => {
    const reach = twoPathReach({
      exaSearch: async () => [{ title: '甲', url: 'https://a.example/doc', snippet: 'ok' }],
      githubSearch: async () => {
        throw new Error('GitHub 匿名额度用尽（HTTP 403）');
      },
    });
    const result = await runResearchTask(baseState(), 'org-1', '快搜', {
      reach,
      now: fixedNow,
      queryFor: () => '验收组织',
    });
    expect(result.sources.map((source) => source.origin?.locator)).toEqual([
      'https://a.example/doc',
    ]);
    expect(result.task.status).toBe('已完成');
    expect(result.task.stopReason).toBeUndefined();
    const failure = result.audits.find((audit) => audit.kind === '搜索失败');
    expect(failure?.payload).toMatchObject({ path: 'GitHub', error: /403/ });
    const resultAudit = result.audits.find((audit) => audit.kind === '搜索结果');
    expect(resultAudit?.payload).toMatchObject({
      count: 1,
      paths: [
        { name: 'Exa', ok: true, count: 1 },
        { name: 'GitHub', ok: false, count: 0 },
      ],
    });
  });

  it('全部检索路失败按失败收口：保持未知，不写来源也不写负事实', async () => {
    const reach = twoPathReach({
      exaSearch: async () => {
        throw new Error('mcporter 退出 1');
      },
      githubSearch: async () => {
        throw new Error('GitHub 匿名额度用尽（HTTP 403）');
      },
    });
    const result = await runResearchTask(baseState(), 'org-1', '快搜', {
      reach,
      now: fixedNow,
      queryFor: () => '验收组织',
    });
    expect(result.task.status).toBe('已停止');
    expect(result.task.stopReason).toBe('失败');
    expect(result.sources).toEqual([]);
    const failures = result.audits.filter((audit) => audit.kind === '搜索失败');
    expect(failures.map((audit) => (audit.payload as { path: string }).path)).toEqual([
      'Exa',
      'GitHub',
    ]);
    expect(JSON.stringify(result.audits)).not.toMatch(/没有这家公司/);
  });

  it('searches 按路计且失败路也计：一次双路扇出计 2', async () => {
    const reach = twoPathReach({
      // 13 条唯一命中：把快搜 opens=12 打满，触顶行的 searches 字段暴露按路计数。
      exaSearch: async () =>
        Array.from({ length: 13 }, (_, i) => ({
          title: `H${i}`,
          url: `https://h${i}.example/doc`,
          snippet: 'ok',
        })),
      githubSearch: async () => {
        throw new Error('GitHub 匿名额度用尽（HTTP 403）');
      },
    });
    const result = await runResearchTask(baseState(), 'org-1', '快搜', {
      reach,
      now: fixedNow,
      queryFor: () => '验收组织',
    });
    expect(result.task.stopReason).toBe('触顶');
    const capAudit = result.audits.find((audit) => audit.kind === '触顶');
    expect(capAudit?.payload).toMatchObject({ searches: 2, opens: 12 });
  });

  it('体检红路静默跳过：只扇出绿路，红路不参与搜索与预算', async () => {
    const githubSearch = vi.fn(async (): Promise<SearchHit[]> => [
      { title: '丙', url: 'https://c.example/doc', snippet: 'ok' },
    ]);
    const reach = twoPathReach({
      exaSearch: async () => [{ title: '甲', url: 'https://a.example/doc', snippet: 'ok' }],
      githubSearch: async () => githubSearch(),
      githubDoctorOk: false,
    });
    const result = await runResearchTask(baseState(), 'org-1', '快搜', {
      reach,
      now: fixedNow,
      queryFor: () => '验收组织',
    });
    expect(githubSearch).not.toHaveBeenCalled();
    const searchAudit = result.audits.find((audit) => audit.kind === '搜索');
    expect(searchAudit?.payload).toMatchObject({ paths: [{ name: 'Exa' }] });
    expect(result.sources.map((source) => source.origin?.locator)).toEqual([
      'https://a.example/doc',
    ]);
  });

  it('体检结论与路清单对不上时失败收口，不静默空跑', async () => {
    const reach: ReachAdapter = {
      paths: [
        {
          name: 'Exa',
          doctorCheck: async () => ({ ok: true, detail: 'ok' }),
          search: async () => {
            throw new Error('不应扇出：体检没点名这条路');
          },
        },
      ],
      doctor: async () => ({ ok: true, detail: '体检没给任何路', paths: [] }),
      open: async (url) => ({ url, ok: false, body: '', error: '不应打开' }),
    };
    const result = await runResearchTask(baseState(), 'org-1', '快搜', {
      reach,
      now: fixedNow,
      queryFor: () => '验收组织',
    });
    expect(result.task.status).toBe('已停止');
    expect(result.task.stopReason).toBe('失败');
    expect(result.sources).toEqual([]);
  });
});

describe('挂死兜底（审计 D1）', () => {
  /** 真实 setTimeout 计时；墙钟档经 e2e 环境变量压小（与 fee-cap 压 tokens 同一注入家族）。 */
  function withSmallWall<T>(ms: number, run: () => Promise<T>): Promise<T> {
    const prev = process.env.STAFFDESK_E2E_WALL_MS;
    process.env.STAFFDESK_E2E_WALL_MS = String(ms);
    return run().finally(() => {
      if (prev === undefined) delete process.env.STAFFDESK_E2E_WALL_MS;
      else process.env.STAFFDESK_E2E_WALL_MS = prev;
    });
  }

  it('预算墙钟档可被环境变量压小，非正数忽略', () => {
    const prev = process.env.STAFFDESK_E2E_WALL_MS;
    process.env.STAFFDESK_E2E_WALL_MS = '100';
    try {
      expect(budgetFor('快搜').wallMs).toBe(100);
      process.env.STAFFDESK_E2E_WALL_MS = '0';
      expect(budgetFor('快搜').wallMs).toBe(BUDGETS['快搜'].wallMs);
    } finally {
      if (prev === undefined) delete process.env.STAFFDESK_E2E_WALL_MS;
      else process.env.STAFFDESK_E2E_WALL_MS = prev;
    }
  });

  it('搜索扇出挂死时按墙钟折搜索超时，任务失败收口不卡「进行中」', async () => {
    const reach = onePathReach({
      search: () => new Promise<SearchHit[]>(() => {}),
      open: async (url) => ({ url, ok: true, body: '不应打开' }),
    });
    const result = await withSmallWall(100, () =>
      runResearchTask(baseState(), 'org-1', '快搜', {
        reach,
        queryFor: () => '验收组织',
      }),
    );
    expect(result.task.status).toBe('已停止');
    expect(result.task.stopReason).toBe('失败');
    expect(JSON.stringify(result.audits)).toMatch(/搜索超时/);
    expect(result.sources).toEqual([]);
  });

  it('单次打开挂死时按墙钟折打开超时进失败 URL，任务按触顶收口不卡「进行中」', async () => {
    const reach = onePathReach({
      search: async () => [
        { title: '挂死页', url: 'https://a.example/hang', snippet: 'ok' },
        { title: '正常页', url: 'https://b.example/ok', snippet: 'ok' },
      ],
      open: (url) =>
        url.includes('hang')
          ? new Promise<OpenResult>(() => {})
          : Promise.resolve({ url, ok: true, body: '正文' }),
    });
    const result = await withSmallWall(100, () =>
      runResearchTask(baseState(), 'org-1', '快搜', {
        reach,
        queryFor: () => '验收组织',
      }),
    );
    expect(result.task.status).not.toBe('进行中');
    expect(result.task.stopReason).toBe('触顶');
    expect(result.failedUrls.some((url) => url.includes('hang'))).toBe(true);
    expect(JSON.stringify(result.audits)).toMatch(/打开超时/);
  });
});
