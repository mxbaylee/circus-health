import {
  collectionClinicalProjectionContextAsync,
  type CollectionClinicalReviewResult,
} from './intake-review-collection-session.ts';

type ReadyReview = Extract<CollectionClinicalReviewResult, { status: 'ready' }>;
declare const preparationBrand: unique symbol;
export interface CorrectionSupportReviewPreparation {
  readonly [preparationBrand]: true;
}
export type CorrectionSupportReviewPreparationResult =
  | Exclude<CollectionClinicalReviewResult, ReadyReview>
  | { status: 'prepared'; preparation: CorrectionSupportReviewPreparation };
const preparations = new WeakMap<
  CorrectionSupportReviewPreparation,
  { session: ReadyReview['session']; signal?: AbortSignal; assertRunning?: () => void }
>();

/** Preserve the original session proof, but expose no records before its late physical sweep. */
export function deferCorrectionSupportReview(
  result: CollectionClinicalReviewResult,
  signal?: AbortSignal,
  assertRunning?: () => void,
): CorrectionSupportReviewPreparationResult {
  if (result.status !== 'ready') return result;
  const preparation = Object.freeze({}) as CorrectionSupportReviewPreparation;
  preparations.set(preparation, { session: result.session, signal, assertRunning });
  return { status: 'prepared', preparation };
}

export function disposeCorrectionSupportReview(
  preparation: CorrectionSupportReviewPreparation,
): void {
  const selected = preparations.get(preparation);
  preparations.delete(preparation);
  selected?.session.close();
}

/** One-use handoff: verify original signed identities after preparation callbacks, never rebaseline. */
export async function consumeCorrectionSupportReview(
  preparation: CorrectionSupportReviewPreparation,
) {
  const selected = preparations.get(preparation);
  if (!selected) throw Error('Supporting clinical review preparation is unavailable');
  preparations.delete(preparation);
  try {
    selected.signal?.throwIfAborted();
    selected.assertRunning?.();
    const context = await collectionClinicalProjectionContextAsync(
      selected.session,
      selected.signal,
      selected.assertRunning,
    );
    return { session: selected.session, context };
  } catch (error) {
    selected.session.close();
    throw error;
  }
}
