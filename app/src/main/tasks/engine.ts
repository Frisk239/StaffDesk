import { createHash } from 'node:crypto';
import { emptyFeeSpend, type TaskFeeSpend } from '@shared/taskFee';
import type { BudgetGear, DeskTask, Source, State, TaskKind, TaskStopReason } from '@shared/types';
import type { OpenResult, ReachAdapter, ReachPath, SearchHit } from '../adapters/reach';

export type { BudgetGear };

export interface Budget {
  gear: BudgetGear;
  searches: number;
  opens: number;
  steps: number;
  wallMs: number;
  tokens: number;
  missingUsageCalls: number;
}

/**
 * ADR 0059：硬顶只留可执法维度（searches / opens / steps / wallMs / tokens）。
 * hops 已删——引擎 opens 只开搜索命中页，没有跳链，声明未执法属谎言口径。
 *
 * tokens：按每页单片段抽取估系统+原文 8–10k prompt + ~1k completion。
 * 快搜打开上限 12 → ~108k，取 120_000 留一轮余量，顶不住二次深抽。
 * 深挖打开上限 30、允许长页切块，约 3× 快搜，与搜索/打开/墙钟档位倍率同量级 → 400_000。
 *
 * missingUsageCalls：端点不回传 usage 时的独立小上限，按档位搜索次数对齐，
 * 缺失不得当 0 token 继续烧。
 */
export const BUDGETS: Record<BudgetGear, Budget> = {
  快搜: {
    gear: '快搜',
    searches: 8,
    opens: 12,
    steps: 16,
    wallMs: 3 * 60_000,
    tokens: 120_000,
    missingUsageCalls: 8,
  },
  深挖: {
    gear: '深挖',
    searches: 20,
    opens: 30,
    steps: 40,
    wallMs: 15 * 60_000,
    tokens: 400_000,
    missingUsageCalls: 20,
  },
};

/** e2e 可经 STAFFDESK_E2E_TOKEN_BUDGET / STAFFDESK_E2E_WALL_MS 压 tokens / 墙钟档；非正数忽略。 */
export function budgetFor(gear: BudgetGear): Budget {
  const base = BUDGETS[gear];
  let next = base;
  const tokenRaw = process.env.STAFFDESK_E2E_TOKEN_BUDGET;
  if (tokenRaw) {
    const n = Number(tokenRaw);
    if (Number.isFinite(n) && n > 0) next = { ...next, tokens: Math.floor(n) };
  }
  // 审计 D1：小墙钟档配合挂起注入，断言任务限时收口不卡「进行中」。
  const wallRaw = process.env.STAFFDESK_E2E_WALL_MS;
  if (wallRaw) {
    const n = Number(wallRaw);
    if (Number.isFinite(n) && n > 0) next = { ...next, wallMs: Math.floor(n) };
  }
  return next;
}

/** ADR 0059：只判费用维——抽取阶段发生在搜索/打开计数停止增长之后，别拿零填充别的维度。 */
export function hitFeeCap(budget: Budget, spend: TaskFeeSpend): boolean {
  return spend.totalTokens >= budget.tokens || spend.missingUsageCalls >= budget.missingUsageCalls;
}

/** ADR 0059：费用维先于搜索/打开/步数/墙钟，避免混成普通「触顶」。 */
export function capHit(args: {
  budget: Budget;
  searches: number;
  opens: number;
  steps: number;
  elapsedMs: number;
  spend: TaskFeeSpend;
}): TaskStopReason | undefined {
  if (hitFeeCap(args.budget, args.spend)) {
    return '费用触顶';
  }
  if (
    args.searches >= args.budget.searches ||
    args.opens >= args.budget.opens ||
    args.steps >= args.budget.steps ||
    args.elapsedMs >= args.budget.wallMs
  ) {
    return '触顶';
  }
  return undefined;
}

export interface TaskAuditRow {
  taskId: string;
  seq: number;
  kind: string;
  payload: unknown;
  ts: string;
}

export interface ResearchResult {
  task: DeskTask;
  audits: TaskAuditRow[];
  sources: Source[];
  opened: { url: string; body: string }[];
  failedUrls: string[];
  stopReason?: TaskStopReason | undefined;
}

export interface ResearchDeps {
  reach: ReachAdapter;
  now?: () => number;
  queryFor: (state: State, objectId: string) => string;
  onAudit?: ((audit: TaskAuditRow) => void) | undefined;
  shouldStop?: (() => boolean) | undefined;
  /** 任务内 LLM usage 累计；缺省空花费。抽取路径与单测注入共用。 */
  usageSpend?: (() => TaskFeeSpend) | undefined;
}

export interface ResearchRunOptions {
  kind?: Extract<TaskKind, '调研' | '再搜一轮'> | undefined;
  query?: string | undefined;
  parentTaskId?: string | undefined;
  dueAt?: string | undefined;
  late?: boolean | undefined;
  missedRuns?: number | undefined;
  task?: DeskTask | undefined;
}

export function createResearchTask(
  state: State,
  objectId: string,
  gear: BudgetGear,
  deps: ResearchDeps,
  options: ResearchRunOptions = {},
): DeskTask {
  const obj = state.objects.find((o) => o.id === objectId);
  const started = deps.now?.() ?? Date.now();
  const createdAt = new Date(started).toISOString().replace('T', ' ').slice(0, 16);
  const task: DeskTask = {
    id: `task-${state.seq}-${started}`,
    objectId,
    kind: options.kind ?? '调研',
    status: '进行中',
    createdAt,
    budgetGear: gear,
  };
  const query =
    options.query?.trim() || deps.queryFor(state, objectId) || `${obj?.name ?? ''} 官方`;
  task.query = query;
  if (options.parentTaskId) task.parentTaskId = options.parentTaskId;
  if (options.dueAt) task.dueAt = options.dueAt;
  return task;
}

/** 调研循环：顶过程不顶写入条数。触顶后已打开的照写，失败 URL 记审计。不编负事实。 */
export async function runResearchTask(
  state: State,
  objectId: string,
  gear: BudgetGear,
  deps: ResearchDeps,
  options: ResearchRunOptions = {},
): Promise<ResearchResult> {
  const obj = state.objects.find((o) => o.id === objectId);
  const budget = budgetFor(gear);
  const started = deps.now?.() ?? Date.now();
  const task = runningTask(
    options.task ?? createResearchTask(state, objectId, gear, deps, options),
  );
  const query = task.query?.trim() || deps.queryFor(state, objectId) || `${obj?.name ?? ''} 官方`;
  task.query = query;
  const audits: TaskAuditRow[] = [];
  const opened: { url: string; body: string }[] = [];
  const failedUrls: string[] = [];
  const sources: Source[] = [];
  let seq = 0;
  let searches = 0;
  let opens = 0;
  let steps = 0;
  let stopReason: TaskStopReason | undefined;

  const log = (kind: string, payload: unknown) => {
    seq += 1;
    const audit = {
      taskId: task.id,
      seq,
      kind,
      payload,
      ts: new Date().toISOString(),
    };
    audits.push(audit);
    deps.onAudit?.(audit);
  };

  const finish = (
    reason: TaskStopReason | undefined,
    forcedStatus?: DeskTask['status'] | undefined,
    detail?: Record<string, unknown> | undefined,
  ): ResearchResult => {
    stopReason = reason;
    task.status =
      forcedStatus ??
      (reason === '手动' || (reason === '失败' && opened.length === 0) ? '已停止' : '已完成');
    if (reason) task.stopReason = reason;
    log('停止', {
      reason: reason ?? '完成',
      opened: opened.length,
      failed: failedUrls.length,
      ...(detail ?? {}),
    });
    return { task, audits, sources, opened, failedUrls, stopReason };
  };

  const manualStop = () => deps.shouldStop?.() ?? false;
  const finishIfManuallyStopped = () => {
    if (!manualStop()) return null;
    return finish('手动', '已停止');
  };

  log('开始', {
    kind: task.kind,
    query: task.query,
    budgetGear: task.budgetGear,
    parentTaskId: task.parentTaskId,
    dueAt: task.dueAt,
  });

  if ((options.missedRuns ?? 0) > 0) {
    log('未跑', {
      parentTaskId: options.parentTaskId,
      dueAt: options.dueAt,
      missedRuns: options.missedRuns,
      note: '彻底退出期间跳过的周期不假装跑过',
    });
  }

  if (options.late || options.missedRuns) {
    log('迟跑', {
      parentTaskId: options.parentTaskId,
      dueAt: options.dueAt,
      missedRuns: options.missedRuns ?? 0,
      note: '迟跑：只补最新一次，中间周期记未跑',
    });
  }

  const stoppedBeforeDoctor = finishIfManuallyStopped();
  if (stoppedBeforeDoctor) return stoppedBeforeDoctor;

  const currentCap = (): TaskStopReason | undefined =>
    capHit({
      budget,
      searches,
      opens,
      steps,
      elapsedMs: (deps.now?.() ?? Date.now()) - started,
      spend: deps.usageSpend?.() ?? emptyFeeSpend(),
    });

  // 审计 D1：capHit 只在步间判，搜索扇出或单次打开挂死时步间永远走不到——
  // 两处等待都以「墙钟剩余」作上限，到点折失败，任务按触顶收口，不卡「进行中」。
  // 真实适配器的 fetch 另有自身 25s/20s 超时（reach.ts），这里是引擎侧兜底（罐头注入也走它）。
  const wallRemainingMs = (): number =>
    Math.max(0, budget.wallMs - ((deps.now?.() ?? Date.now()) - started));

  const logCap = (reason: TaskStopReason) => {
    const spend = deps.usageSpend?.() ?? emptyFeeSpend();
    log(reason, {
      searches,
      opens,
      steps,
      tokens: spend.totalTokens,
      missingUsageCalls: spend.missingUsageCalls,
    });
  };

  const doctor = await deps.reach.doctor();
  log('体检', doctor);
  const stoppedAfterDoctor = finishIfManuallyStopped();
  if (stoppedAfterDoctor) return stoppedAfterDoctor;
  if (!doctor.ok) {
    return finish('失败', '已停止', {
      detail: doctor.detail,
      hint: doctor.hint,
    });
  }
  // 0061：只扇出体检通过的路；红路静默跳过（体检行已逐路标注）。
  const greenNames = new Set(doctor.paths.filter((p) => p.ok).map((p) => p.name));
  const activePaths: ReachPath[] = deps.reach.paths.filter((p) => greenNames.has(p.name));
  if (activePaths.length === 0) {
    // 体检结论与路清单对不上属适配缺陷：宁可失败收口，不静默空跑（0008：不编造）。
    return finish('失败', '已停止', { detail: '没有体检通过的检索路' });
  }

  steps += 1;
  // 0061：searches 按路计，失败路也计——防坏路反复重试烧墙钟；费用触顶口径不变（0059）。
  searches += activePaths.length;
  log('搜索', { query, paths: activePaths.map((p) => ({ name: p.name })) });
  const stoppedBeforeSearch = finishIfManuallyStopped();
  if (stoppedBeforeSearch) return stoppedBeforeSearch;

  // 0061：并行扇出（async 包装把同步抛错也折成 rejected）；单路失败只记审计、不挡其余路。
  // 审计 D1：扇出等待受墙钟剩余约束——挂死的路在墙钟内折「搜索超时」，不让 allSettled 永久悬挂。
  const wallMs = wallRemainingMs();
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const settledOrDeadline = await Promise.race([
    Promise.allSettled(activePaths.map(async (path) => path.search(query))),
    new Promise<null>((resolve) => {
      deadlineTimer = setTimeout(() => resolve(null), wallMs);
    }),
  ]);
  // race 落定即清孤儿定时器——不清会挂满一个墙钟档（评审 M32，有界但没理由留着）。
  if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
  const settled =
    settledOrDeadline ??
    activePaths.map(() => ({
      status: 'rejected' as const,
      reason: new Error(`搜索超时（墙钟剩余 ${Math.round(wallMs / 1000)} 秒内未返回）`),
    }));
  const perPath: PathHits[] = [];
  const pathOutcomes: Array<{ name: string; ok: boolean; count: number; error?: string }> = [];
  const failedPaths: Array<{ name: string; error: string; hint?: string | undefined }> = [];
  activePaths.forEach((path, index) => {
    const result = settled[index];
    if (result?.status === 'fulfilled') {
      perPath.push({ name: path.name, hits: result.value });
      pathOutcomes.push({ name: path.name, ok: true, count: result.value.length });
      return;
    }
    const reason: unknown = result?.status === 'rejected' ? result.reason : undefined;
    const error = reason instanceof Error ? reason.message : String(reason ?? '未知失败');
    const hint =
      typeof reason === 'object' && reason && 'hint' in reason
        ? (reason as { hint?: string }).hint
        : undefined;
    failedPaths.push({ name: path.name, error, hint });
    pathOutcomes.push({ name: path.name, ok: false, count: 0, error });
  });
  for (const failure of failedPaths) {
    log('搜索失败', {
      path: failure.name,
      query,
      error: failure.error,
      hint: failure.hint,
    });
  }
  const { hits, duplicates } = mergeSearchHits(perPath);
  log('搜索结果', {
    query,
    count: hits.length,
    duplicates,
    paths: pathOutcomes,
    hits: hits.slice(0, 8).map((hit) => ({
      title: hit.title,
      url: hit.url,
      snippet: hit.snippet.slice(0, 240),
    })),
  });
  if (perPath.length > 0 && hits.length === 0) {
    log('空结果', { query, note: '没有写入来源，也不写负事实' });
  }
  // 0008：全路失败才按失败收口（失败表现为未知）；有路活着就照常打开入库。
  if (failedPaths.length === activePaths.length) stopReason = '失败';

  const stoppedAfterSearch = finishIfManuallyStopped();
  if (stoppedAfterSearch) return stoppedAfterSearch;

  for (const hit of hits) {
    const stoppedBeforeOpen = finishIfManuallyStopped();
    if (stoppedBeforeOpen) return stoppedBeforeOpen;
    const openedCap = currentCap();
    if (openedCap) {
      stopReason = openedCap;
      logCap(openedCap);
      break;
    }
    steps += 1;
    opens += 1;
    log('打开尝试', { url: hit.url, title: hit.title });
    // 审计 D1：单次打开的等待受墙钟剩余约束——挂死的适配器到点折「打开超时」，记失败 URL 继续。
    const page = await safeOpen(deps.reach, hit.url, wallRemainingMs());
    if (!page.ok) {
      failedUrls.push(hit.url);
      log('打开失败', { url: hit.url, error: page.error ?? '打开失败' });
      const stoppedAfterFailedOpen = finishIfManuallyStopped();
      if (stoppedAfterFailedOpen) return stoppedAfterFailedOpen;
      continue;
    }
    opened.push({ url: hit.url, body: page.body });
    log('打开', {
      url: hit.url,
      finalUrl: page.finalUrl ?? page.url,
      title: page.title ?? hit.title,
      chars: page.body.length,
    });
    sources.push(sourceFromPage(task, objectId, hit, page, obj?.workspaceId, opens));
    const stoppedAfterOpen = finishIfManuallyStopped();
    if (stoppedAfterOpen) return stoppedAfterOpen;
  }

  if (!stopReason) {
    const endCap = currentCap();
    if (endCap) {
      stopReason = endCap;
      logCap(endCap);
    }
  }
  const stoppedBeforeFinish = finishIfManuallyStopped();
  if (stoppedBeforeFinish) return stoppedBeforeFinish;
  return finish(stopReason);
}

function runningTask(task: DeskTask): DeskTask {
  const next: DeskTask = { ...task, status: '进行中' };
  delete next.stopReason;
  return next;
}

async function safeOpen(reach: ReachAdapter, url: string, waitMs: number): Promise<OpenResult> {
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    const opened = await Promise.race([
      reach.open(url),
      new Promise<OpenResult>((resolve) => {
        deadlineTimer = setTimeout(
          () =>
            resolve({
              url,
              ok: false,
              body: '',
              error: `打开超时（墙钟剩余 ${Math.round(waitMs / 1000)} 秒内未返回）`,
            }),
          waitMs,
        );
      }),
    ]);
    // race 落定即清孤儿定时器（评审 M32）；正常打开远快于墙钟，不会先到。
    if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
    return opened;
  } catch (err) {
    if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
    return {
      url,
      ok: false,
      body: '',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export interface PathHits {
  name: string;
  hits: SearchHit[];
}

/**
 * ADR 0061：多路命中按 URL 去重合并——同 URL 留先到（路序即优先序，扇出顺序稳定）。
 * 纯函数供单测；检索命中不等于来源（0008），合并条数与写入条数无关。
 */
export function mergeSearchHits(perPath: readonly PathHits[]): {
  hits: SearchHit[];
  duplicates: number;
} {
  const seen = new Set<string>();
  const hits: SearchHit[] = [];
  let duplicates = 0;
  for (const { hits: pathHits } of perPath) {
    for (const hit of pathHits) {
      if (seen.has(hit.url)) {
        duplicates += 1;
        continue;
      }
      seen.add(hit.url);
      hits.push(hit);
    }
  }
  return { hits, duplicates };
}

function sourceFromPage(
  task: DeskTask,
  objectId: string,
  hit: SearchHit,
  page: OpenResult,
  workspaceId: string | undefined,
  index: number,
): Source {
  const body = page.body.trim();
  const fetchedAt = new Date().toISOString();
  const contentHash = createHash('sha256').update(body).digest('hex');
  const title = page.title || hit.title || page.finalUrl || hit.url;
  const source: Source = {
    id: `src-res-${task.id}-${index}`,
    title,
    body,
    path: '调研',
    boundObjectIds: [objectId],
    origin: {
      kind: 'research',
      taskId: task.id,
      locator: hit.url,
      finalUrl: page.finalUrl ?? page.url,
      contentHash,
      fetchedAt,
    },
    segments: [{ id: 'body', start: 0, end: body.length, label: title }],
    contentHash,
    fetchedAt,
  };
  if (workspaceId) source.workspaceId = workspaceId;
  return source;
}

export function defaultQuery(state: State, objectId: string): string {
  const obj = state.objects.find((o) => o.id === objectId);
  return obj ? `${obj.name} 官方 介绍` : '';
}
