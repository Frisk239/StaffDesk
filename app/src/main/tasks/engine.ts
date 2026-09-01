import { createHash } from 'node:crypto';
import { emptyFeeSpend, type TaskFeeSpend } from '@shared/taskFee';
import type { BudgetGear, DeskTask, Source, State, TaskKind, TaskStopReason } from '@shared/types';
import type { OpenResult, ReachAdapter, SearchHit } from '../adapters/reach';

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

/** e2e 可经 STAFFDESK_E2E_TOKEN_BUDGET 压 tokens 顶；非正数忽略。 */
export function budgetFor(gear: BudgetGear): Budget {
  const base = BUDGETS[gear];
  const raw = process.env.STAFFDESK_E2E_TOKEN_BUDGET;
  if (!raw) return base;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return base;
  return { ...base, tokens: Math.floor(n) };
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

  steps += 1;
  searches += 1;
  log('搜索', { query, platform: 'Agent Reach' });
  const stoppedBeforeSearch = finishIfManuallyStopped();
  if (stoppedBeforeSearch) return stoppedBeforeSearch;
  let hits: SearchHit[] = [];
  try {
    hits = await deps.reach.search(query);
    log('搜索结果', {
      query,
      count: hits.length,
      hits: hits.slice(0, 8).map((hit) => ({
        title: hit.title,
        url: hit.url,
        snippet: hit.snippet.slice(0, 240),
      })),
    });
    if (hits.length === 0) log('空结果', { query, note: '没有写入来源，也不写负事实' });
  } catch (err) {
    log('搜索失败', {
      query,
      error: err instanceof Error ? err.message : String(err),
      hint:
        typeof err === 'object' && err && 'hint' in err
          ? (err as { hint?: string }).hint
          : undefined,
    });
    stopReason = '失败';
  }

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
    const page = await safeOpen(deps.reach, hit.url);
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

async function safeOpen(reach: ReachAdapter, url: string): Promise<OpenResult> {
  try {
    return await reach.open(url);
  } catch (err) {
    return {
      url,
      ok: false,
      body: '',
      error: err instanceof Error ? err.message : String(err),
    };
  }
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
