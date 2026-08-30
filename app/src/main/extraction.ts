import type { Action } from '@shared/actions';
import type { State } from '@shared/types';
import type { Brain } from './brain';
import { activeModelCompletion } from './llm/runtime';
import { runExtractLoop } from './loops/extract';
import { safeDetail } from './redact';

type ExtractionRunner = typeof runExtractLoop;
type ExtractionBrain = Pick<Brain, 'snapshot' | 'dispatch' | 'recoverExtractionFailure'>;

/**
 * One deep seam for every extraction entry point. It owns snapshotting, model
 * selection, orchestration, terminal dispatch and publication, so callers cannot
 * accidentally leave a started job in the running state.
 */
export function createExtractionJobExecutor(args: {
  brain: ExtractionBrain;
  publish: (state: State) => void;
  extract?: ExtractionRunner;
}): (sourceId: string) => Promise<State> {
  const extract = args.extract ?? runExtractLoop;

  return async (sourceId: string): Promise<State> => {
    let terminalDispatched = false;
    try {
      const state = args.brain.snapshot();
      const source = state.sources.find((item) => item.id === sourceId);
      const action: Action =
        !source || source.boundObjectIds.length === 0
          ? { type: 'EXTRACT_DONE', sourceId, claims: [], outcome: 'success' }
          : await extractionAction(sourceId, state, extract);
      const next = args.brain.dispatch(action);
      terminalDispatched = true;
      args.publish(next);
      return next;
    } catch (error) {
      const detail = `抽取编排失败：${safeDetail(error)}`;

      // The ledger may already contain a terminal result when publication throws.
      // Do not append a second result card; only correct the ephemeral job status.
      if (terminalDispatched) {
        return recoverFailedJob(args.brain, args.publish, sourceId, detail);
      }

      try {
        const failed = args.brain.dispatch({
          type: 'EXTRACT_DONE',
          sourceId,
          outcome: 'failed',
          detail,
        });
        tryPublish(args.publish, failed);
        return failed;
      } catch (settleError) {
        return recoverFailedJob(
          args.brain,
          args.publish,
          sourceId,
          `${detail}；终态落库失败：${safeDetail(settleError)}`,
        );
      }
    }
  };
}

async function extractionAction(
  sourceId: string,
  state: State,
  extract: ExtractionRunner,
): Promise<Action> {
  const source = state.sources.find((item) => item.id === sourceId);
  if (!source) return { type: 'EXTRACT_DONE', sourceId, claims: [], outcome: 'success' };
  const result = await extract({
    source,
    objects: state.objects,
    slotDefs: state.slotDefs,
    existing: state.claims,
    complete: activeModelCompletion(state),
  });
  if (result.status !== 'success') {
    return {
      type: 'EXTRACT_DONE',
      sourceId,
      outcome: result.status,
      detail: result.detail,
      draftCount: result.draftCount,
      rejectedCount: result.rejectedCount,
    };
  }
  return {
    type: 'EXTRACT_DONE',
    sourceId,
    claims: result.claims,
    outcome: result.status,
    detail: result.detail,
    draftCount: result.draftCount,
    rejectedCount: result.rejectedCount,
  };
}

function recoverFailedJob(
  brain: ExtractionBrain,
  publish: (state: State) => void,
  sourceId: string,
  detail: string,
): State {
  const failed = brain.recoverExtractionFailure(sourceId, detail);
  tryPublish(publish, failed);
  return failed;
}

function tryPublish(publish: (state: State) => void, state: State): void {
  try {
    publish(state);
  } catch {
    // The job is already terminal in the main process. A later snapshot/state
    // change lets the renderer recover even if this particular send failed.
  }
}
