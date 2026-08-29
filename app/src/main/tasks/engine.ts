import type { DeskTask, Source, State, TaskStopReason } from '@shared/types';
import type { ReachAdapter, SearchHit } from '../adapters/reach';

export type BudgetGear = '快搜' | '深挖';

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

/** 调研循环：顶过程不顶写入条数。触顶后已打开的照写，失败 URL 记审计。不编负事实。 */
export async function runResearchTask(
  state: State,
  objectId: string,
  gear: BudgetGear,
  deps: ResearchDeps,
): Promise<ResearchResult> {
  const obj = state.objects.find((o) => o.id === objectId);
  const budget = BUDGETS[gear];
  const started = deps.now?.() ?? Date.now();
  const createdAt = new Date(started).toISOString().replace('T', ' ').slice(0, 16);
  const task: DeskTask = {
    id: `task-${started}`,
    objectId,
    kind: '调研',
    status: '进行中',
    createdAt,
    budgetGear: gear,
  };
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

  const hitCap = () => {
    const elapsed = (deps.now?.() ?? Date.now()) - started;
    return searches >= budget.searches || opens >= budget.opens || steps >= budget.steps || elapsed >= budget.wallMs;
  };

  const query = deps.queryFor(state, objectId) || `${obj?.name ?? ''} 官方`;
  steps += 1;
  searches += 1;
  log('搜索', { query, platform: 'exa' });
  let hits: SearchHit[] = [];
  try {
    hits = await deps.reach.search(query);
    log('搜索结果', { count: hits.length });
  } catch (err) {
    log('失败', { query, error: err instanceof Error ? err.message : String(err) });
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
    const page = await deps.reach.open(hit.url);
    if (!page.ok) {
      failedUrls.push(hit.url);
      log('失败', { url: hit.url, error: page.error });
      continue;
    }
    opened.push({ url: hit.url, body: page.body });
    log('打开', { url: hit.url, title: hit.title });
    const src: Source = {
      id: `src-res-${task.id}-${opens}`,
      title: hit.title || hit.url,
      body: page.body,
      path: '调研',
      boundObjectIds: [objectId],
    };
    if (obj?.workspaceId) src.workspaceId = obj.workspaceId;
    sources.push(src);
  }

  if (!stopReason) {
    if (hitCap()) {
      stopReason = '触顶';
      log('触顶', { searches, opens, steps });
    }
  }
  task.status = stopReason === '失败' && opened.length === 0 ? '已停止' : '已完成';
  if (stopReason) task.stopReason = stopReason;
  log('停止', { reason: stopReason ?? '完成', opened: opened.length, failed: failedUrls.length });
  return { task, audits, sources, opened, failedUrls, stopReason };
}

export function defaultQuery(state: State, objectId: string): string {
  const obj = state.objects.find((o) => o.id === objectId);
  return obj ? `${obj.name} 官方 介绍` : '';
}
