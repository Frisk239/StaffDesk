import type { Brain } from '../../src/main/brain';
import { draftsToClaims, type ExtractDraft } from '../../src/main/loops/extract';

/** Complete a binding with explicit test-generated extraction output. */
export function completeExtraction(brain: Brain, sourceId: string, drafts: ExtractDraft[]) {
  const state = brain.snapshot();
  const source = state.sources.find((item) => item.id === sourceId);
  if (!source) throw new Error(`Test source not found: ${sourceId}`);
  const claims = draftsToClaims({
    drafts,
    source,
    objects: state.objects,
    slotDefs: state.slotDefs,
    existing: state.claims,
    now: '2026-08-29T00:00:00.000Z',
  });
  brain.dispatch({ type: 'EXTRACT_DONE', sourceId, claims });
  return claims;
}
