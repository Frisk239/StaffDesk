import type { Claim, DeskTask, Source, State, WriteProposal } from './types';

export function sourceResearchTaskId(
  source: Pick<Source, 'id' | 'origin' | 'path'>,
): string | null {
  const originTaskId = source.origin?.taskId?.trim();
  if (source.origin?.kind === 'research' && originTaskId) return originTaskId;
  if (source.origin?.kind !== 'research' && source.path !== '调研') return null;
  const match = source.id.match(/^src-res-(.+)-\d+$/);
  return match?.[1] ?? null;
}

export function researchSourcesForTask(state: Pick<State, 'sources'>, taskId: string): Source[] {
  return state.sources.filter((source) => sourceResearchTaskId(source) === taskId);
}

export function unverifiedClaimIdsForTask(
  state: Pick<State, 'claims' | 'sources' | 'tasks'>,
  taskId: string,
): string[] {
  const task = state.tasks.find((item) => item.id === taskId);
  if (!task) return [];
  const sourceIds = new Set(researchSourcesForTask(state, taskId).map((source) => source.id));
  return state.claims
    .filter(
      (claim) =>
        claim.objectId === task.objectId &&
        claim.status === '成立' &&
        claim.unverified &&
        sourceIds.has(claim.sourceId),
    )
    .map((claim) => claim.id);
}

export function taskClaimReviewReady(
  state: Pick<State, 'extractJobs' | 'sources' | 'tasks'>,
  taskId: string,
): boolean {
  const task = state.tasks.find((item) => item.id === taskId);
  if (!task || !isEndedResearchRun(task)) return false;
  const sources = researchSourcesForTask(state, taskId);
  if (sources.length === 0) return false;
  return sources.every((source) => {
    const job = state.extractJobs.find((item) => item.sourceId === source.id);
    return Boolean(job && job.status !== '抽取中');
  });
}

export function pendingTaskClaimReview(
  state: Pick<State, 'writeQueue'>,
  taskId: string,
): WriteProposal | undefined {
  return state.writeQueue.find((write) => write.kind === '批量晋升' && write.taskId === taskId);
}

export function taskClaimReviewSummary(state: Pick<State, 'claims'>, claimIds: string[]): string {
  return claimIds
    .map((id) => {
      const claim = state.claims.find((item) => item.id === id);
      return claim ? `· ${claim.text}` : `· ${id}`;
    })
    .join('\n');
}

function isEndedResearchRun(task: DeskTask): boolean {
  return (
    (task.kind === '调研' || task.kind === '再搜一轮') &&
    (task.status === '已完成' || task.status === '已停止')
  );
}

export function claimsByIds(state: Pick<State, 'claims'>, claimIds: string[]): Claim[] {
  const ids = new Set(claimIds);
  return state.claims.filter((claim) => ids.has(claim.id));
}
