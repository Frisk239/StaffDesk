import { createHash } from 'node:crypto';
import type { BudgetGear, DeskTask, Source, State, TaskKind, TaskStopReason } from '@shared/types';
import type { OpenResult, ReachAdapter, SearchHit } from '../adapters/reach';

export type { BudgetGear };

export interface Budget {
  gear: BudgetGear;
  searches: number;
  opens: number;
  hops: number;
  steps: number;
  wallMs: number;
}

export const BUDGETS: Record<BudgetGear, Budget> = {
  快搜: { gear: '快搜', searches: 8, opens: 12, hops: 1, steps: 16, wallMs: 3 * 60_000 },
  深挖: { gear: '深挖', searches: 20, opens: 30, hops: 2, steps: 40, wallMs: 15 * 60_000 },
};

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
  const budget = BUDGETS[gear];
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

  const hitCap = () => {
    const elapsed = (deps.now?.() ?? Date.now()) - started;
    return (
      searches >= budget.searches ||
      opens >= budget.opens ||
      steps >= budget.steps ||
      elapsed >= budget.wallMs
    );
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
    if (hitCap()) {
      stopReason = '触顶';
      log('触顶', { searches, opens, steps });
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

  if (!stopReason && hitCap()) {
    stopReason = '触顶';
    log('触顶', { searches, opens, steps });
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
