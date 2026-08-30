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
}

export interface ResearchRunOptions {
  kind?: Extract<TaskKind, '调研' | '再搜一轮'> | undefined;
  query?: string | undefined;
  parentTaskId?: string | undefined;
  dueAt?: string | undefined;
  late?: boolean | undefined;
  missedRuns?: number | undefined;
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
  const createdAt = new Date(started).toISOString().replace('T', ' ').slice(0, 16);
  const task: DeskTask = {
    id: `task-${started}`,
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
    audits.push({
      taskId: task.id,
      seq,
      kind,
      payload,
      ts: new Date().toISOString(),
    });
  };

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
  if (!doctor.ok) {
    stopReason = '失败';
    task.status = '已停止';
    task.stopReason = stopReason;
    log('停止', {
      reason: stopReason,
      detail: doctor.detail,
      hint: doctor.hint,
      opened: 0,
      failed: 0,
    });
    return { task, audits, sources, opened, failedUrls, stopReason };
  }

  steps += 1;
  searches += 1;
  log('搜索', { query, platform: 'Agent Reach' });
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

  for (const hit of hits) {
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
  }

  if (!stopReason && hitCap()) {
    stopReason = '触顶';
    log('触顶', { searches, opens, steps });
  }
  task.status = stopReason === '失败' && opened.length === 0 ? '已停止' : '已完成';
  if (stopReason) task.stopReason = stopReason;
  log('停止', { reason: stopReason ?? '完成', opened: opened.length, failed: failedUrls.length });
  return { task, audits, sources, opened, failedUrls, stopReason };
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
